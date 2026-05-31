const KSCAN_DEFAULT_WEBUI_BASE_URL = "https://llm.moip.go.kr";
const CHAT_COMPLETIONS_PATH = "/api/chat/completions";
const FALLBACK_MODEL_NAME = String(
  globalThis.KSUITE_DEFAULT_LLM_MODEL || "gemma-26b-moe"
).trim() || "gemma-26b-moe";
const HISTORY_KEY = "bp_history_v1";
const QUEUE_STATUS_KEY = "kscan_queue_status_v1";
const EVALUATED_APPNOS_LEGACY_KEY = "kscan_evaluated_appnos_v1";
const EVALUATED_DEDUPE_KEYS_KEY = "kscan_evaluated_keys_v2";
const RESULT_PAGE_PATH = "modules/k-scan/result.html";
const BP_SERVICE_PATH = "/bpService.do";
const DWPI_ABST_PATH = "/getDWPIAbst.do";
const MAX_CAPTURE_ROWS = 3000;
const DWPI_PAIR_WAIT_MS = 3000;
const EMPTY_DWPI_INFO_TEXT = "No DWPI information";
const MAX_PARALLEL_EVAL = 12;
const KQUERY_ACTIVE_QUERY_VERSION_KEY = "kquery_active_query_version_v1";
const KQUERY_LATEST_ARTIFACT_KEY = "kquery_latest_artifact_v1";
const KRESEARCH_CAPTURE_HISTORY_KEY = "kresearch_capture_history_v1";
const KRESEARCH_MAX_CAPTURE_ROWS = 3000;
const CAPTURE_MODE_LEGACY = "legacy_eval";
const CAPTURE_MODE_CAPTURE_ONLY = "capture_only";

let resultWindowId = null;

// tabId -> { attached: boolean }
const attachedTabs = new Map();
// tabId -> rootTabId (START_CAPTURE를 받은 기준 탭)
const captureRootByTab = new Map();
// attach 중복 호출 방지용 플래그
const attachingTabs = new Set();

// tabId -> Map(requestId -> meta)
const pending = new Map();

// tabId -> Array<{ bundleId, bpMeta, payloadRaw, applicationNo, citationText, timer }>
const pendingBpPairByTab = new Map();

// tabId -> Array<{ dwpiMeta, dwpiText, timer }>
const pendingDwpiByTab = new Map();

// 평가 작업 큐
const evaluationQueue = [];
let evaluationRunning = 0;
let evaluationCompleted = 0;
let evaluationCycleActive = false;

// dedupe key(queryVersionId::applicationNo or runId::applicationNo) 추적용 집합
const scheduledEvaluationKeys = new Set();
const evaluatedEvaluationKeys = new Set();
const reevaluatingHistoryIds = new Set();
let evaluatedLoaded = false;
let evaluatedLoadPromise = null;
const captureRunIdByRootTab = new Map();
const captureContextByRootTab = new Map();
const captureRootWindowIdByRootTab = new Map();
let lastCaptureOnlyAutoAttachAt = 0;

// 짧은 시간에 같은 pair가 반복되는 경우 중복 enqueue 방지
const lastSeenByTab = new Map(); // tabId -> { sig, ts }


const TEMPLATE_KEY = "prompt_template";
const DEFAULT_TEMPLATE_PATH = "modules/k-scan/prompts/default.txt";
const DEFAULT_TEMPLATE_FALLBACK = [
  "출원발명:",
  "{출원발명}",
  "",
  "DWPI 정보(인용발명의 요약):",
  "{DWPI 정보}",
  "",
  "인용발명:",
  "{인용발명}"
].join("\n");
let defaultTemplatePromise = null;

// Initialize queue status at service-worker startup.
void chrome.storage.local.set({
  [QUEUE_STATUS_KEY]: {
    queued: 0,
    running: 0,
    completed: 0,
    active: false,
    ts: Date.now()
  }
}).catch(() => {});

function isCapturableTabUrl(url) {
  if (typeof url !== "string") return false;
  return url.startsWith("http://") || url.startsWith("https://");
}

function getCaptureRootTabId(tabId) {
  const rootTabId = captureRootByTab.get(tabId);
  return Number.isInteger(rootTabId) ? rootTabId : tabId;
}

function setCaptureContextForRoot(rootTabId, context = {}) {
  if (!Number.isInteger(rootTabId)) return;
  const mode = context?.mode === CAPTURE_MODE_CAPTURE_ONLY
    ? CAPTURE_MODE_CAPTURE_ONLY
    : CAPTURE_MODE_LEGACY;
  const runId = normalizeRunId(context?.runId);
  const queryVersionId = normalizeQueryVersionId(context?.queryVersionId);
  captureContextByRootTab.set(rootTabId, {
    mode,
    runId,
    queryVersionId
  });
}

function getCaptureContextForTab(tabId) {
  const rootTabId = getCaptureRootTabId(tabId);
  const context = captureContextByRootTab.get(rootTabId);
  if (!context || typeof context !== "object") {
    return {
      mode: CAPTURE_MODE_LEGACY,
      runId: normalizeRunId(captureRunIdByRootTab.get(rootTabId)),
      queryVersionId: ""
    };
  }
  return {
    mode: context.mode === CAPTURE_MODE_CAPTURE_ONLY
      ? CAPTURE_MODE_CAPTURE_ONLY
      : CAPTURE_MODE_LEGACY,
    runId: normalizeRunId(context.runId) || normalizeRunId(captureRunIdByRootTab.get(rootTabId)),
    queryVersionId: normalizeQueryVersionId(context.queryVersionId)
  };
}

function clearTabCaptureState(tabId) {
  const rootTabId = getCaptureRootTabId(tabId);
  attachedTabs.delete(tabId);
  captureRootByTab.delete(tabId);
  attachingTabs.delete(tabId);
  pending.delete(tabId);
  pendingBpPairByTab.delete(tabId);
  pendingDwpiByTab.delete(tabId);
  lastSeenByTab.delete(tabId);
  if (rootTabId === tabId) {
    captureRunIdByRootTab.delete(rootTabId);
    captureContextByRootTab.delete(rootTabId);
    captureRootWindowIdByRootTab.delete(rootTabId);
  }
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} 타임아웃(${timeoutMs}ms)`));
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

async function getApiUrl() {
  const data = await chrome.storage.local.get(["webuiBaseUrl"]);
  const baseUrl = String(data.webuiBaseUrl || KSCAN_DEFAULT_WEBUI_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  return `${baseUrl}${CHAT_COMPLETIONS_PATH}`;
}

function getDefaultTemplate() {
  if (!defaultTemplatePromise) {
    defaultTemplatePromise = fetch(chrome.runtime.getURL(DEFAULT_TEMPLATE_PATH))
      .then((res) => (res.ok ? res.text() : DEFAULT_TEMPLATE_FALLBACK))
      .catch(() => DEFAULT_TEMPLATE_FALLBACK);
  }
  return defaultTemplatePromise;
}

function normalizeCapturedText(text) {
  return (text ?? "")
    .toString()
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function stripHtmlTags(text) {
  return String(text ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(
      /<\/?(?:p|div|li|tr|td|th|h[1-6]|ul|ol|table|tbody|thead|tfoot|section|article|header|footer|main|nav|pre)\b[^>]*>/gi,
      "\n"
    )
    // 남아있는 임의 HTML/XML 태그를 최종 제거
    .replace(/<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s+[^<>]*?)?>/g, " ");
}

function sanitizeExtractedText(text) {
  return normalizeCapturedText(stripHtmlTags(text));
}

function extractClaimOnly(text) {
  return sanitizeExtractedText(text);
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
        typeof value === "string" &&
        keyPatterns.some((pattern) => pattern.test(key)) &&
        value.trim()
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

function looksLikeApplicationNo(token) {
  const value = String(token ?? "").trim();
  if (!value) return false;
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
      "docNo",
      "id"
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
  if (looksLikeApplicationNo(labeled)) {
    return labeled;
  }

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

function applyTemplate(tpl, applicationText, citationText, dwpiText) {
  const t = (tpl && tpl.trim()) ? tpl : DEFAULT_TEMPLATE_FALLBACK;
  const hasDwpiPlaceholder =
    t.includes("{DWPI 정보}") ||
    t.includes("{DWPI정보}") ||
    t.includes("{dwpi_info}");

  let template = t;
  if (!hasDwpiPlaceholder) {
    if (template.includes("{인용발명}")) {
      template = template.replace(
        "{인용발명}",
        "DWPI 정보(인용발명의 요약):\n{DWPI 정보}\n\n인용발명:\n{인용발명}"
      );
    } else {
      template += "\n\nDWPI 정보(인용발명의 요약):\n{DWPI 정보}";
    }
  }

  return template
    .replaceAll("{출원발명}", applicationText ?? "")
    .replaceAll("{인용발명}", citationText ?? "")
    .replaceAll("{DWPI 정보}", dwpiText ?? "")
    .replaceAll("{DWPI정보}", dwpiText ?? "")
    // Legacy mojibake placeholder compatibility.
    .replaceAll("{???????????????깅♥???饔낅떽???????", applicationText ?? "")
    .replaceAll("{??耀붾굝???????????援??????關履???", citationText ?? "")
    .replaceAll("{DWPI ??耀붾굝?????????", dwpiText ?? "")
    .replaceAll("{DWPI??耀붾굝?????????", dwpiText ?? "")
    .replaceAll("{dwpi_info}", dwpiText ?? "");
}

async function updateHistoryById(id, patch) {
  const data = await chrome.storage.local.get([HISTORY_KEY]);
  const arr = Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
  const idx = arr.findIndex(x => x && x.id === id);
  if (idx === -1) return;

  arr[idx] = { ...arr[idx], ...patch };
  await chrome.storage.local.set({ [HISTORY_KEY]: arr });
}

function makeId() {
  // ??????ル뭽????unique id
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function getTrackedRequestKind(url) {
  try {
    const u = new URL(url);
    const path = String(u.pathname || "").toLowerCase();
    const normalized = path.replace(/\/+$/g, "");
    const bpPattern = /\/bpservice\.do(?:[;/]|$)/i;
    const dwpiPattern = /\/getdwpiabst\.do(?:[;/]|$)/i;

    if (bpPattern.test(normalized) || normalized.endsWith(BP_SERVICE_PATH.toLowerCase())) {
      return "bp";
    }
    if (dwpiPattern.test(normalized) || normalized.endsWith(DWPI_ABST_PATH.toLowerCase())) {
      return "dwpi";
    }
    return null;
  } catch {
    return null;
  }
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

function parseSearchParamCaseInsensitive(searchParams, keyName) {
  if (!searchParams || typeof searchParams.entries !== "function") return "";
  const target = String(keyName || "").trim().toLowerCase();
  for (const [rawKey, rawValue] of searchParams.entries()) {
    if (String(rawKey || "").trim().toLowerCase() !== target) continue;
    return String(rawValue || "").trim();
  }
  return "";
}

function payloadHasSkgmTargetId(payloadRaw) {
  const raw = decodeMaybeURIComponent(String(payloadRaw || ""));
  if (!raw) return false;
  const normalized = raw.replace(/\s+/g, "").toUpperCase();
  if (!normalized.includes("SKGM010500")) return false;
  if (/[\?&;]ID=(?:\/)?SKGM010500(?:[&#;]|$)/i.test(normalized)) return true;
  if (/["']ID["']\s*:\s*["'](?:\/)?SKGM010500["']/i.test(raw)) return true;
  if (/[\u001F]ID(?:\/)?SKGM010500(?:[\u001F]|$)/i.test(raw)) return true;
  return normalized.includes("SKGM010500");
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
      const normalized = normalizeSkgmServiceId(rawId);
      if (normalized === "SKGM010500") return true;
    }

    return payloadHasSkgmTargetId(payloadRaw);
  } catch {
    return payloadHasSkgmTargetId(payloadRaw);
  }
}

function isKResearchTargetBpCaptured(meta, responseText = "") {
  if (isKResearchTargetBpRequest(meta?.url || "", meta?.payload || "")) {
    return true;
  }
  const normalizedResponse = String(responseText || "").replace(/\s+/g, "").toUpperCase();
  return normalizedResponse.includes("SKGM010500");
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

function isSameModuleUrl(tabUrl, targetUrl) {
  if (typeof tabUrl !== "string") return false;
  return tabUrl === targetUrl || tabUrl.startsWith(`${targetUrl}?`) || tabUrl.startsWith(`${targetUrl}#`);
}

async function getAllResultTabs() {
  const targetUrl = chrome.runtime.getURL(RESULT_PAGE_PATH);
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => isSameModuleUrl(String(tab?.url || ""), targetUrl));
}

async function dedupeExistingResultWindows() {
  let resultTabs = [];
  try {
    resultTabs = await getAllResultTabs();
  } catch {
    return;
  }

  if (resultTabs.length === 0) {
    resultWindowId = null;
    return;
  }

  const primary = resultTabs.find((tab) => tab.windowId === resultWindowId) || resultTabs[0];
  if (Number.isInteger(primary?.windowId)) {
    resultWindowId = primary.windowId;
  }

  const duplicateTabIds = resultTabs
    .filter((tab) => Number.isInteger(tab?.id) && tab.id !== primary.id)
    .map((tab) => tab.id);

  if (duplicateTabIds.length > 0) {
    try {
      await chrome.tabs.remove(duplicateTabIds);
    } catch {}
  }
}

async function openOrFocusResultWindow() {
  await dedupeExistingResultWindows();

  try {
    const resultTabs = await getAllResultTabs();
    if (resultTabs.length > 0) {
      const primary = resultTabs.find((tab) => tab.windowId === resultWindowId) || resultTabs[0];

      if (Number.isInteger(primary?.windowId)) {
        try {
          await chrome.windows.update(primary.windowId, { focused: true });
        } catch {}
        resultWindowId = primary.windowId;
      }

      if (Number.isInteger(primary?.id)) {
        try {
          await chrome.tabs.update(primary.id, { active: true });
        } catch {}
      }
      return;
    }
  } catch {}

  const w = await chrome.windows.create({
    url: chrome.runtime.getURL(RESULT_PAGE_PATH),
    type: "popup",
    width: 720,
    height: 780
  });
  resultWindowId = w.id;
}

void dedupeExistingResultWindows().catch(() => {});

async function pushHistory(item) {
  const data = await chrome.storage.local.get([HISTORY_KEY]);
  const arr = Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
  arr.unshift(item);
  if (arr.length > MAX_CAPTURE_ROWS) {
    arr.length = MAX_CAPTURE_ROWS;
  }
  await chrome.storage.local.set({ [HISTORY_KEY]: arr });
}

async function pushKResearchCaptureRow(item) {
  const data = await chrome.storage.local.get([KRESEARCH_CAPTURE_HISTORY_KEY]);
  const arr = Array.isArray(data[KRESEARCH_CAPTURE_HISTORY_KEY])
    ? data[KRESEARCH_CAPTURE_HISTORY_KEY]
    : [];
  arr.unshift(item);
  if (arr.length > KRESEARCH_MAX_CAPTURE_ROWS) {
    arr.length = KRESEARCH_MAX_CAPTURE_ROWS;
  }
  await chrome.storage.local.set({ [KRESEARCH_CAPTURE_HISTORY_KEY]: arr });
}

async function getKResearchCapturedRowsByRunId(runId) {
  const normalizedRunId = normalizeRunId(runId);
  const data = await chrome.storage.local.get([KRESEARCH_CAPTURE_HISTORY_KEY]);
  const arr = Array.isArray(data[KRESEARCH_CAPTURE_HISTORY_KEY])
    ? data[KRESEARCH_CAPTURE_HISTORY_KEY]
    : [];

  if (!normalizedRunId) return arr;
  return arr.filter((item) => normalizeRunId(item?.runId) === normalizedRunId);
}

async function getKResearchCaptureStatusByRunId(runId, limit = 40) {
  const rows = await getKResearchCapturedRowsByRunId(runId);
  const normalizedLimit = Math.max(1, Math.min(200, Number.isFinite(Number(limit)) ? Number(limit) : 40));
  const preview = rows.slice(0, normalizedLimit).map((row, index) => ({
    resultId: String(row?.id || `cap_${index + 1}`),
    applicationNo: normalizeApplicationNo(row?.applicationNo) || "-",
    status: "captured",
    index
  }));

  return {
    count: rows.length,
    rows: preview
  };
}

function extractAssistantText(apiJson) {
  try {
    const c = apiJson?.choices?.[0];
    const content = c?.message?.content;
    if (typeof content === "string") return content;
  } catch {}
  try {
    return JSON.stringify(apiJson, null, 2);
  } catch {
    return String(apiJson);
  }
}

async function getConfiguredModelName() {
  if (typeof globalThis.KSUITE_GET_SHARED_SETTINGS === "function") {
    try {
      const sharedSettings = await globalThis.KSUITE_GET_SHARED_SETTINGS();
      const configuredModel = String(sharedSettings?.defaultModel || "").trim();
      if (configuredModel) return configuredModel;
    } catch (error) {
      console.warn("[K-SCAN] Failed to read shared model setting:", error);
    }
  }

  return FALLBACK_MODEL_NAME;
}

async function callLocalChatApi(token, content) {
  const headers = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json"
  };
  const body = {
    model: await getConfiguredModelName(),
    messages: [{ role: "user", content }]
  };

  const res = await fetch(await getApiUrl(), {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  const json = await res.json();
  return { status: res.status, ok: res.ok, json };
}

async function readResponseBodyText(tabId, requestId) {
  try {
    const r = await chrome.debugger.sendCommand(
      { tabId },
      "Network.getResponseBody",
      { requestId }
    );
    return decodeBody(r?.body, r?.base64Encoded);
  } catch (error) {
    return `getResponseBody 호출 실패: ${String(error?.message ?? error)}`;
  }
}

function normalizeApplicationNo(raw) {
  return String(raw ?? "").trim();
}

function normalizeQueryVersionId(raw) {
  return String(raw ?? "").trim();
}

function normalizeRunId(raw) {
  return String(raw ?? "").trim();
}

function normalizeHistoryId(raw) {
  return String(raw ?? "").trim();
}

function makeRunId(prefix = "scan_run") {
  const base = Date.now().toString(36);
  const nonce = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${base}_${nonce}`;
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

function resolveHistoryCitationText(item) {
  const directCandidates = [
    item?.citationText,
    item?.citation_text,
    item?.citation,
    item?.citationBody
  ];
  for (const candidate of directCandidates) {
    const text = normalizeCapturedText(candidate);
    if (text) return text;
  }
  return extractFallbackCitationTextFromPayload(item?.payload);
}

function resolveHistoryDwpiText(item) {
  const directCandidates = [item?.dwpiText, item?.dwpi_text, item?.dwpi];
  for (const candidate of directCandidates) {
    const text = normalizeCapturedText(candidate);
    if (text) return text;
  }
  return "";
}

function buildEvaluationDedupeKey({ queryVersionId, runId, applicationNo }) {
  const appNo = normalizeApplicationNo(applicationNo);
  if (!appNo) return "";

  const normalizedQueryVersionId = normalizeQueryVersionId(queryVersionId);
  if (normalizedQueryVersionId) {
    return `${normalizedQueryVersionId}::${appNo}`;
  }

  const normalizedRunId = normalizeRunId(runId);
  if (normalizedRunId) {
    return `${normalizedRunId}::${appNo}`;
  }

  return `legacy::${appNo}`;
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

async function resolveCurrentQueryVersionId() {
  try {
    const data = await chrome.storage.local.get([
      KQUERY_ACTIVE_QUERY_VERSION_KEY,
      KQUERY_LATEST_ARTIFACT_KEY
    ]);
    const active = normalizeQueryVersionId(data[KQUERY_ACTIVE_QUERY_VERSION_KEY]);
    if (active) return active;
    return normalizeQueryVersionId(data[KQUERY_LATEST_ARTIFACT_KEY]?.queryVersionId);
  } catch {
    return "";
  }
}

function resolveHistoryFallbackRunId(item) {
  const runId = normalizeRunId(item?.runId);
  if (runId) return runId;
  const timeText = String(item?.time ?? "").trim();
  if (timeText) {
    const suffix = timeText.replace(/[^0-9A-Za-z]+/g, "_").replace(/^_+|_+$/g, "");
    if (suffix) return `legacy_${suffix}`;
  }
  return "legacy";
}

function rebuildEvaluatedFromHistory(history) {
  evaluatedEvaluationKeys.clear();
  const arr = Array.isArray(history) ? history : [];
  for (const item of arr) {
    if (item?.apiOk !== true) continue;
    const key = buildEvaluationDedupeKey({
      queryVersionId: item?.queryVersionId,
      runId: resolveHistoryFallbackRunId(item),
      applicationNo: item?.applicationNo
    });
    if (key) evaluatedEvaluationKeys.add(key);
  }
}

function rebuildEvaluatedFromList(list) {
  evaluatedEvaluationKeys.clear();
  const arr = Array.isArray(list) ? list : [];
  for (const item of arr) {
    const key = String(item ?? "").trim();
    if (!key || !key.includes("::")) continue;
    evaluatedEvaluationKeys.add(key);
  }
}

function persistEvaluatedKeys() {
  void chrome.storage.local.set({
    [EVALUATED_DEDUPE_KEYS_KEY]: Array.from(evaluatedEvaluationKeys)
  }).catch(() => {});
}

async function ensureEvaluatedLoaded() {
  if (evaluatedLoaded) return;
  if (evaluatedLoadPromise) return evaluatedLoadPromise;

  evaluatedLoadPromise = chrome.storage.local
    .get([EVALUATED_DEDUPE_KEYS_KEY, EVALUATED_APPNOS_LEGACY_KEY, HISTORY_KEY])
    .then((data) => {
      const storedKeys = data[EVALUATED_DEDUPE_KEYS_KEY];
      if (Array.isArray(storedKeys) && storedKeys.length > 0) {
        rebuildEvaluatedFromList(storedKeys);
      } else {
        rebuildEvaluatedFromHistory(data[HISTORY_KEY]);
        persistEvaluatedKeys();
      }

      // Controlled migration: clear legacy appNo-only cache to avoid cross-version over-dedupe.
      if (Array.isArray(data[EVALUATED_APPNOS_LEGACY_KEY])) {
        void chrome.storage.local.remove([EVALUATED_APPNOS_LEGACY_KEY]).catch(() => {});
      }
      evaluatedLoaded = true;
    })
    .catch(() => {
      evaluatedLoaded = true;
    })
    .finally(() => {
      evaluatedLoadPromise = null;
    });

  return evaluatedLoadPromise;
}

function buildQueueStatus() {
  return {
    queued: evaluationQueue.length,
    running: evaluationRunning,
    completed: evaluationCompleted,
    active: evaluationCycleActive,
    ts: Date.now()
  };
}

function writeQueueStatus() {
  void chrome.storage.local.set({ [QUEUE_STATUS_KEY]: buildQueueStatus() }).catch(() => {});
}

async function runEvaluationTask(task) {
  const pair = task.pair;
  const citationText = (pair?.citationText ?? "").trim();
  const dwpiText = (pair?.dwpiText ?? "").trim();
  const payloadRaw = pair?.payloadRaw ?? "";
  const applicationNo = pair?.applicationNo ?? null;
  const queryVersionId = normalizeQueryVersionId(task?.queryVersionId || pair?.queryVersionId);
  const runId = normalizeRunId(task?.runId || pair?.runId);
  const bpMeta = pair?.bpMeta ?? {};
  const dwpiMeta = pair?.dwpiMeta ?? null;
  const overwriteHistoryId = normalizeHistoryId(task?.overwriteHistoryId);

  // 평가 실행에 필요한 token/appText/template 로드
  const store = await chrome.storage.local.get([
    "ksuiteSharedApiKey",
    "application_text",
    TEMPLATE_KEY
  ]);

  const token = (store.ksuiteSharedApiKey ?? "").trim();
  const appText = (store.application_text ?? "").trim();
  const defaultTpl = await getDefaultTemplate();
  const storedTpl = store[TEMPLATE_KEY];
  const tpl = (typeof storedTpl === "string" && storedTpl.trim())
    ? storedTpl
    : defaultTpl;

  if (!token || !appText || !citationText) {
    if (overwriteHistoryId) {
      const missingReason = !token
        ? "API key is missing."
        : (!appText ? "application_text is missing." : "citation text is missing.");
      await updateHistoryById(overwriteHistoryId, {
        apiOk: false,
        apiStatus: 0,
        response: `재평가 실패: ${missingReason}`
      });
    }
    return { success: false };
  }

  const id = overwriteHistoryId || makeId();
  const pendingItem = {
    id,
    time: normalizeTs(overwriteHistoryId ? Date.now() : bpMeta.ts),
    url: bpMeta.url,
    dwpiUrl: dwpiMeta?.url ?? null,
    apiOk: null,
    apiStatus: null,
    applicationNo: applicationNo || null,
    queryVersionId: queryVersionId || null,
    runId: runId || null,
    payload: payloadRaw,
    citationText: citationText || "",
    dwpiText: dwpiText || "",
    response: "평가 요청 중..."
  };

  if (overwriteHistoryId) {
    await updateHistoryById(overwriteHistoryId, pendingItem);
  } else {
    await pushHistory(pendingItem);
  }

  const content = applyTemplate(
    tpl,
    appText,
    citationText,
    dwpiText || EMPTY_DWPI_INFO_TEXT
  );

  let apiResultText = "";
  let apiOk = false;
  let apiStatus = 0;

  try {
    const rr = await callLocalChatApi(token, content);
    apiOk = rr.ok;
    apiStatus = rr.status;
    apiResultText = extractAssistantText(rr.json);
  } catch (error) {
    apiResultText = `API 요청 실패: ${String(error?.message ?? error)}`;
  }

  await updateHistoryById(id, {
    apiOk,
    apiStatus,
    time: normalizeTs(Date.now()),
    response: apiResultText
  });

  return { success: apiOk };
}

function pumpEvaluationQueue() {
  while (evaluationRunning < MAX_PARALLEL_EVAL && evaluationQueue.length > 0) {
    const task = evaluationQueue.shift();
    evaluationRunning += 1;
    writeQueueStatus();

    (async () => {
      let success = false;
      try {
        const result = await runEvaluationTask(task);
        success = !!result?.success;
      } catch {}

      evaluationRunning -= 1;
      evaluationCompleted += 1;
      if (task?.overwriteHistoryId) {
        reevaluatingHistoryIds.delete(normalizeHistoryId(task.overwriteHistoryId));
      }

      if (task?.dedupeKey) {
        scheduledEvaluationKeys.delete(task.dedupeKey);
        if (success) {
          evaluatedEvaluationKeys.add(task.dedupeKey);
          persistEvaluatedKeys();
        }
      }

      if (evaluationRunning === 0 && evaluationQueue.length === 0) {
        evaluationCycleActive = false;
      }
      writeQueueStatus();
      pumpEvaluationQueue();
    })();
  }
}

async function enqueueCitationPair(pair) {
  const citationText = (pair?.citationText ?? "").trim();
  if (!citationText) return;

  const context = getCaptureContextForTab(pair?.tabId);
  const captureMode = pair?.captureMode === CAPTURE_MODE_CAPTURE_ONLY
    ? CAPTURE_MODE_CAPTURE_ONLY
    : (context.mode === CAPTURE_MODE_CAPTURE_ONLY ? CAPTURE_MODE_CAPTURE_ONLY : CAPTURE_MODE_LEGACY);
  const queryVersionId = normalizeQueryVersionId(pair?.queryVersionId)
    || normalizeQueryVersionId(context.queryVersionId)
    || await resolveCurrentQueryVersionId();
  const runId = normalizeRunId(pair?.runId)
    || normalizeRunId(context.runId)
    || getCaptureRunIdForTab(pair?.tabId);

  const resolvedApplicationNo = normalizeApplicationNo(pair?.applicationNo)
    || resolveCapturedApplicationNo({
      payloadRaw: pair?.payloadRaw ?? "",
      requestUrl: pair?.bpMeta?.url ?? "",
      responseText: citationText
    });

  if (captureMode === CAPTURE_MODE_CAPTURE_ONLY) {
    await pushKResearchCaptureRow({
      id: makeId(),
      time: normalizeTs(Date.now()),
      applicationNo: resolvedApplicationNo || null,
      queryVersionId: queryVersionId || null,
      runId: runId || null,
      payload: pair?.payloadRaw ?? "",
      citationText,
      dwpiText: normalizeCapturedText(pair?.dwpiText ?? ""),
      targetMatched: pair?.targetMatched === true,
      url: pair?.bpMeta?.url ?? "",
      dwpiUrl: pair?.dwpiMeta?.url ?? "",
      source: "k-scan-capture-only"
    });
    return;
  }

  await pushHistory({
    id: makeId(),
    time: normalizeTs(Date.now()),
    applicationNo: resolvedApplicationNo || null,
    queryVersionId: queryVersionId || null,
    runId: runId || null,
    payload: pair?.payloadRaw ?? "",
    citationText,
    dwpiText: normalizeCapturedText(pair?.dwpiText ?? ""),
    targetMatched: pair?.targetMatched === true,
    url: pair?.bpMeta?.url ?? "",
    dwpiUrl: pair?.dwpiMeta?.url ?? "",
    tabId: pair?.tabId ?? null,
    source: "k-scan"
  });
}

async function enqueueReevaluationByHistoryIds(historyIds) {
  const _ids = Array.isArray(historyIds)
    ? historyIds.map((id) => normalizeHistoryId(id)).filter(Boolean)
    : [];
  return { queued: 0, skipped: _ids.length, missing: 0 };
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

function stagePendingBpPair(tabId, pair) {
  const dwpiQueue = pendingDwpiByTab.get(tabId);
  if (dwpiQueue && dwpiQueue.length > 0) {
    const dwpiItem = dwpiQueue.shift();
    if (dwpiItem?.timer) clearTimeout(dwpiItem.timer);
    if (dwpiQueue.length === 0) pendingDwpiByTab.delete(tabId);

    void enqueueCitationPair({
      ...pair,
      dwpiText: dwpiItem?.dwpiText ?? "",
      dwpiMeta: dwpiItem?.dwpiMeta ?? null
    });
    return;
  }

  const bundleId = pair.bundleId || makeId();
  const queue = getPendingBpQueue(tabId);
  const bundled = { ...pair, bundleId };
  bundled.timer = setTimeout(() => {
    const targetQueue = pendingBpPairByTab.get(tabId);
    if (!targetQueue) return;
    const idx = targetQueue.findIndex((x) => x.bundleId === bundleId);
    if (idx === -1) return;

    const [expired] = targetQueue.splice(idx, 1);
    if (targetQueue.length === 0) pendingBpPairByTab.delete(tabId);
    void enqueueCitationPair({ ...expired, dwpiText: "", dwpiMeta: null });
  }, DWPI_PAIR_WAIT_MS);
  queue.push(bundled);
}

function stagePendingDwpi(tabId, dwpiMeta, dwpiText) {
  const bpQueue = pendingBpPairByTab.get(tabId);
  if (bpQueue && bpQueue.length > 0) {
    const pair = bpQueue.shift();
    if (pair?.timer) clearTimeout(pair.timer);
    if (bpQueue.length === 0) pendingBpPairByTab.delete(tabId);

    void enqueueCitationPair({
      ...pair,
      dwpiMeta,
      dwpiText
    });
    return;
  }

  const queue = getPendingDwpiQueue(tabId);
  const dwpiItem = {
    dwpiMeta,
    dwpiText,
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
      await enqueueCitationPair({ ...pair, dwpiText: "", dwpiMeta: null });
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

// CDP getResponseBody 결과를 안전하게 문자열로 디코딩한다.
function decodeBody(body, base64Encoded) {
  if (!base64Encoded) return body ?? "";
  try {
    // atob는 binary string을 반환한다.
    const bin = atob(body || "");
    // UTF-8 텍스트로 변환한다.
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    // 디코딩 실패 시 원문(body)을 그대로 반환한다.
    return body ?? "";
  }
}

async function attachDebugger(tabId, options = {}) {
  const target = { tabId };
  const rootTabId = Number.isInteger(options?.rootTabId)
    ? options.rootTabId
    : getCaptureRootTabId(tabId);
  // 이미 attach된 탭은 재attach하지 않는다.
  if (attachedTabs.get(tabId)?.attached) {
    captureRootByTab.set(tabId, rootTabId);
    return;
  }
  if (attachingTabs.has(tabId)) return;
  attachingTabs.add(tabId);

  let attached = false;
  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    attachedTabs.set(tabId, { attached: true });
    captureRootByTab.set(tabId, rootTabId);

    await chrome.debugger.sendCommand(target, "Network.enable", {
      // no-op options
    });

    // ????????????????댟?? ???????????????곌떽釉붾????????꾩룆梨띰쭕????????癲됱빖??????????關?쒎첎?嫄????????遺븍き????????????? ???????????????????????筌뤾쑬???
    // await chrome.debugger.sendCommand(target, "Network.setCacheDisabled", { cacheDisabled: true });

    if (!pending.has(tabId)) pending.set(tabId, new Map());
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

function getActiveCaptureRootIds() {
  const rootIds = new Set();
  for (const rootTabId of captureRootByTab.values()) {
    if (Number.isInteger(rootTabId)) rootIds.add(rootTabId);
  }
  return Array.from(rootIds);
}

function getActiveCaptureOnlyRootIds() {
  const ids = [];
  for (const [rootTabId, context] of captureContextByRootTab.entries()) {
    if (!Number.isInteger(rootTabId)) continue;
    if (context?.mode !== CAPTURE_MODE_CAPTURE_ONLY) continue;
    ids.push(rootTabId);
  }
  return ids;
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
  if (!force && (now - lastCaptureOnlyAutoAttachAt) < 1500) return;
  lastCaptureOnlyAutoAttachAt = now;

  const captureOnlyRoots = getActiveCaptureOnlyRootIds();
  if (!Array.isArray(captureOnlyRoots) || captureOnlyRoots.length === 0) return;

  const allTabs = await chrome.tabs.query({});
  const tabById = new Map(
    allTabs
      .filter((tab) => Number.isInteger(tab?.id))
      .map((tab) => [tab.id, tab])
  );

  for (const rootTabId of captureOnlyRoots) {
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
        await attachDebugger(tabId, { rootTabId });
      } catch {}
    }
  }
}

async function detachCaptureScope(tabId) {
  const scopedTabIds = getCaptureScopeTabIds(tabId);
  for (const scopedTabId of scopedTabIds) {
    await detachDebugger(scopedTabId);
  }
}

async function attachKResearchCaptureTab(rootTabId, targetTabId) {
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

  const [rootTab, targetTab] = await Promise.all([
    chrome.tabs.get(rootTabId),
    chrome.tabs.get(targetTabId)
  ]);

  const rootWindowId = Number.isInteger(rootTab?.windowId)
    ? rootTab.windowId
    : captureRootWindowIdByRootTab.get(rootTabId);
  const sameWindow = Number.isInteger(rootWindowId)
    && Number.isInteger(targetTab?.windowId)
    && rootWindowId === targetTab.windowId;

  const openerTabId = Number.isInteger(targetTab?.openerTabId) ? targetTab.openerTabId : null;
  const openerRootId = Number.isInteger(openerTabId) ? getCaptureRootTabId(openerTabId) : null;
  const openerLinked = Number.isInteger(openerRootId) && openerRootId === rootTabId;

  const captureOnlyMode = rootContext.mode === CAPTURE_MODE_CAPTURE_ONLY;
  if (!captureOnlyMode && !sameWindow && !openerLinked) {
    throw new Error("Target tab is out of capture scope");
  }

  const url = String(targetTab?.url || "").trim();
  const attachable = !url || url.startsWith("about:") || isCapturableTabUrl(url);
  if (!attachable) {
    throw new Error("Target tab is not capturable");
  }

  await withTimeout(attachDebugger(targetTabId, { rootTabId }), 5000, "attachDebugger(derived)");
  return {
    attached: true,
    rootTabId,
    tabId: targetTabId
  };
}

async function maybeAttachDerivedBundleClaimTab(tab) {
  const tabId = tab?.id;
  if (!Number.isInteger(tabId)) return;
  if (attachedTabs.get(tabId)?.attached) return;
  if (attachingTabs.has(tabId)) return;

  const openerTabId = tab?.openerTabId;
  let rootTabId = Number.isInteger(openerTabId) ? captureRootByTab.get(openerTabId) : null;
  const captureOnlyRoots = getActiveCaptureOnlyRootIds();
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
  if (!Number.isInteger(rootTabId) && captureOnlyRoots.length === 1) {
    rootTabId = captureOnlyRoots[0];
  }
  if (!Number.isInteger(rootTabId)) {
    const activeRootIds = getActiveCaptureRootIds();
    if (activeRootIds.length !== 1) return;
    rootTabId = activeRootIds[0];
  }
  if (!Number.isInteger(rootTabId)) return;

  try {
    await attachDebugger(tabId, { rootTabId });
  } catch (error) {
    console.warn("K-SCAN auto-attach failed:", error);
  }
}

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const tabId = source?.tabId;
  if (!tabId) return;
  if (!attachedTabs.get(tabId)?.attached) return;
  // requestWillBeSent: bpService.do / getDWPIAbst.do ????濾?????遺얘턁?????? ?????怨뚮뼺?됰뗀???
  if (method === "Network.requestWillBeSent") {
    const requestId = params?.requestId;
    const req = params?.request;
    const url = req?.url;
    if (!requestId || !url) return;

    const methodName = req?.method ?? "";
    const payload = req?.postData ?? "";
    const kind = getTrackedRequestKind(url);
    if (!kind) return;

    const map = pending.get(tabId);
    if (!map) return;

    const prev = map.get(requestId) ?? {};
    map.set(requestId, {
      ...prev,
      kind,
      url,
      method: methodName,
      payload,
      requestTs: Date.now()
    });
    return;
  }


  // responseReceived?????URL, ??????嫄?????????濡?씀?濾??μ떜媛???????????????怨뺥닠??????
  if (method === "Network.responseReceived") {
    const url = params?.response?.url;
    const requestId = params?.requestId;
    if (!requestId) return;

    const map = pending.get(tabId);
    if (!map) return;

    const prev = map.get(requestId) ?? {};
    const trackedKind = getTrackedRequestKind(url || "") || prev.kind;
    if (!trackedKind) return;

    map.set(requestId, {
      ...prev,
      kind: trackedKind,
      url: url || prev.url,
      status: params.response?.status,
      mime: params.response?.mimeType,
      ts: Date.now()
    });
    return;
  }

  if (method === "Network.loadingFinished") {
    const requestId = params?.requestId;
    if (!requestId) return;

    const map = pending.get(tabId);
    const meta = map?.get(requestId);
    if (!meta) return;

    map.delete(requestId);
    const bodyText = await readResponseBodyText(tabId, requestId);

    if (meta.kind === "bp") {
      const targetMatched = isKResearchTargetBpCaptured(meta, bodyText);

      const payloadRaw = meta.payload ?? "";
      const applicationNo = resolveCapturedApplicationNo({
        payloadRaw,
        requestUrl: meta?.url ?? "",
        responseText: bodyText
      });
      const citationText = extractClaimOnly(bodyText);

      stagePendingBpPair(tabId, {
        bundleId: makeId(),
        bpMeta: meta,
        payloadRaw,
        applicationNo,
        citationText,
        tabId,
        runId: getCaptureRunIdForTab(tabId),
        targetMatched
      });
      return;
    }

    if (meta.kind === "dwpi") {
      const dwpiText = extractDwpiOnly(bodyText);
      stagePendingDwpi(tabId, meta, dwpiText);
      return;
    }
    return;
  }

  // ????????쇰뮝???????沃섃뫂????????繹먮굞???
  if (method === "Network.loadingFailed") {
    const requestId = params?.requestId;
    if (!requestId) return;

    const map = pending.get(tabId);
    const meta = map?.get(requestId);
    if (meta) map?.delete(requestId);

    // DWPI ????濾????????????쇰뮝??????? ??遺얘턁????????????????????????袁⑸즴壤?????????ル뭽??????????bpService ??遺얘턁筌?（??????DWPI ????????살몖????遺얘턁???????꿔꺂?????
    if (meta?.kind === "dwpi") {
      const bpQueue = pendingBpPairByTab.get(tabId);
      if (bpQueue && bpQueue.length > 0) {
        const pair = bpQueue.shift();
        if (pair?.timer) clearTimeout(pair.timer);
        if (bpQueue.length === 0) pendingBpPairByTab.delete(tabId);
        await enqueueCitationPair({ ...pair, dwpiText: "", dwpiMeta: null });
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
  if (msg?.type !== "KSCAN_REEVALUATE_SELECTED") return undefined;

  sendResponse({
    ok: false,
    error: "K-SCAN LLM evaluation is disabled."
  });
  return false;
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (globalThis.KRESEARCH_CAPTURE_MODULE_ENABLED) {
    return undefined;
  }

  const type = String(msg?.type || "");
  if (
    type !== "KRESEARCH_START_CAPTURE"
    && type !== "KRESEARCH_STOP_CAPTURE"
    && type !== "KRESEARCH_GET_CAPTURED_ROWS"
    && type !== "KRESEARCH_GET_CAPTURE_STATUS"
    && type !== "KRESEARCH_ATTACH_TAB"
  ) {
    return undefined;
  }

  (async () => {
    if (type === "KRESEARCH_GET_CAPTURED_ROWS") {
      const runId = normalizeRunId(msg?.runId);
      const rows = await getKResearchCapturedRowsByRunId(runId);
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
      const status = await getKResearchCaptureStatusByRunId(runId, msg?.limit);
      sendResponse({
        ok: true,
        runId: runId || "",
        count: status.count,
        rows: status.rows
      });
      return;
    }

    if (type === "KRESEARCH_ATTACH_TAB") {
      const requestedRootTabId = Number.isInteger(msg?.rootTabId) ? msg.rootTabId : null;
      const requestedTabId = Number.isInteger(msg?.tabId) ? msg.tabId : null;

      let rootTabId = requestedRootTabId;
      if (!Number.isInteger(rootTabId)) {
        const captureOnlyRoots = getActiveCaptureOnlyRootIds();
        if (captureOnlyRoots.length !== 1) {
          throw new Error("Unable to resolve capture root");
        }
        rootTabId = captureOnlyRoots[0];
      }

      let targetTabId = requestedTabId;
      if (!Number.isInteger(targetTabId)) {
        const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        targetTabId = Number.isInteger(activeTabs?.[0]?.id) ? activeTabs[0].id : null;
      }
      if (!Number.isInteger(targetTabId)) {
        throw new Error("Unable to resolve target tab");
      }

      const attached = await attachKResearchCaptureTab(rootTabId, targetTabId);
      sendResponse({
        ok: true,
        ...attached
      });
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

      await withTimeout(attachDebugger(tabId, { rootTabId: tabId }), 5000, "attachDebugger");

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
      return;
    }
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error?.message || String(error)
    });
  });

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "START_CAPTURE" && msg?.type !== "STOP_CAPTURE") {
    return undefined;
  }

  let responded = false;
  const safeRespond = (payload) => {
    if (responded) return;
    responded = true;
    sendResponse(payload);
  };

  const guardTimer = setTimeout(() => {
    safeRespond({ ok: false, error: "Background processing timeout" });
  }, 8000);

  (async () => {
    if (msg?.type === "START_CAPTURE") {
      const tabId = msg.tabId;
      try {
        if (!Number.isInteger(tabId)) {
          throw new Error("유효한 탭 ID가 아닙니다.");
        }

        const tab = await chrome.tabs.get(tabId);
        const tabUrl = String(tab?.url || "");
        if (!isCapturableTabUrl(tabUrl)) {
          throw new Error("HTTP/HTTPS 페이지에서만 캡처할 수 있습니다.");
        }

        await withTimeout(attachDebugger(tabId, { rootTabId: tabId }), 5000, "attachDebugger");
        const runId = makeRunId();
        captureRunIdByRootTab.set(tabId, runId);
        if (Number.isInteger(tab?.windowId)) {
          captureRootWindowIdByRootTab.set(tabId, tab.windowId);
        }
        setCaptureContextForRoot(tabId, {
          mode: CAPTURE_MODE_LEGACY,
          runId,
          queryVersionId: ""
        });
        safeRespond({ ok: true });
      } catch (e) {
        safeRespond({ ok: false, error: String(e?.message ?? e) });
      }
      return;
    }

    if (msg?.type === "STOP_CAPTURE") {
      const tabId = msg.tabId;
      try {
        if (!Number.isInteger(tabId)) {
          throw new Error("Invalid tab ID");
        }
        await withTimeout(detachCaptureScope(tabId), 5000, "detachCaptureScope");
        safeRespond({ ok: true });
      } catch (e) {
        safeRespond({ ok: false, error: String(e?.message ?? e) });
      }
      return;
    }
  })()
    .catch((error) => {
      safeRespond({ ok: false, error: String(error?.message ?? error) });
    })
    .finally(() => {
      clearTimeout(guardTimer);
    });

  return true;
});

chrome.tabs.onCreated.addListener((tab) => {
  void maybeAttachDerivedBundleClaimTab(tab);
  void autoAttachCaptureOnlyTabs(false).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
  if (Number.isInteger(tab?.id)) {
    void maybeAttachDerivedBundleClaimTab(tab);
    void autoAttachCaptureOnlyTabs(false).catch(() => {});
    return;
  }

  void chrome.tabs
    .get(tabId)
    .then((fullTab) => {
      void maybeAttachDerivedBundleClaimTab(fullTab);
      void autoAttachCaptureOnlyTabs(false).catch(() => {});
    })
    .catch(() => {});
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!Number.isInteger(tabId)) return;
  void chrome.tabs
    .get(tabId)
    .then((tab) => {
      void maybeAttachDerivedBundleClaimTab(tab);
      void autoAttachCaptureOnlyTabs(false).catch(() => {});
    })
    .catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!changes[HISTORY_KEY]) return;

  const next = changes[HISTORY_KEY].newValue;
  if (Array.isArray(next) && next.length > 0) return;

  evaluatedEvaluationKeys.clear();
  scheduledEvaluationKeys.clear();
  reevaluatingHistoryIds.clear();
  evaluatedLoaded = true;
  evaluatedLoadPromise = null;
  void chrome.storage.local.remove([EVALUATED_DEDUPE_KEYS_KEY, EVALUATED_APPNOS_LEGACY_KEY]).catch(() => {});
});

// ????????????살탾?????뽯＞??????detach (????關?쒎첎?嫄?濚밸쮦???
chrome.tabs.onRemoved.addListener((tabId) => {
  const rootTabId = captureRootByTab.get(tabId);
  if (rootTabId === tabId) {
    void detachCaptureScope(tabId);
  } else if (captureRootByTab.has(tabId) || attachedTabs.get(tabId)?.attached) {
    void detachDebugger(tabId);
  }
  void dedupeExistingResultWindows().catch(() => {});
});
