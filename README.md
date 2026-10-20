# cortico-world-localvision（本地视觉）

Coopanion / Cortico 的 World 扩展：**截屏在本机由本地视觉模型转成稳定文字，云端只收文字**，
用来提升提示词缓存命中、降低 token 消耗。

> 插件名：local vision（本地视觉）｜包名：`cortico-world-localvision`｜契约：`api: 6`

---

## 为什么能降 token

Coopanion「操作电脑」每轮都把屏幕截图发给云端。截图每帧都在变，导致云端输入前缀每轮变化，
**提示词缓存被击穿**——账单里那 8% 的未命中输入占了 73% 的成本，且视觉 token 本身很贵。

本插件把"看屏"改成本地行为：

```
截屏 ──本机──▶ 本地视觉模型 ──▶ 稳定文字描述 ──▶ 云端(只收文字)
```

- 屏幕没变时，文字描述**几乎不变** → 云端输入前缀稳定 → 缓存持续命中。
- 云端**收不到任何图片** → 视觉 token ≈ 0。
- 文字比 1280×800 的 JPEG 小几个数量级，即便偶尔未命中也很便宜。

## 工具

| 工具 | 作用 |
|---|---|
| `localvision_see` | 截主屏 → 本地 VLM → 稳定文字描述（窗口/文字/可点元素）。**感知主工具。** |
| `localvision_ocr` | 截屏 → 本地模型逐字提取文字。需要读具体文字时用。 |
| `localvision_click` | **[接口占位]** 按 `elementId` / `text` / `x,y` 点击。尚未实现，见下。 |

## 配置（`worlds.localvision`）

| 键 | 默认 | 说明 |
|---|---|---|
| `vlmBaseUrl` | `http://127.0.0.1:11434/v1` | 本地 OpenAI 兼容视觉端点（Ollama / LM Studio / llama.cpp） |
| `vlmModel` | `minicpm-v2.6` | 本地视觉模型；0.8B–4B 描述屏幕足够 |
| `screenshotMaxWidth` | `1280` | 与 cua 对齐的缩放空间（感知阶段暂未强制缩放） |
| `screenshotMaxHeight` | `800` | 同上 |
| `ocrEnabled` | `true` | 是否开放 `localvision_ocr` |
| `autoSeeOnStart` | `false` | 预留 |

运行前：`ollama pull minicpm-v2.6`（或任意视觉模型）。

## 怎么真正省到钱（集成方式）

本插件只负责"本地感知"。要让云端**完全不收截图**，需配合以下任一种：

- **方式 A（现在就能用）**：把 Coopanion 的模型连接指向我们之前写的**本地代理**
  （`coopanion_local_vision_proxy.py`）。代理会在 API 边界把所有图片（含 cua 工具回执里的截图）
  替换成本地 VLM 的文字，云端彻底看不到图。这是当前的即时方案。
- **方式 B（更彻底，待做）**：让 cua World 不再自己上传截图，改为消费 `localvision_see` 的文字。
  需要给 `cortico-world-cua` 打补丁或提供一个替代 World，配合下面的"点击设计"做确定性操作。

## 点击设计（接口已留，方案待定——征询意见）

`localvision_click` 目前只是占位。我的建议（**元素引用**，而非坐标猜测）：

1. `localvision_see` 未来除了文字，还返回一份**带稳定 id 的元素清单 + 边界框**（坐标落在 cua 的
   1280×800 空间）。
2. 云端**只在元素空间做选择**（"点提交按钮"或选 `E3`），调用 `localvision_click({ elementId: 'E3' })`。
3. **本机侧**把 id 解析为中心坐标并真正点击。坐标不上云、不靠云端猜像素。
4. 文字密集型界面可用 `localvision_click({ text: '登录' })`：用 OCR 锚定最近文字再点。

这样云端 100% 是文字、点击确定性高、坐标永不离开本机。当前 `x,y` 仅作回退占位。

> 也欢迎你拍板：是否要"本地 VLM 直接出坐标框"还是"VLM 出元素 + 独立定位器"，两者在精度与模型要求上不同。

## 开发与安装

```bash
corepack pnpm install        # 装 cortico 开发依赖（类型/校验用）
pnpm describe:extension .   # 重新生成 describe.json
pnpm check:extension .      # 契约与声明校验
```

装进 Coopanion / Cortico：扩展页「手动安装」填本目录绝对路径 → 重启 → World 总览启用；
或在部署 `config.json` 写 `worlds.localvision.enabled = true`。

## 许可

MIT。
