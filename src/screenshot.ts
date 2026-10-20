/**
 * 截屏：零 npm 依赖，调用操作系统自带能力。
 * - macOS: screencapture
 * - Windows: PowerShell + .NET（System.Drawing）截主屏存 PNG
 * 返回 PNG 的 base64 与原始尺寸（供后续缩放/坐标对齐使用）。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CapturedImage } from './vlm.ts';

const exec = promisify(execFile);

export async function captureScreenshot(_maxW: number, _maxH: number): Promise<CapturedImage> {
  const out = join(tmpdir(), `lv-${Date.now()}.png`);
  const platform = process.platform;

  if (platform === 'darwin') {
    await exec('screencapture', ['-x', out]);
  } else if (platform === 'win32') {
    const escaped = out.replace(/\\/g, '\\\\').replace(/'/g, "''");
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
      '$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
      `$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)`,
      '$g = [System.Drawing.Graphics]::FromImage($bmp)',
      '$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $bmp.Size)',
      `$bmp.Save('${escaped}')`,
      '$g.Dispose(); $bmp.Dispose()',
    ].join('\n');
    await exec('powershell', ['-NoProfile', '-Command', ps]);
  } else {
    throw new Error(`localvision: 不支持的平台 ${platform}（仅支持 win32 / darwin）`);
  }

  const buf = await readFile(out);
  // PNG IHDR: 宽在偏移 16，高在偏移 20（大端）
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { base64: buf.toString('base64'), width, height };
}
