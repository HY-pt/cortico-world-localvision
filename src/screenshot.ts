/**
 * 截屏：零 npm 依赖，调用操作系统自带能力；自适应任意分辨率 / DPI / 宽高比。
 *  - 先用原生物理分辨率截取（DPI 感知，绝不用逻辑像素）。
 *  - 再等比缩放到 maxWidth × maxHeight 上限（只缩不放，保持宽高比不变形）。
 *  - 支持 region（原生物理像素子矩形）裁剪：用于「两级截图」的节约模式，
 *    只截目标附近一小块，显著降低传给识别引擎的数据量。
 *  - 返回缩放后的 PNG base64，以及用于点击还原的「变换基准」(CaptureTransform)。
 *
 * 依赖 OS 能力：
 *  - macOS: screencapture -x（-R 支持裁剪）
 *  - Windows: PowerShell + .NET（System.Drawing）截指定屏/矩形并缩放
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fitToMax, type CaptureTransform } from './vision-space.ts';

const exec = promisify(execFile);

/**
 * 本会话（本次进程）自己创建的截屏临时文件。清理「上一轮残留」时必须跳过它们——
 * World 可能在同一个进程里重载（禁用再启用），误伤在飞的截图会让当次识别直接失败。
 */
const ownShots = new Set<string>();

/** 删掉截屏临时文件；失败无所谓（只是 tmp 残留），绝不能影响主流程。 */
async function cleanupTemp(...paths: string[]): Promise<void> {
  await Promise.all(paths.map((p) => rm(p, { force: true }).catch(() => {})));
}

export interface CaptureResult extends CaptureTransform {
  base64: string; // 缩放后 PNG 的 base64（不含 data: 前缀）
}

export interface CaptureOpts {
  maxWidth: number;
  maxHeight: number;
  monitor?: number; // 0-based 屏序号；undefined => 主屏
  region?: { x: number; y: number; w: number; h: number }; // 原生物理像素裁剪区（可选）
}

export async function captureScreenshot(opts: CaptureOpts): Promise<CaptureResult> {
  const platform = process.platform;
  if (platform === 'darwin') return captureMac(opts);
  if (platform === 'win32') return captureWin(opts);
  if (platform === 'linux') return captureLinux(opts);
  throw new Error(`localvision: 不支持的平台 ${platform}（仅支持 win32 / darwin / linux）`);
}

async function captureMac(opts: CaptureOpts): Promise<CaptureResult> {
  const out = join(tmpdir(), `lv-${Date.now()}.png`);
  ownShots.add(out);
  try {
    // 主屏全尺寸（用于 region 坐标与还原基准）
    const boundsRaw = (
      await exec('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop'])
        .then((r) => r.stdout)
        .catch(() => '0 0 1920 1080')
    ).trim();
    const parts = boundsRaw.split(/\s+/).map(Number);
    const fw = parts[2] || 1920;
    const fh = parts[3] || 1080;

    let rx = 0;
    let ry = 0;
    let rw = fw;
    let rh = fh;
    if (opts.region) {
      rx = Math.max(0, Math.min(opts.region.x, fw - 1));
      ry = Math.max(0, Math.min(opts.region.y, fh - 1));
      rw = Math.max(1, Math.min(opts.region.w, fw - rx));
      rh = Math.max(1, Math.min(opts.region.h, fh - ry));
    }

    await exec('screencapture', ['-x', '-R', `${rx},${ry},${rw},${rh}`, out]);
    const raw = await readFile(out);
    const iw = raw.readUInt32BE(16); // PNG IHDR 宽（大端）
    const ih = raw.readUInt32BE(20);
    const { scale, scaledWidth, scaledHeight } = fitToMax(iw, ih, opts.maxWidth, opts.maxHeight);
    if (scale < 1) {
      // sips -z 参数为 <height> <width>
      await exec('sips', ['-z', String(scaledHeight), String(scaledWidth), out]);
    }
    const buf = await readFile(out);
    return {
      base64: buf.toString('base64'),
      nativeWidth: fw,
      nativeHeight: fh,
      regionX: rx,
      regionY: ry,
      regionW: rw,
      regionH: rh,
      scaledWidth: scale < 1 ? scaledWidth : rw,
      scaledHeight: scale < 1 ? scaledHeight : rh,
      scale,
      monitor: 'primary',
      capturedAt: Date.now(),
    };
  } finally {
    await cleanupTemp(out);
    ownShots.delete(out);
  }
}

async function captureWin(opts: CaptureOpts): Promise<CaptureResult> {
  const out = join(tmpdir(), `lv-${Date.now()}.png`);
  const dimFile = join(tmpdir(), `lv-dim-${Date.now()}.json`);
  ownShots.add(out);
  ownShots.add(dimFile);
  try {
    const ps = buildWindowsCapturePs(
      out,
      dimFile,
      opts.monitor ?? -1,
      opts.maxWidth,
      opts.maxHeight,
      opts.region
    );
    await exec('powershell', ['-NoProfile', '-Command', ps]);
    const dim = JSON.parse(await readFile(dimFile, 'utf8')) as Omit<CaptureResult, 'base64' | 'capturedAt'>;
    const buf = await readFile(out);
    return { base64: buf.toString('base64'), ...dim, capturedAt: Date.now() };
  } finally {
    await cleanupTemp(out, dimFile);
    ownShots.delete(out);
    ownShots.delete(dimFile);
  }
}

/**
 * Linux 截图：零 npm 依赖，调用系统自带截图工具。
 *  - Wayland（grim）：全屏 `grim out.png`，局部 `grim -g "x,y WxH" out.png`。
 *  - X11：优先 ImageMagick（import 可一步全屏/裁切），其次 maim（`-g` 几何），再次 scrot（仅全屏，
 *    局部会退化为全屏——坐标换算以全屏为准）。
 * 探测不到任何工具时抛错，提示用户安装。先全屏截一张拿原生分辨率（region 坐标与
 * nativeWidth/Height 基准都要），需要局部再截对应矩形；等比缩放到上限走 ImageMagick `convert`。
 */
interface LinuxTools {
  wayland: boolean;
  /** 全屏捕获（原生分辨率，不缩放）。 */
  full: (out: string) => Promise<void>;
  /** 局部捕获（原生分辨率，不缩放）。supportsRegion=false 时调用方应退化为全屏。 */
  region: (out: string, x: number, y: number, w: number, h: number) => Promise<void>;
  supportsRegion: boolean;
  /** 等比缩放到指定像素（仅在本机有 ImageMagick 时存在）。 */
  resize?: (out: string, w: number, h: number) => Promise<void>;
}

let cachedLinuxTools: LinuxTools | null = null;

async function detectLinuxTools(): Promise<LinuxTools> {
  if (cachedLinuxTools) return cachedLinuxTools;
  const wayland = !!(process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland');
  const has = async (cmd: string): Promise<boolean> => {
    try {
      const r = await exec('sh', ['-c', `command -v ${cmd}`]);
      return (r.stdout || '').trim().length > 0;
    } catch {
      return false;
    }
  };
  const convertBin = (await has('convert')) ? 'convert' : (await has('magick')) ? 'magick' : null;
  const resize = convertBin
    ? async (out: string, w: number, h: number) => {
        await exec(convertBin, [out, '-resize', `${w}x${h}`, out]);
      }
    : undefined;

  let tools: LinuxTools;
  if (wayland) {
    if (!(await has('grim'))) {
      throw new Error('localvision: Linux(Wayland) 需要 grim 截图工具，请先安装（如 sudo apt install grim）');
    }
    tools = {
      wayland: true,
      full: async (out) => {
        await exec('grim', [out]);
      },
      region: async (out, x, y, w, h) => {
        await exec('grim', ['-g', `${x},${y} ${w}x${h}`, out]);
      },
      supportsRegion: true,
      resize,
    };
  } else {
    if (await has('import')) {
      tools = {
        wayland: false,
        full: async (out) => {
          await exec('import', ['-window', 'root', out]);
        },
        region: async (out, x, y, w, h) => {
          await exec('import', ['-window', 'root', '-crop', `${w}x${h}+${x}+${y}`, out]);
        },
        supportsRegion: true,
        resize,
      };
    } else if (await has('maim')) {
      tools = {
        wayland: false,
        full: async (out) => {
          await exec('maim', [out]);
        },
        region: async (out, x, y, w, h) => {
          await exec('maim', ['-g', `${w}x${h}+${x}+${y}`, out]);
        },
        supportsRegion: true,
        resize,
      };
    } else if (await has('scrot')) {
      // scrot 不支持非交互式矩形裁切，局部退化为全屏（坐标以全屏为准）。
      tools = {
        wayland: false,
        full: async (out) => {
          await exec('scrot', ['-o', out]);
        },
        region: async (out) => {
          await exec('scrot', ['-o', out]);
        },
        supportsRegion: false,
        resize,
      };
    } else {
      throw new Error(
        'localvision: Linux(X11) 未找到截图工具，请安装其一：ImageMagick(imagemagick) / maim / scrot',
      );
    }
  }
  cachedLinuxTools = tools;
  return tools;
}

async function captureLinux(opts: CaptureOpts): Promise<CaptureResult> {
  const out = join(tmpdir(), `lv-${Date.now()}.png`);
  ownShots.add(out);
  try {
    const tools = await detectLinuxTools();

    // 1) 先全屏截一张拿原生分辨率（DPI 感知）。
    await tools.full(out);
    const fullBuf = await readFile(out);
    const fw = fullBuf.readUInt32BE(16); // PNG IHDR 宽（大端）
    const fh = fullBuf.readUInt32BE(20);

    let rx = 0;
    let ry = 0;
    let rw = fw;
    let rh = fh;
    if (opts.region && tools.supportsRegion) {
      rx = Math.max(0, Math.min(Math.round(opts.region.x), fw - 1));
      ry = Math.max(0, Math.min(Math.round(opts.region.y), fh - 1));
      rw = Math.max(1, Math.min(Math.round(opts.region.w), fw - rx));
      rh = Math.max(1, Math.min(Math.round(opts.region.h), fh - ry));
      await tools.region(out, rx, ry, rw, rh);
    }

    const raw = await readFile(out);
    const iw = raw.readUInt32BE(16);
    const ih = raw.readUInt32BE(20);
    const { scale: fitScale, scaledWidth: outW, scaledHeight: outH } = fitToMax(iw, ih, opts.maxWidth, opts.maxHeight);
    let finalW = iw;
    let finalH = ih;
    if (fitScale < 1 && tools.resize) {
      await tools.resize(out, outW, outH);
      finalW = outW;
      finalH = outH;
    }
    const buf = await readFile(out);
    return {
      base64: buf.toString('base64'),
      nativeWidth: fw,
      nativeHeight: fh,
      regionX: rx,
      regionY: ry,
      regionW: rw,
      regionH: rh,
      // 无 resize 工具时按原图尺寸上报（tesseract 自行缩放，坐标仍用 regionW/scaledWidth 还原，不影响定位）。
      scaledWidth: finalW,
      scaledHeight: finalH,
      // scale 与 scaledWidth 自洽：实际缩放过 = fitScale（<1），没缩放 = 1（nativeWidth*scale === scaledWidth 恒成立）。
      scale: finalW < iw ? fitScale : 1,
      monitor: 'primary',
      capturedAt: Date.now(),
    };
  } finally {
    await cleanupTemp(out);
    ownShots.delete(out);
  }
}

/**
 * 清掉「上一轮运行」遗留的截屏临时文件——截图缓存的生命周期就是一次 Coopanion 运行：
 * 截图都是用完即删的临时文件，跨重启没有保留价值（画面早就变了），而 Coopanion 把
 * TMPDIR 指到 data/tmp、系统重启不会清，所以每次 World 启动（= Coopanion 启动或
 * 重载）时把上一轮的残留全部清掉，重启即清空。只删 lv- 前缀、且不属本会话的文件：
 * 误伤不了别人的临时文件，也误伤不了正在进行的截图。返回删除个数。
 */
export async function clearPreviousShots(): Promise<number> {
  let names: string[];
  try {
    names = await readdir(tmpdir());
  } catch {
    return 0;
  }
  const stale = names.filter((n) => /^lv-(dim-)?\d{10,}\.(png|json)$/.test(n) && !ownShots.has(join(tmpdir(), n)));
  await Promise.all(stale.map((n) => rm(join(tmpdir(), n), { force: true }).catch(() => {})));
  return stale.length;
}

/** Windows：DPI 感知截屏 + 可选矩形裁剪 + 等比缩放到上限，并把尺寸写进 dimFile。 */
function buildWindowsCapturePs(
  out: string,
  dimFile: string,
  monitorIdx: number,
  maxW: number,
  maxH: number,
  region?: { x: number; y: number; w: number; h: number }
): string {
  const o = out.replace(/\\/g, '\\\\').replace(/'/g, "''");
  const d = dimFile.replace(/\\/g, '\\\\').replace(/'/g, "''");
  // region 直接传四个数字，避免把 JSON 当 PowerShell 表达式解析
  const rx = region ? Math.max(0, Math.round(region.x)) : 0;
  const ry = region ? Math.max(0, Math.round(region.y)) : 0;
  const rw = region ? Math.max(0, Math.round(region.w)) : 0;
  const rh = region ? Math.max(0, Math.round(region.h)) : 0;
  return [
    '$ErrorActionPreference="Stop"',
    // 先声明 DPI 感知，否则 Screen.Bounds 给的是逻辑尺寸（125% 下 1920×1080 会读成 1536×864）
    'try {',
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class LvDpi {',
    '  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);',
    '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
    '}',
    '"@',
    '} catch {}',
    '$dpiOk=$false',
    'try { $dpiOk=[LvDpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) } catch {}',
    'if(-not $dpiOk){ try { [LvDpi]::SetProcessDPIAware() | Out-Null } catch {} }',
    'try { [System.Windows.Forms.Application]::SetHighDpiMode("PerMonitorV2") | Out-Null } catch {}',
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
    '$screens=[System.Windows.Forms.Screen]::AllScreens',
    `$scr = if ((${monitorIdx} -ge 0) -and (${monitorIdx} -lt $screens.Length)) { $screens[${monitorIdx}] } else { [System.Windows.Forms.Screen]::PrimaryScreen }`,
    '$b=$scr.Bounds',
    `$fw=$b.Width; $fh=$b.Height`,
    `$regX=${rx}; $regY=${ry}; $regW=${rw}; $regH=${rh}`,
    'if($regW -gt 0 -and $regH -gt 0){',
    '  $rx=[Math]::Max(0,[int]$regX); $ry=[Math]::Max(0,[int]$regY)',
    '  $rw=[Math]::Min([int]$regW, $fw-$rx); $rh=[Math]::Min([int]$regH, $fh-$ry)',
    '  if($rw -le 0){$rw=$fw}; if($rh -le 0){$rh=$fh}',
    '} else { $rx=0; $ry=0; $rw=$fw; $rh=$fh }',
    '$bmp=New-Object System.Drawing.Bitmap($rw,$rh)',
    '$g=[System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($rx,$ry,0,0,$bmp.Size)',
    `$scale=[Math]::Min([Math]::Min(${maxW}/$rw,${maxH}/$rh),1)`,
    '$sw=$rw; $sh=$rh',
    'if($scale -lt 1){',
    '  $sw=[int][Math]::Round($rw*$scale); $sh=[int][Math]::Round($rh*$scale);',
    '  $b2=New-Object System.Drawing.Bitmap($sw,$sh);',
    '  $g2=[System.Drawing.Graphics]::FromImage($b2);',
    '  $g2.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;',
    '  $g2.DrawImage($bmp,0,0,$sw,$sh);',
    '  $g.Dispose(); $bmp.Dispose(); $bmp=$b2; $g=$g2',
    '}',
    `$bmp.Save('${o}')`,
    '$g.Dispose(); $bmp.Dispose()',
    `$mon=$scr.DeviceName.Replace("\\","/")`,
    '$scaleInv=$scale.ToString([System.Globalization.CultureInfo]::InvariantCulture)',
    `"{""nativeWidth"":$fw,""nativeHeight"":$fh,""regionX"":$rx,""regionY"":$ry,""regionW"":$rw,""regionH"":$rh,""scaledWidth"":$sw,""scaledHeight"":$sh,""scale"":$scaleInv,""monitor"":""$mon""}" | Out-File -Encoding ascii '${d}'`,
  ].join('\n');
}
