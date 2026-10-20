/**
 * 本地视觉模型客户端 + 三级兜底的 Vision API 客户端。
 *  - 本地 VLM（Ollama / LM Studio / llama.cpp）：只与本地端点通信，图片不出本机。
 *  - Vision API（Tier3 终极兜底）：OpenAI 兼容 /chat/completions，可指向本地也可指向云端，
 *    用于前两级（OCR / 归一化坐标）都失败时的"看图找点"。带超时与鉴权头。
 */

export interface CapturedImage {
  base64: string; // 不含 data: 前缀的 PNG base64
  width: number;
  height: number;
}

const SEE_PROMPT =
  '用中文简要描述这张屏幕截图：可见的窗口/应用、关键文字、可疑的可点击元素及其大致位置。' +
  '只描述画面所见，不要猜测应用名；若给出了关注点，只围绕它描述。';

const OCR_PROMPT = '逐字提取图中所有文字，按出现顺序列出，不要改写、不要翻译、不要省略。';

async function chatWithImage(
  base64: string,
  baseUrl: string,
  model: string,
  prompt: string,
  timeoutMs = 0
): Promise<string> {
  const url = baseUrl.replace(/\/$/, '') + '/chat/completions';
  const body = {
    model,
    messages: [{ role: 'user', content: prompt, images: [base64] }],
    stream: false,
  };
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`本地视觉模型请求失败 ${res.status}: ${detail}`);
    }
    const data: any = await res.json();
    return data?.choices?.[0]?.message?.content ?? '';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function describeOllama(
  base64: string,
  baseUrl: string,
  model: string,
  prompt?: string,
  timeoutMs?: number
): Promise<string> {
  return chatWithImage(base64, baseUrl, model, prompt?.trim() || SEE_PROMPT, timeoutMs ?? 0);
}

export function ocrWithVlm(
  base64: string,
  baseUrl: string,
  model: string,
  timeoutMs?: number
): Promise<string> {
  return chatWithImage(base64, baseUrl, model, OCR_PROMPT, timeoutMs ?? 0);
}

const LOCATE_PROMPT =
  '在图中找到文字 "{Q}" 所在的可点击区域，输出其归一化边界框 JSON：' +
  '{"x":<中心x 0-1>,"y":<中心y 0-1>,"w":<宽0-1>,"h":<高0-1>}。只输出 JSON 本身，不要解释。';

/**
 * 按文字在屏幕上定位其归一化边界框（OCR/视觉锚定点击用，Tier1）。
 * 由本地视觉模型完成"文字 -> 位置"的 grounding，云端只给文字，不猜坐标，精度高于直接归一化回退。
 */
export async function locateText(
  base64: string,
  baseUrl: string,
  model: string,
  query: string,
  timeoutMs?: number
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  const prompt = LOCATE_PROMPT.replace('{Q}', query.replace(/[\\"]/g, ' '));
  const raw = await chatWithImage(base64, baseUrl, model, prompt, timeoutMs ?? 0);
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (typeof o.x === 'number' && typeof o.y === 'number') return o;
    return null;
  } catch {
    return null;
  }
}

/**
 * Tier3 终极兜底：把截图传给 Vision API，让其按文字意图定位可点击位置的中心归一化坐标。
 * 与本地 VLM 不同，这里用 OpenAI 兼容的 image_url 格式，并支持 Bearer 鉴权（可指向云端）。
 * 带超时与错误处理：调用方应 catch，失败即视为兜底失败、返回清晰错误，不崩溃。
 */
export async function locateViaVision(
  base64: string,
  baseUrl: string,
  apiKey: string,
  model: string,
  intent: string,
  timeoutMs = 20000
): Promise<{ x: number; y: number } | null> {
  const url = baseUrl.replace(/\/$/, '') + '/chat/completions';
  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `在截图中找到"${intent}"所在的可点击位置，输出其【中心】归一化坐标 JSON：` +
              '{"x":<中心x 0-1>,"y":<中心y 0-1>}。只输出 JSON 本身，不要解释。',
          },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
        ],
      },
    ],
    stream: false,
  };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Vision API ${res.status}: ${detail}`);
    }
    const data: any = await res.json();
    const raw = data?.choices?.[0]?.message?.content ?? '';
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      const o = JSON.parse(m[0]);
      if (typeof o.x === 'number' && typeof o.y === 'number') return { x: o.x, y: o.y };
      return null;
    } catch {
      return null;
    }
  } finally {
    clearTimeout(timer);
  }
}
