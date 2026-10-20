/**
 * 本机原生 OCR（不依赖任何"视觉小模型"，不下载权重）。
 *  - Windows：调用系统内置的 Windows.Media.Ocr（WinRT，Windows 10/11 自带，免安装）。
 *  - macOS / 其它：尝试系统已装的 tesseract（常见），否则返回空。
 *
 * 返回归一化(0..1)的文字框；坐标相对「当前图」（全屏或裁剪图），
 * 由调用方结合 CaptureTransform.region 还原到屏幕绝对位置。
 *
 * 这样默认轻量模式下，桌宠就能"读"屏幕上的文字（用于 see / 点击文字锚定），
 * 而完全不调用任何云端或本地视觉大模型 —— 契合"本地 OCR + 坐标，不要视觉模型"的定位。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);

export interface OcrWord {
  text: string;
  x: number; // 左上归一化 x (0-1)
  y: number; // 左上归一化 y (0-1)
  w: number; // 宽归一化 (0-1)
  h: number; // 高归一化 (0-1)
  line: number; // 行号（拼接可读文本用）
}

/** 解析 PNG IHDR 拿到宽高（用于 tesseract 归一化）。 */
function pngSize(b64: string): { w: number; h: number } {
  const buf = Buffer.from(b64, 'base64');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

export async function ocrNative(imageB64: string): Promise<OcrWord[]> {
  const plat = process.platform;
  if (plat === 'win32') return ocrWinRt(imageB64);
  return ocrTesseract(imageB64);
}

/** 把 OCR 文字框拼成可读的多行文本（see 工具默认用）。 */
export function ocrToText(words: OcrWord[]): string {
  if (!words.length) return '';
  let out = '';
  let lastLine = -1;
  for (const w of words) {
    if (w.line !== lastLine) {
      out += '\n';
      lastLine = w.line;
    }
    out += w.text + ' ';
  }
  return out.replace(/\n\s+/g, '\n').trim();
}

/** 在 OCR 结果里查找包含 query 的文字框（先精确后包含）。 */
export function findWord(words: OcrWord[], query: string): OcrWord | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const hit = words.find((w) => w.text.toLowerCase() === q);
  if (hit) return hit;
  return words.find((w) => w.text.toLowerCase().includes(q)) ?? null;
}

// ——— Windows：内置 WinRT OCR ———
async function ocrWinRt(imageB64: string): Promise<OcrWord[]> {
  const b64File = join(tmpdir(), `lv-ocr-${Date.now()}.b64`);
  const outFile = join(tmpdir(), `lv-ocr-${Date.now()}.txt`);
  await writeFile(b64File, imageB64, 'utf8');
  const b = b64File.replace(/\\/g, '\\\\').replace(/'/g, "''");
  const o = outFile.replace(/\\/g, '\\\\').replace(/'/g, "''");
  const ps = [
    '$ErrorActionPreference="Stop"',
    'Add-Type -AssemblyName System.Drawing',
    `$bytes=[System.Convert]::FromBase64String((Get-Content -Raw '${b}'))`,
    '$ms=New-Object System.IO.MemoryStream(,$bytes)',
    '$bmp=New-Object System.Drawing.Bitmap($ms)',
    '$w=$bmp.Width; $h=$bmp.Height',
    'try { [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null } catch {}',
    '$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()',
    'if(-not $engine){ try { $engine=[Windows.Media.Ocr.OcrEngine]::TryCreate("en-US") } catch {} }',
    '$lines=@(("{0} {1}" -f $w,$h))',
    'if($engine){',
    '  $stream=New-Object Windows.Storage.Streams.InMemoryRandomAccessStream',
    '  $dw=New-Object Windows.Storage.Streams.DataWriter($stream)',
    '  $dw.WriteBytes($bytes)',
    '  [void]$dw.StoreAsync(); [void]$dw.FlushAsync(); $stream.Seek(0)',
    '  $task=$engine.RecognizeAsync($stream)',
    '  [void]$task.AsTask().Wait()',
    '  $res=$task.GetResults()',
    '  $li=0',
    '  foreach($line in $res.Lines){ foreach($word in $line.Words){ $r=$word.BoundingRect; $lines += ("{0}|{1}|{2}|{3}|{4}|{5}" -f ($word.Text -replace \'"\',\' \'),[int]$r.X,[int]$r.Y,[int]$r.Width,[int]$r.Height,$li) }; $li++ }',
    '}',
    `$lines -join \`n | Out-File -Encoding ascii '${o}'`,
  ].join('\n');
  try {
    await exec('powershell', ['-NoProfile', '-Command', ps]);
    const txt = await readFile(outFile, 'utf8');
    const rows = txt.split('\n').map((s) => s.trim()).filter(Boolean);
    if (rows.length < 1) return [];
    const [W, H] = rows[0].split(' ').map(Number);
    if (!W || !H) return [];
    const words: OcrWord[] = [];
    for (let i = 1; i < rows.length; i++) {
      const p = rows[i].split('|');
      if (p.length < 6) continue;
      words.push({
        text: p[0],
        x: Number(p[1]) / W,
        y: Number(p[2]) / H,
        w: Number(p[3]) / W,
        h: Number(p[4]) / H,
        line: Number(p[5]) || 0,
      });
    }
    return words;
  } catch {
    return [];
  } finally {
    try {
      await exec('cmd', ['/c', 'del', '/q', b64File, outFile]);
    } catch {
      /* ignore */
    }
  }
}

// ——— macOS / 其它：tesseract（若已安装）———
async function ocrTesseract(imageB64: string): Promise<OcrWord[]> {
  const png = join(tmpdir(), `lv-ocr-${Date.now()}.png`);
  const base = join(tmpdir(), `lv-ocr-${Date.now()}`);
  await writeFile(png, Buffer.from(imageB64, 'base64'));
  const { w: W, h: H } = pngSize(imageB64);
  try {
    await exec('tesseract', [png, base, '-l', 'eng', 'tsv']);
  } catch {
    return [];
  }
  const tsv = await readFile(`${base}.tsv`, 'utf8').catch(() => '');
  const words: OcrWord[] = [];
  for (const line of tsv.split('\n')) {
    const cols = line.split('\t');
    if (cols.length < 12) continue;
    if (cols[1] !== '5') continue; // 仅取 word 级
    const left = Number(cols[6]);
    const top = Number(cols[7]);
    const width = Number(cols[8]);
    const height = Number(cols[9]);
    const text = cols[11];
    if (!text || !W || !H) continue;
    words.push({
      text,
      x: left / W,
      y: top / H,
      w: width / W,
      h: height / H,
      line: Number(cols[4]) || 0,
    });
  }
  return words;
}
