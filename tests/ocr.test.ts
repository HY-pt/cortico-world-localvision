/**
 * OCR 输出层单测（node:test，零新依赖）。
 * 跑：node --experimental-transform-types --test tests/ocr.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ocrToText, ocrToLocatedTextMapped, SINGLE_LINE_MIN_CONF, type OcrWord } from '../src/ocr.ts';

/** 常规识别出来的词：有真实坐标。 */
const boxed = (text: string, x = 0.1): OcrWord => ({ text, x, y: 0.5, w: 0.2, h: 0.05, line: 0 });
/** 单行补读出来的词：只有文字，没有坐标。 */
const nobox = (text: string): OcrWord => ({ text, x: 0, y: 0, w: 0, h: 0, line: 0, noBox: true });

const map = (nx: number, ny: number) => ({ x: nx * 1280, y: ny * 720 });

test('补读置信度门槛取值有据：字幕 63~93，CG 碎片 0~15', () => {
  assert.equal(SINGLE_LINE_MIN_CONF, 40);
  assert.ok(SINGLE_LINE_MIN_CONF > 15, '要能滤掉 CG 碎片');
  assert.ok(SINGLE_LINE_MIN_CONF < 63, '要能放真字幕过');
});

test('有坐标的词照常给出可点击坐标', () => {
  const out = ocrToLocatedTextMapped([boxed('确认', 0.5)], map);
  assert.ok(out.includes('确认 @ ('));
  assert.ok(out.includes('关键文字及中心坐标'));
  assert.ok(!out.includes('没有位置信息'), '有坐标就不该出现这句');
});

test('全是补读词时：只给文字，并明说不能用于点击', () => {
  const out = ocrToLocatedTextMapped([nobox('记住你一定要从这里出来')], map);
  assert.ok(out.includes('没有位置信息'));
  assert.ok(out.includes('不能用于点击'));
  // 关键：绝不能编造坐标出来
  assert.ok(!out.includes('@ ('), '没有坐标就不能输出坐标，否则模型会点错地方');
});

test('混合时：坐标清单只含有坐标的词，另提示有几个词没位置', () => {
  const out = ocrToLocatedTextMapped([boxed('确认'), nobox('记住你一定要从这里出来')], map);
  assert.ok(out.includes('确认 @ ('), '有坐标的照常给');
  assert.ok(!out.includes('记住你一定要从这里出来 @ ('), '没坐标的不能混进坐标清单');
  assert.ok(out.includes('另有 1 个词没有位置信息'));
});

test('补读词的文字照样进阅读顺序，不会被丢掉', () => {
  const text = ocrToText([nobox('第一句'), nobox('第二句')]);
  assert.ok(text.includes('第一句'));
  assert.ok(text.includes('第二句'));
});

test('空输入返回空串，不产生多余说明', () => {
  assert.equal(ocrToLocatedTextMapped([], map), '');
  assert.equal(ocrToText([]), '');
});
