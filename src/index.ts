/**
 * cortico-world-localvision（本地视觉 / LocalVision）
 *
 * 定位：**只做「看屏幕」这一层**，操作电脑交给 Coopanion 内置的 `pet_cua_*` 工具。
 *
 *  - 看屏：截屏 → 本机 tesseract.js（WASM）OCR → 返回文字 + 截图像素坐标。
 *    默认不把截图发给云端，省掉每帧图片 token 和缓存击穿。
 *  - 硬拦截（Plan 1）：向打过 hook 的 Cortico 注册「工具回执变换」，在内置 cua 的截图回执
 *    落库前就把图片换成 OCR 文字——包括 pet_cua_screenshot 和动作后自动附的截图。
 *  - 兜底：屏幕上一行字都没有（纯图表/图片/视频）时，才把截图作为图片回退。
 *  - 操作：不提供点击/打字工具，直接用内置的 pet_cua_click / pet_cua_type / pet_cua_key /
 *    pet_cua_drag / pet_cua_scroll / pet_cua_windows / pet_cua_focus / pet_cua_wait。
 *
 * 坐标契约：本地截图与内置 cua 的截图都用 `min(maxW/w, maxH/h, 1)` 等比缩放、默认 1280×800；
 * 同一显示器下，`localvision_see` 返回的截图像素可以直接传给 `pet_cua_click`。
 *
 * 发布校验：pnpm describe:extension / pnpm check:extension
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { WorldDefinition } from 'cortico/world.ts';
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { ToolDef, ToolOutcome, WorldHost } from 'cortico/core/types.ts';
import { captureScreenshot } from './screenshot.ts';
import { disposeOcr, imageSize, ocrNative, ocrToText, ocrToLocatedText, type OcrOptions, type OcrWord } from './ocr.ts';

/** 核心 hook 的签名（老版本 cortico 类型里没有，运行时做能力检测）。 */
type OutcomeTransform = (out: ToolOutcome, info: { tool: string; world?: string }) => ToolOutcome | Promise<ToolOutcome>;
type HookHost = WorldHost & { registerToolOutcomeTransform?: (fn: OutcomeTransform) => () => void };

export interface LocalVisionSection {
  /** Cortico World 段开关（框架/部署控制）。 */
  enabled: boolean;
  /** OCR 语言：chi_sim（中英，默认）、eng、chi_sim+eng；也接受 zh-Hans / en-US 自动映射。 */
  ocrLang: string;
  /** 截图缩放上限；与内置 cua 的 screenshot.maxWidth 对齐，坐标才能直接复用。 */
  screenshotMaxWidth: number;
  screenshotMaxHeight: number;
  /** OCR 找不到文字时，是否把截图作为图片回退（用 Coopanion 已配的模型看图）。 */
  fallbackImage: boolean;
  /** 硬拦截：注册核心 hook，在内置 cua 的截图回执落库前换成 OCR 文本（需要打过 hook 的 Cortico）。 */
  hookIntercept: boolean;
  /** 额外强制拦截的工具名；带 screen/zoom/截图 特征的 blob 无论工具名都会被拦。 */
  hookTools: string[];
  /** OCR 找不到文字时：'image' 保留原图，'text' 丢弃图片只留提示。 */
  onOcrEmpty: 'image' | 'text';
}

/** 1 起的 display -> 0 起的 monitor；非法值返回 null 由调用方报错。 */
function toMonitor(display: unknown): number | null | undefined {
  if (display === undefined || display === null) return undefined;
  if (typeof display !== 'number' || !Number.isInteger(display) || display < 1) return null;
  return display - 1;
}

const TOOL_DECLS = [
  {
    name: 'localvision_see',
    description:
      '看屏幕：在本机截屏后用系统 OCR 把可见文字转成「文字 + 截图像素坐标」返回，默认不向云端上传图片（省 token）。' +
      '只有当屏幕上一行文字都没有、OCR 彻底失败时，才把截图作为图片回退。' +
      '返回的坐标可直接传给内置的 pet_cua_click（同一显示器、默认 1280×800 缩放）。',
    parameters: {
      type: 'object',
      properties: {
        display: {
          type: 'integer',
          minimum: 1,
          description: '显示器编号（1 起，1 = 最左）；缺省为主显示器。多屏时与 pet_cua_* 用同一个编号。',
        },
        prompt: {
          type: 'string',
          description: '可选：只想关注的内容（例如"右上角的按钮"）。仅作为提示，不影响 OCR 结果。',
        },
      },
      required: [],
    },
    tags: ['read', 'snapshot'],
  },
  {
    name: 'localvision_ocr',
    description:
      '逐字提取屏幕上的文字（本机原生 OCR），只返回纯文本、不含坐标、不回退图片。适合读错误消息、字段名等具体文字。',
    parameters: {
      type: 'object',
      properties: {
        display: {
          type: 'integer',
          minimum: 1,
          description: '显示器编号（1 起，1 = 最左）；缺省为主显示器。',
        },
      },
      required: [],
    },
    tags: ['read'],
  },
];

function localvisionConfigGroup(lang: string): ConfigGroup {
  const zh = lang !== 'en';
  const K = 'worlds.localvision';
  return {
    id: 'world:localvision',
    owner: 'world:localvision',
    schema: {
      type: 'object',
      title: zh ? '本地视觉' : 'Local vision',
      properties: {
        [`${K}.ocrLang`]: {
          type: 'string',
          title: zh ? 'OCR 语言' : 'OCR language',
          description: zh ? 'chi_sim（中英）/ eng / chi_sim+eng' : 'chi_sim / eng / chi_sim+eng',
          'x-hot': true,
        },
        [`${K}.screenshotMaxWidth`]: { type: 'integer', title: zh ? '截图最大宽' : 'Max width', minimum: 320, maximum: 3840, 'x-suffix': 'px', 'x-hot': true },
        [`${K}.screenshotMaxHeight`]: { type: 'integer', title: zh ? '截图最大高' : 'Max height', minimum: 240, maximum: 2160, 'x-suffix': 'px', 'x-hot': true },
        [`${K}.fallbackImage`]: { type: 'boolean', title: zh ? '无文字时回退图片' : 'Fall back to image', 'x-hot': true },
        [`${K}.hookIntercept`]: {
          type: 'boolean',
          title: zh ? '硬拦截截图（需框架 hook）' : 'Intercept screenshots (needs hook)',
          description: zh
            ? '注册核心变换，把内置 cua 的截图换成 OCR 文字；框架没打 hook 时自动降级。'
            : 'Replace screenshot tool results with OCR text; degrades when the framework has no hook.',
          'x-hot': true,
        },
        [`${K}.onOcrEmpty`]: {
          type: 'string',
          title: zh ? 'OCR 无文字时' : 'When OCR finds nothing',
          enum: ['image', 'text'],
          'x-hot': true,
        },
      },
    },
  };
}

export default {
  id: 'localvision',
  label: '本地视觉 LocalVision',
  defaults: (): LocalVisionSection => ({
    enabled: false,
    ocrLang: '',
    screenshotMaxWidth: 1280,
    screenshotMaxHeight: 800,
    fallbackImage: true,
    hookIntercept: true,
    hookTools: ['pet_cua_screenshot', 'pet_cua_zoom', 'cua_screenshot', 'cua_zoom'],
    onOcrEmpty: 'image',
  }),
  describe: {
    tools: TOOL_DECLS,
    events: [],
  },
  create: (ctx: any) => new LocalVisionWorld(ctx),
} satisfies WorldDefinition<LocalVisionSection>;

class LocalVisionWorld {
  readonly id = 'localvision';
  private host: WorldHost | null = null;
  private unregisterHook: (() => void) | null = null;
  /** 同一张截图重复出现时（历史重放、动作后截图）不重复 OCR。 */
  private readonly ocrCache = new Map<string, OcrWord[]>();

  constructor(private ctx: any) {}

  private get cfg(): LocalVisionSection {
    return this.ctx.config as LocalVisionSection;
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    const hookHost = host as HookHost;
    if (this.cfg.hookIntercept && typeof hookHost.registerToolOutcomeTransform === 'function') {
      this.unregisterHook = hookHost.registerToolOutcomeTransform((out, info) => this.transformToolOutcome(out, info));
    }
  }

  async stop(): Promise<void> {
    this.unregisterHook?.();
    this.unregisterHook = null;
    this.host = null;
    await disposeOcr();
  }

  /** tesseract 语言数据缓存目录（部署数据目录下）。 */
  private get cacheDir(): string {
    const base = typeof this.ctx?.dataDir === 'string' && this.ctx.dataDir ? this.ctx.dataDir : tmpdir();
    return join(base, 'localvision-tessdata');
  }

  /** OCR 参数：语言、traineddata 缓存目录，以及本次截图的坐标基准。 */
  private ocrOptions(img: { scaledWidth: number; scaledHeight: number }): OcrOptions {
    return {
      lang: this.cfg.ocrLang || undefined,
      cacheDir: this.cacheDir,
      width: img.scaledWidth,
      height: img.scaledHeight,
    };
  }

  private isImage(blob: unknown): boolean {
    const mime = (blob as { mime?: unknown })?.mime;
    return typeof mime === 'string' && mime.startsWith('image/');
  }

  /** 截图特征：内置 cua 的 blob 叫 screen.jpg / zoom.jpg，fallbackText 是「屏幕截图 …」。 */
  private isScreenshotBlob(blob: unknown): boolean {
    if (!this.isImage(blob)) return false;
    const b = blob as { name?: unknown; fallbackText?: unknown };
    return /screen|zoom|截图|截圖/i.test(`${b.name ?? ''} ${b.fallbackText ?? ''}`);
  }

  private blobBytes(blob: unknown): Uint8Array | null {
    const b = blob as { bytes?: unknown; handle?: unknown };
    if (b?.bytes instanceof Uint8Array) return b.bytes;
    if (typeof b?.handle === 'string') return this.host?.blob(b.handle)?.bytes ?? null;
    return null;
  }

  /**
   * 核心 hook：工具回执落库前把截图换成 OCR 文字。
   * 只处理「截图特征」的图片，或明确列进 hookTools 的工具返回的图片；生成图/用户图原样保留。
   */
  private async transformToolOutcome(out: ToolOutcome, info: { tool: string; world?: string }): Promise<ToolOutcome> {
    const blobs = out.blobs;
    if (!this.cfg.hookIntercept || !blobs?.length) return out;
    const forced = this.cfg.hookTools.includes(info.tool);
    const targets = blobs.filter((b) => this.isScreenshotBlob(b) || (forced && this.isImage(b)));
    if (!targets.length) return out;

    let text = out.text;
    const kept: NonNullable<ToolOutcome['blobs']> = [];
    let changed = false;

    for (const blob of blobs) {
      if (!targets.includes(blob)) {
        kept.push(blob);
        continue;
      }
      const bytes = this.blobBytes(blob);
      const dims = bytes ? imageSize(bytes) : null;
      if (!bytes || !dims) {
        kept.push(blob);
        continue;
      }

      const key = createHash('sha256').update(bytes).digest('hex');
      let words = this.ocrCache.get(key);
      if (!words) {
        words = await ocrNative(Buffer.from(bytes).toString('base64'), {
          lang: this.cfg.ocrLang || undefined,
          cacheDir: this.cacheDir,
          width: dims.w,
          height: dims.h,
        });
        if (this.ocrCache.size > 200) this.ocrCache.clear();
        this.ocrCache.set(key, words);
      }

      if (words.length) {
        text +=
          `\n\n[本机 OCR] 这张截图已在本地转成文字，未上传图片：\n` +
          `${ocrToLocatedText(words, dims.w, dims.h)}\n` +
          `坐标 = 该截图像素，可直接传给 pet_cua_click。`;
        changed = true;
      } else if (this.cfg.onOcrEmpty === 'text') {
        text += `\n\n[本机 OCR] 这张截图没有识别到文字，图片已丢弃。`;
        changed = true;
      } else {
        kept.push(blob);
      }
    }

    if (!changed) return out;
    return { ...out, text, ...(kept.length ? { blobs: kept } : { blobs: undefined }) };
  }

  private get acceptsImage(): boolean {
    return this.host?.modelFacts.accepts('image/png') ?? true;
  }

  private async capture(display: unknown) {
    const monitor = toMonitor(display);
    if (monitor === null) throw new Error('display 要是 1 起的整数');
    return captureScreenshot({
      maxWidth: this.cfg.screenshotMaxWidth,
      maxHeight: this.cfg.screenshotMaxHeight,
      monitor,
    });
  }

  private hint(display: unknown): string {
    const n = typeof display === 'number' ? display : 1;
    return `坐标 = 本次截图像素，可直接传给 pet_cua_click（与内置 cua 同显示器 ${n}、同 ${this.cfg.screenshotMaxWidth}×${this.cfg.screenshotMaxHeight} 缩放）。`;
  }

  tools(): ToolDef[] {
    const handlers: Record<string, (args: Record<string, unknown>) => Promise<ToolOutcome>> = {
      localvision_see: async (args) => {
        const img = await this.capture(args.display);
        const W = img.scaledWidth;
        const H = img.scaledHeight;
        const base = `截图 ${W}×${H}（屏幕 ${img.nativeWidth}×${img.nativeHeight}）。`;
        try {
          const words = await ocrNative(img.base64, this.ocrOptions(img));
          if (words.length) {
            return {
              text:
                `${base}\n[本机 OCR] 截图未上传，只返回文字与坐标：\n` +
                ocrToLocatedText(words, W, H) +
                `\n\n${this.hint(args.display)}`,
            };
          }
        } catch {
          /* 落到下面的回退 */
        }
        if (this.cfg.fallbackImage && this.acceptsImage) {
          return {
            text: `${base}\n[本机 OCR] 未识别到文字，已回退为截图图片。`,
            blobs: [
              {
                bytes: Buffer.from(img.base64, 'base64'),
                mime: 'image/png',
                name: 'screen.png',
                fallbackText: `屏幕截图 ${W}×${H}`,
              },
            ],
          };
        }
        return {
          text:
            `${base}\n[本机 OCR] 未识别到文字。` +
            (this.acceptsImage ? '（已关闭图片回退）' : '且当前模型不接收图片。') +
            `\n可以用 pet_cua_windows 列窗口，或直接按已知坐标操作。`,
        };
      },
      localvision_ocr: async (args) => {
        const img = await this.capture(args.display);
        const words = await ocrNative(img.base64, this.ocrOptions(img));
        if (!words.length) {
          return {
            text:
              `[localvision_ocr] 本机 OCR 未识别到文字（截图 ${img.scaledWidth}×${img.scaledHeight}）。` +
              `请确认系统 OCR 语言包已安装${this.cfg.ocrLang ? '' : '，或在配置里填 ocrLang'}。`,
            failed: true,
          };
        }
        return { text: ocrToText(words) };
      },
    };

    return TOOL_DECLS.map((decl) => ({
      ...decl,
      tags: [...decl.tags],
      handler: async (args) => {
        try {
          return await handlers[decl.name](args);
        } catch (err) {
          return { text: `[${decl.name} 失败] ${(err as Error).message}`, failed: true as const };
        }
      },
    }));
  }

  envPromptVars(): Record<string, string> {
    return {
      'localvision.intercept': this.unregisterHook
        ? '截图已在本地硬拦截：pet_cua_screenshot 返回的图片会被本机 OCR 转成文字，不会上传；正常使用即可。'
        : '本机没有硬拦截：不要调用 pet_cua_screenshot / pet_cua_zoom（会传图）；动作工具请传 screenshot:false。',
    };
  }

  webUi(lang: string) {
    const zh = lang !== 'en';
    return {
      label: '本地视觉 LocalVision',
      config: [localvisionConfigGroup(lang)],
      promptDocs: [
        {
          key: 'worlds.localvision.envPrompt',
          title: zh ? '本地视觉环境' : 'Local vision environment',
          description: zh ? '看屏用 localvision_see，操作用内置 pet_cua_*。' : 'Look with localvision_see, act with the built-in pet_cua_*.',
          path: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)),
          role: 'envPrompt' as const,
          vars: [{ name: 'localvision.intercept', description: zh ? '硬拦截是否生效' : 'Whether hard interception is active' }],
        },
      ],
    };
  }
}
