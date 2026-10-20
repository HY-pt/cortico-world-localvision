/**
 * 视觉空间坐标变换（分辨率 / DPI / 多屏 与云端坐标解耦的核心）。
 *
 * 设计原则：
 *  - 截图与点击始终使用「原生物理像素」（DPI 感知），不混用逻辑像素。
 *  - 云端只见到「归一化坐标 0..1」，绝不见原生像素或具体分辨率。
 *  - 本机保存上次截图的变换基准；点击时把归一化坐标乘回原生尺寸，
 *    因此任何分辨率 / 缩放 / 宽高比下都能像素级命中。
 *
 * 为什么能自适应：
 *  - 等比缩放（min 比值，只缩不放）保证截图不变形，识别稳定；
 *  - 归一化坐标与分辨率无关，云端逻辑在不同机器上完全一致；
 *  - 还原是纯线性乘法，无浮点累计误差之外的偏差。
 *
 * 裁剪支持：CaptureTransform 自带 regionX/Y/W/H（该图所覆盖的原生区域）。
 *  全屏截图时 region = 整屏（regionX=regionY=0, regionW=nativeWidth...）；
 *  局部裁剪时 region 为子矩形。normToNative 一律按 region 还原到绝对原生像素，
 *  因此「局部裁剪图里的归一化坐标」也能正确回到屏幕绝对位置。
 */

export interface CaptureTransform {
  nativeWidth: number; // 物理屏幕像素宽（DPI 感知）—— 还原用的全屏基准
  nativeHeight: number; // 物理屏幕像素高
  regionX: number; // 本图左上角在原生的 X 偏移（全屏=0）
  regionY: number; // 本图左上角在原生的 Y 偏移（全屏=0）
  regionW: number; // 本图覆盖的原生宽（全屏=nativeWidth）
  regionH: number; // 本图覆盖的原生高（全屏=nativeHeight）
  scaledWidth: number; // 实际发给识别引擎的图宽（等比缩放后）
  scaledHeight: number; // 实际发给识别引擎的图高
  scale: number; // nativeWidth / scaledWidth（统一，不变形）
  monitor: string; // 截自哪块屏（Windows: \\.\DISPLAYn；mac: primary）
  capturedAt: number; // 时间戳，用于判断坐标是否已过期
}

/** 等比缩放以适配 max 画布（只缩不放，保持宽高比）。 */
export function fitToMax(
  w: number,
  h: number,
  maxW: number,
  maxH: number
): { scale: number; scaledWidth: number; scaledHeight: number } {
  const scale = Math.min(maxW / w, maxH / h, 1);
  const scaledWidth = Math.max(1, Math.round(w * scale));
  const scaledHeight = Math.max(1, Math.round(h * scale));
  return { scale, scaledWidth, scaledHeight };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 缩放图坐标 -> 原生物理像素（当识别引擎用缩放图像素坐标时）。 */
export function visionToNative(
  vx: number,
  vy: number,
  t: CaptureTransform
): { x: number; y: number } {
  const x = t.regionX + (vx * t.regionW) / t.scaledWidth;
  const y = t.regionY + (vy * t.regionH) / t.scaledHeight;
  return {
    x: clamp(Math.round(x), 0, t.nativeWidth),
    y: clamp(Math.round(y), 0, t.nativeHeight),
  };
}

/** 归一化坐标(0..1) -> 原生物理像素（推荐：天然分辨率无关）。 */
export function normToNative(
  nx: number,
  ny: number,
  t: CaptureTransform
): { x: number; y: number } {
  const x = t.regionX + nx * t.regionW;
  const y = t.regionY + ny * t.regionH;
  return {
    x: clamp(Math.round(x), 0, t.nativeWidth),
    y: clamp(Math.round(y), 0, t.nativeHeight),
  };
}
