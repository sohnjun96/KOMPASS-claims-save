import { makeSessionId, makeRunId, makeQueryVersionId, nowIso } from "./core/ids.js";
import {
  loadWorkspace,
  saveSessions,
  appendEvalHistory,
  saveSettings,
  getStorageKeys
} from "./core/storage.js";
import {
  generateInitialQuery,
  evaluateCapturedRows,
  summarizeIteration,
  autoRefineQuery,
  manualGateRefineQuery,
  autoRepairDuplicateQuery
} from "./core/engine.js";
import {
  buildExpression,
  deriveQueryPlanFromExpression,
  normalizeQueryPlan,
  dedupeTermsAcrossActiveGroups
} from "./core/query_builder.js";
import {
  buildQueryFingerprint,
  buildSemanticQueryFingerprint,
  buildActiveTermsFingerprint,
  collectActiveCanonicalTerms
} from "./core/query_fingerprint.js";
import {
  normalizeDialogKind,
  deriveDialogSignalFromMonitorState,
  deriveAutoDecisionFromDialogAndCount,
  makeCaptureStabilitySnapshot,
  updateCaptureStabilityWindow,
  classifyDerivedTabs,
  nextAutoStage
} from "./core/auto_loop.js";
import {
  COUNT_CONTROL_DEFAULTS,
  parseKompassDialogCount,
  classifyResultCount,
  resolveBestObservedCount,
  computeCountDistanceScore,
  computeReductionRatio,
  buildRepeatReasonSignature,
  countRecentSignatureRepeats
} from "./core/count_control.js";
import {
  REASONING_EFFORT_ENUM,
  REASONING_PROMPT_KEYS,
  normalizeModelControls
} from "./core/model_controls.js";

const SHARED_STORAGE_KEYS = globalThis.KSUITE_STORAGE_KEYS || {};
const CLAIM_KEY_KQUERY = SHARED_STORAGE_KEYS.KQUERY_CLAIM_TEXT || "ksuiteClaimKQuery";
const CLAIM_KEY_KSCAN = SHARED_STORAGE_KEYS.KSCAN_CLAIM_TEXT || "ksuiteClaimKScan";
const KRESEARCH_STORAGE_KEYS = getStorageKeys();
const EVAL_HISTORY_STORAGE_KEY = KRESEARCH_STORAGE_KEYS?.evalHistory || "kresearch_eval_history_v1";

const MANUAL_DECISION_PENDING = "pending";
const MANUAL_DECISION_TOO_MANY = "too_many";
const MANUAL_DECISION_TOO_FEW = "too_few";
const MANUAL_DECISION_PROCEED = "proceed";
const MANUAL_USER_EDIT_HISTORY_WEIGHT = 3;
const CAPTURE_STATUS_POLL_MS = 1200;
const AUTO_TOO_MANY_RESULT_THRESHOLD = 300;
const AUTO_DIALOG_TIMEOUT_MS = 12000;
const AUTO_COUNT_TIMEOUT_MS = 12000;
const AUTO_CLAIM_BATCH_STABLE_MS = 2000;
const AUTO_CLAIM_BATCH_TIMEOUT_MS = 30000;
const AUTO_POLL_INTERVAL_MS = 300;
const AUTO_MAX_RETRY_PER_STAGE = 3;
const AUTO_START_RECOVERY_MAX_RETRIES = 2;
const AUTO_START_RECOVERY_DELAY_MS = 700;
const AUTO_NO_CHANGE_FALLBACK_REPEAT_COUNT = 3;
const AUTO_DIALOG_PRIORITY_WINDOW_MS = 1200;
const QUERY_APPLY_RETRY_MAX_ATTEMPTS_AUTO = 6;
const QUERY_APPLY_RETRY_MAX_ATTEMPTS_MANUAL = 3;
const QUERY_APPLY_RETRY_DELAY_MS = 350;
const DEFAULT_MAX_ITERATIONS = 15;
const TARGET_COUNT_RANGE = Array.isArray(COUNT_CONTROL_DEFAULTS?.targetCountRange)
  ? COUNT_CONTROL_DEFAULTS.targetCountRange.slice(0, 2)
  : [0, 300];
const SOFT_TARGET_RANGE = Array.isArray(COUNT_CONTROL_DEFAULTS?.softTargetRange)
  ? COUNT_CONTROL_DEFAULTS.softTargetRange.slice(0, 2)
  : [50, 180];
const ACTIVE_PANE_EXECUTE = "execute";
const ACTIVE_PANE_RESULTS = "results";
const ACTIVE_PANE_ADVANCED = "advanced";

const AUTO_STATUS_IDLE = "idle";
const AUTO_STATUS_RUNNING = "running";
const AUTO_STATUS_STOPPING = "stopping";
const AUTO_STATUS_PAUSED = "paused";
const AUTO_STATUS_ERROR = "error";
const AUTO_STATUS_DONE = "done";

const AUTO_STAGE = {
  PREPARE: "prepare",
  ENSURE_INITIAL_QUERY: "ensure_initial_query",
  START_CAPTURE: "start_capture",
  CLICK_INITIAL_SCREEN: "click_initial_screen",
  APPLY_QUERY: "apply_query",
  CLICK_SEARCH: "click_search",
  WAIT_DIALOG: "wait_dialog",
  HANDLE_DIALOG_MANY: "handle_dialog_many",
  HANDLE_DIALOG_FEW: "handle_dialog_few",
  WAIT_RESULT_COUNT: "wait_result_count",
  HANDLE_COUNT_MANY: "handle_count_many",
  HANDLE_COUNT_PROCEED: "handle_count_proceed",
  MARK_PROCEED: "mark_proceed",
  CLICK_CLAIM_BATCH: "click_claim_batch",
  WAIT_CLAIM_BATCH_CAPTURE: "wait_claim_batch_capture",
  CLOSE_CLAIM_BATCH_TABS: "close_claim_batch_tabs",
  FINISH_CYCLE: "finish_cycle",
  WAIT_CYCLE_RESULT: "wait_cycle_result",
  ADVANCE_ITERATION: "advance_iteration",
  COMPLETED: "completed",
  PAUSED_MANUAL_REQUIRED: "paused_manual_required",
  ERROR: "error"
};

const claimInput = document.getElementById("claimInput");
const claimStat = document.getElementById("claimStat");
const claimCard = document.getElementById("claimCard");
const importKQueryClaimBtn = document.getElementById("importKQueryClaimBtn");
const importKScanClaimBtn = document.getElementById("importKScanClaimBtn");
const buildInitialQueryBtn = document.getElementById("buildInitialQueryBtn");
const shellHeader = document.getElementById("shellHeader");
const primaryModeTabs = document.getElementById("primaryModeTabs");
const appFooter = document.querySelector(".app-footer");
const paneExecuteTab = document.getElementById("paneExecuteTab");
const paneResultsTab = document.getElementById("paneResultsTab");
const paneAdvancedTab = document.getElementById("paneAdvancedTab");
const paneExecute = document.getElementById("paneExecute");
const paneResults = document.getElementById("paneResults");
const paneAdvanced = document.getElementById("paneAdvanced");
const shellAutoStatus = document.getElementById("shellAutoStatus");
const shellStage = document.getElementById("shellStage");
const shellCurrentQuery = document.getElementById("shellCurrentQuery");
const shellSession = document.getElementById("shellSession");
const shellIteration = document.getElementById("shellIteration");
const shellQueryVersion = document.getElementById("shellQueryVersion");
const heroAutoStatus = document.getElementById("heroAutoStatus");
const heroStage = document.getElementById("heroStage");
const heroCurrentQuery = document.getElementById("heroCurrentQuery");
const heroNextAction = document.getElementById("heroNextAction");
const heroRecentDialog = document.getElementById("heroRecentDialog");
const heroRecentCount = document.getElementById("heroRecentCount");
const heroError = document.getElementById("heroError");
const heroRetry = document.getElementById("heroRetry");
const heroIteration = document.getElementById("heroIteration");
const heroSession = document.getElementById("heroSession");
const executeQuerySummary = document.getElementById("executeQuerySummary");
const executeQueryDiffLine = document.getElementById("executeQueryDiffLine");
const executeQueryWhy = document.getElementById("executeQueryWhy");
const executeQueryDetails = document.getElementById("executeQueryDetails");
const execOpenDetailsBtn = document.getElementById("execOpenDetailsBtn");
const execEditQueryBtn = document.getElementById("execEditQueryBtn");
const execCopyQueryBtn = document.getElementById("execCopyQueryBtn");
const execRollbackBtn = document.getElementById("execRollbackBtn");
const manualInterventionCard = document.getElementById("manualInterventionCard");
const manualInterventionMessage = document.getElementById("manualInterventionMessage");
const manualInterventionActions = document.getElementById("manualInterventionActions");
const openAdvancedFromInterventionBtn = document.getElementById("openAdvancedFromInterventionBtn");
const abortLoopBtnAdvanced = document.getElementById("abortLoopBtnAdvanced");
const manualTooManyBtnAdv = document.getElementById("manualTooManyBtnAdv");
const manualTooFewBtnAdv = document.getElementById("manualTooFewBtnAdv");
const manualProceedBtnAdv = document.getElementById("manualProceedBtnAdv");
const advSectionManualLoop = document.getElementById("advSectionManualLoop");
const advSectionKompassControl = document.getElementById("advSectionKompassControl");
const advSectionManualGate = document.getElementById("advSectionManualGate");
const advSectionModelControls = document.getElementById("advSectionModelControls");
const advSectionQueryEditor = document.getElementById("advSectionQueryEditor");
const advSectionEvalProgress = document.getElementById("advSectionEvalProgress");
const advSectionDiagnostics = document.getElementById("advSectionDiagnostics");
const advSectionFeedback = document.getElementById("advSectionFeedback");
const globalReasoningEffortSelect = document.getElementById("globalReasoningEffortSelect");
const enablePerPromptReasoningEffortToggle = document.getElementById("enablePerPromptReasoningEffortToggle");
const perPromptReasoningControls = document.getElementById("perPromptReasoningControls");
const perPromptReasoningFeatureExtract = document.getElementById("perPromptReasoningFeatureExtract");
const perPromptReasoningQuerySeed = document.getElementById("perPromptReasoningQuerySeed");
const perPromptReasoningQueryRefine = document.getElementById("perPromptReasoningQueryRefine");
const perPromptReasoningQueryDuplicateRepair = document.getElementById("perPromptReasoningQueryDuplicateRepair");
const perPromptReasoningQueryPlanRemap = document.getElementById("perPromptReasoningQueryPlanRemap");
const perPromptReasoningCitationEvalJson = document.getElementById("perPromptReasoningCitationEvalJson");

const saveManualQueryBtn = document.getElementById("saveManualQueryBtn");
const copyQueryBtn = document.getElementById("copyQueryBtn");
const rollbackQueryBtn = document.getElementById("rollbackQueryBtn");
const queryExpression = document.getElementById("queryExpression");
const queryDiffSummary = document.getElementById("queryDiffSummary");
const queryDiffAdded = document.getElementById("queryDiffAdded");
const queryDiffRemoved = document.getElementById("queryDiffRemoved");
const activeGroupsMeta = document.getElementById("activeGroupsMeta");
const inactiveGroupsMeta = document.getElementById("inactiveGroupsMeta");
const focusFeatureMeta = document.getElementById("focusFeatureMeta");
const simplificationMeta = document.getElementById("simplificationMeta");
const sessionIdMeta = document.getElementById("sessionIdMeta");
const queryVersionMeta = document.getElementById("queryVersionMeta");
const iterationMeta = document.getElementById("iterationMeta");
const statusMeta = document.getElementById("statusMeta");

const startCaptureBtn = document.getElementById("startCaptureBtn");
const finishCycleBtn = document.getElementById("finishCycleBtn");
const abortLoopBtn = document.getElementById("abortLoopBtn");
const applyQueryTextBtn = document.getElementById("applyQueryTextBtn");
const clickSearchBtn = document.getElementById("clickSearchBtn");
const clickInitialScreenBtn = document.getElementById("clickInitialScreenBtn");
const startAutoModeBtn = document.getElementById("startAutoModeBtn");
const stopAutoModeBtn = document.getElementById("stopAutoModeBtn");
const loopStatusDock = document.getElementById("loopStatusDock");
const runMeta = document.getElementById("runMeta");
const tabMeta = document.getElementById("tabMeta");
const loopStatus = document.getElementById("loopStatus");
const diagAttachedTabsMeta = document.getElementById("diagAttachedTabsMeta");
const diagDerivedTabsMeta = document.getElementById("diagDerivedTabsMeta");
const diagRowsStoredMeta = document.getElementById("diagRowsStoredMeta");
const diagRowsDiscardedMeta = document.getElementById("diagRowsDiscardedMeta");
const diagDiscardReasonsMeta = document.getElementById("diagDiscardReasonsMeta");
const diagStoredTargetFalseMeta = document.getElementById("diagStoredTargetFalseMeta");
const autoModeMeta = document.getElementById("autoModeMeta");
const autoStageMeta = document.getElementById("autoStageMeta");
const autoQueryVersionMeta = document.getElementById("autoQueryVersionMeta");
const autoIterationMeta = document.getElementById("autoIterationMeta");
const autoRunMeta = document.getElementById("autoRunMeta");
const autoCurrentQueryMeta = document.getElementById("autoCurrentQueryMeta");
const autoDialogMeta = document.getElementById("autoDialogMeta");
const autoCountMeta = document.getElementById("autoCountMeta");
const autoActionMeta = document.getElementById("autoActionMeta");
const autoErrorMeta = document.getElementById("autoErrorMeta");
const autoRetryMeta = document.getElementById("autoRetryMeta");

const manualTooManyBtn = document.getElementById("manualTooManyBtn");
const manualTooFewBtn = document.getElementById("manualTooFewBtn");
const manualProceedBtn = document.getElementById("manualProceedBtn");
const manualGateMeta = document.getElementById("manualGateMeta");
const manualNextMeta = document.getElementById("manualNextMeta");
const evalPendingMeta = document.getElementById("evalPendingMeta");
const evalRunningMeta = document.getElementById("evalRunningMeta");
const evalCompletedMeta = document.getElementById("evalCompletedMeta");
const evalFailedMeta = document.getElementById("evalFailedMeta");
const evalProgressList = document.getElementById("evalProgressList");

const metricCount = document.getElementById("metricCount");
const metricTopScore = document.getElementById("metricTopScore");
const metricCoverage = document.getElementById("metricCoverage");
const metricDecision = document.getElementById("metricDecision");
const resultEvalTotalMeta = document.getElementById("resultEvalTotalMeta");
const resultEvalPendingMeta = document.getElementById("resultEvalPendingMeta");
const resultEvalRunningMeta = document.getElementById("resultEvalRunningMeta");
const resultEvalCompletedMeta = document.getElementById("resultEvalCompletedMeta");
const resultEvalFailedMeta = document.getElementById("resultEvalFailedMeta");
const resultScoreDistHigh = document.getElementById("resultScoreDistHigh");
const resultScoreDistMid = document.getElementById("resultScoreDistMid");
const resultScoreDistLow = document.getElementById("resultScoreDistLow");
const topDocsList = document.getElementById("topDocsList");
const pairCandidatesList = document.getElementById("pairCandidatesList");
const resultDetailModal = document.getElementById("resultDetailModal");
const resultDetailBackdrop = document.getElementById("resultDetailBackdrop");
const resultDetailCloseBtn = document.getElementById("resultDetailCloseBtn");
const resultDetailTitle = document.getElementById("resultDetailTitle");
const resultDetailBody = document.getElementById("resultDetailBody");
const queryHistoryModal = document.getElementById("queryHistoryModal");
const queryHistoryBackdrop = document.getElementById("queryHistoryBackdrop");
const queryHistoryCloseBtn = document.getElementById("queryHistoryCloseBtn");
const queryHistoryTableBody = document.getElementById("queryHistoryTableBody");
const saturatedFeaturesList = document.getElementById("saturatedFeaturesList");
const gapFeaturesList = document.getElementById("gapFeaturesList");
const noisyTermsList = document.getElementById("noisyTermsList");
const nextQueryRationaleList = document.getElementById("nextQueryRationaleList");
const feedbackLogList = document.getElementById("feedbackLogList");

const PER_PROMPT_REASONING_SELECT_MAP = {
  feature_extract: perPromptReasoningFeatureExtract,
  query_seed: perPromptReasoningQuerySeed,
  query_refine: perPromptReasoningQueryRefine,
  query_duplicate_repair: perPromptReasoningQueryDuplicateRepair,
  query_plan_remap: perPromptReasoningQueryPlanRemap,
  citation_eval_json: perPromptReasoningCitationEvalJson
};

function createDefaultSettings() {
  return {
    maxIterations: DEFAULT_MAX_ITERATIONS,
    querySeedTemperature: 0,
    autoTooManyThreshold: AUTO_TOO_MANY_RESULT_THRESHOLD,
    autoDialogTimeoutMs: AUTO_DIALOG_TIMEOUT_MS,
    autoCountTimeoutMs: AUTO_COUNT_TIMEOUT_MS,
    autoClaimBatchStableMs: AUTO_CLAIM_BATCH_STABLE_MS,
    autoClaimBatchTimeoutMs: AUTO_CLAIM_BATCH_TIMEOUT_MS,
    modelControls: normalizeModelControls(null)
  };
}

function normalizeRuntimeSettings(rawSettings) {
  const merged = {
    ...createDefaultSettings(),
    ...(rawSettings && typeof rawSettings === "object" ? rawSettings : {})
  };
  merged.modelControls = normalizeModelControls(merged.modelControls);
  return merged;
}

const state = {
  sessions: [],
  activeSessionId: "",
  evalHistory: [],
  settings: createDefaultSettings(),
  busy: false,
  queryDraftText: "",
  queryDraftDirty: false,
  queryDraftVersionId: "",
  evalProgress: {
    total: 0,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    rows: {}
  },
  captureStatusPollTimer: null,
  captureEvalSyncRunning: false,
  captureEvalSyncPromise: null,
  captureEvalInFlightByRun: new Map(),
  captureAttachProbe: {
    lastTabId: null,
    lastAt: 0
  },
  captureDiagnostics: {
    attachedTabsCount: 0,
    derivedTabsAttachedCount: 0,
    rowsStoredCount: 0,
    rowsDiscardedCount: 0,
    discardReasons: {},
    lastStoredTargetMatchedFalseCount: 0
  },
  view: {
    activePane: ACTIVE_PANE_EXECUTE,
    advancedSections: {
      manualLoop: false,
      kompassControl: false,
      manualGate: false,
      modelControls: false,
      queryEditor: false,
      evalProgress: false,
      diagnostics: false,
      feedbackLog: false
    }
  },
  autoRunner: {
    active: false,
    stopRequested: false,
    status: AUTO_STATUS_IDLE,
    stage: "",
    lastAction: "",
    lastError: "",
    lastDialogKind: "",
    lastResultCount: null,
    retryCount: 0,
    startRetryCount: 0,
    loopCount: 0,
    currentRunId: "",
    currentQueryVersionId: "",
    currentExpression: "",
    preSearchResultCount: null,
    targetCountRange: TARGET_COUNT_RANGE.slice(0, 2),
    softTargetRange: SOFT_TARGET_RANGE.slice(0, 2),
    lastCountSource: "unknown",
    lastCountBucket: "unknown",
    lastReductionRatio: null,
    lastRepeatReasonSignature: "",
    lastRepeatReasonCount: 1,
    claimBatchDerivedTabIds: [],
    searchTabId: null,
    startedAt: "",
    updatedAt: "",
    stageStartedAt: 0
  },
  resultDetail: {
    open: false,
    title: "",
    body: ""
  },
  queryHistoryModal: {
    open: false
  }
};

function cloneDeep(value) {
  return JSON.parse(JSON.stringify(value));
}

function getMaxIterations() {
  const value = Number(state.settings?.maxIterations);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_ITERATIONS;
}

function getAutoSettingInt(key, fallback) {
  const value = Number(state.settings?.[key]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function getAutoTooManyThreshold() {
  return getAutoSettingInt("autoTooManyThreshold", AUTO_TOO_MANY_RESULT_THRESHOLD);
}

function getAutoDialogTimeoutMs() {
  return getAutoSettingInt("autoDialogTimeoutMs", AUTO_DIALOG_TIMEOUT_MS);
}

function getAutoCountTimeoutMs() {
  return getAutoSettingInt("autoCountTimeoutMs", AUTO_COUNT_TIMEOUT_MS);
}

function getAutoClaimBatchStableMs() {
  return getAutoSettingInt("autoClaimBatchStableMs", AUTO_CLAIM_BATCH_STABLE_MS);
}

function getAutoClaimBatchTimeoutMs() {
  return getAutoSettingInt("autoClaimBatchTimeoutMs", AUTO_CLAIM_BATCH_TIMEOUT_MS);
}

function getQuerySeedTemperature() {
  const value = Number(state.settings?.querySeedTemperature);
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 0.1) return 0.1;
  return value;
}

function getModelControls() {
  const normalized = normalizeModelControls(state.settings?.modelControls);
  state.settings.modelControls = normalized;
  return normalized;
}

async function persistSettingsState() {
  state.settings = normalizeRuntimeSettings(state.settings);
  await saveSettings(state.settings);
}

function renderReasoningSettingsControls() {
  const modelControls = getModelControls();
  const globalEffort = String(modelControls.globalReasoningEffort || "low").trim().toLowerCase();
  const perPromptEnabled = modelControls.enablePerPromptReasoningEffort === true;

  if (globalReasoningEffortSelect) {
    globalReasoningEffortSelect.value = REASONING_EFFORT_ENUM.includes(globalEffort)
      ? globalEffort
      : "low";
  }
  if (enablePerPromptReasoningEffortToggle) {
    enablePerPromptReasoningEffortToggle.checked = perPromptEnabled;
  }
  if (perPromptReasoningControls) {
    perPromptReasoningControls.classList.toggle("is-disabled", !perPromptEnabled);
  }

  REASONING_PROMPT_KEYS.forEach((promptName) => {
    const select = PER_PROMPT_REASONING_SELECT_MAP[promptName];
    if (!select) return;
    const value = String(modelControls?.perPromptReasoningEffort?.[promptName] || "low").trim().toLowerCase();
    select.value = REASONING_EFFORT_ENUM.includes(value) ? value : "low";
    select.disabled = !perPromptEnabled;
  });
}

const ADVANCED_SECTION_MAP = {
  manualLoop: advSectionManualLoop,
  kompassControl: advSectionKompassControl,
  manualGate: advSectionManualGate,
  modelControls: advSectionModelControls,
  queryEditor: advSectionQueryEditor,
  evalProgress: advSectionEvalProgress,
  diagnostics: advSectionDiagnostics,
  feedbackLog: advSectionFeedback
};

function normalizeActivePane(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === ACTIVE_PANE_RESULTS || value === ACTIVE_PANE_ADVANCED) return value;
  return ACTIVE_PANE_EXECUTE;
}

function setActivePane(nextPane) {
  state.view.activePane = normalizeActivePane(nextPane);
  renderPaneVisibility();
}

function renderPaneVisibility() {
  const activePane = normalizeActivePane(state.view?.activePane);
  if (paneExecute) paneExecute.hidden = activePane !== ACTIVE_PANE_EXECUTE;
  if (paneResults) paneResults.hidden = activePane !== ACTIVE_PANE_RESULTS;
  if (paneAdvanced) paneAdvanced.hidden = activePane !== ACTIVE_PANE_ADVANCED;

  const tabState = [
    [paneExecuteTab, ACTIVE_PANE_EXECUTE],
    [paneResultsTab, ACTIVE_PANE_RESULTS],
    [paneAdvancedTab, ACTIVE_PANE_ADVANCED]
  ];
  tabState.forEach(([button, pane]) => {
    if (!button) return;
    const selected = pane === activePane;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", selected ? "true" : "false");
  });
}

function getAdvancedSectionElement(key) {
  return ADVANCED_SECTION_MAP[key] || null;
}

function renderAdvancedSectionState() {
  const sections = state.view?.advancedSections || {};
  Object.keys(ADVANCED_SECTION_MAP).forEach((key) => {
    const element = getAdvancedSectionElement(key);
    if (!element) return;
    element.open = sections[key] === true;
  });
}

function bindAdvancedSectionStateEvents() {
  Object.keys(ADVANCED_SECTION_MAP).forEach((key) => {
    const element = getAdvancedSectionElement(key);
    if (!element || element.dataset.bound === "true") return;
    element.addEventListener("toggle", () => {
      state.view.advancedSections[key] = element.open === true;
    });
    element.dataset.bound = "true";
  });
}

function resetAutoRunnerState() {
  state.autoRunner = {
    active: false,
    stopRequested: false,
    status: AUTO_STATUS_IDLE,
    stage: "",
    lastAction: "",
    lastError: "",
    lastDialogKind: "",
    lastResultCount: null,
    retryCount: 0,
    startRetryCount: 0,
    loopCount: 0,
    currentRunId: "",
    currentQueryVersionId: "",
    currentExpression: "",
    preSearchResultCount: null,
    targetCountRange: TARGET_COUNT_RANGE.slice(0, 2),
    softTargetRange: SOFT_TARGET_RANGE.slice(0, 2),
    lastCountSource: "unknown",
    lastCountBucket: "unknown",
    lastReductionRatio: null,
    lastRepeatReasonSignature: "",
    lastRepeatReasonCount: 1,
    claimBatchDerivedTabIds: [],
    searchTabId: null,
    startedAt: "",
    updatedAt: nowIso(),
    stageStartedAt: 0
  };
}

function isAutoStopRequested() {
  return state.autoRunner.stopRequested === true;
}

function touchAutoRunner(patch = {}) {
  state.autoRunner = {
    ...(state.autoRunner || {}),
    ...(patch || {}),
    updatedAt: nowIso()
  };
}

function setAutoStatus(status, lastAction = "") {
  touchAutoRunner({
    status: String(status || AUTO_STATUS_IDLE).trim() || AUTO_STATUS_IDLE,
    ...(lastAction ? { lastAction } : {})
  });
}

function setAutoStage(stage, lastAction = "") {
  touchAutoRunner({
    stage: String(stage || "").trim(),
    stageStartedAt: Date.now(),
    ...(lastAction ? { lastAction } : {})
  });
}

function syncAutoRunnerWithSession() {
  const session = getActiveSession();
  const currentVersion = getCurrentQueryVersion(session);
  touchAutoRunner({
    currentRunId: String(session?.pendingCapture?.runId || "").trim(),
    currentQueryVersionId: String(currentVersion?.queryVersionId || "").trim(),
    currentExpression: String(currentVersion?.expression || "").trim()
  });
}

function logAutoAction(action, tone = "running") {
  const message = String(action || "").trim();
  if (!message) return;
  touchAutoRunner({ lastAction: message });
  const session = getActiveSession();
  if (session) {
    pushFeedbackLog(session, `[AUTO] ${message}`);
  }
  setLoopStatus(`자동 모드: ${message}`, tone);
}

function toLabelStatus(status) {
  const map = {
    idle: "idle",
    ready: "ready",
    capturing: "capturing",
    evaluating: "evaluating",
    success: "success",
    max_iterations: "max_iterations",
    aborted: "aborted",
    error: "error"
  };
  return map[status] || String(status || "idle");
}

function normalizeManualDecision(raw, hasPendingCapture) {
  if (!hasPendingCapture) return "";
  const value = String(raw || "").trim();
  if (
    value === MANUAL_DECISION_PENDING
    || value === MANUAL_DECISION_TOO_MANY
    || value === MANUAL_DECISION_TOO_FEW
    || value === MANUAL_DECISION_PROCEED
  ) {
    return value;
  }
  return MANUAL_DECISION_PENDING;
}

function toManualDecisionLabel(decision) {
  if (decision === MANUAL_DECISION_PENDING) return "미판정";
  if (decision === MANUAL_DECISION_TOO_MANY) return "결과 많음";
  if (decision === MANUAL_DECISION_TOO_FEW) return "결과 적음";
  if (decision === MANUAL_DECISION_PROCEED) return "적정 건수";
  return "-";
}

function toManualNextActionLabel(decision, hasPendingCapture) {
  if (!hasPendingCapture) return "먼저 사이클을 시작해 주세요.";
  if (decision === MANUAL_DECISION_PENDING) return "결과 건수를 선택해 주세요.";
  if (decision === MANUAL_DECISION_PROCEED) return "청구항 일괄조회 후 평가를 실행해 주세요.";
  if (decision === MANUAL_DECISION_TOO_MANY) return "검색식을 좁혀 다시 검색합니다.";
  if (decision === MANUAL_DECISION_TOO_FEW) return "검색식을 넓혀 다시 검색합니다.";
  return "-";
}


function sanitizeUiText(text, fallback = "") {
  const raw = String(text ?? "").trim();
  if (!raw) return String(fallback ?? "");
  const compact = raw.replace(/\s+/g, "");
  const total = compact.length || 1;
  const hangul = (compact.match(/[가-힣]/g) || []).length;
  const ascii = (compact.match(/[A-Za-z0-9.,:;()[\]{}\-_/+'"%!?&]/g) || []).length;
  const question = (compact.match(/\?/g) || []).length;
  const nonAscii = Math.max(0, total - ascii);
  const suspicious =
    question >= 2 ||
    (nonAscii > 0 && hangul === 0 && ascii / total < 0.4) ||
    (nonAscii > 0 && hangul / total < 0.2 && ascii / total < 0.2);
  return suspicious ? String(fallback ?? "") : raw;
}

function setBusy(next) {
  state.busy = !!next;
  const disabled = state.busy;
  if (buildInitialQueryBtn) buildInitialQueryBtn.disabled = disabled;
  if (startCaptureBtn) startCaptureBtn.disabled = disabled;
  if (finishCycleBtn) finishCycleBtn.disabled = disabled;
  if (abortLoopBtn) abortLoopBtn.disabled = false;
  if (abortLoopBtnAdvanced) abortLoopBtnAdvanced.disabled = false;
  if (applyQueryTextBtn) applyQueryTextBtn.disabled = disabled;
  if (clickSearchBtn) clickSearchBtn.disabled = disabled;
  if (clickInitialScreenBtn) clickInitialScreenBtn.disabled = disabled;
  if (saveManualQueryBtn) saveManualQueryBtn.disabled = disabled;
  if (rollbackQueryBtn) rollbackQueryBtn.disabled = disabled;
  if (copyQueryBtn) copyQueryBtn.disabled = disabled;
  if (manualTooManyBtnAdv) manualTooManyBtnAdv.disabled = disabled;
  if (manualTooFewBtnAdv) manualTooFewBtnAdv.disabled = disabled;
  if (manualProceedBtnAdv) manualProceedBtnAdv.disabled = disabled;
  if (execOpenDetailsBtn) execOpenDetailsBtn.disabled = false;
  if (execEditQueryBtn) execEditQueryBtn.disabled = false;
  if (execCopyQueryBtn) execCopyQueryBtn.disabled = disabled;
  if (execRollbackBtn) execRollbackBtn.disabled = disabled;
  if (openAdvancedFromInterventionBtn) openAdvancedFromInterventionBtn.disabled = false;
  if (startAutoModeBtn) {
    startAutoModeBtn.disabled = disabled || state.autoRunner.active === true;
  }
  if (stopAutoModeBtn) {
    stopAutoModeBtn.disabled = state.autoRunner.active !== true;
  }
}

function setLoopStatus(message, tone = "info") {
  if (!loopStatus) return;
  const fallbackByTone = {
    ok: "완료되었습니다.",
    warn: "확인이 필요합니다.",
    error: "실패했습니다.",
    running: "처리 중입니다...",
    info: "준비되었습니다."
  };
  loopStatus.textContent = sanitizeUiText(message, fallbackByTone[tone] || fallbackByTone.info);
  loopStatus.dataset.tone = tone;
}

function getActiveSession() {
  return state.sessions.find((session) => session.sessionId === state.activeSessionId) || null;
}

function getCurrentQueryVersion(session) {
  if (!session) return null;
  const byId = session.queryVersions?.find((version) => version.queryVersionId === session.currentQueryVersionId);
  if (byId) return byId;
  return Array.isArray(session.queryVersions) ? session.queryVersions[session.queryVersions.length - 1] : null;
}

function markQueryDraftPristine(expression, queryVersionId) {
  state.queryDraftText = String(expression || "");
  state.queryDraftDirty = false;
  state.queryDraftVersionId = String(queryVersionId || "").trim();
}

function syncQueryDraftFromCurrent(currentVersion) {
  const currentVersionId = String(currentVersion?.queryVersionId || "").trim();
  const currentExpression = String(currentVersion?.expression || "");
  if (state.queryDraftVersionId !== currentVersionId) {
    markQueryDraftPristine(currentExpression, currentVersionId);
    return;
  }
  if (!state.queryDraftDirty) {
    state.queryDraftText = currentExpression;
  }
}

function resetEvalProgress(total = 0) {
  const normalizedTotal = Number.isFinite(Number(total)) ? Math.max(0, Number(total)) : 0;
  state.evalProgress = {
    total: normalizedTotal,
    pending: normalizedTotal,
    running: 0,
    completed: 0,
    failed: 0,
    rows: {}
  };
}

function upsertEvalProgressRow(row, status) {
  if (!row || typeof row !== "object") return;
  const key = String(row.resultId || `row_${row.index ?? ""}`).trim();
  if (!key) return;
  state.evalProgress.rows[key] = {
    index: Number.isFinite(Number(row.index)) ? Number(row.index) : Number.MAX_SAFE_INTEGER,
    applicationNo: String(row.applicationNo || "").trim() || "-",
    status: String(status || row.status || "pending")
  };
}

function applyEvalProgressEvent(event) {
  const payload = event && typeof event === "object" ? event : {};
  if (payload.phase === "init") {
    resetEvalProgress(payload.total || 0);
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    rows.forEach((row) => upsertEvalProgressRow(row, "pending"));
  }

  if (Number.isFinite(Number(payload.total))) state.evalProgress.total = Math.max(0, Number(payload.total));
  if (Number.isFinite(Number(payload.pending))) state.evalProgress.pending = Math.max(0, Number(payload.pending));
  if (Number.isFinite(Number(payload.running))) state.evalProgress.running = Math.max(0, Number(payload.running));
  if (Number.isFinite(Number(payload.completed))) state.evalProgress.completed = Math.max(0, Number(payload.completed));
  if (Number.isFinite(Number(payload.failed))) state.evalProgress.failed = Math.max(0, Number(payload.failed));

  if (payload.row && typeof payload.row === "object") {
    upsertEvalProgressRow(payload.row, payload.row.status || (payload.phase === "row_start" ? "running" : "completed"));
  }
}

function getRowResultId(row, index = 0) {
  const direct = String(row?.resultId || row?.id || "").trim();
  if (direct) return direct;
  return `row_${index + 1}`;
}

function normalizeApplicationNoKey(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}

function getRowEvaluationKey(row, index = 0) {
  const applicationNo = normalizeApplicationNoKey(row?.applicationNo);
  if (applicationNo) return `app:${applicationNo}`;
  return `id:${getRowResultId(row, index)}`;
}

function ensureLiveEvalApplicationIndex(liveEval) {
  const target = liveEval && typeof liveEval === "object" ? liveEval : {};
  if (!target.evaluatedByApplicationNo || typeof target.evaluatedByApplicationNo !== "object") {
    target.evaluatedByApplicationNo = {};
  }
  if (!target.invalidByApplicationNo || typeof target.invalidByApplicationNo !== "object") {
    target.invalidByApplicationNo = {};
  }
  const evaluatedById = target.evaluatedById || {};
  const invalidById = target.invalidById || {};
  Object.values(evaluatedById).forEach((entry) => {
    const applicationNo = normalizeApplicationNoKey(entry?.applicationNo);
    if (!applicationNo) return;
    target.evaluatedByApplicationNo[applicationNo] = String(entry?.resultId || target.evaluatedByApplicationNo[applicationNo] || "");
    delete target.invalidByApplicationNo[applicationNo];
  });
  Object.values(invalidById).forEach((entry) => {
    const applicationNo = normalizeApplicationNoKey(entry?.applicationNo);
    if (!applicationNo) return;
    if (target.evaluatedByApplicationNo[applicationNo]) return;
    target.invalidByApplicationNo[applicationNo] = String(entry?.resultId || target.invalidByApplicationNo[applicationNo] || "");
  });
  return target;
}

function collectKnownEvaluationKeys(liveEval, inFlightSet = null) {
  const target = ensureLiveEvalApplicationIndex(liveEval);
  const keys = new Set();
  Object.keys(target.evaluatedById || {}).forEach((resultId) => {
    const key = String(resultId || "").trim();
    if (key) keys.add(`id:${key}`);
  });
  Object.keys(target.invalidById || {}).forEach((resultId) => {
    const key = String(resultId || "").trim();
    if (key) keys.add(`id:${key}`);
  });
  Object.keys(target.evaluatedByApplicationNo || {}).forEach((applicationNo) => {
    const key = normalizeApplicationNoKey(applicationNo);
    if (key) keys.add(`app:${key}`);
  });
  Object.keys(target.invalidByApplicationNo || {}).forEach((applicationNo) => {
    const key = normalizeApplicationNoKey(applicationNo);
    if (key) keys.add(`app:${key}`);
  });
  if (inFlightSet instanceof Set) {
    inFlightSet.forEach((keyRaw) => {
      const key = String(keyRaw || "").trim();
      if (key) keys.add(key);
    });
  }
  return keys;
}

function filterRowsForEvaluation(rows, knownKeys = new Set()) {
  const seen = new Set();
  const selectedRows = [];
  const selectedKeys = [];
  (Array.isArray(rows) ? rows : []).forEach((row, index) => {
    const key = getRowEvaluationKey(row, index);
    if (!key) return;
    if (knownKeys.has(key) || seen.has(key)) return;
    seen.add(key);
    selectedRows.push(row);
    selectedKeys.push(key);
  });
  return {
    rows: selectedRows,
    keys: selectedKeys
  };
}

function ensurePendingCaptureLiveEval(pendingCapture) {
  if (!pendingCapture || typeof pendingCapture !== "object") {
    return {
      evaluatedById: {},
      invalidById: {},
      evaluatedByApplicationNo: {},
      invalidByApplicationNo: {},
      lastFetchedCount: 0,
      lastSyncedAt: ""
    };
  }
  if (!pendingCapture.liveEval || typeof pendingCapture.liveEval !== "object") {
    pendingCapture.liveEval = {};
  }
  if (!pendingCapture.liveEval.evaluatedById || typeof pendingCapture.liveEval.evaluatedById !== "object") {
    pendingCapture.liveEval.evaluatedById = {};
  }
  if (!pendingCapture.liveEval.invalidById || typeof pendingCapture.liveEval.invalidById !== "object") {
    pendingCapture.liveEval.invalidById = {};
  }
  if (!pendingCapture.liveEval.evaluatedByApplicationNo || typeof pendingCapture.liveEval.evaluatedByApplicationNo !== "object") {
    pendingCapture.liveEval.evaluatedByApplicationNo = {};
  }
  if (!pendingCapture.liveEval.invalidByApplicationNo || typeof pendingCapture.liveEval.invalidByApplicationNo !== "object") {
    pendingCapture.liveEval.invalidByApplicationNo = {};
  }
  if (!Number.isFinite(Number(pendingCapture.liveEval.lastFetchedCount))) {
    pendingCapture.liveEval.lastFetchedCount = 0;
  }
  if (typeof pendingCapture.liveEval.lastSyncedAt !== "string") {
    pendingCapture.liveEval.lastSyncedAt = "";
  }
  return ensureLiveEvalApplicationIndex(pendingCapture.liveEval);
}

function getInFlightSetByRun(runId) {
  const key = String(runId || "").trim() || "__default__";
  if (!(state.captureEvalInFlightByRun instanceof Map)) {
    state.captureEvalInFlightByRun = new Map();
  }
  let set = state.captureEvalInFlightByRun.get(key);
  if (!set) {
    set = new Set();
    state.captureEvalInFlightByRun.set(key, set);
  }
  return set;
}

function clearInFlightByRun(runId) {
  const key = String(runId || "").trim() || "__default__";
  if (!(state.captureEvalInFlightByRun instanceof Map)) return;
  state.captureEvalInFlightByRun.delete(key);
}

function setEvalProgressFromCapture(rowsPreview, total, pendingCapture, runId) {
  const liveEval = ensurePendingCaptureLiveEval(pendingCapture);
  ensureLiveEvalApplicationIndex(liveEval);
  const evaluatedById = liveEval.evaluatedById || {};
  const invalidById = liveEval.invalidById || {};
  const evaluatedByApplicationNo = liveEval.evaluatedByApplicationNo || {};
  const invalidByApplicationNo = liveEval.invalidByApplicationNo || {};
  const inFlight = getInFlightSetByRun(runId);

  const completedCount = Object.keys(evaluatedById).length;
  const failedCount = Object.keys(invalidById).length;
  const runningCount = inFlight.size;
  const normalizedTotal = Math.max(0, Number(total || 0));

  state.evalProgress.total = normalizedTotal;
  state.evalProgress.completed = Math.min(normalizedTotal, completedCount);
  state.evalProgress.failed = Math.min(
    Math.max(0, normalizedTotal - state.evalProgress.completed),
    failedCount
  );
  state.evalProgress.running = Math.min(
    Math.max(0, normalizedTotal - state.evalProgress.completed - state.evalProgress.failed),
    runningCount
  );
  state.evalProgress.pending = Math.max(
    0,
    normalizedTotal - state.evalProgress.completed - state.evalProgress.failed - state.evalProgress.running
  );
  state.evalProgress.rows = {};

  const previewRows = Array.isArray(rowsPreview) ? rowsPreview.slice(0, 40) : [];
  previewRows.forEach((row, index) => {
    const resultId = getRowResultId(row, index);
    const applicationNo = normalizeApplicationNoKey(row?.applicationNo);
    const evalKey = getRowEvaluationKey(row, index);
    let status = "captured";
    if (inFlight.has(evalKey)) {
      status = "running";
    } else if (invalidById[resultId] || (applicationNo && invalidByApplicationNo[applicationNo])) {
      status = "failed";
    } else if (evaluatedById[resultId] || (applicationNo && evaluatedByApplicationNo[applicationNo])) {
      status = "completed";
    }
    upsertEvalProgressRow({
      index: Number.isFinite(Number(row?.index)) ? Number(row.index) : index,
      resultId,
      applicationNo: String(row?.applicationNo || "").trim() || "-",
      status
    }, status);
  });
}

async function waitCaptureEvalSync() {
  if (!state.captureEvalSyncPromise) return;
  try {
    await state.captureEvalSyncPromise;
  } catch {
    // ignore
  }
}

async function syncCapturedRowsAndEvaluateNew(session, pendingCapture, totalCount) {
  if (!session || !pendingCapture) return;
  if (state.captureEvalSyncRunning) return;

  const runId = String(pendingCapture.runId || "").trim();
  if (!runId) return;
  const liveEval = ensurePendingCaptureLiveEval(pendingCapture);
  ensureLiveEvalApplicationIndex(liveEval);
  const inFlight = getInFlightSetByRun(runId);
  const processedCount = collectKnownEvaluationKeys(liveEval, inFlight).size;
  if (Number(totalCount || 0) <= processedCount && Number(liveEval.lastFetchedCount || 0) >= Number(totalCount || 0)) {
    return;
  }

  state.captureEvalSyncRunning = true;
  state.captureEvalSyncPromise = (async () => {
    const rowsResponse = await sendRuntimeMessage({
      type: "KRESEARCH_GET_CAPTURED_ROWS",
      runId
    }, 20000);
    if (!rowsResponse?.ok) {
      throw new Error(rowsResponse?.error || "captured rows fetch failed");
    }

    const allRows = Array.isArray(rowsResponse.rows) ? rowsResponse.rows : [];
    liveEval.lastFetchedCount = allRows.length;

    const known = collectKnownEvaluationKeys(liveEval, inFlight);
    const selected = filterRowsForEvaluation(allRows, known);
    const newRows = selected.rows;
    if (newRows.length === 0) return;

    selected.keys.forEach((key) => {
      inFlight.add(key);
    });
    setEvalProgressFromCapture(allRows, allRows.length, pendingCapture, runId);
    render();

    const evalResult = await evaluateCapturedRows({
      claimText: session.claimText,
      features: session.features,
      rows: newRows,
      queryVersionId: pendingCapture.queryVersionId,
      runId,
      alreadyEvaluatedApplicationNos: [
        ...Object.keys(liveEval.evaluatedByApplicationNo || {}),
        ...Object.keys(liveEval.invalidByApplicationNo || {})
      ],
      onLog: (message) => setLoopStatus(message, "running"),
      settings: state.settings
    });
    mergeLiveEvalResult(liveEval, evalResult);
    selected.keys.forEach((key) => {
      inFlight.delete(key);
    });
    liveEval.lastSyncedAt = nowIso();
    setEvalProgressFromCapture(allRows, allRows.length, pendingCapture, runId);
    render();
    session.updatedAt = nowIso();
    upsertSession(session);
    await persistSessionState();
  })()
    .catch((error) => {
      pushFeedbackLog(session, `라이브 평가 동기화 실패: ${error?.message || String(error)}`);
    })
    .finally(() => {
      state.captureEvalSyncRunning = false;
      state.captureEvalSyncPromise = null;
    });

  await state.captureEvalSyncPromise;
}

function resetCaptureDiagnosticsState() {
  state.captureDiagnostics = {
    attachedTabsCount: 0,
    derivedTabsAttachedCount: 0,
    rowsStoredCount: 0,
    rowsDiscardedCount: 0,
    discardReasons: {},
    lastStoredTargetMatchedFalseCount: 0
  };
}

function applyCaptureDiagnosticsPayload(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const discardReasons = source.discardReasons && typeof source.discardReasons === "object"
    ? source.discardReasons
    : {};

  state.captureDiagnostics = {
    attachedTabsCount: Number.isFinite(Number(source.attachedTabsCount)) ? Math.max(0, Number(source.attachedTabsCount)) : 0,
    derivedTabsAttachedCount: Number.isFinite(Number(source.derivedTabsAttachedCount)) ? Math.max(0, Number(source.derivedTabsAttachedCount)) : 0,
    rowsStoredCount: Number.isFinite(Number(source.rowsStoredCount)) ? Math.max(0, Number(source.rowsStoredCount)) : 0,
    rowsDiscardedCount: Number.isFinite(Number(source.rowsDiscardedCount)) ? Math.max(0, Number(source.rowsDiscardedCount)) : 0,
    discardReasons,
    lastStoredTargetMatchedFalseCount: Number.isFinite(Number(source.lastStoredTargetMatchedFalseCount))
      ? Math.max(0, Number(source.lastStoredTargetMatchedFalseCount))
      : 0
  };
}

function formatDiscardReasonsSummary(discardReasons) {
  const entries = Object.entries(discardReasons && typeof discardReasons === "object" ? discardReasons : {})
    .filter(([key, value]) => !!String(key || "").trim() && Number(value) > 0)
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .slice(0, 4);
  if (!entries.length) return "-";
  return entries.map(([key, value]) => `${key}:${value}`).join(", ");
}

async function refreshCaptureStatusPreview() {
  const session = getActiveSession();
  const pendingCapture = session?.pendingCapture;
  if (!pendingCapture) {
    resetCaptureDiagnosticsState();
    return;
  }

  await ensureActiveTabAttachedForCapture(pendingCapture);

  const runId = String(pendingCapture.runId || "").trim();
  if (!runId) return;

  try {
    const response = await sendRuntimeMessage({
      type: "KRESEARCH_GET_CAPTURE_STATUS",
      runId,
      limit: 40
    }, 12000);
    if (!response?.ok) return;

    const rows = Array.isArray(response.rows) ? response.rows : [];
    const count = Number.isFinite(Number(response.count)) ? Math.max(0, Number(response.count)) : rows.length;
    setEvalProgressFromCapture(rows, count, pendingCapture, runId);

    const diagnostics = await sendRuntimeMessage({
      type: "KRESEARCH_GET_CAPTURE_DIAGNOSTICS",
      runId
    }, 12000).catch(() => null);
    if (diagnostics?.ok) {
      applyCaptureDiagnosticsPayload(diagnostics?.diagnostics);
    }

    await syncCapturedRowsAndEvaluateNew(session, pendingCapture, count);
  } catch {
    // ignore polling errors
  }
}

async function ensureActiveTabAttachedForCapture(pendingCapture) {
  if (!pendingCapture || !Number.isInteger(pendingCapture?.tabId)) return;

  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs || tabs.length === 0 || !tabs[0]?.id) {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  }

  const activeTab = tabs?.[0] || null;
  const activeTabId = Number.isInteger(activeTab?.id) ? activeTab.id : null;
  if (!Number.isInteger(activeTabId)) return;
  if (activeTabId === pendingCapture.tabId) return;

  const now = Date.now();
  if (
    state.captureAttachProbe.lastTabId === activeTabId
    && (now - Number(state.captureAttachProbe.lastAt || 0)) < 3000
  ) {
    return;
  }

  const url = String(activeTab?.url || "");
  const attachable = !url || url.startsWith("about:") || url.startsWith("http://") || url.startsWith("https://");
  if (!attachable) return;

  state.captureAttachProbe.lastTabId = activeTabId;
  state.captureAttachProbe.lastAt = now;

  // Active-tab attach probe is only a supplemental/manual reinforcement path.
  // Primary capture coverage should still come from background auto-attach logic.
  await sendRuntimeMessage({
    type: "KRESEARCH_ATTACH_TAB",
    rootTabId: pendingCapture.tabId,
    tabId: activeTabId
  }, 10000).catch(() => ({}));
}

function stopCaptureStatusPolling() {
  if (state.captureStatusPollTimer) {
    clearInterval(state.captureStatusPollTimer);
    state.captureStatusPollTimer = null;
  }
  state.captureAttachProbe.lastTabId = null;
  state.captureAttachProbe.lastAt = 0;
}

function resetLiveCaptureRuntimeState() {
  if (state.captureEvalInFlightByRun instanceof Map) {
    state.captureEvalInFlightByRun.clear();
  }
  state.captureEvalSyncRunning = false;
  state.captureEvalSyncPromise = null;
  resetCaptureDiagnosticsState();
}

function ensureCaptureStatusPolling() {
  if (state.captureStatusPollTimer) return;
  state.captureStatusPollTimer = setInterval(() => {
    void refreshCaptureStatusPreview().then(() => {
      render();
    });
  }, CAPTURE_STATUS_POLL_MS);
  void refreshCaptureStatusPreview().then(() => {
    render();
  });
}

function pushFeedbackLog(session, text) {
  if (!session) return;
  if (!Array.isArray(session.feedbackLog)) {
    session.feedbackLog = [];
  }
  session.feedbackLog.unshift({
    at: nowIso(),
    text: sanitizeUiText(text, String(text || "").trim())
  });
  if (session.feedbackLog.length > 120) {
    session.feedbackLog.length = 120;
  }
}

function upsertSession(nextSession) {
  const next = state.sessions.map((session) => (
    session.sessionId === nextSession.sessionId ? nextSession : session
  ));
  if (!next.some((session) => session.sessionId === nextSession.sessionId)) {
    next.unshift(nextSession);
  }
  state.sessions = next.slice(0, 30);
  state.activeSessionId = nextSession.sessionId;
}

async function persistSessionState() {
  await saveSessions(state.sessions, state.activeSessionId);
}

function formatScore(value) {
  if (typeof value !== "number") return "-";
  return String(Math.round(value));
}

function formatCountWithComma(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  return Math.max(0, Math.floor(numeric)).toLocaleString();
}

function renderSummaryList(container, rows, formatter, options = {}) {
  const onSelect = typeof options?.onSelect === "function" ? options.onSelect : null;
  container.innerHTML = "";
  if (!Array.isArray(rows) || rows.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No data";
    container.appendChild(li);
    return;
  }

  rows.forEach((row, index) => {
    const li = document.createElement("li");
    const text = formatter(row, index);
    if (onSelect) {
      li.classList.add("list-clickable-item");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "summary-item-btn";
      button.textContent = text;
      button.addEventListener("click", () => {
        onSelect(row, index, text);
      });
      li.appendChild(button);
    } else {
      li.textContent = text;
    }
    container.appendChild(li);
  });
}

function bindModelControlEvents() {
  if (globalReasoningEffortSelect && globalReasoningEffortSelect.dataset.bound !== "true") {
    globalReasoningEffortSelect.addEventListener("change", async () => {
      const selected = String(globalReasoningEffortSelect.value || "").trim().toLowerCase();
      const nextModelControls = normalizeModelControls({
        ...getModelControls(),
        globalReasoningEffort: selected
      });
      state.settings = normalizeRuntimeSettings({
        ...state.settings,
        modelControls: nextModelControls
      });
      await persistSettingsState();
      render();
    });
    globalReasoningEffortSelect.dataset.bound = "true";
  }

  if (enablePerPromptReasoningEffortToggle && enablePerPromptReasoningEffortToggle.dataset.bound !== "true") {
    enablePerPromptReasoningEffortToggle.addEventListener("change", async () => {
      const nextModelControls = normalizeModelControls({
        ...getModelControls(),
        enablePerPromptReasoningEffort: enablePerPromptReasoningEffortToggle.checked === true
      });
      state.settings = normalizeRuntimeSettings({
        ...state.settings,
        modelControls: nextModelControls
      });
      await persistSettingsState();
      render();
    });
    enablePerPromptReasoningEffortToggle.dataset.bound = "true";
  }

  REASONING_PROMPT_KEYS.forEach((promptName) => {
    const select = PER_PROMPT_REASONING_SELECT_MAP[promptName];
    if (!select || select.dataset.bound === "true") return;
    select.addEventListener("change", async () => {
      const nextPerPrompt = {
        ...getModelControls().perPromptReasoningEffort,
        [promptName]: String(select.value || "").trim().toLowerCase()
      };
      const nextModelControls = normalizeModelControls({
        ...getModelControls(),
        perPromptReasoningEffort: nextPerPrompt
      });
      state.settings = normalizeRuntimeSettings({
        ...state.settings,
        modelControls: nextModelControls
      });
      await persistSettingsState();
      render();
    });
    select.dataset.bound = "true";
  });
}

function toPercentText(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  return `${Math.round(numeric * 100)}%`;
}

function toTextList(value, fallback = "-") {
  const list = uniqueStrings(Array.isArray(value) ? value : []);
  return list.length ? list.join(", ") : fallback;
}

function clipDetailText(value, limit = 1500) {
  const text = String(value || "").trim();
  if (!text) return "-";
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

function getLatestIterationRecord(session) {
  const iterations = Array.isArray(session?.iterations) ? session.iterations : [];
  if (!iterations.length) return null;
  return iterations[iterations.length - 1] || null;
}

function getLatestEvalHistoryEntry(session) {
  const sessionId = String(session?.sessionId || "").trim();
  if (!sessionId) return null;
  const latestIteration = getLatestIterationRecord(session);
  const latestRunId = String(latestIteration?.runId || "").trim();
  const latestQueryVersionId = String(latestIteration?.queryVersionId || "").trim();
  const entries = Array.isArray(state.evalHistory) ? state.evalHistory : [];
  const candidates = entries.filter((entry) => {
    if (String(entry?.sessionId || "").trim() !== sessionId) return false;
    if (latestRunId && String(entry?.runId || "").trim() !== latestRunId) return false;
    if (latestQueryVersionId && String(entry?.queryVersionId || "").trim() !== latestQueryVersionId) return false;
    return true;
  });

  if (candidates.length) {
    return candidates.sort((left, right) => {
      const leftIter = Number(left?.iterationNo || 0);
      const rightIter = Number(right?.iterationNo || 0);
      if (leftIter !== rightIter) return rightIter - leftIter;
      return String(right?.createdAt || "").localeCompare(String(left?.createdAt || ""));
    })[0] || null;
  }

  const fallback = entries
    .filter((entry) => String(entry?.sessionId || "").trim() === sessionId)
    .sort((left, right) => String(right?.createdAt || "").localeCompare(String(left?.createdAt || "")));
  return fallback[0] || null;
}

function findEvaluationDetailByApplicationNo(session, applicationNoRaw) {
  const applicationNo = normalizeApplicationNoKey(applicationNoRaw);
  if (!applicationNo) return null;
  const rowsByKey = buildSessionEvaluationDetailMap(session);
  const key = `app:${applicationNo}`;
  if (rowsByKey.has(key)) {
    return rowsByKey.get(key) || null;
  }
  return Array.from(rowsByKey.values()).find((row) => normalizeApplicationNoKey(row?.applicationNo) === applicationNo) || null;
}

function buildTopDocDetailText(session, row, index = 0) {
  const detail = findEvaluationDetailByApplicationNo(session, row?.applicationNo);
  const lines = [
    `문헌 순위: ${index + 1}`,
    `출원번호: ${String(row?.applicationNo || "-")}`,
    `점수: ${formatScore(row?.score)}`,
    `히트 구성: ${toTextList(row?.featureHits)}`,
    `누락 구성: ${toTextList(detail?.missingFeatures)}`,
    `판정 요약: ${String(row?.featureJudgmentSummary || "-").trim() || "-"}`,
    `이유: ${String(row?.reason || "-").trim() || "-"}`,
    "",
    "[세부 판단]"
  ];

  const judgments = Array.isArray(detail?.featureJudgments) ? detail.featureJudgments : [];
  if (judgments.length) {
    judgments.forEach((judgment) => {
      const featureId = String(judgment?.featureId || "-");
      const status = String(judgment?.status || "-");
      const confidence = Number(judgment?.confidence);
      const confidenceText = Number.isFinite(confidence) ? confidence.toFixed(2) : "-";
      const evidenceSource = String(judgment?.evidenceSource || "-");
      const evidenceText = clipDetailText(judgment?.evidenceText, 220);
      lines.push(`- ${featureId}: ${status} (confidence ${confidenceText}) / source=${evidenceSource} / evidence=${evidenceText}`);
    });
  } else {
    lines.push("- 세부 feature judgment 데이터 없음");
  }

  lines.push("");
  lines.push("[보조 지표]");
  lines.push(`- field similarity: ${toPercentText(detail?.fieldSimilarity)}`);
  lines.push(`- pair fill value: ${toPercentText(detail?.pairFillValue)}`);
  lines.push(`- conflict flags: ${toTextList(detail?.conflictFlags)}`);
  lines.push(`- noisy terms: ${toTextList(detail?.noisyTerms)}`);
  lines.push("");
  lines.push("[원문 요약]");
  lines.push(`- citation: ${clipDetailText(detail?.rawCitationText, 900)}`);
  lines.push(`- dwpi: ${clipDetailText(detail?.rawDwpiText, 700)}`);
  return lines.join("\n");
}

function buildPairCandidateDetailText(session, row, index = 0) {
  const leftDetail = findEvaluationDetailByApplicationNo(session, row?.leftApplicationNo);
  const rightDetail = findEvaluationDetailByApplicationNo(session, row?.rightApplicationNo);
  const lines = [
    `조합 순위: ${index + 1}`,
    `문헌 조합: ${String(row?.leftApplicationNo || "-")} + ${String(row?.rightApplicationNo || "-")}`,
    `커버리지: ${toPercentText(row?.coverage)}`,
    `최소 점수: ${formatScore(row?.minScore)}`,
    `결합 개연성: ${toPercentText(row?.combinePlausibility)}`,
    `보완성: ${toPercentText(row?.complementarity)}`,
    `기술분야 근접도: ${toPercentText(row?.fieldProximity)}`,
    `충돌 수준: ${row?.lowConflict ? "낮음" : "높음"}`,
    `남은 누락 구성: ${toTextList(row?.remainingGaps)}`,
    `충돌 플래그: ${toTextList(row?.conflictFlags)}`,
    `조합 이유: ${String(row?.pairRationale || "-").trim() || "-"}`,
    "",
    "[좌측 문헌 요약]",
    `- 출원번호: ${String(row?.leftApplicationNo || "-")}`,
    `- 점수: ${formatScore(leftDetail?.score)}`,
    `- 히트 구성: ${toTextList(leftDetail?.featureHits)}`,
    `- 누락 구성: ${toTextList(leftDetail?.missingFeatures)}`,
    "",
    "[우측 문헌 요약]",
    `- 출원번호: ${String(row?.rightApplicationNo || "-")}`,
    `- 점수: ${formatScore(rightDetail?.score)}`,
    `- 히트 구성: ${toTextList(rightDetail?.featureHits)}`,
    `- 누락 구성: ${toTextList(rightDetail?.missingFeatures)}`
  ];
  return lines.join("\n");
}

function openResultDetailModal(title, body) {
  closeQueryHistoryModal();
  state.resultDetail = {
    open: true,
    title: sanitizeUiText(title, "상세 정보"),
    body: String(body || "-").trim() || "-"
  };
  renderResultDetailModal();
}

function closeResultDetailModal() {
  if (!state.resultDetail?.open) return;
  state.resultDetail = {
    open: false,
    title: "",
    body: ""
  };
  renderResultDetailModal();
}

function renderResultDetailModal() {
  if (!resultDetailModal || !resultDetailTitle || !resultDetailBody) return;
  const open = state.resultDetail?.open === true;
  resultDetailModal.classList.toggle("hidden", !open);
  if (!open) return;
  resultDetailTitle.textContent = String(state.resultDetail?.title || "상세 정보");
  resultDetailBody.textContent = String(state.resultDetail?.body || "-");
}

function getSessionEvalHistoryEntries(session) {
  const sessionId = String(session?.sessionId || "").trim();
  if (!sessionId) return [];
  return (Array.isArray(state.evalHistory) ? state.evalHistory : [])
    .filter((entry) => String(entry?.sessionId || "").trim() === sessionId)
    .sort((left, right) => {
      const leftIter = Number(left?.iterationNo || 0);
      const rightIter = Number(right?.iterationNo || 0);
      if (leftIter !== rightIter) return leftIter - rightIter;
      return String(left?.createdAt || "").localeCompare(String(right?.createdAt || ""));
    });
}

function buildSessionEvaluationDetailMap(session) {
  const rowsByKey = new Map();
  getSessionEvalHistoryEntries(session).forEach((entry) => {
    const evaluations = Array.isArray(entry?.evaluations) ? entry.evaluations : [];
    evaluations.forEach((row, index) => {
      const appKey = normalizeApplicationNoKey(row?.applicationNo);
      const resultId = String(row?.resultId || "").trim();
      const fallbackKey = resultId || `${String(entry?.runId || "-")}::${index + 1}`;
      const key = appKey ? `app:${appKey}` : `id:${fallbackKey}`;
      rowsByKey.set(key, row);
    });
  });

  const pendingCapture = session?.pendingCapture && typeof session.pendingCapture === "object"
    ? session.pendingCapture
    : null;
  if (pendingCapture) {
    const liveEval = ensurePendingCaptureLiveEval(pendingCapture);
    Object.values(liveEval?.evaluatedById || {}).forEach((row, index) => {
      const appKey = normalizeApplicationNoKey(row?.applicationNo);
      const resultId = String(row?.resultId || "").trim();
      const fallbackKey = resultId || `${String(pendingCapture?.runId || "-")}::live::${index + 1}`;
      const key = appKey ? `app:${appKey}` : `id:${fallbackKey}`;
      rowsByKey.set(key, row);
    });
  }
  return rowsByKey;
}

function collectSessionEvaluationsSnapshot(session) {
  return Array.from(buildSessionEvaluationDetailMap(session).values());
}

function buildSessionCumulativeSummary(session, currentVersion) {
  if (!session) return null;
  const evaluations = collectSessionEvaluationsSnapshot(session);
  if (!evaluations.length) return session?.lastSummary || null;
  try {
    return summarizeIteration({
      evaluations,
      features: Array.isArray(session?.features) ? session.features : [],
      featureStateById: currentVersion?.featureStateById || {}
    });
  } catch (error) {
    console.warn("[K-Research] cumulative summary fallback", error?.message || String(error));
    return session?.lastSummary || null;
  }
}

function summarizeSessionEvaluationOverview(session) {
  const completedRows = [];
  const failedRows = [];

  // Keep result-tab stats session-cumulative by evaluation events,
  // not by unique applicationNo. This prevents apparent resets after queryVersion changes.
  getSessionEvalHistoryEntries(session).forEach((entry) => {
    const evaluations = Array.isArray(entry?.evaluations) ? entry.evaluations : [];
    const invalidOutputs = Array.isArray(entry?.invalidOutputs) ? entry.invalidOutputs : [];
    evaluations.forEach((row) => completedRows.push(row));
    invalidOutputs.forEach((row) => failedRows.push(row));
  });

  const pendingCapture = session?.pendingCapture && typeof session.pendingCapture === "object"
    ? session.pendingCapture
    : null;
  if (pendingCapture) {
    const liveEval = ensurePendingCaptureLiveEval(pendingCapture);
    Object.values(liveEval?.evaluatedById || {}).forEach((row) => completedRows.push(row));
    Object.values(liveEval?.invalidById || {}).forEach((row) => failedRows.push(row));
  }

  const distribution = {
    high: 0,
    mid: 0,
    low: 0
  };
  completedRows.forEach((row) => {
    const score = Number(row?.score);
    if (!Number.isFinite(score)) return;
    if (score >= 60) distribution.high += 1;
    else if (score >= 40) distribution.mid += 1;
    else distribution.low += 1;
  });

  const runningNow = Math.max(0, Number(state.evalProgress?.running || 0));
  const pendingNow = Math.max(0, Number(state.evalProgress?.pending || 0));
  const completedCount = completedRows.length;
  const failedCount = failedRows.length;
  const totalCount = completedCount + failedCount + runningNow + pendingNow;

  return {
    total: totalCount,
    pending: pendingNow,
    running: runningNow,
    completed: completedCount,
    failed: failedCount,
    distribution
  };
}

function renderResultsProgressAndDistribution(session) {
  if (!resultEvalTotalMeta || !resultEvalPendingMeta || !resultEvalRunningMeta || !resultEvalCompletedMeta || !resultEvalFailedMeta) {
    return;
  }
  const overview = summarizeSessionEvaluationOverview(session);

  resultEvalTotalMeta.textContent = String(overview.total || 0);
  resultEvalPendingMeta.textContent = String(overview.pending || 0);
  resultEvalRunningMeta.textContent = String(overview.running || 0);
  resultEvalCompletedMeta.textContent = String(overview.completed || 0);
  resultEvalFailedMeta.textContent = String(overview.failed || 0);

  if (resultScoreDistHigh) resultScoreDistHigh.textContent = String(overview.distribution.high || 0);
  if (resultScoreDistMid) resultScoreDistMid.textContent = String(overview.distribution.mid || 0);
  if (resultScoreDistLow) resultScoreDistLow.textContent = String(overview.distribution.low || 0);
}

function buildQueryHistoryRows(session) {
  const versions = Array.isArray(session?.queryVersions) ? session.queryVersions : [];
  const iterations = Array.isArray(session?.iterations) ? session.iterations : [];
  const toFiniteNumber = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === "string" && value.trim() === "") return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
  };
  const pickFiniteNumber = (...candidates) => {
    for (const candidate of candidates) {
      const parsed = toFiniteNumber(candidate);
      if (parsed !== null) return parsed;
    }
    return null;
  };
  const formatHistoryTimestamp = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return "-";
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return raw;
    return parsed.toLocaleString();
  };
  const iterByVersionId = new Map();
  const versionById = new Map();
  versions.forEach((version) => {
    const queryVersionId = String(version?.queryVersionId || "").trim();
    if (!queryVersionId) return;
    versionById.set(queryVersionId, version);
  });
  iterations.forEach((iteration) => {
    const queryVersionId = String(iteration?.queryVersionId || "").trim();
    if (!queryVersionId) return;
    const previous = iterByVersionId.get(queryVersionId);
    if (!previous || Number(iteration?.iterationNo || 0) >= Number(previous?.iterationNo || 0)) {
      iterByVersionId.set(queryVersionId, iteration);
    }
  });

  const sortedIterations = [...iterations].sort((left, right) => {
    const leftNo = Number(left?.iterationNo || 0);
    const rightNo = Number(right?.iterationNo || 0);
    if (leftNo !== rightNo) return rightNo - leftNo;
    return String(right?.createdAt || "").localeCompare(String(left?.createdAt || ""));
  });

  const rows = sortedIterations.map((iteration) => {
    const queryVersionId = String(iteration?.queryVersionId || "").trim();
    const version = versionById.get(queryVersionId) || null;
    const searchResultCountRaw = pickFiniteNumber(
      iteration?.currentResultCount,
      iteration?.current_result_count,
      version?.currentResultCount,
      version?.current_result_count,
      iteration?.resultCount,
      iteration?.result_count,
      version?.resultCount,
      version?.result_count
    );
    const evaluatedCountRaw = pickFiniteNumber(
      iteration?.resultCount,
      iteration?.result_count,
      version?.resultCount,
      version?.result_count
    );
    const topScoreRaw = pickFiniteNumber(
      iteration?.topScore,
      iteration?.top_score,
      version?.topScore,
      version?.top_score
    );
    const topScoreText = Number.isFinite(topScoreRaw) ? formatScore(topScoreRaw) : "-";
    const evaluatedCountText = formatCountWithComma(evaluatedCountRaw);
    return {
      expression: String(version?.expression || iteration?.queryExpression || "").trim() || "-",
      resultCount: formatCountWithComma(searchResultCountRaw),
      topScore: evaluatedCountText !== "-"
        ? `${topScoreText} (${evaluatedCountText})`
        : topScoreText,
      searchedAt: formatHistoryTimestamp(
        iteration?.createdAt
        || iteration?.updatedAt
        || version?.updatedAt
        || version?.createdAt
      )
    };
  });

  const unsearchedRows = [...versions].reverse().filter((version) => {
    const queryVersionId = String(version?.queryVersionId || "").trim();
    if (!queryVersionId) return false;
    return !iterByVersionId.has(queryVersionId);
  }).map((version) => ({
      expression: String(version?.expression || "").trim() || "-",
      resultCount: "-",
      topScore: "-",
      searchedAt: formatHistoryTimestamp(version?.updatedAt || version?.createdAt)
    }));

  return [...rows, ...unsearchedRows];
}

function renderQueryHistoryModalTable(session) {
  if (!queryHistoryTableBody) return;
  queryHistoryTableBody.innerHTML = "";
  const rows = buildQueryHistoryRows(session);
  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.textContent = "데이터가 없습니다.";
    tr.appendChild(td);
    queryHistoryTableBody.appendChild(tr);
    return;
  }

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    const expressionTd = document.createElement("td");
    expressionTd.textContent = row.expression;
    const resultCountTd = document.createElement("td");
    resultCountTd.textContent = row.resultCount;
    const topScoreTd = document.createElement("td");
    topScoreTd.textContent = row.topScore;
    const searchedAtTd = document.createElement("td");
    searchedAtTd.textContent = row.searchedAt;
    tr.appendChild(expressionTd);
    tr.appendChild(resultCountTd);
    tr.appendChild(topScoreTd);
    tr.appendChild(searchedAtTd);
    queryHistoryTableBody.appendChild(tr);
  });
}

function openQueryHistoryModal() {
  const session = getActiveSession();
  if (!session) {
    setLoopStatus("먼저 초기 검색식을 생성해 주세요.", "warn");
    return;
  }
  closeResultDetailModal();
  renderQueryHistoryModalTable(session);
  state.queryHistoryModal.open = true;
  renderQueryHistoryModal();
}

function closeQueryHistoryModal() {
  if (!state.queryHistoryModal?.open) return;
  state.queryHistoryModal.open = false;
  renderQueryHistoryModal();
}

function renderQueryHistoryModal() {
  if (!queryHistoryModal) return;
  const open = state.queryHistoryModal?.open === true;
  queryHistoryModal.classList.toggle("hidden", !open);
}

function normalizeFeatureId(value) {
  return String(value || "").trim().toUpperCase();
}

function uniqueStrings(items) {
  const out = [];
  const seen = new Set();
  (Array.isArray(items) ? items : []).forEach((item) => {
    const value = String(item || "").trim();
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(value);
  });
  return out;
}

function computeQueryVersionFingerprints(versionLike) {
  const queryPlan = versionLike?.queryPlan || { groups: [] };
  const termsByFeature = versionLike?.termsByFeature || {};
  const featureStateById = versionLike?.featureStateById || {};
  const fingerprint = buildQueryFingerprint({
    queryPlan,
    termsByFeature,
    featureStateById
  });
  const semanticFingerprint = buildSemanticQueryFingerprint({
    queryPlan,
    termsByFeature,
    featureStateById
  });
  const activeTermsFingerprint = buildActiveTermsFingerprint({
    queryPlan,
    termsByFeature,
    featureStateById
  });
  const activeTerms = collectActiveCanonicalTerms({
    queryPlan,
    termsByFeature,
    featureStateById
  });
  return {
    fingerprint,
    semanticFingerprint,
    activeTermsFingerprint,
    activeTerms
  };
}

function ensureVersionFingerprintMetadata(version) {
  if (!version || typeof version !== "object") return version;
  const fingerprints = computeQueryVersionFingerprints(version);
  return {
    ...version,
    fingerprint: String(version?.fingerprint || fingerprints.fingerprint || "").trim(),
    semanticFingerprint: String(version?.semanticFingerprint || fingerprints.semanticFingerprint || "").trim(),
    activeTermsFingerprint: String(version?.activeTermsFingerprint || fingerprints.activeTermsFingerprint || "").trim(),
    activeTerms: Array.isArray(version?.activeTerms) && version.activeTerms.length
      ? uniqueStrings(version.activeTerms)
      : uniqueStrings(fingerprints.activeTerms || []),
    duplicateOfQueryVersionId: String(version?.duplicateOfQueryVersionId || "").trim() || null,
    duplicateBlocked: version?.duplicateBlocked === true
  };
}

function findDuplicateVersionInSession(session, candidateVersion, excludeQueryVersionId = "") {
  const candidate = ensureVersionFingerprintMetadata(candidateVersion);
  const targetFingerprint = String(candidate?.fingerprint || "").trim();
  const targetSemantic = String(candidate?.semanticFingerprint || "").trim();
  const targetActive = String(candidate?.activeTermsFingerprint || "").trim();
  if (!targetFingerprint && !targetSemantic && !targetActive) return null;
  const excludeId = String(excludeQueryVersionId || "").trim();

  const versions = Array.isArray(session?.queryVersions) ? session.queryVersions : [];
  for (const entry of versions) {
    const queryVersionId = String(entry?.queryVersionId || "").trim();
    if (excludeId && queryVersionId === excludeId) continue;
    const normalized = ensureVersionFingerprintMetadata(entry);
    if (targetFingerprint && normalized.fingerprint && normalized.fingerprint === targetFingerprint) {
      return { duplicateOfQueryVersionId: queryVersionId, reason: "exact fingerprint match" };
    }
    if (targetSemantic && normalized.semanticFingerprint && normalized.semanticFingerprint === targetSemantic) {
      return { duplicateOfQueryVersionId: queryVersionId, reason: "semantic fingerprint match" };
    }
    if (targetActive && normalized.activeTermsFingerprint && normalized.activeTermsFingerprint === targetActive) {
      return { duplicateOfQueryVersionId: queryVersionId, reason: "active term multiset match" };
    }
  }
  return null;
}

function hasIterationHistoryForQueryVersion(session, queryVersionId) {
  const target = String(queryVersionId || "").trim();
  if (!target) return false;
  const iterations = Array.isArray(session?.iterations) ? session.iterations : [];
  return iterations.some((row) => String(row?.queryVersionId || "").trim() === target);
}

function detectAutoDuplicatePreflight(session, currentVersion) {
  const currentQueryVersionId = String(currentVersion?.queryVersionId || "").trim();
  if (!currentQueryVersionId) return null;

  if (hasIterationHistoryForQueryVersion(session, currentQueryVersionId)) {
    return {
      reason: "preflight_query_version_reused",
      duplicateOfQueryVersionId: currentQueryVersionId,
      matchType: "query_version_reuse"
    };
  }

  const duplicateInfo = findDuplicateVersionInSession(session, currentVersion, currentQueryVersionId);
  if (duplicateInfo) {
    return {
      reason: `preflight_${String(duplicateInfo.reason || "duplicate").trim().replace(/\s+/g, "_")}`,
      duplicateOfQueryVersionId: String(duplicateInfo?.duplicateOfQueryVersionId || "").trim(),
      matchType: String(duplicateInfo?.reason || "").includes("semantic")
        ? "semantic_fingerprint"
        : (String(duplicateInfo?.reason || "").includes("active term") ? "active_terms" : "fingerprint")
    };
  }
  return null;
}

async function runAutoDuplicateRepairRoute({
  session,
  currentVersion,
  trigger = null
} = {}) {
  if (!session || !currentVersion) {
    return { applied: false, reason: "missing_session_or_version", feedbackActions: [] };
  }
  const triggerInfo = trigger && typeof trigger === "object" ? trigger : {};
  const triggerReason = String(triggerInfo?.reason || "duplicate_repair").trim();

  pushFeedbackLog(session, `[AUTO] duplicate repair trigger: ${triggerReason}`);

  const baseArgs = {
    claimText: session.claimText,
    features: session.features,
    currentVersion,
    queryVersions: session.queryVersions,
    iterations: session.iterations,
    trigger: triggerInfo,
    onLog: (message) => setLoopStatus(message, "running"),
    settings: state.settings
  };

  let repaired = null;
  try {
    repaired = await autoRepairDuplicateQuery(baseArgs);
  } catch (error) {
    pushFeedbackLog(session, `[AUTO] duplicate repair LLM failed: ${error?.message || String(error)}`);
  }

  if (!repaired?.queryVersionId) {
    pushFeedbackLog(
      session,
      `[AUTO] duplicate repair LLM skipped (${repaired?.failureReason || "no_change"}), deterministic retry`
    );
    try {
      repaired = await autoRepairDuplicateQuery({
        ...baseArgs,
        skipLlm: true
      });
    } catch (error) {
      pushFeedbackLog(session, `[AUTO] duplicate repair deterministic failed: ${error?.message || String(error)}`);
      repaired = null;
    }
  }

  if (!repaired?.queryVersionId) {
    const failureReason = String(repaired?.failureReason || "repair_exhausted");
    pushFeedbackLog(session, `[AUTO] duplicate repair exhausted: keep current query (${failureReason})`);
    return {
      applied: false,
      reason: failureReason,
      feedbackActions: Array.isArray(repaired?.feedbackActions) ? repaired.feedbackActions : []
    };
  }

  const normalizedRepaired = applyCrossGroupDedupeToVersion(repaired, session.features);
  session.queryVersions = [...(session.queryVersions || []), normalizedRepaired];
  session.currentQueryVersionId = normalizedRepaired.queryVersionId;
  markQueryDraftPristine(normalizedRepaired.expression, normalizedRepaired.queryVersionId);
  pushFeedbackLog(
    session,
    `[AUTO] duplicate repair applied -> ${normalizedRepaired.queryVersionId} (${normalizedRepaired.source || "duplicate_repair"})`
  );
  pushPlannerMetaLog(session, normalizedRepaired, normalizedRepaired.refineMode || "balanced");
  pushFeatureReasonLogs(session, normalizedRepaired, "Duplicate repair adjustments");
  return {
    applied: true,
    version: normalizedRepaired,
    feedbackActions: normalizedRepaired.feedbackActions || []
  };
}

function updatePaneLayoutMetrics() {
  const headerHeight = Number(shellHeader?.offsetHeight || 0);
  const tabsHeight = Number(primaryModeTabs?.offsetHeight || 0);
  const statusDockHeight = Number(loopStatusDock?.offsetHeight || 0);
  const footerHeight = Number(appFooter?.offsetHeight || 0);
  const viewportHeight = Number(window?.innerHeight || 0);
  const paddingAllowance = 22;
  const computedMin = Math.max(
    300,
    viewportHeight - headerHeight - tabsHeight - statusDockHeight - footerHeight - paddingAllowance
  );

  document.documentElement.style.setProperty("--kr-shell-header-height", `${Math.max(0, headerHeight)}px`);
  document.documentElement.style.setProperty("--kr-pane-min-height", `${computedMin}px`);
}

function buildStoredTermCapPolicyForVersion(version, features) {
  const byFeature = {};
  const setCap = (featureIdRaw, candidateLimit) => {
    const featureId = normalizeFeatureId(featureIdRaw);
    if (!featureId) return;
    const limit = Math.max(1, Math.min(2, Number(candidateLimit) || 1));
    byFeature[featureId] = Math.max(Number(byFeature[featureId] || 1), limit);
  };

  (Array.isArray(version?.queryPlan?.groups) ? version.queryPlan.groups : []).forEach((group) => {
    const featureIds = Array.isArray(group?.feature_ids || group?.featureIds)
      ? (group.feature_ids || group.featureIds)
      : [];
    const termCount = uniqueStrings(group?.terms || []).length;
    if (!termCount) return;
    featureIds.forEach((featureId) => setCap(featureId, termCount));
  });
  Object.entries(version?.termsByFeature || {}).forEach(([featureId, terms]) => {
    const termCount = uniqueStrings(terms).length;
    if (termCount >= 2) {
      setCap(featureId, 2);
    }
  });
  (Array.isArray(features) ? features : []).forEach((feature) => {
    const featureId = normalizeFeatureId(feature?.id);
    if (!featureId || byFeature[featureId]) return;
    byFeature[featureId] = 1;
  });

  return {
    maxTermsPerFeature: 1,
    maxTermsPerFeatureByFeatureId: byFeature,
    allowTwoTermsFeatureIds: Object.entries(byFeature)
      .filter(([, limit]) => Number(limit) >= 2)
      .map(([featureId]) => featureId)
  };
}

function applyCrossGroupDedupeToVersion(version, features) {
  const source = version && typeof version === "object" ? cloneDeep(version) : {};
  const storedTermPolicy = buildStoredTermCapPolicyForVersion(source, features);
  const deduped = dedupeTermsAcrossActiveGroups({
    queryPlan: source.queryPlan || { groups: [] },
    termsByFeature: source.termsByFeature || {},
    featureStateById: source.featureStateById || {}
  });
  const dedupedPlan = normalizeQueryPlan({
    queryPlan: deduped?.queryPlan || source.queryPlan || null,
    features: Array.isArray(features) ? features : [],
    termsByFeature: source.termsByFeature || {},
    featureStateById: source.featureStateById || {},
    ...storedTermPolicy
  });
  const expression = buildExpression({
    queryPlan: dedupedPlan,
    features: Array.isArray(features) ? features : [],
    termsByFeature: source.termsByFeature || {},
    featureStateById: source.featureStateById || {},
    ...storedTermPolicy
  });

  const feedbackBasis = source.feedbackBasis && typeof source.feedbackBasis === "object"
    ? cloneDeep(source.feedbackBasis)
    : {};
  feedbackBasis.crossGroupDedupe = {
    duplicate_terms_removed: uniqueStrings(deduped?.debugMeta?.duplicate_terms_removed || []),
    term_owner_by_group: deduped?.debugMeta?.term_owner_by_group || {},
    emptied_groups: uniqueStrings(deduped?.debugMeta?.emptied_groups || []),
    rebuild_required_due_to_cross_group_dedupe:
      deduped?.debugMeta?.rebuild_required_due_to_cross_group_dedupe === true
  };

  return ensureVersionFingerprintMetadata({
    ...source,
    queryPlan: dedupedPlan,
    expression: String(expression || "").trim(),
    feedbackBasis
  });
}

function renderPlainList(container, items, emptyText = "-") {
  if (!container) return;
  const values = uniqueStrings(items);
  container.innerHTML = "";
  if (!values.length) {
    const li = document.createElement("li");
    li.textContent = emptyText;
    container.appendChild(li);
    return;
  }

  values.slice(0, 30).forEach((entry) => {
    const li = document.createElement("li");
    li.textContent = entry;
    container.appendChild(li);
  });
}

function buildFeatureTextMap(session) {
  const featureMap = new Map();
  (Array.isArray(session?.features) ? session.features : []).forEach((feature) => {
    const featureId = normalizeFeatureId(feature?.id);
    const text = String(feature?.text || "").trim();
    if (!featureId) return;
    featureMap.set(featureId, text);
  });
  return featureMap;
}

function formatFeatureLabel(featureId, featureMap) {
  const id = normalizeFeatureId(featureId);
  if (!id) return "";
  const text = String(featureMap.get(id) || "").trim();
  if (!text) return id;
  const clipped = text.length > 80 ? `${text.slice(0, 77)}...` : text;
  return `${id}: ${clipped}`;
}

function resolveLatestReasonContext(session, currentVersion) {
  const versions = Array.isArray(session?.queryVersions) ? session.queryVersions : [];
  if (currentVersion?.feedbackBasis && typeof currentVersion.feedbackBasis === "object") {
    return currentVersion;
  }
  for (let i = versions.length - 1; i >= 0; i -= 1) {
    const candidate = versions[i];
    if (candidate?.feedbackBasis && typeof candidate.feedbackBasis === "object") {
      return candidate;
    }
  }
  return currentVersion || null;
}

function buildNoisyTermLines(noisyTermsByFeature, featureMap) {
  const source = (noisyTermsByFeature && typeof noisyTermsByFeature === "object")
    ? noisyTermsByFeature
    : {};
  const lines = [];
  Object.entries(source).forEach(([featureIdRaw, terms]) => {
    const featureId = normalizeFeatureId(featureIdRaw);
    const termList = uniqueStrings(terms).slice(0, 6);
    if (!termList.length) return;
    const label = featureId === "__UNSCOPED__"
      ? "UNSCOPED"
      : formatFeatureLabel(featureId, featureMap);
    lines.push(`${label} -> ${termList.join(", ")}`);
  });
  return lines;
}

function buildNextQueryRationaleLines(contextVersion, summary, featureMap) {
  const lines = [];
  const basis = contextVersion?.feedbackBasis && typeof contextVersion.feedbackBasis === "object"
    ? contextVersion.feedbackBasis
    : {};

  const plannerDecision = String(
    basis.plannerDecision || basis.decision || contextVersion?.refineMode || ""
  ).trim();
  if (plannerDecision) {
    lines.push(`decision: ${plannerDecision}`);
  }

  const rationale = String(basis.nextQueryRationale || contextVersion?.notes || "").trim();
  if (rationale) {
    lines.push(`rationale: ${rationale}`);
  }

  const saturated = uniqueStrings(basis.saturatedFeatureIds || []);
  if (saturated.length) {
    lines.push(`saturated focus: ${saturated.map((id) => formatFeatureLabel(id, featureMap)).join(" | ")}`);
  }
  const gaps = uniqueStrings(basis.gapFeatureIds || []);
  if (gaps.length) {
    lines.push(`gap focus: ${gaps.map((id) => formatFeatureLabel(id, featureMap)).join(" | ")}`);
  }

  const actions = uniqueStrings(contextVersion?.feedbackActions || []).slice(0, 5);
  actions.forEach((entry) => {
    lines.push(`action: ${entry}`);
  });

  if (summary?.pairDecision?.combinePlausibility !== undefined && summary?.pairDecision !== null) {
    lines.push(
      `pair check: plausibility ${Math.round((Number(summary.pairDecision.combinePlausibility) || 0) * 100)}%, lowConflict=${summary.pairDecision.lowConflict ? "yes" : "no"}, gaps=${Array.isArray(summary.pairDecision.remainingGaps) ? summary.pairDecision.remainingGaps.length : 0}`
    );
  }

  return lines;
}

function renderDecisionRationale(session, currentVersion, summary) {
  const featureMap = buildFeatureTextMap(session);
  const contextVersion = resolveLatestReasonContext(session, currentVersion);
  const basis = contextVersion?.feedbackBasis && typeof contextVersion.feedbackBasis === "object"
    ? contextVersion.feedbackBasis
    : {};

  const saturatedLines = uniqueStrings(basis.saturatedFeatureIds || [])
    .map((featureId) => formatFeatureLabel(featureId, featureMap))
    .filter(Boolean);
  const gapLines = uniqueStrings(basis.gapFeatureIds || [])
    .map((featureId) => formatFeatureLabel(featureId, featureMap))
    .filter(Boolean);
  const noisyLines = buildNoisyTermLines(basis.noisyTermsByFeature, featureMap);
  const rationaleLines = buildNextQueryRationaleLines(contextVersion, summary, featureMap);

  renderPlainList(saturatedFeaturesList, saturatedLines, "No saturated features yet.");
  renderPlainList(gapFeaturesList, gapLines, "No gap features identified.");
  renderPlainList(noisyTermsList, noisyLines, "No noisy terms flagged.");
  renderPlainList(nextQueryRationaleList, rationaleLines, "No next-query rationale yet.");
}

function extractFeatureReasonEntries(refinedVersion, session) {
  const featureMap = buildFeatureTextMap(session);
  const out = [];
  const feedbackActions = uniqueStrings(refinedVersion?.feedbackActions || []);
  feedbackActions.forEach((entry) => {
    const text = String(entry || "").trim();
    if (!text) return;
    const match = text.match(/^\[([A-Za-z0-9_:-]+)\]\s*(.+)$/);
    if (match) {
      const featureLabel = formatFeatureLabel(match[1], featureMap);
      out.push(`${featureLabel} -> ${match[2]}`);
      return;
    }
    if (/feature|gap|saturated|noise|planner|core_guard|manual_gate/i.test(text)) {
      out.push(text);
    }
  });

  const basis = refinedVersion?.feedbackBasis && typeof refinedVersion.feedbackBasis === "object"
    ? refinedVersion.feedbackBasis
    : {};
  const saturated = uniqueStrings(basis.saturatedFeatureIds || []);
  if (saturated.length) {
    out.push(`Saturated: ${saturated.map((id) => formatFeatureLabel(id, featureMap)).join(" | ")}`);
  }
  const gaps = uniqueStrings(basis.gapFeatureIds || []);
  if (gaps.length) {
    out.push(`Gap: ${gaps.map((id) => formatFeatureLabel(id, featureMap)).join(" | ")}`);
  }
  const noisyLines = buildNoisyTermLines(basis.noisyTermsByFeature, featureMap);
  noisyLines.forEach((line) => out.push(`Noisy: ${line}`));

  return uniqueStrings(out).slice(0, 16);
}

function pushFeatureReasonLogs(session, refinedVersion, title = "Feature rationale") {
  const lines = extractFeatureReasonEntries(refinedVersion, session);
  if (!lines.length) return;
  pushFeedbackLog(session, `${title}:`);
  lines.forEach((line) => {
    pushFeedbackLog(session, `  - ${line}`);
  });
}

function renderFeedbackLogs(session) {
  feedbackLogList.innerHTML = "";
  const logs = Array.isArray(session?.feedbackLog) ? session.feedbackLog : [];
  if (!logs.length) {
    const li = document.createElement("li");
    li.textContent = "No feedback history.";
    feedbackLogList.appendChild(li);
    return;
  }

  logs.slice(0, 20).forEach((entry) => {
    const li = document.createElement("li");
    li.textContent = `[${new Date(entry.at).toLocaleString()}] ${entry.text}`;
    feedbackLogList.appendChild(li);
  });
}

function renderEvalProgress() {
  if (!evalPendingMeta || !evalRunningMeta || !evalCompletedMeta || !evalFailedMeta || !evalProgressList) return;

  const progress = state.evalProgress || {};
  evalPendingMeta.textContent = String(progress.pending ?? 0);
  evalRunningMeta.textContent = String(progress.running ?? 0);
  evalCompletedMeta.textContent = String(progress.completed ?? 0);
  evalFailedMeta.textContent = String(progress.failed ?? 0);

  const rows = Object.values(progress.rows || {})
    .sort((a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER))
    .slice(0, 40);

  evalProgressList.innerHTML = "";
  if (rows.length === 0) {
    const li = document.createElement("li");
    li.textContent = "평가 진행 내역이 없습니다.";
    evalProgressList.appendChild(li);
    return;
  }

  rows.forEach((row) => {
    const li = document.createElement("li");
    const statusLabel = row.status === "captured"
      ? "수집"
      : (row.status === "running"
      ? "평가중"
      : (row.status === "completed" ? "완료" : (row.status === "failed" ? "실패" : "대기")));
    li.textContent = `${statusLabel} | ${row.applicationNo}`;
    evalProgressList.appendChild(li);
  });
}

function dedupeTerms(items) {
  const out = [];
  const seen = new Set();
  (Array.isArray(items) ? items : []).forEach((item) => {
    const normalized = String(item || "")
      .replace(/"/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(normalized);
  });
  return out;
}

function deriveWidenTerms(text) {
  const words = String(text || "")
    .replace(/[()\[\],.;:]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2);

  const out = [];
  if (words[0]) out.push(words[0]);
  if (words.length >= 2) out.push(`${words[0]} ${words[1]}`);
  return dedupeTerms(out);
}

function deriveLooseFallbackTerms(text) {
  const source = String(text || "").trim();
  if (!source) return [];
  const base = source.replace(/[()\[\],.;:]/g, " ").trim();
  const words = base.split(/\s+/).filter(Boolean);
  const out = [];

  if (words.length >= 1) out.push(words[0]);
  if (words.length >= 2) out.push(`${words[0]} ${words[1]}`);

  const compact = base.replace(/\s+/g, "");
  if (compact.length >= 4) out.push(compact.slice(0, 3));
  if (compact.length >= 3) out.push(compact.slice(0, 2));
  if (compact.length >= 2) out.push(compact.slice(0, 1));

  return dedupeTerms(out);
}

function pickStrictTerm(terms, featureText) {
  const candidates = dedupeTerms([...(Array.isArray(terms) ? terms : []), featureText]);
  if (!candidates.length) return String(featureText || "").trim();
  candidates.sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    return a.localeCompare(b);
  });
  return candidates[0];
}

function splitTopLevel(text, delimiterChar) {
  const src = String(text || "");
  const out = [];
  let depth = 0;
  let inQuote = false;
  let token = "";

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "\"") {
      inQuote = !inQuote;
      token += ch;
      continue;
    }
    if (!inQuote) {
      if (ch === "(") depth += 1;
      if (ch === ")" && depth > 0) depth -= 1;
      if (ch === delimiterChar && depth === 0) {
        out.push(token);
        token = "";
        continue;
      }
    }
    token += ch;
  }
  out.push(token);
  return out.map((item) => item.trim()).filter(Boolean);
}

function stripOuterParens(text) {
  const out = String(text || "").trim();
  if (out.startsWith("(") && out.endsWith(")")) {
    return out.slice(1, -1).trim();
  }
  return out;
}

function extractTermsFromExpressionGroup(groupText) {
  const body = stripOuterParens(groupText);
  return dedupeTerms(
    splitTopLevel(body, "|").map((raw) => {
      const trimmed = String(raw || "").trim();
      return trimmed.replace(/^"(.*)"$/u, "$1").trim();
    })
  );
}

function extractExpressionTermsForDiff(expression) {
  const groups = splitTopLevel(String(expression || "").trim(), "&");
  const terms = [];
  groups.forEach((groupText) => {
    const extracted = extractTermsFromExpressionGroup(groupText);
    extracted.forEach((term) => terms.push(term));
  });
  return dedupeTerms(terms);
}

function renderDiffList(container, terms, emptyText) {
  if (!container) return;
  container.innerHTML = "";
  const list = Array.isArray(terms) ? terms : [];
  if (list.length === 0) {
    const li = document.createElement("li");
    li.textContent = emptyText;
    container.appendChild(li);
    return;
  }

  list.slice(0, 30).forEach((term) => {
    const li = document.createElement("li");
    li.textContent = term;
    container.appendChild(li);
  });
}

function renderQueryDiff(session, currentVersion) {
  if (!queryDiffSummary || !queryDiffAdded || !queryDiffRemoved) return;

  const versions = Array.isArray(session?.queryVersions) ? session.queryVersions : [];
  const currentId = String(currentVersion?.queryVersionId || "").trim();
  const currentIndex = versions.findIndex((version) => String(version?.queryVersionId || "").trim() === currentId);
  const prevVersion = currentIndex > 0 ? versions[currentIndex - 1] : null;

  if (!prevVersion || !currentVersion) {
    queryDiffSummary.textContent = "이전 버전이 없습니다.";
    renderDiffList(queryDiffAdded, [], "추가된 용어 없음");
    renderDiffList(queryDiffRemoved, [], "제거된 용어 없음");
    return;
  }

  const prevExpression = String(prevVersion.expression || "").trim();
  const currentExpression = String(currentVersion.expression || "").trim();
  if (!prevExpression && !currentExpression) {
    queryDiffSummary.textContent = "변경된 용어가 없습니다.";
    renderDiffList(queryDiffAdded, [], "추가된 용어 없음");
    renderDiffList(queryDiffRemoved, [], "제거된 용어 없음");
    return;
  }

  const oldTerms = extractExpressionTermsForDiff(prevExpression);
  const newTerms = extractExpressionTermsForDiff(currentExpression);
  const oldSet = new Set(oldTerms.map((term) => term.toLowerCase()));
  const newSet = new Set(newTerms.map((term) => term.toLowerCase()));

  const added = newTerms.filter((term) => !oldSet.has(term.toLowerCase()));
  const removed = oldTerms.filter((term) => !newSet.has(term.toLowerCase()));

  const oldGroupCount = splitTopLevel(prevExpression, "&").length;
  const newGroupCount = splitTopLevel(currentExpression, "&").length;
  queryDiffSummary.textContent = `그룹 수 ${oldGroupCount} -> ${newGroupCount}, 추가 ${added.length}, 제거 ${removed.length}`;

  renderDiffList(queryDiffAdded, added, "추가된 용어 없음");
  renderDiffList(queryDiffRemoved, removed, "제거된 용어 없음");
}


function collectQueryStateMeta(version) {
  const groups = Array.isArray(version?.queryPlan?.groups) ? version.queryPlan.groups : [];
  const activeGroups = groups.filter((group) => group?.active !== false)
    .map((group) => String(group?.group_id || group?.groupId || "").trim())
    .filter(Boolean);
  const inactiveGroups = groups.filter((group) => group?.active === false)
    .map((group) => String(group?.group_id || group?.groupId || "").trim())
    .filter(Boolean);

  const basis = version?.feedbackBasis && typeof version.feedbackBasis === "object"
    ? version.feedbackBasis
    : {};

  const focusFeature = String(basis.focusFeatureId || basis.promotedFeatureId || "").trim();
  const simplificationApplied = basis.simplificationApplied === true
    || (Array.isArray(basis.dephrasedTerms) && basis.dephrasedTerms.length > 0)
    || groups.some((group) => group?.simplified === true);
  const crossGroupRemovedCount = Array.isArray(basis?.crossGroupDedupe?.duplicate_terms_removed)
    ? basis.crossGroupDedupe.duplicate_terms_removed.length
    : 0;
  const duplicateBlocked = version?.duplicateBlocked === true || basis?.duplicateQueryBlocked === true;
  const duplicateOf = String(version?.duplicateOfQueryVersionId || basis?.duplicateOfQueryVersionId || "").trim();

  return {
    activeGroups: uniqueStrings(activeGroups),
    inactiveGroups: uniqueStrings(inactiveGroups),
    focusFeature,
    simplificationApplied,
    crossGroupRemovedCount,
    duplicateBlocked,
    duplicateOf
  };
}

function renderQueryStateMeta(version) {
  if (!activeGroupsMeta || !inactiveGroupsMeta || !focusFeatureMeta || !simplificationMeta) return;
  const meta = collectQueryStateMeta(version);
  activeGroupsMeta.textContent = meta.activeGroups.length ? meta.activeGroups.join(", ") : "-";
  inactiveGroupsMeta.textContent = meta.inactiveGroups.length ? meta.inactiveGroups.join(", ") : "-";
  focusFeatureMeta.textContent = meta.focusFeature || "-";
  const simplifyLabel = meta.simplificationApplied ? "applied" : "none";
  simplificationMeta.textContent = meta.crossGroupRemovedCount > 0
    ? `${simplifyLabel} | cross-group dedupe ${meta.crossGroupRemovedCount}`
    : simplifyLabel;
  if (meta.duplicateBlocked) {
    activeGroupsMeta.textContent = `${activeGroupsMeta.textContent} | duplicate-blocked${meta.duplicateOf ? ` (of ${meta.duplicateOf})` : ""}`;
  }
}

function pushPlannerMetaLog(session, version, modeHint = "") {
  if (!session || !version) return;
  const basis = version?.feedbackBasis && typeof version.feedbackBasis === "object"
    ? version.feedbackBasis
    : {};
  const mode = String(modeHint || version?.refineMode || basis?.plannerDecision || "").trim() || "-";
  const changedGroupIds = uniqueStrings(basis.changedGroupIds || []);
  const promotedFeatureId = String(basis.promotedFeatureId || "").trim() || "-";
  const droppedFeatureId = String(basis.droppedFeatureId || "").trim() || "-";
  const dephrasedTerms = uniqueStrings(basis.dephrasedTerms || []);
  const expressionChanged = basis.expressionChanged !== false;
  const duplicateBlocked = version?.duplicateBlocked === true || basis?.duplicateQueryBlocked === true;
  const duplicateOf = String(version?.duplicateOfQueryVersionId || basis?.duplicateOfQueryVersionId || "").trim() || "-";
  const crossGroupRemovedCount = Array.isArray(basis?.crossGroupDedupe?.duplicate_terms_removed)
    ? basis.crossGroupDedupe.duplicate_terms_removed.length
    : 0;

  pushFeedbackLog(
    session,
    `planner_meta: mode=${mode}, changed_group_ids=${changedGroupIds.join("|") || "-"}, promoted_feature_id=${promotedFeatureId}, dropped_group_id=${droppedFeatureId}, dephrased_terms=${dephrasedTerms.join("|") || "-"}, expression_changed=${expressionChanged ? "Y" : "N"}, cross_group_removed=${crossGroupRemovedCount}, duplicate_blocked=${duplicateBlocked ? "Y" : "N"}, duplicate_of=${duplicateOf}`
  );
}
function deriveTermsByFeatureFromExpression({
  expression,
  features,
  featureStateById,
  fallbackTermsByFeature,
  baseQueryPlan
}) {
  return deriveQueryPlanFromExpression({
    expression,
    features,
    featureStateById,
    fallbackTermsByFeature,
    baseQueryPlan
  });
}

function getVersionHistoryWeight(version) {
  const explicit = Number(version?.historyWeight);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(1, Math.min(5, Math.round(explicit)));
  }
  return String(version?.source || "").trim() === "manual_user_edit"
    ? MANUAL_USER_EDIT_HISTORY_WEIGHT
    : 1;
}

function getManualGateRepeatCount(session, decision) {
  const mode = decision === MANUAL_DECISION_TOO_MANY ? "narrow" : "widen";
  const versions = Array.isArray(session?.queryVersions) ? session.queryVersions : [];
  let streak = 0;

  for (let index = versions.length - 1; index >= 0; index -= 1) {
    const version = versions[index];
    const source = String(version?.source || "").trim();
    if (source !== "manual_count_gate" && source !== "manual_count_gate_llm") break;
    if (String(version?.refineMode || "").trim() !== mode) break;
    streak += 1;
  }

  return Math.max(1, streak + 1);
}

function buildManualGateRefinedVersion({ session, currentVersion, decision }) {
  const features = Array.isArray(session?.features) ? session.features : [];
  const nextState = cloneDeep(currentVersion?.featureStateById || {});
  const nextTerms = cloneDeep(currentVersion?.termsByFeature || {});
  const feedbackActions = [];
  const currentExpression = String(currentVersion?.expression || "").trim();

  const coreIds = features.filter((feature) => !!feature.core).map((feature) => String(feature.id || ""));
  const coreSet = new Set(coreIds);

  if (decision === MANUAL_DECISION_TOO_MANY) {
    features.forEach((feature) => {
      const featureId = String(feature.id || "");
      if (!featureId) return;

      nextState[featureId] = {
        ...(nextState[featureId] || {}),
        enabled: true,
        core: !!feature.core,
        text: String(feature.text || "")
      };

      const terms = dedupeTerms([...(nextTerms[featureId] || []), feature.text]);
      const strict = pickStrictTerm(terms, feature.text);
      nextTerms[featureId] = [strict].filter(Boolean);
      feedbackActions.push(`[${featureId}] narrow: 해당 구성은 대표 용어 1개만 유지`);
    });
  } else if (decision === MANUAL_DECISION_TOO_FEW) {
    const enabledIds = features
      .map((feature) => String(feature.id || ""))
      .filter((featureId) => featureId && (nextState[featureId]?.enabled !== false));

    let enabledCount = enabledIds.length;
    const minEnabled = Math.max(2, coreIds.length > 0 ? coreIds.length : 2);

    features.forEach((feature) => {
      const featureId = String(feature.id || "");
      if (!featureId || coreSet.has(featureId)) return;

      const curEnabled = nextState[featureId]?.enabled !== false;
      if (!curEnabled) return;
      if (enabledCount <= minEnabled) return;

      nextState[featureId] = {
        ...(nextState[featureId] || {}),
        enabled: false,
        core: !!feature.core,
        text: String(feature.text || "")
      };
      enabledCount -= 1;
      feedbackActions.push(`[${featureId}] widen: 약한 제한 구성을 비활성화`);
    });

    features.forEach((feature) => {
      const featureId = String(feature.id || "");
      if (!featureId) return;

      if (coreSet.has(featureId)) {
        nextState[featureId] = {
          ...(nextState[featureId] || {}),
          enabled: true,
          core: true,
          text: String(feature.text || "")
        };
      }

      if (nextState[featureId]?.enabled === false) return;

      const widened = dedupeTerms([
        ...(nextTerms[featureId] || []),
        feature.text,
        ...deriveWidenTerms(feature.text)
      ]).slice(0, 6);

      nextTerms[featureId] = widened;
      feedbackActions.push(`[${featureId}] widen: 해당 구성 용어를 확장`);
    });
  }

  const enabledCoreCount = coreIds.filter((featureId) => nextState[featureId]?.enabled !== false).length;
  const requiredCoreCount = Math.min(2, coreIds.length);
  if (enabledCoreCount < requiredCoreCount) {
    coreIds.forEach((featureId) => {
      nextState[featureId] = {
        ...(nextState[featureId] || {}),
        enabled: true,
        core: true
      };
    });
    feedbackActions.push("core_guard: 핵심 구성은 최소 2개 유지");
  }

  let expression = buildExpression({
    features,
    termsByFeature: nextTerms,
    featureStateById: nextState
  });

  // 보정 후에도 식이 바뀌지 않으면 stronger fallback을 적용한다.
  // widen은 optional 비활성화/대체어 추가, narrow는 용어 축소를 한 번 더 시도한다.
  if (String(expression || "").trim() === currentExpression) {
      if (decision === MANUAL_DECISION_TOO_FEW) {
      const optionalEnabled = features.find((feature) => {
        const featureId = String(feature.id || "");
        return featureId && !feature.core && nextState[featureId]?.enabled !== false;
      });
      if (optionalEnabled) {
        const featureId = String(optionalEnabled.id || "");
        nextState[featureId] = {
          ...(nextState[featureId] || {}),
          enabled: false,
          core: !!optionalEnabled.core,
          text: String(optionalEnabled.text || "")
        };
        feedbackActions.push(`[${featureId}] widen: force disable optional feature`);
      } else {
        const firstEnabled = features.find((feature) => {
          const featureId = String(feature.id || "");
          return featureId && nextState[featureId]?.enabled !== false;
        });
        if (firstEnabled) {
          const featureId = String(firstEnabled.id || "");
          const widened = dedupeTerms([
            ...(nextTerms[featureId] || []),
            ...deriveWidenTerms(firstEnabled.text),
            ...deriveLooseFallbackTerms(firstEnabled.text)
          ]);
          if (widened.length > (nextTerms[featureId] || []).length) {
            nextTerms[featureId] = widened.slice(0, 8);
            feedbackActions.push(`[${featureId}] widen: force add alternate term`);
          }
        }
      }
    } else if (decision === MANUAL_DECISION_TOO_MANY) {
      const targetFeature = features.find((feature) => {
        const featureId = String(feature.id || "");
        return featureId && nextState[featureId]?.enabled !== false && (nextTerms[featureId] || []).length > 1;
      });
      if (targetFeature) {
        const featureId = String(targetFeature.id || "");
        nextTerms[featureId] = [String((nextTerms[featureId] || [])[0] || "").trim()].filter(Boolean);
        feedbackActions.push(`[${featureId}] narrow: force keep first term`);
      } else {
        const optionalEnabled = features.find((feature) => {
          const featureId = String(feature.id || "");
          return featureId && !feature.core && nextState[featureId]?.enabled !== false;
        });
        if (optionalEnabled) {
          const featureId = String(optionalEnabled.id || "");
          nextState[featureId] = {
            ...(nextState[featureId] || {}),
            enabled: false,
            core: !!optionalEnabled.core,
            text: String(optionalEnabled.text || "")
          };
          feedbackActions.push(`[${featureId}] narrow: force disable optional feature`);
        } else {
          const disabledFeature = features.find((feature) => {
            const featureId = String(feature.id || "");
            return featureId && nextState[featureId]?.enabled === false;
          });
          if (disabledFeature) {
            const featureId = String(disabledFeature.id || "");
            nextState[featureId] = {
              ...(nextState[featureId] || {}),
              enabled: true,
              core: !!disabledFeature.core,
              text: String(disabledFeature.text || "")
            };
            feedbackActions.push(`[${featureId}] narrow: force enable disabled feature`);
          }
        }
      }
    }

    expression = buildExpression({
      features,
      termsByFeature: nextTerms,
      featureStateById: nextState
    });

    if (String(expression || "").trim() === currentExpression) {
      if (decision === MANUAL_DECISION_TOO_FEW) {
        const firstEnabled = features.find((feature) => {
          const featureId = String(feature.id || "");
          return featureId && nextState[featureId]?.enabled !== false;
        });
        if (firstEnabled) {
          const featureId = String(firstEnabled.id || "");
          const loose = deriveLooseFallbackTerms(firstEnabled.text).find((term) => {
            return !dedupeTerms(nextTerms[featureId] || []).some((entry) => entry.toLowerCase() === term.toLowerCase());
          });
          if (loose) {
            nextTerms[featureId] = dedupeTerms([...(nextTerms[featureId] || []), loose]).slice(0, 8);
            feedbackActions.push(`[${featureId}] widen: force add loose fallback '${loose}'`);
          }
        }
      } else if (decision === MANUAL_DECISION_TOO_MANY) {
        const firstEnabled = features.find((feature) => {
          const featureId = String(feature.id || "");
          return featureId && nextState[featureId]?.enabled !== false;
        });
        if (firstEnabled) {
          const featureId = String(firstEnabled.id || "");
          const base = String(firstEnabled.text || "").trim();
          if (base) {
            nextTerms[featureId] = [`${base} ${base}`];
            feedbackActions.push(`[${featureId}] narrow: force strict composite term`);
          }
        }
      }

      expression = buildExpression({
        features,
        termsByFeature: nextTerms,
        featureStateById: nextState
      });
    }
  }

  const queryPlan = normalizeQueryPlan({
    features,
    termsByFeature: nextTerms,
    featureStateById: nextState
  });
  expression = buildExpression({
    queryPlan,
    features,
    termsByFeature: nextTerms,
    featureStateById: nextState
  });

  return {
    queryVersionId: makeQueryVersionId(),
    createdAt: nowIso(),
    source: "manual_count_gate",
    refineMode: decision === MANUAL_DECISION_TOO_MANY ? "narrow" : "widen",
    notes: decision === MANUAL_DECISION_TOO_MANY
      ? "Manual gate: too many results"
      : "Manual gate: too few results",
    expression,
    queryPlan,
    termsByFeature: nextTerms,
    featureStateById: nextState,
    historyWeight: 1,
    feedbackActions: dedupeTerms(feedbackActions).slice(0, 20)
  };
}

function formatAutoStatusLabel(status) {
  const value = String(status || AUTO_STATUS_IDLE).trim().toLowerCase();
  if (!value) return AUTO_STATUS_IDLE;
  return value;
}

function shortenQueryExpression(expression, limit = 220) {
  const raw = String(expression || "").replace(/\s+/g, " ").trim();
  if (!raw) return "-";
  if (raw.length <= limit) return raw;
  return `${raw.slice(0, Math.max(10, limit - 3))}...`;
}

function applyAutoStatusBadge(element, status) {
  if (!element) return;
  element.classList.remove(
    "auto-status-running",
    "auto-status-warn",
    "auto-status-paused",
    "auto-status-error",
    "auto-status-done",
    "auto-status-stopping"
  );
  if (status === AUTO_STATUS_RUNNING) element.classList.add("auto-status-running");
  if (status === AUTO_STATUS_STOPPING) element.classList.add("auto-status-stopping", "auto-status-warn");
  if (status === AUTO_STATUS_PAUSED) element.classList.add("auto-status-paused", "auto-status-warn");
  if (status === AUTO_STATUS_ERROR) element.classList.add("auto-status-error");
  if (status === AUTO_STATUS_DONE) element.classList.add("auto-status-done");
}

function toAutoStatusText(status) {
  const value = formatAutoStatusLabel(status);
  if (value === AUTO_STATUS_RUNNING) return "running";
  if (value === AUTO_STATUS_STOPPING) return "stopping";
  if (value === AUTO_STATUS_PAUSED) return "paused";
  if (value === AUTO_STATUS_ERROR) return "error";
  if (value === AUTO_STATUS_DONE) return "done";
  return "idle";
}

function toAutoStageText(stageRaw) {
  const stage = String(stageRaw || "").trim();
  const map = {
    [AUTO_STAGE.PREPARE]: "준비",
    [AUTO_STAGE.ENSURE_INITIAL_QUERY]: "초기 검색식 준비",
    [AUTO_STAGE.START_CAPTURE]: "캡처 시작",
    [AUTO_STAGE.CLICK_INITIAL_SCREEN]: "초기 화면 이동",
    [AUTO_STAGE.APPLY_QUERY]: "검색식 입력",
    [AUTO_STAGE.CLICK_SEARCH]: "검색 버튼 클릭",
    [AUTO_STAGE.WAIT_DIALOG]: "Dialog/결과 수 대기",
    [AUTO_STAGE.HANDLE_DIALOG_MANY]: "결과 많음 보정",
    [AUTO_STAGE.HANDLE_DIALOG_FEW]: "결과 적음 보정",
    [AUTO_STAGE.WAIT_RESULT_COUNT]: "결과 수 판독",
    [AUTO_STAGE.HANDLE_COUNT_MANY]: "결과 수 기반 보정",
    [AUTO_STAGE.HANDLE_COUNT_PROCEED]: "적정 건수 판정",
    [AUTO_STAGE.MARK_PROCEED]: "진행 확정",
    [AUTO_STAGE.CLICK_CLAIM_BATCH]: "청구항 일괄조회 클릭",
    [AUTO_STAGE.WAIT_CLAIM_BATCH_CAPTURE]: "수집 안정화 대기",
    [AUTO_STAGE.CLOSE_CLAIM_BATCH_TABS]: "파생 탭 정리",
    [AUTO_STAGE.FINISH_CYCLE]: "수집 완료 + 평가 실행",
    [AUTO_STAGE.WAIT_CYCLE_RESULT]: "평가/요약 대기",
    [AUTO_STAGE.ADVANCE_ITERATION]: "다음 반복 준비",
    [AUTO_STAGE.COMPLETED]: "자동 탐색 완료",
    [AUTO_STAGE.PAUSED_MANUAL_REQUIRED]: "사람 확인 필요",
    [AUTO_STAGE.ERROR]: "오류"
  };
  return map[stage] || (stage || "-");
}

function toDialogSummaryLabel(kindRaw) {
  const kind = String(kindRaw || "").trim().toLowerCase();
  if (kind === "many") return "many (결과 많음)";
  if (kind === "few") return "few (결과 적음)";
  if (kind === "none") return "none";
  return "-";
}

function buildHeroNextActionText({ status, stageText, lastAction, pendingCapture, manualDecision, sessionStatus }) {
  if (status === AUTO_STATUS_ERROR) {
    return "오류 원인을 확인하고 고급 탭에서 수동 조치 후 재시작하세요.";
  }
  if (status === AUTO_STATUS_STOPPING) {
    return "현재 단계 종료 후 자동 모드를 정지합니다.";
  }
  if (status === AUTO_STATUS_PAUSED) {
    return "사람 확인 필요 카드에서 판단을 선택하거나 고급 제어를 사용하세요.";
  }
  if (status === AUTO_STATUS_DONE) {
    return "종료 조건에 도달했습니다. 결과 탭에서 후보를 검토하세요.";
  }
  if (status === AUTO_STATUS_RUNNING) {
    if (lastAction) return lastAction;
    return `${stageText} 진행 중`;
  }
  if (pendingCapture && manualDecision === MANUAL_DECISION_PENDING) {
    return "결과 건수 판단 후 진행하세요.";
  }
  if (sessionStatus === "capturing") {
    return "검색 후 청구항 일괄조회를 실행하고 수집 완료를 기다리세요.";
  }
  return "자동 탐색 시작을 누르면 루프를 실행합니다.";
}

function isRecoverableAutoError(message) {
  const text = String(message || "").toLowerCase();
  if (!text) return false;
  return (
    text.includes("result_count_unreadable")
    || text.includes("result-count")
    || text.includes("claim_batch")
    || text.includes("claim-batch")
    || text.includes("duplicate")
    || text.includes("manual")
  );
}

function resolveManualInterventionState(session, pendingCapture, manualDecision) {
  const status = formatAutoStatusLabel(state.autoRunner?.status || AUTO_STATUS_IDLE);
  const stage = String(state.autoRunner?.stage || "").trim();
  const lastError = String(state.autoRunner?.lastError || "").trim();
  const lastAction = String(state.autoRunner?.lastAction || "").trim();

  const pausedManual = stage === AUTO_STAGE.PAUSED_MANUAL_REQUIRED || status === AUTO_STATUS_PAUSED;
  if (pausedManual) {
    const reason = lastError
      || lastAction
      || "자동 진행이 멈췄습니다. 결과 많음/적음/적정 중 하나를 선택해 주세요.";
    return {
      visible: true,
      message: reason
    };
  }

  if (status === AUTO_STATUS_ERROR && isRecoverableAutoError(lastError || lastAction)) {
    return {
      visible: true,
      message: lastError || lastAction || "복구 가능한 오류가 발생했습니다. 수동 판단 후 계속 진행하세요."
    };
  }

  if (state.autoRunner.active !== true && pendingCapture && manualDecision === MANUAL_DECISION_PENDING) {
    return {
      visible: true,
      message: "수집 중간 판단이 필요합니다. 결과 많음/적음/적정을 선택해 주세요."
    };
  }

  return {
    visible: false,
    message: ""
  };
}

function computeExecuteDiffLine(session, currentVersion) {
  const versions = Array.isArray(session?.queryVersions) ? session.queryVersions : [];
  const currentId = String(currentVersion?.queryVersionId || "").trim();
  const currentIndex = versions.findIndex((entry) => String(entry?.queryVersionId || "").trim() === currentId);
  const prevVersion = currentIndex > 0 ? versions[currentIndex - 1] : null;
  if (!prevVersion || !currentVersion) {
    return "초기 버전입니다.";
  }

  const prevExpression = String(prevVersion.expression || "").trim();
  const currentExpression = String(currentVersion.expression || "").trim();
  const oldTerms = extractExpressionTermsForDiff(prevExpression);
  const newTerms = extractExpressionTermsForDiff(currentExpression);
  const oldSet = new Set(oldTerms.map((term) => term.toLowerCase()));
  const newSet = new Set(newTerms.map((term) => term.toLowerCase()));
  const added = newTerms.filter((term) => !oldSet.has(term.toLowerCase()));
  const removed = oldTerms.filter((term) => !newSet.has(term.toLowerCase()));

  const oldGroupCount = splitTopLevel(prevExpression, "&").length;
  const newGroupCount = splitTopLevel(currentExpression, "&").length;
  return `그룹 ${oldGroupCount} → ${newGroupCount}, 추가 ${added.length}, 제거 ${removed.length}`;
}

function computeExecuteReasonText(session, currentVersion) {
  const reasonFromBasis = String(currentVersion?.feedbackBasis?.nextQueryRationale || "").trim();
  if (reasonFromBasis) return reasonFromBasis;
  const notes = String(currentVersion?.notes || "").trim();
  if (notes) return notes;
  const actions = Array.isArray(currentVersion?.feedbackActions) ? currentVersion.feedbackActions : [];
  if (actions.length > 0) return String(actions[0] || "").trim();
  const log = Array.isArray(session?.feedbackLog) ? session.feedbackLog : [];
  if (log.length > 0) return String(log[0]?.text || "").trim();
  return "아직 변경 근거가 없습니다.";
}

function renderExecuteQuerySummary(session, currentVersion) {
  if (executeQuerySummary) {
    executeQuerySummary.textContent = shortenQueryExpression(currentVersion?.expression || "");
  }
  if (executeQueryDiffLine) {
    executeQueryDiffLine.textContent = computeExecuteDiffLine(session, currentVersion);
  }
  if (executeQueryWhy) {
    executeQueryWhy.textContent = computeExecuteReasonText(session, currentVersion);
  }
}

function renderManualInterventionCard(session, pendingCapture, manualDecision) {
  if (!manualInterventionCard || !manualInterventionMessage) return;
  const intervention = resolveManualInterventionState(session, pendingCapture, manualDecision);
  manualInterventionCard.classList.toggle("hidden", intervention.visible !== true);
  if (intervention.visible) {
    manualInterventionMessage.textContent = intervention.message;
  }
  if (manualInterventionActions) {
    manualInterventionActions.classList.toggle("hidden", !pendingCapture);
  }
}

function renderAutoRunnerMeta(session, currentVersion) {
  const status = formatAutoStatusLabel(state.autoRunner?.status || AUTO_STATUS_IDLE);
  const stageRaw = String(state.autoRunner?.stage || "").trim();
  const stageText = toAutoStageText(stageRaw);
  const queryVersionId = String(
    state.autoRunner?.currentQueryVersionId
    || currentVersion?.queryVersionId
    || "-"
  );
  const iterationText = `${Number(session?.iterationCount || 0)} / ${getMaxIterations()}`;
  const runId = String(
    state.autoRunner?.currentRunId
    || session?.pendingCapture?.runId
    || "-"
  );
  const expression = String(
    state.autoRunner?.currentExpression
    || currentVersion?.expression
    || "-"
  );
  const dialogText = toDialogSummaryLabel(state.autoRunner?.lastDialogKind || "-");
  const countSource = normalizeCountSourceLabel(state.autoRunner?.lastCountSource || "unknown");
  const countBucket = String(state.autoRunner?.lastCountBucket || "unknown");
  const countText = Number.isFinite(Number(state.autoRunner?.lastResultCount))
    ? `${Number(state.autoRunner.lastResultCount)} (${countSource}/${countBucket})`
    : "-";
  const lastAction = String(state.autoRunner?.lastAction || "-");
  const lastError = String(state.autoRunner?.lastError || "-");
  const retryCount = String(Math.max(0, Number(state.autoRunner?.retryCount || 0)));
  const sessionId = String(session?.sessionId || "-");
  const summaryExpression = shortenQueryExpression(expression, 240);
  const summaryInlineExpression = shortenQueryExpression(expression, 90);
  const nextActionText = buildHeroNextActionText({
    status,
    stageText,
    lastAction,
    pendingCapture: session?.pendingCapture || null,
    manualDecision: normalizeManualDecision(session?.pendingCapture?.manualDecision, !!session?.pendingCapture),
    sessionStatus: String(session?.status || "").trim()
  });

  [autoModeMeta, shellAutoStatus, heroAutoStatus].forEach((el) => {
    if (!el) return;
    el.textContent = toAutoStatusText(status);
    applyAutoStatusBadge(el, status);
  });

  if (autoStageMeta) autoStageMeta.textContent = stageRaw || "-";
  if (autoQueryVersionMeta) autoQueryVersionMeta.textContent = queryVersionId;
  if (autoIterationMeta) autoIterationMeta.textContent = iterationText;
  if (autoRunMeta) autoRunMeta.textContent = runId;
  if (autoCurrentQueryMeta) autoCurrentQueryMeta.textContent = expression;
  if (autoDialogMeta) autoDialogMeta.textContent = String(state.autoRunner?.lastDialogKind || "-");
  if (autoCountMeta) autoCountMeta.textContent = countText;
  if (autoActionMeta) autoActionMeta.textContent = lastAction;
  if (autoErrorMeta) autoErrorMeta.textContent = lastError;
  if (autoRetryMeta) autoRetryMeta.textContent = retryCount;

  if (shellStage) shellStage.textContent = stageText;
  if (shellCurrentQuery) shellCurrentQuery.textContent = summaryInlineExpression;
  if (shellSession) shellSession.textContent = sessionId;
  if (shellIteration) shellIteration.textContent = iterationText;
  if (shellQueryVersion) shellQueryVersion.textContent = queryVersionId;

  if (heroStage) heroStage.textContent = stageText;
  if (heroCurrentQuery) heroCurrentQuery.textContent = summaryExpression;
  if (heroNextAction) heroNextAction.textContent = nextActionText;
  if (heroRecentDialog) heroRecentDialog.textContent = dialogText;
  if (heroRecentCount) heroRecentCount.textContent = countText;
  if (heroError) heroError.textContent = lastError && lastError !== "-" ? lastError : "-";
  if (heroRetry) heroRetry.textContent = retryCount;
  if (heroIteration) heroIteration.textContent = iterationText;
  if (heroSession) heroSession.textContent = sessionId;
}

function render() {
  if (
    !claimInput || !claimStat
    || !sessionIdMeta || !queryVersionMeta || !iterationMeta || !statusMeta
    || !queryExpression || !runMeta || !tabMeta
    || !diagAttachedTabsMeta || !diagDerivedTabsMeta || !diagRowsStoredMeta || !diagRowsDiscardedMeta || !diagDiscardReasonsMeta || !diagStoredTargetFalseMeta
    || !queryDiffSummary || !queryDiffAdded || !queryDiffRemoved
    || !activeGroupsMeta || !inactiveGroupsMeta || !focusFeatureMeta || !simplificationMeta
    || !manualGateMeta || !manualNextMeta
    || !metricCount || !metricTopScore || !metricCoverage || !metricDecision
    || !topDocsList || !pairCandidatesList || !feedbackLogList
    || !saturatedFeaturesList || !gapFeaturesList || !noisyTermsList || !nextQueryRationaleList
  ) {
    return;
  }

  const session = getActiveSession();
  const currentVersion = getCurrentQueryVersion(session);
  const pendingCapture = session?.pendingCapture || null;
  const manualDecision = normalizeManualDecision(pendingCapture?.manualDecision, !!pendingCapture);
  syncAutoRunnerWithSession();
  updatePaneLayoutMetrics();
  renderAutoRunnerMeta(session, currentVersion);
  renderPaneVisibility();
  renderAdvancedSectionState();
  renderReasoningSettingsControls();
  if (claimCard) {
    claimCard.classList.toggle("is-compact", state.autoRunner.active === true);
  }

  claimStat.textContent = `${(claimInput.value || "").length} chars`;

  sessionIdMeta.textContent = session?.sessionId || "-";
  queryVersionMeta.textContent = currentVersion?.queryVersionId || "-";
  iterationMeta.textContent = `${session?.iterationCount || 0} / ${getMaxIterations()}`;
  statusMeta.textContent = toLabelStatus(session?.status || "idle");

  syncQueryDraftFromCurrent(currentVersion);
  queryExpression.value = state.queryDraftText;
  renderQueryDiff(session, currentVersion);
  renderQueryStateMeta(currentVersion);
  renderExecuteQuerySummary(session, currentVersion);
  renderManualInterventionCard(session, pendingCapture, manualDecision);

  runMeta.textContent = pendingCapture?.runId || "-";
  tabMeta.textContent = Number.isInteger(pendingCapture?.tabId)
    ? String(pendingCapture.tabId)
    : "-";
  diagAttachedTabsMeta.textContent = String(Math.max(0, Number(state.captureDiagnostics?.attachedTabsCount || 0)));
  diagDerivedTabsMeta.textContent = String(Math.max(0, Number(state.captureDiagnostics?.derivedTabsAttachedCount || 0)));
  diagRowsStoredMeta.textContent = String(Math.max(0, Number(state.captureDiagnostics?.rowsStoredCount || 0)));
  diagRowsDiscardedMeta.textContent = String(Math.max(0, Number(state.captureDiagnostics?.rowsDiscardedCount || 0)));
  diagStoredTargetFalseMeta.textContent = String(Math.max(0, Number(state.captureDiagnostics?.lastStoredTargetMatchedFalseCount || 0)));
  diagDiscardReasonsMeta.textContent = formatDiscardReasonsSummary(state.captureDiagnostics?.discardReasons);

  manualGateMeta.textContent = toManualDecisionLabel(manualDecision);
  manualNextMeta.textContent = toManualNextActionLabel(manualDecision, !!pendingCapture);

  const summary = buildSessionCumulativeSummary(session, currentVersion) || session?.lastSummary || null;
  renderResultsProgressAndDistribution(session);
  metricCount.textContent = summary?.resultCount ?? 0;
  metricTopScore.textContent = formatScore(summary?.topScore);
  metricCoverage.textContent = summary ? `${Math.round((summary.coverage || 0) * 100)}%` : "-";
  metricDecision.textContent = summary
    ? (summary.singleHit ? "단일 문헌 근접" : (summary.pairHit ? "조합 후보 성립" : "탐색 계속"))
    : "-";

  renderSummaryList(topDocsList, summary?.topDocs || [], (row) => (
    `${row.applicationNo || "(no appNo)"} | score ${formatScore(row.score)}
- hits: ${Array.isArray(row.featureHits) && row.featureHits.length ? row.featureHits.join(", ") : "-"}
- judgments: ${row.featureJudgmentSummary || "-"}
- reason: ${String(row.reason || "-").trim() || "-"}`
  ), {
    onSelect: (row, index) => {
      openResultDetailModal(
        `상위 문헌 상세 (${index + 1})`,
        buildTopDocDetailText(session, row, index)
      );
    }
  });

  renderSummaryList(pairCandidatesList, summary?.pairCandidates || [], (row) => (
    `${row.leftApplicationNo || "-"} + ${row.rightApplicationNo || "-"} | coverage ${Math.round((row.coverage || 0) * 100)}% | plausibility ${Math.round((Number(row.combinePlausibility) || 0) * 100)}%
- pair reason: ${String(row.pairRationale || "").trim() || "-"}
- minScore: ${formatScore(row.minScore)} | conflict: ${row.lowConflict ? "low" : "high"} | remaining gaps: ${(Array.isArray(row.remainingGaps) ? row.remainingGaps.length : 0)}`
  ), {
    onSelect: (row, index) => {
      openResultDetailModal(
        `조합 후보 상세 (${index + 1})`,
        buildPairCandidateDetailText(session, row, index)
      );
    }
  });
  renderDecisionRationale(session, currentVersion, summary);

  renderEvalProgress();
  renderFeedbackLogs(session);

  const hasSession = !!session;
  const canFinishCycle = !!pendingCapture && manualDecision === MANUAL_DECISION_PROCEED;

  startCaptureBtn.disabled = state.busy || !hasSession || session.status === "capturing";
  finishCycleBtn.disabled = state.busy || !hasSession || !canFinishCycle;
  rollbackQueryBtn.disabled = state.busy || !hasSession || !Array.isArray(session.queryVersions) || session.queryVersions.length < 2;
  copyQueryBtn.disabled = !String(state.queryDraftText || currentVersion?.expression || "").trim();
  if (saveManualQueryBtn) {
    const hasDraft = !!String(state.queryDraftText || "").trim();
    saveManualQueryBtn.disabled = state.busy || !hasSession || !hasDraft || !state.queryDraftDirty;
  }

  manualTooManyBtn.disabled = state.busy || !pendingCapture;
  manualTooFewBtn.disabled = state.busy || !pendingCapture;
  manualProceedBtn.disabled = state.busy || !pendingCapture;
  if (manualTooManyBtnAdv) manualTooManyBtnAdv.disabled = manualTooManyBtn.disabled;
  if (manualTooFewBtnAdv) manualTooFewBtnAdv.disabled = manualTooFewBtn.disabled;
  if (manualProceedBtnAdv) manualProceedBtnAdv.disabled = manualProceedBtn.disabled;
  if (abortLoopBtnAdvanced) abortLoopBtnAdvanced.disabled = false;
  if (execCopyQueryBtn) execCopyQueryBtn.disabled = copyQueryBtn.disabled;
  if (execRollbackBtn) execRollbackBtn.disabled = rollbackQueryBtn.disabled;
  if (startAutoModeBtn) {
    startAutoModeBtn.disabled = state.busy || state.autoRunner.active === true;
  }
  if (stopAutoModeBtn) {
    stopAutoModeBtn.disabled = state.autoRunner.active !== true;
  }

  if (session?.status === "capturing" && pendingCapture) {
    ensureCaptureStatusPolling();
  } else if (state.captureStatusPollTimer) {
    stopCaptureStatusPolling();
  } else if (!pendingCapture) {
    resetCaptureDiagnosticsState();
  }

  renderResultDetailModal();
  if (state.queryHistoryModal?.open) {
    renderQueryHistoryModalTable(session);
  }
  renderQueryHistoryModal();
}

async function sendRuntimeMessage(message, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error("runtime message timeout"));
    }, timeoutMs);

    chrome.runtime.sendMessage(message, (response) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message || String(error)));
        return;
      }
      resolve(response || {});
    });
  });
}

async function clearStoredLiteratureCache(reason = "session_end") {
  const cleanupReason = String(reason || "").trim() || "session_end";
  let captureClearedCount = 0;

  try {
    const response = await sendRuntimeMessage({
      type: "KRESEARCH_CLEAR_CAPTURE_HISTORY"
    }, 12000);
    if (response?.ok) {
      captureClearedCount = Number(response?.clearedCount || 0);
    } else {
      throw new Error(response?.error || "capture history clear failed");
    }
  } catch (error) {
    console.warn("[K-Research] capture history clear failed", {
      reason: cleanupReason,
      error: error?.message || String(error)
    });
  }

  try {
    await chrome.storage.local.set({
      [EVAL_HISTORY_STORAGE_KEY]: []
    });
    state.evalHistory = [];
  } catch (error) {
    console.warn("[K-Research] eval history clear failed", {
      reason: cleanupReason,
      error: error?.message || String(error)
    });
  }

  resetCaptureDiagnosticsState();
  console.debug("[K-Research] literature cache cleared", {
    reason: cleanupReason,
    captureClearedCount
  });
}

async function getActiveHttpTab() {
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs || tabs.length === 0 || !tabs[0]?.id) {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  const active = tabs?.[0] || null;
  const activeUrl = String(active?.url || "");
  const activeCapturable = Number.isInteger(active?.id)
    && (activeUrl.startsWith("http://") || activeUrl.startsWith("https://"));
  if (activeCapturable) return active;

  if (Number.isInteger(active?.windowId)) {
    const sameWindowTabs = await chrome.tabs.query({ windowId: active.windowId });
    const fallback = (Array.isArray(sameWindowTabs) ? sameWindowTabs : []).find((tab) => {
      const url = String(tab?.url || "");
      return Number.isInteger(tab?.id) && (url.startsWith("http://") || url.startsWith("https://"));
    });
    if (fallback) return fallback;
  }

  throw new Error("No capturable HTTP/HTTPS tab found for KOMPASS.");
}

function isCapturableHttpTab(tab) {
  const url = String(tab?.url || "");
  return Number.isInteger(tab?.id) && (url.startsWith("http://") || url.startsWith("https://"));
}

async function resolveTabById(tabId) {
  const normalizedTabId = Number(tabId);
  if (!Number.isInteger(normalizedTabId)) return null;
  const tab = await chrome.tabs.get(normalizedTabId).catch(() => null);
  return isCapturableHttpTab(tab) ? tab : null;
}

async function runMainWorldOnTab(tab, func, args = []) {
  if (!Number.isInteger(tab?.id)) {
    throw new Error("No active tab found.");
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func,
    args
  });
  return results?.[0]?.result ?? null;
}

async function runMainWorldOnTabAllFrames(tab, func, args = []) {
  if (!Number.isInteger(tab?.id)) {
    throw new Error("No active tab found.");
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      world: "MAIN",
      func,
      args
    });
    return Array.isArray(results) ? results : [];
  } catch (error) {
    console.warn(
      "[auto][dialog-monitor] all-frames execute failed, fallback to top-frame: %s",
      String(error?.message || error || "")
    );
    // Fallback to top-frame only when all-frames scripting is not available.
    const single = await runMainWorldOnTab(tab, func, args);
    return [{
      frameId: 0,
      result: single,
      fallbackTopFrameOnly: true,
      error: String(error?.message || error || "")
    }];
  }
}

async function runMainWorldOnActiveTab(func, args = []) {
  const tab = await getActiveHttpTab();
  return runMainWorldOnTab(tab, func, args);
}

function classifyKompassDialog(rawType) {
  if (rawType === "confirm") {
    return {
      kind: "many",
      uiType: "확인/취소",
      uiKind: "많음",
      autoAction: "cancel"
    };
  }
  if (rawType === "alert") {
    return {
      kind: "few",
      uiType: "확인",
      uiKind: "없음",
      autoAction: "confirm"
    };
  }
  if (rawType === "prompt") {
    return {
      kind: "other",
      uiType: "prompt",
      uiKind: "기타",
      autoAction: "confirm"
    };
  }
  if (rawType === "beforeunload") {
    return {
      kind: "other",
      uiType: "beforeunload",
      uiKind: "기타",
      autoAction: "confirm"
    };
  }
  return {
    kind: "other",
    uiType: rawType || "unknown",
    uiKind: "기타",
    autoAction: "confirm"
  };
}

function installOrRefreshDialogMonitor(options = {}) {
  const normalizedOptions = (typeof options === "number")
    ? { durationMs: Number(options || 15000), confirmBehavior: "confirm", preserveHistory: false }
    : (options && typeof options === "object" ? options : {});
  const monitorWindowMs = Number(normalizedOptions.durationMs || 15000);
  const preserveHistory = normalizedOptions.preserveHistory === true;
  const confirmBehavior = (() => {
    const raw = String(normalizedOptions.confirmBehavior || "confirm").trim().toLowerCase();
    if (raw === "dismiss" || raw === "cancel") return "cancel";
    return "confirm";
  })();
  const startedAt = Date.now();
  const until = startedAt + monitorWindowMs;

  function normalizeMessage(value) {
    try {
      if (value === undefined || value === null) return "";
      return String(value);
    } catch {
      return "";
    }
  }

  // IMPORTANT: This function runs in page MAIN world via executeScript.
  // Do not reference outer module-scope helpers here.
  function parseDialogCountInline(message) {
    const text = String(message || "");
    if (!text) return null;

    const patterns = [
      /\(([0-9][0-9,]*)\s*건\)/i,
      /([0-9][0-9,]*)\s*건/i
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (!match?.[1]) continue;
      const parsed = Number(String(match[1]).replace(/,/g, ""));
      if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
    }
    return null;
  }

  function buildDialogPayload(rawType, message, behavior = "confirm") {
    const normalizedType = String(rawType || "").trim().toLowerCase();
    const base = (() => {
      if (normalizedType === "confirm") {
        return {
          kind: "many",
          uiType: "확인/취소",
          uiKind: "많음"
        };
      }
      if (normalizedType === "alert") {
        return {
          kind: "few",
          uiType: "확인",
          uiKind: "없음"
        };
      }
      return {
        kind: "other",
        uiType: normalizedType || "unknown",
        uiKind: "기타"
      };
    })();
    const parsedCount = parseDialogCountInline(message);
    const autoAction = normalizedType === "confirm"
      ? (behavior === "cancel" ? "cancel" : "confirm")
      : "confirm";
    return {
      rawType: normalizedType,
      message: normalizeMessage(message),
      parsedCount: Number.isFinite(Number(parsedCount)) ? Number(parsedCount) : null,
      detectedAt: new Date().toISOString(),
      timestamp: Date.now(),
      ...base,
      autoAction
    };
  }

  function recordDialog(rawType, message, behavior = "confirm") {
    let payload = null;
    try {
      payload = buildDialogPayload(rawType, message, behavior);
    } catch (error) {
      payload = {
        rawType: String(rawType || "").trim().toLowerCase(),
        message: normalizeMessage(message),
        parsedCount: null,
        detectedAt: new Date().toISOString(),
        timestamp: Date.now(),
        kind: rawType === "confirm" ? "many" : (rawType === "alert" ? "few" : "other"),
        uiType: rawType === "confirm" ? "확인/취소" : "확인",
        uiKind: rawType === "confirm" ? "많음" : (rawType === "alert" ? "없음" : "기타"),
        autoAction: rawType === "confirm" && behavior === "cancel" ? "cancel" : "confirm",
        parserError: String(error?.message || error || "")
      };
    }
    const state = window.__kResearchDialogMonitorState || {};
    if (!Array.isArray(state.history)) state.history = [];
    if (!state.firstDialog) state.firstDialog = payload;
    state.lastDialog = payload;
    state.history.push(payload);
    window.__kResearchDialogMonitorState = state;
    console.log(
      "[auto][dialog-monitor] captured rawType=%s kind=%s autoAction=%s",
      payload.rawType || "",
      payload.kind || "",
      payload.autoAction || ""
    );
    return payload;
  }

  if (
    typeof window.__kResearchOriginalConfirm !== "function"
    || window.confirm === window.__kResearchMonitorConfirm
  ) {
    window.__kResearchOriginalConfirm = window.confirm.bind(window);
  }
  if (
    typeof window.__kResearchOriginalAlert !== "function"
    || window.alert === window.__kResearchMonitorAlert
  ) {
    window.__kResearchOriginalAlert = window.alert.bind(window);
  }

  const monitorConfirm = function monitorConfirm(message) {
    const state = window.__kResearchDialogMonitorState || {};
    if (Date.now() <= (state.until || 0)) {
      const behavior = String(state.confirmBehavior || "confirm").trim().toLowerCase() === "cancel"
        ? "cancel"
        : "confirm";
      recordDialog("confirm", message, behavior);
      return behavior !== "cancel";
    }
    return window.__kResearchOriginalConfirm(message);
  };
  const monitorAlert = function monitorAlert(message) {
    const state = window.__kResearchDialogMonitorState || {};
    if (Date.now() <= (state.until || 0)) {
      recordDialog("alert", message);
      return undefined;
    }
    return window.__kResearchOriginalAlert(message);
  };
  window.__kResearchMonitorConfirm = monitorConfirm;
  window.__kResearchMonitorAlert = monitorAlert;
  window.confirm = monitorConfirm;
  window.alert = monitorAlert;
  window.__kResearchDialogPatchApplied = true;

  const previousState = window.__kResearchDialogMonitorState;
  const previousHistory = (preserveHistory && Array.isArray(previousState?.history))
    ? previousState.history.slice()
    : [];
  window.__kResearchDialogMonitorState = {
    startedAt,
    until,
    confirmBehavior,
    history: previousHistory,
    firstDialog: previousHistory[0] || null,
    lastDialog: previousHistory[previousHistory.length - 1] || null
  };
  console.log(
    "[auto][dialog-monitor] installed startedAt=%s until=%s confirmBehavior=%s preserveHistory=%s patched=%s",
    startedAt,
    until,
    confirmBehavior,
    preserveHistory ? "true" : "false",
    window.__kResearchDialogPatchApplied === true ? "true" : "false"
  );

  return {
    ok: true,
    strategy: "page-patch",
    startedAt,
    until,
    monitorWindowMs,
    confirmBehavior
  };
}

function readDialogMonitorState() {
  const state = window.__kResearchDialogMonitorState;
  if (!state) {
    return {
      ok: false,
      installed: false,
      history: [],
      firstDialog: null,
      lastDialog: null
    };
  }

  return {
    ok: true,
    strategy: "page-patch",
    installed: true,
    active: Date.now() <= (state.until || 0),
    startedAt: state.startedAt || null,
    until: state.until || null,
    history: Array.isArray(state.history) ? state.history.slice() : [],
    firstDialog: state.firstDialog || null,
    lastDialog: state.lastDialog || null
  };
}

async function waitForDialogResultOnTab(tab, timeoutMs = 12000, pollIntervalMs = 250) {
  const startedAt = Date.now();
  let latestState = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      latestState = await readDialogMonitorStateOnTab(tab);
    } catch {
      return {
        ok: false,
        strategy: "page-patch",
        error: "dialog-state-read-failed",
        history: [],
        firstDialog: null,
        lastDialog: null
      };
    }

    if ((latestState?.history?.length || 0) > 0) {
      return latestState;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return latestState || {
    ok: true,
    strategy: "page-patch",
    history: [],
    firstDialog: null,
    lastDialog: null,
    timedOut: true
  };
}

function summarizeDialogResult(dialogState) {
  const history = Array.isArray(dialogState?.history) ? dialogState.history : [];
  const dialog = dialogState?.firstDialog || dialogState?.lastDialog || null;
  if (!dialog) {
    return "Dialog detection: no confirm/alert (manual count decision required).";
  }
  const message = String(dialog.message || "").trim();
  return `Dialog detection: ${dialog.rawType} => ${dialog.kind}${message ? ` / ${message}` : ""}`;
}

function deriveManualDecisionFromDialog(dialogState) {
  const dialog = dialogState?.firstDialog || dialogState?.lastDialog || null;
  const rawType = String(dialog?.rawType || "").trim().toLowerCase();
  if (rawType === "confirm") return MANUAL_DECISION_TOO_MANY;
  if (rawType === "alert") return MANUAL_DECISION_TOO_FEW;
  return "";
}

function normalizeAutoDialogSignal(rawValue) {
  return normalizeDialogKind(rawValue);
}

function normalizeCountSourceLabel(source) {
  const raw = String(source || "").trim().toLowerCase();
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

function applyObservedCountToAutoRunner(observed = {}, {
  fallbackCount = null,
  previousCount = null
} = {}) {
  const resolved = observed && typeof observed === "object" ? observed : {};
  const source = normalizeCountSourceLabel(resolved.countSource);
  const count = Number.isFinite(Number(resolved.count))
    ? Math.max(0, Math.floor(Number(resolved.count)))
    : (Number.isFinite(Number(fallbackCount)) ? Math.max(0, Math.floor(Number(fallbackCount))) : null);
  const classified = classifyResultCount(count);
  const bucket = String(resolved.countBucket || classified.bucket || "unknown");
  const decision = String(resolved.decision || classified.decision || "unreadable");
  const reductionRatio = computeReductionRatio(previousCount, count);
  const signature = buildRepeatReasonSignature({
    decision,
    countBucket: bucket,
    previousBucket: String(state.autoRunner?.lastCountBucket || ""),
    reductionRatio
  });
  const session = getActiveSession();
  const repeatReasonCount = countRecentSignatureRepeats(
    Array.isArray(session?.iterations) ? session.iterations : [],
    signature,
    4
  );
  touchAutoRunner({
    targetCountRange: TARGET_COUNT_RANGE.slice(0, 2),
    softTargetRange: SOFT_TARGET_RANGE.slice(0, 2),
    lastResultCount: count,
    lastCountSource: source,
    lastCountBucket: bucket,
    lastReductionRatio: reductionRatio,
    lastRepeatReasonSignature: signature,
    lastRepeatReasonCount: repeatReasonCount
  });
  return {
    count,
    countSource: source,
    countBucket: bucket,
    decision,
    reductionRatio,
    repeatReasonSignature: signature,
    repeatReasonCount,
    countDistanceScore: computeCountDistanceScore(count, TARGET_COUNT_RANGE, SOFT_TARGET_RANGE)
  };
}

function injectKompassQueryText(text) {
  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function setNativeTextareaValue(element, value) {
    const proto = Object.getPrototypeOf(element);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && typeof desc.set === "function") {
      desc.set.call(element, value);
    } else {
      element.value = value;
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const list = Array.from(document.querySelectorAll('textarea[id*="freeword_textarea"]'));
  const target = list.find(isVisible) || list[0] || null;
  if (!target) {
    return { ok: false, error: "freeword_textarea target not found" };
  }

  setNativeTextareaValue(target, String(text || ""));
  target.focus();
  return { ok: true, targetId: target.id || "" };
}

function injectKompassSearchClick() {
  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function clickElement(element) {
    element.focus?.();
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    element.click();
  }

  const selector = [
    'div[id$="Div01_btnSearch"]',
    'button[id$="Div01_btnSearch"]',
    'input[id$="Div01_btnSearch"]',
    '[id$="Div01_btnSearch"]'
  ].join(", ");

  const list = Array.from(document.querySelectorAll(selector));
  const target = list.find(isVisible) || list[0] || null;
  if (!target) {
    return { ok: false, error: "Div01_btnSearch target not found" };
  }

  clickElement(target);
  return { ok: true, targetId: target.id || "", tagName: target.tagName || "" };
}

function injectKompassInitialScreenClick() {
  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function clickElement(element) {
    element.focus?.();
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    element.click();
  }

  const selector = [
    'button[id$="BtnOpenWorkFrame01"]',
    'input[id$="BtnOpenWorkFrame01"]',
    'div[id$="BtnOpenWorkFrame01"]',
    '[id$="BtnOpenWorkFrame01"]'
  ].join(", ");

  const list = Array.from(document.querySelectorAll(selector));
  const target = list.find(isVisible) || list[0] || null;
  if (!target) {
    return { ok: false, error: "BtnOpenWorkFrame01 target not found" };
  }

  clickElement(target);
  return { ok: true, targetId: target.id || "", tagName: target.tagName || "" };
}

function injectReadSearchResultCount() {
  function readCountFromText(text) {
    const normalized = String(text || "").replace(/,/g, "");
    const match = normalized.match(/(\d+)\s*건\s*\/\s*총/i);
    if (!match?.[1]) return null;
    const n = Number(match[1]);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.floor(n));
  }

  function findClosestContainerFromTextNode(textNode) {
    const parent = textNode?.parentElement || null;
    if (!parent) return null;
    return parent.closest("div,section,article,li,td,th,span,p") || parent;
  }

  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  const candidates = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = String(node?.nodeValue || "").trim();
    if (!text || !text.includes("건 / 총")) continue;
    const container = findClosestContainerFromTextNode(node);
    if (!container) continue;
    const containerText = String(container.textContent || "").trim();
    const count = readCountFromText(containerText);
    if (!Number.isFinite(count)) continue;
    candidates.push({
      count,
      text: containerText.slice(0, 220)
    });
  }

  if (candidates.length > 0) {
    const first = candidates[0];
    return {
      ok: true,
      count: first.count,
      source: "container",
      rawText: first.text
    };
  }

  const pageText = String(document.body?.innerText || document.documentElement?.innerText || "").trim();
  const fallbackCount = readCountFromText(pageText);
  if (Number.isFinite(fallbackCount)) {
    return {
      ok: true,
      count: fallbackCount,
      source: "page"
    };
  }

  return {
    ok: false,
    error: "result-count-unreadable"
  };
}

function aggregateDialogMonitorStates(frameResults = []) {
  const frames = Array.isArray(frameResults) ? frameResults : [];
  const aggregatedHistory = [];
  let installed = false;
  let active = false;
  let startedAt = null;
  let until = null;

  frames.forEach((entry) => {
    const state = entry?.result;
    if (!state || typeof state !== "object") return;
    if (state.installed === true) installed = true;
    if (state.active === true) active = true;
    if (Number.isFinite(Number(state.startedAt))) {
      const value = Number(state.startedAt);
      if (!Number.isFinite(startedAt) || value < startedAt) startedAt = value;
    }
    if (Number.isFinite(Number(state.until))) {
      const value = Number(state.until);
      if (!Number.isFinite(until) || value > until) until = value;
    }
    const history = Array.isArray(state.history) ? state.history : [];
    history.forEach((dialogEntry) => {
      if (!dialogEntry || typeof dialogEntry !== "object") return;
      aggregatedHistory.push({
        ...dialogEntry,
        frameId: Number.isInteger(entry?.frameId) ? entry.frameId : null
      });
    });
  });

  aggregatedHistory.sort((left, right) => {
    const leftTs = Number(left?.timestamp || 0);
    const rightTs = Number(right?.timestamp || 0);
    return leftTs - rightTs;
  });

  return {
    ok: true,
    strategy: "page-patch-all-frames",
    installed,
    active,
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    until: Number.isFinite(until) ? until : null,
    history: aggregatedHistory,
    firstDialog: aggregatedHistory[0] || null,
    lastDialog: aggregatedHistory[aggregatedHistory.length - 1] || null,
    frameCount: frames.length
  };
}

async function readDialogMonitorStateOnTab(tab) {
  const frameResults = await runMainWorldOnTabAllFrames(tab, readDialogMonitorState, []);
  return aggregateDialogMonitorStates(frameResults);
}

function injectKompassClaimBatchClick() {
  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function clickElement(element) {
    element.focus?.();
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    element.click();
  }

  const selector = [
    'div[title="청구항일괄조회"]',
    'button[title="청구항일괄조회"]',
    'input[title="청구항일괄조회"]',
    '[title="청구항일괄조회"]'
  ].join(", ");

  const list = Array.from(document.querySelectorAll(selector));
  const target = list.find(isVisible) || list[0] || null;
  if (!target) {
    return { ok: false, error: "claim-batch-target-not-found" };
  }

  clickElement(target);
  return { ok: true, targetId: target.id || "", tagName: target.tagName || "" };
}

function injectKompassAutoMovePageClick() {
  const TARGET_TITLE_CANON = "페이지를자동으로이동합니다";

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function canonText(value) {
    return String(value || "")
      .replace(/\s+/g, "")
      .replace(/[.,'"`"“”‘’·•\-_=+(){}\[\]<>!?;:]/g, "")
      .trim();
  }

  function hasTargetTitle(el) {
    if (!(el instanceof Element)) return false;
    const titleCanon = canonText(el.getAttribute?.("title") || "");
    const textCanon = canonText(el.textContent || "");
    if (titleCanon && (titleCanon.includes(TARGET_TITLE_CANON) || TARGET_TITLE_CANON.includes(titleCanon))) return true;
    if (textCanon && (textCanon.includes(TARGET_TITLE_CANON) || TARGET_TITLE_CANON.includes(textCanon))) return true;
    return false;
  }

  function getDepth(el) {
    let depth = 0;
    let cursor = el;
    while (cursor?.parentElement) {
      depth += 1;
      cursor = cursor.parentElement;
    }
    return depth;
  }

  function clampPoint(x, y) {
    return {
      x: Math.max(0, Math.min(window.innerWidth - 1, Math.floor(x))),
      y: Math.max(0, Math.min(window.innerHeight - 1, Math.floor(y)))
    };
  }

  function getElementCenterPoint(element) {
    const rect = element.getBoundingClientRect();
    return clampPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  function clickElement(element, point) {
    const resolvedPoint = point && Number.isFinite(point.x) && Number.isFinite(point.y)
      ? clampPoint(point.x, point.y)
      : getElementCenterPoint(element);

    const dispatchPointer = (type) => {
      if (typeof PointerEvent !== "function") return;
      element.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        pointerType: "mouse",
        isPrimary: true,
        clientX: resolvedPoint.x,
        clientY: resolvedPoint.y,
        button: 0,
        buttons: type === "pointerdown" ? 1 : 0
      }));
    };

    const dispatchMouse = (type, buttons = 0) => {
      element.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: resolvedPoint.x,
        clientY: resolvedPoint.y,
        button: 0,
        buttons
      }));
    };

    element.focus?.();
    dispatchMouse("mouseenter");
    dispatchMouse("mouseover");
    dispatchMouse("mousemove");
    dispatchPointer("pointerdown");
    dispatchMouse("mousedown", 1);
    dispatchPointer("pointerup");
    dispatchMouse("mouseup");
    dispatchMouse("click");
    dispatchMouse("dblclick");
    element.click();
    element.dispatchEvent(new Event("change", { bubbles: true, cancelable: true, composed: true }));
  }

  function collectCandidateElements(target) {
    const seen = new Set();
    const out = [];
    const add = (el, point = null, source = "") => {
      if (!(el instanceof Element)) return;
      if (!isVisible(el)) return;
      if (seen.has(el)) return;
      seen.add(el);
      out.push({
        element: el,
        point: point || getElementCenterPoint(el),
        source: source || "candidate"
      });
    };

    // 1) For this control, descendants are often all DIVs. Prefer deepest visible DIV nodes.
    Array.from(target.querySelectorAll("div"))
      .filter(isVisible)
      .sort((left, right) => {
        const depthDiff = getDepth(right) - getDepth(left);
        if (depthDiff !== 0) return depthDiff;
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        const leftArea = leftRect.width * leftRect.height;
        const rightArea = rightRect.width * rightRect.height;
        return leftArea - rightArea;
      })
      .forEach((el) => add(el, null, "desc-div"));

    // 2) Probe hit-test stack at several points and include overlapping DIV layers + ancestor chain.
    const rect = target.getBoundingClientRect();
    const points = [
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.left + 4, rect.top + 4],
      [rect.right - 4, rect.top + 4],
      [rect.left + 4, rect.bottom - 4],
      [rect.right - 4, rect.bottom - 4],
      [rect.left + rect.width / 2, rect.top + 4],
      [rect.left + rect.width / 2, rect.bottom - 4]
    ];

    points.forEach(([xRaw, yRaw]) => {
      const point = clampPoint(xRaw, yRaw);
      const stack = typeof document.elementsFromPoint === "function"
        ? document.elementsFromPoint(point.x, point.y)
        : [document.elementFromPoint(point.x, point.y)].filter(Boolean);

      stack.forEach((el) => {
        if (!el || !(el instanceof Element)) return;
        if (!(el === target || target.contains(el))) return;
        if (String(el.tagName || "").toUpperCase() === "DIV") {
          add(el, point, "hit-div");
        }
        let cursor = el.parentElement;
        while (cursor && (cursor === target || target.contains(cursor))) {
          if (String(cursor.tagName || "").toUpperCase() === "DIV") {
            add(cursor, point, "ancestor-div");
          }
          if (cursor === target) break;
          cursor = cursor.parentElement;
        }
      });
    });

    // 3) Include generic clickable descendants as backup.
    Array.from(target.querySelectorAll("[onclick], [role='button'], [tabindex]:not([tabindex='-1']), button, a[href], input[type='button'], input[type='submit'], span"))
      .filter(isVisible)
      .sort((left, right) => getDepth(right) - getDepth(left))
      .forEach((el) => add(el, null, "interactive-desc"));

    // 4) Fallback to target itself last.
    add(target, null, "target");

    // Limit excessive attempts while preserving depth priority.
    return out.slice(0, 60);
  }

  function sortCandidatesByPriority(candidates = []) {
    return [...candidates].sort((left, right) => {
      const leftEl = left?.element;
      const rightEl = right?.element;
      if (!leftEl || !rightEl) return 0;
      const leftDepth = getDepth(leftEl);
      const rightDepth = getDepth(rightEl);
      if (rightDepth !== leftDepth) return rightDepth - leftDepth;
      const leftIsDiv = String(leftEl.tagName || "").toUpperCase() === "DIV" ? 1 : 0;
      const rightIsDiv = String(rightEl.tagName || "").toUpperCase() === "DIV" ? 1 : 0;
      if (rightIsDiv !== leftIsDiv) return rightIsDiv - leftIsDiv;
      return 0;
    });
  }

  function safeGetAttribute(element, key) {
    try {
      return element?.getAttribute?.(key) || "";
    } catch {
      return "";
    }
  }

  const selector = [
    'div[title="페이지를 자동으로 이동합니다."]',
    'div[title*="페이지를 자동으로 이동"]',
    'button[title="페이지를 자동으로 이동합니다."]',
    'button[title*="페이지를 자동으로 이동"]',
    'input[title="페이지를 자동으로 이동합니다."]',
    'input[title*="페이지를 자동으로 이동"]',
    '[title="페이지를 자동으로 이동합니다."]',
    '[title*="페이지를 자동으로 이동"]'
  ].join(", ");

  const list = Array.from(document.querySelectorAll(selector));
  let target = list.find((el) => isVisible(el) && hasTargetTitle(el))
    || list.find(isVisible)
    || null;
  if (!target) {
    const fallbackList = Array.from(document.querySelectorAll("div,button,input,[title]"))
      .filter((el) => isVisible(el) && hasTargetTitle(el));
    target = fallbackList[0] || null;
  }
  if (!target) {
    return { ok: false, error: "auto-move-target-not-found" };
  }

  const candidates = sortCandidatesByPriority(collectCandidateElements(target));
  const clicked = [];
  // Perform multiple rounds because first click may only reveal nested clickable DIV.
  for (let round = 0; round < 3; round += 1) {
    for (const candidate of candidates) {
      const element = candidate?.element;
      if (!(element instanceof Element)) continue;
      try {
        clickElement(element, candidate?.point || null);
        clicked.push({
          tagName: element.tagName || "",
          id: element.id || "",
          className: String(element.className || "").trim(),
          title: safeGetAttribute(element, "title"),
          source: String(candidate?.source || ""),
          round: round + 1
        });
      } catch {}
    }
  }

  return {
    ok: clicked.length > 0,
    targetId: target.id || "",
    tagName: target.tagName || "",
    title: target.getAttribute("title") || "",
    clickedCount: clicked.length,
    clicked
  };
}

async function waitForSearchResultCountOnTab(tab, timeoutMs = AUTO_COUNT_TIMEOUT_MS, pollIntervalMs = AUTO_POLL_INTERVAL_MS) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await runMainWorldOnTab(tab, injectReadSearchResultCount, []);
      if (result?.ok && Number.isFinite(Number(result?.count))) {
        return {
          ok: true,
          count: Math.max(0, Math.floor(Number(result.count))),
          source: String(result?.source || "").trim()
        };
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return {
    ok: false,
    error: "result-count-timeout"
  };
}

async function importClaimFromStorage(storageKey) {
  const data = await chrome.storage.local.get([storageKey]);
  const text = String(data[storageKey] || "").trim();
  if (!text) {
    throw new Error("저장소에 청구항 텍스트가 없습니다.");
  }
  claimInput.value = text;
  await chrome.storage.local.set({
    [CLAIM_KEY_KQUERY]: text,
    [CLAIM_KEY_KSCAN]: text
  });
  render();
}

function autoSleep(ms = AUTO_POLL_INTERVAL_MS) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(10, Number(ms) || AUTO_POLL_INTERVAL_MS)));
}

async function ensureInitialQueryReady() {
  const sessionBefore = getActiveSession();
  const currentBefore = getCurrentQueryVersion(sessionBefore);
  if (sessionBefore && currentBefore?.queryVersionId) {
    return {
      ok: true,
      session: sessionBefore,
      queryVersion: currentBefore
    };
  }

  const claimText = String(claimInput?.value || "").trim();
  if (!claimText) {
    throw new Error("claim_text_required");
  }

  await handleBuildInitialQuery();
  const session = getActiveSession();
  const queryVersion = getCurrentQueryVersion(session);
  if (!session || !queryVersion?.queryVersionId) {
    throw new Error("initial_query_not_ready");
  }
  return {
    ok: true,
    session,
    queryVersion
  };
}

async function startCaptureStep(options = {}) {
  const session = getActiveSession();
  if (!session) throw new Error("session_not_found");
  if (session.pendingCapture?.runId) {
    return {
      ok: true,
      runId: String(session.pendingCapture.runId || ""),
      reused: true
    };
  }

  const preferredTabId = options?.autoMode === true
    ? Number(state.autoRunner?.searchTabId)
    : null;
  await handleStartCaptureCycle({
    preferredTabId,
    strictPreferredTab: options?.autoMode === true
  });
  const updated = getActiveSession();
  if (!updated?.pendingCapture?.runId) {
    throw new Error("capture_start_failed");
  }
  return {
    ok: true,
    runId: String(updated.pendingCapture.runId || ""),
    reused: false
  };
}

async function clickInitialScreenStep(options = {}) {
  const tab = options?.autoMode === true
    ? await resolveAutoSearchTab({ strict: true })
    : await getActiveHttpTab();
  const result = await runMainWorldOnTab(tab, injectKompassInitialScreenClick, []);
  if (!result?.ok) {
    throw new Error(result?.error || "initial_screen_click_failed");
  }
  return {
    ...result,
    tab
  };
}

function isRetryableQueryApplyErrorMessage(message) {
  const value = String(message || "").trim().toLowerCase();
  if (!value) return false;
  return (
    value.includes("freeword_textarea")
    || value.includes("target not found")
    || value.includes("query_text_apply_failed")
  );
}

async function applyQueryTextStep(options = {}) {
  const session = getActiveSession();
  const current = getCurrentQueryVersion(session);
  const autoMode = options?.autoMode === true || state.autoRunner?.active === true;
  const tab = autoMode
    ? await resolveAutoSearchTab({ strict: true })
    : await getActiveHttpTab();
  const draftExpression = String(queryExpression?.value || "").trim();
  const currentExpression = String(current?.expression || "").trim();
  const expression = autoMode
    ? String(currentExpression || draftExpression).trim()
    : String(draftExpression || currentExpression).trim();
  if (!expression) {
    throw new Error("query_expression_missing");
  }

  const maxAttempts = Math.max(
    1,
    Number.isFinite(Number(options?.maxAttempts))
      ? Number(options.maxAttempts)
      : (autoMode ? QUERY_APPLY_RETRY_MAX_ATTEMPTS_AUTO : QUERY_APPLY_RETRY_MAX_ATTEMPTS_MANUAL)
  );
  const retryDelayMs = Math.max(
    50,
    Number.isFinite(Number(options?.retryDelayMs))
      ? Number(options.retryDelayMs)
      : QUERY_APPLY_RETRY_DELAY_MS
  );
  let lastErrorMessage = "query_text_apply_failed";
  let lastResult = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runMainWorldOnTab(tab, injectKompassQueryText, [expression]);
    lastResult = result;
    if (result?.ok) {
      syncAutoRunnerWithSession();
      touchAutoRunner({
        currentExpression: expression
      });
      return {
        ...result,
        expression
      };
    }

    const errorMessage = String(result?.error || "query_text_apply_failed");
    lastErrorMessage = errorMessage;
    const retryable = isRetryableQueryApplyErrorMessage(errorMessage);
    if (!retryable || attempt >= maxAttempts) {
      break;
    }

    console.log(
      "[auto][apply_query] retry attempt=%s/%s delayMs=%s reason=%s",
      attempt,
      maxAttempts,
      retryDelayMs,
      errorMessage
    );
    await autoSleep(retryDelayMs);
  }

  throw new Error(lastResult?.error || lastErrorMessage || "query_text_apply_failed");
}

async function clickSearchStep({ autoMode = false } = {}) {
  const tab = autoMode
    ? await resolveAutoSearchTab({ strict: true })
    : await getActiveHttpTab();
  let preSearchCount = null;
  try {
    const preProbe = await runMainWorldOnTab(tab, injectReadSearchResultCount, []);
    if (preProbe?.ok && Number.isFinite(Number(preProbe?.count))) {
      preSearchCount = Math.max(0, Math.floor(Number(preProbe.count)));
    }
  } catch {
    preSearchCount = null;
  }
  const monitorInstallFrames = await runMainWorldOnTabAllFrames(tab, installOrRefreshDialogMonitor, [{
    durationMs: getAutoDialogTimeoutMs(),
    confirmBehavior: autoMode ? "cancel" : "confirm"
  }]);
  const monitorInstalled = aggregateDialogMonitorStates(
    (Array.isArray(monitorInstallFrames) ? monitorInstallFrames : []).map((entry) => ({
      ...entry,
      result: {
        ...(entry?.result || {}),
        history: []
      }
    }))
  );
  console.log(
    "[auto][dialog-monitor] installed startedAt=%s until=%s frameCount=%s",
    Number(monitorInstalled?.startedAt || 0) || "",
    Number(monitorInstalled?.until || 0) || "",
    Number(monitorInstalled?.frameCount || 0) || ""
  );
  const result = await runMainWorldOnTab(tab, injectKompassSearchClick, []);
  if (!result?.ok) {
    throw new Error(result?.error || "search_click_failed");
  }
  if (!autoMode) {
    setLoopStatus(
      `KOMPASS search clicked (${result.targetId || result.tagName || "target"}).`,
      "ok"
    );
  }
  return {
    ok: true,
    tab,
    clickResult: result,
    preSearchCount
  };
}

async function waitDialogStep(tab, options = {}) {
  const timeoutMs = getAutoDialogTimeoutMs();
  const pollIntervalMs = 250;
  const startedAt = Date.now();
  const preSearchResultCount = Number.isFinite(Number(options?.preSearchResultCount))
    ? Math.max(0, Math.floor(Number(options.preSearchResultCount)))
    : null;
  let lastDialogState = null;
  let latchedDialogKind = "";
  let lastRearmAt = 0;

  while ((Date.now() - startedAt) < timeoutMs) {
    try {
      lastDialogState = await readDialogMonitorStateOnTab(tab);
    } catch {
      lastDialogState = {
        ok: false,
        strategy: "page-patch-all-frames",
        error: "dialog-state-read-failed",
        history: [],
        firstDialog: null,
        lastDialog: null
      };
    }

    const history = Array.isArray(lastDialogState?.history) ? lastDialogState.history : [];
    if (history.length > 0) {
      const dialogSummary = summarizeDialogResult(lastDialogState);
      const manualDecision = deriveManualDecisionFromDialog(lastDialogState);
      const dialog = lastDialogState?.firstDialog || lastDialogState?.lastDialog || null;
      const rawSignal = dialog?.kind || dialog?.rawType || manualDecision || "";
      const observedCount = resolveBestObservedCount({
        dialogState: lastDialogState,
        pageCountState: null
      });
      const kind = deriveDialogSignalFromMonitorState(lastDialogState, rawSignal)
        || normalizeAutoDialogSignal(manualDecision)
        || "none";
      latchedDialogKind = kind || latchedDialogKind;
      touchAutoRunner({
        lastDialogKind: kind || state.autoRunner?.lastDialogKind || ""
      });
      console.log(
        "[auto][wait_dialog] history=%s first=%s last=%s rawType=%s autoAction=%s latched=%s nextStage=%s",
        history.length,
        String(lastDialogState?.firstDialog?.kind || ""),
        String(lastDialogState?.lastDialog?.kind || ""),
        String(lastDialogState?.lastDialog?.rawType || ""),
        String(lastDialogState?.lastDialog?.autoAction || ""),
        kind || "",
        kind === "many" ? AUTO_STAGE.HANDLE_DIALOG_MANY : (kind === "few" ? AUTO_STAGE.HANDLE_DIALOG_FEW : AUTO_STAGE.WAIT_RESULT_COUNT)
      );
      return {
        ok: true,
        dialogState: lastDialogState,
        dialogSummary,
        kind,
        rawKind: rawSignal || "",
        manualDecision,
        countDetected: false,
        resultCount: null,
        observedCount
      };
    }

    const shouldRearm = history.length <= 0
      && (lastDialogState?.installed !== true || lastDialogState?.active !== true);
    if (shouldRearm && (Date.now() - lastRearmAt) >= 700) {
      lastRearmAt = Date.now();
      try {
        await runMainWorldOnTabAllFrames(tab, installOrRefreshDialogMonitor, [{
          durationMs: timeoutMs,
          confirmBehavior: state.autoRunner?.active === true ? "cancel" : "confirm",
          preserveHistory: true
        }]);
        console.log(
          "[auto][dialog-monitor] rearmed during wait_dialog installed=%s active=%s frameCount=%s",
          String(lastDialogState?.installed === true),
          String(lastDialogState?.active === true),
          Number(lastDialogState?.frameCount || 0) || 0
        );
      } catch (rearmError) {
        console.warn(
          "[auto][dialog-monitor] rearm failed: %s",
          String(rearmError?.message || rearmError || "")
        );
      }
    }

    // Priority rule:
    // 1) If a dialog has already been observed, return dialog signal first.
    // 2) Only when no dialog is observed, short-circuit by readable result count.
    if (state.autoRunner?.active === true) {
      try {
        const countProbe = await runMainWorldOnTab(tab, injectReadSearchResultCount, []);
        if (countProbe?.ok && Number.isFinite(Number(countProbe?.count))) {
          const count = Math.max(0, Math.floor(Number(countProbe.count)));
          const elapsedMs = Date.now() - startedAt;
          const baselineChanged = preSearchResultCount === null || count !== preSearchResultCount;
          const allowCountShortCircuit = baselineChanged || elapsedMs >= AUTO_DIALOG_PRIORITY_WINDOW_MS;
          if (!allowCountShortCircuit) {
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
            continue;
          }
          touchAutoRunner({
            lastDialogKind: "none",
            lastResultCount: count
          });
          console.log(
            "[auto][wait_dialog] count_short_circuit elapsed=%s pre=%s current=%s baselineChanged=%s",
            elapsedMs,
            Number.isFinite(Number(preSearchResultCount)) ? preSearchResultCount : "",
            count,
            baselineChanged ? "true" : "false"
          );
          return {
            ok: true,
            dialogState: lastDialogState,
            dialogSummary: `Dialog detection: no confirm/alert (result count detected: ${count}).`,
            kind: "none",
            rawKind: "",
            manualDecision: "",
            countDetected: true,
            resultCount: count,
            observedCount: resolveBestObservedCount({
              dialogState: lastDialogState,
              pageCountState: { ok: true, count, source: String(countProbe?.source || "page") }
            })
          };
        }
      } catch {
        // ignore and continue waiting within timeout
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  const dialogSummary = summarizeDialogResult(lastDialogState);
  const timeoutKind = latchedDialogKind || "none";
  touchAutoRunner({
    lastDialogKind: timeoutKind
  });
  return {
    ok: true,
    dialogState: lastDialogState || {
      ok: true,
      strategy: "page-patch",
      history: [],
      firstDialog: null,
      lastDialog: null,
      timedOut: true
    },
    dialogSummary,
    kind: timeoutKind,
    rawKind: "",
    manualDecision: "",
    countDetected: false,
    resultCount: null,
    observedCount: resolveBestObservedCount({
      dialogState: lastDialogState || {},
      pageCountState: null
    })
  };
}

async function handleManualDecisionStep(decision, { source = "manual" } = {}) {
  await handleManualCountDecision(decision);
  const session = getActiveSession();
  if (source !== "manual") {
    logAutoAction(`manual_gate_${source} => ${decision}`);
  }
  return {
    ok: true,
    session,
    currentVersion: getCurrentQueryVersion(session)
  };
}

async function readSearchResultCountStep(tab) {
  const result = await waitForSearchResultCountOnTab(tab, getAutoCountTimeoutMs(), AUTO_POLL_INTERVAL_MS);
  if (!result?.ok) {
    throw new Error(result?.error || "result_count_unreadable");
  }
  const count = Math.max(0, Math.floor(Number(result.count || 0)));
  const classified = classifyResultCount(count);
  touchAutoRunner({
    lastResultCount: count,
    lastCountSource: "page_count",
    lastCountBucket: classified.bucket,
    lastReductionRatio: computeReductionRatio(state.autoRunner?.lastResultCount, count),
    lastRepeatReasonSignature: buildRepeatReasonSignature({
      decision: classified.decision,
      countBucket: classified.bucket,
      previousBucket: state.autoRunner?.lastCountBucket || "",
      reductionRatio: computeReductionRatio(state.autoRunner?.lastResultCount, count)
    })
  });
  return {
    ok: true,
    count,
    source: result.source || "",
    countBucket: classified.bucket,
    decision: classified.decision
  };
}

async function markProceedStep() {
  await handleManualCountDecision(MANUAL_DECISION_PROCEED);
  return {
    ok: true
  };
}

async function clickClaimBatchStep(options = {}) {
  const session = getActiveSession();
  const rootTabId = Number(session?.pendingCapture?.tabId);
  const rootTab = Number.isInteger(rootTabId)
    ? await chrome.tabs.get(rootTabId).catch(() => null)
    : null;
  const beforeTabs = await chrome.tabs.query({});
  const beforeTabIds = beforeTabs
    .map((tab) => Number(tab?.id))
    .filter((tabId) => Number.isInteger(tabId));

  const tab = options?.autoMode === true
    ? await resolveAutoSearchTab({ strict: true })
    : await getActiveHttpTab();
  const result = await runMainWorldOnTab(tab, injectKompassClaimBatchClick, []);
  if (!result?.ok) {
    throw new Error(result?.error || "claim_batch_click_failed");
  }

  return {
    ok: true,
    result,
    beforeTabIds,
    rootTabId: Number.isInteger(rootTabId) ? rootTabId : null,
    rootWindowId: Number.isInteger(rootTab?.windowId) ? rootTab.windowId : null
  };
}

async function clickAutoMoveButtonOnDerivedTabsStep({
  beforeTabIds = [],
  rootTabId = null,
  rootWindowId = null,
  timeoutMs = 10000,
  pollIntervalMs = 300
} = {}) {
  const beforeSet = new Set(
    (Array.isArray(beforeTabIds) ? beforeTabIds : [])
      .map((tabId) => Number(tabId))
      .filter((tabId) => Number.isInteger(tabId))
  );
  const collectCandidateTabIds = (tabs = []) => {
    const derived = classifyDerivedTabs({
      tabs,
      beforeTabIds,
      rootTabId,
      rootWindowId
    }).filter((tabId) => Number.isInteger(tabId) && tabId !== rootTabId);
    if (derived.length > 0) return derived;

    // Fallback: include newly opened HTTP(S) tabs that were not present before claim-batch click.
    // Some popup tabs may not have openerTabId/rootWindow linkage immediately.
    const newlyOpened = (Array.isArray(tabs) ? tabs : [])
      .map((tab) => ({
        id: Number(tab?.id),
        url: String(tab?.url || "")
      }))
      .filter((entry) => Number.isInteger(entry.id) && entry.id !== rootTabId)
      .filter((entry) => !beforeSet.has(entry.id))
      .filter((entry) => entry.url.startsWith("http://") || entry.url.startsWith("https://"))
      .map((entry) => entry.id);

    if (newlyOpened.length > 0) return newlyOpened;

    // Final fallback: probe active/root tab too, in case opener linkage is delayed.
    const fallback = [];
    const activeTab = (Array.isArray(tabs) ? tabs : []).find((tab) => tab?.active === true);
    const activeTabId = Number(activeTab?.id);
    if (Number.isInteger(activeTabId)) fallback.push(activeTabId);
    if (Number.isInteger(rootTabId)) fallback.push(rootTabId);
    return Array.from(new Set(fallback));
  };

  const tryClickAutoMoveOnTab = async (tab) => {
    const direct = await runMainWorldOnTab(tab, injectKompassAutoMovePageClick, []);
    if (direct?.ok) {
      return {
        ok: true,
        method: "top-frame",
        result: direct
      };
    }

    const frameResults = await runMainWorldOnTabAllFrames(tab, injectKompassAutoMovePageClick, []);
    const hit = (Array.isArray(frameResults) ? frameResults : []).find((frameEntry) => frameEntry?.result?.ok);
    if (hit?.result?.ok) {
      return {
        ok: true,
        method: "all-frames",
        result: hit.result
      };
    }

    return {
      ok: false,
      error: direct?.error || "auto-move-target-not-found"
    };
  };

  const startedAt = Date.now();
  const clickedTabIds = new Set();
  const clickAttemptByTab = new Map();
  const discoveredDerivedTabIds = new Set();

  while ((Date.now() - startedAt) < timeoutMs) {
    const tabs = await chrome.tabs.query({});
    const derivedTabIds = collectCandidateTabIds(tabs);

    derivedTabIds.forEach((tabId) => discoveredDerivedTabIds.add(tabId));

    for (const tabId of derivedTabIds) {
      const attempts = Number(clickAttemptByTab.get(tabId) || 0);
      if (clickedTabIds.has(tabId) && attempts >= 2) continue;
      if (attempts >= 4) continue;
      const tab = tabs.find((entry) => Number(entry?.id) === tabId) || null;
      if (!tab) continue;
      try {
        clickAttemptByTab.set(tabId, attempts + 1);
        const clickResult = await tryClickAutoMoveOnTab(tab);
        if (clickResult?.ok) {
          clickedTabIds.add(tabId);
          console.log(
            "[auto][claim_batch] auto-move button clicked tabId=%s method=%s target=%s clickedCount=%s attempt=%s",
            tabId,
            clickResult?.method || "-",
            clickResult?.result?.targetId || clickResult?.result?.tagName || "-",
            Number(clickResult?.result?.clickedCount || 0),
            attempts + 1
          );
        }
      } catch (error) {
        console.debug(
          "[auto][claim_batch] auto-move click pending tabId=%s reason=%s",
          tabId,
          error?.message || String(error)
        );
      }
    }

    if (clickedTabIds.size > 0 && clickedTabIds.size >= discoveredDerivedTabIds.size) {
      break;
    }

    await autoSleep(pollIntervalMs);
  }

  return {
    ok: true,
    discoveredTabIds: Array.from(discoveredDerivedTabIds),
    clickedTabIds: Array.from(clickedTabIds),
    clickedCount: clickedTabIds.size
  };
}

async function waitClaimBatchCaptureStableStep() {
  const stableWindowMs = getAutoClaimBatchStableMs();
  const timeoutMs = getAutoClaimBatchTimeoutMs();
  const startedAt = Date.now();
  let previousSignature = "";
  let stableSince = 0;

  while ((Date.now() - startedAt) < timeoutMs) {
    if (isAutoStopRequested()) {
      return {
        ok: false,
        stopped: true,
        error: "auto_stop_requested"
      };
    }

    await refreshCaptureStatusPreview();
    const snapshot = makeCaptureStabilitySnapshot({
      rowsStoredCount: state.captureDiagnostics?.rowsStoredCount || 0,
      evalPending: state.evalProgress?.pending || 0,
      evalRunning: state.evalProgress?.running || 0,
      captureEvalSyncRunning: state.captureEvalSyncRunning === true
    });
    const stability = updateCaptureStabilityWindow({
      previousSignature,
      stableSince,
      snapshot,
      now: Date.now(),
      stableWindowMs
    });
    previousSignature = stability.signature;
    stableSince = stability.stableSince;
    if (stability.stable) {
      return {
        ok: true,
        stable: true
      };
    }
    await autoSleep(AUTO_POLL_INTERVAL_MS);
  }

  return {
    ok: false,
    stable: false,
    timedOut: true,
    error: "claim_batch_capture_timeout"
  };
}

async function closeDerivedTabsStep({ beforeTabIds = [], rootTabId = null, rootWindowId = null } = {}) {
  const allTabs = await chrome.tabs.query({});
  const closeTabIds = classifyDerivedTabs({
    tabs: allTabs,
    beforeTabIds,
    rootTabId,
    rootWindowId
  });
  const safeCloseIds = closeTabIds.filter((tabId) => Number.isInteger(tabId) && tabId !== rootTabId);
  touchAutoRunner({
    claimBatchDerivedTabIds: safeCloseIds
  });

  for (const tabId of safeCloseIds) {
    await chrome.tabs.remove(tabId).catch(() => {});
  }

  return {
    ok: true,
    closedTabIds: safeCloseIds
  };
}

async function finishCycleStep() {
  await handleFinishCycle();
  const session = getActiveSession();
  return {
    ok: true,
    session
  };
}

async function waitForIterationAdvanceStep({
  previousIteration = 0,
  previousQueryVersionId = "",
  timeoutMs = 45000
} = {}) {
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < timeoutMs) {
    if (isAutoStopRequested()) {
      return {
        ok: false,
        stopped: true,
        error: "auto_stop_requested"
      };
    }

    const session = getActiveSession();
    if (!session) {
      return {
        ok: false,
        error: "session_not_found"
      };
    }
    const currentVersion = getCurrentQueryVersion(session);
    const status = String(session.status || "").trim();
    if (status === "success" || status === "max_iterations") {
      return {
        ok: true,
        advanced: true,
        completed: true,
        session
      };
    }
    if (status === "error" || status === "aborted") {
      return {
        ok: false,
        error: `session_${status}`,
        session
      };
    }
    if ((Number(session.iterationCount || 0) > Number(previousIteration || 0))
      || (String(currentVersion?.queryVersionId || "").trim() && String(currentVersion?.queryVersionId || "").trim() !== String(previousQueryVersionId || "").trim())) {
      return {
        ok: true,
        advanced: true,
        completed: false,
        session
      };
    }
    await autoSleep(AUTO_POLL_INTERVAL_MS);
  }
  return {
    ok: false,
    error: "iteration_advance_timeout"
  };
}

async function resolveAutoSearchTab(options = {}) {
  const strict = options?.strict === true;
  const cachedTabId = Number(state.autoRunner?.searchTabId);
  if (Number.isInteger(cachedTabId)) {
    const cached = await resolveTabById(cachedTabId);
    if (cached) {
      return cached;
    }
    if (strict) {
      throw new Error("auto_search_tab_unavailable");
    }
  } else if (strict) {
    throw new Error("auto_search_tab_not_set");
  }
  return getActiveHttpTab();
}

function setAutoStageAndRender(stage, action = "") {
  setAutoStage(stage, action);
  if (action) {
    logAutoAction(action, "running");
  } else {
    render();
  }
}

function handleAutoRunnerError(error, stage = "") {
  const message = String(error?.message || error || "").trim() || "unknown_error";
  touchAutoRunner({
    lastError: message,
    retryCount: Math.max(0, Number(state.autoRunner?.retryCount || 0)) + 1
  });
  const retryCount = Math.max(0, Number(state.autoRunner?.retryCount || 0));
  if (
    (message.includes("result_count_unreadable") || message.includes("result-count"))
    && stage === AUTO_STAGE.WAIT_RESULT_COUNT
  ) {
    console.log(
      "[auto][wait_result_count] timeout_reason=%s stage=%s",
      "result_count_unreadable",
      stage
    );
    setAutoStatus(AUTO_STATUS_PAUSED, "결과 수를 읽지 못해 자동 진행을 멈춤");
    setAutoStage(AUTO_STAGE.PAUSED_MANUAL_REQUIRED, "결과 수를 읽지 못해 자동 진행을 멈춤");
    console.log(
      "[auto][fallback] reason=%s",
      "result_count_unreadable"
    );
    return "paused";
  }
  if (retryCount <= AUTO_MAX_RETRY_PER_STAGE && stage === AUTO_STAGE.CLICK_INITIAL_SCREEN) {
    setAutoStage(AUTO_STAGE.APPLY_QUERY, "초기 화면 클릭 실패 - 검색식 입력 단계로 계속");
    return "recover";
  }
  setAutoStatus(AUTO_STATUS_ERROR, `?ㅻ쪟: ${message}`);
  setAutoStage(AUTO_STAGE.ERROR, `?ㅻ쪟: ${message}`);
  console.log(
    "[auto][fallback] reason=%s",
    message || "unknown_error"
  );
  return "error";
}

async function runAutoLoop() {
  if (state.autoRunner.active !== true) return;
  const autoContext = {
    claimBatchContext: null,
    waitCycleContext: null
  };

  while (state.autoRunner.active === true) {
    if (isAutoStopRequested()) {
      setAutoStatus(AUTO_STATUS_PAUSED, "사용자 요청으로 자동 모드를 정지했습니다.");
      setAutoStage(AUTO_STAGE.PAUSED_MANUAL_REQUIRED, "사용자 요청으로 자동 모드를 정지했습니다.");
      touchAutoRunner({
        active: false
      });
      render();
      break;
    }

    const stage = String(state.autoRunner.stage || AUTO_STAGE.PREPARE);
    try {
      if (stage === AUTO_STAGE.PREPARE) {
        syncAutoRunnerWithSession();
        setAutoStageAndRender(AUTO_STAGE.ENSURE_INITIAL_QUERY, "prepare");
        continue;
      }

      if (stage === AUTO_STAGE.ENSURE_INITIAL_QUERY) {
        await ensureInitialQueryReady();
        syncAutoRunnerWithSession();
        touchAutoRunner({ retryCount: 0 });
        setAutoStageAndRender(AUTO_STAGE.START_CAPTURE, "initial query ready");
        continue;
      }

      if (stage === AUTO_STAGE.START_CAPTURE) {
        const started = await startCaptureStep({ autoMode: true });
        touchAutoRunner({
          currentRunId: String(started?.runId || ""),
          retryCount: 0
        });
        setAutoStageAndRender(AUTO_STAGE.CLICK_INITIAL_SCREEN, "start_capture");
        continue;
      }

      if (stage === AUTO_STAGE.CLICK_INITIAL_SCREEN) {
        await clickInitialScreenStep({ autoMode: true });
        touchAutoRunner({ retryCount: 0 });
        setAutoStageAndRender(AUTO_STAGE.APPLY_QUERY, "click_initial_screen");
        continue;
      }

      if (stage === AUTO_STAGE.APPLY_QUERY) {
        const session = getActiveSession();
        const beforeCurrent = getCurrentQueryVersion(session);
        const preflightTrigger = detectAutoDuplicatePreflight(session, beforeCurrent);
        if (preflightTrigger) {
          logAutoAction(
            `duplicate preflight detected (${preflightTrigger.reason})`,
            "warn"
          );
          const repaired = await runAutoDuplicateRepairRoute({
            session,
            currentVersion: beforeCurrent,
            trigger: preflightTrigger
          });
          if (repaired?.applied) {
            upsertSession(session);
            await persistSessionState();
            logAutoAction(
              `duplicate preflight repaired -> ${repaired?.version?.queryVersionId || "-"}`,
              "running"
            );
          } else {
            logAutoAction(
              `duplicate preflight repair skipped (keep current query)`,
              "warn"
            );
          }
        }

        const applied = await applyQueryTextStep({
          autoMode: true,
          maxAttempts: QUERY_APPLY_RETRY_MAX_ATTEMPTS_AUTO,
          retryDelayMs: QUERY_APPLY_RETRY_DELAY_MS
        });
        touchAutoRunner({
          currentExpression: String(applied?.expression || ""),
          retryCount: 0
        });
        setAutoStageAndRender(AUTO_STAGE.CLICK_SEARCH, "apply_query");
        continue;
      }

      if (stage === AUTO_STAGE.CLICK_SEARCH) {
        const clicked = await clickSearchStep({ autoMode: true });
        touchAutoRunner({
          searchTabId: Number(clicked?.tab?.id) || null,
          preSearchResultCount: Number.isFinite(Number(clicked?.preSearchCount))
            ? Math.max(0, Math.floor(Number(clicked.preSearchCount)))
            : null,
          retryCount: 0
        });
        setAutoStageAndRender(AUTO_STAGE.WAIT_DIALOG, "click_search");
        continue;
      }

      if (stage === AUTO_STAGE.WAIT_DIALOG) {
        const tab = await resolveAutoSearchTab({ strict: true });
        const previousCount = Number.isFinite(Number(state.autoRunner?.lastResultCount))
          ? Math.max(0, Math.floor(Number(state.autoRunner.lastResultCount)))
          : null;
        const dialog = await waitDialogStep(tab, {
          preSearchResultCount: state.autoRunner?.preSearchResultCount
        });
        const dialogHistory = Array.isArray(dialog?.dialogState?.history) ? dialog.dialogState.history : [];
        const firstDialogKind = String(dialog?.dialogState?.firstDialog?.kind || "");
        const lastDialogKind = String(dialog?.dialogState?.lastDialog?.kind || "");
        const lastDialogRawType = String(dialog?.dialogState?.lastDialog?.rawType || "");
        const lastDialogAutoAction = String(dialog?.dialogState?.lastDialog?.autoAction || "");
        const rawDialogSignal = String(
          dialog?.rawKind
          || dialog?.kind
          || dialog?.manualDecision
          || ""
        ).trim();
        const normalizedDialogSignal = normalizeAutoDialogSignal(rawDialogSignal);
        const observed = applyObservedCountToAutoRunner(
          dialog?.observedCount || {},
          {
            fallbackCount: dialog?.resultCount,
            previousCount
          }
        );
        const observedCountText = Number.isFinite(Number(observed?.count))
          ? Number(observed.count)
          : "";
        const observedSourceText = String(observed?.countSource || "unknown");
        const observedBucketText = String(observed?.countBucket || "unknown");
        // Priority:
        // - If dialog signal is present, it wins and transitions immediately.
        // - Count branch is only used when dialog is not observed and count is readable.
        if (dialog.countDetected === true && Number.isFinite(Number(dialog.resultCount))) {
          const resultCount = Math.max(0, Math.floor(Number(dialog.resultCount)));
          const decision = {
            decision: String(observed?.decision || "unreadable"),
            reason: `count_source:${observedSourceText}`
          };
          const countNext = nextAutoStage({
            currentStage: AUTO_STAGE.WAIT_RESULT_COUNT,
            signal: decision.decision,
            stopRequested: isAutoStopRequested(),
            sessionStatus: getActiveSession()?.status || ""
          });
          console.log(
            "[auto][wait_dialog] history=%s first=%s last=%s rawType=%s autoAction=%s raw=%s normalized=%s lastDialogKind=%s lastResultCount=%s decision=%s nextStage=%s",
            dialogHistory.length,
            firstDialogKind,
            lastDialogKind,
            lastDialogRawType,
            lastDialogAutoAction,
            rawDialogSignal || "",
            normalizedDialogSignal || "",
            state.autoRunner?.lastDialogKind || "",
            resultCount,
            decision?.decision || "",
            countNext
          );
          logAutoAction(
            `result_count => ${resultCount} (source=${observedSourceText}, bucket=${observedBucketText})`,
            "running"
          );
          if (countNext === AUTO_STAGE.HANDLE_COUNT_MANY) {
            setAutoStageAndRender(AUTO_STAGE.HANDLE_COUNT_MANY, "count => too_many");
            continue;
          }
          if (countNext === AUTO_STAGE.HANDLE_COUNT_PROCEED) {
            setAutoStageAndRender(AUTO_STAGE.HANDLE_COUNT_PROCEED, "count => proceed");
            continue;
          }
          setAutoStageAndRender(AUTO_STAGE.WAIT_RESULT_COUNT, "count => unreadable");
          continue;
        }

        const next = nextAutoStage({
          currentStage: AUTO_STAGE.WAIT_DIALOG,
          signal: normalizedDialogSignal,
          stopRequested: isAutoStopRequested(),
          sessionStatus: getActiveSession()?.status || ""
        });
        console.log(
          "[auto][wait_dialog] history=%s first=%s last=%s rawType=%s autoAction=%s raw=%s normalized=%s lastDialogKind=%s observedCount=%s source=%s bucket=%s decision=%s nextStage=%s",
          dialogHistory.length,
          firstDialogKind,
          lastDialogKind,
          lastDialogRawType,
          lastDialogAutoAction,
          rawDialogSignal || "",
          normalizedDialogSignal || "",
          state.autoRunner?.lastDialogKind || "",
          observedCountText,
          observedSourceText,
          observedBucketText,
          normalizedDialogSignal || "none",
          next
        );
        touchAutoRunner({
          lastDialogKind: normalizedDialogSignal || state.autoRunner?.lastDialogKind || "none",
          retryCount: 0
        });
        if (next === AUTO_STAGE.HANDLE_DIALOG_MANY) {
          const countLabel = Number.isFinite(Number(observed?.count))
            ? `dialog => too_many (${Number(observed.count).toLocaleString()}건)`
            : "dialog => too_many";
          setAutoStageAndRender(AUTO_STAGE.HANDLE_DIALOG_MANY, countLabel);
          continue;
        }
        if (next === AUTO_STAGE.HANDLE_DIALOG_FEW) {
          const countLabel = Number.isFinite(Number(observed?.count))
            ? `dialog => too_few (${Number(observed.count).toLocaleString()}건)`
            : "dialog => too_few";
          setAutoStageAndRender(AUTO_STAGE.HANDLE_DIALOG_FEW, countLabel);
          continue;
        }
        setAutoStageAndRender(AUTO_STAGE.WAIT_RESULT_COUNT, "dialog => none");
        continue;
      }

      if (stage === AUTO_STAGE.HANDLE_DIALOG_MANY) {
        await handleManualDecisionStep(MANUAL_DECISION_TOO_MANY, { source: "auto_dialog_many" });
        touchAutoRunner({
          loopCount: Math.max(0, Number(state.autoRunner?.loopCount || 0)) + 1,
          retryCount: 0
        });
        setAutoStageAndRender(AUTO_STAGE.PREPARE, "refined by dialog many");
        continue;
      }

      if (stage === AUTO_STAGE.HANDLE_DIALOG_FEW) {
        await handleManualDecisionStep(MANUAL_DECISION_TOO_FEW, { source: "auto_dialog_few" });
        touchAutoRunner({
          loopCount: Math.max(0, Number(state.autoRunner?.loopCount || 0)) + 1,
          retryCount: 0
        });
        setAutoStageAndRender(AUTO_STAGE.PREPARE, "refined by dialog few");
        continue;
      }

      if (stage === AUTO_STAGE.WAIT_RESULT_COUNT) {
        const tab = await resolveAutoSearchTab({ strict: true });
        const countResult = await readSearchResultCountStep(tab);
        const previousCount = Number.isFinite(Number(state.autoRunner?.lastResultCount))
          ? Math.max(0, Math.floor(Number(state.autoRunner.lastResultCount)))
          : null;
        const observed = applyObservedCountToAutoRunner({
          count: countResult.count,
          countSource: "page_count",
          countBucket: countResult.countBucket || classifyResultCount(countResult.count).bucket,
          decision: countResult.decision || classifyResultCount(countResult.count).decision
        }, {
          fallbackCount: countResult.count,
          previousCount
        });
        const decision = {
          decision: String(observed?.decision || "unreadable"),
          reason: `count_source:${String(observed?.countSource || "page_count")}`
        };
        const next = nextAutoStage({
          currentStage: AUTO_STAGE.WAIT_RESULT_COUNT,
          signal: decision.decision,
          stopRequested: isAutoStopRequested(),
          sessionStatus: getActiveSession()?.status || ""
        });
        console.log(
          "[auto][wait_result_count] raw=%s normalized=%s lastDialogKind=%s lastResultCount=%s source=%s bucket=%s decision=%s nextStage=%s",
          "none",
          "none",
          state.autoRunner?.lastDialogKind || "",
          countResult.count,
          String(observed?.countSource || "page_count"),
          String(observed?.countBucket || "unknown"),
          decision?.decision || "",
          next
        );
        logAutoAction(
          `result_count => ${countResult.count} (source=${String(observed?.countSource || "page_count")}, bucket=${String(observed?.countBucket || "unknown")})`,
          "running"
        );
        if (next === AUTO_STAGE.HANDLE_COUNT_MANY) {
          setAutoStageAndRender(AUTO_STAGE.HANDLE_COUNT_MANY, "count => too_many");
          continue;
        }
        if (next === AUTO_STAGE.HANDLE_COUNT_PROCEED) {
          setAutoStageAndRender(AUTO_STAGE.HANDLE_COUNT_PROCEED, "count => proceed");
          continue;
        }
        console.log(
          "[auto][wait_result_count] timeout_reason=%s",
          "unreadable_count_or_unknown_signal"
        );
        throw new Error("result_count_unreadable");
      }

      if (stage === AUTO_STAGE.HANDLE_COUNT_MANY) {
        await handleManualDecisionStep(MANUAL_DECISION_TOO_MANY, { source: "auto_count_many" });
        touchAutoRunner({
          loopCount: Math.max(0, Number(state.autoRunner?.loopCount || 0)) + 1,
          retryCount: 0
        });
        setAutoStageAndRender(AUTO_STAGE.PREPARE, "refined by count many");
        continue;
      }

      if (stage === AUTO_STAGE.HANDLE_COUNT_PROCEED) {
        setAutoStageAndRender(AUTO_STAGE.MARK_PROCEED, "count proceed");
        continue;
      }

      if (stage === AUTO_STAGE.MARK_PROCEED) {
        await markProceedStep();
        touchAutoRunner({ retryCount: 0 });
        setAutoStageAndRender(AUTO_STAGE.CLICK_CLAIM_BATCH, "mark_proceed");
        continue;
      }

      if (stage === AUTO_STAGE.CLICK_CLAIM_BATCH) {
        const clickBatch = await clickClaimBatchStep({ autoMode: true });
        const autoMove = await clickAutoMoveButtonOnDerivedTabsStep({
          beforeTabIds: clickBatch.beforeTabIds || [],
          rootTabId: clickBatch.rootTabId,
          rootWindowId: clickBatch.rootWindowId
        });
        autoContext.claimBatchContext = clickBatch;
        if (Array.isArray(autoMove?.discoveredTabIds) && autoMove.discoveredTabIds.length > 0) {
          logAutoAction(
            `claim_batch derived tabs detected=${autoMove.discoveredTabIds.length}, auto-move clicked=${Number(autoMove?.clickedCount || 0)}`,
            Number(autoMove?.clickedCount || 0) > 0 ? "running" : "warn"
          );
        }
        touchAutoRunner({
          retryCount: 0,
          claimBatchDerivedTabIds: []
        });
        setAutoStageAndRender(AUTO_STAGE.WAIT_CLAIM_BATCH_CAPTURE, "claim_batch clicked");
        continue;
      }

      if (stage === AUTO_STAGE.WAIT_CLAIM_BATCH_CAPTURE) {
        const waited = await waitClaimBatchCaptureStableStep();
        if (!waited?.ok && waited?.timedOut) {
          logAutoAction("claim batch capture wait timeout (continue)", "warn");
        } else if (!waited?.ok && waited?.stopped) {
          setAutoStatus(AUTO_STATUS_PAUSED, "자동 모드 정지 요청");
          setAutoStage(AUTO_STAGE.PAUSED_MANUAL_REQUIRED, "자동 모드 정지 요청");
          touchAutoRunner({ active: false });
          render();
          break;
        }
        touchAutoRunner({ retryCount: 0 });
        setAutoStageAndRender(AUTO_STAGE.CLOSE_CLAIM_BATCH_TABS, "wait_claim_batch_capture");
        continue;
      }

      if (stage === AUTO_STAGE.CLOSE_CLAIM_BATCH_TABS) {
        const context = autoContext.claimBatchContext || {};
        const closed = await closeDerivedTabsStep({
          beforeTabIds: context.beforeTabIds || [],
          rootTabId: context.rootTabId,
          rootWindowId: context.rootWindowId
        });
        logAutoAction(`close_derived_tabs => ${Array.isArray(closed?.closedTabIds) ? closed.closedTabIds.length : 0}`, "running");
        touchAutoRunner({ retryCount: 0 });
        setAutoStageAndRender(AUTO_STAGE.FINISH_CYCLE, "close_claim_batch_tabs");
        continue;
      }

      if (stage === AUTO_STAGE.FINISH_CYCLE) {
        const session = getActiveSession();
        const currentVersion = getCurrentQueryVersion(session);
        autoContext.waitCycleContext = {
          previousIteration: Number(session?.iterationCount || 0),
          previousQueryVersionId: String(currentVersion?.queryVersionId || "").trim()
        };
        await finishCycleStep();
        touchAutoRunner({ retryCount: 0 });
        setAutoStageAndRender(AUTO_STAGE.WAIT_CYCLE_RESULT, "finish_cycle");
        continue;
      }

      if (stage === AUTO_STAGE.WAIT_CYCLE_RESULT) {
        const waitResult = await waitForIterationAdvanceStep({
          previousIteration: autoContext.waitCycleContext?.previousIteration || 0,
          previousQueryVersionId: autoContext.waitCycleContext?.previousQueryVersionId || ""
        });
        if (!waitResult?.ok) {
          throw new Error(waitResult?.error || "wait_cycle_result_failed");
        }
        const session = waitResult.session || getActiveSession();
        const next = nextAutoStage({
          currentStage: AUTO_STAGE.WAIT_CYCLE_RESULT,
          signal: waitResult.advanced ? "advanced" : "",
          stopRequested: isAutoStopRequested(),
          sessionStatus: session?.status || ""
        });
        if (next === AUTO_STAGE.COMPLETED) {
          setAutoStageAndRender(AUTO_STAGE.COMPLETED, "completed");
          continue;
        }
        if (next === AUTO_STAGE.ADVANCE_ITERATION) {
          setAutoStageAndRender(AUTO_STAGE.ADVANCE_ITERATION, "next_iteration");
          continue;
        }
        throw new Error("wait_cycle_transition_failed");
      }

      if (stage === AUTO_STAGE.ADVANCE_ITERATION) {
        touchAutoRunner({
          loopCount: Math.max(0, Number(state.autoRunner?.loopCount || 0)) + 1,
          retryCount: 0
        });
        setAutoStageAndRender(AUTO_STAGE.PREPARE, "advance_iteration");
        continue;
      }

      if (stage === AUTO_STAGE.COMPLETED) {
        setAutoStatus(AUTO_STATUS_DONE, "자동 모드 종료 조건 도달");
        touchAutoRunner({
          active: false,
          stopRequested: false
        });
        render();
        break;
      }

      if (stage === AUTO_STAGE.PAUSED_MANUAL_REQUIRED) {
        setAutoStatus(AUTO_STATUS_PAUSED, state.autoRunner.lastAction || "manual action required");
        touchAutoRunner({
          active: false
        });
        render();
        break;
      }

      if (stage === AUTO_STAGE.ERROR) {
        setAutoStatus(AUTO_STATUS_ERROR, state.autoRunner.lastError || "error");
        touchAutoRunner({
          active: false
        });
        render();
        break;
      }

      setAutoStageAndRender(AUTO_STAGE.ERROR, `unknown_stage:${stage}`);
    } catch (error) {
      const result = handleAutoRunnerError(error, stage);
      render();
      if (result === "recover") {
        continue;
      }
      if (result === "paused") {
        touchAutoRunner({ active: false });
        render();
        break;
      }
      touchAutoRunner({ active: false });
      render();
      break;
    }
  }
}

function isAutoRunnerTerminalError() {
  const status = String(state.autoRunner?.status || "").trim().toLowerCase();
  const stage = String(state.autoRunner?.stage || "").trim().toLowerCase();
  if (state.autoRunner?.stopRequested === true) return false;
  return status === AUTO_STATUS_ERROR || stage === AUTO_STAGE.ERROR;
}

async function runAutoLoopWithStartRecovery({
  maxRetries = AUTO_START_RECOVERY_MAX_RETRIES,
  retryDelayMs = AUTO_START_RECOVERY_DELAY_MS
} = {}) {
  const normalizedMaxRetries = Math.max(0, Math.floor(Number(maxRetries) || 0));
  const normalizedRetryDelayMs = Math.max(100, Math.floor(Number(retryDelayMs) || AUTO_START_RECOVERY_DELAY_MS));
  let attempt = 0;

  while (attempt <= normalizedMaxRetries) {
    touchAutoRunner({
      startRetryCount: attempt
    });

    if (attempt > 0) {
      const session = getActiveSession();
      const retryMessage = `auto start recovery retry ${attempt}/${normalizedMaxRetries}`;
      if (session) {
        pushFeedbackLog(session, `[AUTO] ${retryMessage}`);
      }
      logAutoAction(retryMessage, "warn");
      touchAutoRunner({
        active: true,
        stopRequested: false,
        status: AUTO_STATUS_RUNNING,
        stage: AUTO_STAGE.PREPARE,
        retryCount: 0,
        lastError: ""
      });
      await autoSleep(normalizedRetryDelayMs);
    }

    await runAutoLoop();

    const shouldRetry = isAutoRunnerTerminalError()
      && state.autoRunner?.stopRequested !== true
      && attempt < normalizedMaxRetries;
    if (!shouldRetry) break;
    attempt += 1;
  }

  const exhausted = isAutoRunnerTerminalError()
    && Number(state.autoRunner?.startRetryCount || 0) >= normalizedMaxRetries;
  if (exhausted && normalizedMaxRetries > 0) {
    const exhaustedMessage = `자동 모드 복구 재시도 한도 도달 (${normalizedMaxRetries})`;
    const session = getActiveSession();
    if (session) {
      pushFeedbackLog(session, `[AUTO] ${exhaustedMessage}`);
    }
    touchAutoRunner({
      lastAction: exhaustedMessage
    });
    setLoopStatus(exhaustedMessage, "error");
    render();
  }
}

async function handleStartAutoMode() {
  if (state.autoRunner.active === true) {
    setLoopStatus("자동 모드가 이미 실행 중입니다.", "warn");
    return;
  }
  let anchorTab = null;
  try {
    anchorTab = await getActiveHttpTab();
  } catch (error) {
    setLoopStatus(`자동 모드 시작 실패: ${error?.message || String(error)}`, "error");
    return;
  }
  setActivePane(ACTIVE_PANE_EXECUTE);
  resetAutoRunnerState();
  touchAutoRunner({
    active: true,
    stopRequested: false,
    status: AUTO_STATUS_RUNNING,
    stage: AUTO_STAGE.PREPARE,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    retryCount: 0,
    startRetryCount: 0,
    loopCount: 0,
    lastError: "",
    lastAction: "자동 모드 시작",
    lastDialogKind: "",
    lastResultCount: null,
    claimBatchDerivedTabIds: [],
    searchTabId: Number(anchorTab?.id) || null
  });
  logAutoAction(`start_auto_mode (tab=${Number(anchorTab?.id) || "-"})`);
  render();
  await runAutoLoopWithStartRecovery({
    maxRetries: AUTO_START_RECOVERY_MAX_RETRIES,
    retryDelayMs: AUTO_START_RECOVERY_DELAY_MS
  });
}

async function handleStopAutoMode() {
  if (state.autoRunner.active !== true) {
    setLoopStatus("자동 모드가 실행 중이 아닙니다.", "warn");
    return;
  }
  touchAutoRunner({
    stopRequested: true,
    status: AUTO_STATUS_STOPPING,
    lastAction: "자동 모드 정지 요청"
  });
  const session = getActiveSession();
  if (session) {
    pushFeedbackLog(session, "[AUTO] stopped by user");
  }
  setLoopStatus("자동 모드 정지 요청을 처리 중입니다.", "warn");
  render();
}

function buildSummaryReport(session, summary) {
  const lines = [];
  lines.push(`Session: ${session.sessionId}`);
  lines.push(`Status: ${session.status}`);
  lines.push(`Iterations: ${session.iterationCount}`);
  lines.push(`TopScore: ${summary?.topScore ?? "-"}`);
  lines.push(`Coverage: ${Math.round((summary?.coverage || 0) * 100)}%`);
  lines.push(`SingleHit: ${summary?.singleHit ? "Y" : "N"}`);
  lines.push(`PairHit: ${summary?.pairHit ? "Y" : "N"}`);
  if (summary?.pairDecision) {
    const decision = summary.pairDecision;
    lines.push(`PairPlausibility: ${Math.round((Number(decision.combinePlausibility) || 0) * 100)}%`);
    lines.push(`PairLowConflict: ${decision.lowConflict ? "Y" : "N"}`);
    lines.push(`PairRemainingGaps: ${(Array.isArray(decision.remainingGaps) ? decision.remainingGaps.length : 0)}`);
  }
  return lines.join("\n");
}

function chooseAutoNoChangeFallbackDecisions(summary) {
  const summaryCount = Number(summary?.resultCount);
  const summaryTopScore = Number(summary?.topScore);
  const summaryCoverage = Number(summary?.coverage);
  const countDecision = deriveAutoDecisionFromDialogAndCount({
    dialogKind: "none",
    resultCount: Number.isFinite(summaryCount) ? summaryCount : null,
    threshold: getAutoTooManyThreshold()
  });

  if (countDecision.decision === "too_many") {
    return [MANUAL_DECISION_TOO_MANY, MANUAL_DECISION_TOO_FEW];
  }
  if (countDecision.decision === "unreadable") {
    return [MANUAL_DECISION_TOO_FEW, MANUAL_DECISION_TOO_MANY];
  }

  // count is in acceptable range:
  // if quality is already somewhat high, narrow; otherwise widen first.
  const qualityHigh = (
    (Number.isFinite(summaryTopScore) && summaryTopScore >= 75)
    || (Number.isFinite(summaryCoverage) && summaryCoverage >= 0.85)
  );
  return qualityHigh
    ? [MANUAL_DECISION_TOO_MANY, MANUAL_DECISION_TOO_FEW]
    : [MANUAL_DECISION_TOO_FEW, MANUAL_DECISION_TOO_MANY];
}

function buildIterationCountContext(session, summary) {
  const targetCountRange = TARGET_COUNT_RANGE.slice(0, 2);
  const softTargetRange = SOFT_TARGET_RANGE.slice(0, 2);
  const previousIteration = Array.isArray(session?.iterations) && session.iterations.length > 0
    ? session.iterations[session.iterations.length - 1]
    : null;
  const previousResultCount = Number.isFinite(Number(previousIteration?.currentResultCount))
    ? Math.max(0, Math.floor(Number(previousIteration.currentResultCount)))
    : (
      Number.isFinite(Number(previousIteration?.resultCount))
        ? Math.max(0, Math.floor(Number(previousIteration.resultCount)))
        : null
    );

  const autoObservedCount = Number.isFinite(Number(state.autoRunner?.lastResultCount))
    ? Math.max(0, Math.floor(Number(state.autoRunner.lastResultCount)))
    : null;
  const fallbackSummaryCount = Number.isFinite(Number(summary?.resultCount))
    ? Math.max(0, Math.floor(Number(summary.resultCount)))
    : null;
  const currentResultCount = autoObservedCount !== null ? autoObservedCount : fallbackSummaryCount;

  const classified = classifyResultCount(currentResultCount);
  const countSource = normalizeCountSourceLabel(
    state.autoRunner?.lastCountSource
    || (currentResultCount !== null ? "page_count" : "unknown")
  );
  const countBucket = String(
    state.autoRunner?.lastCountBucket
    || classified.bucket
    || "unknown"
  );
  const reductionRatio = computeReductionRatio(previousResultCount, currentResultCount);
  const repeatReasonSignature = buildRepeatReasonSignature({
    decision: classified.decision,
    countBucket,
    previousBucket: String(previousIteration?.countBucket || ""),
    reductionRatio
  });
  const repeatReasonCount = countRecentSignatureRepeats(
    Array.isArray(session?.iterations) ? session.iterations : [],
    repeatReasonSignature,
    4
  );
  const countDistanceScore = computeCountDistanceScore(
    currentResultCount,
    targetCountRange,
    softTargetRange
  );

  touchAutoRunner({
    targetCountRange,
    softTargetRange,
    lastCountSource: countSource,
    lastCountBucket: countBucket,
    lastReductionRatio: reductionRatio,
    lastRepeatReasonSignature: repeatReasonSignature,
    lastRepeatReasonCount: repeatReasonCount
  });

  return {
    targetCountRange,
    softTargetRange,
    currentResultCount,
    previousResultCount,
    countSource,
    countBucket,
    countDistanceScore,
    reductionRatio,
    repeatReasonSignature,
    repeatReasonCount
  };
}

function mergeLiveEvalResult(liveEval, evalResult) {
  const target = liveEval && typeof liveEval === "object" ? liveEval : ensurePendingCaptureLiveEval({});
  ensureLiveEvalApplicationIndex(target);
  const evaluatedById = target.evaluatedById || {};
  const invalidById = target.invalidById || {};
  const evaluatedByApplicationNo = target.evaluatedByApplicationNo || {};
  const invalidByApplicationNo = target.invalidByApplicationNo || {};
  const evaluations = Array.isArray(evalResult?.evaluations) ? evalResult.evaluations : [];
  const invalidOutputs = Array.isArray(evalResult?.invalidOutputs) ? evalResult.invalidOutputs : [];

  evaluations.forEach((entry) => {
    const resultId = String(entry?.resultId || "").trim();
    if (!resultId) return;
    evaluatedById[resultId] = entry;
    delete invalidById[resultId];
    const applicationNo = normalizeApplicationNoKey(entry?.applicationNo);
    if (applicationNo) {
      evaluatedByApplicationNo[applicationNo] = resultId;
      delete invalidByApplicationNo[applicationNo];
    }
  });
  invalidOutputs.forEach((entry) => {
    const resultId = String(entry?.resultId || "").trim();
    if (!resultId) return;
    invalidById[resultId] = entry;
    delete evaluatedById[resultId];
    const applicationNo = normalizeApplicationNoKey(entry?.applicationNo);
    if (applicationNo && !evaluatedByApplicationNo[applicationNo]) {
      invalidByApplicationNo[applicationNo] = resultId;
    }
  });

  target.evaluatedById = evaluatedById;
  target.invalidById = invalidById;
  target.evaluatedByApplicationNo = evaluatedByApplicationNo;
  target.invalidByApplicationNo = invalidByApplicationNo;
  target.lastSyncedAt = nowIso();
  return target;
}

function buildOrderedEvalResultFromLive(liveEval, rows) {
  const allRows = Array.isArray(rows) ? rows : [];
  const rowIndexById = new Map();
  allRows.forEach((row, index) => {
    rowIndexById.set(getRowResultId(row, index), index);
  });

  const evaluations = Object.values(liveEval?.evaluatedById || {})
    .filter((entry) => rowIndexById.has(String(entry?.resultId || "").trim()))
    .sort((a, b) => {
      const ai = rowIndexById.get(String(a?.resultId || "").trim()) ?? Number.MAX_SAFE_INTEGER;
      const bi = rowIndexById.get(String(b?.resultId || "").trim()) ?? Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });

  const invalidOutputs = Object.values(liveEval?.invalidById || {})
    .filter((entry) => rowIndexById.has(String(entry?.resultId || "").trim()))
    .sort((a, b) => {
      const ai = rowIndexById.get(String(a?.resultId || "").trim()) ?? Number.MAX_SAFE_INTEGER;
      const bi = rowIndexById.get(String(b?.resultId || "").trim()) ?? Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });

  return {
    evaluations,
    invalidOutputs
  };
}

async function handleBuildInitialQuery() {
  const claimText = String(claimInput.value || "").trim();
  if (!claimText) {
    setLoopStatus("청구항을 입력해 주세요.", "warn");
    return;
  }

  setBusy(true);
  setLoopStatus("초기 검색식을 생성하고 있습니다...", "running");

  try {
    const initial = await generateInitialQuery(claimText, {
      querySeedTemperature: getQuerySeedTemperature(),
      settings: state.settings,
      onLog: (message) => setLoopStatus(message, "running")
    });
    const normalizedInitial = applyCrossGroupDedupeToVersion(initial, initial?.features || []);
    await clearStoredLiteratureCache("new_session_claim_change");

    const session = {
      sessionId: makeSessionId(),
      claimText,
      status: "ready",
      iterationCount: 0,
      currentQueryVersionId: normalizedInitial.queryVersionId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      features: initial.features,
      queryVersions: [normalizedInitial],
      iterations: [],
      pendingCapture: null,
      lastSummary: null,
      summaryReport: "",
      feedbackLog: []
    };
    resetEvalProgress(0);
    markQueryDraftPristine(normalizedInitial.expression, normalizedInitial.queryVersionId);

    pushFeedbackLog(session, `Initial query generated (${normalizedInitial.queryVersionId}).`);

    upsertSession(session);
    await persistSessionState();
    await chrome.storage.local.set({
      [CLAIM_KEY_KQUERY]: claimText,
      [CLAIM_KEY_KSCAN]: claimText
    });
    setLoopStatus("초기 검색식 생성이 완료되었습니다.", "ok");
  } catch (error) {
    setLoopStatus(`초기 검색식 생성 실패: ${error?.message || String(error)}`, "error");
  } finally {
    setBusy(false);
    render();
  }
}

async function handleStartCaptureCycle(options = {}) {
  const session = getActiveSession();
  if (!session) {
    setLoopStatus("먼저 초기 검색식을 생성해 주세요.", "warn");
    return;
  }
  if (session.pendingCapture) {
    setLoopStatus("이미 캡처가 진행 중입니다. 현재 사이클을 먼저 마무리해 주세요.", "warn");
    return;
  }

  const currentVersion = getCurrentQueryVersion(session);
  if (!currentVersion?.queryVersionId) {
    setLoopStatus("현재 검색식 버전을 찾을 수 없습니다.", "error");
    return;
  }

  setBusy(true);

  try {
    resetLiveCaptureRuntimeState();
    resetEvalProgress(0);
    const preferredTabId = Number(options?.preferredTabId);
    const strictPreferredTab = options?.strictPreferredTab === true;
    let tab = await resolveTabById(preferredTabId);
    if (!tab && strictPreferredTab && Number.isInteger(preferredTabId)) {
      throw new Error("auto_search_tab_unavailable");
    }
    if (!tab) {
      tab = await getActiveHttpTab();
    }
    const runId = makeRunId();
    const response = await sendRuntimeMessage({
      type: "KRESEARCH_START_CAPTURE",
      tabId: tab.id,
      runId,
      queryVersionId: currentVersion.queryVersionId
    });

    if (!response?.ok) {
      throw new Error(response?.error || "capture start failed");
    }

    session.pendingCapture = {
      tabId: tab.id,
      runId: String(response.runId || runId),
      queryVersionId: currentVersion.queryVersionId,
      startedAt: nowIso(),
      manualDecision: MANUAL_DECISION_PENDING,
      liveEval: {
        evaluatedById: {},
        invalidById: {},
        evaluatedByApplicationNo: {},
        invalidByApplicationNo: {},
        lastFetchedCount: 0,
        lastSyncedAt: ""
      }
    };
    session.status = "capturing";
    session.updatedAt = nowIso();
    pushFeedbackLog(session, `Capture started (run=${session.pendingCapture.runId}, query=${currentVersion.queryVersionId}).`);

    upsertSession(session);
    await persistSessionState();
    ensureCaptureStatusPolling();
    setLoopStatus("캡처를 시작했습니다. KOMPASS에서 검색식 입력 -> 검색 -> 청구항일괄조회를 진행해 주세요.", "running");
  } catch (error) {
    setLoopStatus(`캡처 시작 실패: ${error?.message || String(error)}`, "error");
  } finally {
    setBusy(false);
    render();
  }
}

async function handleManualCountDecision(decision) {
  const session = getActiveSession();
  if (!session?.pendingCapture) {
    setLoopStatus("캡처를 먼저 시작해 주세요.", "warn");
    return;
  }

  if (decision === MANUAL_DECISION_PROCEED) {
    session.pendingCapture.manualDecision = MANUAL_DECISION_PROCEED;
    session.updatedAt = nowIso();
    pushFeedbackLog(session, "Manual gate: proceed (result count acceptable).");
    upsertSession(session);
    await persistSessionState();
    ensureCaptureStatusPolling();
    setLoopStatus("적정 건수로 설정했습니다. KOMPASS에서 청구항일괄조회를 실행하고 '수집 완료 + 평가 실행'을 눌러 주세요.", "ok");
    render();
    return;
  }

  if (decision !== MANUAL_DECISION_TOO_MANY && decision !== MANUAL_DECISION_TOO_FEW) {
    return;
  }

  setLoopStatus(
    decision === MANUAL_DECISION_TOO_MANY
      ? "결과 많음으로 설정했습니다. 검색식을 좁히는 보정을 적용합니다.."
      : "결과 적음으로 설정했습니다. 검색식을 넓히는 보정을 적용합니다..",
    "running"
  );
  setBusy(true);

  try {
    stopCaptureStatusPolling();
    await waitCaptureEvalSync();
    const pending = session.pendingCapture;

    await sendRuntimeMessage({
      type: "KRESEARCH_STOP_CAPTURE",
      tabId: pending.tabId
    }, 15000).catch(() => ({}));

    const currentVersion = getCurrentQueryVersion(session);
    if (!currentVersion) {
      throw new Error("현재 검색식 버전을 찾을 수 없습니다.");
    }

    const repeatCount = getManualGateRepeatCount(session, decision);
    const manualCountContext = buildIterationCountContext(session, session?.lastSummary || {});
    let refined;
    try {
      refined = await manualGateRefineQuery({
        claimText: session.claimText,
        features: session.features,
        currentVersion,
        queryVersions: session.queryVersions,
        iterations: session.iterations,
        feedbackLog: session.feedbackLog,
        decision,
        repeatCount,
        countContext: manualCountContext,
        settings: state.settings,
        onLog: (message) => setLoopStatus(message, "running")
      });
    } catch (llmError) {
      pushFeedbackLog(
        session,
        `Manual gate LLM refine failed, retry with planner-only mode: ${llmError?.message || String(llmError)}`
      );
      refined = await manualGateRefineQuery({
        claimText: session.claimText,
        features: session.features,
        currentVersion,
        queryVersions: session.queryVersions,
        iterations: session.iterations,
        feedbackLog: session.feedbackLog,
        decision,
        repeatCount,
        countContext: manualCountContext,
        skipLlm: true,
        settings: state.settings,
        onLog: (message) => setLoopStatus(message, "running")
      });
    }

    if (refined?.noChange) {
      session.pendingCapture = null;
      resetLiveCaptureRuntimeState();
      session.status = "ready";
      session.updatedAt = nowIso();
      pushFeedbackLog(session, `Manual gate refine skipped (no expression change, mode=${refined.mode || "-"}).`);
      if (refined?.duplicateBlocked) {
        pushFeedbackLog(
          session,
          "이전 검색식과 실질적으로 동일하여 새 버전 생성 대신 자동 재보정을 수행했습니다."
        );
        if (refined?.duplicateOfQueryVersionId) {
          pushFeedbackLog(session, `duplicate_of: ${refined.duplicateOfQueryVersionId}`);
        }
      }
      if (Array.isArray(refined?.feedbackActions) && refined.feedbackActions.length > 0) {
        refined.feedbackActions.forEach((entry) => pushFeedbackLog(session, entry));
      }
    } else {
      const normalizedRefined = applyCrossGroupDedupeToVersion(refined, session.features);
      session.queryVersions = [...(session.queryVersions || []), normalizedRefined];
      session.currentQueryVersionId = normalizedRefined.queryVersionId;
      session.pendingCapture = null;
      resetLiveCaptureRuntimeState();
      session.status = "ready";
      session.updatedAt = nowIso();
      markQueryDraftPristine(normalizedRefined.expression, normalizedRefined.queryVersionId);

      pushFeedbackLog(
        session,
        decision === MANUAL_DECISION_TOO_MANY
          ? `Manual gate: too many results -> narrow query (${normalizedRefined.queryVersionId}, intensity=${Math.min(3, repeatCount)}).`
          : `Manual gate: too few results -> widen query (${normalizedRefined.queryVersionId}, intensity=${Math.min(3, repeatCount)}).`
      );
      if (normalizedRefined?.duplicateBlocked) {
        pushFeedbackLog(
          session,
          `중복 검색식 차단 후 자동 재보정 적용 (duplicate_of=${normalizedRefined.duplicateOfQueryVersionId || "-"})`
        );
      }
      pushPlannerMetaLog(session, normalizedRefined, normalizedRefined.refineMode);
      pushFeatureReasonLogs(session, normalizedRefined, "Feature-level adjustments");
    }

    upsertSession(session);
    await persistSessionState();

    if (decision === MANUAL_DECISION_TOO_MANY) {
      setLoopStatus("검색식 좁히기 보정을 적용했습니다. 검색식 입력 -> 검색을 다시 실행해 결과를 확인해 주세요.", "warn");
    } else {
      setLoopStatus("검색식 넓히기 보정을 적용했습니다. 검색식 입력 -> 검색을 다시 실행해 결과를 확인해 주세요.", "warn");
    }
  } catch (error) {
    setLoopStatus(`수동 게이트 보정 실패: ${error?.message || String(error)}`, "error");
  } finally {
    setBusy(false);
    render();
  }
}

async function handleFinishCycle() {
  const session = getActiveSession();
  if (!session?.pendingCapture) {
    setLoopStatus("캡처를 먼저 시작해 주세요.", "warn");
    return;
  }

  const decision = normalizeManualDecision(session.pendingCapture.manualDecision, true);
  if (decision !== MANUAL_DECISION_PROCEED) {
    setLoopStatus("먼저 결과 건수 판단에서 '적정 건수 (청구항일괄조회 진행)'를 선택해 주세요.", "warn");
    return;
  }

  setBusy(true);
  stopCaptureStatusPolling();
  await waitCaptureEvalSync();
  session.status = "evaluating";
  session.updatedAt = nowIso();
  upsertSession(session);
  await persistSessionState();
  render();

  try {
    const pending = session.pendingCapture;

    const stopResponse = await sendRuntimeMessage({
      type: "KRESEARCH_STOP_CAPTURE",
      tabId: pending.tabId
    }, 20000);
    if (!stopResponse?.ok) {
      throw new Error(stopResponse?.error || "capture stop failed");
    }

    const rowsResponse = await sendRuntimeMessage({
      type: "KRESEARCH_GET_CAPTURED_ROWS",
      runId: pending.runId
    }, 20000);
    if (!rowsResponse?.ok) {
      throw new Error(rowsResponse?.error || "captured rows fetch failed");
    }

    const rows = Array.isArray(rowsResponse.rows) ? rowsResponse.rows : [];
    const currentVersion = getCurrentQueryVersion(session);
    const liveEval = ensurePendingCaptureLiveEval(pending);
    ensureLiveEvalApplicationIndex(liveEval);
    const runId = String(pending.runId || "").trim();
    const inFlight = getInFlightSetByRun(runId);

    setEvalProgressFromCapture(rows, rows.length, pending, runId);
    render();

    const known = collectKnownEvaluationKeys(liveEval, inFlight);
    const selected = filterRowsForEvaluation(rows, known);
    const missingRows = selected.rows;

    if (missingRows.length > 0) {
      setLoopStatus(`미평가 문헌 ${missingRows.length}건을 추가 평가하고 있습니다...`, "running");
      selected.keys.forEach((key) => {
        inFlight.add(key);
      });
      setEvalProgressFromCapture(rows, rows.length, pending, runId);
      render();

      const missingEval = await evaluateCapturedRows({
        claimText: session.claimText,
        features: session.features,
        rows: missingRows,
        queryVersionId: pending.queryVersionId,
        runId: pending.runId,
        alreadyEvaluatedApplicationNos: [
          ...Object.keys(liveEval.evaluatedByApplicationNo || {}),
          ...Object.keys(liveEval.invalidByApplicationNo || {})
        ],
        onLog: (message) => setLoopStatus(message, "running"),
        onProgress: (progressEvent) => {
          applyEvalProgressEvent(progressEvent);
          render();
        },
        settings: state.settings
      });
      mergeLiveEvalResult(liveEval, missingEval);
      selected.keys.forEach((key) => {
        inFlight.delete(key);
      });
      liveEval.lastFetchedCount = rows.length;
      liveEval.lastSyncedAt = nowIso();
      setEvalProgressFromCapture(rows, rows.length, pending, runId);
      render();
    }

    const evalResult = buildOrderedEvalResultFromLive(liveEval, rows);
    clearInFlightByRun(runId);
    setEvalProgressFromCapture(rows, rows.length, pending, runId);
    render();

    const featureStateById = currentVersion?.featureStateById || {};
    const summary = summarizeIteration({
      evaluations: evalResult.evaluations,
      features: session.features,
      featureStateById
    });
    pushFeedbackLog(
      session,
      `평가 완료: 총 ${summary.resultCount}건, 최고점수 ${summary.topScore ?? "-"}, 커버리지 ${Math.round((summary.coverage || 0) * 100)}%`
    );
    const countContext = buildIterationCountContext(session, summary);

    const iterationNo = (session.iterationCount || 0) + 1;
    const iterationRecord = {
      iterationNo,
      queryVersionId: pending.queryVersionId,
      runId: pending.runId,
      queryExpression: currentVersion?.expression || "",
      resultCount: summary.resultCount,
      topScore: summary.topScore,
      singleHit: summary.singleHit,
      pairHit: summary.pairHit,
      coverage: summary.coverage,
      targetCountRange: countContext.targetCountRange,
      softTargetRange: countContext.softTargetRange,
      currentResultCount: countContext.currentResultCount,
      previousResultCount: countContext.previousResultCount,
      countSource: countContext.countSource,
      countBucket: countContext.countBucket,
      countDistanceScore: countContext.countDistanceScore,
      reductionRatio: countContext.reductionRatio,
      repeatReasonSignature: countContext.repeatReasonSignature,
      repeatReasonCount: countContext.repeatReasonCount,
      feedbackActions: [],
      invalidOutputCount: evalResult.invalidOutputs.length,
      createdAt: nowIso()
    };

    session.iterationCount = iterationNo;
    session.lastSummary = summary;
    session.iterations = Array.isArray(session.iterations)
      ? [...session.iterations, iterationRecord]
      : [iterationRecord];
    session.pendingCapture = null;
    resetLiveCaptureRuntimeState();

    const evalHistoryEntry = {
      sessionId: session.sessionId,
      iterationNo,
      runId: pending.runId,
      queryVersionId: pending.queryVersionId,
      evaluations: evalResult.evaluations,
      invalidOutputs: evalResult.invalidOutputs,
      summary,
      createdAt: nowIso()
    };
    await appendEvalHistory(evalHistoryEntry);
    const mergedEvalHistory = [
      evalHistoryEntry,
      ...(Array.isArray(state.evalHistory) ? state.evalHistory : [])
    ];
    const dedupedEvalHistory = [];
    const seenHistoryKeys = new Set();
    mergedEvalHistory.forEach((entry) => {
      const sessionKey = String(entry?.sessionId || "").trim();
      const runKey = String(entry?.runId || "").trim();
      const iterationKey = Number(entry?.iterationNo || 0);
      const queryVersionKey = String(entry?.queryVersionId || "").trim();
      const dedupeKey = `${sessionKey}::${runKey}::${iterationKey}::${queryVersionKey}`;
      if (seenHistoryKeys.has(dedupeKey)) return;
      seenHistoryKeys.add(dedupeKey);
      dedupedEvalHistory.push(entry);
    });
    state.evalHistory = dedupedEvalHistory.slice(0, 120);

    let cleanupReason = "";
    if (summary.singleHit || summary.pairHit) {
      session.status = "success";
      session.summaryReport = buildSummaryReport(session, summary);
      cleanupReason = "session_end_success";
      pushFeedbackLog(
        session,
        summary.singleHit
          ? "Exit condition met: single citation hit (score>=85 + full coverage)."
          : "Exit condition met: pair combination hit (full coverage + low conflict + high combine plausibility)."
      );
      setLoopStatus("종료 조건을 충족했습니다. 필요하면 결과를 검토하고 다음 작업을 진행해 주세요.", "ok");
    } else if (iterationNo >= getMaxIterations()) {
      session.status = "max_iterations";
      session.summaryReport = buildSummaryReport(session, summary);
      cleanupReason = "session_end_max_iterations";
      pushFeedbackLog(session, `Max iterations reached (${getMaxIterations()}).`);
      setLoopStatus("최대 반복 횟수에 도달했습니다. 필요하면 결과를 검토하고 수동 보정을 진행해 주세요.", "warn");
    } else {
      const refined = await autoRefineQuery({
        claimText: session.claimText,
        features: session.features,
        currentVersion,
        evaluations: evalResult.evaluations,
        summary,
        countContext,
        queryVersions: session.queryVersions,
        iterations: session.iterations,
        feedbackLog: session.feedbackLog,
        settings: state.settings,
        onLog: (message) => setLoopStatus(message, "running")
      });

      if (refined?.noChange) {
        const trigger = {
          reason: refined?.duplicateBlocked ? "auto_refine_duplicate_blocked" : "auto_refine_no_change",
          duplicateOfQueryVersionId: String(refined?.duplicateOfQueryVersionId || "").trim(),
          matchType: refined?.duplicateBlocked ? "duplicate_blocked" : "same_expression"
        };
        const repaired = await runAutoDuplicateRepairRoute({
          session,
          currentVersion,
          trigger
        });

        session.status = "ready";
        if (repaired?.applied) {
          iterationRecord.feedbackActions = repaired.feedbackActions || [];
          pushFeedbackLog(
            session,
            `Auto duplicate repair applied after no-change -> ${repaired?.version?.queryVersionId || "-"}`
          );
        } else {
          iterationRecord.feedbackActions = uniqueStrings([
            ...(Array.isArray(refined?.feedbackActions) ? refined.feedbackActions : ["no_change_guard"]),
            ...(Array.isArray(repaired?.feedbackActions) ? repaired.feedbackActions : []),
            "duplicate_repair_exhausted: keep_current_query"
          ]).slice(0, 50);
          pushFeedbackLog(session, `Auto refine skipped (no expression change, mode=${refined.mode || "-"}).`);
          if (refined?.duplicateBlocked) {
            pushFeedbackLog(
              session,
              "이전 검색식과 실질적으로 동일하여 duplicate repair를 시도했지만, 변경 가능한 검색식을 만들지 못해 기존 검색식으로 진행합니다."
            );
            if (refined?.duplicateOfQueryVersionId) {
              pushFeedbackLog(session, `duplicate_of: ${refined.duplicateOfQueryVersionId}`);
            }
          } else {
            pushFeedbackLog(
              session,
              "duplicate repair를 시도했지만 변경 가능한 검색식을 만들지 못해 기존 검색식으로 진행합니다."
            );
          }
          if (Array.isArray(refined?.feedbackActions) && refined.feedbackActions.length > 0) {
            refined.feedbackActions.forEach((entry) => pushFeedbackLog(session, entry));
          }
        }
      } else {
        const normalizedRefined = applyCrossGroupDedupeToVersion(refined, session.features);
        session.queryVersions = [...(session.queryVersions || []), normalizedRefined];
        session.currentQueryVersionId = normalizedRefined.queryVersionId;
        markQueryDraftPristine(normalizedRefined.expression, normalizedRefined.queryVersionId);
        session.status = "ready";

        iterationRecord.feedbackActions = normalizedRefined.feedbackActions;

        pushFeedbackLog(session, `Auto refine applied -> ${normalizedRefined.queryVersionId} (${normalizedRefined.refineMode}).`);
        if (normalizedRefined?.duplicateBlocked) {
          pushFeedbackLog(
            session,
            `중복 검색식 차단 후 자동 재보정 적용 (duplicate_of=${normalizedRefined.duplicateOfQueryVersionId || "-"})`
          );
        }
        pushPlannerMetaLog(session, normalizedRefined, normalizedRefined.refineMode);
        pushFeatureReasonLogs(session, normalizedRefined, "Feature-level adjustments");
      }
      setLoopStatus("자동 보정으로 다음 검색식을 생성했습니다. 새 검색식으로 다음 사이클을 진행해 주세요.", "ok");
    }

    if (evalResult.invalidOutputs.length > 0) {
      const parseCount = evalResult.invalidOutputs.filter((item) => item?.type === "parse_error").length;
      const invalidCount = evalResult.invalidOutputs.filter((item) => item?.type === "invalid_output").length;
      pushFeedbackLog(
        session,
        `Invalid outputs: total=${evalResult.invalidOutputs.length}, parse_error=${parseCount}, invalid_output=${invalidCount}`
      );
    }

    session.updatedAt = nowIso();
    upsertSession(session);
    await persistSessionState();
    if (cleanupReason) {
      await clearStoredLiteratureCache(cleanupReason);
    }
  } catch (error) {
    session.pendingCapture = null;
    resetLiveCaptureRuntimeState();
    session.status = "error";
    session.updatedAt = nowIso();
    pushFeedbackLog(session, `Cycle failed: ${error?.message || String(error)}`);
    upsertSession(session);
    await persistSessionState();
    setLoopStatus(`사이클 처리 실패: ${error?.message || String(error)}`, "error");
  } finally {
    setBusy(false);
    render();
  }
}

async function handleAbortLoop() {
  const session = getActiveSession();
  if (!session) return;

  if (state.autoRunner.active === true) {
    touchAutoRunner({
      active: false,
      stopRequested: true,
      status: AUTO_STATUS_PAUSED,
      stage: AUTO_STAGE.PAUSED_MANUAL_REQUIRED,
      lastAction: "루프 중단으로 자동 모드 종료"
    });
  }

  setBusy(true);
  stopCaptureStatusPolling();

  try {
    await waitCaptureEvalSync();
    if (session.pendingCapture?.tabId) {
      await sendRuntimeMessage({
        type: "KRESEARCH_STOP_CAPTURE",
        tabId: session.pendingCapture.tabId
      }, 12000).catch(() => ({}));
    }

    session.pendingCapture = null;
    resetLiveCaptureRuntimeState();
    session.status = "aborted";
    session.updatedAt = nowIso();
    resetEvalProgress(0);
    pushFeedbackLog(session, "Loop aborted by user.");
    upsertSession(session);
    await persistSessionState();
    await clearStoredLiteratureCache("session_end_aborted");
    setLoopStatus("루프를 중단했습니다.", "warn");
  } finally {
    setBusy(false);
    render();
  }
}

async function handleRollback() {
  const session = getActiveSession();
  if (!session || !Array.isArray(session.queryVersions) || session.queryVersions.length < 2) {
    setLoopStatus("롤백할 이전 버전이 없습니다.", "warn");
    return;
  }

  const currentIndex = session.queryVersions.findIndex((version) => version.queryVersionId === session.currentQueryVersionId);
  const targetIndex = currentIndex > 0 ? currentIndex - 1 : session.queryVersions.length - 2;
  if (targetIndex < 0) {
    setLoopStatus("롤백할 이전 버전이 없습니다.", "warn");
    return;
  }

  const target = session.queryVersions[targetIndex];
  session.currentQueryVersionId = target.queryVersionId;
  session.status = "ready";
  session.updatedAt = nowIso();
  pushFeedbackLog(session, `Rollback applied -> ${target.queryVersionId}`);

  upsertSession(session);
  await persistSessionState();
  markQueryDraftPristine(target.expression || "", target.queryVersionId);
  setLoopStatus("직전 버전으로 롤백했습니다.", "ok");
  render();
}

async function handleSaveManualQueryEdit() {
  const session = getActiveSession();
  if (!session) {
    setLoopStatus("먼저 초기 검색식을 생성해 주세요.", "warn");
    return;
  }
  if (session.pendingCapture) {
    setLoopStatus("캡처가 진행 중일 때는 수동 수정 저장을 할 수 없습니다. 먼저 캡처를 종료해 주세요.", "warn");
    return;
  }

  const current = getCurrentQueryVersion(session);
  if (!current?.queryVersionId) {
    setLoopStatus("현재 검색식 버전을 찾을 수 없습니다.", "error");
    return;
  }

  const editedExpression = String(queryExpression?.value || "").trim();
  if (!editedExpression) {
    setLoopStatus("저장할 검색식이 없습니다.", "warn");
    return;
  }

  const currentExpression = String(current.expression || "").trim();
  if (editedExpression === currentExpression) {
    markQueryDraftPristine(currentExpression, current.queryVersionId);
    setLoopStatus("검색식 변경 사항이 없습니다.", "warn");
    render();
    return;
  }

  const remapped = deriveTermsByFeatureFromExpression({
    expression: editedExpression,
    features: session.features,
    featureStateById: current.featureStateById || {},
    fallbackTermsByFeature: current.termsByFeature || {},
    baseQueryPlan: current.queryPlan || null
  });
  const nextTerms = remapped.termsByFeature;
  const nextFeatureState = cloneDeep(current.featureStateById || {});
  const queryPlan = remapped.queryPlan;
  const unmappedGroups = Array.isArray(remapped?.mapping?.unmappedGroups) ? remapped.mapping.unmappedGroups : [];

  const nextVersion = {
    ...cloneDeep(current),
    queryVersionId: makeQueryVersionId(),
    createdAt: nowIso(),
    source: "manual_user_edit",
    refineMode: "manual_edit",
    notes: "Manual query edit by user",
    expression: editedExpression,
    queryPlan,
    termsByFeature: nextTerms,
    featureStateById: nextFeatureState,
    feedbackActions: ["manual_edit: user updated query expression"],
    queryPlanNeedsRemap: unmappedGroups.length > 0,
    unmappedQueryGroups: unmappedGroups.map((group) => group.group_id),
    historyWeight: MANUAL_USER_EDIT_HISTORY_WEIGHT
  };
  const normalizedNextVersion = applyCrossGroupDedupeToVersion(nextVersion, session.features);
  const duplicateInfo = findDuplicateVersionInSession(session, normalizedNextVersion, current.queryVersionId);
  if (duplicateInfo) {
    pushFeedbackLog(
      session,
      "이전 검색식과 실질적으로 동일하여 새 버전 생성 대신 자동 재보정을 수행했습니다."
    );
    pushFeedbackLog(
      session,
      `manual_edit duplicate blocked: duplicate_of=${duplicateInfo.duplicateOfQueryVersionId || "-"}, reason=${duplicateInfo.reason}`
    );
    upsertSession(session);
    await persistSessionState();
    setLoopStatus("수동 수정 검색식이 기존 버전과 중복되어 저장하지 않습니다.", "warn");
    render();
    return;
  }

  session.queryVersions = [...(session.queryVersions || []), normalizedNextVersion];
  session.currentQueryVersionId = normalizedNextVersion.queryVersionId;
  session.status = "ready";
  session.updatedAt = nowIso();
  pushFeedbackLog(
    session,
    `Manual edit saved -> ${normalizedNextVersion.queryVersionId} (weight=${getVersionHistoryWeight(normalizedNextVersion)}).`
  );
  const removedCount = Array.isArray(normalizedNextVersion?.feedbackBasis?.crossGroupDedupe?.duplicate_terms_removed)
    ? normalizedNextVersion.feedbackBasis.crossGroupDedupe.duplicate_terms_removed.length
    : 0;
  if (removedCount > 0) {
    pushFeedbackLog(session, `cross-group duplicate term removed: ${removedCount}`);
  }
  if (unmappedGroups.length > 0) {
    pushFeedbackLog(
      session,
      `Manual edit remap pending: ${unmappedGroups.length} UNMAPPED group(s) will be remapped before next refine.`
    );
  }

  upsertSession(session);
  await persistSessionState();
  markQueryDraftPristine(normalizedNextVersion.expression, normalizedNextVersion.queryVersionId);
  setLoopStatus("수동 수정 검색식을 새 버전으로 저장했습니다. 다음 보정 시 높은 가중치로 반영됩니다.", "ok");
  render();
}

async function handleCopyQuery() {
  const session = getActiveSession();
  const current = getCurrentQueryVersion(session);
  const expression = String(
    String(queryExpression?.value || "").trim()
    || String(current?.expression || "").trim()
  ).trim();
  if (!expression) return;

  await navigator.clipboard.writeText(expression);
  setLoopStatus("검색식을 클립보드에 복사했습니다.", "ok");
}

async function handleApplyQueryTextToKompass() {
  setBusy(true);
  try {
    const result = await applyQueryTextStep();
    setLoopStatus(`KOMPASS query text applied (${result.targetId || "textarea"}).`, "ok");
  } catch (error) {
    setLoopStatus(`Query text apply failed: ${error?.message || String(error)}`, "error");
  } finally {
    setBusy(false);
    render();
  }
}

async function handleClickKompassSearch() {
  setBusy(true);
  try {
    const clicked = await clickSearchStep({ autoMode: false });
    const dialog = await waitDialogStep(clicked.tab);
    const dialogSummary = dialog.dialogSummary;
    const autoDecision = dialog.manualDecision;
    const activeSession = getActiveSession();

    if (autoDecision && activeSession?.pendingCapture) {
      pushFeedbackLog(
        activeSession,
        autoDecision === MANUAL_DECISION_TOO_MANY
          ? "Auto gate: confirm dialog detected -> too many results."
          : "Auto gate: alert dialog detected -> too few results."
      );
      upsertSession(activeSession);
      await persistSessionState();
      setLoopStatus(
        `KOMPASS search clicked (${clicked.clickResult.targetId || clicked.clickResult.tagName || "target"}). ${dialogSummary} Auto decision applied.`,
        "warn"
      );
      await handleManualDecisionStep(autoDecision, { source: "dialog_manual" });
      return;
    }

    setLoopStatus(
      `KOMPASS search clicked (${clicked.clickResult.targetId || clicked.clickResult.tagName || "target"}). ${dialogSummary}`,
      "ok"
    );
  } catch (error) {
    setLoopStatus(`Search click failed: ${error?.message || String(error)}`, "error");
  } finally {
    setBusy(false);
    render();
  }
}

async function handleClickKompassInitialScreen() {
  setBusy(true);
  try {
    const result = await clickInitialScreenStep();
    setLoopStatus(`KOMPASS initial-screen clicked (${result.targetId || result.tagName || "target"}).`, "ok");
  } catch (error) {
    setLoopStatus(`Initial-screen click failed: ${error?.message || String(error)}`, "error");
  } finally {
    setBusy(false);
    render();
  }
}

async function initialize() {
  const workspace = await loadWorkspace();
  state.sessions = (Array.isArray(workspace.sessions) ? workspace.sessions : []).map((session) => {
    const features = Array.isArray(session?.features) ? session.features : [];
    const queryVersions = (Array.isArray(session?.queryVersions) ? session.queryVersions : [])
      .map((version) => applyCrossGroupDedupeToVersion(version, features));
    const currentCandidate = String(session?.currentQueryVersionId || "").trim();
    const currentExists = queryVersions.some((entry) => String(entry?.queryVersionId || "").trim() === currentCandidate);
    return {
      ...session,
      queryVersions,
      currentQueryVersionId: currentExists
        ? currentCandidate
        : String(queryVersions[queryVersions.length - 1]?.queryVersionId || "").trim()
    };
  });
  state.activeSessionId = String(workspace.activeSessionId || "").trim();
  state.evalHistory = Array.isArray(workspace.evalHistory) ? workspace.evalHistory : [];
  state.settings = normalizeRuntimeSettings(workspace.settings);
  resetAutoRunnerState();

  await persistSettingsState();
  resetEvalProgress(0);

  const active = getActiveSession();
  if (active?.claimText) {
    claimInput.value = active.claimText;
  }

  if (active?.pendingCapture && active?.status === "capturing") {
    ensureCaptureStatusPolling();
  }

  bindAdvancedSectionStateEvents();
  bindModelControlEvents();
  renderPaneVisibility();
  renderAdvancedSectionState();
  render();
}

claimInput?.addEventListener("input", () => {
  const text = String(claimInput.value || "");
  void chrome.storage.local.set({
    [CLAIM_KEY_KQUERY]: text,
    [CLAIM_KEY_KSCAN]: text
  });
  render();
});

queryExpression?.addEventListener("input", () => {
  const session = getActiveSession();
  const current = getCurrentQueryVersion(session);
  state.queryDraftVersionId = String(current?.queryVersionId || state.queryDraftVersionId || "").trim();
  state.queryDraftText = String(queryExpression.value || "");
  state.queryDraftDirty = true;
  if (saveManualQueryBtn) {
    const hasDraft = !!String(state.queryDraftText || "").trim();
    saveManualQueryBtn.disabled = state.busy || !session || !hasDraft;
  }
});

importKQueryClaimBtn?.addEventListener("click", async () => {
  try {
    await importClaimFromStorage(CLAIM_KEY_KQUERY);
    setLoopStatus("K-QUERY 청구항을 가져왔습니다.", "ok");
  } catch (error) {
    setLoopStatus(`청구항 가져오기 실패: ${error?.message || String(error)}`, "error");
  }
});

importKScanClaimBtn?.addEventListener("click", async () => {
  try {
    await importClaimFromStorage(CLAIM_KEY_KSCAN);
    setLoopStatus("K-SCAN 청구항을 가져왔습니다.", "ok");
  } catch (error) {
    setLoopStatus(`청구항 가져오기 실패: ${error?.message || String(error)}`, "error");
  }
});

buildInitialQueryBtn?.addEventListener("click", () => {
  void handleBuildInitialQuery();
});

paneExecuteTab?.addEventListener("click", () => {
  setActivePane(ACTIVE_PANE_EXECUTE);
  closeResultDetailModal();
  closeQueryHistoryModal();
  render();
});

paneResultsTab?.addEventListener("click", () => {
  setActivePane(ACTIVE_PANE_RESULTS);
  render();
});

paneAdvancedTab?.addEventListener("click", () => {
  setActivePane(ACTIVE_PANE_ADVANCED);
  closeResultDetailModal();
  closeQueryHistoryModal();
  render();
});

resultDetailCloseBtn?.addEventListener("click", () => {
  closeResultDetailModal();
});

resultDetailBackdrop?.addEventListener("click", () => {
  closeResultDetailModal();
});

queryHistoryCloseBtn?.addEventListener("click", () => {
  closeQueryHistoryModal();
});

queryHistoryBackdrop?.addEventListener("click", () => {
  closeQueryHistoryModal();
});

execOpenDetailsBtn?.addEventListener("click", () => {
  if (!executeQueryDetails) return;
  executeQueryDetails.open = !executeQueryDetails.open;
});

executeQuerySummary?.addEventListener("click", () => {
  openQueryHistoryModal();
});

executeQuerySummary?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  openQueryHistoryModal();
});

execEditQueryBtn?.addEventListener("click", () => {
  setActivePane(ACTIVE_PANE_ADVANCED);
  if (advSectionQueryEditor) advSectionQueryEditor.open = true;
  renderAdvancedSectionState();
  queryExpression?.focus();
  render();
});

execCopyQueryBtn?.addEventListener("click", () => {
  void handleCopyQuery();
});

execRollbackBtn?.addEventListener("click", () => {
  void handleRollback();
});

openAdvancedFromInterventionBtn?.addEventListener("click", () => {
  setActivePane(ACTIVE_PANE_ADVANCED);
  if (advSectionManualGate) advSectionManualGate.open = true;
  if (advSectionManualLoop) advSectionManualLoop.open = true;
  state.view.advancedSections.manualGate = true;
  state.view.advancedSections.manualLoop = true;
  renderAdvancedSectionState();
  render();
});

startCaptureBtn?.addEventListener("click", () => {
  void handleStartCaptureCycle();
});

manualTooManyBtn?.addEventListener("click", () => {
  void handleManualCountDecision(MANUAL_DECISION_TOO_MANY);
});

manualTooFewBtn?.addEventListener("click", () => {
  void handleManualCountDecision(MANUAL_DECISION_TOO_FEW);
});

manualProceedBtn?.addEventListener("click", () => {
  void handleManualCountDecision(MANUAL_DECISION_PROCEED);
});

manualTooManyBtnAdv?.addEventListener("click", () => {
  void handleManualCountDecision(MANUAL_DECISION_TOO_MANY);
});

manualTooFewBtnAdv?.addEventListener("click", () => {
  void handleManualCountDecision(MANUAL_DECISION_TOO_FEW);
});

manualProceedBtnAdv?.addEventListener("click", () => {
  void handleManualCountDecision(MANUAL_DECISION_PROCEED);
});

finishCycleBtn?.addEventListener("click", () => {
  void handleFinishCycle();
});

abortLoopBtn?.addEventListener("click", () => {
  void handleAbortLoop();
});

abortLoopBtnAdvanced?.addEventListener("click", () => {
  void handleAbortLoop();
});

rollbackQueryBtn?.addEventListener("click", () => {
  void handleRollback();
});

saveManualQueryBtn?.addEventListener("click", () => {
  void handleSaveManualQueryEdit();
});

copyQueryBtn?.addEventListener("click", () => {
  void handleCopyQuery();
});

applyQueryTextBtn?.addEventListener("click", () => {
  void handleApplyQueryTextToKompass();
});

clickSearchBtn?.addEventListener("click", () => {
  void handleClickKompassSearch();
});

clickInitialScreenBtn?.addEventListener("click", () => {
  void handleClickKompassInitialScreen();
});

startAutoModeBtn?.addEventListener("click", () => {
  void handleStartAutoMode();
});

stopAutoModeBtn?.addEventListener("click", () => {
  void handleStopAutoMode();
});

window.addEventListener("resize", () => {
  updatePaneLayoutMetrics();
});

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeResultDetailModal();
  closeQueryHistoryModal();
});

void initialize().catch((error) => {
  stopCaptureStatusPolling();
  setLoopStatus(`초기화 실패: ${error?.message || String(error)}`, "error");
});
