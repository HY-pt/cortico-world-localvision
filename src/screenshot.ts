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
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fitToMax, type CaptureTransform } from './vision-space.ts';

const exec = promisify(execFile);

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
  throw new Error(`localvision: 不支持的平台 ${platform}（仅支持 win32 / darwin）`);
}

async function captureMac(opts: CaptureOpts): Promise<CaptureResult> {
  const out = join(tmpdir(), `lv-${Date.now()}.png`);
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
}

async function captureWin(opts: CaptureOpts): Promise<CaptureResult> {
  const out = join(tmpdir(), `lv-${Date.now()}.png`);
  const dimFile = join(tmpdir(), `lv-dim-${Date.now()}.json`);
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
