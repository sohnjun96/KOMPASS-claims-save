(() => {
  "use strict";

  const KRESEARCH_CAPTURE_HISTORY_KEY = "kresearch_capture_history_v1";
  const KRESEARCH_MAX_CAPTURE_ROWS = 3000;
  const BP_SERVICE_PATH = "/bpService.do";
  const DWPI_ABST_PATH = "/getDWPIAbst.do";
  const TARGET_BP_SERVICE_IDS = Object.freeze(["SKGM10500", "SKGM010500"]);
  const TARGET_BP_SERVICE_ID_SET = new Set(TARGET_BP_SERVICE_IDS);
  const DWPI_PAIR_WAIT_MS = 3000;
  const AUTO_ATTACH_THROTTLE_MS = 250;
  const DERIVED_ATTACH_RETRY_DELAYS_MS = Object.freeze([20, 80, 220, 520, 1100]);
  const NETWORK_ENABLE_MAX_TOTAL_BUFFER_SIZE = 128 * 1024 * 1024;
  const NETWORK_ENABLE_MAX_RESOURCE_BUFFER_SIZE = 8 * 1024 * 1024;
  const NETWORK_ENABLE_MAX_POST_DATA_SIZE = 4 * 1024 * 1024;
  const RESPONSE_BODY_READ_RETRY_DELAYS_MS = Object.freeze([0, 40, 120]);
  const CAPTURE_MODE_CAPTURE_ONLY = "capture_only";
  const CAPTURE_SCOPE_ROOT = "root";
  const CAPTURE_SCOPE_DERIVED = "derived";
  const ATTACHED_VIA_AUTO = "auto";
  const ATTACHED_VIA_MANUAL = "manual";
  const ATTACHED_VIA_UNKNOWN = "unknown";
  const PRIORITY_HINT_PRIMARY = "primary";
  const PRIORITY_HINT_SECONDARY = "secondary";

  globalThis.KRESEARCH_CAPTURE_MODULE_ENABLED = true;

  const attachedTabs = new Map();
  const attachingTabs = new Set();
  const captureRootByTab = new Map();
  const captureRunIdByRootTab = new Map();
  const captureContextByRootTab = new Map();
  const captureRootWindowIdByRootTab = new Map();
  const pendingByTab = new Map();
  const pendingBpPairByTab = new Map();
  const pendingDwpiByTab = new Map();
  const derivedAttachRetryStateByTab = new Map();
  const captureDiagnostics = createCaptureDiagnosticsState();
  let lastAutoAttachAt = 0;

  function createCaptureDiagnosticsState() {
    return {
      attachedTabsCount: 0,
      derivedTabsAttachedCount: 0,
      rowsStoredCount: 0,
      rowsDiscardedCount: 0,
      discardReasons: {},
      lastAttachedTabIds: [],
      lastStoredTabIds: [],
      lastStoredTargetMatchedFalseCount: 0,
      responseBodyReadSuccessCount: 0,
      responseBodyReadFailureCount: 0,
      payloadFallbackUsedCount: 0,
      bpRequestsSeenCount: 0,
      bpLoadingFinishedCount: 0,
      bpRowsQueuedCount: 0
    };
  }

  function toTabIdOrNull(value) {
    return Number.isInteger(value) ? value : null;
  }

  function toCaptureScope(value) {
    return value === CAPTURE_SCOPE_DERIVED ? CAPTURE_SCOPE_DERIVED : CAPTURE_SCOPE_ROOT;
  }

  function toAttachedVia(value) {
    if (value === ATTACHED_VIA_AUTO || value === ATTACHED_VIA_MANUAL || value === ATTACHED_VIA_UNKNOWN) {
      return value;
    }
    return ATTACHED_VIA_UNKNOWN;
  }

  function appendTailUnique(list, value, maxLen = 12) {
    if (!Array.isArray(list)) return [];
    const next = list.filter((entry) => entry !== value);
    next.push(value);
    if (next.length > maxLen) {
      next.splice(0, next.length - maxLen);
    }
    return next;
  }

  function refreshAttachDiagnostics() {
    let attachedCount = 0;
    let derivedCount = 0;
    for (const meta of attachedTabs.values()) {
      if (meta?.attached !== true) continue;
      attachedCount += 1;
      if (meta?.derived === true) derivedCount += 1;
    }
    captureDiagnostics.attachedTabsCount = attachedCount;
    captureDiagnostics.derivedTabsAttachedCount = derivedCount;
  }

  function recordAttachedTab(tabId) {
    if (!Number.isInteger(tabId)) return;
    captureDiagnostics.lastAttachedTabIds = appendTailUnique(captureDiagnostics.lastAttachedTabIds, tabId);
    refreshAttachDiagnostics();
  }

  function recordDiscard(reasonRaw) {
    const reason = String(reasonRaw || "").trim() || "other";
    captureDiagnostics.rowsDiscardedCount += 1;
    captureDiagnostics.discardReasons[reason] = Number(captureDiagnostics.discardReasons[reason] || 0) + 1;
  }

  function recordStoredRow(row) {
    captureDiagnostics.rowsStoredCount += 1;
    if (row?.targetMatched !== true) {
      captureDiagnostics.lastStoredTargetMatchedFalseCount += 1;
    }
    if (Number.isInteger(row?.tabId)) {
      captureDiagnostics.lastStoredTabIds = appendTailUnique(captureDiagnostics.lastStoredTabIds, row.tabId);
    }
  }

  function getCaptureDiagnosticsSnapshot() {
    refreshAttachDiagnostics();
    return {
      attachedTabsCount: captureDiagnostics.attachedTabsCount,
      derivedTabsAttachedCount: captureDiagnostics.derivedTabsAttachedCount,
      rowsStoredCount: captureDiagnostics.rowsStoredCount,
      rowsDiscardedCount: captureDiagnostics.rowsDiscardedCount,
      discardReasons: { ...(captureDiagnostics.discardReasons || {}) },
      lastAttachedTabIds: Array.isArray(captureDiagnostics.lastAttachedTabIds)
        ? [...captureDiagnostics.lastAttachedTabIds]
        : [],
      lastStoredTabIds: Array.isArray(captureDiagnostics.lastStoredTabIds)
        ? [...captureDiagnostics.lastStoredTabIds]
        : [],
      lastStoredTargetMatchedFalseCount: Number(captureDiagnostics.lastStoredTargetMatchedFalseCount || 0),
      responseBodyReadSuccessCount: Number(captureDiagnostics.responseBodyReadSuccessCount || 0),
      responseBodyReadFailureCount: Number(captureDiagnostics.responseBodyReadFailureCount || 0),
      payloadFallbackUsedCount: Number(captureDiagnostics.payloadFallbackUsedCount || 0),
      bpRequestsSeenCount: Number(captureDiagnostics.bpRequestsSeenCount || 0),
      bpLoadingFinishedCount: Number(captureDiagnostics.bpLoadingFinishedCount || 0),
      bpRowsQueuedCount: Number(captureDiagnostics.bpRowsQueuedCount || 0)
    };
  }

  function resetCaptureDiagnostics() {
    const next = createCaptureDiagnosticsState();
    captureDiagnostics.attachedTabsCount = next.attachedTabsCount;
    captureDiagnostics.derivedTabsAttachedCount = next.derivedTabsAttachedCount;
    captureDiagnostics.rowsStoredCount = next.rowsStoredCount;
    captureDiagnostics.rowsDiscardedCount = next.rowsDiscardedCount;
    captureDiagnostics.discardReasons = next.discardReasons;
    captureDiagnostics.lastAttachedTabIds = next.lastAttachedTabIds;
    captureDiagnostics.lastStoredTabIds = next.lastStoredTabIds;
    captureDiagnostics.lastStoredTargetMatchedFalseCount = next.lastStoredTargetMatchedFalseCount;
    captureDiagnostics.responseBodyReadSuccessCount = next.responseBodyReadSuccessCount;
    captureDiagnostics.responseBodyReadFailureCount = next.responseBodyReadFailureCount;
    captureDiagnostics.payloadFallbackUsedCount = next.payloadFallbackUsedCount;
    captureDiagnostics.bpRequestsSeenCount = next.bpRequestsSeenCount;
    captureDiagnostics.bpLoadingFinishedCount = next.bpLoadingFinishedCount;
    captureDiagnostics.bpRowsQueuedCount = next.bpRowsQueuedCount;
    refreshAttachDiagnostics();
  }

  function setAttachedTabMetaForTest(tabId, meta = {}) {
    if (!Number.isInteger(tabId)) return;
    attachedTabs.set(tabId, {
      attached: true,
      rootTabId: Number.isInteger(meta?.rootTabId) ? meta.rootTabId : tabId,
      attachedAt: Date.now(),
      attachedVia: toAttachedVia(meta?.attachedVia),
      derived: meta?.derived === true
    });
    if (Number.isInteger(meta?.rootTabId)) {
      captureRootByTab.set(tabId, meta.rootTabId);
    }
    recordAttachedTab(tabId);
  }

  function clearAttachedTabsForTest() {
    attachedTabs.clear();
    captureRootByTab.clear();
    refreshAttachDiagnostics();
  }

  function makeId(prefix = "kr") {
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function makeRunId(prefix = "krun") {
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  }

  function normalizeTs(ts) {
    const d = ts ? new Date(ts) : new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
  }

  function normalizeRunId(value) {
    const text = String(value ?? "").trim();
    if (!text) return "";
    return text.slice(0, 120);
  }

  function normalizeQueryVersionId(value) {
    const text = String(value ?? "").trim();
    if (!text) return "";
    return text.slice(0, 120);
  }

  function normalizeApplicationNo(value) {
    const text = String(value ?? "").trim();
    if (!text) return "";
    return text.toUpperCase().replace(/\s+/g, "");
  }

  function normalizePriorityHint(value, targetMatched = false) {
    if (value === PRIORITY_HINT_PRIMARY || value === PRIORITY_HINT_SECONDARY) return value;
    return targetMatched === true ? PRIORITY_HINT_PRIMARY : PRIORITY_HINT_SECONDARY;
  }

  function normalizeCaptureRow(row, fallbackIndex = 0) {
    const tabId = toTabIdOrNull(row?.tabId);
    const rootTabId = toTabIdOrNull(row?.rootTabId);
    const targetMatched = row?.targetMatched === true;
    const inferredScope = Number.isInteger(tabId) && Number.isInteger(rootTabId) && tabId !== rootTabId
      ? CAPTURE_SCOPE_DERIVED
      : CAPTURE_SCOPE_ROOT;
    return {
      ...(row || {}),
      id: String(row?.id || `cap_${fallbackIndex + 1}`),
      applicationNo: normalizeApplicationNo(row?.applicationNo) || null,
      queryVersionId: normalizeQueryVersionId(row?.queryVersionId) || null,
      runId: normalizeRunId(row?.runId) || null,
      citationText: normalizeCapturedText(row?.citationText),
      dwpiText: normalizeCapturedText(row?.dwpiText),
      targetMatched,
      discardReason: row?.discardReason ? String(row.discardReason) : null,
      captureScope: row?.captureScope ? toCaptureScope(row.captureScope) : inferredScope,
      attachedVia: toAttachedVia(row?.attachedVia),
      rootTabId,
      tabId,
      priorityHint: normalizePriorityHint(row?.priorityHint, targetMatched)
    };
  }

  function normalizeHistoryLimit(limit) {
    const n = Number(limit);
    if (!Number.isFinite(n)) return 40;
    return Math.max(1, Math.min(200, Math.floor(n)));
  }

  function normalizeCapturedText(text) {
    return String(text ?? "")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
  }

  function stripHtmlTags(text) {
    return String(text ?? "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\/?(?:p|div|li|tr|td|th|h[1-6]|ul|ol|table|tbody|thead|tfoot|section|article|header|footer|main|nav|pre)\b[^>]*>/gi, "\n")
      .replace(/<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s+[^<>]*?)?>/g, " ");
  }

  function sanitizeExtractedText(text) {
    return normalizeCapturedText(stripHtmlTags(text));
  }

  function extractClaimOnly(text) {
    return sanitizeExtractedText(text);
  }

  function extractFallbackCitationTextFromPayload(payloadRaw) {
    const raw = String(payloadRaw ?? "");
    if (!raw) return "";

    const parts = raw
      .split("\u001F")
      .map((part) => sanitizeExtractedText(part))
      .filter(Boolean);
    if (parts.length === 0) return sanitizeExtractedText(raw);

    return parts.reduce((longest, cur) => (cur.length > longest.length ? cur : longest), "");
  }

  function resolveCitationTextForCapture(responseText, payloadRaw) {
    const fromResponse = extractClaimOnly(responseText);
    if (fromResponse) {
      return {
        citationText: fromResponse,
        source: "response_body"
      };
    }

    const fromPayload = extractFallbackCitationTextFromPayload(payloadRaw);
    if (fromPayload) {
      captureDiagnostics.payloadFallbackUsedCount += 1;
      return {
        citationText: fromPayload,
        source: "payload_fallback"
      };
    }

    return {
      citationText: "",
      source: "empty"
    };
  }

  function findFirstStringByKey(node, keyPatterns) {
    const queue = [node];
    while (queue.length > 0) {
      const cur = queue.shift();
      if (!cur) continue;
      if (Array.isArray(cur)) {
        queue.push(...cur);
        continue;
      }
      if (typeof cur !== "object") continue;

      for (const [key, value] of Object.entries(cur)) {
        if (
          typeof value === "string"
          && keyPatterns.some((pattern) => pattern.test(key))
          && value.trim()
        ) {
          return value.trim();
        }
        if (value && typeof value === "object") queue.push(value);
      }
    }
    return "";
  }

  function extractDwpiOnly(text) {
    const raw = normalizeCapturedText(text);
    if (!raw) return "";

    try {
      const json = JSON.parse(raw);
      const fromJson = findFirstStringByKey(json, [
        /dwpi/i,
        /abst/i,
        /abstract/i,
        /summary/i,
        /yoyak/i
      ]);
      if (fromJson) return sanitizeExtractedText(fromJson);
    } catch {}

    return sanitizeExtractedText(raw);
  }

  function hasEnoughDigits(text, minDigits = 6) {
    return String(text ?? "").replace(/\D/g, "").length >= minDigits;
  }

  function isSkgmServiceIdToken(token) {
    const value = String(token ?? "").trim().toUpperCase();
    if (!value) return false;
    return /^\/?SKGM0?\d+$/.test(value);
  }

  function looksLikeApplicationNo(token) {
    const value = String(token ?? "").trim();
    if (!value) return false;
    if (isSkgmServiceIdToken(value)) return false;
    if (value.length < 6 || value.length > 40) return false;
    if (!/[0-9]/.test(value)) return false;
    if (!/^[A-Za-z0-9./\-_]+$/.test(value)) return false;
    return hasEnoughDigits(value, 6);
  }

  function extractSecondToken(src) {
    const parts = String(src ?? "")
      .split("\u001F")
      .map((part) => String(part ?? "").trim())
      .filter(Boolean);
    const found = parts.find(looksLikeApplicationNo);
    return found || null;
  }

  function extractApplicationNoFromUrl(rawUrl) {
    try {
      const u = new URL(rawUrl);
      const keys = [
        "applicationNo",
        "application_no",
        "applNo",
        "appNo",
        "apno",
        "an",
        "docNo"
      ];
      for (const key of keys) {
        const value = String(u.searchParams.get(key) ?? "").trim();
        if (looksLikeApplicationNo(value)) return value;
      }

      const pathCandidates = String(u.pathname || "").match(/[A-Za-z0-9./\-_]{6,40}/g) || [];
      const fromPath = pathCandidates.find(looksLikeApplicationNo);
      if (fromPath) return fromPath;
      return "";
    } catch {
      return "";
    }
  }

  function extractApplicationNoFromText(rawText) {
    const text = String(rawText ?? "");
    if (!text) return "";

    const labeledPattern =
      /(?:application[_\s-]*no|appl(?:ication)?[_\s-]*no|app[_\s-]*no|출원번호)\s*[:=]?\s*([A-Za-z0-9./\-_]{6,40})/i;
    const labeled = text.match(labeledPattern)?.[1];
    if (looksLikeApplicationNo(labeled)) return labeled;

    const likelyTokens = text.match(/[A-Za-z0-9./\-_]{8,40}/g) || [];
    const preferred = likelyTokens.find((token) => {
      if (!looksLikeApplicationNo(token)) return false;
      return /-/.test(token) || /[A-Za-z]/.test(token) || hasEnoughDigits(token, 8);
    });
    if (preferred) return preferred;

    const fallback = likelyTokens.find(looksLikeApplicationNo);
    return fallback || "";
  }

  function resolveCapturedApplicationNo({ payloadRaw, requestUrl, responseText }) {
    const fromPayloadToken = extractSecondToken(payloadRaw);
    if (looksLikeApplicationNo(fromPayloadToken)) return normalizeApplicationNo(fromPayloadToken);

    const fromPayloadText = extractApplicationNoFromText(payloadRaw);
    if (looksLikeApplicationNo(fromPayloadText)) return normalizeApplicationNo(fromPayloadText);

    const fromUrl = extractApplicationNoFromUrl(requestUrl);
    if (looksLikeApplicationNo(fromUrl)) return normalizeApplicationNo(fromUrl);

    const fromResponse = extractApplicationNoFromText(responseText);
    if (looksLikeApplicationNo(fromResponse)) return normalizeApplicationNo(fromResponse);

    return "";
  }

  function isCapturableTabUrl(url) {
    if (typeof url !== "string") return false;
    return url.startsWith("http://") || url.startsWith("https://");
  }

  function getTrackedRequestKind(url, payloadRaw = "") {
    try {
      const u = new URL(url);
      const path = String(u.pathname || "").toLowerCase().replace(/\/+$/g, "");
      if (/\/bpservice\.do(?:[;/]|$)/i.test(path) || path.endsWith(BP_SERVICE_PATH.toLowerCase())) {
        // K-Research keeps a hard target constraint for SKGM010500-family requests.
        // Only track target bpService requests at request stage.
        return isKResearchTargetBpRequest(url, payloadRaw) ? "bp" : null;
      }
      if (/\/getdwpiabst\.do(?:[;/]|$)/i.test(path) || path.endsWith(DWPI_ABST_PATH.toLowerCase())) {
        return "dwpi";
      }
      return null;
    } catch {
      return null;
    }
  }

  function shouldTrackRequestKindForTab(tabId, requestKind) {
    if (!requestKind) return false;
    const scope = getCaptureMetaForTab(tabId);
    if (requestKind === "dwpi" && scope?.derived === true) {
      return false;
    }
    return true;
  }

  function decodeMaybeURIComponent(value) {
    const src = String(value || "");
    if (!src) return "";
    try {
      return decodeURIComponent(src);
    } catch {
      return src;
    }
  }

  function normalizeSkgmServiceId(value) {
    return decodeMaybeURIComponent(value)
      .replace(/\s+/g, "")
      .replace(/^\/+/, "")
      .toUpperCase();
  }

  function isTargetBpServiceId(value) {
    const normalized = normalizeSkgmServiceId(value);
    return TARGET_BP_SERVICE_ID_SET.has(normalized);
  }

  function parseSearchParamCaseInsensitive(searchParams, keyName) {
    if (!searchParams || typeof searchParams.entries !== "function") return "";
    const target = String(keyName || "").trim().toLowerCase();
    for (const [rawKey, rawValue] of searchParams.entries()) {
      if (String(rawKey || "").trim().toLowerCase() !== target) continue;
      return String(rawValue || "").trim();
    }
    return "";
  }

  function extractServiceIdFromPayload(payloadRaw) {
    const raw = decodeMaybeURIComponent(String(payloadRaw || ""));
    if (!raw) return "";

    const patterns = [
      /[\?&;]ID=(?:\/)?(SKGM\d+)(?:[&#;]|$)/i,
      /["']ID["']\s*:\s*["'](?:\/)?(SKGM\d+)["']/i,
      /[\u001F]ID(?:\/)?(SKGM\d+)(?:[\u001F]|$)/i
    ];
    for (const pattern of patterns) {
      const match = raw.match(pattern);
      if (!match?.[1]) continue;
      return normalizeSkgmServiceId(match[1]);
    }
    return "";
  }

  function extractServiceIdFromRequest(url, payloadRaw = "") {
    try {
      const u = new URL(url);
      const rawId = parseSearchParamCaseInsensitive(u.searchParams, "id");
      const normalizedFromUrl = normalizeSkgmServiceId(rawId);
      if (normalizedFromUrl) return normalizedFromUrl;
    } catch {}
    return extractServiceIdFromPayload(payloadRaw);
  }

  function payloadHasSkgmTargetId(payloadRaw) {
    const raw = decodeMaybeURIComponent(String(payloadRaw || ""));
    if (!raw) return false;
    const normalized = raw.replace(/\s+/g, "").toUpperCase();
    for (const targetId of TARGET_BP_SERVICE_IDS) {
      if (!normalized.includes(targetId)) continue;
      if (new RegExp(`[\\?&;]ID=(?:\\/)?${targetId}(?:[&#;]|$)`, "i").test(normalized)) return true;
      if (new RegExp(`["']ID["']\\s*:\\s*["'](?:\\/)?${targetId}["']`, "i").test(raw)) return true;
      if (new RegExp(`[\\u001F]ID(?:\\/)?${targetId}(?:[\\u001F]|$)`, "i").test(raw)) return true;
      return true;
    }
    return false;
  }

  function isKResearchTargetBpRequest(url, payloadRaw = "") {
    try {
      const u = new URL(url);
      const path = String(u.pathname || "").toLowerCase().replace(/\/+$/g, "");
      if (!/\/bpservice\.do(?:[;/]|$)/i.test(path) && !path.endsWith(BP_SERVICE_PATH.toLowerCase())) {
        return false;
      }

      const rawId = parseSearchParamCaseInsensitive(u.searchParams, "id");
      if (rawId) {
        if (isTargetBpServiceId(rawId)) return true;
      }

      return payloadHasSkgmTargetId(payloadRaw);
    } catch {
      return payloadHasSkgmTargetId(payloadRaw);
    }
  }

  // Preferred-hit signal only: this is NOT a hard storage gate.
  function isPreferredKResearchBpHit(meta, responseText = "") {
    if (isKResearchTargetBpRequest(meta?.url || "", meta?.payload || "")) {
      return true;
    }
    const normalizedResponse = String(responseText || "").replace(/\s+/g, "").toUpperCase();
    return TARGET_BP_SERVICE_IDS.some((targetId) => normalizedResponse.includes(targetId));
  }

  function isKResearchTargetBpCaptured(meta, responseText = "") {
    return isPreferredKResearchBpHit(meta, responseText);
  }

  function isExplicitNonTargetBpRequest(meta) {
    const serviceId = extractServiceIdFromRequest(meta?.url || "", meta?.payload || "");
    if (!serviceId) return false;
    return !isTargetBpServiceId(serviceId);
  }

  function decodeBody(body, base64Encoded) {
    if (!base64Encoded) return body ?? "";
    try {
      const bin = atob(body || "");
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch {
      return body ?? "";
    }
  }

  function sleepMs(delayMs) {
    return new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, Number(delayMs) || 0));
    });
  }

  async function readResponseBodyText(tabId, requestId) {
    let lastError = null;

    for (let index = 0; index < RESPONSE_BODY_READ_RETRY_DELAYS_MS.length; index += 1) {
      if (index > 0) {
        await sleepMs(RESPONSE_BODY_READ_RETRY_DELAYS_MS[index]);
      }
      try {
        const response = await chrome.debugger.sendCommand(
          { tabId },
          "Network.getResponseBody",
          { requestId }
        );
        const text = decodeBody(response?.body, response?.base64Encoded);
        if (normalizeCapturedText(text)) {
          captureDiagnostics.responseBodyReadSuccessCount += 1;
          return {
            text,
            ok: true,
            attempt: index + 1,
            error: null
          };
        }
      } catch (error) {
        lastError = error;
      }
    }

    captureDiagnostics.responseBodyReadFailureCount += 1;
    return {
      text: "",
      ok: false,
      attempt: RESPONSE_BODY_READ_RETRY_DELAYS_MS.length,
      error: lastError?.message || String(lastError || "")
    };
  }

  function getFallbackReasonForEmptyCitation(meta, bodyResult, citationSource) {
    if (citationSource === "payload_fallback") return "response_body_unavailable_payload_fallback";
    if (bodyResult?.ok !== true) return "response_body_read_failed";
    if (meta?.kind === "bp") return "empty_citation_from_bp_response";
    return "empty_citation";
  }

  function resolveDiscardReasonForBpCapture({ targetMatched, citationText, captureMeta, bodyResult, citationSource, meta }) {
    const shouldCapture = shouldCaptureBpPair({
      targetMatched,
      citationText,
      captureMeta
    });
    if (shouldCapture) {
      return { shouldCapture: true, reason: null };
    }
    if (!normalizeCapturedText(citationText)) {
      return {
        shouldCapture: false,
        reason: getFallbackReasonForEmptyCitation(meta, bodyResult, citationSource)
      };
    }
    return { shouldCapture: true, reason: null };
  }

  function getCaptureRootTabId(tabId) {
    const rootTabId = captureRootByTab.get(tabId);
    return Number.isInteger(rootTabId) ? rootTabId : tabId;
  }

  function getCaptureRunIdForTab(tabId) {
    const rootTabId = getCaptureRootTabId(tabId);
    if (!Number.isInteger(rootTabId)) return "";
    const existing = normalizeRunId(captureRunIdByRootTab.get(rootTabId));
    if (existing) return existing;
    const created = makeRunId();
    captureRunIdByRootTab.set(rootTabId, created);
    return created;
  }

  function setCaptureContextForRoot(rootTabId, context = {}) {
    if (!Number.isInteger(rootTabId)) return;
    captureContextByRootTab.set(rootTabId, {
      mode: CAPTURE_MODE_CAPTURE_ONLY,
      runId: normalizeRunId(context?.runId),
      queryVersionId: normalizeQueryVersionId(context?.queryVersionId)
    });
  }

  function getCaptureContextForTab(tabId) {
    const rootTabId = getCaptureRootTabId(tabId);
    const context = captureContextByRootTab.get(rootTabId);
    return {
      mode: CAPTURE_MODE_CAPTURE_ONLY,
      runId: normalizeRunId(context?.runId) || normalizeRunId(captureRunIdByRootTab.get(rootTabId)),
      queryVersionId: normalizeQueryVersionId(context?.queryVersionId)
    };
  }

  function getCaptureMetaForTab(tabId) {
    const normalizedTabId = toTabIdOrNull(tabId);
    const rootTabId = Number.isInteger(normalizedTabId)
      ? getCaptureRootTabId(normalizedTabId)
      : toTabIdOrNull(tabId);
    const attachedMeta = attachedTabs.get(normalizedTabId) || {};
    const captureScope = Number.isInteger(normalizedTabId) && Number.isInteger(rootTabId) && normalizedTabId !== rootTabId
      ? CAPTURE_SCOPE_DERIVED
      : CAPTURE_SCOPE_ROOT;
    const attachedVia = toAttachedVia(attachedMeta?.attachedVia);
    return {
      rootTabId: toTabIdOrNull(rootTabId),
      tabId: toTabIdOrNull(normalizedTabId),
      captureScope,
      attachedVia,
      derived: captureScope === CAPTURE_SCOPE_DERIVED
    };
  }

  function shouldCaptureBpPair({ targetMatched = false, citationText = "", captureMeta = null }) {
    const text = normalizeCapturedText(citationText);
    if (!text) return false;
    // Request-stage tracking already enforces SKGM010500-family target constraint.
    // If citation text exists, keep the row and let targetMatched work as priority metadata.
    return true;
  }

  function buildCaptureRowFromPair(pair, context = {}) {
    if (!pair || typeof pair !== "object") {
      return { row: null, discardReason: "missing_pair_data" };
    }

    const citationText = normalizeCapturedText(pair?.citationText);
    if (!citationText) {
      return { row: null, discardReason: "no_citation_text" };
    }

    const tabId = toTabIdOrNull(pair?.tabId);
    const scopeMeta = {
      ...getCaptureMetaForTab(tabId),
      ...(pair?.captureMeta && typeof pair.captureMeta === "object" ? pair.captureMeta : {})
    };
    const targetMatched = pair?.targetMatched === true;
    const row = normalizeCaptureRow({
      id: makeId("cap"),
      time: normalizeTs(Date.now()),
      applicationNo: pair?.applicationNo || null,
      queryVersionId: context?.queryVersionId || null,
      runId: context?.runId || null,
      payload: pair?.payloadRaw ?? "",
      citationText,
      dwpiText: normalizeCapturedText(pair?.dwpiText ?? ""),
      targetMatched,
      discardReason: null,
      captureScope: scopeMeta.captureScope,
      attachedVia: scopeMeta.attachedVia,
      rootTabId: scopeMeta.rootTabId,
      tabId: scopeMeta.tabId,
      priorityHint: targetMatched ? PRIORITY_HINT_PRIMARY : PRIORITY_HINT_SECONDARY,
      url: pair?.bpMeta?.url ?? "",
      dwpiUrl: pair?.dwpiMeta?.url ?? "",
      source: "k-research-capture-only"
    });

    return { row, discardReason: null };
  }

  function clearTabCaptureState(tabId) {
    const rootTabId = getCaptureRootTabId(tabId);
    clearDerivedAttachRetryState(tabId);
    attachedTabs.delete(tabId);
    attachingTabs.delete(tabId);
    captureRootByTab.delete(tabId);
    pendingByTab.delete(tabId);
    pendingBpPairByTab.delete(tabId);
    pendingDwpiByTab.delete(tabId);

    if (rootTabId === tabId) {
      captureRunIdByRootTab.delete(rootTabId);
      captureContextByRootTab.delete(rootTabId);
      captureRootWindowIdByRootTab.delete(rootTabId);
    }

    refreshAttachDiagnostics();
  }

  function withTimeout(promise, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${label} timed out (${timeoutMs}ms)`));
      }, timeoutMs);

      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  function getPendingBpQueue(tabId) {
    let queue = pendingBpPairByTab.get(tabId);
    if (!queue) {
      queue = [];
      pendingBpPairByTab.set(tabId, queue);
    }
    return queue;
  }

  function getPendingDwpiQueue(tabId) {
    let queue = pendingDwpiByTab.get(tabId);
    if (!queue) {
      queue = [];
      pendingDwpiByTab.set(tabId, queue);
    }
    return queue;
  }

  async function pushCaptureRow(item) {
    const data = await chrome.storage.local.get([KRESEARCH_CAPTURE_HISTORY_KEY]);
    const arr = Array.isArray(data[KRESEARCH_CAPTURE_HISTORY_KEY])
      ? data[KRESEARCH_CAPTURE_HISTORY_KEY]
      : [];

    arr.unshift(normalizeCaptureRow(item, arr.length));
    if (arr.length > KRESEARCH_MAX_CAPTURE_ROWS) {
      arr.length = KRESEARCH_MAX_CAPTURE_ROWS;
    }

    await chrome.storage.local.set({ [KRESEARCH_CAPTURE_HISTORY_KEY]: arr });
  }

  function sortRowsByPriority(rows) {
    return [...(Array.isArray(rows) ? rows : [])].sort((left, right) => {
      const leftPriority = left?.priorityHint === PRIORITY_HINT_PRIMARY ? 1 : 0;
      const rightPriority = right?.priorityHint === PRIORITY_HINT_PRIMARY ? 1 : 0;
      if (rightPriority !== leftPriority) return rightPriority - leftPriority;

      const leftTime = Date.parse(String(left?.time || ""));
      const rightTime = Date.parse(String(right?.time || ""));
      if (Number.isFinite(rightTime) && Number.isFinite(leftTime) && rightTime !== leftTime) {
        return rightTime - leftTime;
      }

      return String(right?.id || "").localeCompare(String(left?.id || ""));
    });
  }

  async function getCapturedRowsByRunId(runId) {
    const normalizedRunId = normalizeRunId(runId);
    const data = await chrome.storage.local.get([KRESEARCH_CAPTURE_HISTORY_KEY]);
    const arrRaw = Array.isArray(data[KRESEARCH_CAPTURE_HISTORY_KEY])
      ? data[KRESEARCH_CAPTURE_HISTORY_KEY]
      : [];
    const arr = arrRaw.map((row, index) => normalizeCaptureRow(row, index));

    const filtered = normalizedRunId
      ? arr.filter((item) => normalizeRunId(item?.runId) === normalizedRunId)
      : arr;
    return sortRowsByPriority(filtered);
  }

  async function clearCaptureHistory(options = {}) {
    const runId = normalizeRunId(options?.runId);
    const data = await chrome.storage.local.get([KRESEARCH_CAPTURE_HISTORY_KEY]);
    const arrRaw = Array.isArray(data[KRESEARCH_CAPTURE_HISTORY_KEY])
      ? data[KRESEARCH_CAPTURE_HISTORY_KEY]
      : [];
    const arr = arrRaw.map((row, index) => normalizeCaptureRow(row, index));

    if (!runId) {
      await chrome.storage.local.set({ [KRESEARCH_CAPTURE_HISTORY_KEY]: [] });
      return {
        clearedCount: arr.length,
        remainingCount: 0
      };
    }

    const next = arr.filter((item) => normalizeRunId(item?.runId) !== runId);
    await chrome.storage.local.set({ [KRESEARCH_CAPTURE_HISTORY_KEY]: next });
    return {
      clearedCount: Math.max(0, arr.length - next.length),
      remainingCount: next.length
    };
  }

  async function getCaptureStatusByRunId(runId, limit = 40) {
    const rows = await getCapturedRowsByRunId(runId);
    const normalizedLimit = normalizeHistoryLimit(limit);
    const preview = rows.slice(0, normalizedLimit).map((row, index) => ({
      resultId: String(row?.id || `cap_${index + 1}`),
      applicationNo: normalizeApplicationNo(row?.applicationNo) || "-",
      status: "captured",
      index,
      targetMatched: row?.targetMatched === true,
      priorityHint: normalizePriorityHint(row?.priorityHint, row?.targetMatched === true)
    }));

    return {
      count: rows.length,
      rows: preview
    };
  }

  async function enqueueCapturePair(pair) {
    if (!pair || typeof pair !== "object") {
      recordDiscard("missing_pair_data");
      console.warn("K-Research capture: row skipped (missing pair data)");
      return;
    }

    const context = getCaptureContextForTab(pair?.tabId);
    const runId = normalizeRunId(pair?.runId)
      || normalizeRunId(context?.runId)
      || getCaptureRunIdForTab(pair?.tabId);
    const queryVersionId = normalizeQueryVersionId(pair?.queryVersionId)
      || normalizeQueryVersionId(context?.queryVersionId);

    const applicationNo = normalizeApplicationNo(pair?.applicationNo)
      || resolveCapturedApplicationNo({
        payloadRaw: pair?.payloadRaw ?? "",
        requestUrl: pair?.bpMeta?.url ?? "",
        responseText: pair?.citationText ?? ""
      });

    const normalizedPair = {
      ...pair,
      applicationNo: applicationNo || null,
      runId: runId || null,
      queryVersionId: queryVersionId || null
    };

    const prepared = buildCaptureRowFromPair(normalizedPair, {
      runId: runId || null,
      queryVersionId: queryVersionId || null
    });
    if (!prepared?.row) {
      const reason = String(prepared?.discardReason || "other");
      recordDiscard(reason);
      if (reason === "no_citation_text") {
        console.debug("K-Research capture: row skipped (no citation text)");
      } else {
        console.warn(`K-Research capture: row skipped (${reason})`);
      }
      return;
    }

    try {
      await pushCaptureRow(prepared.row);
      recordStoredRow(prepared.row);
      if (prepared.row.targetMatched !== true) {
        console.debug(
          "K-Research capture: row stored with targetMatched=false",
          {
            runId: prepared.row.runId,
            tabId: prepared.row.tabId,
            rootTabId: prepared.row.rootTabId,
            captureScope: prepared.row.captureScope,
            attachedVia: prepared.row.attachedVia
          }
        );
      }
    } catch (error) {
      recordDiscard("storage_error");
      console.warn("K-Research capture: row store failed (storage_error)", error);
    }
  }

  function stagePendingBpPair(tabId, pair) {
    captureDiagnostics.bpRowsQueuedCount += 1;
    const captureMeta = pair?.captureMeta && typeof pair.captureMeta === "object"
      ? pair.captureMeta
      : getCaptureMetaForTab(tabId);
    const pairWithMeta = {
      ...(pair || {}),
      tabId: Number.isInteger(pair?.tabId) ? pair.tabId : tabId,
      captureMeta
    };

    const dwpiQueue = pendingDwpiByTab.get(tabId);
    if (dwpiQueue && dwpiQueue.length > 0) {
      const dwpiItem = dwpiQueue.shift();
      if (dwpiItem?.timer) clearTimeout(dwpiItem.timer);
      if (dwpiQueue.length === 0) pendingDwpiByTab.delete(tabId);

      void enqueueCapturePair({
        ...pairWithMeta,
        dwpiText: dwpiItem?.dwpiText ?? "",
        dwpiMeta: dwpiItem?.dwpiMeta ?? null,
        captureMeta: pairWithMeta.captureMeta || dwpiItem?.captureMeta || getCaptureMetaForTab(tabId)
      });
      return;
    }

    const bundleId = pairWithMeta.bundleId || makeId("pair");
    const queue = getPendingBpQueue(tabId);
    const bundled = { ...pairWithMeta, bundleId };
    bundled.timer = setTimeout(() => {
      const targetQueue = pendingBpPairByTab.get(tabId);
      if (!targetQueue) return;
      const idx = targetQueue.findIndex((x) => x.bundleId === bundleId);
      if (idx === -1) return;

      const [expired] = targetQueue.splice(idx, 1);
      if (targetQueue.length === 0) pendingBpPairByTab.delete(tabId);
      void enqueueCapturePair({ ...expired, dwpiText: "", dwpiMeta: null });
    }, DWPI_PAIR_WAIT_MS);
    queue.push(bundled);
  }

  function stagePendingDwpi(tabId, dwpiMeta, dwpiText) {
    const captureMeta = getCaptureMetaForTab(tabId);
    const bpQueue = pendingBpPairByTab.get(tabId);
    if (bpQueue && bpQueue.length > 0) {
      const pair = bpQueue.shift();
      if (pair?.timer) clearTimeout(pair.timer);
      if (bpQueue.length === 0) pendingBpPairByTab.delete(tabId);

      void enqueueCapturePair({
        ...pair,
        dwpiMeta,
        dwpiText,
        captureMeta: pair?.captureMeta || captureMeta
      });
      return;
    }

    const queue = getPendingDwpiQueue(tabId);
    const dwpiItem = {
      dwpiMeta,
      dwpiText,
      captureMeta,
      timer: null
    };
    dwpiItem.timer = setTimeout(() => {
      const targetQueue = pendingDwpiByTab.get(tabId);
      if (!targetQueue) return;
      const idx = targetQueue.indexOf(dwpiItem);
      if (idx !== -1) targetQueue.splice(idx, 1);
      if (targetQueue.length === 0) pendingDwpiByTab.delete(tabId);
    }, DWPI_PAIR_WAIT_MS);
    queue.push(dwpiItem);
  }

  async function flushPendingPairsForTab(tabId) {
    const bpQueue = pendingBpPairByTab.get(tabId);
    pendingBpPairByTab.delete(tabId);
    if (Array.isArray(bpQueue)) {
      for (const pair of bpQueue) {
        if (pair?.timer) clearTimeout(pair.timer);
        await enqueueCapturePair({ ...pair, dwpiText: "", dwpiMeta: null });
      }
    }

    const dwpiQueue = pendingDwpiByTab.get(tabId);
    pendingDwpiByTab.delete(tabId);
    if (Array.isArray(dwpiQueue)) {
      for (const item of dwpiQueue) {
        if (item?.timer) clearTimeout(item.timer);
      }
    }
  }

  async function attachDebugger(tabId, options = {}) {
    const target = { tabId };
    const rootTabId = Number.isInteger(options?.rootTabId)
      ? options.rootTabId
      : getCaptureRootTabId(tabId);
    const attachedVia = toAttachedVia(options?.attachedVia);
    const derived = options?.derived === true || tabId !== rootTabId;

    if (attachedTabs.get(tabId)?.attached) {
      const prevMeta = attachedTabs.get(tabId) || {};
      attachedTabs.set(tabId, {
        ...prevMeta,
        attached: true,
        rootTabId,
        attachedVia,
        derived
      });
      captureRootByTab.set(tabId, rootTabId);
      clearDerivedAttachRetryState(tabId);
      recordAttachedTab(tabId);
      return;
    }
    if (attachingTabs.has(tabId)) return;
    attachingTabs.add(tabId);

    let attached = false;
    try {
      await chrome.debugger.attach(target, "1.3");
      attached = true;
      attachedTabs.set(tabId, {
        attached: true,
        rootTabId,
        attachedAt: Date.now(),
        attachedVia,
        derived
      });
      captureRootByTab.set(tabId, rootTabId);
      clearDerivedAttachRetryState(tabId);
      recordAttachedTab(tabId);

      try {
        await chrome.debugger.sendCommand(target, "Network.enable", {
          maxTotalBufferSize: NETWORK_ENABLE_MAX_TOTAL_BUFFER_SIZE,
          maxResourceBufferSize: NETWORK_ENABLE_MAX_RESOURCE_BUFFER_SIZE,
          maxPostDataSize: NETWORK_ENABLE_MAX_POST_DATA_SIZE,
          enableDurableMessages: true
        });
      } catch {
        await chrome.debugger.sendCommand(target, "Network.enable", {
          maxTotalBufferSize: NETWORK_ENABLE_MAX_TOTAL_BUFFER_SIZE,
          maxResourceBufferSize: NETWORK_ENABLE_MAX_RESOURCE_BUFFER_SIZE,
          maxPostDataSize: NETWORK_ENABLE_MAX_POST_DATA_SIZE
        });
      }
      if (!pendingByTab.has(tabId)) pendingByTab.set(tabId, new Map());
      console.debug("K-Research capture: attach success", {
        tabId,
        rootTabId,
        attachedVia,
        derived
      });
    } catch (error) {
      if (attached) {
        try {
          await chrome.debugger.detach(target);
        } catch {}
      }
      clearTabCaptureState(tabId);
      throw error;
    } finally {
      attachingTabs.delete(tabId);
    }
  }

  async function detachDebugger(tabId) {
    const target = { tabId };
    const wasAttached = attachedTabs.get(tabId)?.attached;
    try {
      if (wasAttached) {
        await flushPendingPairsForTab(tabId);
        try {
          await chrome.debugger.detach(target);
        } catch {}
      }
    } finally {
      clearTabCaptureState(tabId);
    }
  }

  function getCaptureScopeTabIds(tabId) {
    const rootTabId = getCaptureRootTabId(tabId);
    const scoped = [];
    for (const [trackedTabId, trackedRootTabId] of captureRootByTab.entries()) {
      if (trackedRootTabId === rootTabId) scoped.push(trackedTabId);
    }
    if (scoped.length === 0) scoped.push(rootTabId);
    return Array.from(new Set(scoped));
  }

  async function detachCaptureScope(tabId) {
    const scopedTabIds = getCaptureScopeTabIds(tabId);
    for (const scopedTabId of scopedTabIds) {
      await detachDebugger(scopedTabId);
    }
  }

  function clearDerivedAttachRetryState(tabId) {
    const current = derivedAttachRetryStateByTab.get(tabId);
    if (current?.timer) {
      clearTimeout(current.timer);
    }
    derivedAttachRetryStateByTab.delete(tabId);
  }

  function scheduleDerivedAttachRetry(tabId, attempt = 0) {
    if (!Number.isInteger(tabId)) return;
    if (attachedTabs.get(tabId)?.attached) {
      clearDerivedAttachRetryState(tabId);
      return;
    }
    if (attempt >= DERIVED_ATTACH_RETRY_DELAYS_MS.length) return;

    const existing = derivedAttachRetryStateByTab.get(tabId);
    if (existing && Number(existing.attempt || 0) >= attempt) {
      return;
    }
    if (existing?.timer) {
      clearTimeout(existing.timer);
    }

    const delayMs = Number(DERIVED_ATTACH_RETRY_DELAYS_MS[attempt] || 0);
    const timer = setTimeout(() => {
      const live = derivedAttachRetryStateByTab.get(tabId);
      if (!live || live.timer !== timer) return;
      derivedAttachRetryStateByTab.delete(tabId);

      void chrome.tabs
        .get(tabId)
        .then((tab) => maybeAttachDerivedTab(tab))
        .then(() => {
          if (attachedTabs.get(tabId)?.attached) {
            clearDerivedAttachRetryState(tabId);
            return;
          }
          scheduleDerivedAttachRetry(tabId, attempt + 1);
        })
        .catch(() => {
          scheduleDerivedAttachRetry(tabId, attempt + 1);
        });
    }, Math.max(0, delayMs));

    derivedAttachRetryStateByTab.set(tabId, {
      attempt,
      timer
    });
  }

  function getActiveCaptureRootIds() {
    const rootIds = new Set();
    for (const [rootTabId, context] of captureContextByRootTab.entries()) {
      if (!Number.isInteger(rootTabId)) continue;
      if (context?.mode !== CAPTURE_MODE_CAPTURE_ONLY) continue;
      rootIds.add(rootTabId);
    }
    return Array.from(rootIds);
  }

  function getTabHost(rawUrl) {
    try {
      const u = new URL(String(rawUrl || ""));
      if (u.protocol !== "http:" && u.protocol !== "https:") return "";
      return String(u.host || "").trim().toLowerCase();
    } catch {
      return "";
    }
  }

  async function autoAttachCaptureOnlyTabs(force = false) {
    const now = Date.now();
    if (!force && (now - lastAutoAttachAt) < AUTO_ATTACH_THROTTLE_MS) return;
    lastAutoAttachAt = now;

    const captureRoots = getActiveCaptureRootIds();
    if (!Array.isArray(captureRoots) || captureRoots.length === 0) return;

    const allTabs = await chrome.tabs.query({});
    const tabById = new Map(
      allTabs
        .filter((tab) => Number.isInteger(tab?.id))
        .map((tab) => [tab.id, tab])
    );

    for (const rootTabId of captureRoots) {
      const rootTab = tabById.get(rootTabId) || await chrome.tabs.get(rootTabId).catch(() => null);
      if (!rootTab) continue;

      const rootWindowId = Number.isInteger(rootTab?.windowId)
        ? rootTab.windowId
        : captureRootWindowIdByRootTab.get(rootTabId);
      const rootHost = getTabHost(rootTab?.url);

      for (const tab of allTabs) {
        const tabId = tab?.id;
        if (!Number.isInteger(tabId)) continue;
        if (tabId === rootTabId) continue;
        if (attachedTabs.get(tabId)?.attached) continue;
        if (attachingTabs.has(tabId)) continue;

        const url = String(tab?.url || "").trim();
        const attachable = !url || url.startsWith("about:") || isCapturableTabUrl(url);
        if (!attachable) continue;

        const openerTabId = Number.isInteger(tab?.openerTabId) ? tab.openerTabId : null;
        const openerRootId = Number.isInteger(openerTabId) ? getCaptureRootTabId(openerTabId) : null;
        const openerLinked = Number.isInteger(openerRootId) && openerRootId === rootTabId;

        const sameWindow = Number.isInteger(rootWindowId)
          && Number.isInteger(tab?.windowId)
          && tab.windowId === rootWindowId;
        const tabHost = getTabHost(url);
        const sameHost = !!rootHost && !!tabHost && tabHost === rootHost;
        const aboutPage = url.startsWith("about:");

        if (!openerLinked && !sameWindow && !sameHost && !aboutPage) continue;

        try {
          await attachDebugger(tabId, {
            rootTabId,
            attachedVia: ATTACHED_VIA_AUTO,
            derived: true
          });
          console.debug("K-Research capture: auto attach success", {
            rootTabId,
            tabId,
            openerLinked,
            sameWindow,
            sameHost
          });
        } catch (error) {
          console.warn("K-Research capture: auto attach failed", {
            rootTabId,
            tabId,
            error: error?.message || String(error)
          });
        }
      }
    }
  }

  async function attachCaptureTab(rootTabId, targetTabId) {
    if (!Number.isInteger(rootTabId) || !Number.isInteger(targetTabId)) {
      throw new Error("Invalid root/target tab ID");
    }

    const rootContext = captureContextByRootTab.get(rootTabId);
    if (!rootContext || rootContext.mode !== CAPTURE_MODE_CAPTURE_ONLY) {
      throw new Error("Capture root is not active");
    }

    if (targetTabId === rootTabId) {
      return { attached: false, reason: "root_tab" };
    }

    const targetTab = await chrome.tabs.get(targetTabId);
    const url = String(targetTab?.url || "").trim();
    const attachable = !url || url.startsWith("about:") || isCapturableTabUrl(url);
    if (!attachable) {
      throw new Error("Target tab is not capturable");
    }

    await withTimeout(attachDebugger(targetTabId, {
      rootTabId,
      attachedVia: ATTACHED_VIA_MANUAL,
      derived: targetTabId !== rootTabId
    }), 5000, "attachDebugger(derived)");
    console.debug("K-Research capture: manual attach success", {
      rootTabId,
      tabId: targetTabId
    });
    return {
      attached: true,
      rootTabId,
      tabId: targetTabId,
      attachedVia: ATTACHED_VIA_MANUAL
    };
  }

  async function maybeAttachDerivedTab(tab) {
    const tabId = tab?.id;
    if (!Number.isInteger(tabId)) return;
    if (attachedTabs.get(tabId)?.attached) return;
    if (attachingTabs.has(tabId)) return;

    const openerTabId = tab?.openerTabId;
    let rootTabId = Number.isInteger(openerTabId) ? captureRootByTab.get(openerTabId) : null;

    if (!Number.isInteger(rootTabId) && Number.isInteger(tab?.windowId)) {
      const rootsInSameWindow = [];
      for (const [candidateRootId, windowId] of captureRootWindowIdByRootTab.entries()) {
        if (!Number.isInteger(candidateRootId)) continue;
        if (windowId !== tab.windowId) continue;
        if (!captureContextByRootTab.has(candidateRootId) && !captureRunIdByRootTab.has(candidateRootId)) continue;
        rootsInSameWindow.push(candidateRootId);
      }
      if (rootsInSameWindow.length === 1) {
        rootTabId = rootsInSameWindow[0];
      }
    }

    if (!Number.isInteger(rootTabId)) {
      const activeRootIds = getActiveCaptureRootIds();
      if (activeRootIds.length !== 1) return;
      rootTabId = activeRootIds[0];
    }
    if (!Number.isInteger(rootTabId)) return;

    try {
      await attachDebugger(tabId, {
        rootTabId,
        attachedVia: ATTACHED_VIA_AUTO,
        derived: tabId !== rootTabId
      });
      clearDerivedAttachRetryState(tabId);
      console.debug("K-Research capture: derived attach success", {
        rootTabId,
        tabId
      });
    } catch (error) {
      console.warn("K-Research capture: derived auto attach failed", {
        rootTabId,
        tabId,
        error: error?.message || String(error)
      });
      scheduleDerivedAttachRetry(tabId, 0);
    }
  }

  globalThis.__KRESEARCH_CAPTURE_TEST_API__ = {
    buildCaptureRowFromPair,
    normalizeCaptureRow,
    createCaptureDiagnosticsState,
    getCaptureDiagnosticsSnapshot,
    normalizePriorityHint,
    shouldCaptureBpPair,
    getTrackedRequestKind,
    isKResearchTargetBpRequest,
    shouldTrackRequestKindForTab,
    extractFallbackCitationTextFromPayload,
    resolveCitationTextForCapture,
    looksLikeApplicationNo,
    resolveCapturedApplicationNo,
    __testRecordAttachedTab: recordAttachedTab,
    __testRecordDiscard: recordDiscard,
    __testRecordStoredRow: recordStoredRow,
    __testResetDiagnostics: resetCaptureDiagnostics,
    __testSetAttachedTabMeta: setAttachedTabMetaForTest,
    __testClearAttachedTabs: clearAttachedTabsForTest,
    constants: {
      CAPTURE_SCOPE_ROOT,
      CAPTURE_SCOPE_DERIVED,
      ATTACHED_VIA_AUTO,
      ATTACHED_VIA_MANUAL,
      ATTACHED_VIA_UNKNOWN,
      PRIORITY_HINT_PRIMARY,
      PRIORITY_HINT_SECONDARY
    }
  };

  if (
    !globalThis.chrome
    || !chrome.debugger
    || !chrome.runtime
    || !chrome.tabs
    || !chrome.storage?.local
  ) {
    return;
  }

  chrome.debugger.onEvent.addListener(async (source, method, params) => {
    const tabId = source?.tabId;
    if (!Number.isInteger(tabId)) return;
    if (!attachedTabs.get(tabId)?.attached) return;

    if (method === "Network.requestWillBeSent") {
      const requestId = params?.requestId;
      const req = params?.request;
      const url = req?.url;
      if (!requestId || !url) return;
      const payloadRaw = req?.postData ?? "";

      const kind = getTrackedRequestKind(url, payloadRaw);
      if (!kind) return;
      if (!shouldTrackRequestKindForTab(tabId, kind)) return;
      if (kind === "bp") {
        captureDiagnostics.bpRequestsSeenCount += 1;
      }

      const map = pendingByTab.get(tabId);
      if (!map) return;

      const prev = map.get(requestId) ?? {};
      map.set(requestId, {
        ...prev,
        kind,
        url,
        method: req?.method ?? "",
        payload: payloadRaw,
        requestTs: Date.now()
      });
      return;
    }

    if (method === "Network.responseReceived") {
      const requestId = params?.requestId;
      if (!requestId) return;

      const map = pendingByTab.get(tabId);
      if (!map) return;

      const prev = map.get(requestId) ?? {};
      const url = params?.response?.url;
      const trackedKind = prev.kind || getTrackedRequestKind(url || "", prev?.payload ?? "");
      if (!trackedKind) return;
      if (!shouldTrackRequestKindForTab(tabId, trackedKind)) {
        map.delete(requestId);
        return;
      }

      map.set(requestId, {
        ...prev,
        kind: trackedKind,
        url: url || prev.url,
        status: params?.response?.status,
        mime: params?.response?.mimeType,
        ts: Date.now()
      });
      return;
    }

    if (method === "Network.loadingFinished") {
      const requestId = params?.requestId;
      if (!requestId) return;

      const map = pendingByTab.get(tabId);
      const meta = map?.get(requestId);
      if (!meta) return;

      map.delete(requestId);
      const bodyResult = await readResponseBodyText(tabId, requestId);
      const bodyText = String(bodyResult?.text || "");
      const captureMeta = getCaptureMetaForTab(tabId);

      if (meta.kind === "bp") {
        captureDiagnostics.bpLoadingFinishedCount += 1;
        const payloadRaw = meta.payload ?? "";
        const citationResolved = resolveCitationTextForCapture(bodyText, payloadRaw);
        const citationText = citationResolved.citationText;
        const applicationNo = resolveCapturedApplicationNo({
          payloadRaw,
          requestUrl: meta?.url ?? "",
          responseText: bodyText
        });
        const targetMatched = isPreferredKResearchBpHit(meta, bodyText);
        const captureDecision = resolveDiscardReasonForBpCapture({
          targetMatched,
          citationText,
          captureMeta,
          bodyResult,
          citationSource: citationResolved.source,
          meta
        });
        if (captureDecision.shouldCapture !== true) {
          const discardReason = String(captureDecision.reason || "other");
          recordDiscard(discardReason);
          console.debug("K-Research capture: bp row skipped", {
            tabId,
            url: meta?.url || "",
            captureScope: captureMeta?.captureScope || CAPTURE_SCOPE_ROOT,
            reason: discardReason,
            responseBodyOk: bodyResult?.ok === true,
            responseBodyError: bodyResult?.error || ""
          });
          return;
        }
        if (targetMatched !== true) {
          console.debug("K-Research capture: bp fallback capture accepted (targetMatched=false)", {
            tabId,
            url: meta?.url || "",
            captureScope: captureMeta?.captureScope || CAPTURE_SCOPE_ROOT
          });
        }
        if (citationResolved.source === "payload_fallback") {
          console.debug("K-Research capture: citation recovered from payload fallback", {
            tabId,
            url: meta?.url || "",
            targetMatched
          });
        }

        stagePendingBpPair(tabId, {
          bundleId: makeId("pair"),
          bpMeta: meta,
          payloadRaw,
          applicationNo,
          citationText,
          tabId,
          runId: getCaptureRunIdForTab(tabId),
          targetMatched,
          captureMeta
        });
        return;
      }

      if (meta.kind === "dwpi") {
        if (captureMeta?.derived === true) {
          return;
        }
        const dwpiText = extractDwpiOnly(bodyText);
        stagePendingDwpi(tabId, meta, dwpiText);
      }
      return;
    }

    if (method === "Network.loadingFailed") {
      const requestId = params?.requestId;
      if (!requestId) return;

      const map = pendingByTab.get(tabId);
      const meta = map?.get(requestId);
      if (meta) map.delete(requestId);

      if (meta?.kind === "dwpi") {
        const captureMeta = getCaptureMetaForTab(tabId);
        if (captureMeta?.derived === true) return;
        const bpQueue = pendingBpPairByTab.get(tabId);
        if (bpQueue && bpQueue.length > 0) {
          const pair = bpQueue.shift();
          if (pair?.timer) clearTimeout(pair.timer);
          if (bpQueue.length === 0) pendingBpPairByTab.delete(tabId);
          await enqueueCapturePair({ ...pair, dwpiText: "", dwpiMeta: null });
        }
      }
    }
  });

  chrome.debugger.onDetach.addListener((source) => {
    const tabId = source?.tabId;
    if (!Number.isInteger(tabId)) return;
    clearTabCaptureState(tabId);
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const type = String(msg?.type || "");
    if (
      type !== "KRESEARCH_START_CAPTURE"
      && type !== "KRESEARCH_STOP_CAPTURE"
      && type !== "KRESEARCH_GET_CAPTURED_ROWS"
      && type !== "KRESEARCH_GET_CAPTURE_STATUS"
      && type !== "KRESEARCH_GET_CAPTURE_DIAGNOSTICS"
      && type !== "KRESEARCH_CLEAR_CAPTURE_HISTORY"
      && type !== "KRESEARCH_ATTACH_TAB"
    ) {
      return undefined;
    }

    (async () => {
      if (type === "KRESEARCH_GET_CAPTURED_ROWS") {
        const runId = normalizeRunId(msg?.runId);
        const rows = await getCapturedRowsByRunId(runId);
        sendResponse({
          ok: true,
          runId: runId || "",
          count: rows.length,
          rows
        });
        return;
      }

      if (type === "KRESEARCH_GET_CAPTURE_STATUS") {
        const runId = normalizeRunId(msg?.runId);
        await autoAttachCaptureOnlyTabs(false).catch(() => {});
        const status = await getCaptureStatusByRunId(runId, msg?.limit);
        sendResponse({
          ok: true,
          runId: runId || "",
          count: status.count,
          rows: status.rows
        });
        return;
      }

      if (type === "KRESEARCH_GET_CAPTURE_DIAGNOSTICS") {
        const runId = normalizeRunId(msg?.runId);
        await autoAttachCaptureOnlyTabs(false).catch(() => {});
        sendResponse({
          ok: true,
          runId: runId || "",
          diagnostics: getCaptureDiagnosticsSnapshot()
        });
        return;
      }

      if (type === "KRESEARCH_CLEAR_CAPTURE_HISTORY") {
        const runId = normalizeRunId(msg?.runId);
        const cleared = await clearCaptureHistory({ runId });
        sendResponse({
          ok: true,
          runId: runId || "",
          ...cleared
        });
        return;
      }

      if (type === "KRESEARCH_ATTACH_TAB") {
        const requestedRootTabId = Number.isInteger(msg?.rootTabId) ? msg.rootTabId : null;
        const requestedTabId = Number.isInteger(msg?.tabId) ? msg.tabId : null;

        let rootTabId = requestedRootTabId;
        if (!Number.isInteger(rootTabId)) {
          const roots = getActiveCaptureRootIds();
          if (roots.length !== 1) {
            throw new Error("Unable to resolve capture root");
          }
          rootTabId = roots[0];
        }

        let targetTabId = requestedTabId;
        if (!Number.isInteger(targetTabId)) {
          const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          targetTabId = Number.isInteger(activeTabs?.[0]?.id) ? activeTabs[0].id : null;
        }
        if (!Number.isInteger(targetTabId)) {
          throw new Error("Unable to resolve target tab");
        }

        const attached = await attachCaptureTab(rootTabId, targetTabId);
        sendResponse({ ok: true, ...attached });
        return;
      }

      const tabId = msg?.tabId;
      if (!Number.isInteger(tabId)) {
        throw new Error("Invalid tab ID");
      }

      if (type === "KRESEARCH_START_CAPTURE") {
        const tab = await chrome.tabs.get(tabId);
        const tabUrl = String(tab?.url || "");
        if (!isCapturableTabUrl(tabUrl)) {
          throw new Error("Capture requires an HTTP/HTTPS tab.");
        }

        resetCaptureDiagnostics();

        await withTimeout(attachDebugger(tabId, {
          rootTabId: tabId,
          attachedVia: ATTACHED_VIA_MANUAL,
          derived: false
        }), 5000, "attachDebugger");

        const runId = normalizeRunId(msg?.runId) || makeRunId("krun");
        const queryVersionId = normalizeQueryVersionId(msg?.queryVersionId);
        captureRunIdByRootTab.set(tabId, runId);
        if (Number.isInteger(tab?.windowId)) {
          captureRootWindowIdByRootTab.set(tabId, tab.windowId);
        }
        setCaptureContextForRoot(tabId, {
          mode: CAPTURE_MODE_CAPTURE_ONLY,
          runId,
          queryVersionId
        });

        await autoAttachCaptureOnlyTabs(true).catch(() => {});

        sendResponse({
          ok: true,
          runId,
          queryVersionId
        });
        return;
      }

      if (type === "KRESEARCH_STOP_CAPTURE") {
        await withTimeout(detachCaptureScope(tabId), 5000, "detachCaptureScope");
        sendResponse({ ok: true });
      }
    })().catch((error) => {
      sendResponse({
        ok: false,
        error: error?.message || String(error)
      });
    });

    return true;
  });

  chrome.tabs.onCreated.addListener((tab) => {
    void maybeAttachDerivedTab(tab);
    if (Number.isInteger(tab?.id)) {
      scheduleDerivedAttachRetry(tab.id, 0);
    }
    void autoAttachCaptureOnlyTabs(true).catch(() => {});
  });

  chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
    if (Number.isInteger(tab?.id)) {
      void maybeAttachDerivedTab(tab);
      scheduleDerivedAttachRetry(tab.id, 0);
      void autoAttachCaptureOnlyTabs(true).catch(() => {});
      return;
    }

    void chrome.tabs
      .get(tabId)
      .then((fullTab) => {
        void maybeAttachDerivedTab(fullTab);
        if (Number.isInteger(fullTab?.id)) {
          scheduleDerivedAttachRetry(fullTab.id, 0);
        }
        void autoAttachCaptureOnlyTabs(true).catch(() => {});
      })
      .catch(() => {});
  });

  chrome.tabs.onActivated.addListener(({ tabId }) => {
    if (!Number.isInteger(tabId)) return;
    void chrome.tabs
      .get(tabId)
      .then((tab) => {
        void maybeAttachDerivedTab(tab);
        scheduleDerivedAttachRetry(tabId, 0);
        void autoAttachCaptureOnlyTabs(true).catch(() => {});
      })
      .catch(() => {});
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    const rootTabId = captureRootByTab.get(tabId);
    if (rootTabId === tabId) {
      void detachCaptureScope(tabId);
    } else if (captureRootByTab.has(tabId) || attachedTabs.get(tabId)?.attached) {
      void detachDebugger(tabId);
    }
  });
})();
