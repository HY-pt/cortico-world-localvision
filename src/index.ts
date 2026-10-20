/**
 * cortico-world-localvision
 * 本地视觉 World：截屏在本机由本地视觉模型转成稳定文字，云端只收文字。
 *
 * 设计目标（见 README）：把每轮变化的截图替换为「稳定文字描述」，
 * 让云端输入前缀保持稳定 -> 提示词缓存命中率上升 -> 未命中那 8% 的全价 token 消失，
 * 且视觉 token 趋近于 0。
 *
 * 注意：本文件是按 Cortico World 契约(api:6)写的脚手架。发布前请用
 *   pnpm describe:extension <目录> 与 pnpm check:extension <目录>
 * 校验，并以 cortico/world.ts 的真实类型为准微调。
 */

import type { WorldDefinition } from 'cortico/world.ts';
import { describeOllama, ocrWithVlm } from './vlm.ts';
import { captureScreenshot } from './screenshot.ts';

export interface LocalVisionSection {
  vlmBaseUrl: string; // OpenAI 兼容视觉端点，如 http://127.0.0.1:11434/v1
  vlmModel: string; // 本地视觉模型，如 minicpm-v2.6 / qwen2-vl / llava
  screenshotMaxWidth: number; // 与 cua 对齐的缩放空间，默认 1280
  screenshotMaxHeight: number; // 默认 800
  ocrEnabled: boolean;
  autoSeeOnStart: boolean; // 暂未使用，预留
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
  }),
  create: (ctx: any) => new LocalVisionWorld(ctx),
} satisfies WorldDefinition<LocalVisionSection>;

class LocalVisionWorld {
  constructor(private ctx: any) {}

  private get cfg(): LocalVisionSection {
    return this.ctx.config as LocalVisionSection;
  }

  tools() {
    return [
      {
        name: 'localvision_see',
        description:
          '截取当前主屏幕，在本机用本地视觉模型转成稳定的文字描述（可见窗口/应用、关键文字、可疑的可点击元素及其大致位置），不向云端发送任何图片。' +
          '用于"看"屏幕：每次调用返回的文字应尽量稳定，屏幕没变时描述不变，从而让云端缓存命中。',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: '可选的关注点，例如"只看右上角的按钮"或"找出登录表单"。',
            },
          },
        },
        call: async (args: { prompt?: string }) => {
          const img = await captureScreenshot(this.cfg.screenshotMaxWidth, this.cfg.screenshotMaxHeight);
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
          const img = await captureScreenshot(this.cfg.screenshotMaxWidth, this.cfg.screenshotMaxHeight);
          const text = await ocrWithVlm(img.base64, this.cfg.vlmBaseUrl, this.cfg.vlmModel);
          return [textPart(text)];
        },
      },
      {
        // STUB —— 点击功能仅留接口，实现方案见 README「点击设计」。
        name: 'localvision_click',
        description:
          '[接口占位] 按元素 id 或屏幕上出现的文字或像素坐标点击。当前为占位，尚未实现本地解析与执行。' +
          '推荐的最终形态：localvision_see 返回带 id 的元素清单，云端只选 id，由本机侧解析为坐标并点击。',
        parameters: {
          type: 'object',
          properties: {
            elementId: { type: 'string', description: 'localvision_see 返回的元素 id（优先）' },
            text: { type: 'string', description: '按屏幕上出现的文字点击（OCR 锚定）' },
            x: { type: 'number', description: '可选：直接像素坐标 x（回退用）' },
            y: { type: 'number', description: '可选：直接像素坐标 y（回退用）' },
          },
        },
        call: async () => {
          return [
            textPart(
              '[localvision_click] 尚未实现：点击为接口占位。请在 README 的「点击设计」中确定最终方案（元素 id / 文字锚定 / 坐标回退）后再实现本地解析与执行。'
            ),
          ];
        },
      },
    ];
  }

  // 环境提示词：让 agent 用本地视觉"看"屏，且知道云端不收图片。
  webUi(lang: string) {
    if (lang === 'zh') {
      return [
        {
          role: 'envPrompt',
          text:
            '你可以通过 localvision_see 工具"看"屏幕：它在你的电脑上本地运行视觉模型，' +
            '只把稳定的文字描述返回给你，不会向任何云端发送截图。' +
            '因此你看到的屏幕信息来自文字描述；做电脑操作时优先依据这些描述，不要假设自己能直接看到图片。' +
            '屏幕内容没变时，localvision_see 的返回应当一致——据此判断是否需要重新观察。',
        },
      ];
    }
    return [
      {
        role: 'envPrompt',
        text:
          'You can "see" the screen via the localvision_see tool, which runs a vision model locally on this computer ' +
          'and returns only a stable text description — no screenshot is ever sent to the cloud. ' +
          'Base computer actions on that description; do not assume you can see raw images. ' +
          'When the screen has not changed, localvision_see should return the same text — use that to decide whether to re-observe.',
      },
    ];
  }

  envPromptVars() {
    return {};
  }
}
