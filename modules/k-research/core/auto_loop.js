function toInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

export function normalizeDialogKind(rawValue) {
  const value = String(rawValue || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
  if (!value) return "none";

  if (
    value === "many"
    || value === "too_many"
    || value === "confirm"
    || value === "dialog_many"
    || value === "count_many"
  ) {
    return "many";
  }
  if (
    value === "few"
    || value === "too_few"
    || value === "alert"
    || value === "dialog_few"
    || value === "count_few"
  ) {
    return "few";
  }
  if (
    value === "none"
    || value === "no_dialog"
    || value === "no_dialog_detected"
    || value === "no_dialog_found"
    || value === "no_dialog_timeout"
  ) {
    return "none";
  }
  return "";
}

export function deriveDialogSignalFromMonitorState(dialogState = {}, fallbackRaw = "") {
  const history = Array.isArray(dialogState?.history) ? dialogState.history : [];
  if (history.length <= 0) {
    return normalizeDialogKind(fallbackRaw || "none");
  }

  const firstDialog = dialogState?.firstDialog || history[0] || null;
  const lastDialog = dialogState?.lastDialog || history[history.length - 1] || null;
  const primaryRaw = String(
    firstDialog?.kind
    || firstDialog?.rawType
    || lastDialog?.kind
    || lastDialog?.rawType
    || fallbackRaw
    || ""
  ).trim();

  return normalizeDialogKind(primaryRaw);
}

export function deriveAutoDecisionFromDialogAndCount({
  dialogKind = "",
  resultCount = null,
  threshold = 300
} = {}) {
  const normalizedDialog = normalizeDialogKind(dialogKind);
  if (normalizedDialog === "many") {
    return {
      decision: "too_many",
      reason: "dialog_many"
    };
  }
  if (normalizedDialog === "few") {
    return {
      decision: "too_few",
      reason: "dialog_few"
    };
  }

  if (
    resultCount === null
    || resultCount === undefined
    || (typeof resultCount === "string" && String(resultCount).trim() === "")
  ) {
    return {
      decision: "unreadable",
      reason: "count_unreadable"
    };
  }

  const count = Number(resultCount);
  if (!Number.isFinite(count)) {
    return {
      decision: "unreadable",
      reason: "count_unreadable"
    };
  }

  const manyThreshold = Math.max(1, toInt(threshold, 300));
  if (count >= manyThreshold) {
    return {
      decision: "too_many",
      reason: "count_many"
    };
  }

  return {
    decision: "proceed",
    reason: "count_proceed"
  };
}

export function makeCaptureStabilitySnapshot({
  rowsStoredCount = 0,
  evalPending = 0,
  evalRunning = 0,
  captureEvalSyncRunning = false
} = {}) {
  return {
    rowsStoredCount: toInt(rowsStoredCount, 0),
    evalPending: toInt(evalPending, 0),
    evalRunning: toInt(evalRunning, 0),
    captureEvalSyncRunning: captureEvalSyncRunning === true
  };
}

function buildStabilitySignature(snapshot = {}) {
  return [
    toInt(snapshot.rowsStoredCount, 0),
    toInt(snapshot.evalPending, 0),
    toInt(snapshot.evalRunning, 0),
    snapshot.captureEvalSyncRunning === true ? 1 : 0
  ].join("|");
}

export function updateCaptureStabilityWindow({
  previousSignature = "",
  stableSince = 0,
  snapshot = {},
  now = Date.now(),
  stableWindowMs = 2000
} = {}) {
  const normalizedSnapshot = makeCaptureStabilitySnapshot(snapshot);
  const signature = buildStabilitySignature(normalizedSnapshot);
  const normalizedWindow = Math.max(250, toInt(stableWindowMs, 2000));
  const hasBlockingWork = normalizedSnapshot.captureEvalSyncRunning
    || normalizedSnapshot.evalRunning > 0;

  let nextStableSince = Number.isFinite(Number(stableSince)) ? Number(stableSince) : 0;
  if (signature !== previousSignature) {
    nextStableSince = Number(now);
  } else if (!nextStableSince) {
    nextStableSince = Number(now);
  }

  const stableDuration = Math.max(0, Number(now) - nextStableSince);
  const stable = !hasBlockingWork
    && normalizedSnapshot.evalPending <= 0
    && signature === previousSignature
    && stableDuration >= normalizedWindow;

  return {
    stable,
    signature,
    stableSince: nextStableSince,
    snapshot: normalizedSnapshot
  };
}

export function classifyDerivedTabs({
  tabs = [],
  beforeTabIds = [],
  rootTabId = null,
  rootWindowId = null
} = {}) {
  const rootId = Number.isInteger(rootTabId) ? rootTabId : null;
  const beforeSet = new Set(
    (Array.isArray(beforeTabIds) ? beforeTabIds : [])
      .map((tabId) => Number(tabId))
      .filter((tabId) => Number.isInteger(tabId))
  );

  const out = new Set();
  (Array.isArray(tabs) ? tabs : []).forEach((tab) => {
    const tabId = Number(tab?.id);
    if (!Number.isInteger(tabId)) return;
    if (Number.isInteger(rootId) && tabId === rootId) return;

    const openerTabId = Number(tab?.openerTabId);
    if (Number.isInteger(rootId) && openerTabId === rootId) {
      out.add(tabId);
      return;
    }

    const windowId = Number(tab?.windowId);
    if (
      Number.isInteger(rootWindowId)
      && Number.isInteger(windowId)
      && windowId === rootWindowId
      && !beforeSet.has(tabId)
    ) {
      out.add(tabId);
    }
  });

  return Array.from(out).sort((left, right) => left - right);
}

export function nextAutoStage({
  currentStage = "",
  signal = "",
  stopRequested = false,
  sessionStatus = ""
} = {}) {
  if (stopRequested) return "paused_manual_required";
  const status = String(sessionStatus || "").trim().toLowerCase();
  if (status === "success" || status === "max_iterations") return "completed";

  const stage = String(currentStage || "").trim();
  const normalizedSignal = String(signal || "").trim();
  const normalizedDialogSignal = normalizeDialogKind(normalizedSignal);

  if (stage === "wait_dialog") {
    if (normalizedDialogSignal === "many") return "handle_dialog_many";
    if (normalizedDialogSignal === "few") return "handle_dialog_few";
    return "wait_result_count";
  }
  if (stage === "wait_result_count") {
    if (normalizedSignal === "too_many") return "handle_count_many";
    // Weak-recall bucket (1~20) is still a readable/usable count.
    // Proceed path is preferred over unreadable fallback.
    if (normalizedSignal === "too_few") return "handle_count_proceed";
    if (normalizedSignal === "proceed") return "handle_count_proceed";
    if (normalizedSignal === "unreadable") return "paused_manual_required";
  }
  if (stage === "wait_cycle_result") {
    if (status === "error" || status === "aborted") return "error";
    if (normalizedSignal === "advanced") return "advance_iteration";
  }
  return stage;
}
