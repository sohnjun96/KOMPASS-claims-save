const TARGET_COUNT_RANGE_DEFAULT = [0, 300];
const SOFT_TARGET_RANGE_DEFAULT = [50, 180];
const GROUP_BUDGET_HARD_CAP = 5;
const GROUP_BUDGET_MIN = 2;

function toFiniteInt(value, fallback = null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function clamp01(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function normalizeBucket(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (
    raw === "0"
    || raw === "1_20"
    || raw === "21_100"
    || raw === "101_300"
    || raw === "301_1000"
    || raw === "1001_10000"
    || raw === "over_10000"
    || raw === "unknown"
  ) {
    return raw;
  }
  return "unknown";
}

function normalizeDecision(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "too_many" || raw === "too_few" || raw === "proceed" || raw === "unreadable") {
    return raw;
  }
  return "unreadable";
}

export function normalizeCountSource(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (
    raw === "dialog_exact_over_10k"
    || raw === "page_count"
    || raw === "dialog_bucket_only"
    || raw === "unknown"
  ) {
    return raw;
  }
  return "unknown";
}

export function normalizeDialogKind(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "many" || raw === "confirm" || raw === "too_many" || raw === "dialog_many") {
    return "many";
  }
  if (raw === "few" || raw === "alert" || raw === "too_few" || raw === "dialog_few") {
    return "few";
  }
  if (!raw || raw === "none" || raw === "no-dialog" || raw === "no_dialog") {
    return "none";
  }
  return "";
}

export function parseKompassDialogCount(message) {
  const text = String(message || "");
  if (!text) return null;

  const normalized = text.replace(/\s+/g, " ").trim();
  const exactMatch = normalized.match(/\(([0-9][0-9,]*)\uAC74\)/u);
  const fallbackMatch = normalized.match(/([0-9][0-9,]*)\uAC74/u);
  const source = exactMatch?.[1] || fallbackMatch?.[1] || "";
  if (!source) return null;

  const parsed = Number(source.replace(/,/g, ""));
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor(parsed));
}

export function classifyResultCount(count) {
  const value = toFiniteInt(count, null);
  if (value === null) {
    return {
      count: null,
      bucket: "unknown",
      decision: "unreadable",
      isTooMany: false,
      isTooFew: false,
      isProceed: false,
      isEmpty: false
    };
  }

  if (value === 0) {
    return {
      count: 0,
      bucket: "0",
      decision: "too_few",
      isTooMany: false,
      isTooFew: true,
      isProceed: false,
      isEmpty: true
    };
  }

  if (value <= 20) {
    return {
      count: value,
      bucket: "1_20",
      decision: "too_few",
      isTooMany: false,
      isTooFew: true,
      isProceed: false,
      isEmpty: false
    };
  }

  if (value <= 100) {
    return {
      count: value,
      bucket: "21_100",
      decision: "proceed",
      isTooMany: false,
      isTooFew: false,
      isProceed: true,
      isEmpty: false
    };
  }

  if (value <= 300) {
    return {
      count: value,
      bucket: "101_300",
      decision: "proceed",
      isTooMany: false,
      isTooFew: false,
      isProceed: true,
      isEmpty: false
    };
  }

  if (value <= 1000) {
    return {
      count: value,
      bucket: "301_1000",
      decision: "too_many",
      isTooMany: true,
      isTooFew: false,
      isProceed: false,
      isEmpty: false
    };
  }

  if (value <= 10000) {
    return {
      count: value,
      bucket: "1001_10000",
      decision: "too_many",
      isTooMany: true,
      isTooFew: false,
      isProceed: false,
      isEmpty: false
    };
  }

  return {
    count: value,
    bucket: "over_10000",
    decision: "too_many",
    isTooMany: true,
    isTooFew: false,
    isProceed: false,
    isEmpty: false
  };
}

export function computeCountDistanceScore(
  count,
  targetCountRange = TARGET_COUNT_RANGE_DEFAULT,
  softTargetRange = SOFT_TARGET_RANGE_DEFAULT
) {
  const current = toFiniteInt(count, null);
  if (current === null) return 0;

  const [targetMinRaw, targetMaxRaw] = Array.isArray(targetCountRange)
    ? targetCountRange
    : TARGET_COUNT_RANGE_DEFAULT;
  const [softMinRaw, softMaxRaw] = Array.isArray(softTargetRange)
    ? softTargetRange
    : SOFT_TARGET_RANGE_DEFAULT;

  const targetMin = Math.max(0, Number(targetMinRaw || 0));
  const targetMax = Math.max(targetMin, Number(targetMaxRaw || 300));
  const softMin = Math.max(targetMin, Number(softMinRaw || 50));
  const softMax = Math.max(softMin, Number(softMaxRaw || 180));

  if (current >= softMin && current <= softMax) return 1;
  if (current >= targetMin && current <= targetMax) return 0.82;

  if (current < targetMin) {
    const gap = targetMin - current;
    return Number((1 - Math.min(1, gap / Math.max(1, softMin || 1))).toFixed(4));
  }

  const over = current - targetMax;
  const penalty = Math.min(1, Math.log10(over + 1) / 4.2);
  return Number(clamp01(1 - penalty, 0).toFixed(4));
}

export function computeReductionRatio(previousCount, currentCount) {
  const prev = toFiniteInt(previousCount, null);
  const cur = toFiniteInt(currentCount, null);
  if (prev === null || cur === null || prev <= 0) return null;
  return Number((cur / prev).toFixed(4));
}

export function buildRepeatReasonSignature({
  decision = "",
  countBucket = "",
  previousBucket = "",
  reductionRatio = null
} = {}) {
  const normalizedDecision = normalizeDecision(decision);
  const normalizedBucket = normalizeBucket(countBucket);
  const prevBucket = normalizeBucket(previousBucket);
  const ratio = Number.isFinite(Number(reductionRatio)) ? Number(reductionRatio) : null;

  if (normalizedDecision === "too_many") {
    const reductionHint = ratio === null
      ? "low_reduction"
      : (ratio > 0.85 ? "low_reduction" : (ratio > 0.65 ? "mid_reduction" : "strong_reduction"));
    const bucketHint = normalizedBucket === prevBucket ? "same_bucket" : "bucket_shift";
    return `too_many|${normalizedBucket}|${reductionHint}|${bucketHint}`;
  }

  if (normalizedDecision === "too_few") {
    const sparseHint = normalizedBucket === "0" ? "empty" : "sparse";
    const stickHint = ratio === null
      ? "stuck"
      : (ratio >= 0.95 ? "stuck" : "recovering");
    return `too_few|${normalizedBucket}|${sparseHint}|${stickHint}`;
  }

  if (normalizedDecision === "proceed") {
    return `proceed|${normalizedBucket}`;
  }

  return "unknown_count|auto_paused";
}

export function countRecentSignatureRepeats(iterations = [], signature = "", windowSize = 4) {
  const normalizedSignature = String(signature || "").trim();
  if (!normalizedSignature) return 0;
  const list = Array.isArray(iterations) ? iterations : [];
  const tail = list.slice(Math.max(0, list.length - Math.max(1, Number(windowSize) || 4)));
  let count = 1;
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const prev = String(tail[i]?.repeatReasonSignature || "").trim();
    if (!prev || prev !== normalizedSignature) break;
    count += 1;
  }
  return count;
}

function pickDialogParsedCount(dialogState = {}) {
  const history = Array.isArray(dialogState?.history) ? dialogState.history : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const row = history[i];
    const parsed = toFiniteInt(row?.parsedCount, null);
    if (parsed !== null) return parsed;
    const parsedFromMessage = parseKompassDialogCount(row?.message || "");
    if (parsedFromMessage !== null) return parsedFromMessage;
  }
  const last = dialogState?.lastDialog || dialogState?.firstDialog || null;
  const parsed = toFiniteInt(last?.parsedCount, null);
  if (parsed !== null) return parsed;
  return parseKompassDialogCount(last?.message || "");
}

export function resolveBestObservedCount({
  dialogState = null,
  pageCountState = null
} = {}) {
  const dialogHistory = Array.isArray(dialogState?.history) ? dialogState.history : [];
  const dialogSignal = normalizeDialogKind(
    dialogState?.firstDialog?.kind
      || dialogState?.firstDialog?.rawType
      || dialogState?.lastDialog?.kind
      || dialogState?.lastDialog?.rawType
      || ""
  );

  const dialogExact = pickDialogParsedCount(dialogState);
  const pageCount = toFiniteInt(pageCountState?.count, null);

  if (dialogExact !== null) {
    const classified = classifyResultCount(dialogExact);
    return {
      count: dialogExact,
      countSource: "dialog_exact_over_10k",
      countBucket: classified.bucket,
      decision: classified.decision,
      dialogKind: dialogSignal || "none",
      hasDialog: dialogHistory.length > 0
    };
  }

  if (pageCount !== null) {
    const classified = classifyResultCount(pageCount);
    return {
      count: pageCount,
      countSource: "page_count",
      countBucket: classified.bucket,
      decision: classified.decision,
      dialogKind: dialogSignal || "none",
      hasDialog: dialogHistory.length > 0
    };
  }

  if (dialogHistory.length > 0 && (dialogSignal === "many" || dialogSignal === "few")) {
    const fallbackBucket = dialogSignal === "many" ? "over_10000" : "0";
    const fallbackDecision = dialogSignal === "many" ? "too_many" : "too_few";
    return {
      count: null,
      countSource: "dialog_bucket_only",
      countBucket: fallbackBucket,
      decision: fallbackDecision,
      dialogKind: dialogSignal,
      hasDialog: true
    };
  }

  return {
    count: null,
    countSource: "unknown",
    countBucket: "unknown",
    decision: "unreadable",
    dialogKind: dialogSignal || "none",
    hasDialog: dialogHistory.length > 0
  };
}

export function computeGroupBudget({
  mode = "balanced",
  countBucket = "unknown",
  repeatReasonCount = 1
} = {}) {
  const normalizedMode = String(mode || "balanced").trim().toLowerCase();
  const bucket = normalizeBucket(countBucket);
  const repeat = Math.max(1, Math.floor(Number(repeatReasonCount) || 1));

  let budget = 3;
  if (normalizedMode === "initial") {
    budget = 3;
  } else if (normalizedMode === "widen") {
    budget = bucket === "0" ? 2 : 3;
    if (repeat >= 3) budget = 2;
  } else if (normalizedMode === "narrow") {
    budget = 4;
    if (bucket === "1001_10000" || bucket === "over_10000") budget = 5;
    if (repeat >= 3) budget = 5;
  } else if (normalizedMode === "rebuild") {
    budget = 4;
  }

  return Math.max(GROUP_BUDGET_MIN, Math.min(GROUP_BUDGET_HARD_CAP, budget));
}

export const COUNT_CONTROL_DEFAULTS = {
  targetCountRange: TARGET_COUNT_RANGE_DEFAULT,
  softTargetRange: SOFT_TARGET_RANGE_DEFAULT
};
