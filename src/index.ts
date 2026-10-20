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
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { WorldDefinition } from 'cortico/world.ts';
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { ToolDef, ToolOutcome, WorldHost } from 'cortico/core/types.ts';
import { captureScreenshot } from './screenshot.ts';
import {
  autoOcrLang,
  disposeOcr,
  imageSize,
  ocrNative,
  ocrToText,
  ocrToLocatedTextMapped,
  resolveOcrLangs,
  systemLocale,
  type OcrOptions,
  type OcrWord,
} from './ocr.ts';

/** 核心 hook 的签名（老版本 cortico 类型里没有，运行时做能力检测）。 */
type OutcomeTransform = (out: ToolOutcome, info: { tool: string; world?: string }) => ToolOutcome | Promise<ToolOutcome>;
type HookHost = WorldHost & { registerToolOutcomeTransform?: (fn: OutcomeTransform) => () => void };

export interface LocalVisionSection {
  /** Cortico World 段开关（框架/部署控制）。 */
  enabled: boolean;
  /** OCR 语言：auto（跟随系统语言）/ chi_sim / eng / chi_sim+eng；也接受 zh-Hans / en-US 映射。 */
  ocrLang: string;
  /** 截图缩放上限；与内置 cua 的 screenshot.maxWidth 对齐，坐标才能直接复用。 */
  screenshotMaxWidth: number;
  screenshotMaxHeight: number;
  /** 硬拦截：注册核心 hook，在内置 cua 的截图回执落库前换成 OCR 文本（需要打过 hook 的 Cortico）。 */
  hookIntercept: boolean;
  /** 额外强制拦截的工具名；带 screen/zoom/截图 特征的 blob 无论工具名都会被拦。 */
  hookTools: string[];
  /** OCR 找不到文字时（硬拦截与 see 工具共用）：'image' 把截图作为图片发给 Coopanion 对话模型，'text' 丢弃图片只留提示。 */
  onOcrEmpty: 'image' | 'text';
  /** 视觉模型端点（本地或线上，OpenAI 兼容 / Anthropic / Responses / 自定义路径）；默认关闭。 */
  localModelEnabled: boolean;
  /** 厂商预设：openai/anthropic/gemini/deepseek/qwen/openrouter/xai/kimi/zhipu/minimax/doubao/qianfan/stepfun/ollama/lmstudio/custom。 */
  localModelProvider: string;
  localModelBaseUrl: string;
  localModelApiKey: string;
  localModelName: string;
  localModelTimeoutMs: number;
  /** 协议：auto（跟随厂商预设）/ openai-chat / anthropic-messages / openai-responses / custom。 */
  localModelProtocol: 'auto' | 'openai-chat' | 'anthropic-messages' | 'openai-responses' | 'custom';
  /** custom 协议的请求路径，默认 /chat/completions（仍是 OpenAI Chat 兼容体）。 */
  localModelPath: string;
  localModelMaxTokens: number;
  localModelTemperature: number;
  /** 追加给视觉模型的指令；留空用内置提示。 */
  localModelPrompt: string;
  /** OpenAI 兼容的 image_url detail。 */
  localModelDetail: 'auto' | 'low' | 'high';
  /** 感知优先级：auto（OCR→模型→图片）/ ocr-only / model-first / model-only / image-only。 */
  visionStrategy: 'auto' | 'ocr-only' | 'model-first' | 'model-only' | 'image-only';
  /** 优先用哪个模型看图：auto（本地>在线>Coopanion 兜底）/ local / online / coop。 */
  localModelPriority: 'auto' | 'local' | 'online' | 'coop';
}

/** 1 起的 display -> 0 起的 monitor；非法值返回 null 由调用方报错。 */
function toMonitor(display: unknown): number | null | undefined {
  if (display === undefined || display === null) return undefined;
  if (typeof display !== 'number' || !Number.isInteger(display) || display < 1) return null;
  return display - 1;
}

type Region = { x: number; y: number; w: number; h: number };

/** `region` 用截图坐标（与 localvision_see 返回的坐标同一空间）。 */
function parseRegion(v: unknown): Region | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  const num = (k: string): number | null => (typeof r[k] === 'number' && Number.isFinite(r[k]) ? (r[k] as number) : null);
  const x = num('x');
  const y = num('y');
  const w = num('w');
  const h = num('h');
  if (x === null || y === null || w === null || h === null || w < 1 || h < 1) return undefined;
  return { x, y, w, h };
}

/** 局部裁剪参数：坐标与 localvision_see 返回的截图坐标同一空间。 */
const REGION = {
  type: 'object',
  properties: {
    x: { type: 'integer', minimum: 0 },
    y: { type: 'integer', minimum: 0 },
    w: { type: 'integer', minimum: 1 },
    h: { type: 'integer', minimum: 1 },
  },
  required: ['x', 'y', 'w', 'h'],
  description: '只截这块再 OCR（小字更准）。坐标用上一次 localvision_see 返回的截图坐标（同一坐标系）。',
};

/** 诊断报告的结构化形态：面板按卡片渲染，工具只取 text。 */
export interface DoctorRow {
  label: string;
  value: string;
}
export interface DoctorSection {
  title: string;
  rows: DoctorRow[];
}
export interface DoctorReport {
  text: string;
  sections: DoctorSection[];
  model: DoctorRow[];
  tips: string[];
}

/** 厂商预设：只提供 base URL 与默认协议，用户仍可用地址/协议覆盖。 */
const PROVIDERS: Record<string, { base: string; protocol: 'openai-chat' | 'anthropic-messages' | 'openai-responses' }> = {
  openai: { base: 'https://api.openai.com/v1', protocol: 'openai-chat' },
  anthropic: { base: 'https://api.anthropic.com/v1', protocol: 'anthropic-messages' },
  gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/openai', protocol: 'openai-chat' },
  deepseek: { base: 'https://api.deepseek.com/v1', protocol: 'openai-chat' },
  qwen: { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'openai-chat' },
  openrouter: { base: 'https://openrouter.ai/api/v1', protocol: 'openai-chat' },
  xai: { base: 'https://api.x.ai/v1', protocol: 'openai-chat' },
  kimi: { base: 'https://api.moonshot.cn/v1', protocol: 'openai-chat' },
  zhipu: { base: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'openai-chat' },
  minimax: { base: 'https://api.minimaxi.com/v1', protocol: 'openai-chat' },
  doubao: { base: 'https://ark.cn-beijing.volces.com/api/v3', protocol: 'openai-chat' },
  qianfan: { base: 'https://qianfan.baidubce.com/v2', protocol: 'openai-chat' },
  stepfun: { base: 'https://api.stepfun.com/v1', protocol: 'openai-chat' },
  ollama: { base: 'http://127.0.0.1:11434/v1', protocol: 'openai-chat' },
  lmstudio: { base: 'http://127.0.0.1:1234/v1', protocol: 'openai-chat' },
  custom: { base: '', protocol: 'openai-chat' },
};

/** 面板下拉里的厂商名（含中文别名）；顺序即下拉顺序。 */
const PROVIDER_LABELS: ReadonlyArray<{ value: string; zh: string; en: string }> = [
  { value: 'custom', zh: '自定义（自己填地址）', en: 'Custom (fill your own)' },
  { value: 'openai', zh: 'OpenAI', en: 'OpenAI' },
  { value: 'anthropic', zh: 'Anthropic Claude', en: 'Anthropic Claude' },
  { value: 'gemini', zh: 'Google Gemini', en: 'Google Gemini' },
  { value: 'deepseek', zh: 'DeepSeek', en: 'DeepSeek' },
  { value: 'qwen', zh: '通义千问 Qwen', en: 'Qwen' },
  { value: 'openrouter', zh: 'OpenRouter', en: 'OpenRouter' },
  { value: 'xai', zh: 'xAI Grok', en: 'xAI Grok' },
  { value: 'kimi', zh: 'Kimi（月之暗面）', en: 'Kimi (Moonshot)' },
  { value: 'zhipu', zh: '智谱 GLM', en: 'Zhipu GLM' },
  { value: 'minimax', zh: 'MiniMax', en: 'MiniMax' },
  { value: 'doubao', zh: '豆包 Doubao（火山方舟）', en: 'Doubao (Volcengine Ark)' },
  { value: 'qianfan', zh: '百度千帆', en: 'Baidu Qianfan' },
  { value: 'stepfun', zh: '阶跃星辰 StepFun', en: 'StepFun' },
  { value: 'ollama', zh: 'Ollama（本机）', en: 'Ollama (local)' },
  { value: 'lmstudio', zh: 'LM Studio（本机）', en: 'LM Studio (local)' },
];

/** 预设 + 用户覆盖 -> 实际 base URL / 协议。 */
function resolveEndpoint(cfg: LocalVisionSection): {
  base: string;
  protocol: 'openai-chat' | 'anthropic-messages' | 'openai-responses' | 'custom';
} {
  const preset = PROVIDERS[cfg.localModelProvider] ?? PROVIDERS.custom;
  const base = (cfg.localModelBaseUrl || '').trim().replace(/\/+$/, '') || preset.base;
  const protocol = cfg.localModelProtocol === 'auto' ? preset.protocol : cfg.localModelProtocol;
  return { base, protocol };
}

const TOOL_DECLS = [
  {
    name: 'localvision_see',
    description:
      '看屏幕：在本机截屏后用系统 OCR 把可见文字转成「文字 + 截图像素坐标」返回，默认不向云端上传图片（省 token）。' +
      '小字看不清时，可用上一次返回的坐标传 region 再 OCR 一次，会在原始分辨率下识别。' +
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
        region: REGION,
      },
      required: [],
    },
    tags: ['read', 'snapshot'],
  },
  {
    name: 'localvision_ocr',
    description:
      '逐字提取屏幕上的文字（本机原生 OCR），只返回纯文本、不含坐标、不回退图片。适合读错误消息、字段名等具体文字；小字可传 region 局部放大识别。',
    parameters: {
      type: 'object',
      properties: {
        display: {
          type: 'integer',
          minimum: 1,
          description: '显示器编号（1 起，1 = 最左）；缺省为主显示器。',
        },
        region: REGION,
      },
      required: [],
    },
    tags: ['read'],
  },
  {
    name: 'localvision_describe',
    description:
      '用视觉模型描述画面（游戏、图片、图表、视频帧等 OCR 读不出来的内容）。需要先在配置里启用视觉模型；图片发到配置的端点（本地或线上）。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '想问本地视觉模型的问题；缺省为"描述截图内容"。' },
        display: { type: 'integer', minimum: 1, description: '显示器编号（1 起）；缺省为主显示器。' },
        region: REGION,
      },
      required: [],
    },
    tags: ['read', 'snapshot'],
  },
  {
    name: 'localvision_doctor',
    description:
      '诊断本地视觉：报告屏幕/DPI、OCR 语言与已缓存语言包、硬拦截是否生效、视觉模型端点配置；checkModel=true 时还会实际请求一次端点。排查“识别不准/模型不工作”时先跑它。',
    parameters: {
      type: 'object',
      properties: {
        checkModel: { type: 'boolean', description: '是否实际请求一次视觉模型端点（会消耗少量 token）。默认 false。' },
      },
      required: [],
    },
    tags: ['read'],
  },
];

/**
 * 配置拆两组：截图/OCR 一张卡、视觉模型一张卡。
 * 19 项堆一张卡太挤，模型那组里的「地址/路径」也是 custom 真正要填的空位。
 */
function ocrConfigGroup(lang: string): ConfigGroup {
  const zh = lang !== 'en';
  const K = 'worlds.localvision';
  return {
    id: 'world:localvision',
    owner: 'world:localvision',
    schema: {
      type: 'object',
      title: zh ? '本地视觉 · 配置' : 'Local vision · settings',
      description: zh
        ? '看屏与视觉模型的所有配置（与「模型」面板是同一份；面板是更顺手的编辑器，这里作为原始/高级入口）。改了即时生效，不用重启。'
        : 'All capture and vision-model settings (same source as the Model panel, which is the friendlier editor; this is the raw/advanced entry). Changes apply immediately.',
      properties: {
        [`${K}.visionStrategy`]: {
          type: 'string',
          title: zh ? '感知优先级' : 'Perception order',
          enum: ['auto', 'ocr-only', 'model-first', 'model-only', 'image-only'],
          'x-hot': true,
          description: zh
            ? 'auto=OCR→视觉模型→图片（默认，OCR 优先，最省 token）；ocr-only 只 OCR；model-first 先模型再 OCR；model-only 只模型；image-only 直接回退图片（游戏/视频）。'
            : 'auto=OCR→model→image (default, OCR first); ocr-only; model-first; model-only; image-only.',
        },
        [`${K}.localModelPriority`]: {
          type: 'string',
          title: zh ? '优先选择的模型' : 'Preferred model',
          enum: ['auto', 'local', 'online', 'coop'],
          'x-hot': true,
          description: zh
            ? '看图用哪个模型：auto=按 本地>在线>Coopanion 模型商 自动路由（端点按地址自动判本地/在线，最后兜底把截图交给 Coopanion 对话模型）；local=只用本地端点；online=只用在线端点；coop=直接用 Coopanion 模型商。'
            : 'Which model describes images: auto routes local>online>Coopanion; local/online pin one; coop uses the Coopanion chat model.',
        },
        [`${K}.ocrLang`]: {
          type: 'string',
          title: zh ? 'OCR 语言' : 'OCR language',
          description: zh ? 'auto（跟随系统语言）/ chi_sim / eng / chi_sim+eng' : 'auto (follow system locale) / chi_sim / eng / chi_sim+eng',
          'x-hot': true,
        },
        [`${K}.screenshotMaxWidth`]: { type: 'integer', title: zh ? '截图最大宽' : 'Max width', minimum: 320, maximum: 3840, 'x-suffix': 'px', 'x-hot': true },
        [`${K}.screenshotMaxHeight`]: { type: 'integer', title: zh ? '截图最大高' : 'Max height', minimum: 240, maximum: 2160, 'x-suffix': 'px', 'x-hot': true },
        [`${K}.onOcrEmpty`]: {
          type: 'string',
          title: zh ? 'OCR 无文字时' : 'When OCR finds nothing',
          enum: ['image', 'text'],
          description: zh
            ? 'OCR 没认出文字时怎么办（硬拦截截图与「看一眼」工具共用这一开关）：image=把截图作为图片发给 Coopanion 已配的模型（费 token）；text=丢弃图片只回文字（默认，最省 token）。'
            : 'When OCR finds no text (shared by intercepted screenshots and the see tool): image sends the screenshot to the Coopanion model (costs tokens); text drops it (default).',
          'x-hot': true,
        },
        [`${K}.hookIntercept`]: {
          type: 'boolean',
          title: zh ? '硬拦截截图（需框架 hook）' : 'Intercept screenshots (needs hook)',
          description: zh
            ? '注册核心变换，把内置 cua 的截图换成 OCR 文字；框架没打 hook 时自动降级。'
            : 'Replace screenshot tool results with OCR text; degrades when the framework has no hook.',
          'x-hot': true,
        },
        // ↓ 视觉模型全部配置（与「模型」面板是同一份，面板是更顺手的编辑器）。
        [`${K}.localModelEnabled`]: {
          type: 'boolean',
          title: zh ? '启用视觉模型（本地/线上）' : 'Vision model (local/online)',
          description: zh
            ? 'OCR 读不出内容时（游戏/图片/图表），用 OpenAI 兼容或 Anthropic 端点描述画面；本地端点图片不离开本机，线上端点按厂商隐私政策。'
            : 'Describe non-text content (games/images/charts) with an OpenAI-compatible or Anthropic endpoint; local endpoints keep the image on this machine, online ones follow the vendor policy.',
          'x-hot': true,
        },
        [`${K}.localModelProvider`]: {
          type: 'string',
          title: zh ? '厂商预设' : 'Provider preset',
          enum: ['custom', 'openai', 'anthropic', 'gemini', 'deepseek', 'qwen', 'openrouter', 'xai', 'kimi', 'zhipu', 'minimax', 'doubao', 'qianfan', 'stepfun', 'ollama', 'lmstudio'],
          'x-hot': true,
          description: zh
            ? '选厂商后，地址留空就用它的默认地址、协议选 auto 就用它的默认协议；选 custom 时必须自己填下面的「视觉模型地址」。'
            : 'Pick a vendor: leave the base URL empty for its default and protocol auto for its default. Choosing custom requires the base URL below.',
        },
        [`${K}.localModelBaseUrl`]: {
          type: 'string',
          title: zh ? '视觉模型地址（custom 就填这里）' : 'Vision model base URL (fill this for custom)',
          description: zh
            ? '选了厂商预设可以留空（用它的默认地址）；选 custom 必须自己填。如 https://api.openai.com/v1、https://api.deepseek.com/v1、https://dashscope.aliyuncs.com/compatible-mode/v1、https://openrouter.ai/api/v1、http://127.0.0.1:11434/v1'
            : 'Leave empty to use the vendor preset default; required when the preset is custom. e.g. https://api.openai.com/v1, https://openrouter.ai/api/v1, http://127.0.0.1:11434/v1',
          'x-hot': true,
        },
        [`${K}.localModelProtocol`]: {
          type: 'string',
          title: zh ? '协议' : 'Protocol',
          enum: ['auto', 'openai-chat', 'anthropic-messages', 'openai-responses', 'custom'],
          'x-hot': true,
          description: zh
            ? 'auto=跟随厂商预设；openai-chat（OpenAI/DeepSeek/Qwen/OpenRouter/Gemini 兼容…）；anthropic-messages；openai-responses；custom=自定义路径（仍是 OpenAI Chat 请求体）。'
            : 'auto follows the provider preset; openai-chat; anthropic-messages; openai-responses; custom uses the custom path with an OpenAI Chat body.',
        },
        [`${K}.localModelPath`]: {
          type: 'string',
          title: zh ? '自定义路径（选 custom 协议填这里）' : 'Custom path (fill this for the custom protocol)',
          description: zh ? '仅 custom 协议用，会拼在地址后面；默认 /chat/completions。' : 'Only for the custom protocol; appended to the base URL. Defaults to /chat/completions.',
          'x-hot': true,
        },
        [`${K}.localModelApiKey`]: {
          type: 'string',
          title: zh ? '视觉模型 Key' : 'Vision model key',
          description: zh ? '厂商的 API 密钥（如 DeepSeek / OpenAI 的 sk-…），不是接口地址；本地 Ollama / LM Studio 留空。' : 'The vendor API key (sk-…), not the endpoint URL; leave empty for Ollama / LM Studio.',
          'x-hot': true,
        },
        [`${K}.localModelName`]: {
          type: 'string',
          title: zh ? '视觉模型名' : 'Vision model name',
          description: zh ? '如 qwen-vl-max、gpt-5、claude-haiku-5-5、gemini-3.5-flash-lite、qwen2.5vl:7b' : 'e.g. qwen-vl-max, gpt-5, claude-haiku-5-5, gemini-3.5-flash-lite, qwen2.5vl:7b',
          'x-hot': true,
        },
        [`${K}.localModelTimeoutMs`]: {
          type: 'integer',
          title: zh ? '视觉模型超时' : 'Vision model timeout',
          minimum: 1000,
          maximum: 120000,
          'x-suffix': 'ms',
          'x-hot': true,
        },
        [`${K}.localModelMaxTokens`]: {
          type: 'integer',
          title: zh ? '最大输出 token' : 'Max output tokens',
          minimum: 1,
          maximum: 8192,
          'x-hot': true,
        },
        [`${K}.localModelTemperature`]: {
          type: 'number',
          title: zh ? '温度' : 'Temperature',
          minimum: 0,
          maximum: 2,
          'x-hot': true,
        },
        [`${K}.localModelPrompt`]: {
          type: 'string',
          title: zh ? '附加指令' : 'Extra prompt',
          description: zh ? '追加给视觉模型的指令；留空用内置提示。' : 'Extra instruction for the vision model; empty uses the built-in prompt.',
        },
        [`${K}.localModelDetail`]: {
          type: 'string',
          title: zh ? '图片细节' : 'Image detail',
          enum: ['auto', 'low', 'high'],
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
    ocrLang: 'auto',
    screenshotMaxWidth: 1280,
    screenshotMaxHeight: 800,
    hookIntercept: true,
    hookTools: ['pet_cua_screenshot', 'pet_cua_zoom', 'cua_screenshot', 'cua_zoom'],
    onOcrEmpty: 'text',
    localModelEnabled: false,
    localModelProvider: 'custom',
    localModelBaseUrl: '',
    localModelApiKey: '',
    localModelName: '',
    localModelTimeoutMs: 20000,
    localModelProtocol: 'auto',
    localModelPath: '/chat/completions',
    localModelMaxTokens: 1000,
    localModelTemperature: 0.2,
    localModelPrompt: '',
    localModelDetail: 'auto',
    visionStrategy: 'auto',
    localModelPriority: 'auto',
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
  /** 上一次截图的基准，供局部裁剪把「截图坐标」换算成原生像素。 */
  private lastView: { nativeWidth: number; nativeHeight: number; fullScale: number } | null = null;
  /** 诊断用统计。 */
  private ocrCalls = 0;
  private lastOcrMs = 0;
  private lastOcrWords = 0;

  constructor(private ctx: any) {}

  private get cfg(): LocalVisionSection {
    // 框架的 WorldContext 字段是 cfg；config 只是旧版/测试上下文的兼容。
    return (this.ctx?.cfg ?? this.ctx?.config ?? {}) as LocalVisionSection;
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
    // localvision 自己的回执已经 OCR 过，别再处理一遍
    if (info.tool.startsWith('localvision_')) return out;
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
        words = await this.runOcr(Buffer.from(bytes).toString('base64'), {
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
          `${ocrToLocatedTextMapped(words, (nx, ny) => ({ x: nx * dims.w, y: ny * dims.h }))}\n` +
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

  private fullScaleOf(nativeWidth: number, nativeHeight: number): number {
    return Math.min(this.cfg.screenshotMaxWidth / nativeWidth, this.cfg.screenshotMaxHeight / nativeHeight, 1);
  }

  private async capture(display: unknown, region?: Region) {
    const monitor = toMonitor(display);
    if (monitor === null) throw new Error('display 要是 1 起的整数');
    const base = { maxWidth: this.cfg.screenshotMaxWidth, maxHeight: this.cfg.screenshotMaxHeight, monitor };

    // region 用上一次截图的坐标系；没有基准时先全屏截一张建立基准
    if (region && !this.lastView) {
      const full = await captureScreenshot(base);
      this.lastView = { nativeWidth: full.nativeWidth, nativeHeight: full.nativeHeight, fullScale: this.fullScaleOf(full.nativeWidth, full.nativeHeight) };
    }

    let shot;
    if (region && this.lastView) {
      const f = this.lastView.fullScale;
      const nw = this.lastView.nativeWidth;
      const nh = this.lastView.nativeHeight;
      const x = Math.max(0, Math.min(region.x / f, nw - 1));
      const y = Math.max(0, Math.min(region.y / f, nh - 1));
      shot = await captureScreenshot({
        ...base,
        region: {
          x,
          y,
          w: Math.max(1, Math.min(region.w / f, nw - x)),
          h: Math.max(1, Math.min(region.h / f, nh - y)),
        },
      });
    } else {
      shot = await captureScreenshot(base);
    }
    this.lastView = { nativeWidth: shot.nativeWidth, nativeHeight: shot.nativeHeight, fullScale: this.fullScaleOf(shot.nativeWidth, shot.nativeHeight) };
    return shot;
  }

  private hint(display: unknown, img: { nativeWidth: number; nativeHeight: number }): string {
    const n = typeof display === 'number' ? display : 1;
    const f = this.fullScaleOf(img.nativeWidth, img.nativeHeight);
    const w = Math.round(img.nativeWidth * f);
    const h = Math.round(img.nativeHeight * f);
    return `坐标 = 全屏截图 ${w}×${h} 空间，可直接传给 pet_cua_click（与内置 cua 同显示器 ${n}、同 ${w}×${h} 缩放）。`;
  }

  /**
   * 视觉模型端点（OpenAI Chat Completions 或 Anthropic Messages；本地/线上都可）。
   * 没配或调用失败时返回 failed，由调用方决定回退。
   */
  private async describeWithLocalModel(img: { base64: string }, prompt?: string): Promise<ToolOutcome> {
    const cfg = this.cfg;
    if (!cfg.localModelEnabled) {
      return { text: '[localvision_describe] 视觉模型未启用：在配置里打开「启用视觉模型」，填端点与模型名。', failed: true };
    }
    const { base, protocol } = resolveEndpoint(cfg);
    const model = (cfg.localModelName || '').trim();
    if (!base || !model) {
      return { text: '[localvision_describe] 视觉模型还缺「地址」或「模型名」。', failed: true };
    }

    const instruction = [cfg.localModelPrompt?.trim(), prompt?.trim()].filter(Boolean).join('\n')
      || '描述这张截图：有哪些窗口、控件、可见文字、图像内容与布局。';
    const maxTokens = Math.max(1, Math.min(8192, cfg.localModelMaxTokens || 1000));
    const temperature = Number.isFinite(cfg.localModelTemperature) ? cfg.localModelTemperature : 0.2;
    const dataUrl = `data:image/png;base64,${img.base64}`;
    const auth = cfg.localModelApiKey ? { authorization: `Bearer ${cfg.localModelApiKey}` } : {};

    const controller = new AbortController();
    const timeoutMs = Math.max(1000, cfg.localModelTimeoutMs || 20000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res: Response;
      if (protocol === 'anthropic-messages') {
        res = await fetch(`${base}/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': cfg.localModelApiKey || '',
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            temperature,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: instruction },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: img.base64 } },
              ],
            }],
          }),
          signal: controller.signal,
        });
      } else if (protocol === 'openai-responses') {
        res = await fetch(`${base}/responses`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({
            model,
            input: [{
              role: 'user',
              content: [
                { type: 'input_text', text: instruction },
                { type: 'input_image', image_url: dataUrl },
              ],
            }],
            max_output_tokens: maxTokens,
            temperature,
          }),
          signal: controller.signal,
        });
      } else {
        const path = protocol === 'custom' ? (cfg.localModelPath || '/chat/completions') : '/chat/completions';
        res = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({
            model,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: instruction },
                { type: 'image_url', image_url: { url: dataUrl, detail: cfg.localModelDetail || 'auto' } },
              ],
            }],
            max_tokens: maxTokens,
            temperature,
            stream: false,
          }),
          signal: controller.signal,
        });
      }

      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        return { text: `[localvision_describe] 视觉模型返回 ${res.status}：${body}`, failed: true };
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
        content?: Array<{ type?: string; text?: string }>;
        output_text?: string;
        output?: Array<{ content?: Array<{ text?: string }> }>;
      };
      const responsesText = json?.output_text?.trim()
        || (json?.output ?? []).flatMap((it) => it?.content ?? []).map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
      const text = protocol === 'anthropic-messages'
        ? (json?.content ?? []).map((p) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('')
        : protocol === 'openai-responses'
          ? responsesText
          : (() => {
              const content = json?.choices?.[0]?.message?.content;
              return typeof content === 'string'
                ? content
                : Array.isArray(content)
                  ? content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('')
                  : '';
            })();
      if (!text.trim()) return { text: '[localvision_describe] 视觉模型没有返回文本。', failed: true };
      return { text: `[视觉模型] ${text.trim()}` };
    } catch (e) {
      const err = e as Error & { cause?: { code?: string; message?: string } };
      const cause = err?.cause ? err.cause.code || err.cause.message || String(err.cause) : '';
      const msg = err?.name === 'AbortError'
        ? `超过 ${timeoutMs}ms`
        : `${err?.message || String(e)}${cause ? `（${cause}）` : ''}`;
      return { text: `[localvision_describe] 调用视觉模型失败：${msg}`, failed: true };
    } finally {
      clearTimeout(timer);
    }
  }

  /** OCR 调用统一入口：记录次数、耗时、词数，供诊断用。 */
  private async runOcr(base64: string, opts: OcrOptions): Promise<OcrWord[]> {
    const t0 = Date.now();
    let words: OcrWord[] = [];
    try {
      words = await ocrNative(base64, opts);
      return words;
    } finally {
      this.ocrCalls += 1;
      this.lastOcrMs = Date.now() - t0;
      this.lastOcrWords = words.length;
    }
  }

  /** 诊断报告：屏幕/DPI、OCR 语言与缓存、硬拦截、视觉模型配置与可达性。 */
  /** 采集诊断数据：文本报告（工具用）+ 分区/模型/建议（面板用）。 */
  private async doctorData(checkModel: boolean): Promise<DoctorReport> {
    const cfg = this.cfg;
    const lines: string[] = ['[localvision 诊断]'];
    const locale = systemLocale();
    const resolved = resolveOcrLangs(cfg.ocrLang);
    lines.push(`系统: ${process.platform} ${process.arch}, Node ${process.versions.node}, locale ${locale || '(未知)'}`);
    lines.push(`OCR: 配置 ${cfg.ocrLang || '(空)'} → 实际 ${resolved}; 调用 ${this.ocrCalls} 次, 最近 ${this.lastOcrMs}ms / ${this.lastOcrWords} 词`);

    let cachedLangs: string[] = [];
    let langCache = '(空，首次 OCR 会下载)';
    try {
      cachedLangs = (await readdir(this.cacheDir)).filter((f) => f.endsWith('.traineddata')).map((f) => f.replace('.traineddata', ''));
      if (cachedLangs.length) langCache = cachedLangs.join(', ');
    } catch {
      langCache = '目录不存在（首次 OCR 会创建）';
    }
    lines.push(`语言包缓存: ${langCache}`);

    let shotBase64 = '';
    let screen = '';
    try {
      const shot = await captureScreenshot({ maxWidth: cfg.screenshotMaxWidth, maxHeight: cfg.screenshotMaxHeight });
      shotBase64 = shot.base64;
      const f = this.fullScaleOf(shot.nativeWidth, shot.nativeHeight);
      screen =
        `原生 ${shot.nativeWidth}×${shot.nativeHeight}; 截图 ${Math.round(shot.nativeWidth * f)}×${Math.round(shot.nativeHeight * f)} ` +
        `(scale ${f.toFixed(3)}); 显示器 ${shot.monitor}`;
    } catch (e) {
      screen = `截屏失败（${(e as Error).message}）`;
    }
    lines.push(`屏幕: ${screen}`);

    const hook = this.unregisterHook ? '已注册（核心 hook 生效）' : '未注册（框架没打 hook 或 hookIntercept=false）';
    lines.push(`硬拦截: ${hook}`);

    const endpoint = resolveEndpoint(cfg);
    const modelConfigured = cfg.localModelEnabled && !!endpoint.base && !!cfg.localModelName.trim();
    const maskedKey = cfg.localModelApiKey ? `已填(${cfg.localModelApiKey.slice(0, 4)}…)` : '未填';
    let endpointCheck: string | null = null;
    if (checkModel) {
      if (!modelConfigured) {
        endpointCheck = '跳过（未启用或缺地址/模型名）';
      } else if (!shotBase64) {
        endpointCheck = '跳过（截屏失败，没有可发的图）';
      } else {
        const t0 = Date.now();
        const r = await this.describeWithLocalModel({ base64: shotBase64 }, '只回复 OK，不要描述画面。');
        endpointCheck = `${r.failed ? '失败' : '成功'} ${Date.now() - t0}ms — ${String(r.text).slice(0, 240)}`;
      }
      lines.push(`端点检查: ${endpointCheck}`);
    }
    lines.push(
      `视觉模型: ${cfg.localModelEnabled ? '已启用' : '未启用'}; 厂商 ${cfg.localModelProvider}; 协议 ${endpoint.protocol}; 地址 ${endpoint.base || '(空)'}; ` +
      `模型 ${cfg.localModelName || '(空)'}; Key ${maskedKey}; maxTokens ${cfg.localModelMaxTokens}, temp ${cfg.localModelTemperature}, detail ${cfg.localModelDetail}`,
    );

    const tips: string[] = [];
    if (!cachedLangs.includes(resolved)) tips.push(`语言包 ${resolved} 还没缓存，首次 OCR 会下载`);
    if (!this.unregisterHook) tips.push('想要硬拦截：确认打了 patches/core-tool-outcome-hook.patch 并重启');
    if (cfg.localModelEnabled && !modelConfigured) tips.push('视觉模型已启用但缺地址/模型名');
    if (cfg.onOcrEmpty === 'image' && !(cfg.localModelEnabled && cfg.localModelBaseUrl.trim() && cfg.localModelName.trim()))
      tips.push('「OCR 无文字时」设为 image 但视觉模型未配置：没认出字时截图会发给 Coopanion 已配的模型（费 token）；不需要请在「配置」页改回 text');
    if (!locale) tips.push('系统语言未知，OCR 语言已回退 eng；可手动填 ocrLang');
    if (tips.length) lines.push(`建议: ${tips.join('；')}`);

    const model: DoctorRow[] = [
      { label: '状态', value: cfg.localModelEnabled ? '已启用' : '未启用' },
      { label: '厂商预设', value: cfg.localModelProvider },
      { label: '协议', value: endpoint.protocol },
      { label: '地址', value: endpoint.base || '(空)' },
      { label: '模型名', value: cfg.localModelName || '(空)' },
      { label: 'Key', value: maskedKey },
      { label: '调参', value: `maxTokens ${cfg.localModelMaxTokens} / temp ${cfg.localModelTemperature} / detail ${cfg.localModelDetail}` },
      { label: '感知优先级', value: cfg.visionStrategy },
      { label: '模型优先级', value: cfg.localModelPriority },
      ...(endpointCheck ? [{ label: '端点检查', value: endpointCheck }] : []),
    ];

    const sections: DoctorSection[] = [
      {
        title: '运行环境',
        rows: [
          { label: '系统', value: `${process.platform} ${process.arch} / Node ${process.versions.node}` },
          { label: '系统语言', value: locale || '(未知)' },
          { label: '屏幕', value: screen },
          { label: '硬拦截', value: hook },
        ],
      },
      {
        title: 'OCR',
        rows: [
          { label: '语言', value: `${cfg.ocrLang || '(空)'} → ${resolved}` },
          { label: '语言包缓存', value: langCache },
          { label: '统计', value: `调用 ${this.ocrCalls} 次 / 最近 ${this.lastOcrMs}ms ${this.lastOcrWords} 词` },
        ],
      },
    ];

    return { text: lines.join('\n'), sections, model, tips };
  }

  /** 工具的诊断入口：只返回文本报告。 */
  private async doctor(checkModel: boolean): Promise<ToolOutcome> {
    const d = await this.doctorData(checkModel);
    return { text: d.text };
  }

  /** 按 `visionStrategy` 决定感知顺序：auto=OCR→模型→图片，默认 OCR 优先。 */
  private async perceive(display: unknown, region: Region | undefined, prompt?: string): Promise<ToolOutcome> {
    const cfg = this.cfg;
    const img = await this.capture(display, region);
    const W = img.scaledWidth;
    const H = img.scaledHeight;
    const f = this.fullScaleOf(img.nativeWidth, img.nativeHeight);
    const map = (nx: number, ny: number) => ({
      x: (img.regionX + nx * img.regionW) * f,
      y: (img.regionY + ny * img.regionH) * f,
    });
    const area = region ? `，区域 ${img.regionW}×${img.regionH} 原生像素` : '';
    const base = `截图 ${W}×${H}${area}（屏幕 ${img.nativeWidth}×${img.nativeHeight}）。`;

    const ocrNow = async (): Promise<ToolOutcome | null> => {
      try {
        const words = await this.runOcr(img.base64, this.ocrOptions(img));
        if (!words.length) return null;
        return {
          text:
            `${base}\n[本机 OCR] 截图未上传，只返回文字与坐标：\n` +
            ocrToLocatedTextMapped(words, map) +
            `\n\n${this.hint(display, img)}`,
        };
      } catch {
        return null;
      }
    };

    // 模型优先级：auto=本地>在线>Coopanion 兜底；local/online 只用对应端点；coop=直接交给对话模型。
    const endpointKind = (): 'local' | 'online' =>
      /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(resolveEndpoint(cfg).base) ? 'local' : 'online';
    const visionUsable = (): boolean => {
      const { base } = resolveEndpoint(cfg);
      if (!cfg.localModelEnabled || !base || !cfg.localModelName.trim()) return false;
      if (cfg.localModelPriority === 'local') return endpointKind() === 'local';
      if (cfg.localModelPriority === 'online') return endpointKind() === 'online';
      return true; // auto：端点配好就用（本地/在线按地址自动判）
    };

    const modelNow = async (): Promise<ToolOutcome | null> => {
      if (cfg.localModelPriority === 'coop' || !visionUsable()) return null;
      const r = await this.describeWithLocalModel(
        img,
        prompt || '这张截图里有什么？重点说明画面内容、控件、可见文字与布局。',
      );
      if (r.failed) {
        this.host?.log.warn('localvision: 视觉模型失败', { detail: r.text });
        return null;
      }
      return r;
    };

    const imageNow = (): ToolOutcome => ({
      text: `${base}\n[本机 OCR] 未识别到文字，已回退为截图图片。`,
      blobs: [
        {
          bytes: Buffer.from(img.base64, 'base64'),
          mime: 'image/png',
          name: region ? 'crop.png' : 'screen.png',
          fallbackText: region ? `区域截图 ${W}×${H}` : `屏幕截图 ${W}×${H}`,
        },
      ],
    });

    const noteNow = (): ToolOutcome => ({
      text:
        `${base}\n[本机 OCR] 未识别到文字，且不会把截图发给云端模型。` +
        (this.acceptsImage
          ? '要看图：在「模型」页配置视觉模型，或在「配置」页把「OCR 无文字时」设为 image（会消耗 token）。'
          : '当前对话模型不接收图片。') +
        `\n可以用 pet_cua_windows 列窗口，或直接按已知坐标操作。`,
    });

    // 链尾兜底 = Coopanion 模型商：把截图作为图片交给对话模型。
    // 「OCR 无文字时」设为 image、或显式把优先级设为 coop，才真正发图。
    const coopFallback = (): ToolOutcome =>
      (cfg.onOcrEmpty === 'image' || cfg.localModelPriority === 'coop') && this.acceptsImage ? imageNow() : noteNow();

    switch (cfg.visionStrategy) {
      case 'ocr-only': {
        const o = await ocrNow();
        return o ?? { text: `${base}\n[本机 OCR] 未识别到文字（ocr-only）。` };
      }
      case 'model-only': {
        const r = await modelNow();
        return r ?? { text: '[localvision] 视觉模型未启用或调用失败（model-only）。', failed: true };
      }
      case 'image-only':
        return imageNow();
      case 'model-first': {
        const r = await modelNow();
        if (r) return r;
        const o = await ocrNow();
        if (o) return o;
        return coopFallback();
      }
      case 'auto':
      default: {
        const o = await ocrNow();
        if (o) return o;
        const r = await modelNow();
        if (r) return r;
        return coopFallback();
      }
    }
  }

  tools(): ToolDef[] {
    const handlers: Record<string, (args: Record<string, unknown>) => Promise<ToolOutcome>> = {
      localvision_see: async (args) => {
        const region = parseRegion(args.region);
        return this.perceive(args.display, region, typeof args.prompt === 'string' ? args.prompt : undefined);
      },
      localvision_ocr: async (args) => {
        const region = parseRegion(args.region);
        const img = await this.capture(args.display, region);
        const words = await this.runOcr(img.base64, this.ocrOptions(img));
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
      localvision_describe: async (args) => {
        const cfg = this.cfg;
        const kind = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(resolveEndpoint(cfg).base) ? 'local' : 'online';
        if (cfg.localModelPriority === 'coop') {
          // 显式选 coop：把截图交给当前对话模型描述（cognition 传不了图，走图片回退）
          const region = parseRegion(args.region);
          const img = await this.capture(args.display, region);
          return {
            text: '[localvision_describe] 已按「优先选择的模型=coop」把截图交给当前对话模型描述（见下方图片）。',
            blobs: [
              {
                bytes: Buffer.from(img.base64, 'base64'),
                mime: 'image/png',
                name: region ? 'crop.png' : 'screen.png',
                fallbackText: region ? `区域截图 ${img.scaledWidth}×${img.scaledHeight}` : `屏幕截图 ${img.scaledWidth}×${img.scaledHeight}`,
              },
            ],
          };
        }
        if (cfg.localModelPriority !== 'auto' && cfg.localModelPriority !== kind) {
          return {
            text: `[localvision_describe] 「优先选择的模型」设为 ${cfg.localModelPriority}，但端点地址是${kind === 'local' ? '本地' : '在线'}的；请在「模型」页改地址或调整优先级。`,
            failed: true,
          };
        }
        if (!cfg.localModelEnabled) {
          return { text: '[localvision_describe] 视觉模型未启用：在配置里打开「启用视觉模型」，填端点与模型名。', failed: true };
        }
        if (!resolveEndpoint(cfg).base || !cfg.localModelName.trim()) {
          return { text: '[localvision_describe] 视觉模型还缺「地址」或「模型名」。', failed: true };
        }
        const region = parseRegion(args.region);
        const img = await this.capture(args.display, region);
        return this.describeWithLocalModel(img, typeof args.prompt === 'string' ? args.prompt : undefined);
      },
      localvision_doctor: async (args) => this.doctor(args.checkModel === true),
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
      'localvision.localmodel':
        this.cfg.localModelEnabled && this.cfg.localModelBaseUrl.trim() && this.cfg.localModelName.trim()
          ? '需要理解画面内容（游戏、图片、图表、视频帧）时，用 localvision_describe：视觉模型会描述画面（本地/线上按配置）。识别或模型异常时先调 localvision_doctor。'
          : '视觉模型未配置：本机看不了图，不要尝试获取或描述截图画面（不要调 pet_cua_screenshot / cua_screenshot，截图不会发给云端）。画面类问题直接告知用户「本机暂不支持看图」；如果用户有看图片的需求，引导他去「模型」页（或配置页）打开视觉模型并填好端点与模型名，配好后会自动生效。只依赖 OCR 文字与坐标操作。异常时先调 localvision_doctor。',
    };
  }

  /** 模型面板状态：只读本地配置并解析端点，不联网。 */
  private modelState() {
    const cfg = this.cfg;
    const endpoint = resolveEndpoint(cfg);
    const kind: 'local' | 'online' = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(endpoint.base) ? 'local' : 'online';
    return {
      enabled: cfg.localModelEnabled,
      provider: cfg.localModelProvider,
      protocol: cfg.localModelProtocol,
      baseUrl: cfg.localModelBaseUrl,
      apiKey: cfg.localModelApiKey,
      model: cfg.localModelName,
      customPath: cfg.localModelPath,
      maxTokens: cfg.localModelMaxTokens,
      temperature: cfg.localModelTemperature,
      detail: cfg.localModelDetail,
      timeout: cfg.localModelTimeoutMs,
      prompt: cfg.localModelPrompt,
      resolvedBase: endpoint.base,
      resolvedProtocol: endpoint.protocol,
      kind,
      ready: cfg.localModelEnabled && !!endpoint.base && !!cfg.localModelName.trim(),
      // Coopanion 当前对话模型名；它天然支持视觉，不需要、也不做连通测试。
      coopModel: this.coopModelName(),
      priority: cfg.localModelPriority,
    };
  }

  /** Coopanion 当前配置的对话模型名；取不到返回空串。 */
  private coopModelName(): string {
    try {
      return this.host?.modelFacts.model() ?? '';
    } catch {
      return '';
    }
  }

  /**
   * 模型面板「实测」：只测视觉模型端点（本地或在线）的在线状态，
   * 不发图、不测 Coopanion（Coopanion 模型商天然支持视觉，无需连通测试）。
   * 按当前地址判定 local/online，只填对应的那一项；另一项标记未配置。
   */
  private async modelProbe(): Promise<{
    local: { ok: boolean; ms: number; configured: boolean; detail: string };
    online: { ok: boolean; ms: number; configured: boolean; detail: string };
  }> {
    const cfg = this.cfg;
    const endpoint = resolveEndpoint(cfg);
    const kind: 'local' | 'online' = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(endpoint.base) ? 'local' : 'online';

    if (!cfg.localModelEnabled || !endpoint.base || !cfg.localModelName.trim()) {
      const unconfigured = { ok: false, ms: 0, configured: false, detail: '未配置（缺启用/地址/模型名）' };
      return kind === 'local'
        ? { local: unconfigured, online: { ok: false, ms: 0, configured: false, detail: '未配置（地址不是在线端点）' } }
        : { online: unconfigured, local: { ok: false, ms: 0, configured: false, detail: '未配置（地址不是本地端点）' } };
    }
    let base64 = '';
    try {
      base64 = (await captureScreenshot({ maxWidth: cfg.screenshotMaxWidth, maxHeight: cfg.screenshotMaxHeight })).base64;
    } catch (e) {
      const fail = { ok: false, ms: 0, configured: true, detail: `截屏失败：${(e as Error).message}` };
      return kind === 'local' ? { local: fail, online: { ...fail } } : { online: fail, local: { ...fail } };
    }
    const t0 = Date.now();
    try {
      const r = await this.describeWithLocalModel({ base64 }, '只回复 OK，不要描述画面。');
      const res = { ok: !r.failed, ms: Date.now() - t0, configured: true, detail: String(r.text).slice(0, 200) };
      return kind === 'local'
        ? { local: res, online: { ok: false, ms: 0, configured: false, detail: '未配置（地址不是在线端点）' } }
        : { online: res, local: { ok: false, ms: 0, configured: false, detail: '未配置（地址不是本地端点）' } };
    } catch (e) {
      const fail = { ok: false, ms: Date.now() - t0, configured: true, detail: (e as Error).message };
      return kind === 'local' ? { local: fail, online: { ...fail } } : { online: fail, local: { ...fail } };
    }
  }

  /**
   * 列出当前端点上已部署的可用模型，省得用户手填模型名（容易拼错）：
   * - Ollama：GET {base}/api/tags
   * - OpenAI 兼容：GET {base}/models（失败再试 /v1/models），带 Bearer 密钥
   */
  private async modelList(): Promise<{ ok: boolean; models: string[]; detail: string }> {
    const cfg = this.cfg;
    const endpoint = resolveEndpoint(cfg);
    const base = endpoint.base;
    if (!cfg.localModelEnabled || !base) {
      return { ok: false, models: [], detail: '未配置（缺启用或地址）' };
    }
    const isOllama = cfg.localModelProvider === 'ollama' || /ollama|11434/i.test(base);
    const headers: Record<string, string> = {};
    if (cfg.localModelApiKey.trim()) headers.Authorization = `Bearer ${cfg.localModelApiKey.trim()}`;
    const clean = base.replace(/\/+$/, '');
    // OpenAI 兼容：base 常以 /v1 结尾（如 DeepSeek、Ollama 的 OpenAI 模式），模型清单在 /v1/models；
    // 没带 /v1 时再补一个 /v1/models 兜底。
    const paths = /\/v1\/?$/i.test(clean) ? ['/models'] : ['/v1/models', '/models'];
    try {
      if (isOllama) {
        // Ollama 原生清单在 /api/tags；base 若以 /v1 结尾（OpenAI 模式）要去掉，否则变成 /v1/api/tags。
        const ollamaBase = clean.replace(/\/v1\/?$/i, '');
        const r = await fetch(`${ollamaBase}/api/tags`);
        if (!r.ok) return { ok: false, models: [], detail: `HTTP ${r.status}` };
        const j = (await r.json()) as { models?: Array<{ name: string }> };
        const models = (j.models ?? []).map((m) => m.name).filter(Boolean).sort();
        return { ok: true, models, detail: `获取到 ${models.length} 个模型` };
      }
      for (const p of paths) {
        try {
          const r = await fetch(`${clean}${p}`, { headers });
          if (!r.ok) {
            if (p === paths[paths.length - 1]) return { ok: false, models: [], detail: `HTTP ${r.status}（已试 ${paths.join('、')}）` };
            continue;
          }
          const j = (await r.json()) as { data?: Array<{ id: string }> };
          const models = (j.data ?? []).map((m) => m.id).filter(Boolean).sort();
          return { ok: true, models, detail: `获取到 ${models.length} 个模型` };
        } catch (e) {
          if (p === paths[paths.length - 1]) return { ok: false, models: [], detail: (e as Error).message };
        }
      }
      return { ok: false, models: [], detail: '未知错误' };
    } catch (e) {
      return { ok: false, models: [], detail: (e as Error).message };
    }
  }

  webUi(lang: string) {
    const zh = lang !== 'en';
    return {
      label: '本地视觉 LocalVision',
      // 所有配置收进唯一一组（world:localvision）；视觉模型设置与「模型」面板是同一份，
      // 面板是更顺手的编辑器，这里作为原始/高级入口，不再单独开一个重复的「视觉模型」分组。
      config: [ocrConfigGroup(lang)],
      panels: [
        {
          id: 'model',
          title: zh ? '模型' : 'Model',
          description: zh
            ? '视觉模型配置与在线状态：本地/在线表格、连接参数编辑、实测端点。'
            : 'Vision model settings and status: local/online table, connection, endpoint test.',
          getMethods: ['state', 'probe', 'models'],
        },
        {
          id: 'diagnostics',
          title: zh ? '诊断' : 'Diagnostics',
          description: zh
            ? '运行一次诊断：屏幕/DPI、OCR 语言与缓存、硬拦截。懒加载：点「运行诊断」才检测。'
            : 'Run diagnostics: screen/DPI, OCR, hook. Lazy: click to run.',
          getMethods: ['report'],
        },
      ],
      promptDocs: [
        {
          key: 'worlds.localvision.envPrompt',
          title: zh ? '本地视觉环境' : 'Local vision environment',
          description: zh ? '看屏用 localvision_see，操作用内置 pet_cua_*。' : 'Look with localvision_see, act with the built-in pet_cua_*.',
          path: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)),
          role: 'envPrompt' as const,
          vars: [
            { name: 'localvision.intercept', description: zh ? '硬拦截是否生效' : 'Whether hard interception is active' },
            { name: 'localvision.localmodel', description: zh ? '视觉模型是否可用' : 'Whether a vision model is available' },
          ],
        },
      ],
      // 面板数据面必须挂在 webUi() 的返回对象上，框架只从这里收集 invoke。
      invoke: async (panel: string, method: string, args: unknown[]) => {
        if (panel === 'model') {
          if (method === 'state') return this.modelState();
          if (method === 'probe') return this.modelProbe();
          if (method === 'models') return this.modelList();
        }
        if (panel === 'diagnostics' && method === 'report') return this.doctorData(args?.[0] === true);
        throw new Error(`unknown panel/method: ${panel}/${method}`);
      },
    };
  }
}
