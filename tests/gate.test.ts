/**
 * 硬拦截钩子的编排单测（node:test，零新依赖）。
 * 用 mock 的 ToolOutcome 与 mock 的 OCR，不碰真实截图、不跑 tesseract。
 * 跑：node --experimental-transform-types --test tests/gate.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import def from '../src/index.ts';

/** 1×1 PNG：过 imageSize 需要真实图片头，尺寸不影响断言。 */
const PNG_BYTES = new Uint8Array(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC', 'base64'),
);

const screenshotBlob = {
  mime: 'image/jpeg',
  name: 'screen.jpg',
  bytes: PNG_BYTES,
};

/** 另一组字节（PNG 解析只看头部，尾随一字节不影响尺寸判定）：用于规避缓存命中。 */
const PNG_BYTES_2 = Uint8Array.from([...PNG_BYTES, 0]);

interface WorldHarness {
  w: any;
  logs: { level: string; msg: string }[];
}

function makeWorld(over: Record<string, unknown> = {}, acceptsImage = true): WorldHarness {
  const logs: { level: string; msg: string }[] = [];
  const host = {
    log: {
      trace: () => {},
      debug: (m: string) => logs.push({ level: 'debug', msg: m }),
      info: (m: string) => logs.push({ level: 'info', msg: m }),
      warn: (m: string) => logs.push({ level: 'warn', msg: m }),
      error: () => {},
      emit: () => {},
      child: () => ({} as never),
    },
    blob: () => null,
    modelFacts: { accepts: () => acceptsImage },
  };
  const w: any = def.create({ cfg: { ...def.defaults(), ...over } });
  w.host = host;
  return { w, logs };
}

/** 跑一次钩子；words=null 表示让 OCR 抛异常。tool 默认在 hookTools 里（强制拦截）。 */
async function runGate(
  h: WorldHarness,
  words: { text: string; x: number; y: number; w: number; h: number; line: number }[] | null,
  blobs: unknown[] = [screenshotBlob],
  tool = 'pet_cua_screenshot',
) {
  h.w.runOcr = async () => {
    if (words === null) throw new Error('tesseract 预热失败');
    return words;
  };
  return h.w.transformToolOutcome({ text: '原始回执', blobs }, { tool });
}

const WORDS = [{ text: '开始', x: 0.1, y: 0.1, w: 0.2, h: 0.1, line: 0 }];

test('OCR 命中：替换成文字，图片被移除', async () => {
  const h = makeWorld();
  const out = await runGate(h, WORDS);
  assert.ok(out.text.includes('[本机 OCR]'));
  assert.ok(out.text.includes('开始'));
  assert.equal(out.blobs, undefined);
  assert.equal(h.w.getVisionGateStats().ocrHit, 1);
  assert.equal(h.w.getVisionGateStats().fallbackImage, 0);
});

test('OCR 空结果 + onOcrEmpty=image：保留原图并附兜底提示', async () => {
  const h = makeWorld();
  const out = await runGate(h, []);
  assert.equal(out.blobs?.length, 1);
  assert.ok(out.text.includes('视觉兜底'), '缺了兜底提示，模型会去硬读字');
  assert.equal(h.w.getVisionGateStats().fallbackImage, 1);
  assert.equal(h.w.getVisionGateStats().ocrEmpty, 1);
});

test('OCR 空结果 + onOcrEmpty=text：丢弃图片，说明「没有文字」', async () => {
  const h = makeWorld({ onOcrEmpty: 'text' });
  const out = await runGate(h, []);
  assert.equal(out.blobs, undefined);
  assert.ok(out.text.includes('没有识别到文字'));
  assert.ok(!out.text.includes('识别失败'), '空结果不能写成失败');
  assert.equal(h.w.getVisionGateStats().dropped, 1);
});

test('OCR 失败 + onOcrFailure=text：不冒泡，降级为文字并说明是失败', async () => {
  const h = makeWorld({ onOcrFailure: 'text' });
  // 关键：这里不能抛。旧实现只有 try/finally，异常会直接穿透钩子。
  const out = await runGate(h, null);
  assert.ok(out.text.includes('识别失败'));
  assert.ok(out.text.includes('预热失败'));
  assert.equal(out.blobs, undefined);
  assert.equal(h.w.getVisionGateStats().ocrFailed, 1);
  assert.ok(h.logs.some((l) => l.level === 'warn' && l.msg.includes('ocr-failed')), '失败要留 warn 日志');
});

test('OCR 失败 + onOcrFailure=image：仍兜底发图，且记 warn', async () => {
  const h = makeWorld({ onOcrFailure: 'image' });
  const out = await runGate(h, null);
  assert.equal(out.blobs?.length, 1);
  assert.ok(out.text.includes('视觉兜底'));
  assert.equal(h.w.getVisionGateStats().fallbackImage, 1);
  assert.equal(h.w.getVisionGateStats().ocrFailed, 1);
});

test('空结果与失败各走各的配置，互不干扰', async () => {
  const h = makeWorld({ onOcrEmpty: 'text', onOcrFailure: 'image' });
  await runGate(h, []);
  // 换一组字节避开缓存：同一张图第二次会命中缓存走 empty 分支，测不到失败路径
  await runGate(h, null, [{ ...screenshotBlob, bytes: PNG_BYTES_2 }]);
  const s = h.w.getVisionGateStats();
  assert.equal(s.ocrEmpty, 1);
  assert.equal(s.ocrFailed, 1);
  assert.equal(s.fallbackImage, 1); // 只有失败那次兜底
  assert.equal(s.fallbackText, 1); // 只有空结果那次降级
});

test('同一张图第二次命中缓存，不再跑 OCR', async () => {
  const h = makeWorld({ onOcrEmpty: 'image' });
  let calls = 0;
  h.w.runOcr = async () => {
    calls += 1;
    return [];
  };
  const out1 = { text: '原始回执', blobs: [screenshotBlob] };
  await h.w.transformToolOutcome(out1, { tool: 'pet_cua_screenshot' });
  await h.w.transformToolOutcome({ text: '原始回执', blobs: [screenshotBlob] }, { tool: 'pet_cua_screenshot' });
  assert.equal(calls, 1);
  assert.equal(h.w.getVisionGateStats().cacheHit, 1);
});

test('OCR 失败不写缓存，避免故障被后续命中掩盖', async () => {
  const h = makeWorld({ onOcrFailure: 'image' });
  let calls = 0;
  h.w.runOcr = async () => {
    calls += 1;
    throw new Error('boom');
  };
  const t = { tool: 'pet_cua_screenshot' };
  await h.w.transformToolOutcome({ text: 'x', blobs: [screenshotBlob] }, t);
  await h.w.transformToolOutcome({ text: 'x', blobs: [screenshotBlob] }, t);
  assert.equal(calls, 2, '失败被缓存了会导致后续都命中，看起来像「画面没字」');
});

test('fallbackHint=false 时不加兜底提示', async () => {
  const h = makeWorld({ fallbackHint: false });
  const out = await runGate(h, []);
  assert.equal(out.blobs?.length, 1, '图仍要发，只是不加提示');
  assert.ok(!out.text.includes('视觉兜底'));
});

test('模型不收图时：想发图也发不出去，降级为文字并说明原因', async () => {
  const h = makeWorld({ onOcrEmpty: 'image' }, false);
  const out = await runGate(h, []);
  assert.equal(out.blobs, undefined);
  assert.ok(h.logs.some((l) => l.msg.includes('model-rejects-image')));
  assert.equal(h.w.getVisionGateStats().fallbackImage, 0);
});

test('非截图的图片（生成图）原样放行', async () => {
  const h = makeWorld();
  const blob = { mime: 'image/png', name: '生成图.png', bytes: PNG_BYTES };
  // 工具名不在 hookTools 里 → 不强制拦截，只靠名字/特征判断，生成图该放行
  const out = await runGate(h, [], [blob], 'other_tool');
  assert.equal(out.text, '原始回执', '不该改文本');
  assert.deepEqual(out.blobs, [blob], '不该动 blob');
  assert.equal(h.w.getVisionGateStats().calls, 0);
});

test('hookTools 里的工具：强制拦截任何图片，生成图也不放过', async () => {
  const h = makeWorld();
  const blob = { mime: 'image/png', name: '生成图.png', bytes: PNG_BYTES };
  const out = await runGate(h, WORDS, [blob]);
  assert.ok(out.text.includes('[本机 OCR]'), '列进 hookTools 就该硬拦，不看文件名');
  assert.equal(out.blobs, undefined);
  assert.equal(h.w.getVisionGateStats().ocrHit, 1);
});

test('取不到字节的 blob 按失败处理，不再静默保留', async () => {
  const h = makeWorld({ onOcrFailure: 'text' });
  const out = await runGate(h, [], [{ mime: 'image/jpeg', name: 'screen.jpg' }]);
  assert.ok(out.text.includes('取不到画面数据'));
  assert.equal(h.w.getVisionGateStats().ocrFailed, 1);
  assert.ok(h.logs.some((l) => l.level === 'warn' && l.msg.includes('no-bytes-or-size')));
});

test('getVisionGateStats 暴露补丁在位状态与估算成本', async () => {
  const h = makeWorld();
  const s = h.w.getVisionGateStats();
  assert.equal(s.hookInterceptActive, false, '没 start 过就没有钩子');
  assert.equal(typeof s.estimatedTokens, 'number');
  await runGate(h, []);
  assert.ok(h.w.getVisionGateStats().estimatedTokens > 0, '发图了就该有成本估算');
});

test('日志是结构化 JSON 行，含 action 与 reason', async () => {
  const h = makeWorld();
  await runGate(h, []);
  const line = h.logs.find((l) => l.msg.startsWith('localvision.gate '));
  assert.ok(line);
  const json = JSON.parse(line.msg.slice('localvision.gate '.length));
  assert.equal(json.action, 'kept');
  assert.equal(json.reason, 'ocr-empty-image-fallback');
  assert.equal(json.ocrHit, false);
  assert.equal(json.tool, 'pet_cua_screenshot');
  assert.ok(json.ts);
  assert.ok(json.estimatedTokenCost > 0);
});
