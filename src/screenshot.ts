/**
 * 截屏：零 npm 依赖，调用操作系统自带能力；自适应任意分辨率 / DPI / 宽高比。
 *  - 先用原生物理分辨率截取（DPI 感知，绝不用逻辑像素）。
 *  - 再等比缩放到 maxWidth × maxHeight 上限（只缩不放，保持宽高比不变形）。
 *  - 返回缩放后的 PNG base64，以及用于点击还原的「变换基准」(CaptureTransform)。
 *
 * 依赖 OS 能力：
 *  - macOS: screencapture -x（主屏）
 *  - Windows: PowerShell + .NET（System.Drawing）截指定屏并缩放
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fitToMax, type CaptureTransform } from './vision-space.ts';

const exec = promisify(execFile);

export interface CaptureResult extends CaptureTransform {
  base64: string; // 缩放后 PNG 的 base64（不含 data: 前缀）
}

export async function captureScreenshot(opts: {
  maxWidth: number;
  maxHeight: number;
  monitor?: number; // 0-based 屏序号；undefined => 主屏
}): Promise<CaptureResult> {
  const platform = process.platform;

  if (platform === 'darwin') {
    const out = join(tmpdir(), `lv-${Date.now()}.png`);
    await exec('screencapture', ['-x', out]);
    const raw = await readFile(out);
    const nativeWidth = raw.readUInt32BE(16); // PNG IHDR 宽（大端）
    const nativeHeight = raw.readUInt32BE(20);
    const { scale, scaledWidth, scaledHeight } = fitToMax(
      nativeWidth,
      nativeHeight,
      opts.maxWidth,
      opts.maxHeight
    );
    if (scale < 1) {
      // sips -z 参数为 <height> <width>
      await exec('sips', ['-z', String(scaledHeight), String(scaledWidth), out]);
    }
    const buf = await readFile(out);
    return {
      base64: buf.toString('base64'),
      nativeWidth,
      nativeHeight,
      scaledWidth: scale < 1 ? scaledWidth : nativeWidth,
      scaledHeight: scale < 1 ? scaledHeight : nativeHeight,
      scale,
      monitor: 'primary',
      capturedAt: Date.now(),
    };
  }

  if (platform === 'win32') {
    const out = join(tmpdir(), `lv-${Date.now()}.png`);
    const dimFile = join(tmpdir(), `lv-dim-${Date.now()}.json`);
    const ps = buildWindowsCapturePs(out, dimFile, opts.monitor ?? -1, opts.maxWidth, opts.maxHeight);
    await exec('powershell', ['-NoProfile', '-Command', ps]);
    const dim = JSON.parse(await readFile(dimFile, 'utf8')) as {
      nw: number;
      nh: number;
      sw: number;
      sh: number;
      scale: number;
      monitor: string;
    };
    const buf = await readFile(out);
    return {
      base64: buf.toString('base64'),
      nativeWidth: dim.nw,
      nativeHeight: dim.nh,
      scaledWidth: dim.sw,
      scaledHeight: dim.sh,
      scale: dim.scale,
      monitor: dim.monitor,
      capturedAt: Date.now(),
    };
  }

  throw new Error(`localvision: 不支持的平台 ${platform}（仅支持 win32 / darwin）`);
}

/** Windows：DPI 感知截屏 + 等比缩放到上限，并把尺寸写进 dimFile。 */
function buildWindowsCapturePs(
  out: string,
  dimFile: string,
  monitorIdx: number,
  maxW: number,
  maxH: number
): string {
  const o = out.replace(/\\/g, '\\\\').replace(/'/g, "''");
  const d = dimFile.replace(/\\/g, '\\\\').replace(/'/g, "''");
  return [
    '$ErrorActionPreference="Stop"',
    'try { [System.Windows.Forms.Application]::SetHighDpiMode("PerMonitorV2") | Out-Null } catch {}',
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
    '$screens=[System.Windows.Forms.Screen]::AllScreens',
    `$scr = if ((${monitorIdx} -ge 0) -and (${monitorIdx} -lt $screens.Length)) { $screens[${monitorIdx}] } else { [System.Windows.Forms.Screen]::PrimaryScreen }`,
    '$b=$scr.Bounds',
    '$bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height)',
    '$g=[System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$bmp.Size)',
    `$scale=[Math]::Min(${maxW}/$b.Width,${maxH}/$b.Height,1)`,
    '$sw=$b.Width; $sh=$b.Height',
    'if($scale -lt 1){',
    '  $sw=[int][Math]::Round($b.Width*$scale); $sh=[int][Math]::Round($b.Height*$scale);',
    '  $b2=New-Object System.Drawing.Bitmap($sw,$sh);',
    '  $g2=[System.Drawing.Graphics]::FromImage($b2);',
    '  $g2.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;',
    '  $g2.DrawImage($bmp,0,0,$sw,$sh);',
    '  $g.Dispose(); $bmp.Dispose(); $bmp=$b2; $g=$g2',
    '}',
    `$bmp.Save('${o}')`,
    '$g.Dispose(); $bmp.Dispose()',
    `$mon=$scr.DeviceName`,
    `"{""nw"":$($b.Width),""nh"":$($b.Height),""sw"":$sw,""sh"":$sh,""scale"":$scale,""monitor"":$mon}" | Out-File -Encoding ascii '${d}'`,
  ].join('\n');
}
