/**
 * 烟测：验证 localvision 的「通用视觉端点」（OpenAI 兼容 /v1）连通性与标准 image_url 请求格式。
 * 不依赖 Cortico，直接用 fetch 复刻插件里的请求形状。
 *
 * 前置（任选其一）：
 *   ollama serve                                   # 本地 Ollama（默认 127.0.0.1:11434）
 *   ollama pull minicpm-v2.6                        # 或任意支持视觉的模型
 *   # 或：把 visionApiBaseUrl 指向任意云端 OpenAI 兼容端点并填 VISION_API_KEY
 *
 * 运行：
 *   node scripts/smoke.mjs
 *   VISION_API_BASE_URL=http://127.0.0.1:11434/v1 VISION_API_MODEL=minicpm-v2.6 node scripts/smoke.mjs
 */

const BASE = process.env.VISION_API_BASE_URL || 'http://127.0.0.1:11434/v1';
const MODEL = process.env.VISION_API_MODEL || 'minicpm-v2.6';
const KEY = process.env.VISION_API_KEY || '';

// 1x1 红点 PNG（仅用于验证请求格式，不用于真实识别）
const IMG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC';
// 一张带文字的小图（base64）用于验证 OCR / 锚定请求能正常往返（这里只验证格式，不断言结果）。
const IMG_TEXT =
  'iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAUklEQVR4nO3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHgZGkgAAb0jfsAAAAAElFTkSuQmCC';

async function postChat(payload) {
  const url = BASE.replace(/\/+$/, '') + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (KEY) headers['Authorization'] = `Bearer ${KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const d = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${d}`);
  }
  const j = await res.json();
  return j?.choices?.[0]?.message?.content ?? '';
}

async function main() {
  console.log('BASE =', BASE, '| MODEL =', MODEL, KEY ? '| (with Bearer key)' : '| (no key)');

  // 0) 本地 Ollama 可额外探测已拉模型（云端端点无此接口，忽略失败）
  try {
    const root = BASE.replace(/\/v1\/?$/, '');
    const tags = await fetch(root + '/api/tags').then((r) => r.json()).catch(() => null);
    const names = tags?.models?.map((m) => m.name) ?? [];
    console.log('已拉取模型:', names.join(', ') || '(无法读取 /api/tags，若为云端端点属正常)');
    if (names.length && !names.some((n) => n.includes(MODEL))) {
      console.warn(`警告：未找到 ${MODEL}，请先 ollama pull ${MODEL}`);
    }
  } catch {
    /* 忽略，后面会再失败 */
  }

  // 1) 标准 image_url 格式（SEE 描述）—— vlm.ts 全程使用此格式（本地/云端通用）
  try {
    const desc = await postChat({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '用中文一句话描述这张图的主要颜色。' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${IMG}` } },
          ],
        },
      ],
      stream: false,
    });
    console.log('\n[SEE] image_url 格式返回：', desc.slice(0, 200));
  } catch (e) {
    console.error('\n[SEE] 失败：', e.message);
    throw e;
  }

  // 2) 标准 image_url 格式（Tier1 锚定 / Tier3 看图定位 复用同一格式）
  try {
    const desc = await postChat({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张图里有什么文字？（只回答看到的文字）' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${IMG_TEXT}` } },
          ],
        },
      ],
      stream: false,
    });
    console.log('[锚定/Tier3] image_url 格式返回：', desc.slice(0, 200));
  } catch (e) {
    console.error('[锚定/Tier3] image_url 格式失败：', e.message);
  }

  console.log('\nOK：端点连通且标准 image_url 请求格式可用，可继续在 Coopanion/Cortico 中加载本 World。');
}

main().catch((e) => {
  console.error('\n烟测未通过：', e?.message ?? e);
  console.error('请确认：视觉端点已启动（ollama serve 或云端可达），且模型已就绪（ollama pull ' + MODEL + '）');
  process.exit(1);
});
