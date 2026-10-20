/**
 * cortico-world-localvision
 * 本地视觉 World：在「桌宠」侧提供屏幕感知与点击，把云端 token 压到最低。
 *
 * 【产品定位：轻量级桌宠软件】
 *  - 默认（轻量模式）下完全不调用任何视觉大模型：
 *      · 感知用「本机原生 OCR」（Windows 内置 / macOS tesseract），免下载、免模型、快；
 *      · 点击用「归一化坐标」（Tier2），无模型依赖，永远可用。
 *    => 桌宠不卡顿、不联网传图、不烧 token。
 *  - 视觉兜底（Tier3 看图定位）是【可选开关】，默认关闭：
 *      · 仅在 visionFallbackEnabled=true 且填了 visionApiBaseUrl 时才启用；
 *      · 它是标准 OpenAI 兼容 /v1 端点，用户可填本地 Ollama / LM Studio 或云端，
 *        代码不硬编码、不假设任何后端在运行。
 *
 * 【坐标与分辨率适配】
 *  - 云端只收「归一化坐标(0..1) + 文字」，永远不见原生像素/分辨率。
 *  - 原生尺寸只留本机：原生像素 = 归一化 × 原生分辨率，任意分辨率/DPI/宽高比都像素级命中。
 *  - 原生截屏做 DPI 感知（Windows PerMonitorV2），并等比缩放（不变形）。
 *
 * 【三级兜底点击（localvision_click）】
 *  Tier1  text：本机 OCR 文字锚定（免模型，优先，精度高）。两级截图：先按 lastNormPoint 局部裁剪，
 *              识别失败再降级全屏。
 *  Tier2  x,y ：归一化坐标直接点击（无模型依赖，最轻量，始终可用）。
 *  Tier3  intent：前两者都失败 -> 重新截图交给视觉端点看图定位（终极兜底；默认关闭，仅在必要时传图）。
 *
 * 【发布校验】pnpm describe:extension / pnpm check:extension
 */

import type { WorldDefinition } from 'cortico/world.ts';
import {
  describeScreen,
  ocrScreen,
  locateViaVision,
  type VisionOpts,
} from './vlm.ts';
import { captureScreenshot } from './screenshot.ts';
import { clickAt } from './action.ts';
import { normToNative, type CaptureTransform } from './vision-space.ts';
import { ocrNative, ocrToText, findWord, type OcrWord } from './ocr.ts';

export interface LocalVisionSection {
  enabled: boolean; // Cortico World 段开关（框架/部署控制）
  // —— 视觉兜底（终极 Tier3，默认关闭）——
  visionFallbackEnabled: boolean; // 显式开关：是否允许"传图给视觉端点"。默认 false。
  visionApiBaseUrl: string; // 通用 OpenAI 兼容 /v1：本地 http://127.0.0.1:11434/v1 或云端 /v1。空=不用。
  visionApiKey: string; // Bearer Token；本地端点留空
  visionApiModel: string; // 模型名：本地 minicpm-v2.6 / qwen2-vl；云端 gpt-4o
  visionApiTimeoutMs: number; // 单次视觉调用超时（毫秒），默认 8000；失败即降级，不卡死
  // —— 通用 ——
  ocrLang: string; // 预留：原生 OCR 语言偏好（当前实现自动选系统/英文，填了可扩展）
  cropPadding: number; // 两级截图：局部裁剪时围绕 lastNormPoint 扩展的归一化半幅（0..0.45），默认 0.2
  screenshotMaxWidth: number; // 发给识别引擎的图宽上限，默认 1280（等比缩放，不变形）
  screenshotMaxHeight: number; // 高上限，默认 800
}

function textPart(text: string) {
  return { type: 'text', text };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export default {
  id: 'localvision',
  label: '本地视觉 LocalVision',
  defaults: () => ({
    enabled: true,
    // 默认：视觉兜底关闭 —— 不调用任何视觉模型，桌宠最轻量、不卡顿。
    visionFallbackEnabled: false,
    visionApiBaseUrl: '',
    visionApiKey: '',
    visionApiModel: '',
    visionApiTimeoutMs: 8000,
    ocrLang: '',
    cropPadding: 0.2,
    screenshotMaxWidth: 1280,
    screenshotMaxHeight: 800,
  }),
  describe: {
    tools: [
      {
        name: 'localvision_see',
        description:
          '截取当前屏幕并感知内容。默认（轻量模式，未启用视觉兜底）用本机原生 OCR 提取可见文字作为"屏幕描述"返回给你——不调用任何视觉模型、不联网、不传图，最轻量。' +
          '若启用了视觉兜底且配置了 visionApiBaseUrl，则改用视觉端点生成更丰富的描述。无论哪种，都只返回文字、不把原始截图发给云端，从而提升缓存命中、降低 token。',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: '可选关注点，例如"只看右上角的按钮"或"找出登录表单"（视觉兜底启用时生效）。',
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
          '截取屏幕并用本机原生 OCR 逐字提取可见文字（Windows 内置 / macOS tesseract），返回纯文本。免模型、轻量，适合读取具体文字（错误消息、字段名）。若本机无 OCR 且已启用视觉兜底，则回退到视觉端点 OCR。',
        parameters: { type: 'object', properties: {} },
        tags: ['perception'],
      },
      {
        name: 'localvision_click',
        description:
          '在屏幕上点击（三级兜底，坐标均归一化 0-1，由本机乘回原生像素，自适应任意分辨率/DPI/宽高比）。' +
          '① text（本机 OCR 文字锚定，免模型，优先；两级截图：先局部裁剪再全屏）> ' +
          '② x,y（归一化坐标直接点击，无模型依赖，最轻量，始终可用）> ' +
          '③ intent（前两者都失败才启用：重新截图交给视觉端点看图定位，终极兜底；仅在 visionFallbackEnabled=true 且配置了 visionApiBaseUrl 时可用，默认关闭）。' +
          '点击前建议先调用过 localvision_see / localvision_ocr 建立坐标基准。',
        parameters: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: '按屏幕上出现的文字定位并点击其区域中心（Tier1，本机 OCR 锚定，精度高，优先）',
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

  /** 视觉兜底（Tier3）是否可用：必须显式开关 + 配置端点，二者缺一不可。默认 false。 */
  private get visionEnabled(): boolean {
    return this.cfg.visionFallbackEnabled && this.cfg.visionApiBaseUrl.trim() !== '';
  }

  private visionOpts(): VisionOpts {
    const c = this.cfg;
    return {
      baseUrl: c.visionApiBaseUrl.trim(),
      apiKey: c.visionApiKey,
      model: c.visionApiModel,
      timeoutMs: c.visionApiTimeoutMs,
    };
  }

  // 点击还原所需的全屏基准：最近一次全屏截图的变换。裁剪图不会覆盖它。
  private lastTransform: CaptureTransform | null = null;
  // 最近一次成功定位/点击的「全屏归一化」坐标，用于两级截图的局部裁剪中心。
  private lastNormPoint: { x: number; y: number } | null = null;

  tools() {
    return [
      {
        name: 'localvision_see',
        description:
          '截取当前屏幕并感知内容。默认（轻量模式，未启用视觉兜底）用本机原生 OCR 提取可见文字作为"屏幕描述"返回给你——不调用任何视觉模型、不联网、不传图，最轻量。' +
          '若启用了视觉兜底且配置了 visionApiBaseUrl，则改用视觉端点生成更丰富的描述。无论哪种，都只返回文字、不把原始截图发给云端，从而提升缓存命中、降低 token。',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: '可选关注点，例如"只看右上角的按钮"或"找出登录表单"（视觉兜底启用时生效）。',
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
          // 轻量模式：本机原生 OCR 即"看屏"描述（免模型）
          if (!this.visionEnabled) {
            const words = await ocrNative(img.base64);
            if (words.length) {
              return [
                textPart(
                  '【本机 OCR 屏幕描述（轻量模式，未调用任何视觉模型）】\n' + ocrToText(words)
                ),
              ];
            }
            return [
              textPart(
                '本机未提供可用 OCR（Windows 10/11 内置 OCR，或 macOS 需安装 tesseract），无法生成文字描述。' +
                  '可改用 localvision_click 的归一化坐标(x,y)点击；或在设置中启用 visionFallbackEnabled 并填好 visionApiBaseUrl 用视觉端点"看"屏。'
              ),
            ];
          }
          // 视觉兜底启用：用视觉端点生成更丰富的描述
          const desc = await describeScreen(img.base64, this.visionOpts(), args.prompt);
          return [textPart(desc)];
        },
      },
      {
        name: 'localvision_ocr',
        description:
          '截取屏幕并用本机原生 OCR 逐字提取可见文字（Windows 内置 / macOS tesseract），返回纯文本。免模型、轻量，适合读取具体文字（错误消息、字段名）。若本机无 OCR 且已启用视觉兜底，则回退到视觉端点 OCR。',
        parameters: { type: 'object', properties: {} },
        call: async () => {
          const img = await captureScreenshot({
            maxWidth: this.cfg.screenshotMaxWidth,
            maxHeight: this.cfg.screenshotMaxHeight,
          });
          this.lastTransform = img;
          const words = await ocrNative(img.base64);
          if (words.length) {
            return [textPart(ocrToText(words))];
          }
          // 本机无 OCR：若启用了视觉兜底，再回退到视觉端点 OCR
          if (this.visionEnabled) {
            const text = await ocrScreen(img.base64, this.visionOpts());
            return [textPart(text)];
          }
          return [
            textPart(
              '本机未提供可用 OCR。可启用 visionFallbackEnabled 并填好 visionApiBaseUrl 以用视觉端点 OCR，或改用 localvision_click 的归一化坐标(x,y)。'
            ),
          ];
        },
      },
      {
        name: 'localvision_click',
        description:
          '在屏幕上点击（三级兜底，坐标均归一化 0-1，由本机乘回原生像素，自适应任意分辨率/DPI/宽高比）。' +
          '① text（本机 OCR 文字锚定，免模型，优先；两级截图：先局部裁剪再全屏）> ' +
          '② x,y（归一化坐标直接点击，无模型依赖，最轻量，始终可用）> ' +
          '③ intent（前两者都失败才启用：重新截图交给视觉端点看图定位，终极兜底；仅在 visionFallbackEnabled=true 且配置了 visionApiBaseUrl 时可用，默认关闭）。' +
          '点击前建议先调用过 localvision_see / localvision_ocr 建立坐标基准。',
        parameters: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: '按屏幕上出现的文字定位并点击其区域中心（Tier1，本机 OCR 锚定，精度高，优先）',
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

          // ===== Tier1：本机 OCR 文字锚定（免模型，优先；两级截图）=====
          if (args.text) {
            const r1 = await this.locateByOcr(args.text);
            if (r1) {
              return this.clickByNative(
                r1.absX,
                r1.absY,
                `text="${args.text}" (Tier1 本机OCR锚定, ${r1.tier}级截图)`
              );
            }
            note = `Tier1 本机OCR未找到"${args.text}"；`;
          }

          // ===== Tier2：归一化坐标直接点击（回退；无模型依赖，最轻量，始终可用）=====
          if (typeof args.x === 'number' && typeof args.y === 'number') {
            return this.clickByNorm(args.x, args.y, `x,y=(${args.x},${args.y}) (Tier2 归一化回退)`);
          }

          // ===== Tier3：终极兜底，截图传视觉端点看图定位（需显式启用+配置）=====
          if (intent && this.visionEnabled) {
            const r3 = await this.locateByVision(intent, opts, timeout);
            if (r3) {
              return this.clickByNative(
                r3.absX,
                r3.absY,
                `intent="${intent}" (Tier3 视觉端点兜底, ${r3.tier}级截图)`
              );
            }
            return [
              textPart(
                `${note}Tier3 视觉端点未能从图中定位"${intent}"。三级兜底均失败，请换用 text 或 x,y，或检查 visionApiBaseUrl / visionApiModel / visionApiKey。`
              ),
            ];
          }

          // ===== 落到这里：没有任何可用路径 =====
          return [
            textPart(
              `${note}三级兜底均不可用：` +
                (this.visionEnabled
                  ? '请提供 text（Tier1 OCR）或 x,y（Tier2 归一化）；若想用 Tier3 看图定位，请给出文字意图（text / intent）。'
                  : '当前视觉兜底默认关闭，请直接用 x,y 给归一化坐标(0-1)点击；如需 OCR/看图，请在设置启用 visionFallbackEnabled 并填写 visionApiBaseUrl。')
            ),
          ];
        },
      },
    ];
  }

  /**
   * 两级截图 + 本机 OCR 定位：第一级按 lastNormPoint 局部裁剪（节约模式），
   * 若局部识别失败，降级第二级全屏。返回屏幕绝对原生坐标（absX/absY）。
   */
  private async locateByOcr(
    query: string
  ): Promise<{ absX: number; absY: number; tier: 1 | 2 } | null> {
    // 第一级：局部裁剪
    const crop = await this.captureForLocate();
    let words: OcrWord[] = await ocrNative(crop.base64);
    let box = findWord(words, query);
    let tier: 1 | 2 = 1;
    if (!box) {
      // 第二级：全屏
      const full = await captureScreenshot({
        maxWidth: this.cfg.screenshotMaxWidth,
        maxHeight: this.cfg.screenshotMaxHeight,
      });
      this.lastTransform = full;
      words = await ocrNative(full.base64);
      box = findWord(words, query);
      tier = 2;
      if (!box) return null;
      return this.boxToNative(full, box, tier);
    }
    return this.boxToNative(crop, box, tier);
  }

  /**
   * 两级截图 + 视觉端点定位（Tier3 终极兜底）：同上两级策略，最后一步才传图。
   */
  private async locateByVision(
    intent: string,
    opts: VisionOpts,
    timeout: number
  ): Promise<{ absX: number; absY: number; tier: 1 | 2 } | null> {
    const crop = await this.captureForLocate();
    let pt = await locateViaVision(crop.base64, opts, intent, timeout);
    let tier: 1 | 2 = 1;
    if (!pt) {
      const full = await captureScreenshot({
        maxWidth: this.cfg.screenshotMaxWidth,
        maxHeight: this.cfg.screenshotMaxHeight,
      });
      this.lastTransform = full;
      pt = await locateViaVision(full.base64, opts, intent, timeout);
      tier = 2;
      if (!pt) return null;
      return this.pointToNative(full, pt.x, pt.y, tier);
    }
    return this.pointToNative(crop, pt.x, pt.y, tier);
  }

  /** 基于 lastNormPoint 生成「局部裁剪」截屏；无基准时直接全屏。 */
  private async captureForLocate(): Promise<CaptureTransform> {
    const base = this.lastTransform;
    const pad = this.cfg.cropPadding;
    if (base && this.lastNormPoint && pad > 0) {
      const x0 = clamp01(this.lastNormPoint.x - pad);
      const y0 = clamp01(this.lastNormPoint.y - pad);
      const x1 = clamp01(this.lastNormPoint.x + pad);
      const y1 = clamp01(this.lastNormPoint.y + pad);
      const rx = Math.round(x0 * base.nativeWidth);
      const ry = Math.round(y0 * base.nativeHeight);
      const rw = Math.max(1, Math.round((x1 - x0) * base.nativeWidth));
      const rh = Math.max(1, Math.round((y1 - y0) * base.nativeHeight));
      try {
        return await captureScreenshot({
          maxWidth: this.cfg.screenshotMaxWidth,
          maxHeight: this.cfg.screenshotMaxHeight,
          region: { x: rx, y: ry, w: rw, h: rh },
        });
      } catch {
        /* 裁剪失败 -> 全屏兜底 */
      }
    }
    const full = await captureScreenshot({
      maxWidth: this.cfg.screenshotMaxWidth,
      maxHeight: this.cfg.screenshotMaxHeight,
    });
    this.lastTransform = full;
    return full;
  }

  /** OCR 文字框（归一化，相对本图）-> 屏幕绝对原生像素。 */
  private boxToNative(
    t: CaptureTransform,
    box: OcrWord,
    tier: 1 | 2
  ): { absX: number; absY: number; tier: 1 | 2 } {
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const { x, y } = normToNative(cx, cy, t);
    return { absX: x, absY: y, tier };
  }

  /** 视觉端点返回的中心归一化坐标 -> 屏幕绝对原生像素。 */
  private pointToNative(
    t: CaptureTransform,
    nx: number,
    ny: number,
    tier: 1 | 2
  ): { absX: number; absY: number; tier: 1 | 2 } {
    const { x, y } = normToNative(nx, ny, t);
    return { absX: x, absY: y, tier };
  }

  /** 归一化坐标(全屏) -> 原生像素 -> 真实点击（Tier2 用）。 */
  private async clickByNorm(nx: number, ny: number, how: string) {
    if (!this.lastTransform) {
      return [textPart('坐标基准丢失，请重新 localvision_see / localvision_ocr。')];
    }
    const { x, y } = normToNative(nx, ny, this.lastTransform);
    this.lastNormPoint = { x: clamp01(nx), y: clamp01(ny) };
    await clickAt(x, y);
    return [
      textPart(
        `已点击 [${how}]：归一化(${nx.toFixed(3)}, ${ny.toFixed(3)}) -> 原生像素(${x}, ${y})。` +
          ` 屏幕基准 ${this.lastTransform.nativeWidth}x${this.lastTransform.nativeHeight}。`
      ),
    ];
  }

  /** 屏幕绝对原生像素 -> 真实点击（Tier1/Tier3 用，坐标已知，无需基准）。 */
  private async clickByNative(absX: number, absY: number, how: string) {
    if (this.lastTransform) {
      this.lastNormPoint = {
        x: clamp01(absX / this.lastTransform.nativeWidth),
        y: clamp01(absY / this.lastTransform.nativeHeight),
      };
    }
    await clickAt(Math.round(absX), Math.round(absY));
    return [textPart(`已点击 [${how}]：原生像素(${Math.round(absX)}, ${Math.round(absY)})。`)];
  }

  // 环境提示词：让 agent 知道默认用本机 OCR + 归一化坐标，视觉兜底默认关闭且可配置。
  webUi(lang: string) {
    if (lang === 'zh') {
      return [
        {
          role: 'envPrompt',
          text:
            '你可以通过 localvision_see 工具"感知"屏幕：默认用本机原生 OCR 把屏幕转成文字描述返回给你，' +
            '不调用任何视觉模型、不把原始截图发给云端。屏幕没变时描述应当一致——据此判断是否需要重新观察。' +
            '（只有在设置中显式启用 visionFallbackEnabled 并填好 visionApiBaseUrl，才会改用视觉端点生成描述。）' +
            '点击屏幕请用 localvision_click，内部三级兜底：① text（本机 OCR 按屏幕文字锚定，免模型，优先，且先局部裁剪截图、失败再全屏）；' +
            '② x,y（直接给归一化坐标 0-1 回退，最轻量，始终可用）；③ 前两者都失败才重新截图交给视觉端点看图定位（终极兜底，默认关闭）。' +
            '所有坐标都归一化、与分辨率无关，由本机乘回原生像素执行，你无需关心屏幕实际分辨率。',
        },
      ];
    }
    return [
      {
        role: 'envPrompt',
        text:
          'You can "perceive" the screen via localvision_see: by default it uses on-device native OCR to return a text description — ' +
          'no vision model is called and no raw screenshot is sent to the cloud. ' +
          '(Only when visionFallbackEnabled is explicitly turned on AND a visionApiBaseUrl is configured does it use a vision endpoint.) ' +
          'To click, use localvision_click with a 3-tier fallback: ① text (on-device OCR anchors on screen text, model-free, preferred; crops locally first, falls back to full screen); ' +
          '② x,y normalized coordinates (0-1) as fallback (lightest, always available); ③ if both fail, re-screenshot and ask the configured vision endpoint to locate the target (ultimate fallback, OFF by default). ' +
          'All coordinates are normalized (0-1) and resolution-independent; the local machine maps them back to native pixels.',
      },
    ];
  }

  envPromptVars() {
    return {};
  }
}
