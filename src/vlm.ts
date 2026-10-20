/**
 * 通用视觉端点客户端（OpenAI 兼容 /chat/completions）。
 *
 * 设计要点（彻底解耦本地模型）：
 *  - 本文件不绑定 Ollama、不绑定任何具体后端。它只认「OpenAI 兼容的 /v1/chat/completions」。
 *  - 用户可在配置里把 visionApiBaseUrl 指向：
 *      · 本地 Ollama 的 /v1（如 http://127.0.0.1:11434/v1，无需 key）
 *      · LM Studio / llama.cpp server 的 /v1（无需 key）
 *      · 任意云端 OpenAI 兼容视觉 API（填 Bearer key）
 *  - 所有图片均以「标准 image_url（data URL）」格式发送，这是 OpenAI 标准，
 *    也是 Ollama / LM Studio 等本地服务的 OpenAI 兼容端点支持的格式。
 *  - 视觉端点是【可选】的：未配置（baseUrl 为空）时，调用方直接走轻量模式，
 *    本模块不会被调用，桌宠不卡顿。
 *  - 每个调用都带超时（AbortController）与可选 Bearer 鉴权，失败只抛错由调用方降级。
 */

export interface VisionOpts {
  baseUrl: string; // 形如 https://api.xxx/v1 或 http://127.0.0.1:11434/v1（不含尾斜杠也可）
  apiKey: string; // Bearer Token；本地端点留空
  model: string; // 模型名（Ollama 填如 minicpm-v2.6 / qwen2-vl；云端填如 gpt-4o）
  timeoutMs?: number; // 超时毫秒；<=0 表示不超时
}

export interface Box {
  x: number; // 中心归一化 x (0-1)
  y: number; // 中心归一化 y (0-1)
  w: number; // 宽归一化 (0-1)
  h: number; // 高归一化 (0-1)
}

const SEE_PROMPT =
  '用中文简要描述这张屏幕截图：可见的窗口/应用、关键文字、可疑的可点击元素及其大致位置。' +
  '只描述画面所见，不要猜测应用名；若给出了关注点，只围绕它描述。';

const OCR_PROMPT = '逐字提取图中所有文字，按出现顺序列出，不要改写、不要翻译、不要省略。';

const LOCATE_PROMPT =
  '在图中找到文字 "{Q}" 所在的可点击区域，输出其归一化边界框 JSON：' +
  '{"x":<中心x 0-1>,"y":<中心y 0-1>,"w":<宽0-1>,"h":<高0-1>}。只输出 JSON 本身，不要解释。';

const LOCATE_INTENT_PROMPT =
  '在截图中找到"{Q}"所在的可点击位置，输出其【中心】归一化坐标 JSON：' +
  '{"x":<中心x 0-1>,"y":<中心y 0-1>}。只输出 JSON 本身，不要解释。';

/**
 * 通用视觉调用：发送一张图 + 一段文字，返回模型文本。
 * 使用标准 OpenAI image_url 格式，支持 Bearer 鉴权与超时。
 */
export async function callVision(
  opts: VisionOpts,
  prompt: string,
  imageB64: string,
  timeoutMs = 0
): Promise<string> {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const body = {
    model: opts.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${imageB64}` } },
        ],
      },
    ],
    stream: false,
  };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.apiKey) headers['Authorization'] = `Bearer ${opts.apiKey}`;

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`视觉端点 ${res.status}: ${detail}`);
    }
    const data: any = await res.json();
    return data?.choices?.[0]?.message?.content ?? '';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 截屏 -> 稳定文字描述（perception 主工具）。 */
export function describeScreen(
  imageB64: string,
  opts: VisionOpts,
  prompt?: string,
  timeoutMs?: number
): Promise<string> {
  return callVision(opts, prompt?.trim() || SEE_PROMPT, imageB64, timeoutMs ?? opts.timeoutMs ?? 0);
}

/** 截屏 -> 逐字 OCR 文本。 */
export function ocrScreen(imageB64: string, opts: VisionOpts, timeoutMs?: number): Promise<string> {
  return callVision(opts, OCR_PROMPT, imageB64, timeoutMs ?? opts.timeoutMs ?? 0);
}

/**
 * Tier1：按屏幕上文字定位其归一化边界框（OCR/视觉锚定点击用）。
 * 由视觉端点完成"文字 -> 位置"的 grounding，云端只给文字，不猜坐标，精度高于归一化回退。
 * 找不到或解析失败返回 null（调用方降级），不抛错。
 */
export async function locateText(
  imageB64: string,
  opts: VisionOpts,
  query: string,
  timeoutMs?: number
): Promise<Box | null> {
  const prompt = LOCATE_PROMPT.replace('{Q}', query.replace(/[\\"]/g, ' '));
  const raw = await callVision(opts, prompt, imageB64, timeoutMs ?? opts.timeoutMs ?? 0);
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (typeof o.x === 'number' && typeof o.y === 'number') return o as Box;
    return null;
  } catch {
    return null;
  }
}

/**
 * Tier3 终极兜底：把截图传给视觉端点，让其按自然语言意图定位可点击位置的中心归一化坐标。
 * 与 Tier1 共用同一通用端点（本地或云端皆可），只是 prompt 形态不同。
 * 找不到或解析失败返回 null（调用方降级），不抛错；超时/网络错误由调用方 try/catch。
 */
export async function locateViaVision(
  imageB64: string,
  opts: VisionOpts,
  intent: string,
  timeoutMs?: number
): Promise<{ x: number; y: number } | null> {
  const prompt = LOCATE_INTENT_PROMPT.replace('{Q}', intent.replace(/[\\"]/g, ' '));
  const raw = await callVision(opts, prompt, imageB64, timeoutMs ?? opts.timeoutMs ?? 0);
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (typeof o.x === 'number' && typeof o.y === 'number') return { x: o.x, y: o.y };
    return null;
  } catch {
    return null;
  }
}
