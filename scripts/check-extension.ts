/**
 * check:extension —— 复刻 cortico 的自描述校验（cortico 0.2.4 未提供 CLI，此处等价实现）。
 * 校验项：
 *  1) WorldDefinition 必须带有内联 describe（tools / events）。
 *  2) tools() 返回的工具名都要在 describe.tools 中声明（否则失败）。
 *  3) tools() 默认配置下返回的 description / parameters 与 describe.tools 一致（不一致仅警告）。
 *  4) cortico.describe 指向的 describe.json 与代码内联 describe 完全一致（不一致则失败）。
 *
 * 运行：node --experimental-transform-types scripts/check-extension.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import mod from '../src/index.ts';

const def = mod as any;
const failures: string[] = [];
const warnings: string[] = [];
const ok: string[] = [];

if (!def.describe) {
  failures.push('WorldDefinition 缺少 describe 字段。请参照 cortico 约定在默认导出中加入 describe: { tools, events }。');
} else {
  // 构造实例，取出 tools() 默认配置下给出的工具（仅 name/description/parameters 参与比较）
  const ctx = { config: def.defaults(), id: def.id, packageDir: process.cwd() };
  let liveTools: Array<{ name: string; description: string; parameters: unknown }> = [];
  try {
    const world = def.create(ctx);
    liveTools = world.tools().map((t: any) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  } catch (e: any) {
    failures.push(`构造 World 实例失败：${e?.message ?? e}`);
  }

  const declared = new Set((def.describe.tools ?? []).map((t: any) => t.name));
  const liveNames = liveTools.map((t) => t.name);
  const extra = liveNames.filter((n) => !declared.has(n));
  if (extra.length) {
    failures.push(`tools() 返回了未在 describe.tools 声明的工具：${extra.join(', ')}。`);
  } else if (liveNames.length) {
    ok.push('tools(): 每个工具都在 describe.tools 中声明。');
  }

  // 默认配置下 tools() 的 description/parameters 与声明是否一致（不一致仅警告）
  const byName = new Map((def.describe.tools ?? []).map((t: any) => [t.name, t]));
  const changed = liveTools.flatMap((t) => {
    const d = byName.get(t.name);
    if (!d) return [];
    const fields: string[] = [];
    if (d.description !== t.description) fields.push('description');
    if (!isDeepStrictEqual(d.parameters, t.parameters)) fields.push('parameters');
    return fields.length ? [`${t.name} (${fields.join(', ')})`] : [];
  });
  if (changed.length) {
    warnings.push(`tools() 默认配置下返回的 description/parameters 与 describe.tools 不同：${changed.join(', ')}。`);
  } else if (liveNames.length) {
    ok.push('tools(): description/parameters 与 describe.tools 一致。');
  }

  // describe.json（cortico.describe 指向）必须与内联 describe 完全一致
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const describePath: string = pkg.cortico?.describe ?? 'describe.json';
  if (!existsSync(describePath)) {
    failures.push(`cortico.describe 指向 ${describePath}，但文件不存在。运行 pnpm describe:extension 生成。`);
  } else {
    let written: unknown;
    try {
      written = JSON.parse(readFileSync(describePath, 'utf8'));
    } catch (e: any) {
      failures.push(`${describePath} 不是合法 JSON：${e?.message ?? e}`);
      written = null;
    }
    if (written) {
      const regenerated = { tools: [...def.describe.tools], events: [...def.describe.events] };
      if (!isDeepStrictEqual(written, regenerated)) {
        failures.push(`${describePath} 与代码内联 describe 不一致。运行 pnpm describe:extension 重新生成。`);
      } else {
        ok.push(`${describePath} 与代码内联 describe 完全一致。`);
      }
    }
  }
}

function report() {
  if (ok.length) console.log('✓ ' + ok.join('\n✓ '));
  if (warnings.length) console.warn('⚠ ' + warnings.join('\n⚠ '));
  if (failures.length) {
    console.error('\n✗ ' + failures.join('\n✗ '));
    process.exit(1);
  } else {
    console.log('\ncheck:extension 通过（无失败）。');
  }
}
report();
