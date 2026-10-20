/**
 * describe:extension —— 从代码内联 describe 重新生成 cortico.describe 指向的 describe.json。
 * 与 cortico 官方脚本等价：把 WorldDefinition.describe 落盘，供扩展市场展示与 check:extension 比对。
 *
 * 运行：node --experimental-transform-types scripts/describe-extension.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import mod from '../src/index.ts';

const def = mod as any;
if (!def.describe) {
  console.error('WorldDefinition 缺少 describe 字段，无法生成 describe.json。');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const describePath: string = pkg.cortico?.describe ?? 'describe.json';

const out = {
  tools: [...def.describe.tools],
  events: [...def.describe.events],
};
writeFileSync(describePath, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`describe:extension 已生成 ${describePath}（tools=${out.tools.length}, events=${out.events.length}）。`);
