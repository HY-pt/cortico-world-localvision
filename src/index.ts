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
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir, cpus, totalmem, freemem } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { WorldDefinition } from 'cortico/world.ts';
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { ToolDescribe, ToolDef, ToolOutcome, WorldHost } from 'cortico/core/types.ts';
import { captureScreenshot, clearPreviousShots, type CaptureResult } from './screenshot.ts';
import {
  decideFallback,
  emptyCounters,
  estimateImageTokens,
  formatFallbackHint,
  gateEventLine,
  isScreenshotLike,
  type GateAction,
  type GateCounters,
  type GateEvent,
  type OcrStatus,
} from './visionGate.ts';
import {
  autoOcrLang,
  disposeOcr,
  imageSize,
  ocrDiagnostics,
  ocrNative,
  ocrToText,
  ocrToLocatedTextMapped,
  resolveOcrLangs,
  SINGLE_LINE_MIN_CONF,
  systemLocale,
  type OcrOptions,
  type OcrWord,
} from './ocr.ts';
import {
  extractFrames,
  ffmpegAvailable,
  ffmpegInstallHint,
  makeFrameDir,
  probeVideo,
  removeFrameDir,
} from './video.ts';

/** 核心 hook 的签名（老版本 cortico 类型里没有，运行时做能力检测）。 */
type OutcomeTransform = (out: ToolOutcome, info: { tool: string; world?: string }) => ToolOutcome | Promise<ToolOutcome>;
type HookHost = WorldHost & { registerToolOutcomeTransform?: (fn: OutcomeTransform) => () => void };

export interface LocalVisionSection {
  /** Cortico World 段开关（框架/部署控制）。 */
  enabled: boolean;
  /** OCR 语言：auto（跟随系统语言）/ chi_sim / eng / chi_sim+eng；也接受 zh-Hans / en-US 映射。 */
  ocrLang: string;
  /**
   * 常规识别一个字都没读出来时，补跑一次「单行」模式。默认 true。
   *
   * 常规模式（PSM.AUTO）对**单行字幕会完全失效**：实测合成字幕 8 帧全空，
   * 还回报 conf=95 的假高置信度；换单行模式反而一字不差（conf 63~93）。
   * 视频 / CG / 教程的字幕绝大多数是单行——不补这一下，整段视频会被读成空白。
   * 补跑不做版面分析，拿到的文字**没有坐标**，输出时会如实说明、不用于点击。
   */
  ocrSingleLineFallback: boolean;
  /**
   * 补跑结果的置信度门槛（0~100），低于它视作幻觉、宁可说没读出来。默认 40。
   * 实测分得很干净：真字幕 63~93，CG 画面噪点被读成的碎片只有 0~15。
   * 这道门只守「补跑」这条新增路径，不动常规模式已经给出的结果。
   */
  ocrSingleLineMinConf: number;
  /** 截图缩放上限；与内置 cua 的 screenshot.maxWidth 对齐，坐标才能直接复用。 */
  screenshotMaxWidth: number;
  screenshotMaxHeight: number;
  /** 硬拦截：注册核心 hook，在内置 cua 的截图回执落库前换成 OCR 文本（需要打过 hook 的 Cortico）。 */
  hookIntercept: boolean;
  /** 额外强制拦截的工具名；带 screen/zoom/截图 特征的 blob 无论工具名都会被拦。 */
  hookTools: string[];
  /** OCR 找不到文字时（硬拦截与 see 工具共用）：'image' 把截图发给 Coopanion 对话模型，'text' 丢弃图片只留提示。 */
  onOcrEmpty: 'image' | 'text';
  /**
   * OCR **失败**时（抛异常、取不到字节或尺寸）：与「空结果」分开处理。
   * 默认 'image'——空结果是画面本来没字，失败是故障，两者的健康度含义完全不同；
   * 但也同样兜底，保住「任何情况下都有回应」的底线。
   */
  onOcrFailure: 'image' | 'text';
  /**
   * 图片兜底时在回执里加一句「这是兜底，看画面别读字」的提示。默认 true。
   * 不加的话模型拿到无字截图会硬读字或回「看不清」，兜底等于白兜。
   */
  fallbackHint: boolean;
  /**
   * 图片兜底时附带本机 OCR 的「文字 + 坐标」纯文本（text assist）。
   * 截图按原图发送，一个像素都不改；多带一段文本让模型不用靠读图认字。
   */
  textAssist: boolean;
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
  /** 模型未传 expand 时，region 向外扩展的默认像素；0 = 禁用外扩与兜底重试。 */
  expandDefault: number;
  /** 优先用哪个模型看图：auto（本地>在线>Coopanion 兜底）/ local / online / coop。 */
  localModelPriority: 'auto' | 'local' | 'online' | 'coop';
}

/** 取数字型工具参数：非数字/NaN 时回退默认值（模型传错类型不该让整个工具失败）。 */
function numOr(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

/** 把数值夹到区间内。 */
function clampNum(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 秒 → 时间码：不足 1 小时 `mm:ss`，否则 `h:mm:ss`；null（时刻未知）返回 `??:??`。
 * 视频时间线里必须能一眼读出「第几分钟」，纯秒数对模型和用户都不友好。
 */
function clock(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec) || sec < 0) return '??:??';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const mm = String(m).padStart(h ? 2 : 2, '0');
  const str = `${mm}:${String(ss).padStart(2, '0')}`;
  return h ? `${h}:${str}` : str;
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

/** 在截图坐标空间（与 localvision_see 返回坐标同一空间）把 region 向外扩展 expand 像素，并 clamp 到屏幕边界。 */
function expandRegionInScaledSpace(region: Region, expand: number, boundsW: number, boundsH: number): Region {
  if (!(expand > 0)) return region;
  const x = Math.max(0, Math.round(region.x - expand));
  const y = Math.max(0, Math.round(region.y - expand));
  const w = Math.max(1, Math.min(region.w + expand * 2, Math.floor(boundsW) - x));
  const h = Math.max(1, Math.min(region.h + expand * 2, Math.floor(boundsH) - y));
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
/** 设备压力负载进度条：诊断时采样，前端按 percent 画条。 */
export interface DoctorGauge {
  label: string;
  /** 0–100 的占用百分比（CPU 负载 / 内存占用）。 */
  percent: number;
  /** 进度条右侧补充文字，如核心数、已用/总量。 */
  detail?: string;
}
export interface DoctorReport {
  text: string;
  sections: DoctorSection[];
  model: DoctorRow[];
  tips: string[];
  /** 设备压力负载进度条（CPU / 内存）。 */
  gauges?: DoctorGauge[];
}

/** 取一次 os.cpus() 的累计时间片快照（差值法用）。 */
function cpuSnapshot(): { idle: number; total: number } {
  return cpus().reduce(
    (acc, c) => {
      acc.idle += c.times.idle;
      acc.total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
      return acc;
    },
    { idle: 0, total: 0 },
  );
}

/** 由前后两次快照求 CPU 占用百分比。 */
function cpuPercent(a: { idle: number; total: number }, b: { idle: number; total: number }): number {
  const idle = b.idle - a.idle;
  const total = b.total - a.total;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - idle / total) * 100)));
}

/** 采样某段异步任务（如一次截图尝试）期间的 CPU 占用百分比；任务太快时补足采样窗口防失真。 */
async function sampleCpuDuring<T>(task: () => Promise<T>): Promise<{ value: T; cpuLoad: number }> {
  const a = cpuSnapshot();
  const t0 = Date.now();
  const value = await task();
  const elapsed = Date.now() - t0;
  if (elapsed < 280) await new Promise((r) => setTimeout(r, 280 - elapsed));
  return { value, cpuLoad: cpuPercent(a, cpuSnapshot()) };
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

/** modelRoute().blockedBy 的中文说明（诊断建议、端点检查共用）。 */
const ROUTE_REASON: Record<string, string> = {
  'not-enabled': '视觉模型未启用',
  'missing-endpoint': '缺地址或模型名',
  'missing-key': '在线端点缺 API Key',
  priority: '优先级锁定与端点地址不一致',
  coop: '优先级设为 Coopanion 模型商',
};

const TOOL_DECLS: readonly ToolDescribe[] = [
  {
    name: 'localvision_see',
    description:
      '看屏幕：在本机截屏后用本机 OCR 把可见文字转成「文字 + 截图像素坐标」返回，默认不向云端上传图片（省 token）。' +
      '小字看不清时，可用上一次返回的坐标传 region 再 OCR 一次，会在原始分辨率下识别；没看清时也可直接传 expand（像素值），插件会自动把 region 向外扩大再截并兜底重试，不用你算坐标；不传 expand 时用配置页的默认值。' +
      '屏幕上一行文字都没有时，按配置处理：默认只回文字提示（最省 token）；也可交给视觉模型（本地端点 / 在线端点 / Coopanion 模型商）或直接上传图片（费 token）。' +
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
        expand: {
          type: 'integer',
          minimum: 0,
          description:
            '只截了部分（传了 region）时，向外扩展的像素值（截图坐标空间）。插件内部自动把 region 扩大后再截并兜底重试，无需模型算精准坐标；不传时用配置页「默认外扩像素」；没传 region 时无效。',
        },
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
      '用视觉模型描述画面（游戏、图片、图表、视频帧等 OCR 读不出来的内容）。需在「模型」页启用视觉模型，按「优先选择的模型」路由：自动=本地>在线>Coopanion 模型商，也可锁定本地端点、在线端点或直接用 Coopanion 模型商（截图交给对话模型看）。',
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
      '诊断本地视觉：报告屏幕/DPI、OCR 语言与已缓存语言包、硬拦截是否生效、当前视觉模型配置；checkModel=true 时还会实际请求一次端点。排查“识别不准/模型不工作”时先跑它（也可在「诊断」面板点按钮查看）。',
    parameters: {
      type: 'object',
      properties: {
        checkModel: { type: 'boolean', description: '是否实际请求一次视觉模型端点（会消耗少量 token）。默认 false。' },
      },
      required: [],
    },
    tags: ['read'],
  },
  {
    name: 'localvision_watch',
    description:
      '看视频 / 录屏：在本机用 ffmpeg 抽出「画面有变化」的帧，逐帧跑本机 OCR，产出「时刻 → 画面文字」的时间线文本。' +
      '默认只返回文字、不上传任何图片（省 token）；attachImages=true 时才额外附上「OCR 没读出文字」的纯画面帧（游戏、动画、演示画面等），最多 3 张。' +
      '适合回答「这段录屏里发生了什么」「第几分钟出现了什么文字」；需要系统装有 ffmpeg（没有会直接报安装指引）。' +
      '不适合：高速连续动作（抽帧会漏细节）、纯语音内容（不转写音频）。注意 OCR 一帧约 1.8s，帧数直接决定耗时。' +
      '⚠️ OCR 只认印刷体文字，在 CG / 动画 / 游戏画面上常常读不出、甚至读出乱字——这是能力边界不是故障；' +
      '这类内容想「看懂画面」请直接传 attachImages:true 让模型看图，别拿时间线上的几行乱字猜剧情。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '视频文件的绝对路径（mp4 / mkv / webm / mov 等 ffmpeg 能解的都行）。' },
        scene: {
          type: 'number',
          minimum: 0.05,
          maximum: 1,
          description: '场景变化阈值，默认 0.3。越小越敏感、抽到的帧越多；画面切换快的录屏建议 0.15~0.25，画面几乎静止的建议调大。',
        },
        maxFrames: {
          type: 'integer',
          minimum: 1,
          maximum: 120,
          description: '最多 OCR 多少帧，默认 24。OCR 一帧约 1.8s，这个数直接决定本次调用耗时；超出时按时间均匀抽稀（保留首尾帧）。',
        },
        intervalSec: {
          type: 'number',
          minimum: 0.1,
          maximum: 60,
          description: '兜底抽帧间隔（秒），默认 1。画面几乎不变的静态录屏（PPT 讲解、文档演示）用场景检测会一帧都选不出，此时自动改为按这个间隔均匀抽帧。',
        },
        fromSec: { type: 'number', minimum: 0, description: '只看从这一秒起的片段（秒，可带小数）；省略从头。' },
        toSec: { type: 'number', minimum: 0, description: '只看到这一秒为止（秒，可带小数）；省略到尾。' },
        attachImages: {
          type: 'boolean',
          description:
            '默认 false（只返回时间线文字，零图片开销）。设为 true 时，额外附上「OCR 没读出文字」的帧原图（纯画面，值得让模型看图），最多 3 张；会消耗 token。',
        },
      },
      required: ['path'],
    },
    tags: ['read'],
  },
];

/**
 * 实验性功能登记表：配置页「实验性功能」组与诊断面板的错误代码共用这一份。
 * - code：稳定编号（EXP-01…）。开关说明、诊断面板、运行时报错都写同一个编号，
 *   用户说「EXP-01 报错」时两边都能对上号，不用猜是哪个功能。
 * - key：LocalVisionSection 里的布尔开关名。
 * 新增实验功能只要在这里加一行，配置组与诊断面板自动跟上。
 */
const EXPERIMENTAL_FEATURES: readonly {
  key: 'textAssist';
  code: string;
  title: { zh: string; en: string };
  desc: { zh: string; en: string };
}[] = [
  {
    key: 'textAssist',
    code: 'EXP-01',
    title: { zh: '发图时附带本机 OCR 文字', en: 'Attach local OCR text to images' },
    desc: {
      zh:
        '⚠️ 默认关闭，开启后每次发图都会多消耗 token。真的需要发图时，除原始截图外再附一份本机 OCR 的文字与坐标，' +
        '让模型按坐标定位、不必靠读图认字；仅本地小模型（7B 级）认字不准时才值得开。截图始终原图，不做任何涂改。',
      en:
        '⚠️ Off by default; enabling costs extra tokens on every image sent. Also attach locally OCR’d text with coordinates ' +
        'so the model locates by coordinates instead of reading glyphs — worth it only when a small local model (7B-class) misreads text. ' +
        'The screenshot is always untouched pixels.',
    },
  },
];

/** 按开关名取实验功能登记项（编号 EXP-xx 在报错与诊断里共用）。 */
function expFeature(key: string): { code: string; title: { zh: string; en: string } } {
  return EXPERIMENTAL_FEATURES.find((f) => f.key === key) ?? { code: 'EXP-??', title: { zh: key, en: key } };
}

/**
 * 配置页分组：只保留截图/OCR 这层（视觉模型的启用、端点、模型名等 12 项不再重复出现，
 * 「模型」面板是唯一编辑入口，经 ctx.persist 直接落盘）。
 *
 * 拆成三组，让同类项挨在一起（宿主按 schema.properties 的插入顺序渲染，每组自带标题）：
 * - 「识别（OCR）」：感知优先级、OCR 语言、OCR 兜底方式、硬拦截截图——都是"怎么认字"；
 * - 「截图尺寸」：截图最大宽/高、默认外扩像素——都是像素值；
 * - 「实验性功能」：还在调试、可能报错的开关（当前只有 EXP-01 文本辅助），与识别参数分开，
 *   出问题时用户能整组关掉验证；诊断面板按同一套编号（EXP-xx）回报状态与报错。
 * 第一组的 description 会被 syncConfigSummary() 动态改写成当前视觉模型的只读摘要，
 * 配置页每次加载都取最新值。
 */
function ocrConfigGroups(lang: string): ConfigGroup[] {
  const zh = lang !== 'en';
  const K = 'worlds.localvision';
  return [
    {
      id: 'world:localvision',
      owner: 'world:localvision',
      schema: {
        type: 'object',
        title: zh ? '本地视觉 · 识别（OCR）' : 'Local vision · recognition (OCR)',
        description: zh ? '视觉模型配置摘要（动态）。' : 'Vision model summary (dynamic).',
        properties: {
          [`${K}.visionStrategy`]: {
            type: 'string',
            title: zh ? '感知优先级' : 'Perception order',
            // enum 保留全部旧值（兼容已存的配置），下拉只显示 configOptions 给的 3 项。
            enum: ['auto', 'ocr-only', 'model-first', 'model-only', 'image-only'],
            'x-options': 'localvision.visionStrategy',
            'x-hot': true,
            description: zh
              ? '自动模式：OCR>视觉模型>图片上传（默认OCR优先，最省token）。'
              : 'Auto: OCR > vision model > image upload (OCR first, cheapest).',
          },
          [`${K}.ocrLang`]: {
            type: 'string',
            title: zh ? 'OCR 语言' : 'OCR language',
            description: zh ? 'auto（跟随系统语言）/ chi_sim / eng / chi_sim+eng' : 'auto (follow system locale) / chi_sim / eng / chi_sim+eng',
            'x-hot': true,
          },
          [`${K}.ocrSingleLineFallback`]: {
            type: 'boolean',
            title: zh ? '补读单行字幕' : 'Retry as single line',
            description: zh
              ? '常规识别一个字都没读出来时，再按「一行字」的模式补读一次。\n视频、教程、带字幕的画面基本都是一行一行出现的，不开会整段读成空白。\n补读出来的文字没有位置信息，不能用来点击。'
              : 'When normal recognition finds nothing, retry treating the frame as a single line of text.\nSubtitles in videos and tutorials are almost always single-line; without this they read as blank.\nText recovered this way has no position data and cannot be used for clicking.',
            'x-hot': true,
          },
          [`${K}.ocrSingleLineMinConf`]: {
            type: 'integer',
            title: zh ? '补读置信度门槛' : 'Retry confidence floor',
            minimum: 0,
            maximum: 100,
            description: zh
              ? '补读结果的把握低于这个值就当没读出来。默认 40：真字幕通常 63~93，而游戏 / 动画画面被误读成的碎片只有 0~15。\n调高更保守（宁可空着），调低更容易捞到些字但也可能捞到乱码。'
              : 'Discard retry results below this confidence. Default 40: real subtitles score 63~93, while noise misread from game/animation frames scores only 0~15.\nRaise it to be stricter; lower it to catch more text at the risk of garbage.',
            'x-hot': true,
          },
          [`${K}.onOcrEmpty`]: {
            type: 'string',
            title: zh ? 'OCR 兜底方式' : 'OCR fallback',
            enum: ['image', 'text'],
            'x-options': 'localvision.onOcrEmpty',
            description: zh
              ? '图片（默认）：OCR 认不出字时，把截图发给 Coopanion 已配的模型兜底，看得懂游戏、视频等画面（会消耗 token）。\n文本：只返回识别到的文字，不发图、零额外开销。'
              : 'Image (default): when OCR finds no text, the screenshot is sent to the Coopanion model as a fallback — it can read games, video, etc. (costs tokens).\nText: returns recognized text only; no image is sent and no extra cost.',
            'x-hot': true,
          },
          [`${K}.onOcrFailure`]: {
            type: 'string',
            title: zh ? 'OCR 失败时' : 'On OCR failure',
            enum: ['image', 'text'],
            'x-options': 'localvision.onOcrFailure',
            description: zh
              ? '识别**出错**时（不是「画面没字」）怎么办。图片（默认）：同样把截图发给模型兜底，保证有回应，并记一条 warn 日志。\n文本：只留一句提示、不发图。'
              : 'What to do when OCR **errors** (not "no text found"). Image (default): still fall back to the screenshot so there is always a response, and log a warning.\nText: keep a notice only, no image.',
            'x-hot': true,
          },
          [`${K}.fallbackHint`]: {
            type: 'boolean',
            title: zh ? '兜底时提示模型看画面' : 'Hint model on fallback',
            description: zh
              ? '图片兜底时在回执里加一句「这是视觉兜底，关注画面别读字」。默认开启——不然模型会对着无字截图硬读字或回「看不清」。'
              : 'Append a "this is a visual fallback, look at the scene not the text" note when falling back to an image. On by default.',
            'x-hot': true,
          },
          [`${K}.hookIntercept`]: {
            type: 'boolean',
            title: zh ? '硬拦截截图（需框架 hook）' : 'Intercept screenshots (needs hook)',
            description: zh
              ? '注册核心变换，把内置 cua 的截图换成 OCR 文字；框架没打 hook 时自动降级。关闭即时生效，重新开启需重启 World。'
              : 'Replace screenshot tool results with OCR text; degrades when the framework has no hook. Turning off applies at once; turning back on needs a World restart.',
            // hook 在 World 启动时注册（start），没有配置监听：开启需重启 World，所以不是热配置。
            'x-hot': false,
          },
        },
      },
    },
    {
      id: 'world:localvision.screenshot',
      owner: 'world:localvision',
      schema: {
        type: 'object',
        title: zh ? '本地视觉 · 截图尺寸' : 'Local vision · screenshot size',
        description: zh
          ? '下面三项都是像素值。截图上限要和内置 cua 的 screenshot.maxWidth/maxHeight 保持一致，坐标才能直接复用；外扩像素是局部截图（region）向外扩展的幅度。'
          : 'All three are pixel values. Keep the screenshot limits aligned with the built-in cua screenshot.maxWidth/maxHeight so coordinates stay reusable; the expand value is how far a region screenshot grows outward.',
        properties: {
          [`${K}.screenshotMaxWidth`]: { type: 'integer', title: zh ? '截图最大宽' : 'Max width', minimum: 320, maximum: 3840, 'x-suffix': 'px', 'x-hot': true },
          [`${K}.screenshotMaxHeight`]: { type: 'integer', title: zh ? '截图最大高' : 'Max height', minimum: 240, maximum: 2160, 'x-suffix': 'px', 'x-hot': true },
          [`${K}.expandDefault`]: {
            type: 'integer',
            title: zh ? '默认外扩像素（expand）' : 'Default expand (px)',
            minimum: 0,
            maximum: 1000,
            'x-suffix': 'px',
            'x-hot': true,
            description: zh
              ? '局部截图（region）没看清时，插件自动把区域向外扩大再截、无需模型算坐标；OCR 落空还会自动再扩一轮重试。0 = 关闭外扩与重试（精确裁剪）。'
              : 'When a region screenshot finds nothing, the plugin auto-expands the area and retries OCR — no coordinates needed from the model. 0 = disable (exact crop).',
          },
        },
      },
    },
    {
      id: 'world:localvision.experimental',
      owner: 'world:localvision',
      schema: {
        type: 'object',
        title: zh ? '本地视觉 · 实验性功能' : 'Local vision · experimental',
        description: zh
          ? '⚠️ 这一组的功能还在调试中，可能会报错或行为变化。遇到异常先关掉对应开关，确认是不是它引起的。'
          : '⚠️ Features here are still being debugged and may error or change behavior. If something breaks, turn the matching switch off first to confirm.',
        properties: Object.fromEntries(
          EXPERIMENTAL_FEATURES.map((f) => [
            `${K}.${f.key}`,
            {
              type: 'boolean',
              title: zh ? f.title.zh : f.title.en,
              description: zh ? f.desc.zh : f.desc.en,
              'x-hot': true,
            },
          ]),
        ),
      },
    },
  ];
}


/** World 段默认值。ctx 未注入 cfg 时用它兜底，避免 screenshotMaxWidth 等字段缺失算出 NaN 坐标。 */
function defaultLocalVisionSection(): LocalVisionSection {
  return {
    enabled: false,
    ocrLang: 'auto',
    // 字幕是单行，常规模式读不出来——默认补跑，让视频 / 教程不至于整段空白。
    ocrSingleLineFallback: true,
    ocrSingleLineMinConf: SINGLE_LINE_MIN_CONF,
    screenshotMaxWidth: 1280,
    screenshotMaxHeight: 800,
    hookIntercept: true,
    hookTools: ['pet_cua_screenshot', 'pet_cua_zoom', 'cua_screenshot', 'cua_zoom'],
    onOcrEmpty: 'image',
    // 失败与空结果默认都兜底：宁可多花一次 token，也不能让模型拿不到任何回应。
    onOcrFailure: 'image',
    fallbackHint: true,
    localModelEnabled: false,
    localModelProvider: 'qwen',
    localModelBaseUrl: '',
    localModelApiKey: '',
    localModelName: 'qwen-vl-plus',
    localModelTimeoutMs: 20000,
    localModelProtocol: 'auto',
    localModelPath: '/chat/completions',
    localModelMaxTokens: 1000,
    localModelTemperature: 0.2,
    localModelPrompt: '',
    localModelDetail: 'auto',
    visionStrategy: 'auto',
    expandDefault: 100,
    // 默认 auto：本机/在线按地址自动路由，本地 Ollama 等不会因优先级被静默跳过。
    localModelPriority: 'auto',
    // 默认关：文本辅助要多花 token，只有本地小模型认字不准、幻觉严重时才有必要开。
    textAssist: false,
  };
}

const localVisionDef = {
  id: 'localvision',
  label: '本地视觉 LocalVision',
  defaults: (): LocalVisionSection => defaultLocalVisionSection(),
  describe: {
    tools: TOOL_DECLS,
    events: [],
  },
  /**
   * 配置页下拉的显示名（x-options）：存储值仍是英文，界面显示中文。
   * 感知优先级只暴露 自动 / 模型 / OCR-only 三项；OCR 兜底方式显示 图片 / 文本（默认 图片）。
   */
  configOptions: (kind: string, lang: string) => {
    const zh = lang !== 'en';
    if (kind === 'localvision.visionStrategy') {
      return [
        { value: 'auto', label: zh ? '自动' : 'Auto' },
        { value: 'model-first', label: zh ? '模型' : 'Model' },
        { value: 'ocr-only', label: 'OCR-only' },
      ];
    }
    if (kind === 'localvision.onOcrEmpty' || kind === 'localvision.onOcrFailure') {
      return [
        { value: 'image', label: zh ? '图片' : 'Image' },
        { value: 'text', label: zh ? '文本' : 'Text' },
      ];
    }
    return [];
  },
  create: (ctx: any) => new LocalVisionWorld(ctx),
} satisfies WorldDefinition<LocalVisionSection>;

export default localVisionDef;

class LocalVisionWorld {
  readonly id = 'localvision';
  private host: WorldHost | null = null;
  private unregisterHook: (() => void) | null = null;
  /** 配置页分组的活引用：syncConfigSummary() 改它的 description，配置页每次加载取最新。 */
  private uiGroup: ConfigGroup | null = null;
  private uiLang = 'zh';
  /** 同一张截图重复出现时（历史重放、动作后截图）不重复 OCR。 */
  private readonly ocrCache = new Map<string, OcrWord[]>();
  /** 上一次截图的基准，供局部裁剪把「截图坐标」换算成原生像素。 */
  private lastView: { nativeWidth: number; nativeHeight: number; fullScale: number } | null = null;
  /** 诊断用统计。 */
  private ocrCalls = 0;
  private lastOcrMs = 0;
  private lastOcrWords = 0;
  /** 最近一次 OCR 失败的原因（空 = 没失败过）；诊断里要看本机 OCR 健康度。 */
  private lastOcrError = '';
  /** 视觉门控（硬拦截钩子）的计量：拦截数、兜底次数、估算 token 成本。 */
  private readonly gate: GateCounters = emptyCounters();
  /**
   * 实验性功能的最近一次报错：key 是编号（EXP-01…），value 是截断后的原因。
   * 实验功能一律降级处理（不搞挂主流程），但报错要留痕——诊断面板按同一套编号展示，
   * 用户才能把「看到的错误」和「配置页里那个开关」对上。
   */
  private readonly expErrors = new Map<string, string>();
  /** ffmpeg 是否可用：结果缓存，envPrompt 每次渲染都会问，不能每次都 spawn 一次进程。 */
  private ffmpegOk: boolean | null = null;

  constructor(private ctx: any) {}

  private get cfg(): LocalVisionSection {
    // 框架的 WorldContext 字段是 cfg；config 只是旧版/测试上下文的兼容；都拿不到时用默认值兜底。
    return (this.ctx?.cfg ?? this.ctx?.config ?? defaultLocalVisionSection()) as LocalVisionSection;
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    const hookHost = host as HookHost;
    // 能力检测写回内联判断：TS 只对 instanceof/typeof 的**内联**条件窄化可选方法，
    // 抽成变量后 659 行的调用会被判为 possibly undefined。
    const hookSupported = typeof hookHost.registerToolOutcomeTransform === 'function';
    if (this.cfg.hookIntercept && typeof hookHost.registerToolOutcomeTransform === 'function') {
      this.unregisterHook = hookHost.registerToolOutcomeTransform((out, info) => this.transformToolOutcome(out, info));
    }
    // 钩子状态必须在启动日志里留痕：宿主缺 hook 时这里是**静默降级**——配置页照常显示"开"、
    // 实际一张图都不拦，而 Coopanion 每次升级都会冲掉补丁，升级后必然走到这条分支。
    // 不打这条日志，用户只会以为自己还被保护着。
    if (this.unregisterHook) {
      host.log.info('localvision: 硬拦截已生效（核心 hook 已注册）');
    } else if (this.cfg.hookIntercept) {
      host.log.warn('localvision: 硬拦截未生效——宿主缺少核心 hook（Coopanion 升级会冲掉补丁）', {
        detail: hookSupported
          ? 'hook 在但注册失败'
          : '到本地视觉 → 诊断页点「打核心补丁」，然后重启 Coopanion',
      });
    }
    // 清掉上一轮运行遗留的截屏临时文件：截图缓存的生命周期就是一次 Coopanion 运行，
    // 重启即清空（OCR 文字缓存在内存里，进程退了自然也没）。不 await：不能拖慢启动。
    void clearPreviousShots();
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
      // AUTO 一个词都没有时补跑单行模式：视频 / CG / 教程的字幕大多是单行，
      // 不补这一下会整段读成空白。补跑的词没有坐标，输出时会如实说明。
      retrySingleLine: this.cfg.ocrSingleLineFallback !== false,
      singleLineMinConf: this.cfg.ocrSingleLineMinConf,
    };
  }

  // blob 筛选（isImageBlob / isScreenshotLike）已挪到 src/visionGate.ts：纯函数、可单测。

  private blobBytes(blob: unknown): Uint8Array | null {
    const b = blob as { bytes?: unknown; handle?: unknown };
    if (b?.bytes instanceof Uint8Array) return b.bytes;
    if (typeof b?.handle === 'string') return this.host?.blob(b.handle)?.bytes ?? null;
    return null;
  }

  /**
   * 读部署目录下的全局 config.json：用于观察别的 World（内置 cua）的配置。
   * WorldContext 只给自己 World 的配置段，别家的段只能从这里看；读不到返回 null。
   */
  private globalConfig(): Record<string, unknown> | null {
    const botDir = typeof this.ctx?.botDir === 'string' ? this.ctx.botDir : '';
    if (!botDir) return null;
    try {
      const parsed = JSON.parse(readFileSync(join(botDir, 'config.json'), 'utf8'));
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /**
   * 内置 cua（desktop-pet）的「操作后附截图」是否开着。
   * true=开着（每次动作后都会附一张图）；false=已关；null=观察不到（没启用 cua 或读不到配置）。
   * 桌面宠默认值是 true，而框架只持久化非默认项——所以字段缺失也按开着算。
   */
  private cuaAfterAction(): boolean | null {
    const conf = this.globalConfig();
    const worlds = conf?.worlds as Record<string, { enabled?: unknown; cua?: unknown }> | undefined;
    const dp = worlds?.['desktop-pet'];
    if (!dp || dp.enabled === false) return null;
    const cua = dp.cua as { enabled?: unknown; screenshot?: { afterAction?: unknown } } | undefined;
    if (!cua || typeof cua !== 'object' || cua.enabled === false) return null;
    return cua.screenshot?.afterAction !== false;
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
    const targets = blobs.filter((b) => isScreenshotLike(b, forced));
    if (!targets.length) return out;

    const g = this.gate;
    g.calls += 1;
    g.intercepted += targets.length;

    const policy = { onOcrEmpty: this.cfg.onOcrEmpty, onOcrFailure: this.cfg.onOcrFailure };
    const acceptsImage = this.acceptsImage;

    let text = out.text;
    const kept: NonNullable<ToolOutcome['blobs']> = [];
    let anyImageFallback = false;

    for (const blob of blobs) {
      if (!targets.includes(blob)) {
        kept.push(blob);
        continue;
      }
      const bytes = this.blobBytes(blob);
      const dims = bytes ? imageSize(bytes) : null;

      // 取不到字节或尺寸：OCR 的前置条件就不成立，这是**失败**不是「画面没字」，
      // 走 onOcrFailure；原先这里静默保留原图，连条日志都没有。
      if (!bytes || !dims) {
        const d = decideFallback('failed', policy, acceptsImage);
        this.recordGate(d, info.tool, blob, 0, 'no-bytes-or-size');
        if (d.imageFallback) {
          kept.push(blob);
          anyImageFallback = true;
        } else {
          text += `\n\n[本机 OCR] 这张图取不到画面数据，无法识别，图片已丢弃。`;
        }
        continue;
      }

      const key = this.ocrCacheKey(bytes, this.cfg.ocrLang, dims.w, dims.h);
      const cached = this.ocrCache.get(key);
      let status: OcrStatus;
      let words: OcrWord[];
      let err = '';

      if (cached) {
        g.cacheHit += 1;
        words = cached;
        status = words.length ? 'hit' : 'empty';
      } else {
        // 走同一个 ocrOptions：让「单行补跑」在硬拦截路径上也受同一套配置控制，别两套行为。
        const r = await this.ocrWithStatus(
          Buffer.from(bytes).toString('base64'),
          this.ocrOptions({ scaledWidth: dims.w, scaledHeight: dims.h }),
        );
        status = r.status;
        words = r.words;
        err = r.error ?? '';
        // 失败不入缓存：否则故障期间会被后续同一张图一直命中，看起来像「画面没字」
        if (status !== 'failed') {
          if (this.ocrCache.size > 200) this.ocrCache.clear();
          this.ocrCache.set(key, words);
        }
      }
      if (status === 'empty') g.ocrEmpty += 1;

      const d = decideFallback(status, policy, acceptsImage);
      const tokenCost = d.imageFallback ? estimateImageTokens(dims.w, dims.h) : 0;
      this.recordGate(d, info.tool, blob, tokenCost, err);

      if (status === 'hit') {
        g.ocrHit += 1;
        text +=
          `\n\n[本机 OCR] 这张截图已在本地转成文字，未上传图片：\n` +
          `${ocrToLocatedTextMapped(words, (nx, ny) => ({ x: nx * dims.w, y: ny * dims.h }))}\n` +
          `坐标 = 该截图像素，可直接传给 pet_cua_click。`;
      } else if (d.imageFallback) {
        kept.push(blob);
        anyImageFallback = true;
      } else {
        // 降级为文字时如实区分：故障说故障，没字说没字，别都写成「没有文字」
        text +=
          status === 'failed'
            ? `\n\n[本机 OCR] 这张截图识别失败（${err.slice(0, 120) || '未知原因'}），图片已丢弃。`
            : `\n\n[本机 OCR] 这张截图没有识别到文字，图片已丢弃。`;
      }
    }

    // 兜底提示：只在真的把原图发给模型时追加，且一次回执只加一次（多张图不重复刷屏）。
    // 少了这句，模型拿到无字截图会去硬读字或回「看不清」，兜底等于白兜。
    if (anyImageFallback && this.cfg.fallbackHint) {
      text += formatFallbackHint();
    }

    // 注意不能用旧的 `changed` 布尔：全部走图片兜底时没有任何文本改动，
    // 但兜底提示同样要生效——按「文本变了 或 blob 数变了」判断才不会漏。
    const changed = text !== out.text || kept.length !== blobs.length;
    if (!changed) return out;
    return { ...out, text, ...(kept.length ? { blobs: kept } : { blobs: undefined }) };
  }

  /**
   * 记一次门控结果：更新计数器 + 写一条结构化日志。
   * 兜底对应真金白银的 token，单独走 info 并高亮；OCR 失败走 warn 便于排查健康度。
   */
  private recordGate(
    d: { action: GateAction; imageFallback: boolean; reason: string },
    tool: string,
    blob: unknown,
    tokenCost: number,
    err: string,
  ): void {
    const g = this.gate;
    if (d.imageFallback) g.fallbackImage += 1;
    else if (d.action === 'dropped') {
      g.dropped += 1;
      g.fallbackText += 1;
    }
    // 失败与空结果分开计数：前者是故障要排查，后者只是画面没字。
    if (d.reason.startsWith('ocr-failed') || d.reason === 'no-bytes-or-size') g.ocrFailed += 1;
    g.estimatedTokens += tokenCost;

    const e: GateEvent = {
      ts: new Date().toISOString(),
      tool,
      blobType: typeof (blob as { mime?: unknown })?.mime === 'string' ? String((blob as { mime: string }).mime) : 'unknown',
      ocrHit: d.reason === 'ocr-hit',
      action: d.action,
      reason: d.reason,
      estimatedTokenCost: tokenCost,
      ...(err ? { error: err.slice(0, 200) } : {}),
    };
    const line = `localvision.gate ${gateEventLine(e)}`;
    try {
      const log = this.host?.log;
      if (!log) return;
      if (d.imageFallback) log.info(line);
      else if (d.reason.startsWith('ocr-failed') || d.reason === 'no-bytes-or-size') log.warn(line);
      else log.debug(line);
    } catch {
      /* 日志写失败绝不能影响回执本身 */
    }
  }

  /** 只读快照：诊断面板与 doctor 都从这里取，避免外部改到内部计数器。 */
  getVisionGateStats(): GateCounters & { hookInterceptActive: boolean; lastOcrError: string } {
    return {
      ...this.gate,
      hookInterceptActive: this.unregisterHook !== null,
      lastOcrError: this.lastOcrError,
    };
  }

  private get acceptsImage(): boolean {
    return this.host?.modelFacts.accepts('image/png') ?? true;
  }

  private fullScaleOf(nativeWidth: number, nativeHeight: number): number {
    return Math.min(this.cfg.screenshotMaxWidth / nativeWidth, this.cfg.screenshotMaxHeight / nativeHeight, 1);
  }

  private async capture(display: unknown, region?: Region, expand = 0) {
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
      const r = expandRegionInScaledSpace(region, expand, nw / f, nh / f);
      const x = Math.max(0, Math.min(r.x / f, nw - 1));
      const y = Math.max(0, Math.min(r.y / f, nh - 1));
      shot = await captureScreenshot({
        ...base,
        region: {
          x,
          y,
          w: Math.max(1, Math.min(r.w / f, nw - x)),
          h: Math.max(1, Math.min(r.h / f, nh - y)),
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
    // headers 显式声明为 Record<string, string>：条件展开会产出 authorization?: undefined 联合，HeadersInit 不接受。
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cfg.localModelApiKey) headers.authorization = `Bearer ${cfg.localModelApiKey}`;

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
          headers,
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
          headers,
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

  /**
   * 「文本辅助」：截图要发给模型时，在图片之外**额外**附一份本机 OCR 的文字与坐标。
   *
   * 定调：**原图一个像素都不改**。不做涂抹、不抠字——把文字涂成色块会让模型把那里
   * 误判成空白按钮/输入框，反而破坏 UI 布局语义、制造更严重的幻觉。正确做法是：图片
   * 负责图标与排版，文字一律以本机 OCR 为准，模型按坐标定位。
   */
  private async assistText(img: CaptureResult, display: unknown): Promise<string> {
    // 用真值判断而非 === false：老配置里没有这个字段（undefined）时应按默认关闭处理。
    if (!this.cfg.textAssist) return '';
    try {
      const words = await this.wordsOf(img);
      if (!words.length) return '';
      const f = this.fullScaleOf(img.nativeWidth, img.nativeHeight);
      const map = (nx: number, ny: number) => ({
        x: (img.regionX + nx * img.regionW) * f,
        y: (img.regionY + ny * img.regionH) * f,
      });
      return (
        `\n\n[本机 OCR 文本辅助] 截图按原样附上，另给本机识别出的文字与坐标——` +
        `认字请以这段文本为准，图片只看图标、控件与排版：\n` +
        `${ocrToLocatedTextMapped(words, map)}\n${this.hint(display, img)}`
      );
    } catch (e) {
      // 实验功能不搞挂主流程：附不上文本就只发原图（原图本就一个像素不改），
      // 但把原因按 EXP 编号记下来，诊断面板「实验性功能」区会展示，不再是静默吞掉。
      this.noteExpError(expFeature('textAssist').code, e instanceof Error ? e.message : String(e));
      return '';
    }
  }

  /** 记录实验性功能的最近一次报错（编号 EXP-xx），供诊断面板展示；最多留 8 条，先到的先丢。 */
  private noteExpError(code: string, message: string): void {
    this.expErrors.set(code, message.slice(0, 200));
    if (this.expErrors.size > 8) {
      const oldest = this.expErrors.keys().next();
      if (!oldest.done) this.expErrors.delete(oldest.value);
    }
  }

  /** OCR 缓存的 key：除了图片本身，**语言和尺寸也要进 key**——只按字节算的话，改了 ocrLang 会继续命中旧语言的识别结果。 */
  private ocrCacheKey(bytes: Uint8Array, lang: string, width: number, height: number): string {
    const resolved = resolveOcrLangs(lang);
    return createHash('sha256').update(`${resolved}|${width}x${height}|`).update(bytes).digest('hex');
  }

  /**
   * 取某张截图的 OCR 结果：按「语言 + 尺寸 + 图片字节」做 key，命中缓存就不再跑
   * （一张图可能被硬拦截、文本辅助、expand 重试各问一次，缓存让整帧只识别一次）。
   */
  private async wordsOf(img: { base64: string; scaledWidth: number; scaledHeight: number }): Promise<OcrWord[]> {
    const bytes = Buffer.from(img.base64, 'base64');
    const key = this.ocrCacheKey(bytes, this.cfg.ocrLang, img.scaledWidth, img.scaledHeight);
    const cached = this.ocrCache.get(key);
    if (cached) return cached;
    const words = await this.runOcr(img.base64, this.ocrOptions(img));
    if (this.ocrCache.size > 200) this.ocrCache.clear();
    this.ocrCache.set(key, words);
    return words;
  }

  /**
   * OCR 调用统一入口：记录次数、耗时、词数，供诊断用。
   * 失败会抛——工具路径由 handler 的 try/catch 兜住，转成 failed 文本回执。
   */
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

  /**
   * 钩子专用：把 OCR 结果分成 命中 / 空 / 失败 三态。
   *
   * 钩子路径原先只 try/finally，异常会直接冒泡到宿主的回执处理——
   * 一次语言包缺失或预热失败就能把整个工具回执搞挂，而且没有任何兜底。
   * 这里捕获后交给 onOcrFailure 决策，保住「任何情况下都有回应」。
   */
  private async ocrWithStatus(
    base64: string,
    opts: OcrOptions,
  ): Promise<{ status: OcrStatus; words: OcrWord[]; error?: string }> {
    try {
      const words = await this.runOcr(base64, opts);
      return { status: words.length ? 'hit' : 'empty', words };
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      this.lastOcrError = msg.slice(0, 200);
      return { status: 'failed', words: [], error: msg };
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
    const ocd = ocrDiagnostics();
    lines.push(
      `OCR: 配置 ${cfg.ocrLang || '(空)'} → 实际 ${resolved}; 调用 ${this.ocrCalls} 次, 最近 ${this.lastOcrMs}ms / ${this.lastOcrWords} 词` +
        (this.gate.ocrFailed ? `; 失败 ${this.gate.ocrFailed} 次 (最近: ${this.lastOcrError || '未知'})` : '') +
        // 补读命中数单独列：它代表「本来会空手而归，靠单行模式救回来了」
        (ocd.singleLineHits ? `; 单行补读命中 ${ocd.singleLineHits} 次` : '') +
        `; 最近模式 ${ocd.lastPsm}`,
    );

    let cachedLangs: string[] = [];
    let langCache = '(空，首次 OCR 会下载)';
    try {
      cachedLangs = (await readdir(this.cacheDir)).filter((f) => f.endsWith('.traineddata')).map((f) => f.replace('.traineddata', ''));
      if (cachedLangs.length) langCache = cachedLangs.join(', ');
    } catch {
      langCache = '目录不存在（首次 OCR 会创建）';
    }
    lines.push(`语言包缓存: ${langCache}`);

    const route = this.modelRoute();
    const endpoint = route.endpoint;
    // 端点是否本机地址（本地模型才谈得上「本机硬件压力」）。
    const localEndpoint = route.kind === 'local';
    // 本地模型是否真正参与本机推理：真的会用上（Key/优先级都过关）且端点在本机。
    const localActive = route.usable && route.kind === 'local';
    const cpuCores = cpus().length;
    // 设备压力负载：本地模型用户按「当前设置的一次截图尝试」实测硬件压力；
    // 在线 / Coopanion 模型商推理不在本机，直接 0%。
    let cpuLoad = 0;
    let loadNote = '未使用本地模型（在线 / Coopanion 模型商，本机无推理负载）';

    let shotBase64 = '';
    let screen = '';
    try {
      const capture = () => captureScreenshot({ maxWidth: cfg.screenshotMaxWidth, maxHeight: cfg.screenshotMaxHeight });
      let shot: Awaited<ReturnType<typeof captureScreenshot>>;
      if (localActive) {
        const r = await sampleCpuDuring(capture);
        shot = r.value;
        cpuLoad = r.cpuLoad;
        loadNote = `一次截图尝试实测（${cpuCores} 核，${cfg.screenshotMaxWidth}×${cfg.screenshotMaxHeight}）`;
      } else {
        shot = await capture();
      }
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
    // 拦截计量：兜底次数单独列出——它直接对应 token 成本，是用户最该盯的数字。
    const g = this.gate;
    lines.push(
      `拦截统计: 回执 ${g.calls} 次 / 截图 ${g.intercepted} 张; OCR 命中 ${g.ocrHit}, 空结果 ${g.ocrEmpty}, 失败 ${g.ocrFailed}, 缓存命中 ${g.cacheHit}; ` +
        `图片兜底 ${g.fallbackImage} 次 (估算 ${g.estimatedTokens} tokens), 文字降级 ${g.fallbackText} 次`,
    );

    // 内置 cua 的「操作后附截图」：它开着的话，每次动作工具执行完都会再附一张图。
    // 这是桌面宠自己配置段里的开关（我们写不进别人的命名空间），只能观察 + 建议。
    const afterAction = this.cuaAfterAction();
    const afterActionText = afterAction === null ? '(未启用 cua 或读不到配置)' : afterAction ? '开着' : '已关';
    lines.push(`内置 cua 操作后截图: ${afterActionText}`);

    // 完全遮罩 API Key：不在诊断里泄露任何字符（含前缀），由 redactSecrets 兜底二次清理。
    const maskedKey = cfg.localModelApiKey ? '已填' : '未填';
    let endpointCheck: string | null = null;
    if (checkModel) {
      if (!route.usable) {
        endpointCheck = `跳过（${ROUTE_REASON[route.blockedBy] ?? route.blockedBy}）`;
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

    // 运行环境的「模型」行：当前**实际**由谁看图。
    // 只有真的会被调用才显示「本地/在线模型 ✓」；用不了就如实显示 Coopanion 模型商 ✓（真实路由会回退到这里）。
    const modelBadge = route.usable ? (route.kind === 'local' ? '本地模型 ✓' : '在线模型 ✓') : 'Coopanion 模型商 ✓';
    lines.push(`模型: ${modelBadge}`);

    const tips: string[] = [];
    if (!cachedLangs.includes(resolved)) tips.push(`语言包 ${resolved} 还没缓存，首次 OCR 会下载`);
    // 分两种"没注册"：开关开着却没生效（宿主缺 hook，多半是升级冲掉补丁）与开关本就没开，
    // 修法完全不同，混成一句会让人照着"确认打了 patch"白查半天。
    if (this.cfg.hookIntercept && !this.unregisterHook)
      tips.push('硬拦截开着但没生效：宿主缺核心 hook（多半是 Coopanion 升级冲掉了补丁）——点本页「打核心补丁」，重启 Coopanion 即可恢复');
    else if (!this.unregisterHook) tips.push('想要硬拦截：打开本页的「硬拦截截图」开关并重启 World');
    if (afterAction === true) {
      tips.push(
        this.unregisterHook
          ? '内置 cua 的「操作后截图」还开着：截图虽会被硬拦截转成文字，每次动作仍会多一次本地截图——建议在高级配置把 worlds.desktop-pet.cua.screenshot.afterAction 设为 false'
          : '内置 cua 的「操作后截图」还开着：每次动作后都会向模型传一张图——建议在高级配置把 worlds.desktop-pet.cua.screenshot.afterAction 设为 false',
      );
    }
    // OCR 失败过就该让人看见：这是故障信号，不是「画面没字」。
    if (this.gate.ocrFailed)
      tips.push(
        `本机 OCR 已失败 ${this.gate.ocrFailed} 次${this.lastOcrError ? `（最近：${this.lastOcrError.slice(0, 80)}）` : ''}` +
          '：多半是语言包没缓存或预热失败，请看上方「语言包缓存」；持续失败时改用 OCR 语言 eng 试一次',
      );
    if (route.blockedBy === 'missing-endpoint') tips.push('视觉模型已启用但缺地址/模型名：请到「模型」页补全');
    if (route.blockedBy === 'missing-key')
      tips.push('视觉模型已启用，但在线端点没填 API Key：看图请求会降级交给 Coopanion 模型商（费 token）；请到「模型」页填 Key，或改用本地模型');
    if (route.blockedBy === 'priority')
      tips.push(
        `「优先选择的模型」锁定与端点地址不一致（优先级=${cfg.localModelPriority}，地址=${localEndpoint ? '本机' : '在线'}）：` +
          '本地/在线模型不会被调用，实际走 Coopanion 模型商；需要请到「模型」页调整地址或优先级',
      );
    if (cfg.onOcrEmpty === 'image' && !route.configured)
      tips.push('「OCR 兜底方式」为 图片 但视觉模型未配置：OCR 认不出字时截图会发给 Coopanion 已配的模型（费 token）；不需要请在「配置」页改为 文本');
    if (cfg.textAssist)
      tips.push(
        'EXP-01「发图时附带本机 OCR 文字」已开启（实验性功能）：每次发图都会多消耗 token，只有本地小模型认字不准时才需要；' +
          '用在线大模型可以在「配置」页「实验性功能」组关掉',
      );
    if (!locale) tips.push('系统语言未知，OCR 语言已回退 eng；可手动填 ocrLang');
    if (tips.length) lines.push(`建议: ${tips.join('；')}`);

    // 设备压力负载进度条：本地模型 = 截图尝试期间实测；在线 / Coopanion 模型商 = 0%。
    const totalMem = totalmem();
    const usedMem = totalMem - freemem();
    const memPct = Math.round((usedMem / totalMem) * 100);
    const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
    const gauges: DoctorGauge[] = localActive
      ? [
          { label: 'CPU 负载', percent: cpuLoad, detail: loadNote },
          { label: '内存占用', percent: memPct, detail: `${gb(usedMem)} / ${gb(totalMem)} GB` },
        ]
      : [{ label: '本地推理负载', percent: 0, detail: loadNote }];
    lines.push(localActive ? `设备压力: CPU ${cpuLoad}% / 内存 ${memPct}%` : `设备压力: 本地推理负载 0%（${loadNote}）`);

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
          { label: '内置 cua 操作后截图', value: afterActionText },
          { label: '模型', value: modelBadge },
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

    // 实验性功能：与配置页「实验性功能」组共用编号（EXP-01…）。
    // 只在有开关被打开、或留下过报错时才展示，避免常态噪音；开关关掉时顺手清掉它的旧报错。
    const expRows: DoctorRow[] = [];
    let expAnyOn = false;
    for (const f of EXPERIMENTAL_FEATURES) {
      const on = Boolean((this.cfg as unknown as Record<string, unknown>)[f.key]);
      expAnyOn ||= on;
      const err = on ? this.expErrors.get(f.code) : undefined;
      if (!on) this.expErrors.delete(f.code);
      expRows.push({ label: `${f.code} ${f.title.zh}`, value: on ? '已开启' : '已关闭' });
      if (err) {
        expRows.push({ label: `${f.code} 最近报错`, value: err });
        tips.push(
          `${f.code}「${f.title.zh}」最近一次报错：${err}——该功能仍在调试，可先在「配置」页「实验性功能」组关掉它验证`,
        );
      }
    }
    if (expAnyOn || expRows.some((r) => r.label.endsWith('最近报错'))) {
      sections.push({ title: '实验性功能', rows: expRows });
      lines.push(`实验性功能: ${expRows.map((r) => `${r.label} ${r.value}`).join('；')}`);
    }

    // 诊断文本脱敏：彻底剔除 API Key 与常见令牌，确保上报/复制出去不含敏感数据。
    const safeText = this.redactSecrets(lines.join('\n'), cfg.localModelApiKey);
    return { text: safeText, sections, model, tips, gauges };
  }

  /**
   * 诊断文本预清理：把可能的敏感凭据剔除后再上报/复制。
   * - 真实 API Key 全量替换（即使前面只存了前 4 位，这里也兜底）。
   * - 常见令牌形态：sk-/pk-/rk- 开头的长串、Bearer 令牌。
   * 诊断本身不截屏、不含画面内容，这里只针对凭据做最小化清洗。
   */
  private redactSecrets(text: string, apiKey: string): string {
    let out = text;
    if (apiKey && apiKey.length) out = out.split(apiKey).join('••••');
    out = out.replace(/(sk|pk|rk)-[A-Za-z0-9]{16,}/g, '••••');
    out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer ••••');
    return out;
  }

  /** 工具的诊断入口：只返回文本报告。 */
  private async doctor(checkModel: boolean): Promise<ToolOutcome> {
    const d = await this.doctorData(checkModel);
    return { text: d.text };
  }

  /** ffmpeg 是否可用（结果缓存）。 */
  private ffmpegReady(): boolean {
    if (this.ffmpegOk === null) this.ffmpegOk = ffmpegAvailable();
    return this.ffmpegOk;
  }

  /**
   * 看视频 / 录屏：抽「有变化的帧」→ 逐帧本机 OCR → 产出「时刻 → 画面文字」时间线。
   *
   * 与看屏同一套哲学：默认只回文字、不发图（零图片 token）。只有「OCR 一个字都没读出来」的
   * 帧才可能是纯画面（游戏 / 动画 / 演示），且要显式 attachImages 才附原图——
   * 能读成文字的内容绝不浪费一张图。截图/帧一个像素都不改（见设计红线）。
   */
  private async watch(args: Record<string, unknown>): Promise<ToolOutcome> {
    const file = typeof args.path === 'string' ? args.path.trim() : '';
    if (!file) return { text: '[localvision_watch] 缺少 path：要传视频文件的绝对路径。', failed: true };
    if (!existsSync(file) || !statSync(file).isFile()) {
      return { text: `[localvision_watch] 找不到文件（或它不是文件）：${file}`, failed: true };
    }
    if (!this.ffmpegReady()) {
      return { text: `[localvision_watch] 本机没装 ffmpeg，看不了视频。${ffmpegInstallHint()}`, failed: true };
    }

    const scene = clampNum(numOr(args.scene, 0.3), 0.05, 1);
    const maxFrames = Math.round(clampNum(numOr(args.maxFrames, 24), 1, 120));
    const intervalSec = clampNum(numOr(args.intervalSec, 1), 0.1, 60);
    const fromSec = typeof args.fromSec === 'number' && Number.isFinite(args.fromSec) && args.fromSec > 0 ? args.fromSec : undefined;
    const toSec = typeof args.toSec === 'number' && Number.isFinite(args.toSec) && args.toSec > 0 ? args.toSec : undefined;
    const wantImages = args.attachImages === true;
    /** 附图的硬上限：再多就是烧 token，且模型一次也消化不了几张。 */
    const MAX_IMAGES = 3;

    const t0 = Date.now();
    const dir = await makeFrameDir('watch');
    try {
      const meta = probeVideo(file);
      const res = await extractFrames(file, dir, {
        scene,
        intervalSec,
        maxFrames,
        fromSec,
        toSec,
        maxWidth: this.cfg.screenshotMaxWidth,
      });
      if (!res.frames.length) {
        return {
          text:
            `[localvision_watch] 没抽到任何帧：文件可能没有视频轨、已损坏，或指定片段（${fromSec ?? 0}s–${toSec ?? '末尾'}）内没有内容。\n` +
            `ffmpeg 输出：${res.log.slice(-300)}`,
          failed: true,
        };
      }

      // 逐帧 OCR。单帧失败不搞挂整次调用，只记数——一帧的问题不该让整条时间线报废。
      const shots: { t: number | null; text: string }[] = [];
      const blanks: { t: number | null; bytes: Uint8Array }[] = [];
      let ocrFailed = 0;
      for (const f of res.frames) {
        const bytes = await readFile(f.path);
        const dims = imageSize(bytes);
        let words: OcrWord[] = [];
        try {
          words = await this.runOcr(bytes.toString('base64'), {
            lang: this.cfg.ocrLang || undefined,
            cacheDir: this.cacheDir,
            width: dims?.w ?? 0,
            height: dims?.h ?? 0,
          });
        } catch {
          ocrFailed += 1;
        }
        const text = words.length ? ocrToText(words) : '';
        shots.push({ t: f.timeSec, text });
        // 无文字的帧才是「纯画面」，只有它值得发图（且必须用户显式要）。
        if (!text && wantImages && this.acceptsImage && blanks.length < MAX_IMAGES) blanks.push({ t: f.timeSec, bytes });
      }

      // 相邻帧文字相同 → 合并成区间（同一屏停留了多久，比重复十行同样的字有用得多）。
      const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
      const rows: { from: number | null; to: number | null; text: string }[] = [];
      for (const s of shots) {
        const last = rows[rows.length - 1];
        if (last && norm(last.text) === norm(s.text) && norm(s.text) !== '') {
          last.to = s.t;
          continue;
        }
        rows.push({ from: s.t, to: s.t, text: s.text });
      }

      // 单帧文字可能很长（整屏文字），截断保证时间线可读、不会一次灌进几千字。
      const clip = (s: string) => (s.length > 240 ? `${s.slice(0, 240)}…` : s);
      const lines = rows.map((r) => {
        const range =
          r.from !== null && r.to !== null && r.to > r.from ? `${clock(r.from)} → ${clock(r.to)}` : clock(r.from);
        return r.text ? `${range}  「${clip(r.text).replace(/\n/g, ' / ')}」` : `${range}  （画面无文字）`;
      });

      const dur = meta.durationSec !== null ? `时长 ${clock(meta.durationSec)}` : '时长未知';
      const size = meta.width && meta.height ? `${meta.width}×${meta.height}` : '分辨率未知';
      // 回退时要说清是「画面没变化」还是「变化太平缓、只挑出零星几帧」——后者是动画 / CG 的常态。
      const few = (res.sceneFrames ?? 0) > 0;
      const modeText =
        res.mode === 'scene'
          ? `场景变化检测（scene>${scene.toFixed(2)}）`
          : `固定间隔抽帧（每 ${intervalSec}s；${few ? `场景检测只找到 ${res.sceneFrames} 处明显切换，画面变化平缓` : '画面几乎无变化'}，已自动切换策略）`;
      const head =
        `[localvision_watch] ${basename(file)} · ${dur} · ${size} → 抽帧宽 ${this.cfg.screenshotMaxWidth}\n` +
        `策略：${modeText}；抽出 ${res.frames.length} 帧并全部 OCR，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s` +
        (ocrFailed ? `（${ocrFailed} 帧 OCR 失败）` : '') +
        `\n时间线（时刻 → 画面文字）：\n`;

      const blankCount = shots.filter((s) => !s.text).length;
      const tail: string[] = [];
      // 场景检测是 ffmpeg 报错（而非画面没变化）时如实说明，别让用户以为视频真的没变化。
      if (res.sceneError) tail.push(`场景变化检测不可用（${res.sceneError}），已自动改用固定间隔抽帧`);
      if (rows.length && rows.every((r) => !r.text)) {
        tail.push('整段都没有读出文字：可能是纯画面内容（游戏 / 视频），或 OCR 语言不匹配——可到配置页改 ocrLang，或传 attachImages:true 发图给模型看');
      } else if (blankCount && wantImages && !this.acceptsImage) {
        tail.push(`${blankCount}/${shots.length} 帧没有文字，但当前对话模型不接收图片，无法附图`);
      } else if (blankCount && !wantImages) {
        // 明说是「OCR 认不出画面」而不是「这段没内容」：CG / 动画里乱猜剧情比老实说看不懂更糟。
        tail.push(
          `${blankCount}/${shots.length} 帧没有文字。CG / 动画 / 游戏录像的画面内容 OCR 本来就认不出（偶尔还会读出乱字），` +
            '这是能力边界不是故障；想看懂画面请传 attachImages:true（最多附 3 张原图，会消耗 token）',
        );
      }
      if (fromSec !== undefined || toSec !== undefined) {
        tail.push(`已限定片段：${fromSec ?? 0}s → ${toSec ?? '末尾'}`);
      }

      // 附图的帧用 frame_<时刻>.jpg 命名：不含 screen/zoom/截图 特征，不会被硬拦截误当成屏幕截图。
      const blobs = blanks.map((b) => ({
        bytes: Buffer.from(b.bytes),
        mime: 'image/jpeg',
        name: `frame_${clock(b.t).replace(/:/g, '-')}.jpg`,
        fallbackText: `视频帧 ${clock(b.t)}`,
      }));
      if (blobs.length) tail.push(`已附 ${blobs.length} 张无文字帧的原图（未做任何涂改）：${blobs.map((b) => b.fallbackText).join('、')}`);

      return {
        text: head + lines.join('\n') + (tail.length ? `\n\n${tail.join('\n')}` : ''),
        ...(blobs.length ? { blobs } : {}),
      };
    } finally {
      // 帧是临时产物：用完即删，与截图缓存同一套生命周期（重启也自然清空）。
      await removeFrameDir(dir);
    }
  }

  /** 对单张截图做本机 OCR，返回「文字 + 坐标」结果；无文字或失败时返回 null。 */
  private async ocrOutcome(img: CaptureResult, display: unknown): Promise<ToolOutcome | null> {
    try {
      const words = await this.wordsOf(img);
      if (!words.length) return null;
      const f = this.fullScaleOf(img.nativeWidth, img.nativeHeight);
      const map = (nx: number, ny: number) => ({
        x: (img.regionX + nx * img.regionW) * f,
        y: (img.regionY + ny * img.regionH) * f,
      });
      const isCrop = img.regionW < img.nativeWidth || img.regionH < img.nativeHeight;
      const area = isCrop ? `，区域 ${img.regionW}×${img.regionH} 原生像素` : '';
      const base = `截图 ${img.scaledWidth}×${img.scaledHeight}${area}（屏幕 ${img.nativeWidth}×${img.nativeHeight}）。`;
      return {
        text:
          `${base}\n[本机 OCR] 截图未上传，只返回文字与坐标：\n` +
          ocrToLocatedTextMapped(words, map) +
          `\n\n${this.hint(display, img)}`,
      };
    } catch {
      return null;
    }
  }

  /** 按 `visionStrategy` 决定感知顺序：auto=OCR→模型→图片，默认 OCR 优先。 */
  private async perceive(display: unknown, region: Region | undefined, prompt?: string, expand?: number): Promise<ToolOutcome> {
    const cfg = this.cfg;
    // 模型未传 expand 时用配置页的「默认外扩像素」（0 = 禁用外扩与兜底重试）。
    const exp = Math.max(0, Math.min(1000, typeof expand === 'number' && Number.isFinite(expand) ? expand : cfg.expandDefault ?? 100));
    const img = await this.capture(display, region, exp);
    const W = img.scaledWidth;
    const H = img.scaledHeight;
    const area = region ? `，区域 ${img.regionW}×${img.regionH} 原生像素` : '';
    const base = `截图 ${W}×${H}${area}（屏幕 ${img.nativeWidth}×${img.nativeHeight}）。`;

    // OCR 失败时，若传入了 expand 且有 region，自动把范围再扩大一轮重试一次（绝不麻烦模型算坐标）。
    const ocrWithRetry = async (): Promise<ToolOutcome | null> => {
      const first = await this.ocrOutcome(img, display);
      if (first) return first;
      if (exp > 0 && region) {
        const retryImg = await this.capture(display, region, exp * 2);
        const retry = await this.ocrOutcome(retryImg, display);
        if (retry) {
          return { ...retry, text: retry.text.replace('[本机 OCR]', '[本机 OCR] 没看清，已自动扩大范围重试一次') };
        }
      }
      return null;
    };

    // 模型优先级：auto=本地>在线>Coopanion 兜底；local/online 只用对应端点；coop=直接交给对话模型。
    const visionUsable = (): boolean => this.modelRoute().usable;

    const modelNow = async (): Promise<ToolOutcome | null> => {
      if (cfg.localModelPriority === 'coop' || !visionUsable()) return null;
      // 与 describe 保持一致：视觉模型看到的也是原图，开关打开时同样附带 OCR 文本（命中缓存时几乎不花钱）。
      const assist = await this.assistText(img, display);
      const r = await this.describeWithLocalModel(
        img,
        [
          prompt || '这张截图里有什么？重点说明画面内容、控件、可见文字与布局。',
          assist,
        ]
          .filter(Boolean)
          .join('\n'),
      );
      if (r.failed) {
        this.host?.log.warn('localvision: 视觉模型失败', { detail: r.text });
        return null;
      }
      return r;
    };

    // 图片兜底：截图原样发走（不涂改），并附上本机 OCR 的文字与坐标。
    const imageNow = async (): Promise<ToolOutcome> => ({
      text: `${base}\n[本机 OCR] 未识别到文字，已回退为截图图片。${await this.assistText(img, display)}`,
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
          ? '要看图：在「模型」页配置视觉模型，或在「配置」页把「OCR 兜底方式」设为 图片（会消耗 token）。'
          : '当前对话模型不接收图片。') +
        `\n可以用 pet_cua_windows 列窗口，或直接按已知坐标操作。`,
    });

    // 链尾兜底 = Coopanion 模型商：把截图原样交给对话模型（图片 + 本机 OCR 文本）。
    // 「OCR 兜底方式」设为 图片、或显式把优先级设为 coop，才真正发图。
    const coopFallback = async (): Promise<ToolOutcome> =>
      (cfg.onOcrEmpty === 'image' || cfg.localModelPriority === 'coop') && this.acceptsImage ? imageNow() : noteNow();

    switch (cfg.visionStrategy) {
      case 'ocr-only': {
        const o = await ocrWithRetry();
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
        const o = await ocrWithRetry();
        if (o) return o;
        return coopFallback();
      }
      case 'auto':
      default: {
        const o = await ocrWithRetry();
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
        // 未传 expand 时传 undefined，由 perceive 用配置页的「默认外扩像素」兜底。
        const expand =
          typeof args.expand === 'number' && Number.isFinite(args.expand) && args.expand >= 0 ? args.expand : undefined;
        return this.perceive(args.display, region, typeof args.prompt === 'string' ? args.prompt : undefined, expand);
      },
      localvision_ocr: async (args) => {
        const region = parseRegion(args.region);
        const img = await this.capture(args.display, region);
        // 走 wordsOf：同一张图刚被 see / 硬拦截识别过就直接复用，省一次 9 秒级的 OCR。
        const words = await this.wordsOf(img);
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
        const route = this.modelRoute();
        const kind = route.kind;
        if (cfg.localModelPriority === 'coop') {
          // 显式选 coop：把截图交给当前对话模型描述（cognition 传不了图，走图片回退）
          const region = parseRegion(args.region);
          const img = await this.capture(args.display, region);
          return {
            // 原图 + 本机 OCR 文本：模型按坐标定位，不用自己认字。
            text:
              '[localvision_describe] 已按「优先选择的模型=coop」把截图交给当前对话模型描述（见下方图片，原图未做任何涂改）。' +
              (await this.assistText(img, args.display)),
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
        if (!cfg.localModelEnabled) {
          return { text: '[localvision_describe] 视觉模型未启用：在配置里打开「启用视觉模型」，填端点与模型名。', failed: true };
        }
        if (!resolveEndpoint(cfg).base || !cfg.localModelName.trim()) {
          return { text: '[localvision_describe] 视觉模型还缺「地址」或「模型名」。', failed: true };
        }
        const region = parseRegion(args.region);
        const img = await this.capture(args.display, region);
        // 视觉模型用不上（缺 Key）或调用失败（401/超时/网络）时不硬报错，
        // 降级到「Coopanion 模型商」档：把截图作为图片交给当前对话模型；两档都不行才报错。
        const coopDescribeFallback = async (reason: string): Promise<ToolOutcome> => {
          if (!this.acceptsImage) {
            return {
              text: `[localvision_describe] ${reason}，且当前对话模型不接收图片，无法兜底看图。`,
              failed: true,
            };
          }
          return {
            text: `[localvision_describe] ${reason}，已把截图交给当前对话模型描述（原图未做任何涂改）。${await this.assistText(img, args.display)}`,
            blobs: [
              {
                bytes: Buffer.from(img.base64, 'base64'),
                mime: 'image/png',
                name: region ? 'crop.png' : 'screen.png',
                fallbackText: region ? `区域截图 ${img.scaledWidth}×${img.scaledHeight}` : `屏幕截图 ${img.scaledWidth}×${img.scaledHeight}`,
              },
            ],
          };
        };
        if (route.blockedBy === 'missing-key') {
          // 在线端点没 Key 发请求必然 401，白跑一次；直接降级交给对话模型，不发注定失败的请求。
          return coopDescribeFallback('在线端点缺 API Key，视觉模型用不上（请到「模型」页补填）');
        }
        if (route.blockedBy === 'priority') {
          // 和缺 Key 同一类：本地/在线模型因优先级锁定不会被调用，诊断显示「Coopanion 模型商 ✓」、
          // perceive 也会降级——describe 这里必须同样降级，否则又变成「报 A 实际 B」的硬报错。
          return coopDescribeFallback(
            `「优先选择的模型」设为 ${cfg.localModelPriority}，但端点地址是${kind === 'local' ? '本地' : '在线'}的，该模型不会被调用`,
          );
        }
        // 视觉模型看图也走原图：额外附带本机 OCR 文本，让模型不必靠读图认字（同一帧只 OCR 一次）。
        const userPrompt = typeof args.prompt === 'string' ? args.prompt : '';
        const assist = await this.assistText(img, args.display);
        const r = await this.describeWithLocalModel(img, [userPrompt, assist].filter(Boolean).join('\n') || undefined);
        if (r.failed) {
          this.host?.log.warn('localvision: describe 视觉模型失败，降级交给对话模型', { detail: r.text });
          const detail = String(r.text).replace(/^\[localvision_describe\]\s*/, '').replace(/\s+/g, ' ').slice(0, 140);
          return coopDescribeFallback(`视觉模型调用失败（${detail}）`);
        }
        return r;
      },
      localvision_doctor: async (args) => this.doctor(args.checkModel === true),
      localvision_watch: async (args) => this.watch(args),
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
      // 三态：生效 / 开关开着却没生效（宿主缺 hook，多半是升级冲掉补丁）/ 开关本就没开。
      // 第二种必须说清"是坏了不是没开"，否则模型会一直以为用户没开这个开关，不会提醒去修。
      'localvision.intercept': this.unregisterHook
        ? '截图已经被我拦在本机啦：就算调用 pet_cua_screenshot，拿到的也只是本机读出来的文字，不会把图传出去。正常用就行。'
        : this.cfg.hookIntercept
          ? '硬拦截现在没生效哦：开关是开着的，但宿主这边少了个核心 hook（多半是 Coopanion 升级把补丁冲掉了）。这段时间还是不要调用 pet_cua_screenshot / pet_cua_zoom（图会真的传出去），做动作记得传 screenshot:false；要是我常常得看屏幕，就提醒用户去「本地视觉 → 诊断」点一下「打核心补丁」，重启 Coopanion 就好啦。'
          : '硬拦截还没开哦，所以不要调用 pet_cua_screenshot / pet_cua_zoom（会把图传出去）；做动作的时候记得传 screenshot:false。',
      'localvision.localmodel':
        this.cfg.localModelEnabled && this.cfg.localModelBaseUrl.trim() && this.cfg.localModelName.trim()
          ? '想看懂画面内容（游戏、图片、图表、视频里某一幕），用 localvision_describe，我会让配好的视觉模型把画面讲给我听。出问题先调 localvision_doctor。'
          : '视觉模型还没配好，所以我暂时看不了画面内容。在这之前不要调用 pet_cua_screenshot / cua_screenshot：图就算拿到了我也读不懂，只会多花 token 但派不上用场；要是没开硬拦截，截图还会真的传到云端。遇到画面类问题，就老实告诉用户「我现在还看不了图」；想看图的话，引导他去「模型」页打开视觉模型、填好地址和模型名，配好就自动生效啦。平时我只靠读出来的文字和坐标帮你干活。有问题先调 localvision_doctor。',
      // 判定与 perceive 的 coopFallback 同一个（onOcrEmpty === 'image'），不另写一套：
      // 老配置缺字段时两边都落到「文本」分支，提示词与真实行为不会对不上。
      'localvision.ocrfallback':
        this.cfg.onOcrEmpty === 'image'
          ? '当前「OCR 兜底方式」是「图片」：读不出字的时候（游戏、视频、纯画面），我会把截图发给用户已配的视觉模型去看（会消耗 token，画面也会上传），这样我就能讲出画面里有什么。'
          : '当前「OCR 兜底方式」是「文本」：读不出字的时候，我只把已经读到的字告诉你，不发图、不花钱——代价是画面里有什么我就看不到啦。',
      // 视频能力取决于系统有没有 ffmpeg，提示词必须和工具真实行为一致（没装就别让用户白试）。
      'localvision.watch': this.ffmpegReady()
        ? '我可以看视频和录屏哦：用 localvision_watch，把视频文件的完整路径传给我就行。我会在本机挑出画面有变化的那些瞬间来读字，给你一份「第几秒 → 屏幕上写着什么」的清单，默认一张图都不传。'
        : '本机没装 ffmpeg，我暂时看不了视频和录屏啦；如果用户想让我看录屏，就老实说明，然后引导他先装 ffmpeg（Windows：winget install Gyan.FFmpeg）。',
    };
  }

  /**
   * 视觉模型的实际路由状态：**诊断展示与真实路由共用这一份判定**。
   *
   * 之前 badge 只看「启用 + 有地址 + 有模型名」，而地址来自厂商预设（qwen → dashscope）、
   * 模型名来自默认值——于是「在线端点没填 API Key」也显示「在线模型 ✓」。但在线调用必须带 Key，
   * 没 Key 必然 401 失败、最终回退 Coopanion，属于「报 A 实际 B」。这里把「能不能真用上」一次算清：
   * - 在线端点必须有 API Key（本地 Ollama / LM Studio 可留空）；
   * - 优先级锁定与端点地址矛盾时，本地/在线模型根本不会被调用；
   * - 优先级=coop 时一律走 Coopanion 模型商。
   */
  private modelRoute(): {
    endpoint: { base: string; protocol: 'openai-chat' | 'anthropic-messages' | 'openai-responses' | 'custom' };
    kind: 'local' | 'online';
    /** 启用 + 地址可解析 + 模型名非空。 */
    configured: boolean;
    hasKey: boolean;
    /** 真的会被调用（含 Key、优先级不冲突）。 */
    usable: boolean;
    /** 不可用的原因；'' 表示可用。 */
    blockedBy: '' | 'not-enabled' | 'missing-endpoint' | 'missing-key' | 'priority' | 'coop';
  } {
    const cfg = this.cfg;
    const endpoint = resolveEndpoint(cfg);
    // 本机端点判定（这里必须自己算，不能再调本方法，否则无限递归）。
    const kind: 'local' | 'online' = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1])/i.test(endpoint.base) ? 'local' : 'online';
    const hasKey = !!cfg.localModelApiKey?.trim();
    const hasName = !!cfg.localModelName?.trim();
    const configured = cfg.localModelEnabled && !!endpoint.base && hasName;
    let blockedBy: 'not-enabled' | 'missing-endpoint' | 'missing-key' | 'priority' | 'coop' | '' = '';
    if (cfg.localModelPriority === 'coop') blockedBy = 'coop';
    else if (!cfg.localModelEnabled) blockedBy = 'not-enabled';
    else if (!endpoint.base || !hasName) blockedBy = 'missing-endpoint';
    else if (kind === 'online' && !hasKey) blockedBy = 'missing-key';
    else if (cfg.localModelPriority === 'local' && kind !== 'local') blockedBy = 'priority';
    else if (cfg.localModelPriority === 'online' && kind !== 'online') blockedBy = 'priority';
    return { endpoint, kind, configured, hasKey, usable: blockedBy === '', blockedBy };
  }

  /** 模型面板状态：只读本地配置并解析端点，不联网。 */
  private modelState() {
    const cfg = this.cfg;
    this.syncConfigSummary();
    const endpoint = resolveEndpoint(cfg);
    const kind = this.modelRoute().kind;
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
    const kind = this.modelRoute().kind;

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
    let base = endpoint.base;
    if (!cfg.localModelEnabled) {
      return { ok: false, models: [], detail: '未启用视觉模型，请先在上方勾选' };
    }
    // 在线模型严格要求地址 + 密钥，缺了就直接提示，不发请求（避免莫名的 fetch failed）。
    if (base && this.modelRoute().kind === 'online' && !cfg.localModelApiKey.trim()) {
      return { ok: false, models: [], detail: '缺少必要数据：在线模型需要先填 API Key（本地模型可留空）' };
    }
    // 本地放宽：密钥可空；地址没填时按厂商猜默认端口。
    if (!base) {
      if (cfg.localModelProvider === 'ollama') base = 'http://127.0.0.1:11434';
      else if (cfg.localModelProvider === 'lmstudio') base = 'http://127.0.0.1:1234/v1';
      else return { ok: false, models: [], detail: '缺少必要数据：请先填地址' };
    }
    const isOllama = cfg.localModelProvider === 'ollama' || /ollama|11434/i.test(base);
    const headers: Record<string, string> = {};
    if (cfg.localModelApiKey.trim()) headers.Authorization = `Bearer ${cfg.localModelApiKey.trim()}`;
    const clean = base.replace(/\/+$/, '');
    // OpenAI 兼容：base 常以 /v1 结尾（如 DeepSeek、Ollama 的 OpenAI 模式），模型清单在 /v1/models；
    // 没带 /v1 时再补一个 /v1/models 兜底。
    const paths = /\/v1\/?$/i.test(clean) ? ['/models'] : ['/v1/models', '/models'];
    // 列表请求加超时：本地 Ollama 没起 / 远端挂住时不会把面板「获取可用模型」卡死。
    const ac = new AbortController();
    const listTimeout = setTimeout(() => ac.abort(), 12000);
    try {
      if (isOllama) {
        // Ollama 原生清单在 /api/tags；base 若以 /v1 结尾（OpenAI 模式）要去掉，否则变成 /v1/api/tags。
        const ollamaBase = clean.replace(/\/v1\/?$/i, '');
        const r = await fetch(`${ollamaBase}/api/tags`, { signal: ac.signal });
        if (!r.ok) return { ok: false, models: [], detail: `HTTP ${r.status}` };
        const j = (await r.json()) as { models?: Array<{ name: string }> };
        const models = (j.models ?? []).map((m) => m.name).filter(Boolean).sort();
        return { ok: true, models, detail: `获取到 ${models.length} 个模型` };
      }
      for (const p of paths) {
        try {
          const r = await fetch(`${clean}${p}`, { headers, signal: ac.signal });
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
    } finally {
      clearTimeout(listTimeout);
    }
  }

  webUi(lang?: string) {
    // 框架签名是 webUi?(language?: Language)，省略时按中文处理。
    const language = lang ?? 'zh';
    const zh = language !== 'en';
    this.uiLang = language;
    // 组对象是活引用：服务端每次请求都从这里重新序列化（bot.ts allConfigGroups），
    // 所以 syncConfigSummary() 运行时改 schema.description，配置页就能显示当前值。
    // 分三组：识别（OCR）、截图尺寸（像素）、实验性功能；宿主每组渲染成一个带标题的分区。
    const groups = ocrConfigGroups(language);
    this.uiGroup = groups[0];
    this.syncConfigSummary();
    return {
      label: '本地视觉 LocalVision',
      // 配置页只保留截图/OCR 层；视觉模型在「模型」面板编辑（经 ctx.persist 落盘），
      // 首组描述是面板写入的只读摘要，用户不用翻页也能看到当前配置。
      config: groups,
      panels: [
        {
          id: 'model',
          title: zh ? '模型' : 'Model',
          description: zh
            ? '配置视觉模型并检测端点是否在线。'
            : 'Configure the vision model and test its endpoints.',
          getMethods: ['state', 'probe', 'models', 'save'],
        },
        {
          id: 'diagnostics',
          title: zh ? '诊断' : 'Diagnostics',
          description: zh
            ? '检测屏幕、OCR 与硬拦截，结果保留到下次检测。'
            : 'Check screen, OCR and interception; results stay until the next run.',
          getMethods: ['report', 'patch'],
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
            { name: 'localvision.ocrfallback', description: zh ? 'OCR 兜底方式（文本 / 图片）' : 'OCR fallback mode (text / image)' },
            { name: 'localvision.watch', description: zh ? '能否看视频 / 录屏（ffmpeg 是否可用）' : 'Whether video watching is available (ffmpeg)' },
          ],
        },
      ],
      // 面板数据面必须挂在 webUi() 的返回对象上，框架只从这里收集 invoke。
      invoke: async (panel: string, method: string, args: unknown[]) => {
        if (panel === 'model') {
          if (method === 'state') return this.modelState();
          if (method === 'probe') return this.modelProbe();
          if (method === 'models') return this.modelList();
          if (method === 'save') {
            // 面板保存走 ctx.persist（深合并进 worlds.localvision 并同步 config.json），
            // 绕过配置组 schema 校验——模型键已不在配置页 schema 里，避免被静默丢弃。
            const patch = (args?.[0] ?? {}) as Record<string, unknown>;
            this.ctx.persist(patch as never);
            this.syncConfigSummary();
            return { ok: true };
          }
        }
        if (panel === 'diagnostics' && method === 'report') return this.doctorData(args?.[0] === true);
        if (panel === 'diagnostics' && method === 'patch') return this.applyCorePatch();
        throw new Error(`unknown panel/method: ${panel}/${method}`);
      },
    };
  }

  /**
   * 诊断面板「打核心补丁」按钮：跑同一个幂等脚本（scripts/apply-hook-patch.mjs）。
   * 脚本找不到宿主目录时也返回 ok=true（提示手动跑），不让面板报红。
   */
  private applyCorePatch(): { ok: boolean; patched: boolean; detail: string; output: string } {
    const script = fileURLToPath(new URL('../scripts/apply-hook-patch.mjs', import.meta.url));
    let output = '';
    try {
      const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 60000 });
      output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
      if (r.error) return { ok: false, patched: false, detail: `执行失败：${r.error.message}`, output };
      const patched = /✓ 写入/.test(output);
      const skipped = /已打过/.test(output) && !patched;
      const notFound = /未找到/.test(output);
      const detail = patched
        ? '补丁已打好（改了 3 个核心文件，备份在旁）——重启 Coopanion 后生效。'
        : skipped
          ? '补丁已在位，无需重复打。'
          : notFound
            ? '没找到 Coopanion 安装目录；如在便携/自定义路径，请在插件目录手动跑 npm run patch:hook -- <cortico/src 路径>。'
            : '补丁未生效（宿主版本可能不匹配）；可手动跑 npm run patch:hook 看详细输出。';
      return { ok: true, patched, detail, output: output.slice(-800) };
    } catch (e) {
      return { ok: false, patched: false, detail: (e as Error).message, output: output.slice(-800) };
    }
  }

  /** 配置页分组描述 = 当前视觉模型的只读摘要（未启用时提示去「模型」页开启）。 */
  private syncConfigSummary(): void {
    const g = this.uiGroup;
    if (!g) return;
    const zh = this.uiLang !== 'en';
    const cfg = this.cfg;
    if (!cfg.localModelEnabled) {
      g.schema.description = zh
        ? '视觉模型未启用。此页只读展示当前配置；启用、端点与模型名请在「模型」页修改。'
        : 'Vision model disabled. This page is a read-only summary; enable it on the Model panel.';
      return;
    }
    const base = resolveEndpoint(cfg).base || '（厂商默认地址）';
    const prio: Record<string, string> = { auto: '自动', local: '本地', online: '在线', coop: 'Coopanion' };
    g.schema.description = zh
      ? `当前视觉模型：${cfg.localModelProvider} / ${cfg.localModelName || '未填模型名'} @ ${base}（优先级 ${prio[cfg.localModelPriority] ?? cfg.localModelPriority}）。此页只读展示，修改请到「模型」页。`
      : `Current vision model: ${cfg.localModelProvider} / ${cfg.localModelName || 'no model set'} @ ${base} (priority ${cfg.localModelPriority}). Read-only here; edit on the Model panel.`;
  }
}
