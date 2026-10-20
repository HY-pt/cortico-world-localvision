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
