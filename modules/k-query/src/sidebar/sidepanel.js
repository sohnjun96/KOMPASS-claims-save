import { runPipeline } from "../core/orchestrator.js";
import { buildQuery, formatSynonymForQuery } from "../core/query_builder.js";
import { DEFAULT_NEAR_DISTANCE } from "../core/model_config.js";

const generateButton = document.getElementById("generateBtn");
const clearLogsButton = document.getElementById("clearLogsBtn");
const copyResultButton = document.getElementById("copyResultBtn");
const exportQueryButton = document.getElementById("exportQueryBtn");
const exportBundleButton = document.getElementById("exportBundleBtn");
const dockGenerateButton = document.getElementById("dockGenerateBtn");
const dockCopyButton = document.getElementById("dockCopyBtn");
const dockExportButton = document.getElementById("dockExportBtn");
const dockAdvancedButton = document.getElementById("dockAdvancedBtn");
const dockStatus = document.getElementById("dockStatus");
const dockGeneratedAt = document.getElementById("dockGeneratedAt");
const claimInput = document.getElementById("claimInput");
const claimCount = document.getElementById("claimCount");
const sampleButton = document.getElementById("sampleBtn");
const clearInputButton = document.getElementById("clearInputBtn");
const toggleInputCompactButton = document.getElementById("toggleInputCompactBtn");
const mockModeButton = document.getElementById("mockModeBtn");
const logDiv = document.getElementById("log");
const devLogDiv = document.getElementById("devLog");
const layerSummary = document.getElementById("layerSummary");
const resultOutput = document.getElementById("result");
const statusRail = document.getElementById("statusRail");
const statusText = document.getElementById("statusText");
const modeBadge = document.getElementById("modeBadge");
const statusSteps = Array.from(document.querySelectorAll(".status-step"));
const rerunButtons = Array.from(document.querySelectorAll("[data-rerun-layer]"));
const logTabButtons = Array.from(document.querySelectorAll("[data-log-tab]"));
const logPanels = Array.from(document.querySelectorAll("[data-log-panel]"));
const infoButtons = Array.from(document.querySelectorAll(".info-btn"));
const infoModal = document.getElementById("infoModal");
const infoModalTitle = document.getElementById("infoModalTitle");
const infoModalBody = document.getElementById("infoModalBody");
const infoModalCloseTriggers = Array.from(document.querySelectorAll("[data-info-modal-close]"));
const domainDictModal = document.getElementById("domainDictModal");
const domainDictModalCloseTriggers = Array.from(document.querySelectorAll("[data-domain-dict-close]"));
const synonymEditor = document.getElementById("synonymEditor");
const resetEditorButton = document.getElementById("resetEditorBtn");
const breadthSlider = document.getElementById("breadthSlider");
const breadthLabel = document.getElementById("breadthLabel");
const queryPreview = document.getElementById("queryPreview");
const coreSynonymToggle = document.getElementById("coreSynonymToggle");
const coreSynonymState = document.getElementById("coreSynonymState");
const editorNote = document.querySelector("#synonymEditorCard .editor-note");
const domainDictionaryToggle = document.getElementById("domainDictionaryToggle");
const domainDictionaryState = document.getElementById("domainDictionaryState");
const domainDictKeyInput = document.getElementById("domainDictKeyInput");
const domainDictTermsInput = document.getElementById("domainDictTermsInput");
const addDomainDictButton = document.getElementById("addDomainDictBtn");
const domainDictionaryList = document.getElementById("domainDictionaryList");
const domainDictSearchInput = document.getElementById("domainDictSearchInput");
const domainDictSortSelect = document.getElementById("domainDictSortSelect");
const domainDictStats = document.getElementById("domainDictStats");
const domainDictImportButton = document.getElementById("domainDictImportBtn");
const domainDictExportButton = document.getElementById("domainDictExportBtn");
const domainDictClearButton = document.getElementById("domainDictClearBtn");
const domainDictFileInput = document.getElementById("domainDictFileInput");
const openDomainDictModalButton = document.getElementById("openDomainDictModalBtn");
const domainDictLauncherMeta = document.getElementById("domainDictLauncherMeta");
const toastStack = document.getElementById("toastStack");

const foldCards = Array.from(document.querySelectorAll("[data-fold-key]"));
const foldToggleButtons = Array.from(document.querySelectorAll("[data-fold-toggle]"));
const quickNavButtons = Array.from(document.querySelectorAll("[data-focus-panel]"));
const statusFoldBadge = document.getElementById("statusFoldBadge");
const synonymFoldBadge = document.getElementById("synonymFoldBadge");
const logsFoldBadge = document.getElementById("logsFoldBadge");
const resultModeBadge = document.getElementById("resultModeBadge");
const resultElementBadge = document.getElementById("resultElementBadge");
const resultSynonymBadge = document.getElementById("resultSynonymBadge");
const resultLengthBadge = document.getElementById("resultLengthBadge");

const summaryItems = new Map();
const stepMap = new Map(statusSteps.map((step) => [step.dataset.layer, step]));
const LAYER_ORDER = ["Layer 1", "Layer 2", "Layer 3"];
const LAYER_LABELS = {
  "Layer 1": "Layer 1 · 분석",
  "Layer 2": "Layer 2 · 확장",
  "Layer 3": "Layer 3 · 조립"
};

const SAMPLE_CLAIM = "디스플레이 화면을 보호하는 커버를 포함하고, 사용자 조작을 감지하는 센서를 포함하는 전자장치.";
const INFO_CONTENT = {
  layer1: {
    title: "Layer 1 · 분석",
    body: "청구항에서 핵심 구성요소와 기능을 추출합니다.\n- 구성요소/기능 키워드 추출\n- 요소 간 관계(near/close) 추정\n- 분석 모드 결정(component/structure)\n출력: elements + mode + mode_reason"
  },
  layer2: {
    title: "Layer 2 · 확장",
    body: "각 요소의 동의어/유사표현 후보를 생성하고 정제합니다.\n- 모델별 후보 생성\n- 중복/노이즈 제거\n- 요소당 최대 6개 후보 유지\nstructure 모드에서는 관계 기반 후보를 우선 반영합니다."
  },
  layer3: {
    title: "Layer 3 · 조립",
    body: "관계 정보를 반영해 최종 검색식을 조립합니다.\n- 구성 그룹을 AND(&) 연산으로 결합\n- 과도한 확장 억제, 전체 길이 제한\n- structure 모드에서는 관계식을 우선 사용"
  },
  ensemble: {
    title: "앙상블",
    body: "여러 모델 결과를 비교해 가장 안정적인 후보를 채택합니다.\n- 모델별 점수 추정\n- 최고 점수 후보 선택\n- 다음 단계에서 자동 보정"
  }
};

let currentLayer = null;
const PANEL_STORAGE_KEY = "sidepanelState";
const PANEL_STORAGE_VERSION = 1;
const SHARED_STORAGE_KEYS = globalThis.KSUITE_STORAGE_KEYS || {};
const KQUERY_CLAIM_SHARE_STORAGE_KEY = SHARED_STORAGE_KEYS.KQUERY_CLAIM_TEXT || "ksuiteClaimKQuery";
const KQUERY_LATEST_ARTIFACT_KEY = "kquery_latest_artifact_v1";
const KQUERY_QUERY_VERSIONS_KEY = "kquery_query_versions_v1";
const KQUERY_ACTIVE_QUERY_VERSION_KEY = "kquery_active_query_version_v1";
const MAX_QUERY_VERSION_HISTORY = 50;
const MOCK_MODE_DEFAULT = true;
const CORE_SYNONYM_LOCK_DEFAULT = true;
const DOMAIN_DICTIONARY_ENABLED_DEFAULT = true;
const logEntries = [];
const devEntries = [];
let isRestoring = false;
let stateSaveTimer = null;
let unloadHookAdded = false;
let activeLogTab = "progress";
let currentMode = null;
let lastArtifacts = null;
let lastGeneratedQuery = "";
let lastGeneratedAt = "";
let inputCompactEnabled = false;
const selectedSynonymsById = new Map();
const BREADTH_DEFAULT = 40;
let isPipelineRunning = false;
let mockModeEnabled = MOCK_MODE_DEFAULT;
let coreSynonymLockEnabled = CORE_SYNONYM_LOCK_DEFAULT;
let domainDictionaryEnabled = DOMAIN_DICTIONARY_ENABLED_DEFAULT;
let currentQueryVersionId = null;
let domainDictionaryEntries = [];
let domainDictionarySearchKeyword = "";
let domainDictionarySortMode = "updated_desc";
let foldState = {
  status: false,
  synonyms: true,
  logs: true
};

function getTimestamp() {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function normalizeQueryVersionId(raw) {
  const value = String(raw || "").trim();
  return value || "";
}

function createQueryVersionId() {
  const base = Date.now().toString(36);
  const nonce = Math.random().toString(36).slice(2, 8);
  return `qv_${base}_${nonce}`;
}

function buildQueryVersionSnapshot(queryVersionId) {
  const elements = Array.isArray(lastArtifacts?.elements) ? lastArtifacts.elements : [];
  const relations = Array.isArray(lastArtifacts?.relations) ? lastArtifacts.relations : [];
  const coreElementIds = Array.isArray(lastArtifacts?.coreElementIds) ? lastArtifacts.coreElementIds : [];
  const synonymsById = lastArtifacts?.synonymsById && typeof lastArtifacts.synonymsById === "object"
    ? lastArtifacts.synonymsById
    : {};

  return {
    queryVersionId,
    claimText: claimInput?.value || "",
    expression: resultOutput?.value || "",
    mode: lastArtifacts?.mode || currentMode || null,
    elements,
    relations,
    coreElementIds,
    synonymsById,
    generatedAt: new Date().toISOString()
  };
}

async function persistQueryVersionSnapshot() {
  const queryVersionId = createQueryVersionId();
  const snapshot = buildQueryVersionSnapshot(queryVersionId);
  currentQueryVersionId = queryVersionId;

  try {
    const data = await chrome.storage.local.get([KQUERY_QUERY_VERSIONS_KEY]);
    const prevList = Array.isArray(data[KQUERY_QUERY_VERSIONS_KEY]) ? data[KQUERY_QUERY_VERSIONS_KEY] : [];
    const deduped = prevList.filter(
      (item) => normalizeQueryVersionId(item?.queryVersionId) !== queryVersionId
    );
    const nextList = [snapshot, ...deduped].slice(0, MAX_QUERY_VERSION_HISTORY);

    await chrome.storage.local.set({
      [KQUERY_ACTIVE_QUERY_VERSION_KEY]: queryVersionId,
      [KQUERY_LATEST_ARTIFACT_KEY]: snapshot,
      [KQUERY_QUERY_VERSIONS_KEY]: nextList
    });
  } catch {
    // Keep UI flow resilient if snapshot persistence fails.
  }
}

function normalizeFoldState(raw) {
  const next = {
    status: false,
    synonyms: true,
    logs: true
  };
  if (!raw || typeof raw !== "object") return next;
  if (typeof raw.status === "boolean") next.status = raw.status;
  if (typeof raw.synonyms === "boolean") next.synonyms = raw.synonyms;
  if (typeof raw.logs === "boolean") next.logs = raw.logs;
  return next;
}

function findFoldCard(key) {
  return foldCards.find((card) => card.dataset.foldKey === key) || null;
}

function syncFoldUiState() {
  foldCards.forEach((card) => {
    const key = card.dataset.foldKey;
    const collapsed = !!foldState[key];
    card.dataset.collapsed = collapsed ? "true" : "false";
    const toggle = card.querySelector(`[data-fold-toggle=\"${key}\"]`);
    if (toggle instanceof HTMLButtonElement) {
      toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    }
  });
}

function setFoldCollapsed(key, collapsed, { persist = true, scroll = false } = {}) {
  if (!key || !(key in foldState)) return;
  foldState = { ...foldState, [key]: !!collapsed };
  syncFoldUiState();
  if (scroll && !collapsed) {
    const card = findFoldCard(key);
    card?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  if (persist) scheduleStateSave();
}

function syncModalLockState() {
  const infoOpen = infoModal && !infoModal.classList.contains("is-hidden");
  const dictOpen = domainDictModal && !domainDictModal.classList.contains("is-hidden");
  document.body.classList.toggle("modal-open", !!(infoOpen || dictOpen));
}

function openDomainDictionaryModal() {
  if (!domainDictModal) return;
  domainDictModal.classList.remove("is-hidden");
  syncModalLockState();
  if (domainDictSearchInput instanceof HTMLInputElement) {
    domainDictSearchInput.focus();
  }
}

function closeDomainDictionaryModal() {
  if (!domainDictModal) return;
  domainDictModal.classList.add("is-hidden");
  syncModalLockState();
}

function focusPanel(panelKey) {
  if (panelKey === "dictionary") {
    openDomainDictionaryModal();
    return;
  }
  if (!panelKey || !(panelKey in foldState)) return;
  setFoldCollapsed(panelKey, false, { scroll: true });
}

function showToast(message, { type = "info", durationMs = 2200 } = {}) {
  if (!toastStack || !message) return;
  const toast = document.createElement("div");
  toast.className = "toast";
  if (type === "success") toast.classList.add("is-success");
  if (type === "error") toast.classList.add("is-error");
  if (type === "warning") toast.classList.add("is-warning");
  toast.textContent = message;
  toastStack.appendChild(toast);

  window.setTimeout(() => {
    toast.classList.add("is-leaving");
    window.setTimeout(() => toast.remove(), 220);
  }, Math.max(900, durationMs));
}

function countActiveSynonymItems() {
  if (!lastArtifacts) return 0;
  const filtered = buildFilteredSynonymsById();
  return Object.values(filtered).reduce(
    (sum, items) => sum + (Array.isArray(items) ? items.length : 0),
    0
  );
}

function updateFoldBadges() {
  if (statusFoldBadge) {
    const label = statusText?.textContent?.trim() || "대기 중";
    statusFoldBadge.textContent = label;
  }
  if (synonymFoldBadge) {
    const elementCount = Array.isArray(lastArtifacts?.elements) ? lastArtifacts.elements.length : 0;
    const synCount = countActiveSynonymItems();
    synonymFoldBadge.textContent = elementCount > 0
      ? `요소 ${elementCount} · 동의어 ${synCount}`
      : "준비 전";
  }
  if (logsFoldBadge) {
    logsFoldBadge.textContent = `${logEntries.length + devEntries.length} lines`;
  }
}

function updateResultSummary() {
  if (!resultModeBadge || !resultElementBadge || !resultSynonymBadge || !resultLengthBadge) return;
  const modeLabel = currentMode === "structure"
    ? "구조 중심"
    : currentMode === "component"
      ? "구성요소 중심"
      : "자동";
  const elementCount = Array.isArray(lastArtifacts?.elements) ? lastArtifacts.elements.length : 0;
  const synonymCount = countActiveSynonymItems();
  const length = resultOutput?.value?.length || 0;

  resultModeBadge.textContent = `모드: ${modeLabel}`;
  resultModeBadge.classList.toggle("is-accent", modeLabel !== "자동");
  resultElementBadge.textContent = `요소: ${elementCount}`;
  resultSynonymBadge.textContent = `동의어: ${synonymCount}`;
  resultLengthBadge.textContent = `길이: ${length}`;
  updateFoldBadges();
  updateDockMeta();
}

function setInputCompactMode(enabled, { persist = true } = {}) {
  inputCompactEnabled = !!enabled;
  const appRoot = document.querySelector(".app");
  if (appRoot) {
    appRoot.classList.toggle("input-compact", inputCompactEnabled);
  }
  if (toggleInputCompactButton) {
    toggleInputCompactButton.setAttribute("aria-pressed", inputCompactEnabled ? "true" : "false");
    toggleInputCompactButton.textContent = inputCompactEnabled ? "Input Expand" : "Input Compact";
  }
  if (persist) scheduleStateSave();
}

function updateDockMeta() {
  const state = String(statusRail?.dataset?.state || "idle");
  const statusLabelMap = {
    idle: "Ready",
    running: "Running",
    done: "Completed",
    error: "Error"
  };
  if (dockStatus) {
    dockStatus.textContent = statusLabelMap[state] || "Ready";
  }
  if (dockGeneratedAt) {
    dockGeneratedAt.textContent = lastGeneratedAt ? `Last run: ${lastGeneratedAt}` : "Last run: -";
  }
}

function updateClaimMeta() {
  if (!claimInput || !claimCount) return;
  claimCount.textContent = `${claimInput.value.length}자`;
}

function setMockMode(enabled, { persist = true } = {}) {
  mockModeEnabled = !!enabled;
  if (mockModeButton) {
    mockModeButton.textContent = mockModeEnabled ? "Mock: ON" : "Mock: OFF";
    mockModeButton.setAttribute("aria-pressed", mockModeEnabled ? "true" : "false");
    mockModeButton.dataset.state = mockModeEnabled ? "on" : "off";
  }
  if (persist) scheduleStateSave();
}

function refreshCoreSynonymUiState() {
  if (coreSynonymToggle instanceof HTMLInputElement) {
    coreSynonymToggle.checked = coreSynonymLockEnabled;
  }
  if (coreSynonymState) {
    coreSynonymState.textContent = coreSynonymLockEnabled ? "ON" : "OFF";
  }
  if (editorNote) {
    editorNote.textContent = coreSynonymLockEnabled
      ? "Core synonym lock is ON. Base term is always included."
      : "Core synonym lock is OFF. Base term can be disabled.";
  }
}

function setCoreSynonymLock(enabled, { persist = true, rebuild = true } = {}) {
  coreSynonymLockEnabled = !!enabled;
  refreshCoreSynonymUiState();
  if (persist) scheduleStateSave();
  if (rebuild && lastArtifacts) {
    applyEditorSelectionToQuery();
    renderSynonymEditor();
  }
}

const DICTIONARY_SORT_MODES = new Set(["updated_desc", "key_asc", "terms_desc"]);

function createDictionaryEntryId() {
  return `dict-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeDictionaryText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function splitDictionaryTerms(rawValue) {
  return String(rawValue || "")
    .split(/[,\n;]/g)
    .map((term) => sanitizeDictionaryText(term))
    .filter(Boolean);
}

function toDictionaryTimestamp(rawValue, fallback = Date.now()) {
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeDictionarySortMode(rawValue) {
  const value = String(rawValue || "").trim().toLowerCase();
  return DICTIONARY_SORT_MODES.has(value) ? value : "updated_desc";
}

function normalizeDictionaryTermList(rawTerms) {
  if (Array.isArray(rawTerms)) {
    return rawTerms
      .map((term) => sanitizeDictionaryText(term))
      .filter(Boolean);
  }
  return splitDictionaryTerms(rawTerms);
}

function normalizeDomainDictionaryEntries(rawEntries) {
  const entries = Array.isArray(rawEntries) ? rawEntries : [];
  const byKey = new Map();
  const now = Date.now();

  entries.forEach((entry) => {
    if (!entry || typeof entry !== "object") return;
    const key = sanitizeDictionaryText(entry.key || entry.keyword || entry.term || "");
    if (!key) return;

    const terms = normalizeDictionaryTermList(entry.terms);
    if (terms.length === 0) return;

    const keyNorm = normalizeTermKey(key);
    if (!keyNorm) return;
    const createdAt = toDictionaryTimestamp(entry.createdAt ?? entry.created_at, now);
    const updatedAt = toDictionaryTimestamp(entry.updatedAt ?? entry.updated_at, createdAt);

    let target = byKey.get(keyNorm);
    if (!target) {
      target = {
        id: sanitizeDictionaryText(entry.id || "") || createDictionaryEntryId(),
        key,
        terms: [],
        termKeys: new Set(),
        createdAt,
        updatedAt
      };
      byKey.set(keyNorm, target);
    } else {
      target.createdAt = Math.min(target.createdAt, createdAt);
      target.updatedAt = Math.max(target.updatedAt, updatedAt);
    }

    terms.forEach((term) => {
      const termKey = normalizeTermKey(term);
      if (!termKey || target.termKeys.has(termKey)) return;
      target.termKeys.add(termKey);
      target.terms.push(term);
    });
  });

  return Array.from(byKey.values())
    .filter((entry) => entry.terms.length > 0)
    .map(({ id, key, terms, createdAt, updatedAt }) => ({ id, key, terms, createdAt, updatedAt }));
}

function countDomainDictionaryTerms(entries) {
  return (entries || []).reduce((sum, entry) => sum + (Array.isArray(entry?.terms) ? entry.terms.length : 0), 0);
}

function formatDictionaryTime(timestamp) {
  const value = toDictionaryTimestamp(timestamp, Date.now());
  const diffMs = Date.now() - value;
  if (diffMs < 60 * 1000) return "just now";
  if (diffMs < 60 * 60 * 1000) return `${Math.round(diffMs / (60 * 1000))}m ago`;
  if (diffMs < 24 * 60 * 60 * 1000) return `${Math.round(diffMs / (60 * 60 * 1000))}h ago`;
  if (diffMs < 7 * 24 * 60 * 60 * 1000) return `${Math.round(diffMs / (24 * 60 * 60 * 1000))}d ago`;
  return new Date(value).toLocaleDateString();
}

function getDomainDictionaryFilteredSortedEntries() {
  const query = normalizeTermKey(domainDictionarySearchKeyword);
  let entries = [...domainDictionaryEntries];

  if (query) {
    entries = entries.filter((entry) => {
      if (normalizeTermKey(entry.key).includes(query)) return true;
      return (entry.terms || []).some((term) => normalizeTermKey(term).includes(query));
    });
  }

  const mode = normalizeDictionarySortMode(domainDictionarySortMode);
  if (mode === "key_asc") {
    entries.sort((a, b) => String(a.key || "").localeCompare(String(b.key || ""), "en", { sensitivity: "base" }));
    return entries;
  }

  if (mode === "terms_desc") {
    entries.sort((a, b) => {
      const termsDiff = (b.terms?.length || 0) - (a.terms?.length || 0);
      if (termsDiff !== 0) return termsDiff;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    return entries;
  }

  entries.sort((a, b) => {
    const updatedDiff = (b.updatedAt || 0) - (a.updatedAt || 0);
    if (updatedDiff !== 0) return updatedDiff;
    return String(a.key || "").localeCompare(String(b.key || ""), "en", { sensitivity: "base" });
  });
  return entries;
}

function syncDomainDictionaryFilterControls() {
  if (domainDictSearchInput instanceof HTMLInputElement) {
    domainDictSearchInput.value = domainDictionarySearchKeyword;
  }
  if (domainDictSortSelect instanceof HTMLSelectElement) {
    domainDictSortSelect.value = normalizeDictionarySortMode(domainDictionarySortMode);
  }
}

function refreshDomainDictionaryUiState() {
  syncDomainDictionaryFilterControls();
  if (domainDictionaryToggle instanceof HTMLInputElement) {
    domainDictionaryToggle.checked = domainDictionaryEnabled;
    domainDictionaryToggle.disabled = isPipelineRunning;
  }
  if (domainDictionaryState) {
    domainDictionaryState.textContent = domainDictionaryEnabled ? "ON" : "OFF";
  }

  const disableInputs = isPipelineRunning;
  if (domainDictKeyInput instanceof HTMLInputElement) {
    domainDictKeyInput.disabled = disableInputs;
  }
  if (domainDictTermsInput instanceof HTMLTextAreaElement || domainDictTermsInput instanceof HTMLInputElement) {
    domainDictTermsInput.disabled = disableInputs;
  }
  if (addDomainDictButton) {
    addDomainDictButton.disabled = disableInputs;
  }
  if (domainDictSearchInput instanceof HTMLInputElement) {
    domainDictSearchInput.disabled = disableInputs;
  }
  if (domainDictSortSelect instanceof HTMLSelectElement) {
    domainDictSortSelect.disabled = disableInputs;
  }
  if (domainDictImportButton) {
    domainDictImportButton.disabled = disableInputs;
  }
  if (domainDictExportButton) {
    domainDictExportButton.disabled = disableInputs || domainDictionaryEntries.length === 0;
  }
  if (domainDictClearButton) {
    domainDictClearButton.disabled = disableInputs || domainDictionaryEntries.length === 0;
  }
  if (openDomainDictModalButton) {
    openDomainDictModalButton.disabled = false;
  }
}

function setDomainDictionaryEnabled(enabled, { persist = true } = {}) {
  domainDictionaryEnabled = !!enabled;
  refreshDomainDictionaryUiState();
  renderDomainDictionaryList();
  if (persist) scheduleStateSave();
}

function renderDomainDictionaryStats(visibleEntries) {
  const totalEntries = domainDictionaryEntries.length;
  const totalTerms = countDomainDictionaryTerms(domainDictionaryEntries);
  const visible = Array.isArray(visibleEntries) ? visibleEntries : domainDictionaryEntries;
  const visibleEntriesCount = visible.length;
  const visibleTerms = countDomainDictionaryTerms(visible);
  const hasFilter = !!sanitizeDictionaryText(domainDictionarySearchKeyword);

  let text = `${totalEntries} entries · ${totalTerms} terms`;
  if (hasFilter) {
    text = `${visibleEntriesCount}/${totalEntries} entries · ${visibleTerms}/${totalTerms} terms`;
  }
  if (!domainDictionaryEnabled) {
    text = `비활성 · ${text}`;
  }
  if (domainDictStats) {
    domainDictStats.textContent = text;
  }
  if (domainDictLauncherMeta) {
    domainDictLauncherMeta.textContent = text;
  }
}

function loadDomainDictionaryEntryToForm(entry) {
  if (!entry) return;
  if (domainDictKeyInput instanceof HTMLInputElement) {
    domainDictKeyInput.value = entry.key || "";
  }
  if (domainDictTermsInput instanceof HTMLTextAreaElement || domainDictTermsInput instanceof HTMLInputElement) {
    domainDictTermsInput.value = Array.isArray(entry.terms) ? entry.terms.join(", ") : "";
    domainDictTermsInput.focus();
    if (domainDictTermsInput instanceof HTMLInputElement || domainDictTermsInput instanceof HTMLTextAreaElement) {
      domainDictTermsInput.select?.();
    }
  }
  appendProgressLine(`Dictionary entry loaded: ${entry.key}`);
}

function removeDomainDictionaryEntry(entry) {
  if (!entry) return;
  domainDictionaryEntries = domainDictionaryEntries.filter((item) => item.id !== entry.id);
  renderDomainDictionaryList();
  scheduleStateSave();
  appendProgressLine(`Dictionary entry removed: ${entry.key}`);
}

async function copyDomainDictionaryEntry(entry) {
  if (!entry) return;
  const text = `${entry.key}: ${(entry.terms || []).join(", ")}`;
  try {
    await navigator.clipboard.writeText(text);
    appendProgressLine(`Dictionary entry copied: ${entry.key}`);
    showToast("Dictionary entry copied.", { type: "success" });
  } catch {
    appendProgressLine("Failed to copy dictionary entry.");
    showToast("Failed to copy dictionary entry.", { type: "error" });
  }
}

function renderDomainDictionaryList() {
  if (!domainDictionaryList) return;
  domainDictionaryEntries = normalizeDomainDictionaryEntries(domainDictionaryEntries);
  domainDictionaryList.innerHTML = "";
  const visibleEntries = getDomainDictionaryFilteredSortedEntries();
  renderDomainDictionaryStats(visibleEntries);

  if (!Array.isArray(domainDictionaryEntries) || domainDictionaryEntries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "synonym-empty";
    empty.textContent = "No dictionary entries yet.";
    domainDictionaryList.appendChild(empty);
    refreshDomainDictionaryUiState();
    return;
  }

  if (visibleEntries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "synonym-empty";
    empty.textContent = "No entries match the current search filter.";
    domainDictionaryList.appendChild(empty);
    refreshDomainDictionaryUiState();
    return;
  }

  const disableActions = isPipelineRunning;
  visibleEntries.forEach((entry) => {
    const row = document.createElement("div");
    row.className = `dictionary-entry${domainDictionaryEnabled ? "" : " is-disabled"}`;

    const head = document.createElement("div");
    head.className = "dictionary-entry-head";

    const main = document.createElement("div");
    main.className = "dictionary-entry-main";

    const key = document.createElement("div");
    key.className = "dictionary-key";
    key.textContent = entry.key;

    const terms = document.createElement("div");
    terms.className = "dictionary-meta";
    const countPill = document.createElement("span");
    countPill.className = "dictionary-pill";
    countPill.textContent = `${entry.terms.length} terms`;
    const updatedPill = document.createElement("span");
    updatedPill.className = "dictionary-pill";
    updatedPill.textContent = `Updated ${formatDictionaryTime(entry.updatedAt)}`;
    terms.appendChild(countPill);
    terms.appendChild(updatedPill);

    main.appendChild(key);
    main.appendChild(terms);

    const actions = document.createElement("div");
    actions.className = "dictionary-entry-actions";

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "btn ghost tiny";
    editButton.textContent = "Edit";
    editButton.disabled = disableActions;
    editButton.addEventListener("click", () => {
      loadDomainDictionaryEntryToForm(entry);
    });

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "btn ghost tiny";
    copyButton.textContent = "Copy";
    copyButton.disabled = disableActions;
    copyButton.addEventListener("click", async () => {
      await copyDomainDictionaryEntry(entry);
    });

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "btn ghost tiny";
    removeButton.textContent = "Remove";
    removeButton.disabled = disableActions;
    removeButton.addEventListener("click", () => {
      removeDomainDictionaryEntry(entry);
    });

    actions.appendChild(editButton);
    actions.appendChild(copyButton);
    actions.appendChild(removeButton);

    const chips = document.createElement("div");
    chips.className = "dictionary-chip-list";
    entry.terms.forEach((term) => {
      const chip = document.createElement("span");
      chip.className = "dictionary-term-chip";
      chip.textContent = term;
      chips.appendChild(chip);
    });

    head.appendChild(main);
    head.appendChild(actions);
    row.appendChild(head);
    row.appendChild(chips);
    domainDictionaryList.appendChild(row);
  });
  refreshDomainDictionaryUiState();
}

function upsertDomainDictionaryEntry({
  id = createDictionaryEntryId(),
  key,
  terms,
  createdAt = Date.now(),
  updatedAt = Date.now()
}) {
  const cleanKey = sanitizeDictionaryText(key);
  const cleanTerms = normalizeDictionaryTermList(terms);
  if (!cleanKey) return { ok: false, reason: "Dictionary keyword is required." };
  if (cleanTerms.length === 0) return { ok: false, reason: "At least one seed synonym is required." };

  const keyNorm = normalizeTermKey(cleanKey);
  const existing = domainDictionaryEntries.find((entry) => normalizeTermKey(entry.key) === keyNorm);
  if (!existing) {
    domainDictionaryEntries.push({
      id: sanitizeDictionaryText(id) || createDictionaryEntryId(),
      key: cleanKey,
      terms: [...new Set(cleanTerms)],
      createdAt: toDictionaryTimestamp(createdAt),
      updatedAt: toDictionaryTimestamp(updatedAt)
    });
    return { ok: true, merged: false, key: cleanKey, addedTerms: cleanTerms.length };
  }

  const seen = new Set(existing.terms.map((term) => normalizeTermKey(term)));
  let added = 0;
  cleanTerms.forEach((term) => {
    const termKey = normalizeTermKey(term);
    if (!termKey || seen.has(termKey)) return;
    seen.add(termKey);
    existing.terms.push(term);
    added += 1;
  });

  existing.key = cleanKey;
  if (added > 0) {
    existing.updatedAt = Math.max(toDictionaryTimestamp(updatedAt), Date.now());
  }
  return { ok: true, merged: true, key: existing.key, addedTerms: added };
}

function addOrMergeDomainDictionaryEntry() {
  const result = upsertDomainDictionaryEntry({
    key: domainDictKeyInput?.value || "",
    terms: domainDictTermsInput?.value || ""
  });
  if (!result.ok) return { ok: false, reason: result.reason };

  renderDomainDictionaryList();
  scheduleStateSave();
  return {
    ok: true,
    merged: result.merged,
    key: result.key,
    count: result.addedTerms
  };
}

function importDomainDictionaryEntries(rawEntries) {
  const normalized = normalizeDomainDictionaryEntries(rawEntries);
  if (normalized.length === 0) {
    return { ok: false, reason: "No valid dictionary entries found in the imported file." };
  }

  let mergedEntries = 0;
  let mergedTerms = 0;
  normalized.forEach((entry) => {
    const result = upsertDomainDictionaryEntry(entry);
    if (!result.ok) return;
    mergedEntries += 1;
    mergedTerms += result.addedTerms;
  });

  renderDomainDictionaryList();
  scheduleStateSave();
  return { ok: true, mergedEntries, mergedTerms };
}

function exportDomainDictionaryEntries() {
  if (!Array.isArray(domainDictionaryEntries) || domainDictionaryEntries.length === 0) {
    appendProgressLine("No dictionary entries to export.");
    showToast("No dictionary entries to export.", { type: "warning" });
    return;
  }
  const normalized = normalizeDomainDictionaryEntries(domainDictionaryEntries).map(
    ({ key, terms, createdAt, updatedAt }) => ({ key, terms, createdAt, updatedAt })
  );
  const filename = buildExportFileName("k-query-domain-dictionary", "json");
  downloadFile(filename, `${JSON.stringify(normalized, null, 2)}\n`, "application/json;charset=utf-8");
  appendProgressLine(`Dictionary exported: ${filename}`);
  showToast("Dictionary JSON exported.", { type: "success" });
}

function clearDomainDictionaryEntries() {
  if (!Array.isArray(domainDictionaryEntries) || domainDictionaryEntries.length === 0) return;
  const confirmed = window.confirm("Clear all dictionary entries?");
  if (!confirmed) return;
  domainDictionaryEntries = [];
  renderDomainDictionaryList();
  scheduleStateSave();
  appendProgressLine("All dictionary entries were cleared.");
  showToast("Dictionary entries cleared.", { type: "warning" });
}

function getDomainDictionaryPayload() {
  if (!domainDictionaryEnabled) return [];
  return normalizeDomainDictionaryEntries(domainDictionaryEntries).map(({ key, terms }) => ({
    key,
    terms: [...terms]
  }));
}

function buildPipelineOptions(base = {}) {
  return {
    ...base,
    domainDictionary: getDomainDictionaryPayload()
  };
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function buildExportFileName(prefix, extension) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${prefix}-${stamp}.${extension}`;
}

function exportQueryOnly() {
  const query = resultOutput?.value?.trim() || "";
  if (!query) {
    appendProgressLine("No query to export.");
    showToast("No query to export.", { type: "warning" });
    return;
  }
  const filename = buildExportFileName("k-query", "txt");
  downloadFile(filename, `${query}\n`, "text/plain;charset=utf-8");
  appendProgressLine(`Exported query: ${filename}`);
  showToast("Query exported.", { type: "success" });
}

function exportJsonBundle() {
  const bundle = {
    claim: claimInput?.value?.trim() || "",
    mode: lastArtifacts?.mode || currentMode || null,
    elements: Array.isArray(lastArtifacts?.elements) ? lastArtifacts.elements : [],
    relations: Array.isArray(lastArtifacts?.relations) ? lastArtifacts.relations : [],
    coreElementIds: Array.isArray(lastArtifacts?.coreElementIds) ? lastArtifacts.coreElementIds : [],
    synonymsById: lastArtifacts?.synonymsById && typeof lastArtifacts.synonymsById === "object"
      ? lastArtifacts.synonymsById
      : {},
    filteredSynonymsById: buildFilteredSynonymsById(),
    finalQuery: resultOutput?.value?.trim() || "",
    generatedAt: new Date().toISOString(),
    mockModeEnabled,
    domainDictionaryEnabled,
    domainDictionary: normalizeDomainDictionaryEntries(domainDictionaryEntries).map(({ key, terms }) => ({ key, terms }))
  };

  const filename = buildExportFileName("k-query-bundle", "json");
  downloadFile(filename, `${JSON.stringify(bundle, null, 2)}\n`, "application/json;charset=utf-8");
  appendProgressLine(`Exported bundle: ${filename}`);
  showToast("JSON bundle exported.", { type: "success" });
}

function setModeBadge(mode) {
  currentMode = mode || null;
  if (!modeBadge) return;
  if (!mode) {
    modeBadge.textContent = "모드: 자동";
    modeBadge.dataset.mode = "auto";
    updateResultSummary();
    scheduleStateSave();
    return;
  }
  const label = mode === "structure" ? "결합구조" : "구성요소";
  modeBadge.textContent = `모드: ${label}`;
  modeBadge.dataset.mode = mode;
  updateResultSummary();
  scheduleStateSave();
}

function parseModeFromMessage(message) {
  if (!message) return null;
  const normalized = String(message).toLowerCase();
  if (normalized.includes("structure") || message.includes("결합구조")) return "structure";
  if (normalized.includes("component") || message.includes("구성요소") || message.includes("구성 요소")) return "component";
  return null;
}

function setActiveLogTab(tabKey, { persist = true } = {}) {
  if (!tabKey) return;
  activeLogTab = tabKey;
  logTabButtons.forEach((button) => {
    const isActive = button.dataset.logTab === tabKey;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  logPanels.forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.logPanel === tabKey);
  });
  if (persist) scheduleStateSave();
}

function openInfoModal(key) {
  if (!infoModal || !infoModalTitle || !infoModalBody) return;
  const info = INFO_CONTENT[key];
  if (!info) return;
  infoModalTitle.textContent = info.title;
  infoModalBody.textContent = info.body;
  infoModal.classList.remove("is-hidden");
  syncModalLockState();
}

function closeInfoModal() {
  if (!infoModal) return;
  infoModal.classList.add("is-hidden");
  syncModalLockState();
}


function scheduleStateSave() {
  if (isRestoring) return;
  if (stateSaveTimer) clearTimeout(stateSaveTimer);
  stateSaveTimer = setTimeout(() => {
    stateSaveTimer = null;
    persistPanelState();
  }, 200);
}

function flushPanelState() {
  if (stateSaveTimer) {
    clearTimeout(stateSaveTimer);
    stateSaveTimer = null;
  }
  persistPanelState();
}

function buildStatusSnapshot() {
  const steps = {};
  LAYER_ORDER.forEach((layer) => {
    steps[layer] = stepMap.get(layer)?.dataset.state || "idle";
  });
  return {
    overallState: statusRail?.dataset.state || "idle",
    statusText: statusText?.textContent || "",
    steps,
    currentLayer,
    mode: currentMode
  };
}

function applyStatusSnapshot(snapshot) {
  if (!snapshot) return;
  if (statusRail && snapshot.overallState) statusRail.dataset.state = snapshot.overallState;
  if (statusText && typeof snapshot.statusText === "string") statusText.textContent = snapshot.statusText;
  if (snapshot.steps && typeof snapshot.steps === "object") {
    LAYER_ORDER.forEach((layer) => {
      if (snapshot.steps[layer]) setStepState(layer, snapshot.steps[layer]);
    });
  }
  currentLayer = snapshot.currentLayer || null;
  if (snapshot.mode) setModeBadge(snapshot.mode);
}

async function persistPanelState() {
  if (isRestoring) return;
  const snapshot = {
    version: PANEL_STORAGE_VERSION,
    claimText: claimInput?.value || "",
    resultText: resultOutput?.value || "",
    logs: logEntries,
    devEntries,
    status: buildStatusSnapshot(),
    activeLogTab,
    mockModeEnabled,
    coreSynonymLockEnabled,
    currentQueryVersionId,
    breadthValue: getBreadthValue(),
    inputCompactEnabled,
    lastGeneratedAt,
    domainDictionaryEnabled,
    domainDictionaryEntries,
    domainDictionarySearchKeyword,
    domainDictionarySortMode,
    foldState
  };

  try {
    await chrome.storage.local.set({
      [PANEL_STORAGE_KEY]: snapshot,
      [KQUERY_CLAIM_SHARE_STORAGE_KEY]: snapshot.claimText
    });
  } catch {
    // Ignore storage errors.
  }
}

async function persistSharedClaimText() {
  if (!claimInput) return;
  try {
    await chrome.storage.local.set({
      [KQUERY_CLAIM_SHARE_STORAGE_KEY]: claimInput.value || ""
    });
  } catch {
    // Ignore storage errors.
  }
}

async function restorePanelState() {
  const wasRestoring = isRestoring;
  isRestoring = true;
  try {
    const data = await chrome.storage.local.get([PANEL_STORAGE_KEY, KQUERY_ACTIVE_QUERY_VERSION_KEY]);
    const snapshot = data[PANEL_STORAGE_KEY];
    currentQueryVersionId = normalizeQueryVersionId(data[KQUERY_ACTIVE_QUERY_VERSION_KEY]) || null;
    if (!snapshot || snapshot.version !== PANEL_STORAGE_VERSION) return false;
    if (!currentQueryVersionId) {
      currentQueryVersionId = normalizeQueryVersionId(snapshot.currentQueryVersionId) || null;
    }

    clearLogs({ persist: false });
    if (typeof snapshot.mockModeEnabled === "boolean") {
      setMockMode(snapshot.mockModeEnabled, { persist: false });
    } else {
      setMockMode(MOCK_MODE_DEFAULT, { persist: false });
    }
    if (typeof snapshot.coreSynonymLockEnabled === "boolean") {
      setCoreSynonymLock(snapshot.coreSynonymLockEnabled, { persist: false, rebuild: false });
    } else {
      setCoreSynonymLock(CORE_SYNONYM_LOCK_DEFAULT, { persist: false, rebuild: false });
    }
    if (typeof snapshot.domainDictionaryEnabled === "boolean") {
      setDomainDictionaryEnabled(snapshot.domainDictionaryEnabled, { persist: false });
    } else {
      setDomainDictionaryEnabled(DOMAIN_DICTIONARY_ENABLED_DEFAULT, { persist: false });
    }
    if (Array.isArray(snapshot.domainDictionaryEntries)) {
      domainDictionaryEntries = normalizeDomainDictionaryEntries(snapshot.domainDictionaryEntries);
    } else {
      domainDictionaryEntries = [];
    }
    if (typeof snapshot.domainDictionarySearchKeyword === "string") {
      domainDictionarySearchKeyword = snapshot.domainDictionarySearchKeyword;
    } else {
      domainDictionarySearchKeyword = "";
    }
    domainDictionarySortMode = normalizeDictionarySortMode(snapshot.domainDictionarySortMode);
    setInputCompactMode(!!snapshot.inputCompactEnabled, { persist: false });
    if (typeof snapshot.lastGeneratedAt === "string") {
      lastGeneratedAt = snapshot.lastGeneratedAt;
    } else {
      lastGeneratedAt = "";
    }
    foldState = normalizeFoldState(snapshot.foldState);
    syncFoldUiState();
    renderDomainDictionaryList();
    if (typeof snapshot.claimText === "string") claimInput.value = snapshot.claimText;
    if (typeof snapshot.resultText === "string") resultOutput.value = snapshot.resultText;
    updateResultSummary();
    updateClaimMeta();

    if (Array.isArray(snapshot.logs)) {
      snapshot.logs.forEach((entry) => {
        if (entry && typeof entry.message === "string") {
          appendProgressLine(entry.message, entry.timestamp);
        }
      });
    }

    if (Array.isArray(snapshot.devEntries)) {
      snapshot.devEntries.forEach((entry) => {
        if (!entry || typeof entry !== "object") return;
        appendDevItem(entry);
        updateLayerSummary(entry);
      });
    }

    applyStatusSnapshot(snapshot.status);
    if (snapshot.activeLogTab) {
      setActiveLogTab(snapshot.activeLogTab, { persist: false });
    }
    if (breadthSlider && Number.isFinite(snapshot.breadthValue)) {
      breadthSlider.value = String(snapshot.breadthValue);
      updateBreadthLabel(snapshot.breadthValue);
    }
    return true;
  } catch {
    return false;
  } finally {
    isRestoring = wasRestoring;
  }
}

function setStepState(layerKey, state) {
  const step = stepMap.get(layerKey);
  if (!step) return;
  step.dataset.state = state;
}

function setOverallStatus(state, text) {
  if (!statusRail || !statusText) return;
  statusRail.dataset.state = state;
  statusText.textContent = text;
  updateFoldBadges();
  updateDockMeta();
  scheduleStateSave();
}

function updateRerunButtonsState() {
  if (!rerunButtons || rerunButtons.length === 0) return;
  rerunButtons.forEach((button) => {
    const layer = button.dataset.rerunLayer;
    let disabled = isPipelineRunning;
    if (layer === "Layer 2" || layer === "Layer 3") {
      disabled = disabled || !lastArtifacts || !Array.isArray(lastArtifacts.elements);
    }
    if (layer === "Layer 3") {
      disabled = disabled || !lastArtifacts?.synonymsById || Object.keys(lastArtifacts.synonymsById).length === 0;
    }
    button.disabled = disabled;
  });
}

function resetPipelineStatus() {
  currentLayer = null;
  LAYER_ORDER.forEach((layer) => setStepState(layer, "idle"));
  setOverallStatus("idle", "대기 중");
  setModeBadge(null);
}

function updatePipelineStatus(layerKey) {
  const index = LAYER_ORDER.indexOf(layerKey);
  if (index === -1) return;

  currentLayer = layerKey;
  LAYER_ORDER.forEach((layer, idx) => {
    if (idx < index) {
      setStepState(layer, "done");
    } else if (idx === index) {
      setStepState(layer, "active");
    } else {
      setStepState(layer, "idle");
    }
  });

  const label = LAYER_LABELS[layerKey] || layerKey;
  setOverallStatus("running", `${label} 진행 중`);
}

function finalizePipelineStatus() {
  LAYER_ORDER.forEach((layer) => setStepState(layer, "done"));
  setOverallStatus("done", "완료");
  currentLayer = null;
}

function failPipelineStatus() {
  if (currentLayer) setStepState(currentLayer, "error");
  setOverallStatus("error", "오류 발생");
}

function normalizeLayer(layer) {
  if (!layer) return null;
  if (layer.startsWith("Layer 1")) return "Layer 1";
  if (layer.startsWith("Layer 2")) return "Layer 2";
  if (layer.startsWith("Layer 3")) return "Layer 3";
  return null;
}

function extractLayerKey(message) {
  if (!message) return null;
  const normalized = message.toLowerCase();
  if (normalized.includes("layer 1") || normalized.includes("레이어 1")) return "Layer 1";
  if (normalized.includes("layer 2") || normalized.includes("레이어 2")) return "Layer 2";
  if (normalized.includes("layer 3") || normalized.includes("레이어 3")) return "Layer 3";
  return null;
}

function appendProgressLine(message, timestamp = getTimestamp()) {
  if (!message) return;
  const line = document.createElement("div");
  line.className = "log-line";
  line.textContent = `[${timestamp}] ${message}`;
  logDiv.appendChild(line);
  logDiv.scrollTop = logDiv.scrollHeight;
  logEntries.push({ message, timestamp });
  updateFoldBadges();
  scheduleStateSave();
}

function appendDevItem({ layer, stage, label, model, content, timestamp }) {
  const item = document.createElement("details");
  item.className = "dev-item";
  if (stage) item.dataset.stage = stage;

  const summary = document.createElement("summary");
  const parts = [];
  if (layer) parts.push(layer);
  if (label) parts.push(label);
  if (stage) parts.push(stage);
  if (model) parts.push(`model: ${model}`);
  const timeLabel = timestamp || getTimestamp();
  summary.textContent = `[${timeLabel}] ${parts.join(" | ")}`;

  const pre = document.createElement("pre");
  if (typeof content === "string") {
    pre.textContent = content;
  } else {
    pre.textContent = JSON.stringify(content, null, 2);
  }

  item.appendChild(summary);
  item.appendChild(pre);
  devLogDiv.appendChild(item);
  devLogDiv.scrollTop = devLogDiv.scrollHeight;
  devEntries.push({ layer, stage, label, model, content, timestamp: timeLabel });
  updateFoldBadges();
  scheduleStateSave();
}

function clearLogs({ persist = true, keepArtifacts = false } = {}) {
  logDiv.innerHTML = "";
  devLogDiv.innerHTML = "";
  layerSummary.innerHTML = "";
  summaryItems.clear();
  logEntries.length = 0;
  devEntries.length = 0;
  resetPipelineStatus();
  if (!keepArtifacts) {
    lastArtifacts = null;
    lastGeneratedQuery = "";
    selectedSynonymsById.clear();
    renderSynonymEditor();
    if (breadthSlider) breadthSlider.disabled = true;
    renderQueryPreview();
  } else {
    updateRerunButtonsState();
  }
  updateResultSummary();
  updateFoldBadges();
  if (persist) scheduleStateSave();
}

function parseJsonFromResponse(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue to extraction attempts.
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // Continue.
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
      // Continue.
    }
  }

  const firstBracket = trimmed.indexOf("[");
  const lastBracket = trimmed.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    try {
      return JSON.parse(trimmed.slice(firstBracket, lastBracket + 1));
    } catch {
      // Ignore.
    }
  }

  return null;
}

function updateBreadthLabel(value = null) {
  if (!breadthLabel || !breadthSlider) return;
  const raw = value ?? Number.parseInt(breadthSlider.value, 10);
  const normalized = Number.isFinite(raw) ? raw : BREADTH_DEFAULT;
  let label = "보통";
  if (normalized <= 30) label = "좁게";
  if (normalized >= 70) label = "넓게";
  breadthLabel.textContent = label;
}

function getBreadthValue() {
  if (!breadthSlider) return BREADTH_DEFAULT;
  const value = Number.parseInt(breadthSlider.value, 10);
  return Number.isFinite(value) ? value : BREADTH_DEFAULT;
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatSynonymForPreview(item, element) {
  return formatSynonymForQuery(item, element);
}

function buildGroupForPreview(element, synonyms) {
  const formatted = [];
  const seen = new Set();
  (synonyms || []).forEach((item) => {
    const value = formatSynonymForPreview(item, element);
    if (!value || seen.has(value)) return;
    seen.add(value);
    formatted.push(value);
  });

  if (formatted.length === 0) return "";
  if (formatted.length === 1) return `(${formatted[0]})`;
  return `(${formatted.join(" | ")})`;
}

function getGroupColorClass(index) {
  const palette = ["hl-color-1", "hl-color-2", "hl-color-3", "hl-color-4", "hl-color-5", "hl-color-6", "hl-color-7", "hl-color-8"];
  return palette[index % palette.length];
}

function formatSynonymItem(item) {
  if (typeof item === "string") return item;
  if (item && typeof item.term === "string") {
    if (Array.isArray(item.parts) && item.parts.length > 0) {
      return `${item.term} (parts: ${item.parts.join("+")})`;
    }
    return item.term;
  }
  return JSON.stringify(item);
}

function normalizeSynonymKey(item) {
  if (typeof item === "string") {
    return item.trim().toLowerCase();
  }
  if (!item || typeof item !== "object") return "";
  const term = String(item.term || "").trim().toLowerCase();
  const parts = Array.isArray(item.parts) ? item.parts.map((part) => String(part || "").trim().toLowerCase()) : [];
  const match = item.match ? String(item.match).trim().toLowerCase() : "";
  return JSON.stringify({ term, parts, match });
}

function normalizeTermKey(term) {
  return String(term || "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-_]+/g, "");
}

function isBaseSynonym(item, element) {
  if (!element?.term) return false;
  const term = typeof item === "string" ? item : item?.term;
  if (!term) return false;
  return normalizeTermKey(term) === normalizeTermKey(element.term);
}

function formatSynonymDisplay(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  const term = item.term || "";
  if (Array.isArray(item.parts) && item.parts.length > 0) {
    return `${term} (${item.parts.join("+")})`;
  }
  return term || "";
}

function relaxPhraseMatch(item, relax) {
  if (!relax || !item || typeof item !== "object") return item;
  const matchValue = String(item.match || "").toLowerCase();
  if (matchValue !== "phrase") return item;
  const { match, ...rest } = item;
  return { ...rest };
}

function applyBreadthToSynonyms(items, element, breadthValue, { forceBase = true } = {}) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const normalizedBreadth = Math.min(Math.max(breadthValue, 0), 100);
  const ratio = normalizedBreadth / 100;
  const keepCount = Math.min(items.length, Math.max(1, Math.round(items.length * ratio)));
  const relaxPhrase = normalizedBreadth >= 70;
  const kept = [];
  const hasBase = forceBase && items.some((item) => isBaseSynonym(item, element));
  if (hasBase) {
    const baseItem = items.find((item) => isBaseSynonym(item, element));
    if (baseItem) kept.push(baseItem);
  }
  for (const item of items) {
    if (kept.length >= keepCount) break;
    if (forceBase && isBaseSynonym(item, element)) continue;
    kept.push(item);
  }
  return kept.map((item) => relaxPhraseMatch(item, relaxPhrase));
}

function resetEditorSelection() {
  selectedSynonymsById.clear();
  if (!lastArtifacts) return;
  lastArtifacts.elements.forEach((element) => {
    const synonyms = lastArtifacts.synonymsById?.[element.id] || [];
    const set = new Set();
    synonyms.forEach((item) => {
      const key = normalizeSynonymKey(item);
      if (key) set.add(key);
    });
    selectedSynonymsById.set(element.id, set);
  });
}

function buildFilteredSynonymsById() {
  if (!lastArtifacts) return {};
  const breadthValue = getBreadthValue();
  const filteredSynonymsById = {};
  lastArtifacts.elements.forEach((element) => {
    const synonyms = lastArtifacts.synonymsById?.[element.id] || [];
    const selected = selectedSynonymsById.get(element.id) || new Set();
    const pool = synonyms.filter((item) => {
      const key = normalizeSynonymKey(item);
      if (!key) return false;
      if (isBaseSynonym(item, element)) {
        return coreSynonymLockEnabled || selected.has(key);
      }
      return selected.has(key);
    });
    filteredSynonymsById[element.id] = applyBreadthToSynonyms(pool, element, breadthValue, {
      forceBase: coreSynonymLockEnabled
    });
  });
  return filteredSynonymsById;
}

function applyEditorSelectionToQuery() {
  if (!lastArtifacts) return;
  const filteredSynonymsById = buildFilteredSynonymsById();
  const rebuilt = buildQuery({
    elements: lastArtifacts.elements,
    relations: Array.isArray(lastArtifacts.relations) ? lastArtifacts.relations : [],
    synonymsById: filteredSynonymsById,
    nearDistance: DEFAULT_NEAR_DISTANCE
  });
  resultOutput.value = rebuilt;
  updateResultSummary();
  scheduleStateSave();
  renderQueryPreview();
}

function handleSynonymToggle(event) {
  const checkbox = event.target;
  if (!(checkbox instanceof HTMLInputElement)) return;
  const elementId = checkbox.dataset.elementId;
  const synKey = checkbox.dataset.synKey;
  if (!elementId || !synKey) return;
  const current = selectedSynonymsById.get(elementId) || new Set();
  if (checkbox.checked) {
    current.add(synKey);
  } else {
    current.delete(synKey);
  }
  selectedSynonymsById.set(elementId, current);
  applyEditorSelectionToQuery();
  renderSynonymEditor();
}

function selectAllSynonyms(elementId) {
  if (!lastArtifacts) return;
  const synonyms = lastArtifacts.synonymsById?.[elementId] || [];
  const set = new Set();
  synonyms.forEach((item) => {
    const key = normalizeSynonymKey(item);
    if (key) set.add(key);
  });
  selectedSynonymsById.set(elementId, set);
  applyEditorSelectionToQuery();
  renderSynonymEditor();
}

function clearSynonyms(elementId) {
  selectedSynonymsById.set(elementId, new Set());
  applyEditorSelectionToQuery();
  renderSynonymEditor();
}

function renderSynonymEditor() {
  if (!synonymEditor) return;
  synonymEditor.innerHTML = "";
  if (resetEditorButton) resetEditorButton.disabled = !lastArtifacts || isPipelineRunning;
  if (breadthSlider) breadthSlider.disabled = !lastArtifacts || isPipelineRunning;
  updateRerunButtonsState();

  if (!lastArtifacts || !Array.isArray(lastArtifacts.elements) || lastArtifacts.elements.length === 0) {
    const empty = document.createElement("div");
    empty.className = "synonym-empty";
    empty.textContent = "검색식 생성 후 표시됩니다.";
    synonymEditor.appendChild(empty);
    return;
  }

  const disableInputs = isPipelineRunning;
  lastArtifacts.elements.forEach((element) => {
    const synonyms = lastArtifacts.synonymsById?.[element.id] || [];
    const selected = selectedSynonymsById.get(element.id) || new Set();
    const totalCount = synonyms.length;
    const selectedCount = synonyms.filter((item) => {
      const key = normalizeSynonymKey(item);
      if (!key) return false;
      if (isBaseSynonym(item, element)) {
        return coreSynonymLockEnabled || selected.has(key);
      }
      return selected.has(key);
    }).length;

    const row = document.createElement("div");
    row.className = "synonym-row";

    const head = document.createElement("div");
    head.className = "synonym-head";

    const title = document.createElement("div");
    title.className = "synonym-title";
    title.textContent = `${element.id || "?"} · ${element.term || ""}`;

    const meta = document.createElement("div");
    meta.className = "synonym-meta";
    meta.textContent = `선택 ${selectedCount}/${totalCount}`;

    const actions = document.createElement("div");
    actions.className = "synonym-actions";

    const selectAllBtn = document.createElement("button");
    selectAllBtn.type = "button";
    selectAllBtn.className = "btn ghost tiny";
    selectAllBtn.textContent = "전체 선택";
    selectAllBtn.disabled = disableInputs;
    selectAllBtn.addEventListener("click", () => selectAllSynonyms(element.id));

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "btn ghost tiny";
    clearBtn.textContent = "모두 해제";
    clearBtn.disabled = disableInputs;
    clearBtn.addEventListener("click", () => clearSynonyms(element.id));

    actions.appendChild(selectAllBtn);
    actions.appendChild(clearBtn);

    head.appendChild(title);
    head.appendChild(meta);
    head.appendChild(actions);

    const list = document.createElement("div");
    list.className = "synonym-list";

    if (synonyms.length === 0) {
      const empty = document.createElement("div");
      empty.className = "synonym-empty";
      empty.textContent = "동의어 없음";
      list.appendChild(empty);
    } else {
      synonyms.forEach((item) => {
        const key = normalizeSynonymKey(item);
        if (!key) return;
        const isBase = isBaseSynonym(item, element);
        const isForcedBase = isBase && coreSynonymLockEnabled;
        const label = document.createElement("label");
        label.className = `synonym-chip${isForcedBase ? " is-disabled" : ""}`;

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = isForcedBase ? true : selected.has(key);
        checkbox.disabled = isForcedBase || disableInputs;
        checkbox.dataset.elementId = element.id;
        checkbox.dataset.synKey = key;
        checkbox.addEventListener("change", handleSynonymToggle);

        const text = document.createElement("span");
        text.textContent = formatSynonymDisplay(item);

        label.appendChild(checkbox);
        label.appendChild(text);

        if (isBase) {
          const pill = document.createElement("span");
          pill.className = "synonym-pill";
          pill.textContent = coreSynonymLockEnabled ? "required" : "core";
          label.appendChild(pill);
        } else if (item && typeof item === "object" && String(item.match || "").toLowerCase() === "phrase") {
          const pill = document.createElement("span");
          pill.className = "synonym-pill";
          pill.textContent = "phrase";
          label.appendChild(pill);
        }

        list.appendChild(label);
      });
    }

    row.appendChild(head);
    row.appendChild(list);
    synonymEditor.appendChild(row);
  });
  updateResultSummary();
}

function renderQueryPreview() {
  if (!queryPreview) return;
  if (!lastArtifacts || !Array.isArray(lastArtifacts.elements) || lastArtifacts.elements.length === 0) {
    queryPreview.textContent = "검색식 생성 후 표시됩니다.";
    queryPreview.classList.add("is-empty");
    return;
  }

  const filteredSynonymsById = buildFilteredSynonymsById();
  const groupById = {};
  lastArtifacts.elements.forEach((element, index) => {
    const synonyms = filteredSynonymsById[element.id] || [];
    const group = buildGroupForPreview(element, synonyms);
    if (group) {
      groupById[element.id] = {
        text: group,
        colorClass: getGroupColorClass(index),
        label: element.term || element.id
      };
    }
  });

  const parts = [];

  lastArtifacts.elements.forEach((element) => {
    const group = groupById[element.id];
    if (group) parts.push({ type: "group", group });
  });

  if (parts.length === 0) {
    queryPreview.textContent = "미리보기에 그룹이 없습니다.";
    queryPreview.classList.add("is-empty");
    return;
  }

  const htmlParts = [];
  parts.forEach((part, index) => {
    if (index > 0) {
      htmlParts.push('<span class="query-operator"> &amp; </span>');
    }
    if (part.type === "group") {
      const safeGroup = escapeHtml(part.group.text);
      const safeLabel = escapeHtml(part.group.label);
      htmlParts.push(`<span class="hl-group ${part.group.colorClass}" title="${safeLabel}">${safeGroup}</span>`);
    }
  });

  queryPreview.classList.remove("is-empty");
  queryPreview.innerHTML = htmlParts.join("");
}

function buildSummaryContent(parsed, fallbackText) {
  if (Array.isArray(parsed)) {
    return {
      type: "list",
      items: parsed.map(formatSynonymItem)
    };
  }

  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.elements)) {
      return {
        type: "list",
        items: parsed.elements.map((element) => {
          const parts = Array.isArray(element.parts) ? ` (parts: ${element.parts.join("+")})` : "";
          return `${element.id || "?"}: ${element.term || ""}${element.type ? ` [${element.type}]` : ""}${parts}`;
        })
      };
    }

    if (Array.isArray(parsed.relations)) {
      return {
        type: "list",
        items: parsed.relations.map((rel) => {
          const near = rel.near ? `, near=${rel.near}` : "";
          return `${rel.source || "?"} -> ${rel.target || "?"} (${rel.distance || "co-exist"}${near})`;
        })
      };
    }

    const synonyms = parsed.best_synonyms || parsed.synonyms || parsed.terms;
    if (Array.isArray(synonyms)) {
      const items = synonyms.map(formatSynonymItem);
      if (parsed.scores && typeof parsed.scores === "object") {
        const scorePairs = Object.entries(parsed.scores).map(([key, value]) => `${key}=${value}`);
        if (scorePairs.length > 0) items.push(`scores: ${scorePairs.join(", ")}`);
      }
      return {
        type: "list",
        items
      };
    }

    if (typeof parsed.final_query === "string") {
      return { type: "pre", content: parsed.final_query };
    }

    if (typeof parsed.query_structure === "string") {
      return { type: "pre", content: parsed.query_structure };
    }

    return { type: "pre", content: JSON.stringify(parsed, null, 2) };
  }

  return { type: "pre", content: fallbackText || "" };
}

function upsertSummaryCard(key, title, meta, content) {
  let card = summaryItems.get(key);
  if (!card) {
    card = document.createElement("div");
    card.className = "summary-card";
    summaryItems.set(key, card);
  }

  card.innerHTML = "";

  const heading = document.createElement("div");
  heading.className = "summary-title";
  heading.textContent = title;

  const metaLine = document.createElement("div");
  metaLine.className = "summary-meta";
  metaLine.textContent = meta;

  card.appendChild(heading);
  card.appendChild(metaLine);

  if (content.type === "list") {
    const list = document.createElement("ul");
    list.className = "summary-list";
    content.items.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      list.appendChild(li);
    });
    card.appendChild(list);
  } else {
    const pre = document.createElement("pre");
    pre.className = "summary-pre";
    pre.textContent = content.content;
    card.appendChild(pre);
  }

  layerSummary.appendChild(card);
  layerSummary.scrollTop = layerSummary.scrollHeight;
}

function updateLayerSummary(entry) {
  if (!entry || typeof entry !== "object") return;
  if (entry.stage !== "response" && entry.stage !== "assembly") return;
  const allowedLayers = new Set(["Layer 1", "Layer 2-B", "Layer 3"]);
  if (!allowedLayers.has(entry.layer)) return;

  const key = `${entry.layer || "layer"}:${entry.label || "response"}`;
  const parsed = parseJsonFromResponse(entry.content);
  const titleParts = [entry.layer, entry.label].filter(Boolean);
  const title = titleParts.length > 0 ? titleParts.join(" | ") : "응답";
  const metaParts = [];
  if (entry.model) metaParts.push(`모델: ${entry.model}`);
  if (entry.stage) metaParts.push(`단계: ${entry.stage}`);
  const meta = metaParts.join(" | ") || "";

  const content = buildSummaryContent(parsed, typeof entry.content === "string" ? entry.content : "");
  upsertSummaryCard(key, title, meta, content);
}

function handleArtifact(entry) {
  if (!entry || typeof entry !== "object") return;
  const payload = entry.payload;
  if (!payload || typeof payload !== "object") return;

  const elements = Array.isArray(payload.elements) ? payload.elements : [];
  const relations = Array.isArray(payload.relations) ? payload.relations : [];
  const synonymsById = payload.synonymsById && typeof payload.synonymsById === "object"
    ? payload.synonymsById
    : {};
  const coreElementIds = Array.isArray(payload.coreElementIds)
    ? payload.coreElementIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];

  if (elements.length === 0 || Object.keys(synonymsById).length === 0) return;

  lastArtifacts = {
    elements,
    relations,
    synonymsById,
    mode: payload.mode || null,
    coreElementIds: coreElementIds.length > 0
      ? coreElementIds
      : elements.map((element) => String(element?.id || "").trim()).filter(Boolean)
  };
  const payloadQueryVersionId = normalizeQueryVersionId(payload.queryVersionId);
  if (payloadQueryVersionId) currentQueryVersionId = payloadQueryVersionId;
  resetEditorSelection();
  updateBreadthLabel();
  renderSynonymEditor();
  renderQueryPreview();
}

function handleLog(entry) {
  if (typeof entry === "string") {
    appendProgressLine(entry);
    const layerKey = extractLayerKey(entry);
    if (layerKey) updatePipelineStatus(layerKey);
    const mode = parseModeFromMessage(entry);
    if (mode) setModeBadge(mode);
    return;
  }

  if (!entry || typeof entry !== "object") return;

  if (entry.type === "artifact") {
    handleArtifact(entry);
    return;
  }

  if (entry.type === "progress") {
    appendProgressLine(entry.message || "");
    const layerKey = extractLayerKey(entry.message || "");
    if (layerKey) updatePipelineStatus(layerKey);
    const mode = parseModeFromMessage(entry.message || "");
    if (mode) setModeBadge(mode);
    return;
  }

  if (entry.type === "dev") {
    appendDevItem(entry);
    updateLayerSummary(entry);
    if (entry.label === "Pipeline Mode" && entry.content?.mode) {
      setModeBadge(entry.content.mode);
    }
    const normalizedLayer = normalizeLayer(entry.layer);
    if (normalizedLayer) updatePipelineStatus(normalizedLayer);
    return;
  }

  appendProgressLine(JSON.stringify(entry));
}

function setLoading(isLoading) {
  if (generateButton) {
    generateButton.disabled = isLoading;
    generateButton.textContent = isLoading ? "생성 중..." : "검색식 생성";
  }
  if (dockGenerateButton) {
    dockGenerateButton.disabled = isLoading;
  }
  if (dockCopyButton) {
    dockCopyButton.disabled = isLoading;
  }
  if (dockExportButton) {
    dockExportButton.disabled = isLoading;
  }
  if (copyResultButton) copyResultButton.disabled = isLoading;
  if (exportQueryButton) exportQueryButton.disabled = isLoading;
  if (exportBundleButton) exportBundleButton.disabled = isLoading;
  isPipelineRunning = isLoading;
  if (breadthSlider) breadthSlider.disabled = isLoading || !lastArtifacts;
  if (resetEditorButton) resetEditorButton.disabled = isLoading || !lastArtifacts;
  refreshDomainDictionaryUiState();
  renderDomainDictionaryList();
  updateRerunButtonsState();
  updateDockMeta();
}

async function rerunLayer(layerKey) {
  const claim = claimInput.value.trim();
  if (!claim) {
    appendProgressLine("청구항을 입력해 주세요.");
    showToast("청구항을 입력해 주세요.", { type: "warning" });
    return;
  }

  if ((layerKey === "Layer 2" || layerKey === "Layer 3") && !lastArtifacts) {
    appendProgressLine("재실행할 기존 결과가 없습니다.");
    showToast("재실행할 기존 결과가 없습니다.", { type: "warning" });
    return;
  }

  const options = buildPipelineOptions({ startLayer: layerKey, mockMode: mockModeEnabled });
  if (layerKey === "Layer 2" || layerKey === "Layer 3") {
    options.elements = lastArtifacts.elements;
    options.relations = lastArtifacts.relations;
    options.mode = lastArtifacts.mode;
    options.coreElementIds = Array.isArray(lastArtifacts.coreElementIds)
      ? [...lastArtifacts.coreElementIds]
      : [];
  }
  if (layerKey === "Layer 3") {
    options.synonymsById = buildFilteredSynonymsById();
  }

  clearLogs({ keepArtifacts: true });
  renderQueryPreview();
  setOverallStatus("running", "요청 준비 중");
  setLoading(true);

  try {
    appendProgressLine(`${layerKey} 재실행 시작`);
    const result = await runPipeline(claim, handleLog, options);
    resultOutput.value = result;
    lastGeneratedQuery = result;
    lastGeneratedAt = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    updateResultSummary();
    scheduleStateSave();
    renderQueryPreview();
    appendProgressLine("검색식이 생성되었습니다.");
    showToast("레이어 재실행이 완료되었습니다.", { type: "success" });
    finalizePipelineStatus();
  } catch (error) {
    appendProgressLine(`오류: ${error.message}`);
    showToast(`재실행 실패: ${error.message}`, { type: "error" });
    failPipelineStatus();
  } finally {
    setLoading(false);
  }
}

async function ensureSharedKeyAvailable() {
  if (mockModeEnabled) return;
  const data = await chrome.storage.local.get("ksuiteSharedApiKey");
  const key = String(data.ksuiteSharedApiKey || "").trim();
  if (!key) {
    appendProgressLine("공통 API 키가 없습니다. K-SUITE 팝업 설정에서 먼저 저장해 주세요.");
  }
}


if (claimInput) {
  claimInput.addEventListener("input", () => {
    updateClaimMeta();
    scheduleStateSave();
  });
}

if (sampleButton && claimInput) {
  sampleButton.addEventListener("click", () => {
    claimInput.value = SAMPLE_CLAIM;
    updateClaimMeta();
    scheduleStateSave();
    claimInput.focus();
  });
}

if (clearInputButton && claimInput) {
  clearInputButton.addEventListener("click", () => {
    claimInput.value = "";
    updateClaimMeta();
    scheduleStateSave();
    claimInput.focus();
  });
}

if (toggleInputCompactButton) {
  toggleInputCompactButton.addEventListener("click", () => {
    setInputCompactMode(!inputCompactEnabled);
  });
}

if (dockGenerateButton) {
  dockGenerateButton.addEventListener("click", () => {
    if (generateButton) generateButton.click();
  });
}

if (dockCopyButton) {
  dockCopyButton.addEventListener("click", () => {
    if (copyResultButton) copyResultButton.click();
  });
}

if (dockExportButton) {
  dockExportButton.addEventListener("click", () => {
    if (exportBundleButton) exportBundleButton.click();
  });
}

if (dockAdvancedButton) {
  dockAdvancedButton.addEventListener("click", () => {
    setFoldCollapsed("synonyms", false, { scroll: true });
    setFoldCollapsed("logs", false);
    showToast("Advanced panels opened.", { type: "success", durationMs: 1200 });
  });
}
if (mockModeButton) {
  mockModeButton.addEventListener("click", async () => {
    const next = !mockModeEnabled;
    setMockMode(next);
    appendProgressLine(next ? "Mock mode enabled." : "Mock mode disabled.");
    if (!next) {
      await ensureSharedKeyAvailable();
    }
  });
}

if (coreSynonymToggle instanceof HTMLInputElement) {
  coreSynonymToggle.addEventListener("change", () => {
    setCoreSynonymLock(coreSynonymToggle.checked);
    appendProgressLine(
      coreSynonymLockEnabled
        ? "Core synonym lock enabled: base term forced."
        : "Core synonym lock disabled: base term can be removed."
    );
  });
}

if (domainDictionaryToggle instanceof HTMLInputElement) {
  domainDictionaryToggle.addEventListener("change", () => {
    setDomainDictionaryEnabled(domainDictionaryToggle.checked);
    appendProgressLine(
      domainDictionaryEnabled
        ? "Domain dictionary enabled."
        : "Domain dictionary disabled."
    );
    showToast(
      domainDictionaryEnabled ? "Domain dictionary enabled." : "Domain dictionary disabled.",
      { type: domainDictionaryEnabled ? "success" : "warning" }
    );
  });
}

if (openDomainDictModalButton) {
  openDomainDictModalButton.addEventListener("click", () => {
    openDomainDictionaryModal();
  });
}

if (addDomainDictButton) {
  addDomainDictButton.addEventListener("click", () => {
    const result = addOrMergeDomainDictionaryEntry();
    if (!result.ok) {
      appendProgressLine(result.reason);
      showToast(result.reason, { type: "warning" });
      return;
    }

    if (domainDictTermsInput instanceof HTMLTextAreaElement || domainDictTermsInput instanceof HTMLInputElement) {
      domainDictTermsInput.value = "";
      domainDictTermsInput.focus();
    }
    if (domainDictKeyInput instanceof HTMLInputElement) {
      domainDictKeyInput.value = "";
      domainDictKeyInput.focus();
    }
    appendProgressLine(
      result.merged
        ? `Dictionary merged for '${result.key}' (+${result.count}).`
        : `Dictionary entry added for '${result.key}' (${result.count}).`
    );
    showToast(
      result.merged
        ? `Dictionary merged: ${result.key}`
        : `Dictionary entry added: ${result.key}`,
      { type: "success" }
    );
  });
}

if (domainDictTermsInput instanceof HTMLInputElement) {
  domainDictTermsInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (addDomainDictButton) addDomainDictButton.click();
  });
}

if (domainDictTermsInput instanceof HTMLTextAreaElement) {
  domainDictTermsInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    if (addDomainDictButton) addDomainDictButton.click();
  });
}

if (domainDictSearchInput instanceof HTMLInputElement) {
  domainDictSearchInput.addEventListener("input", () => {
    domainDictionarySearchKeyword = domainDictSearchInput.value || "";
    renderDomainDictionaryList();
    scheduleStateSave();
  });
}

if (domainDictSortSelect instanceof HTMLSelectElement) {
  domainDictSortSelect.addEventListener("change", () => {
    domainDictionarySortMode = normalizeDictionarySortMode(domainDictSortSelect.value);
    renderDomainDictionaryList();
    scheduleStateSave();
  });
}

if (domainDictImportButton) {
  domainDictImportButton.addEventListener("click", () => {
    if (domainDictFileInput instanceof HTMLInputElement) {
      domainDictFileInput.value = "";
      domainDictFileInput.click();
    }
  });
}

if (domainDictExportButton) {
  domainDictExportButton.addEventListener("click", () => {
    exportDomainDictionaryEntries();
  });
}

if (domainDictClearButton) {
  domainDictClearButton.addEventListener("click", () => {
    clearDomainDictionaryEntries();
  });
}

if (domainDictFileInput instanceof HTMLInputElement) {
  domainDictFileInput.addEventListener("change", async () => {
    const file = domainDictFileInput.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const rawEntries = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.entries)
          ? parsed.entries
          : Array.isArray(parsed?.domainDictionary)
            ? parsed.domainDictionary
            : [];
      const result = importDomainDictionaryEntries(rawEntries);
      if (!result.ok) {
        appendProgressLine(result.reason);
        showToast(result.reason, { type: "warning" });
        return;
      }
      appendProgressLine(
        `Dictionary import complete: ${result.mergedEntries} entries, +${result.mergedTerms} terms.`
      );
      showToast(
        `Dictionary import complete: ${result.mergedEntries} entries`,
        { type: "success" }
      );
    } catch {
      appendProgressLine("Failed to import dictionary JSON.");
      showToast("Failed to import dictionary JSON.", { type: "error" });
    }
  });
}

if (logTabButtons.length > 0) {
  logTabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setActiveLogTab(button.dataset.logTab);
    });
  });
}

if (breadthSlider) {
  breadthSlider.addEventListener("input", () => {
    updateBreadthLabel();
    scheduleStateSave();
    if (lastArtifacts) {
      applyEditorSelectionToQuery();
      renderSynonymEditor();
    }
  });
}

if (infoButtons.length > 0) {
  infoButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.infoKey;
      openInfoModal(key);
    });
  });
}

if (infoModalCloseTriggers.length > 0) {
  infoModalCloseTriggers.forEach((trigger) => {
    trigger.addEventListener("click", () => {
      closeInfoModal();
    });
  });
}

if (domainDictModalCloseTriggers.length > 0) {
  domainDictModalCloseTriggers.forEach((trigger) => {
    trigger.addEventListener("click", () => {
      closeDomainDictionaryModal();
    });
  });
}

if (foldToggleButtons.length > 0) {
  foldToggleButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.foldToggle;
      if (!key || !(key in foldState)) return;
      const nextCollapsed = !foldState[key];
      setFoldCollapsed(key, nextCollapsed);
    });
  });
}

if (quickNavButtons.length > 0) {
  quickNavButtons.forEach((button) => {
    button.addEventListener("click", () => {
      focusPanel(button.dataset.focusPanel);
    });
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (domainDictModal && !domainDictModal.classList.contains("is-hidden")) {
    closeDomainDictionaryModal();
  }
  if (infoModal && !infoModal.classList.contains("is-hidden")) {
    closeInfoModal();
  }
});

if (copyResultButton) {
  copyResultButton.addEventListener("click", async () => {
    const text = resultOutput.value.trim();
    if (!text) {
      appendProgressLine("복사할 검색식이 없습니다.");
      showToast("복사할 검색식이 없습니다.", { type: "warning" });
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      appendProgressLine("검색식을 복사했습니다.");
      showToast("검색식을 복사했습니다.", { type: "success" });
    } catch {
      resultOutput.focus();
      resultOutput.select();
      const success = document.execCommand("copy");
      appendProgressLine(success ? "검색식을 복사했습니다." : "복사에 실패했습니다.");
      showToast(success ? "검색식을 복사했습니다." : "복사에 실패했습니다.", {
        type: success ? "success" : "error"
      });
      resultOutput.setSelectionRange(0, 0);
    }
  });
}

if (exportQueryButton) {
  exportQueryButton.addEventListener("click", () => {
    exportQueryOnly();
  });
}

if (exportBundleButton) {
  exportBundleButton.addEventListener("click", () => {
    exportJsonBundle();
  });
}

if (clearLogsButton) {
  clearLogsButton.addEventListener("click", () => {
    clearLogs();
  });
}

if (rerunButtons.length > 0) {
  rerunButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const layer = button.dataset.rerunLayer;
      if (layer) rerunLayer(layer);
    });
  });
}

if (resetEditorButton) {
  resetEditorButton.addEventListener("click", () => {
    if (!lastArtifacts) return;
    resetEditorSelection();
    renderSynonymEditor();
    if (lastGeneratedQuery) {
      resultOutput.value = lastGeneratedQuery;
      updateResultSummary();
      scheduleStateSave();
    } else {
      applyEditorSelectionToQuery();
    }
  });
}

if (generateButton && claimInput) {
  generateButton.addEventListener("click", async () => {
    const claim = claimInput.value.trim();
    if (!claim) {
      appendProgressLine("Please enter a claim.");
      showToast("Please enter a claim.", { type: "warning" });
      return;
    }

    clearLogs();
    setOverallStatus("running", "Preparing request");
    setLoading(true);

    try {
      const result = await runPipeline(claim, handleLog, buildPipelineOptions({ mockMode: mockModeEnabled }));
      resultOutput.value = result;
      lastGeneratedQuery = result;
      lastGeneratedAt = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      updateResultSummary();
      scheduleStateSave();
      renderQueryPreview();
      await persistQueryVersionSnapshot();
      appendProgressLine("Query generated successfully.");
      showToast("Query generated successfully.", { type: "success" });
      finalizePipelineStatus();
    } catch (error) {
      appendProgressLine(`Error: ${error.message}`);
      showToast(`Generation failed: ${error.message}`, { type: "error" });
      failPipelineStatus();
    } finally {
      setLoading(false);
    }
  });
}

async function initialize() {
  isRestoring = true;
  setMockMode(MOCK_MODE_DEFAULT, { persist: false });
  setInputCompactMode(false, { persist: false });
  setCoreSynonymLock(CORE_SYNONYM_LOCK_DEFAULT, { persist: false, rebuild: false });
  domainDictionaryEntries = [];
  domainDictionarySearchKeyword = "";
  domainDictionarySortMode = "updated_desc";
  lastGeneratedAt = "";
  foldState = normalizeFoldState(null);
  syncFoldUiState();
  setDomainDictionaryEnabled(DOMAIN_DICTIONARY_ENABLED_DEFAULT, { persist: false });
  await ensureSharedKeyAvailable();
  await restorePanelState();
  await persistSharedClaimText();
  isRestoring = false;
  updateClaimMeta();
  updateBreadthLabel();
  if (breadthSlider && !lastArtifacts) {
    breadthSlider.disabled = true;
  }
  renderSynonymEditor();
  renderQueryPreview();
  refreshDomainDictionaryUiState();
  renderDomainDictionaryList();
  updateResultSummary();
  updateFoldBadges();
  updateDockMeta();
  syncModalLockState();
  if (logTabButtons.length > 0) {
    setActiveLogTab(activeLogTab, { persist: false });
  }

  if (!unloadHookAdded) {
    unloadHookAdded = true;
    window.addEventListener("pagehide", flushPanelState);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushPanelState();
    });
  }
}

initialize();
