/**
 * 视频抽帧：调用系统 ffmpeg，把「有变化的帧」抽成 JPEG 交给本机 OCR。
 *
 * 设计取舍（与项目一贯的省 token / 零依赖哲学一致）：
 *  - **不引入 npm 解码库**：视频解码交给 ffmpeg，Node 侧只读 JPEG 文件再喂给 tesseract.js。
 *    ffmpeg 是可选外部依赖，没装时给出安装指引而不是静默失败。
 *  - **变化检测在 ffmpeg 里做**（`select='gt(scene,X)'`）：Node 侧没有像素级比较能力
 *    （只有 PNG/JPEG 头解析），自己比帧要么引入图像库、要么白跑 OCR；交给滤镜最省。
 *  - **时间戳从 showinfo 的 pts_time 读**：抽出来的帧序号没有时间信息，只有 pts_time
 *    能对上「第几秒」，时间线才有意义。解析不到时退化成「未知时刻」而不是报错。
 *  - **画面几乎不变的录屏**（静态演示、文档录制）scene 检测会一帧都选不出来，
 *    此时自动回退到「固定间隔抽帧」，保证至少有内容返回。
 *
 *  - **定位 ffmpeg 不能只信 PATH**：winget 装完在 PATH 里留的是 0 字节 app execution alias，
 *    交互式 shell 能执行、Node 的 spawnSync 却报 ENOEXEC——只 spawn 'ffmpeg' 会把「装好了」
 *    误判成没装。因此先试 PATH，再回退到 winget 包目录与各平台常见安装路径里的真实 exe。
 *
 * 安全：一律用 spawnSync 传参数数组，不拼 shell 字符串——视频路径带空格、中文、引号都不会被解释。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface VideoFrame {
  /** 帧在视频中的秒数（浮点）；解析不到时为 null（时间线显示「时刻未知」）。 */
  timeSec: number | null;
  /** 帧 JPEG 文件的绝对路径；由调用方在用完后连目录一起删掉。 */
  path: string;
}

export interface VideoMeta {
  /** 视频时长（秒）；探测不到时为 null。 */
  durationSec: number | null;
  width: number;
  height: number;
}

/** 抽帧结果：mode 记录实际走的策略，写进返回文本让用户知道发生了什么。 */
export interface ExtractResult {
  frames: VideoFrame[];
  mode: 'scene' | 'interval';
  /** ffmpeg 的原始输出（截断），排错用。 */
  log: string;
  /**
   * 场景检测执行失败的原因（回退到固定间隔时带上）。
   * 必须暴露出来：静默降级会让「select 表达式语法错」看起来像「画面没变化」，极难排查。
   */
  sceneError?: string;
}

export interface ExtractOptions {
  /** 场景变化阈值 0–1，越小越敏感（抽到的帧越多）。 */
  scene: number;
  /** 回退模式下的抽帧间隔（秒），也是 scene 模式的最小间隔提示。 */
  intervalSec: number;
  /** 帧宽上限（缩小后 OCR 更快，且省视觉 token）。 */
  maxWidth: number;
  /** 最多保留多少帧（超出均匀抽稀）；不含本上限内的删减。 */
  maxFrames: number;
  /** 片段起点（秒）；省略从头。 */
  fromSec?: number;
  /** 片段终点（秒）；省略到尾。 */
  toSec?: number;
  /** ffmpeg 最长允许跑多久（毫秒）。 */
  timeoutMs?: number;
}

/**
 * ffmpeg 可执行文件的解析结果缓存：null = 没找到，字符串 = 能跑的那个命令/路径。
 * 三态（undefined 未探测 / null 没有 / string 有）避免每次调用都 spawn 一串候选。
 */
let ffmpegBin: string | null | undefined;

/** 试跑一次 `-version`：能返回 0 就是可用（0 字节的 alias 会 error，自动跳过）。 */
function canRun(cmd: string): boolean {
  const r = spawnSync(cmd, ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
  return !r.error && r.status === 0;
}

/**
 * winget 装完 ffmpeg 后，PATH 里的 `WinGet\Links\ffmpeg.exe` 是 **0 字节的 app execution alias**：
 * 交互式 shell 能执行它，Node 的 spawnSync 却会失败（ENOEXEC）——直接 spawn 'ffmpeg' 会误判成「没装」。
 * 所以探测失败时要退回包目录里那个真实 exe。
 */
function wingetCandidates(): string[] {
  const base = process.env.LOCALAPPDATA || process.env.USERPROFILE || '';
  if (!base) return [];
  const pkgs = join(base, 'Microsoft', 'WinGet', 'Packages');
  let dirs: string[] = [];
  try {
    dirs = readdirSync(pkgs).filter((d) => /^Gyan\.FFmpeg/i.test(d));
  } catch {
    return [];
  }
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const out: string[] = [];
  for (const d of dirs) {
    const root = join(pkgs, d);
    // 包内是 ffmpeg-<版本>-full_build 一层目录，真实 exe 在它的 bin 下
    let subs: string[] = [];
    try {
      subs = readdirSync(root);
    } catch {
      continue;
    }
    for (const s of subs) {
      const p = join(root, s, 'bin', exe);
      if (existsSync(p)) out.push(p);
    }
    const direct = join(root, 'bin', exe);
    if (existsSync(direct)) out.push(direct);
  }
  // 目录名带版本号，降序取最新的那个先试。
  return out.sort().reverse();
}

/** 各平台常见安装位置（PATH 之外、手动解压或包管理器的固定路径）。 */
function platformCandidates(): string[] {
  switch (process.platform) {
    case 'win32':
      return [
        ...wingetCandidates(),
        'C:\\ffmpeg\\bin\\ffmpeg.exe',
        'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
        'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
      ];
    case 'darwin':
      return ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/local/bin/ffmpeg'];
    default:
      return ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/snap/bin/ffmpeg'];
  }
}

/**
 * 找出能用的 ffmpeg 命令（PATH 优先，失败再按平台找固定位置）。
 * 结果缓存：envPrompt 每次渲染都会问一次，不能每次都 spawn 一串候选。
 */
export function resolveFfmpeg(): string | null {
  if (ffmpegBin !== undefined) return ffmpegBin;
  for (const c of ['ffmpeg', ...platformCandidates()]) {
    if (canRun(c)) {
      ffmpegBin = c;
      return c;
    }
  }
  ffmpegBin = null;
  return null;
}

/** ffmpeg 没装时的安装提示（按平台给一条可直接复制的命令）。 */
export function ffmpegInstallHint(): string {
  switch (process.platform) {
    case 'win32':
      return 'Windows：winget install Gyan.FFmpeg（或 scoop install ffmpeg），装完重启 Coopanion 让 PATH 生效';
    case 'darwin':
      return 'macOS：brew install ffmpeg';
    default:
      return 'Linux：sudo apt install ffmpeg（或 sudo dnf install ffmpeg / sudo pacman -S ffmpeg）';
  }
}

/** ffmpeg 是否可用（含 PATH 之外的常见安装位置）。 */
export function ffmpegAvailable(): boolean {
  return resolveFfmpeg() !== null;
}

/** 解析 `00:02:31.40` 形式的时长为秒。 */
function parseDuration(text: string): number | null {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** 解析 `Video: h264 ... 1920x1080` 里的分辨率。 */
function parseSize(text: string): { width: number; height: number } {
  const m = /Video:.*?,\s*(\d{2,5})x(\d{2,5})/s.exec(text);
  if (!m) return { width: 0, height: 0 };
  return { width: Number(m[1]), height: Number(m[2]) };
}

/**
 * 读视频元信息（时长 / 分辨率）。
 * 用 `ffmpeg -i` 而不是 ffprobe：只装了 ffmpeg 没装 ffprobe 的机器也能用
 * （无输出文件时 ffmpeg 会报错退出，但 stderr 里已经带了完整流信息）。
 */
export function probeVideo(file: string, timeoutMs = 15000): VideoMeta {
  const bin = resolveFfmpeg();
  if (!bin) return { durationSec: null, width: 0, height: 0 };
  const r = spawnSync(bin, ['-hide_banner', '-i', file], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const size = parseSize(text);
  return { durationSec: parseDuration(text), width: size.width, height: size.height };
}

/** 建一个本次抽帧专用的临时目录（用完由调用方删）。 */
export async function makeFrameDir(tag: string): Promise<string> {
  const dir = join(tmpdir(), `localvision-watch-${tag}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** 递归删临时目录；失败无所谓（只是 tmp 残留），绝不能影响主流程。 */
export async function removeFrameDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** 从 showinfo 的日志行里按顺序取出 pts_time（第 k 个对应第 k 个输出帧）。 */
function parsePtsTimes(log: string): number[] {
  const times: number[] = [];
  for (const m of log.matchAll(/pts_time:(\d+(?:\.\d+)?)/g)) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) times.push(v);
  }
  return times;
}

/** 片段参数：`-ss` 放输入前（快速 seek），`-t` 放输出（时长）。 */
function seekArgs(fromSec?: number, toSec?: number): string[] {
  const args: string[] = [];
  if (typeof fromSec === 'number' && fromSec > 0) args.push('-ss', String(fromSec));
  if (typeof toSec === 'number' && fromSec !== undefined && toSec > fromSec) {
    args.push('-t', String(toSec - (typeof fromSec === 'number' ? fromSec : 0)));
  } else if (typeof toSec === 'number' && toSec > 0 && fromSec === undefined) {
    args.push('-t', String(toSec));
  }
  return args;
}

/** 缩放滤镜：只限宽（-2 让高按比例取偶数，ffmpeg 要求某些编码器宽高为偶）。 */
function scaleFilter(maxWidth: number): string {
  return `scale='min(${Math.max(160, Math.round(maxWidth))},iw)':-2`;
}

/**
 * 主入口：抽「有变化的帧」。
 * 先按场景变化阈值抽；一帧都没抽到（画面几乎不变的录屏）时自动回退到固定间隔。
 */
export async function extractFrames(file: string, dir: string, opts: ExtractOptions): Promise<ExtractResult> {
  const timeout = opts.timeoutMs && opts.timeoutMs > 1000 ? opts.timeoutMs : 120000;

  // 1) 场景变化模式：showinfo 的 pts_time 是唯一可靠的时间来源。
  // 内层单引号不能省：filtergraph 把裸逗号当滤镜分隔符，`select=gt(scene,0.3)` 会被拆成
  // 两个滤镜并报「No such filter: '0.3)'」，结果一帧都选不出来（还误以为画面没变化）。
  const scene = runFfmpeg(file, dir, [`select='gt(scene,${opts.scene})'`, scaleFilter(opts.maxWidth), 'showinfo'].join(','), seekArgs(opts.fromSec, opts.toSec), timeout);
  const sceneTimes = parsePtsTimes(scene.log);
  let frames = await collectFrames(dir);
  if (frames.length) {
    frames = frames.map((f, i) => ({ ...f, timeSec: sceneTimes[i] ?? null }));
  }

  // 2) 回退：画面几乎不变（静态演示、文档录制）时 scene 检测会选出 0 帧，改按固定间隔抽。
  if (!frames.length) {
    await clearDir(dir);
    const interval = runFfmpeg(file, dir, [`fps=1/${Math.max(0.1, opts.intervalSec)}`, scaleFilter(opts.maxWidth)].join(','), seekArgs(opts.fromSec, opts.toSec), timeout);
    const base = typeof opts.fromSec === 'number' && opts.fromSec > 0 ? opts.fromSec : 0;
    frames = (await collectFrames(dir)).map((f, i) => ({ ...f, timeSec: base + i * Math.max(0.1, opts.intervalSec) }));
    frames = await thin(frames, opts.maxFrames, dir);
    // ffmpeg 真的报错（而不是画面没变化）时把原因带上，别让上层把「语法错」当成「无变化」。
    const err = scene.ok ? '' : lastErrorLine(scene.log);
    return { frames, mode: 'interval', log: interval.log, ...(err ? { sceneError: err } : {}) };
  }

  frames = await thin(frames, opts.maxFrames, dir);
  return { frames, mode: 'scene', log: scene.log };
}

/**
 * 跑一次 ffmpeg 抽帧（输出到 dir 下 f%06d.jpg）。
 *
 * 「不复制也不丢帧」这个开关改过名：ffmpeg ≥5.1 叫 `-fps_mode passthrough`，
 * 旧版（≤6.x）只认 `-vsync 0`，ffmpeg 9 又把 `-vsync` 删了。逐个试、用第一个能跑通的，
 * 保证新旧版本都能用；必须显式指定，否则默认的 cfr 会为维持帧率复制帧，
 * 让 showinfo 的顺序和文件序号对不上。
 */
function runFfmpeg(
  file: string,
  dir: string,
  filter: string,
  seek: string[],
  timeout: number,
): { log: string; ok: boolean } {
  const out = join(dir, `f%06d.jpg`);
  const head = [
    '-hide_banner',
    '-nostdin',
    ...seek,
    '-i', file,
    '-an', '-sn', // 不要音频/字幕流
    '-vf', filter,
  ];
  const tail = ['-q:v', '3', '-f', 'image2', out];
  let log = '';
  for (const mode of [['-fps_mode', 'passthrough'], ['-vsync', '0'], []]) {
    const r = spawnSync(resolveFfmpeg() ?? 'ffmpeg', [...head, ...mode, ...tail], {
      encoding: 'utf8',
      windowsHide: true,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
    });
    log = `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-4000);
    if (r.status === 0) return { log, ok: true };
  }
  // 三种写法都不行：把最后一次的错误交给上层，用户能在返回文本里看到 ffmpeg 到底说了什么。
  return { log, ok: false };
}

/**
 * 从 ffmpeg 日志里挑「真正出错」的那一行；判断不了就返回 ''。
 *
 * 关键区分：场景检测一帧都没选出来时，ffmpeg 也会以非 0 退出并输出 `Conversion failed!`
 * （输出流没有帧）——那是「画面没变化」的正常结果，不是故障。只有滤镜语法 / 配置类错误
 * 才值得报给用户，否则每次看静态录屏都会冒出一句吓人的「检测不可用」。
 */
function lastErrorLine(log: string): string {
  const fatal = /No such filter|Unrecognized|Option not found|Error opening output|Error while filtering|Failed to configure|Invalid filtergraph|Error initializing|Error parsing|Filter not found/i;
  // `[组件 @ 0x地址]` 开头的是 ffmpeg 内部组件日志（编码器线程终止等），是症状不是原因，先排除。
  const internal = /^\[[^\]]*@ 0x[0-9a-f]+\]/i;
  const lines = log
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !internal.test(l));
  const hit = [...lines].reverse().find((l) => fatal.test(l));
  return hit ? hit.slice(0, 160) : '';
}

/** 读目录里的帧文件，按文件名排序（f000001.jpg …）。 */
async function collectFrames(dir: string): Promise<VideoFrame[]> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => /^f\d+\.jpg$/.test(n)).sort();
  return names.map((n) => ({ timeSec: null, path: join(dir, n) }));
}

/** 清空目录里的旧帧（回退重抽前用）。 */
async function clearDir(dir: string): Promise<void> {
  const files = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(files.map((f) => rm(join(dir, f), { force: true }).catch(() => {})));
}

/**
 * 均匀抽稀到 limit 帧（保留首帧与末帧），多出来的文件直接删掉——
 * OCR 一帧约 1.8s，长视频必须限帧，否则一次调用能跑几分钟。
 */
async function thin(frames: VideoFrame[], limit: number, dir: string): Promise<VideoFrame[]> {
  if (limit <= 0 || frames.length <= limit) return frames;
  if (limit === 1) {
    await drop(frames.slice(1), dir);
    return frames.slice(0, 1);
  }
  const picked: VideoFrame[] = [];
  const keep = new Set<number>();
  const step = (frames.length - 1) / (limit - 1);
  for (let i = 0; i < limit; i++) keep.add(Math.round(i * step));
  for (let i = 0; i < frames.length; i++) {
    if (keep.has(i)) picked.push(frames[i]);
  }
  const keptPaths = new Set(picked.map((f) => f.path));
  await drop(frames.filter((f) => !keptPaths.has(f.path)), dir);
  return picked;
}

/** 删掉被抽稀掉的帧文件。 */
async function drop(frames: VideoFrame[], dir: string): Promise<void> {
  await Promise.all(frames.map((f) => rm(join(dir, f.path), { force: true }).catch(() => {})));
}
