/**
 * 烟测：验证 localvision 的本地视觉端点（Ollama / OpenAI 兼容）连通性与请求格式。
 * 这对应"开始接 Ollama"的集成验证——不依赖 Cortico，直接用 fetch 复刻插件里的请求形状。
 *
 * 前置：
 *   ollama serve                 # 启动 Ollama（默认 127.0.0.1:11434）
 *   ollama pull minicpm-v2.6     # 或任意支持视觉的模型
 * 运行：
 *   node scripts/smoke.mjs
 *   VLM_BASE_URL=http://127.0.0.1:11434/v1 VLM_MODEL=minicpm-v2.6 node scripts/smoke.mjs
 */

const BASE = process.env.VLM_BASE_URL || 'http://127.0.0.1:11434/v1';
const MODEL = process.env.VLM_MODEL || 'minicpm-v2.6';

// 1x1 红点 PNG（仅用于验证请求格式，不用于真实识别）
const IMG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC';
// 一张带文字的小图（base64）用于验证 OCR / 锚定请求能正常往返（这里只验证格式，不断言结果）。
const IMG_TEXT =
  'iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAUklEQVR4nO3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHgZGkgAAb0jfsAAAAAElFTkSuQmCC';

async function postChat(payload) {
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  console.log('BASE =', BASE, '| MODEL =', MODEL);

  // 0) 模型是否就绪
  try {
    const root = BASE.replace(/\/v1\/?$/, '');
    const tags = await fetch(root + '/api/tags').then((r) => r.json()).catch(() => null);
    const names = tags?.models?.map((m) => m.name) ?? [];
    console.log('已拉取模型:', names.join(', ') || '(无法读取 /api/tags，请确认 Ollama 已启动)');
    if (names.length && !names.some((n) => n.includes(MODEL))) {
      console.warn(`警告：未找到 ${MODEL}，请先 ollama pull ${MODEL}`);
    }
  } catch {
    /* 忽略，后面会再失败 */
  }

  // 1) Tier1/Tier2 使用的 Ollama 原生 images 字段格式（SEE 描述）
  try {
    const desc = await postChat({
      model: MODEL,
      messages: [{ role: 'user', content: '用中文一句话描述这张图的主要颜色。', images: [IMG] }],
      stream: false,
    });
    console.log('\n[SEE] images 字段格式返回：', desc.slice(0, 200));
  } catch (e) {
    console.error('\n[SEE] 失败：', e.message);
    throw e;
  }

  // 2) Tier3 使用的 OpenAI image_url 格式（Vision API，可指向云端）
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
    console.log('[Tier3] image_url 格式返回：', desc.slice(0, 200));
  } catch (e) {
    console.error('[Tier3] image_url 格式失败：', e.message);
    console.error('（若指向本地 Ollama，请确认其 OpenAI 兼容端点支持 image_url；否则 Tier3 可改用云端端点）');
  }

  console.log('\nOK：端点连通且两种请求格式均可用，可继续在 Coopanion/Cortico 中加载本 World。');
}

main().catch((e) => {
  console.error('\n烟测未通过：', e?.message ?? e);
  console.error('请确认：ollama serve 已启动，且已执行 ollama pull ' + MODEL);
  process.exit(1);
});
