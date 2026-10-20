/**
 * 本机输入执行：把「原生物理像素坐标」真正变成一次鼠标点击。
 * 零 npm 依赖，调用 OS 自带能力。
 *
 * 说明：本文件实现的是独立可用的点击执行。若部署环境同时装了
 * cortico-world-cua，也可把点击改为委托 cua 的引擎执行（见 README），
 * 那样能和 cua 的窗口/焦点管理保持一致。这里默认走自带的轻量实现。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** 在原生物理像素坐标 (x, y) 处执行一次左键单击。 */
export async function clickAt(x: number, y: number): Promise<void> {
  const platform = process.platform;
  if (platform === 'win32') {
    await clickWindows(x, y);
  } else if (platform === 'darwin') {
    await clickDarwin(x, y);
  } else {
    throw new Error(`localvision: 不支持的平台 ${platform}`);
  }
}

function clickWindows(x: number, y: number): Promise<void> {
  const ps = [
    '$ErrorActionPreference="Stop"',
    'try { [System.Windows.Forms.Application]::SetHighDpiMode("PerMonitorV2") | Out-Null } catch {}',
    'Add-Type -AssemblyName System.Windows.Forms',
    `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y})`,
    'Add-Type @"',
    'using System; using System.Runtime.InteropServices;',
    'public class LV_M { [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,IntPtr e); }',
    '"@',
    '[LV_M]::mouse_event(0x0002,0,0,0,[IntPtr]::Zero)',
    '[LV_M]::mouse_event(0x0004,0,0,0,[IntPtr]::Zero)',
  ].join('\n');
  return exec('powershell', ['-NoProfile', '-Command', ps]).then(() => undefined);
}

function clickDarwin(x: number, y: number): Promise<void> {
  // macOS 坐标原点在左下角，需翻转 y。
  const script = `tell application "System Events" to click at {${x}, ${(y)}}`;
  // y 翻转放在外层避免混淆：先取主屏高度
  return exec('bash', [
    '-c',
    `H=$(osascript -e 'tell application "Finder" to get bounds of window of desktop' | awk '{print $4}'); Y=$((H - ${y})); osascript -e 'tell application "System Events" to click at {${x}, '$Y'}'`,
  ]).then(() => undefined);
}
