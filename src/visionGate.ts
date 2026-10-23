/**
 * 视觉门控的纯逻辑层：blob 筛选、token 估算、兜底决策、计量、日志行。
 *
 * 为什么单独拆出来：这几块是**无副作用、只吃参数**的纯函数，能直接单测；
 * 而钩子编排（读字节、跑 OCR、写回执）留在 index.ts，两边职责不混。
 * 没有做成「通用中间件注入」是因为目前只有 localvision 一个使用者，
 * 为假想需求做抽象会切断 textAssist / cuaAfterAction 等上下文，得不偿失。
 */

/** 一次 OCR 之后的结果状态。failed 与 empty 必须分开：前者是故障，后者是画面本来就没字。 */
export type OcrStatus = 'hit' | 'empty' | 'failed';

/** 这个 blob 最终怎么处理的。dropped = 图片被丢掉（只留文字提示）。 */
export type GateAction = 'replaced' | 'kept' | 'dropped';

/** 计数器：全部只读暴露，供诊断面板与 doctor 使用。 */
export interface GateCounters {
  /** 钩子被调用（有目标 blob 的回执）次数。 */
  calls: number;
  /** 被拦截的截图 blob 总数。 */
  intercepted: number;
  /** OCR 命中（认出文字）次数。 */
  ocrHit: number;
  /** OCR 空结果（确实没文字）次数。 */
  ocrEmpty: number;
  /** OCR 失败（异常 / 取不到字节或尺寸）次数。 */
  ocrFailed: number;
  /** OCR 缓存命中次数。 */
  cacheHit: number;
  /** 走了图片兜底的次数——直接对应 token 成本，单独计数。 */
  fallbackImage: number;
  /** 降级为纯文字的次数。 */
  fallbackText: number;
  /** 图片被丢弃的次数。 */
  dropped: number;
  /** 累计估算的图片 token 成本。 */
  estimatedTokens: number;
}

export function emptyCounters(): GateCounters {
  return {
    calls: 0,
    intercepted: 0,
    ocrHit: 0,
    ocrEmpty: 0,
    ocrFailed: 0,
    cacheHit: 0,
    fallbackImage: 0,
    fallbackText: 0,
    dropped: 0,
    estimatedTokens: 0,
  };
}

/** 结构化日志行（JSON），每次拦截/命中/兜底写一条。 */
export interface GateEvent {
  ts: string;
  tool: string;
  /** blob 的 mime；取不到时是 unknown。 */
  blobType: string;
  ocrHit: boolean;
  action: GateAction;
  /** 机器可读的原因：ocr-hit / ocr-empty-fallback / ocr-failed-fallback / ocr-empty-text / no-bytes 等。 */
  reason: string;
  /** 图片兜底时的估算 token 成本；非图片兜底为 0。 */
  estimatedTokenCost: number;
  /** OCR 失败时带上原因，便于排查本机 OCR 健康度。 */
  error?: string;
}

export function gateEventLine(e: GateEvent): string {
  return JSON.stringify(e);
}

/** 图片 blob 的 mime 判断。 */
export function isImageBlob(blob: unknown): boolean {
  const mime = (blob as { mime?: unknown })?.mime;
  return typeof mime === 'string' && mime.startsWith('image/');
}

/**
 * 截图特征：内置 cua 的 blob 叫 screen.jpg / zoom.jpg，fallbackText 是「屏幕截图 …」。
 * forced 时（工具名在 hookTools 里）只要是图片就拦，不看名字。
 */
export function isScreenshotLike(blob: unknown, forced: boolean): boolean {
  if (!isImageBlob(blob)) return false;
  if (forced) return true;
  const b = blob as { name?: unknown; fallbackText?: unknown };
  return /screen|zoom|截图|截圖/i.test(`${b.name ?? ''} ${b.fallbackText ?? ''}`);
}

/**
 * 估算一张图发给视觉模型的 token 成本（OpenAI high-detail 计费规则的近似）：
 * 先 fit 到 2048，再把短边缩到 768，切 512×512 tile，每 tile 170 tokens + 85 底价。
 * 只是量级参考，不同厂商算法不同，别当精确账单。
 */
export function estimateImageTokens(width: number, height: number): number {
  if (!width || !height) return 0;
  const fit = Math.min(2048 / Math.max(width, height), 1);
  let w = width * fit;
  let h = height * fit;
  const s = Math.min(768 / Math.min(w, h), 1);
  w *= s;
  h *= s;
  const tiles = Math.ceil(w / 512) * Math.ceil(h / 512);
  return tiles * 170 + 85;
}

export interface FallbackPolicy {
  /** OCR 空结果时的兜底方式。 */
  onOcrEmpty: 'image' | 'text';
  /** OCR 失败时的兜底方式；默认 image，保证「任何情况下都有回应」。 */
  onOcrFailure: 'image' | 'text';
}

export interface FallbackDecision {
  action: GateAction;
  /** 是否走了图片兜底（保留原图给模型看）——直接对应 token 成本。 */
  imageFallback: boolean;
  /** 机器可读原因，进日志。 */
  reason: string;
}

/**
 * 兜底决策：失败与空结果分开处理。
 *
 * acceptsImage=false（对话模型不收图）时，'image' 兜底根本发不出去，
 * 必须降级成文字提示——否则模型会拿到一张自己看不见的图，等于没回应。
 */
export function decideFallback(
  status: OcrStatus,
  policy: FallbackPolicy,
  acceptsImage: boolean,
): FallbackDecision {
  if (status === 'hit') return { action: 'replaced', imageFallback: false, reason: 'ocr-hit' };

  const wantImage = status === 'failed' ? policy.onOcrFailure : policy.onOcrEmpty;
  const tag = status === 'failed' ? 'ocr-failed' : 'ocr-empty';

  if (wantImage === 'image') {
    if (!acceptsImage) {
      // 想发图但模型不收：只能降级，并把原因说清楚（否则用户以为配置没生效）
      return { action: 'dropped', imageFallback: false, reason: `${tag}-text-model-rejects-image` };
    }
    return { action: 'kept', imageFallback: true, reason: `${tag}-image-fallback` };
  }
  return { action: 'dropped', imageFallback: false, reason: `${tag}-text` };
}

/**
 * 图片兜底时拼给模型看的提示。
 * 不加的话模型拿到一张无字截图会去硬读字、或回「看不清」——兜底就白兜了。
 *
 * 措辞遵守项目铁律：对模型说「你 / 我」，第一人称，不用第三人称自称；
 * 只说明边界与建议关注点，不越界指挥模型「直接回应用户」。
 */
export function formatFallbackHint(cfg: { hintCjk?: boolean } = {}): string {
  const zh = cfg.hintCjk !== false;
  return zh
    ? '\n\n[视觉兜底] 这张图我没读出文字，所以把原图发给你看——请关注画面里有什么（场景、人物、界面布局），不要试图读字，也不要说「看不清」。'
    : '\n\n[Visual fallback] No text was recognized in this image, so the original screenshot is attached. Focus on the visual content (scene, people, UI layout) rather than trying to read text.';
}
