/**
 * cortico-world-localvision
 * 本地视觉 World：截屏在本机由本地视觉模型转成稳定文字 / 文字锚定坐标，云端只收文字与归一化坐标。
 *
 * 设计目标（见 README）：把每轮变化的截图替换为「稳定文字描述 + 归一化坐标」，
 * 让云端输入前缀保持稳定 -> 提示词缓存命中率上升 -> 未命中那 8% 的全价 token 消失，
 * 且视觉 token 趋近于 0。点击坐标全部归一化(0..1)，由本机乘回原生像素，因此
 * 与屏幕分辨率 / DPI / 宽高比完全无关（自适应截图）。
 *
 * 注意：本文件是按 Cortico World 契约(api:6)写的脚手架。发布前请用
 *   pnpm describe:extension <目录> 与 pnpm check:extension <目录>
 * 校验，并以 cortico/world.ts 的真实类型为准微调。
 */

import type { WorldDefinition } from 'cortico/world.ts';
import { describeOllama, ocrWithVlm, locateText, locateViaVision } from './vlm.ts';
import { captureScreenshot } from './screenshot.ts';
import { clickAt } from './action.ts';
import { normToNative, type CaptureTransform } from './vision-space.ts';

export interface LocalVisionSection {
  vlmBaseUrl: string; // OpenAI 兼容视觉端点，如 http://127.0.0.1:11434/v1
  vlmModel: string; // 本地视觉模型，如 minicpm-v2.6 / qwen2-vl / llava
  screenshotMaxWidth: number; // 发给 VLM 的图宽上限，默认 1280（等比缩放，不变形）
  screenshotMaxHeight: number; // 高上限，默认 800
  ocrEnabled: boolean;
  autoSeeOnStart: boolean; // 暂未使用，预留
  // Tier3 终极兜底 Vision API（可指向本地 Ollama，也可指向云端 OpenAI 兼容端点）
  visionApiBaseUrl: string; // 留空则回退到 vlmBaseUrl（即默认仍走本地）
  visionApiKey: string; // 云端端点填 Bearer Token；本地 Ollama 留空
  visionApiModel: string; // 留空则回退到 vlmModel
  visionApiTimeoutMs: number; // 兜底调用超时，默认 20000
}

function textPart(text: string) {
  return { type: 'text', text };
}

export default {
  id: 'localvision',
  label: '本地视觉 LocalVision',
  defaults: () => ({
    vlmBaseUrl: 'http://127.0.0.1:11434/v1',
    vlmModel: 'minicpm-v2.6',
    screenshotMaxWidth: 1280,
    screenshotMaxHeight: 800,
    ocrEnabled: true,
    autoSeeOnStart: false,
    visionApiBaseUrl: '',
    visionApiKey: '',
    visionApiModel: '',
    visionApiTimeoutMs: 20000,
  }),
  create: (ctx: any) => new LocalVisionWorld(ctx),
} satisfies WorldDefinition<LocalVisionSection>;

class LocalVisionWorld {
  constructor(private ctx: any) {}

  private get cfg(): LocalVisionSection {
    return this.ctx.config as LocalVisionSection;
  }

  // 点击还原所需的基准：最近一次截图的变换（原生尺寸 + 缩放 + 时间戳）。
  private lastTransform: CaptureTransform | null = null;

  tools() {
    return [
      {
        name: 'localvision_see',
        description:
          '截取当前屏幕，在本机用本地视觉模型转成稳定的文字描述（可见窗口/应用、关键文字、可疑的可点击元素及其大致位置），不向云端发送任何图片。' +
          '用于"看"屏幕：每次调用返回的文字应尽量稳定，屏幕没变时描述不变，从而让云端缓存命中。',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: '可选的关注点，例如"只看右上角的按钮"或"找出登录表单"。',
            },
            monitor: {
              type: 'integer',
              description: '可选：截哪块屏（0-based，默认主屏）。多屏环境可用。',
            },
          },
        },
        call: async (args: { prompt?: string; monitor?: number }) => {
          const img = await captureScreenshot({
            maxWidth: this.cfg.screenshotMaxWidth,
            maxHeight: this.cfg.screenshotMaxHeight,
            monitor: args.monitor,
          });
          this.lastTransform = img;
          const desc = await describeOllama(img.base64, this.cfg.vlmBaseUrl, this.cfg.vlmModel, args.prompt);
          return [textPart(desc)];
        },
      },
      {
        name: 'localvision_ocr',
        description:
          '截取屏幕并用本地模型逐字提取可见文字（OCR），返回纯文本，不发送图片。' +
          '适合需要从界面上读取具体文字（如错误消息、字段名）时使用。',
        parameters: { type: 'object', properties: {} },
        call: async () => {
          const img = await captureScreenshot({
            maxWidth: this.cfg.screenshotMaxWidth,
            maxHeight: this.cfg.screenshotMaxHeight,
          });
          this.lastTransform = img;
          const text = await ocrWithVlm(img.base64, this.cfg.vlmBaseUrl, this.cfg.vlmModel);
          return [textPart(text)];
        },
      },
      {
        name: 'localvision_click',
        description:
          '在屏幕上点击（三级兜底，坐标均归一化 0-1 由本机乘回原生像素，自适应任意分辨率/DPI/宽高比）。' +
          '优先级：① text（按屏幕文字做 OCR/视觉锚定，精度最高，优先）> ' +
          '② x,y（直接给归一化坐标回退）> ' +
          '③ 前两者都失败则重新截图交给 Vision API 看图定位（终极兜底，仅在必要时传图，可配置 API）。' +
          '点击前请先调用过 localvision_see / localvision_ocr 以建立坐标基准。',
        parameters: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: '按屏幕上出现的文字定位并点击其区域中心（Tier1，OCR/视觉锚定，精度高，优先）',
            },
            x: {
              type: 'number',
              description: '归一化坐标 x（0-1）；与 y 一起作为 Tier2 直接点击（回退用）',
            },
            y: {
              type: 'number',
              description: '归一化坐标 y（0-1）；与 x 一起作为 Tier2 直接点击（回退用）',
            },
            intent: {
              type: 'string',
              description: 'Tier3 终极兜底时用：用自然语言描述要点的目标（如"右上角的关闭按钮"）；缺省时复用 text',
            },
          },
        },
        call: async (args: { text?: string; x?: number; y?: number; intent?: string }) => {
          if (!this.lastTransform) {
            return [textPart('请先调用 localvision_see 或 localvision_ocr 以建立坐标基准，再点击。')];
          }
          const intent = args.intent ?? args.text ?? '';
          const timeout = this.cfg.visionApiTimeoutMs;
          let tier1Note = '';

          // ===== Tier1：OCR / 视觉锚定（优先，精度高）=====
          if (args.text) {
            try {
              const fresh = await captureScreenshot({
                maxWidth: this.cfg.screenshotMaxWidth,
                maxHeight: this.cfg.screenshotMaxHeight,
              });
              this.lastTransform = fresh;
              const box = await locateText(
                fresh.base64,
                this.cfg.vlmBaseUrl,
                this.cfg.vlmModel,
                args.text,
                timeout
              );
              if (box) {
                return this.doClick(
                  box.x + box.w / 2,
                  box.y + box.h / 2,
                  `text="${args.text}" (Tier1 OCR 锚定)`
                );
              }
              // OCR 未找到 -> 落入 Tier2 / Tier3
            } catch (e: any) {
              // OCR 超时或异常 -> 落入兜底，不崩溃（不提前 return）
              tier1Note = `Tier1 OCR 异常：${e?.message ?? e}；`;
            }
          }

          // ===== Tier2：归一化坐标直接点击（回退）=====
          if (typeof args.x === 'number' && typeof args.y === 'number') {
            return this.doClick(args.x, args.y, `x,y=(${args.x},${args.y}) (Tier2 归一化回退)`);
          }

          // ===== Tier3：终极兜底，截图传 Vision API 看图定位 =====
          if (intent) {
            try {
              const fresh = await captureScreenshot({
                maxWidth: this.cfg.screenshotMaxWidth,
                maxHeight: this.cfg.screenshotMaxHeight,
              });
              this.lastTransform = fresh;
              const baseUrl = this.cfg.visionApiBaseUrl || this.cfg.vlmBaseUrl;
              const model = this.cfg.visionApiModel || this.cfg.vlmModel;
              const pt = await locateViaVision(
                fresh.base64,
                baseUrl,
                this.cfg.visionApiKey,
                model,
                intent,
                timeout
              );
              if (pt) {
                return this.doClick(pt.x, pt.y, `intent="${intent}" (Tier3 Vision API 兜底)`);
              }
              return [
                textPart(
                  `${tier1Note}Tier3 Vision API 未能从图中定位"${intent}"。三级兜底均失败，请换用 text 或 x,y，或检查 Vision API 配置。`
                ),
              ];
            } catch (e: any) {
              return [
                textPart(
                  `Tier3 Vision API 失败：${e?.message ?? e}。请确认 visionApiBaseUrl / visionApiKey 配置正确，或改用 text / x,y。`
                ),
              ];
            }
          }

          return [
            textPart(
              `${tier1Note}三级兜底均不可用：请提供 text（Tier1 OCR）或 x,y（Tier2 归一化）；` +
                '若想启用 Tier3 看图定位，请配置 visionApi* 并给出文字意图（text / intent）。'
            ),
          ];
        },
      },
    ];
  }

  // 归一化坐标 -> 原生像素 -> 真实点击，返回结果文本。
  private async doClick(nx: number, ny: number, how: string) {
    if (!this.lastTransform) {
      return [textPart('坐标基准丢失，请重新 localvision_see / localvision_ocr。')];
    }
    const { x, y } = normToNative(nx, ny, this.lastTransform);
    await clickAt(x, y);
    return [
      textPart(
        `已点击 [${how}]：归一化(${nx.toFixed(3)}, ${ny.toFixed(3)}) -> 原生像素(${x}, ${y})。` +
          ` 屏幕基准 ${this.lastTransform.nativeWidth}x${this.lastTransform.nativeHeight}。`
      ),
    ];
  }

  // 环境提示词：让 agent 用本地视觉"看"屏、用 OCR 锚定/归一化坐标点击，且知道云端不收图片。
  webUi(lang: string) {
    if (lang === 'zh') {
      return [
        {
          role: 'envPrompt',
          text:
            '你可以通过 localvision_see 工具"看"屏幕：它在你的电脑上本地运行视觉模型，' +
            '只把稳定的文字描述返回给你，不会向任何云端发送截图。' +
            '因此你看到的屏幕信息来自文字描述；屏幕没变时 localvision_see 的返回应当一致——据此判断是否需要重新观察。' +
            '点击屏幕请用 localvision_click，内部三级兜底：① text（按屏幕上文字做 OCR/视觉锚定，精度最高，优先）；' +
            '② x,y（直接给归一化坐标 0-1 回退）；③ 前两者都失败则重新截图交给 Vision API 看图定位（终极兜底，仅在必要时传图）。' +
            '所有坐标都归一化、与分辨率无关，由本机乘回原生像素执行，你无需关心屏幕实际分辨率。',
        },
      ];
    }
    return [
      {
        role: 'envPrompt',
        text:
          'You can "see" the screen via the localvision_see tool, which runs a vision model locally and returns only a ' +
          'stable text description — no screenshot is ever sent to the cloud. ' +
          'Base computer actions on that description; do not assume you can see raw images. ' +
          'To click, use localvision_click with a 3-tier fallback: ① text (OCR/visual anchor on screen text, most precise, preferred); ' +
          '② x,y normalized coordinates (0-1) as fallback; ③ if both fail, re-screenshot and ask the configured Vision API to locate the target (ultimate fallback, only sends an image when necessary). ' +
          'All coordinates are normalized (0-1) and resolution-independent; the local machine maps them back to native pixels.',
      },
    ];
  }

  envPromptVars() {
    return {};
  }
}
