/**
 * 本机 OCR 后端：tesseract.js（纯 Node / WASM）。
 *
 * 为什么不用系统 WinRT OCR：它要走 PowerShell + .NET 反射，杀软（卡巴等）会直接拦掉；
 * tesseract.js 在 Node 进程内跑 WASM，不启外部进程、不落 exe，跨 Windows/macOS/Linux 一致。
 *
 * 语言数据（traineddata）首次使用时下载到 `cacheDir`，之后复用；默认 chi_sim（中英混排）。
 * 返回归一化(0..1)文字框；调用方用截图的 scaledWidth/Height 乘回去，得到与 `pet_cua_*`
 * 完全一致的「截图像素坐标」。
 */
import { createWorker, type Worker } from 'tesseract.js';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface OcrWord {
  text: string;
  x: number; // 左上归一化 x (0-1)
  y: number; // 左上归一化 y (0-1)
  w: number; // 宽归一化 (0-1)
  h: number; // 高归一化 (0-1)
  line: number;
}

export interface OcrItem {
  text: string;
  /** 中心坐标（截图像素，与 pet_cua_* 同一空间） */
  cx: number;
  cy: number;
  line: number;
}

export interface OcrOptions {
  /** tesseract 语言：chi_sim、eng、chi_sim+eng；留空 = chi_sim。 */
  lang?: string;
  /** traineddata 缓存目录；默认系统临时目录。 */
  cacheDir?: string;
  /** 截图缩放后的宽高（坐标系基准）。 */
  width: number;
  height: number;
}

/** 语言码归一化：WinRT 的 zh-Hans 与 tesseract 的 chi_sim 都接受。 */
export function tesseractLang(lang?: string): string {
  const l = (lang || '').trim();
  if (!l) return 'eng';
  const k = l.toLowerCase();
  if (k === 'zh' || k.startsWith('zh-hans') || k.startsWith('zh-cn') || k.startsWith('zh-sg')) return 'chi_sim';
  if (k.startsWith('zh-hant') || k.startsWith('zh-tw') || k.startsWith('zh-hk')) return 'chi_tra';
  if (k === 'en' || k.startsWith('en-')) return 'eng';
  if (k === 'ja' || k.startsWith('ja-')) return 'jpn';
  if (k === 'ko' || k.startsWith('ko-')) return 'kor';
  return l;
}

function langsOf(lang?: string): string {
  const l = (lang || '').trim();
  if (!l) return 'chi_sim';
  if (l.includes('+')) return l;
  return tesseractLang(l);
}

let workerPromise: Promise<Worker> | null = null;
let workerKey = '';

async function getWorker(langs: string, cachePath: string): Promise<Worker> {
  const key = `${langs}@${cachePath}`;
  if (workerPromise && workerKey === key) return workerPromise;
  workerKey = key;
  workerPromise = (async () => {
    await mkdir(cachePath, { recursive: true });
    return createWorker(langs, 1, { cachePath });
  })().catch((err) => {
    workerPromise = null;
    workerKey = '';
    throw err;
  });
  return workerPromise;
}

/** 释放 OCR worker（World 停用时调用，回收内存）。 */
export async function disposeOcr(): Promise<void> {
  const p = workerPromise;
  workerPromise = null;
  workerKey = '';
  if (!p) return;
  try {
    (await p).terminate();
  } catch {
    /* ignore */
  }
}

export async function ocrNative(imageB64: string, opts: OcrOptions): Promise<OcrWord[]> {
  const langs = langsOf(opts.lang);
  const cachePath = opts.cacheDir || join(tmpdir(), 'localvision-tessdata');
  const worker = await getWorker(langs, cachePath);
  const { data } = await worker.recognize(Buffer.from(imageB64, 'base64'), {}, { blocks: true, text: true });
  const W = opts.width;
  const H = opts.height;
  if (!W || !H) return [];

  const words: OcrWord[] = [];
  let line = 0;
  for (const block of (data.blocks ?? []) as any[]) {
    for (const para of block.paragraphs ?? []) {
      for (const ln of para.lines ?? []) {
        for (const w of ln.words ?? []) {
          const b = w.bbox;
          if (!b || !w.text) continue;
          words.push({
            text: String(w.text),
            x: b.x0 / W,
            y: b.y0 / H,
            w: (b.x1 - b.x0) / W,
            h: (b.y1 - b.y0) / H,
            line,
          });
        }
        line++;
      }
    }
  }
  return words;
}

/** 阅读顺序的纯文本（localvision_ocr 用）。 */
export function ocrToText(words: OcrWord[]): string {
  if (!words.length) return '';
  const maxLine = Math.max(...words.map((w) => w.line));
  const lines: string[] = [];
  for (let l = 0; l <= maxLine; l++) {
    const row = words.filter((w) => w.line === l).sort((a, b) => a.x - b.x).map((w) => w.text);
    if (row.length) lines.push(row.join(' '));
  }
  return lines.join('\n');
}

/** 归一化框 -> 截图像素中心点。 */
export function ocrItems(words: OcrWord[], W: number, H: number): OcrItem[] {
  return words.map((w) => ({
    text: w.text,
    cx: Math.round((w.x + w.w / 2) * W),
    cy: Math.round((w.y + w.h / 2) * H),
    line: w.line,
  }));
}

/** 阅读顺序文本 + 每个词的截图像素中心坐标（localvision_see 用）。 */
export function ocrToLocatedText(words: OcrWord[], W: number, H: number): string {
  if (!words.length) return '';
  const reading = ocrToText(words);
  const located = ocrItems(words, W, H).map((it) => `- ${it.text} @ (${it.cx}, ${it.cy})`).join('\n');
  return `可见文字(阅读顺序):\n${reading}\n\n关键文字及中心坐标(截图像素):\n${located}`;
}
