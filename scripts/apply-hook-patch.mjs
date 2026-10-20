#!/usr/bin/env node
/**
 * 一键给 Coopanion 宿主打上「工具回执变换」核心钩子。
 * 与 patches/core-tool-outcome-hook.patch 等价（三个文件：core/types.ts、core/loop.ts、core/core.ts），
 * 但用字符串锚点实现，不依赖 patch 命令，Windows 可直接跑。
 *
 * 幂等：已打过（检测到 registerToolOutcomeTransform）自动跳过；
 * 首次修改前写 <file>.bak-hookpatch 备份。
 *
 * 用法：
 *   node scripts/apply-hook-patch.mjs [cortico-src 目录] [--silent]
 * 缺省自动探测：%LOCALAPPDATA%/Programs/Coopanion/resources/app/build/cortico/src
 * --silent：作为 postinstall 运行时压低输出；无论打没打、找没找到宿主，都以 0 退出（绝不阻断安装）。
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const silent = args.includes('--silent');
const quiet = (...a) => { if (!silent) console.log(...a); };
const candidates = [
  args.find((a) => !a.startsWith('-')),
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Coopanion', 'resources', 'app', 'build', 'cortico', 'src'),
].filter(Boolean);
const srcDir = candidates.find((p) => p && existsSync(join(p, 'core', 'loop.ts')));
if (!srcDir) {
  // 没装 Coopanion 的机器上（如纯开发 clone）静默跳过——不是错误。
  quiet('未找到 Coopanion 的 cortico src 目录，跳过打补丁（可手动：npm run patch:hook -- <路径>）');
  process.exit(0);
}
quiet(`目标：${srcDir}\n`);

const files = ['core/types.ts', 'core/loop.ts', 'core/core.ts'];
const originals = Object.fromEntries(files.map((f) => [f, readFileSync(join(srcDir, f), 'utf8')]));
/** 统一按 LF 处理，写回时还原原文件的换行风格。 */
const crlf = Object.fromEntries(files.map((f) => [f, originals[f].includes('\r\n')]));
const norm = Object.fromEntries(files.map((f) => [f, crlf[f] ? originals[f].replaceAll('\r\n', '\n') : originals[f]]));
const toEol = (f, text) => (crlf[f] ? text.replaceAll('\n', '\r\n') : text);

let failed = false;

/** 在 anchor 前插入 insert；marker 出现即视为已打过，跳过。 */
function insertBefore(f, marker, anchor, insert) {
  let c = norm[f];
  if (c.includes(marker)) {
    quiet(`  = ${f}：已打过，跳过`);
    return;
  }
  if (!c.includes(anchor)) {
    console.error(`  ✗ ${f}：锚点没找到：${JSON.stringify(anchor.slice(0, 50))}（宿主版本可能不匹配）`);
    failed = true;
    return;
  }
  norm[f] = c.replace(anchor, insert + anchor);
  quiet(`  + ${f}：已插入`);
}

/** 把 anchor 替换为 replacement；marker 出现即跳过。 */
function replaceOnce(f, marker, anchor, replacement) {
  let c = norm[f];
  if (c.includes(marker)) {
    quiet(`  = ${f}：已打过，跳过`);
    return;
  }
  if (!c.includes(anchor)) {
    console.error(`  ✗ ${f}：锚点没找到：${JSON.stringify(anchor.slice(0, 50))}（宿主版本可能不匹配）`);
    failed = true;
    return;
  }
  norm[f] = c.replace(anchor, replacement);
  quiet(`  + ${f}：已替换`);
}

// ── core/types.ts：类型 + WorldHost 可选方法 ─────────────────────────────
quiet('core/types.ts');
insertBefore(
  'core/types.ts',
  'export type ToolOutcomeTransform',
  '/** handler 抛错，或返回值既不是字符串也不是带字符串 text 的对象，Core 都转为失败回执。 */',
  `/**
 * 工具回执落库前的可选变换。所有已注册的变换按注册顺序串行执行，返回值替换回执；
 * 抛错或返回非法值时保留上一步的结果。用于把图片回执换成文本（例如本机 OCR），
 * 使原图不进入 session、不发给模型。
 */
export type ToolOutcomeTransform = (
  out: ToolOutcome,
  info: { tool: string; world?: string },
) => ToolOutcome | Promise<ToolOutcome>;

`,
);
insertBefore(
  'core/types.ts',
  'registerToolOutcomeTransform?(',
  `  /**
   * 解析 log:/mem: 句柄`,
  `  /**
   * 注册一个工具回执变换（在回执落库、发给模型之前执行），返回注销函数。
   * 未打这个 hook 的宿主没有这个方法，插件应做能力检测并降级。
   */
  registerToolOutcomeTransform?(fn: ToolOutcomeTransform): () => void;
`,
);

// ── core/loop.ts：import、变换集合、注册方法、toolResult 改造、两处调用点 ──
quiet('core/loop.ts');
replaceOnce(
  'core/loop.ts',
  '  ToolOutcome,\n  ToolOutcomeTransform,\n  ToolSchema,',
  '  ToolOutcome,\n  ToolSchema,',
  '  ToolOutcome,\n  ToolOutcomeTransform,\n  ToolSchema,',
);
insertBefore(
  'core/loop.ts',
  'private readonly toolOutcomeTransforms',
  '  private toolDefs: ToolDef[] = [];\n',
  `  /** 工具回执落库前的变换（插件注册；按注册顺序串行执行）。 */
  private readonly toolOutcomeTransforms = new Set<ToolOutcomeTransform>();
`,
);
replaceOnce(
  'core/loop.ts',
  'registerToolOutcomeTransform(fn: ToolOutcomeTransform): () => void {',
  `  /** 工具回执落库:附件内部化,每份的文本形态接在正文后。 */
  private toolResult(callId: string, out: ToolOutcome): ContextRecord {
    const blobs = this.d.blobs.intern(out.blobs);
    return functionResult(callId, withBlobLines(out.text, blobs), blobs ? { blobs } : {});
  }`,
  `  /** 注册工具回执变换；返回注销函数。插件在 start() 里注册，stop() 里注销。 */
  registerToolOutcomeTransform(fn: ToolOutcomeTransform): () => void {
    this.toolOutcomeTransforms.add(fn);
    return () => {
      this.toolOutcomeTransforms.delete(fn);
    };
  }

  /** 串行执行所有变换；单个变换抛错只记日志，保留上一步结果。 */
  private async transformToolOutcome(out: ToolOutcome, tool: string): Promise<ToolOutcome> {
    if (this.toolOutcomeTransforms.size === 0) return out;
    const world = this.d.toolOwner?.(tool);
    let cur = out;
    for (const fn of this.toolOutcomeTransforms) {
      try {
        const next = await fn(cur, world ? { tool, world } : { tool });
        if (next && typeof next.text === 'string') cur = next;
        else this.d.log.warn('工具回执变换返回非法值，忽略', { tool });
      } catch (e) {
        this.d.log.warn('工具回执变换异常', { tool, err: e instanceof Error ? e.message : String(e) });
      }
    }
    return cur;
  }

  /** 工具回执落库:先过插件变换（例如本机 OCR），再内部化附件。 */
  private async toolResult(callId: string, out: ToolOutcome, tool: string): Promise<ContextRecord> {
    const shaped = await this.transformToolOutcome(out, tool);
    const blobs = this.d.blobs.intern(shaped.blobs);
    return functionResult(callId, withBlobLines(shaped.text, blobs), blobs ? { blobs } : {});
  }`,
);
replaceOnce(
  'core/loop.ts',
  'results.push(await this.toolResult(call.call_id, out, call.name));',
  'results.push(this.toolResult(call.call_id, out));',
  'results.push(await this.toolResult(call.call_id, out, call.name));',
);
replaceOnce(
  'core/loop.ts',
  'session.append(await this.toolResult(call.call_id, out, call.name));',
  'session.append(this.toolResult(call.call_id, out));',
  'session.append(await this.toolResult(call.call_id, out, call.name));',
);

// ── core/core.ts：把注册方法挂进 World host ──────────────────────────────
quiet('core/core.ts');
insertBefore(
  'core/core.ts',
  'registerToolOutcomeTransform: (fn)',
  '      modelFacts: this.modelFacts(),\n',
  '      registerToolOutcomeTransform: (fn) => this.loop.registerToolOutcomeTransform(fn),\n',
);

if (failed) {
  // postinstall 场景（--silent）也退出 0：补丁打不上不该阻断安装，插件会退化成软约束，
  // 诊断面板/doctor 会明确报出「硬拦截未生效」。显式手动跑时不静音，让人看见错误。
  console.error('\n✗ 有锚点没匹配上，未写入任何文件。请确认宿主为 Coopanion 0.2.5（build/cortico/src）。');
  process.exit(silent ? 0 : 1);
}

// ── 写回（先备份） ───────────────────────────────────────────────────────
for (const f of files) {
  if (norm[f] === (crlf[f] ? originals[f].replaceAll('\r\n', '\n') : originals[f])) continue;
  const bak = join(srcDir, `${f}.bak-hookpatch`);
  if (!existsSync(bak)) copyFileSync(join(srcDir, f), bak);
  writeFileSync(join(srcDir, f), toEol(f, norm[f]));
  quiet(`  ✓ 写入 ${f}（备份：${f}.bak-hookpatch）`);
}
quiet('\n完成。重启 Coopanion 生效；卸载补丁：把三个 .bak-hookpatch 改回原文件名即可。');
