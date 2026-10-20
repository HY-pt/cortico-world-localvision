/**
 * cortico-world-localvision（本地视觉 / LocalVision）
 *
 * 定位：**只做「看屏幕」这一层**，操作电脑交给 Coopanion 内置的 `pet_cua_*` 工具。
 *
 *  - 看屏：截屏 → 本机原生 OCR（Windows WinRT / macOS·Linux tesseract）→ 返回文字 + 截图像素坐标。
 *    默认不把截图发给云端，省掉每帧图片 token 和缓存击穿。
 *  - 兜底：屏幕上一行字都没有（纯图表/图片/视频）时，才把截图作为图片回退（用 Coopanion 已配的模型看图）。
 *  - 操作：不提供点击/打字工具，直接用内置的 pet_cua_click / pet_cua_type / pet_cua_key /
 *    pet_cua_drag / pet_cua_scroll / pet_cua_windows / pet_cua_focus / pet_cua_wait，并传 screenshot:false。
 *
 * 坐标契约：本地截图与内置 cua 的截图都用 `min(maxW/w, maxH/h, 1)` 等比缩放、默认 1280×800；
 * 同一显示器下，`localvision_see` 返回的截图像素可以直接传给 `pet_cua_click`。
 *
 * 发布校验：pnpm describe:extension / pnpm check:extension
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorldDefinition } from 'cortico/world.ts';
import type { ToolDef, ToolOutcome, WorldHost } from 'cortico/core/types.ts';
import { captureScreenshot } from './screenshot.ts';
import { disposeOcr, ocrNative, ocrToText, ocrToLocatedText, type OcrOptions } from './ocr.ts';

export interface LocalVisionSection {
  /** Cortico World 段开关（框架/部署控制）。 */
  enabled: boolean;
  /** OCR 语言：Windows 填 WinRT 码（zh-Hans），macOS/Linux 填 tesseract 码（chi_sim）；留空跟随系统。 */
  ocrLang: string;
  /** 截图缩放上限；与内置 cua 的 screenshot.maxWidth 对齐，坐标才能直接复用。 */
  screenshotMaxWidth: number;
  screenshotMaxHeight: number;
  /** OCR 找不到文字时，是否把截图作为图片回退（用 Coopanion 已配的模型看图）。 */
  fallbackImage: boolean;
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

export default {
  id: 'localvision',
  label: '本地视觉 LocalVision',
  defaults: (): LocalVisionSection => ({
    enabled: true,
    ocrLang: '',
    screenshotMaxWidth: 1280,
    screenshotMaxHeight: 800,
    fallbackImage: true,
  }),
  describe: {
    tools: TOOL_DECLS,
    events: [],
  },
  create: (ctx: any) => new LocalVisionWorld(ctx),
} satisfies WorldDefinition<LocalVisionSection>;

class LocalVisionWorld {
  private host: WorldHost | null = null;

  constructor(private ctx: any) {}

  private get cfg(): LocalVisionSection {
    return this.ctx.config as LocalVisionSection;
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
  }

  async stop(): Promise<void> {
    this.host = null;
    await disposeOcr();
  }

  /** OCR 参数：语言、traineddata 缓存目录（部署数据目录下），以及本次截图的坐标基准。 */
  private ocrOptions(img: { scaledWidth: number; scaledHeight: number }): OcrOptions {
    const base = typeof this.ctx?.dataDir === 'string' && this.ctx.dataDir ? this.ctx.dataDir : tmpdir();
    return {
      lang: this.cfg.ocrLang || undefined,
      cacheDir: join(base, 'localvision-tessdata'),
      width: img.scaledWidth,
      height: img.scaledHeight,
    };
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
    return {};
  }

  webUi(lang: string) {
    const zh = lang !== 'en';
    const guide = zh
      ? '看屏幕一律用 localvision_see（本机 OCR，返回文字 + 截图像素坐标，不把图片发给云端）；只要文字时用 localvision_ocr。\n' +
        '操作电脑用内置的 pet_cua_* 工具：点击 pet_cua_click、移动 pet_cua_move、拖拽 pet_cua_drag、滚动 pet_cua_scroll、打字 pet_cua_type、按键 pet_cua_key、窗口 pet_cua_windows / pet_cua_focus、等待 pet_cua_wait。\n' +
        '- 每次调用都传 screenshot:false，避免动作完成后自动附截图（那会把图片发给云端）；\n' +
        '- 动作完成后再调用 localvision_see 确认结果。\n' +
        '不要调用 pet_cua_screenshot / pet_cua_zoom（它们会传图片）；只有 localvision_see 明确说「未识别到文字、已回退为截图图片」时才看图。\n' +
        '坐标直接用 localvision_see 返回的截图像素，它与 pet_cua_* 一致（同一显示器、同样的 1280×800 缩放）；多屏时给 localvision_see 传同一个 display（1 起）。'
      : 'Always look at the screen with localvision_see (on-device OCR: text + screenshot-pixel coordinates, no image sent to the cloud); use localvision_ocr when you only need text.\n' +
        'Operate the computer with the built-in pet_cua_* tools: pet_cua_click, pet_cua_move, pet_cua_drag, pet_cua_scroll, pet_cua_type, pet_cua_key, pet_cua_windows / pet_cua_focus, pet_cua_wait.\n' +
        '- Pass screenshot:false on every call so an action does not attach a screenshot (that would upload an image);\n' +
        '- Call localvision_see again after an action to confirm the result.\n' +
        'Do not call pet_cua_screenshot / pet_cua_zoom (they upload images); only look at an image when localvision_see says it fell back to one.\n' +
        'Use the screenshot-pixel coordinates localvision_see returns; they match pet_cua_* (same display, same 1280×800 scaling). On multiple displays, pass the same display (1-based) to localvision_see.';
    return [{ role: 'envPrompt' as const, text: guide }];
  }
}
