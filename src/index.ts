/**
 * cortico-world-localvision
 * 本地视觉 World：在「桌宠」侧提供屏幕感知与点击，把云端 token 压到最低。
 *
 * 产品定位（轻量级桌宠软件）：
 *  - 视觉端点是【可选】的：默认不配置 visionApiBaseUrl，插件进入「轻量模式」，
 *    只提供归一化坐标点击（localvision_click 的 Tier2），不调用任何视觉模型，绝不卡顿。
 *  - 当用户在设置里填上 visionApiBaseUrl（本地 Ollama 的 /v1，或云端 OpenAI 兼容端点），
 *    再解锁 localvision_see / localvision_ocr 的"看屏"能力，以及点击的 Tier1(OCR 锚定) / Tier3(看图兜底)。
 *
 * 彻底解耦本地模型：
 *  - 本插件不依赖、不硬编码、不假设 Ollama 在运行。视觉端点只是一个标准 OpenAI 兼容 /v1。
 *  - 用户自由选择本地或云端，填不填、填哪个完全由配置决定。
 *
 * 三级兜底点击（localvision_click）：
 *  Tier1  text（OCR/视觉锚定，精度最高，优先；需视觉端点）
 *  Tier2  x,y（归一化坐标直接点击，无模型依赖，最轻量；始终可用）
 *  Tier3  前两者都失败 -> 重新截图交给视觉端点看图定位（终极兜底；需视觉端点）
 *
 * 坐标全部归一化(0..1)，由本机乘回原生像素，因此与屏幕分辨率 / DPI / 宽高比完全无关。
 *
 * 发布前请用 `pnpm describe:extension .` 与 `pnpm check:extension .` 校验。
 */

import type { WorldDefinition } from 'cortico/world.ts';
import { describeScreen, ocrScreen, locateText, locateViaVision, type VisionOpts } from './vlm.ts';
import { captureScreenshot } from './screenshot.ts';
import { clickAt } from './action.ts';
import { normToNative, type CaptureTransform } from './vision-space.ts';

export interface LocalVisionSection {
  // —— Cortico World 段必含字段 ——
  enabled: boolean; // 由框架/部署配置控制；defaults 仅给默认
  // —— 通用视觉端点（OpenAI 兼容 /v1）。可选；空 = 关闭视觉，进入轻量模式 ——
  visionApiBaseUrl: string; // 本地填 http://127.0.0.1:11434/v1；云端填其 /v1。空则不调用任何视觉模型
  visionApiKey: string; // Bearer Token；本地 Ollama / LM Studio 等留空
  visionApiModel: string; // 模型名：本地如 minicpm-v2.6 / qwen2-vl；云端如 gpt-4o
  visionApiTimeoutMs: number; // 单次视觉调用超时（毫秒），默认 8000；兜底失败即降级，不卡死
  // —— 截图缩放上限（只缩不放，不变形）——
  screenshotMaxWidth: number; // 默认 1280
  screenshotMaxHeight: number; // 默认 800
}

function textPart(text: string) {
  return { type: 'text', text };
}

export default {
  id: 'localvision',
  label: '本地视觉 LocalVision',
  defaults: () => ({
    // 默认关闭视觉：不调用任何模型，桌宠最轻量、不卡顿。
    enabled: false,
    visionApiBaseUrl: '',
    visionApiKey: '',
    visionApiModel: '',
    visionApiTimeoutMs: 8000,
    screenshotMaxWidth: 1280,
    screenshotMaxHeight: 800,
  }),
  describe: {
    tools: [
      {
        name: 'localvision_see',
        description:
          '截取当前屏幕，用已配置的视觉端点（本地或云端）转成稳定的文字描述（可见窗口/应用、关键文字、可疑的可点击元素及其大致位置），不向云端以外发送截图。用于"看"屏幕：屏幕没变时描述应一致，提升缓存命中、降低 token。需先配置 visionApiBaseUrl；未配置时为轻量模式，本工具不可用。',
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
        tags: ['perception'],
      },
      {
        name: 'localvision_ocr',
        description:
          '截取屏幕并用视觉端点逐字提取可见文字（OCR），返回纯文本。适合读取具体文字（错误消息、字段名）。需先配置 visionApiBaseUrl；未配置时为轻量模式，本工具不可用。',
        parameters: { type: 'object', properties: {} },
        tags: ['perception'],
      },
      {
        name: 'localvision_click',
        description:
          '在屏幕上点击（三级兜底，坐标均归一化 0-1，由本机乘回原生像素，自适应任意分辨率/DPI/宽高比）。优先级：① text（OCR/视觉锚定，精度最高，优先；需视觉端点）> ② x,y（归一化坐标回退，无模型依赖，最轻量，始终可用）> ③ 前两者都失败则重新截图交给视觉端点看图定位（终极兜底，仅在必要时传图；需视觉端点）。默认轻量模式下仅 x,y 可用。点击前需先调用过 localvision_see/localvision_ocr 建立坐标基准。',
        parameters: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: '按屏幕上出现的文字定位并点击其区域中心（Tier1，OCR/视觉锚定，精度高，优先）',
            },
            x: {
              type: 'number',
              description: '归一化坐标 x（0-1）；与 y 一起作为 Tier2 直接点击（回退用，始终可用）',
            },
            y: {
              type: 'number',
              description: '归一化坐标 y（0-1）；与 x 一起作为 Tier2 直接点击（回退用，始终可用）',
            },
            intent: {
              type: 'string',
              description: 'Tier3 终极兜底时用：用自然语言描述要点的目标（如"右上角的关闭按钮"）；缺省时复用 text',
            },
          },
        },
        tags: ['action'],
      },
    ],
    events: [],
  },
  create: (ctx: any) => new LocalVisionWorld(ctx),
} satisfies WorldDefinition<LocalVisionSection>;

class LocalVisionWorld {
  constructor(private ctx: any) {}

  private get cfg(): LocalVisionSection {
    return this.ctx.config as LocalVisionSection;
  }

  /** 视觉端点是否已配置（启用）。未配置 -> 轻量模式。 */
  private get visionEnabled(): boolean {
    return this.cfg.visionApiBaseUrl.trim() !== '';
  }

  /** 汇总视觉端点配置，供 vlm.ts 使用。 */
  private visionOpts(): VisionOpts {
    const c = this.cfg;
    return {
      baseUrl: c.visionApiBaseUrl.trim(),
      apiKey: c.visionApiKey,
      model: c.visionApiModel,
      timeoutMs: c.visionApiTimeoutMs,
    };
  }

  // 点击还原所需的基准：最近一次截图的变换（原生尺寸 + 缩放 + 时间戳）。
  private lastTransform: CaptureTransform | null = null;

  tools() {
    return [
      {
        name: 'localvision_see',
        description:
          '截取当前屏幕，用已配置的视觉端点（本地或云端）转成稳定的文字描述（可见窗口/应用、关键文字、可疑的可点击元素及其大致位置），不向云端以外发送截图。用于"看"屏幕：屏幕没变时描述应一致，提升缓存命中、降低 token。需先配置 visionApiBaseUrl；未配置时为轻量模式，本工具不可用。',
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
          if (!this.visionEnabled) {
            return [
              textPart(
                '轻量模式：尚未配置视觉端点（visionApiBaseUrl 为空），localvision_see 不可用。' +
                  '桌宠因此不调用任何视觉模型、最流畅。如需让桌宠"看"屏幕，请在设置中填写 ' +
                  'visionApiBaseUrl（本地如 http://127.0.0.1:11434/v1，云端填其 /v1）并填好 visionApiModel；' +
                  '当前仍可用 localvision_click 的归一化坐标(x,y)点击。'
              ),
            ];
          }
          const img = await captureScreenshot({
            maxWidth: this.cfg.screenshotMaxWidth,
            maxHeight: this.cfg.screenshotMaxHeight,
            monitor: args.monitor,
          });
          this.lastTransform = img;
          const desc = await describeScreen(img.base64, this.visionOpts(), args.prompt);
          return [textPart(desc)];
        },
      },
      {
        name: 'localvision_ocr',
        description:
          '截取屏幕并用视觉端点逐字提取可见文字（OCR），返回纯文本。适合读取具体文字（错误消息、字段名）。需先配置 visionApiBaseUrl；未配置时为轻量模式，本工具不可用。',
        parameters: { type: 'object', properties: {} },
        call: async () => {
          if (!this.visionEnabled) {
            return [
              textPart(
                '轻量模式：尚未配置视觉端点（visionApiBaseUrl 为空），localvision_ocr 不可用。' +
                  '请在设置中填写 visionApiBaseUrl / visionApiModel 以启用；当前仍可用 localvision_click 的归一化坐标(x,y)点击。'
              ),
            ];
          }
          const img = await captureScreenshot({
            maxWidth: this.cfg.screenshotMaxWidth,
            maxHeight: this.cfg.screenshotMaxHeight,
          });
          this.lastTransform = img;
          const text = await ocrScreen(img.base64, this.visionOpts());
          return [textPart(text)];
        },
      },
      {
        name: 'localvision_click',
        description:
          '在屏幕上点击（三级兜底，坐标均归一化 0-1，由本机乘回原生像素，自适应任意分辨率/DPI/宽高比）。优先级：① text（OCR/视觉锚定，精度最高，优先；需视觉端点）> ② x,y（归一化坐标回退，无模型依赖，最轻量，始终可用）> ③ 前两者都失败则重新截图交给视觉端点看图定位（终极兜底，仅在必要时传图；需视觉端点）。默认轻量模式下仅 x,y 可用。点击前需先调用过 localvision_see/localvision_ocr 建立坐标基准。',
        parameters: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: '按屏幕上出现的文字定位并点击其区域中心（Tier1，OCR/视觉锚定，精度高，优先）',
            },
            x: {
              type: 'number',
              description: '归一化坐标 x（0-1）；与 y 一起作为 Tier2 直接点击（回退用，始终可用）',
            },
            y: {
              type: 'number',
              description: '归一化坐标 y（0-1）；与 x 一起作为 Tier2 直接点击（回退用，始终可用）',
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
          const opts = this.visionOpts();
          const timeout = this.cfg.visionApiTimeoutMs;
          let note = '';

          // ===== Tier1：OCR / 视觉锚定（优先，精度高；需视觉端点）=====
          if (args.text && this.visionEnabled) {
            try {
              const fresh = await captureScreenshot({
                maxWidth: this.cfg.screenshotMaxWidth,
                maxHeight: this.cfg.screenshotMaxHeight,
              });
              this.lastTransform = fresh;
              const box = await locateText(fresh.base64, opts, args.text, timeout);
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
              note = `Tier1 OCR 异常：${e?.message ?? e}；`;
            }
          }

          // ===== Tier2：归一化坐标直接点击（回退；无模型依赖，最轻量，始终可用）=====
          if (typeof args.x === 'number' && typeof args.y === 'number') {
            return this.doClick(args.x, args.y, `x,y=(${args.x},${args.y}) (Tier2 归一化回退)`);
          }

          // ===== Tier3：终极兜底，截图传视觉端点看图定位（需视觉端点）=====
          if (intent && this.visionEnabled) {
            try {
              const fresh = await captureScreenshot({
                maxWidth: this.cfg.screenshotMaxWidth,
                maxHeight: this.cfg.screenshotMaxHeight,
              });
              this.lastTransform = fresh;
              const pt = await locateViaVision(fresh.base64, opts, intent, timeout);
              if (pt) {
                return this.doClick(pt.x, pt.y, `intent="${intent}" (Tier3 视觉端点兜底)`);
              }
              return [
                textPart(
                  `${note}Tier3 视觉端点未能从图中定位"${intent}"。三级兜底均失败，请换用 text 或 x,y，或检查视觉端点配置。`
                ),
              ];
            } catch (e: any) {
              return [
                textPart(
                  `${note}Tier3 视觉端点失败：${e?.message ?? e}。请确认 visionApiBaseUrl / visionApiModel / visionApiKey 配置正确，或改用 text / x,y。`
                ),
              ];
            }
          }

          // ===== 落到这里：没有任何可用路径 =====
          return [
            textPart(
              `${note}三级兜底均不可用：` +
                (this.visionEnabled
                  ? '请提供 text（Tier1 OCR）或 x,y（Tier2 归一化）；若想用 Tier3 看图定位，请给出文字意图（text / intent）。'
                  : '当前为轻量模式（未配置视觉端点），请直接用 x,y 给归一化坐标(0-1)点击；如需 OCR/看图，请在设置填写 visionApiBaseUrl。')
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

  // 环境提示词：让 agent 知道何时用本地视觉、何时走轻量归一化坐标，且云端不收原始截图。
  webUi(lang: string) {
    if (lang === 'zh') {
      return [
        {
          role: 'envPrompt',
          text:
            '你可以通过 localvision_see 工具"看"屏幕：它调用已配置的视觉端点（本地或云端）把屏幕转成稳定文字描述返回给你，' +
            '不会把原始截图发给云端。屏幕没变时描述应当一致——据此判断是否需要重新观察。' +
            '（轻量模式下若未配置视觉端点，localvision_see / localvision_ocr 不可用，请改用归一化坐标点击。）' +
            '点击屏幕请用 localvision_click，内部三级兜底：① text（按屏幕上文字做 OCR/视觉锚定，精度最高，优先）；' +
            '② x,y（直接给归一化坐标 0-1 回退，最轻量，始终可用）；③ 前两者都失败则重新截图交给视觉端点看图定位（终极兜底，仅在必要时传图）。' +
            '所有坐标都归一化、与分辨率无关，由本机乘回原生像素执行，你无需关心屏幕实际分辨率。',
        },
      ];
    }
    return [
      {
        role: 'envPrompt',
        text:
          'You can "see" the screen via the localvision_see tool, which calls a configured vision endpoint (local or cloud) and returns only a ' +
          'stable text description — raw screenshots are never sent to the cloud. ' +
          'Base computer actions on that description; do not assume you can see raw images. ' +
          '(In lightweight mode with no vision endpoint configured, localvision_see/localvision_ocr are unavailable — use normalized coordinates instead.) ' +
          'To click, use localvision_click with a 3-tier fallback: ① text (OCR/visual anchor on screen text, most precise, preferred); ' +
          '② x,y normalized coordinates (0-1) as fallback (lightest, always available); ③ if both fail, re-screenshot and ask the configured vision endpoint to locate the target (ultimate fallback, only sends an image when necessary). ' +
          'All coordinates are normalized (0-1) and resolution-independent; the local machine maps them back to native pixels.',
      },
    ];
  }

  envPromptVars() {
    return {};
  }
}
