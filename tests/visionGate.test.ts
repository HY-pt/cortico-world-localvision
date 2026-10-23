/**
 * 视觉门控纯函数层单测（node:test，零新依赖）。
 * 跑：node --experimental-transform-types --test tests/visionGate.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideFallback,
  emptyCounters,
  estimateImageTokens,
  formatFallbackHint,
  isImageBlob,
  isScreenshotLike,
} from '../src/visionGate.ts';

const imgBlob = (name: string, extra: Record<string, unknown> = {}) => ({
  mime: 'image/jpeg',
  name,
  ...extra,
});

test('isImageBlob 只认 image/*', () => {
  assert.equal(isImageBlob({ mime: 'image/png' }), true);
  assert.equal(isImageBlob({ mime: 'text/plain' }), false);
  assert.equal(isImageBlob({}), false);
});

test('isScreenshotLike：截图特征命中，生成图不命中，forced 时一律拦', () => {
  assert.equal(isScreenshotLike(imgBlob('screen.jpg'), false), true);
  assert.equal(isScreenshotLike(imgBlob('zoom.png'), false), true);
  assert.equal(isScreenshotLike(imgBlob('a.png', { fallbackText: '屏幕截图 1920x1080' }), false), true);
  assert.equal(isScreenshotLike(imgBlob('生成图.png'), false), false);
  // 工具名列进 hookTools 时，不看名字只要是图片就拦
  assert.equal(isScreenshotLike(imgBlob('随意.png'), true), true);
  assert.equal(isScreenshotLike({ mime: 'text/plain', name: 'screen.txt' }, false), false);
});

test('estimateImageTokens：按 OpenAI high-detail 规则近似', () => {
  assert.equal(estimateImageTokens(0, 0), 0);
  // 1280×800 → fit 2048 不缩放 → 短边缩到 768 得 1228.8×768 → 3×2 tiles → 6*170+85
  assert.equal(estimateImageTokens(1280, 800), 1105);
  // 超大图：先 fit 到 2048
  assert.ok(estimateImageTokens(8000, 6000) > 0);
});

test('decideFallback：命中走替换', () => {
  const d = decideFallback('hit', { onOcrEmpty: 'image', onOcrFailure: 'image' }, true);
  assert.deepEqual(d, { action: 'replaced', imageFallback: false, reason: 'ocr-hit' });
});

test('decideFallback：空结果按 onOcrEmpty', () => {
  const p1 = { onOcrEmpty: 'image' as const, onOcrFailure: 'image' as const };
  assert.equal(decideFallback('empty', p1, true).action, 'kept');
  assert.equal(decideFallback('empty', p1, true).imageFallback, true);
  assert.equal(decideFallback('empty', p1, true).reason, 'ocr-empty-image-fallback');

  const p2 = { onOcrEmpty: 'text' as const, onOcrFailure: 'image' as const };
  assert.equal(decideFallback('empty', p2, true).action, 'dropped');
  assert.equal(decideFallback('empty', p2, true).reason, 'ocr-empty-text');
});

test('decideFallback：失败按 onOcrFailure，与空结果互不干扰', () => {
  // 空结果走 text、失败走 image —— 两条配置各管各的
  const p = { onOcrEmpty: 'text' as const, onOcrFailure: 'image' as const };
  assert.equal(decideFallback('failed', p, true).action, 'kept');
  assert.equal(decideFallback('failed', p, true).reason, 'ocr-failed-image-fallback');
  assert.equal(decideFallback('empty', p, true).action, 'dropped');

  const p2 = { onOcrEmpty: 'image' as const, onOcrFailure: 'text' as const };
  assert.equal(decideFallback('failed', p2, true).action, 'dropped');
  assert.equal(decideFallback('failed', p2, true).reason, 'ocr-failed-text');
  assert.equal(decideFallback('empty', p2, true).action, 'kept');
});

test('decideFallback：模型不收图时，image 兜底必须降级为文字', () => {
  const p = { onOcrEmpty: 'image' as const, onOcrFailure: 'image' as const };
  const d = decideFallback('empty', p, false);
  assert.equal(d.action, 'dropped');
  assert.equal(d.imageFallback, false);
  assert.equal(d.reason, 'ocr-empty-text-model-rejects-image');
});

test('formatFallbackHint：桌宠口吻、说明边界、不指挥模型', () => {
  const zh = formatFallbackHint();
  assert.ok(zh.includes('视觉兜底'));
  assert.ok(zh.includes('我')); // 第一人称
  assert.ok(!zh.includes('桌宠')); // 禁止第三人称自称
  assert.ok(!zh.includes('直接回应用户')); // 不越界指挥
  assert.ok(formatFallbackHint({ hintCjk: false }).includes('Visual fallback'));
});

test('emptyCounters：字段齐全且从零开始', () => {
  const c = emptyCounters();
  assert.equal(c.fallbackImage, 0);
  assert.equal(c.estimatedTokens, 0);
  assert.equal(Object.values(c).every((v) => v === 0), true);
  assert.equal(Object.keys(c).length, 10);
});
