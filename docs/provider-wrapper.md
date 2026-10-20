# 可选：Provider 包装器（实验性，默认关闭）

> 这是给**愿意折腾的用户**准备的第二套硬拦截方案。默认**不安装、不启用**。
> 能改 Cortico 就用 `patches/core-tool-outcome-hook.patch`（主线，方案 1）；
> 不能改、又想要硬保证，再考虑本文。

## 目标

把所有**工具回执里的截图**在请求发往模型之前换成 OCR 文字，且：

- 不修改 Cortico 核心；
- 只影响截图，不误伤用户上传的图片或生成图；
- 不重复 OCR 同一张图（历史重放、动作后截图）。

## 为什么挂在这里

- 没有统一的 `providers/transport/chat.ts`。图片是在各 provider 的渲染层被转成 `image_url` 的：
  `providers/transport/history.ts`（openai-chat）、`native-input.ts`、`responses-input.ts`。
- 但所有 provider 都实现 `BaseProvider.respond(request, options)`（`providers/base.ts:18`）。
  在 `respond()` 入口改写请求记录，是**协议无关**的唯一收口。
- 工具回执在上下文里的类型是 `function_call_output`（`protocol/open-responses/context.ts:44`），
  附件在 `record.context.blobs`。只处理这个类型，就不会碰用户图片和普通消息。

## 包结构

一个扩展包只能有一种 `cortico.kind`，所以包装器必须是**独立包**（不能塞进 localvision 的 World 包）：

```
cortico-provider-localvision/
  package.json          # "cortico": { "kind": "provider", "api": 6 }
  src/index.ts          # ProviderModule
  README.md
```

`package.json` 关键字段：

```json
{
  "name": "cortico-provider-localvision",
  "type": "module",
  "main": "./src/index.ts",
  "cortico": { "kind": "provider", "api": 6 },
  "dependencies": { "tesseract.js": "^7.0.0" }
}
```

## 代码骨架

```ts
import type { BaseProvider, ProviderInstance, ProviderModule } from 'cortico/providers/base.ts';
import { providerModule } from 'cortico/providers/registry.ts';
import { ocrNative, imageSize } from 'cortico-world-localvision/src/ocr.ts'; // 或在包内复制

class WrapClient extends BaseProvider {
  constructor(private inner: BaseProvider, private host: ProviderHost, private lang: string) {
    super();
  }

  async respond(request: any, options?: any) {
    const records = request.input ?? request.records ?? []; // 按实际协议取，验证后再定
    for (const r of records) {
      if (r?.type !== 'function_call_output') continue;
      const blobs = r.context?.blobs ?? [];
      const shots = blobs.filter((b: any) =>
        typeof b.mime === 'string' && b.mime.startsWith('image/') &&
        /screen|zoom|截图|截圖/i.test(`${b.name ?? ''} ${b.fallbackText ?? ''}`));
      for (const b of shots) {
        const got = this.host.readBlob(b.handle);
        const dims = got ? imageSize(got) : null;
        if (!got || !dims) continue;
        const words = await ocrNative(got.toString('base64'), {
          lang: this.lang, width: dims.w, height: dims.h, cacheDir: /* 稳定缓存目录 */,
        });
        if (!words.length) continue;
        r.output = `${r.output}\n\n[本机 OCR] 截图已转成文字：\n${/* 文字+坐标 */}`;
        r.context.blobs = blobs.filter((x: any) => x !== b);
      }
    }
    return this.inner.respond(request, options);
  }
}

const mod: ProviderModule = {
  id: 'localvision-wrap',
  title: 'LocalVision 包装器（实验）',
  reasoningTiers: [],      // 继承底层端点的档位
  serviceTiers: [],
  describe: { protocols: ['openai-chat'], auth: ['api-key'], local: false, input: ['text', 'image'] },
  create(name, entry, host): ProviderInstance {
    const delegateKind = (entry as any).delegateKind ?? 'openai-chat-compat';
    const inner = providerModule(delegateKind).create(name, { ...entry, kind: delegateKind }, host);
    return { ...inner, client: new WrapClient(inner.client, host, (entry as any).ocrLang ?? 'chi_sim') };
  },
};

export default mod;
```

## 必做的过滤与缓存

- **只处理 `function_call_output`**：别碰 `message` 记录，否则会把用户发的图也换掉。
- **只处理截图特征**：`name`/`fallbackText` 含 `screen` / `zoom` / `截图`。生成图（`cortico-world-image`）不带这些特征。
- **按内容缓存**：`BlobRef.handle` 对 `log:` 句柄是按内容分配的；用 handle 或字节 SHA-256 做键，历史重放不重复 OCR。
- **OCR 失败策略**：保留原图（可能仍烧 token）或丢弃并注明。建议默认保留，做成配置。
- **坐标基准**：用 `imageSize(bytes)` 得到截图实际宽高，OCR 的归一化框 × 宽高 = 截图坐标，与 `pet_cua_*` 一致。

## 风险与验收清单

- 包装器必须完整转发**流式响应、工具调用、usage、错误与重试**；漏一项就是全量故障。
- 用户要在设置里把 provider 切到包装器；切回原 provider 必须无残留。
- 多协议（openai-chat / openai-responses / anthropic-messages）要分别验证请求记录形状。
- 验收：① 普通对话正常；② 工具调用正常；③ 截图回执变文字且无图片；④ 用户上传图片不受影响；⑤ 历史重放不重复 OCR；⑥ 切回原 provider 正常。

## 默认决策

**不安装、不启用。** 主线是核心 hook（`patches/core-tool-outcome-hook.patch`）；本方案仅作为无法改框架时的备选。
