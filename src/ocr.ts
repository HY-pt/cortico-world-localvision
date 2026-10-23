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
import { createWorker, PSM, type Worker } from 'tesseract.js';
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
  /**
   * true = 只有文字、没有位置。单行回落模式不做版面分析（blocks 为空），
   * 拿不到坐标；这种词**不能用于点击**，输出时要如实说明，别让模型拿假坐标去点。
   */
  noBox?: boolean;
}

/**
 * 单行回落的置信度门槛。
 * 实测（2026-10-23）：标准字幕回落 conf 63~93，CG 艺术字碎片 conf 0~15——
 * 两者完全不重叠，取 40 能干净分开：要字幕、不要幻觉。
 */
export const SINGLE_LINE_MIN_CONF = 40;

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
  /**
   * AUTO 一个词都没给出时，是否补跑一次单行模式（PSM.SINGLE_LINE）。默认 true。
   *
   * 为什么需要：AUTO 对**单行字幕**会完全失效——实测合成字幕 8 帧全空，
   * 还回报 conf=95 的假高置信度；换 SINGLE_LINE 反而一字不差。
   * 只对「原本一个词都没有」的情况补跑，不会让已有结果变差。
   */
  retrySingleLine?: boolean;
  /** 补跑结果的置信度门槛（0-100）；低于它视作幻觉，宁可诚实说没读出来。 */
  singleLineMinConf?: number;
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

/** 当前系统语言（Node 带完整 ICU 时可用）。 */
export function systemLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || '';
  } catch {
    return '';
  }
}

/** 系统语言 -> tesseract 语言；认不出时英文。 */
export function autoOcrLang(locale = systemLocale()): string {
  const l = locale.toLowerCase();
  if (l.startsWith('zh')) return /hant|tw|hk|mo/.test(l) ? 'chi_tra' : 'chi_sim';
  if (l.startsWith('ja')) return 'jpn';
  if (l.startsWith('ko')) return 'kor';
  if (l.startsWith('ru')) return 'rus';
  if (l.startsWith('fr')) return 'fra';
  if (l.startsWith('de')) return 'deu';
  if (l.startsWith('es')) return 'spa';
  if (l.startsWith('pt')) return 'por';
  if (l.startsWith('it')) return 'ita';
  return 'eng';
}

/** 配置值 -> 实际送给 tesseract 的语言串。 */
export function resolveOcrLangs(lang?: string): string {
  const l = (lang || '').trim();
  if (!l || l.toLowerCase() === 'auto') return autoOcrLang();
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
    const worker = await createWorker(langs, 1, { cachePath });
    // tesseract.js 的 worker 默认 PSM 不是 3（对 UI 截图会切成单块，中文识别明显变差）；
    // 固定成 PSM.AUTO=3（自动分页），实测同一张图内容准确率最高。
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
    return worker;
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

/** 单行回落命中的次数（诊断用）：它代表「本来会空手而归，补跑救回来了」。 */
let ocrSingleLineHits = 0;
/** 最近一次识别实际走的模式，排错时很有用。 */
let ocrLastPsm: 'auto' | 'single-line' | 'single-line-rejected' = 'auto';

/** 读 OCR 内部统计，供诊断面板展示。 */
export function ocrDiagnostics(): { singleLineHits: number; lastPsm: string } {
  return { singleLineHits: ocrSingleLineHits, lastPsm: ocrLastPsm };
}

/** 从 tesseract 的版面层级里提词（只有 AUTO 模式才有 blocks/paragraphs/lines）。 */
function wordsFromBlocks(data: { blocks?: unknown }, W: number, H: number): OcrWord[] {
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

export async function ocrNative(imageB64: string, opts: OcrOptions): Promise<OcrWord[]> {
  const langs = resolveOcrLangs(opts.lang);
  const cachePath = opts.cacheDir || join(tmpdir(), 'localvision-tessdata');
  const worker = await getWorker(langs, cachePath);
  const W = opts.width;
  const H = opts.height;
  if (!W || !H) return [];
  const buf = Buffer.from(imageB64, 'base64');

  // 1) 主识别：AUTO，带版面坐标——UI 截图（多块多行）的主场。
  const first = await worker.recognize(buf, {}, { blocks: true, text: true });
  const words = wordsFromBlocks(first.data, W, H);
  if (words.length) {
    ocrLastPsm = 'auto';
    return words;
  }

  // 2) 整张图一个字都没有 → 按「单行字幕」补跑一次。
  //    AUTO 对单行字幕会完全失效（实测 8 帧全空，还回报 conf=95 的假高置信度）。
  //    只在原本为空时补跑，不会让已有结果变差。
  if (opts.retrySingleLine === false) {
    ocrLastPsm = 'auto';
    return [];
  }

  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
  try {
    const retry = await worker.recognize(buf, {}, { text: true });
    const text = String(retry.data.text ?? '').trim();
    const conf = Math.round(retry.data.confidence ?? 0);
    const min = typeof opts.singleLineMinConf === 'number' ? opts.singleLineMinConf : SINGLE_LINE_MIN_CONF;
    if (!text || conf < min) {
      // 置信度太低 = 把画面噪点读成了字（CG 实测 conf 0~15）。
      // 宁可诚实说「没读出来」，也别拿碎片误导模型——这跟「不加全局置信度过滤」不冲突：
      // 这里守的是「补跑这条新路径」，不是去动 AUTO 已经给出的结果。
      ocrLastPsm = 'single-line-rejected';
      return [];
    }
    ocrSingleLineHits += 1;
    ocrLastPsm = 'single-line';
    // 单行模式不做版面分析（blocks 为空），坐标无从谈起，标记为无框。
    return [{ text, x: 0, y: 0, w: 0, h: 0, line: 0, noBox: true }];
  } finally {
    // worker 是模块级单例，PSM 不还原会污染后续每一次识别。
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
  }
}

/** 从 PNG/JPEG 字节里读宽高（截图坐标系的基准）。 */
export function imageSize(bytes: Uint8Array): { w: number; h: number } | null {
  // PNG: IHDR 宽高在 16..23，大端
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const w = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
    const h = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0;
    return w && h ? { w, h } : null;
  }
  // JPEG: 扫 SOF0/SOF1/SOF2
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = bytes[i + 1];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (marker >= 0xc0 && marker <= 0xc3) {
        const h = (bytes[i + 5] << 8) | bytes[i + 6];
        const w = (bytes[i + 7] << 8) | bytes[i + 8];
        return w && h ? { w, h } : null;
      }
      i += 2 + len;
    }
  }
  return null;
}

/** tesseract 会把每个汉字当独立词、中间插空格；把汉字/中文标点之间的空格合掉。 */
export function joinCjk(s: string): string {
  const cjk = '\\u4e00-\\u9fff';
  return s
    .replace(new RegExp(`(?<=[${cjk}])\\s+(?=[${cjk}，。！？、；：…])`, 'g'), '')
    .replace(new RegExp(`(?<=[，。！？、；：…])\\s+(?=[${cjk}])`, 'g'), '');
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
  return joinCjk(lines.join('\n'));
}

/** 归一化框 -> 截图像素中心点。 */
export function ocrItems(words: OcrWord[], W: number, H: number): OcrItem[] {
  return ocrItemsMapped(words, (nx, ny) => ({ x: nx * W, y: ny * H }));
}

export type OcrPointMap = (nx: number, ny: number) => { x: number; y: number };

/** 归一化框的**中心**经 `map` 映射到目标坐标（用于裁剪图 → 全屏截图坐标）。 */
export function ocrItemsMapped(words: OcrWord[], map: OcrPointMap): OcrItem[] {
  return words.map((w) => {
    const p = map(w.x + w.w / 2, w.y + w.h / 2);
    return { text: w.text, cx: Math.round(p.x), cy: Math.round(p.y), line: w.line };
  });
}

/** 阅读顺序文本 + 每个词的中心坐标（`map` 决定坐标系）。 */
export function ocrToLocatedTextMapped(words: OcrWord[], map: OcrPointMap): string {
  if (!words.length) return '';
  const reading = ocrToText(words);
  // 补跑（noBox）的词没有坐标，不能混进「可直接点击」的清单里——会点错地方。
  const boxed = words.filter((w) => !w.noBox);
  if (!boxed.length) {
    return `可见文字(阅读顺序):\n${reading}\n\n（这些字由单行模式补读，没有位置信息，不能用于点击）`;
  }
  const located = ocrItemsMapped(boxed, map).map((it) => `- ${it.text} @ (${it.cx}, ${it.cy})`).join('\n');
  const noBox = words.length - boxed.length;
  const tail = noBox > 0 ? `\n\n（另有 ${noBox} 个词没有位置信息）` : '';
  return `可见文字(阅读顺序):\n${reading}\n\n关键文字及中心坐标(截图像素):\n${located}${tail}`;
}

/** 阅读顺序文本 + 每个词的截图像素中心坐标（localvision_see 用）。 */
export function ocrToLocatedText(words: OcrWord[], W: number, H: number): string {
  return ocrToLocatedTextMapped(words, (nx, ny) => ({ x: nx * W, y: ny * H }));
}
