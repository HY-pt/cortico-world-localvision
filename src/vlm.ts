/**
 * 本地视觉模型客户端（OpenAI 兼容 /chat/completions）。
 * 只与本地端点（Ollama / LM Studio / llama.cpp）通信，图片不出本机。
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
  prompt: string
): Promise<string> {
  const url = baseUrl.replace(/\/$/, '') + '/chat/completions';
  const body = {
    model,
    messages: [{ role: 'user', content: prompt, images: [base64] }],
    stream: false,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`本地视觉模型请求失败 ${res.status}: ${detail}`);
  }
  const data: any = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

export function describeOllama(
  base64: string,
  baseUrl: string,
  model: string,
  prompt?: string
): Promise<string> {
  return chatWithImage(base64, baseUrl, model, prompt?.trim() || SEE_PROMPT);
}

export function ocrWithVlm(base64: string, baseUrl: string, model: string): Promise<string> {
  return chatWithImage(base64, baseUrl, model, OCR_PROMPT);
}

const LOCATE_PROMPT =
  '在图中找到文字 "{Q}" 所在的可点击区域，输出其归一化边界框 JSON：' +
  '{"x":<中心x 0-1>,"y":<中心y 0-1>,"w":<宽0-1>,"h":<高0-1>}。只输出 JSON 本身，不要解释。';

/**
 * 按文字在屏幕上定位其归一化边界框（OCR/视觉锚定点击用）。
 * 由本地视觉模型完成"文字 -> 位置"的 grounding，云端只给文字，不猜坐标，精度高于直接归一化回退。
 */
export async function locateText(
  base64: string,
  baseUrl: string,
  model: string,
  query: string
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  const prompt = LOCATE_PROMPT.replace('{Q}', query.replace(/[\\"]/g, ' '));
  const raw = await chatWithImage(base64, baseUrl, model, prompt);
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
