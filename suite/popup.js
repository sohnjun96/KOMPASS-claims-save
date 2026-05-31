import {
  DEFAULT_WEBUI_BASE_URL,
  SETTINGS_FIELDS,
  FIELD_BY_ID,
  MODULES,
  normalizeFieldValue,
  getMissingRequiredFieldIds,
  getModuleMissingFieldIds
} from "./module-registry.js";

const MESSAGE_TYPES = globalThis.KSUITE_MESSAGE_TYPES;
const STORAGE_KEYS = globalThis.KSUITE_STORAGE_KEYS;
const DEFAULT_LLM_MODEL = globalThis.KSUITE_DEFAULT_LLM_MODEL || "gemma-26b-moe";
const NORMALIZE_MODEL_NAME = globalThis.KSUITE_NORMALIZE_MODEL_NAME
  || ((value, fallback = DEFAULT_LLM_MODEL) => String(value || "").trim() || fallback);
const FETCH_AVAILABLE_MODELS = globalThis.KSUITE_FETCH_AVAILABLE_MODELS;
const FALLBACK_SIDEPANEL_HOST_URL =
  globalThis.KSUITE_FALLBACK_SIDEPANEL_HOST_URL || "https://example.com/";
const KLARC_DASHBOARD_PATH = "modules/k-larc/dashboard.html";

if (!MESSAGE_TYPES || !STORAGE_KEYS) {
  throw new Error("K-SUITE shared constants are not initialized.");
}

const settingsForm = document.getElementById("settingsForm");
const settingsToggleBtn = document.getElementById("settingsToggleBtn");
const settingsCloseBtn = document.getElementById("settingsCloseBtn");
const settingsBackdrop = document.getElementById("settingsBackdrop");
const settingsSheet = document.getElementById("settingsSheet");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");
const reloadSettingsBtn = document.getElementById("reloadSettingsBtn");
const settingsStatus = document.getElementById("settingsStatus");

const gateHint = document.getElementById("gateHint");
const moduleGrid = document.getElementById("moduleGrid");
const feedbackToast = document.getElementById("feedbackToast");
const launchStatus = document.getElementById("launchStatus");
const retryLaunchBtn = document.getElementById("retryLaunchBtn");

const state = {
  savedValues: {},
  draftValues: {},
  dirty: false,
  launchInProgress: false,
  lastFailedModuleId: "",
  activeTab: null,
  launchContextByModule: {},
  modelFieldRefs: null,
  modelLookup: {
    mode: "text",
    loading: false,
    options: [],
    message: "",
    tone: "",
    signature: "",
    seq: 0,
    timer: null
  }
};

function getModuleById(moduleId) {
  return MODULES.find((module) => module.id === moduleId) || null;
}

function toErrorMessage(error) {
  return error?.message || String(error);
}

function createLaunchError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function setStatus(target, text, tone = "") {
  target.textContent = text;
  target.className = "status";
  if (tone) target.classList.add(tone);
}

function setGateHint(text, tone = "") {
  gateHint.textContent = text;
  gateHint.className = "gate-hint";
  if (tone) gateHint.classList.add(tone);
}

function setLaunchFeedback({ message = "", tone = "", showRetry = false, moduleId = "" } = {}) {
  if (!message) {
    feedbackToast.className = "feedback-toast hidden";
    launchStatus.textContent = "";
    retryLaunchBtn.classList.add("hidden");
    return;
  }

  feedbackToast.className = "feedback-toast";
  if (tone) feedbackToast.classList.add(tone);
  launchStatus.textContent = message;

  if (showRetry) {
    retryLaunchBtn.classList.remove("hidden");
    state.lastFailedModuleId = moduleId || state.lastFailedModuleId;
  } else {
    retryLaunchBtn.classList.add("hidden");
    state.lastFailedModuleId = moduleId || "";
  }
}

function getDraftBaseUrl() {
  return normalizeFieldValue(
    FIELD_BY_ID.webuiBaseUrl,
    state.draftValues.webuiBaseUrl || DEFAULT_WEBUI_BASE_URL
  ) || DEFAULT_WEBUI_BASE_URL;
}

function getDraftSharedApiKey() {
  return normalizeFieldValue(FIELD_BY_ID.sharedApiKey, state.draftValues.sharedApiKey || "");
}

function getDraftDefaultModel() {
  return NORMALIZE_MODEL_NAME(state.draftValues.defaultModel, DEFAULT_LLM_MODEL);
}

function getModelLookupSignature() {
  return `${getDraftBaseUrl()}::${getDraftSharedApiKey()}`;
}

function openSettingsSheet() {
  settingsSheet.classList.remove("hidden");
}

function closeSettingsSheet() {
  settingsSheet.classList.add("hidden");
}

function getLaunchTypeLabel(launchType) {
  return launchType === "sidepanel" ? "사이드패널" : "전체 화면";
}

function getModuleLaunchDescription(module) {
  return module?.launchType === "sidepanel"
    ? "현재 탭 기준 사이드패널로 열기"
    : "기존 탭으로 이동하거나 새 탭으로 열기";
}

function getModuleLaunchContext(module) {
  const moduleMissing = getModuleMissingFieldIds(module, state.savedValues);
  if (moduleMissing.length > 0) {
    return {
      launchable: false,
      code: "MISSING_SETTINGS",
      reason: "먼저 공통 API Key를 저장해 주세요."
    };
  }

  if (module.launchType !== "sidepanel") {
    return { launchable: true, code: "", reason: "" };
  }

  const activeUrl = String(state.activeTab?.url || "");
  if (!activeUrl) {
    return {
      launchable: false,
      code: "NO_ACTIVE_TAB",
      reason: "활성 탭을 찾을 수 없습니다."
    };
  }

  if (module.id === "k-query" && isBrowserExtensionsSettingsUrl(activeUrl)) {
    return {
      launchable: false,
      code: "KQUERY_BLOCKED_TAB",
      reason: "K-Query는 chrome://extensions 또는 edge://extensions 탭에서 열 수 없습니다."
    };
  }

  if ((module.id === "k-scan" || module.id === "k-research") && isKlarcDashboardUrl(activeUrl)) {
    return {
      launchable: false,
      code: "KSCAN_REQUIRES_KOMPASS",
      reason: "K-SCAN / K-Research는 KOMPASS 탭에서 열어 주세요."
    };
  }

  if (module.id !== "k-query" && !isSidePanelCompatibleTabUrl(activeUrl)) {
    return {
      launchable: false,
      code: "REQUIRES_HTTP_TAB",
      reason: "이 모듈은 http/https 웹 탭에서만 열 수 있습니다."
    };
  }

  return { launchable: true, code: "", reason: "" };
}

function recomputeLaunchContexts() {
  const map = {};
  MODULES.forEach((module) => {
    map[module.id] = getModuleLaunchContext(module);
  });
  state.launchContextByModule = map;
}

async function refreshActiveTabContext() {
  try {
    state.activeTab = await getActiveTab();
  } catch (_error) {
    state.activeTab = null;
  }
  recomputeLaunchContexts();
}

function collectFormValues() {
  const values = {};

  SETTINGS_FIELDS.forEach((field) => {
    if (field.id === "defaultModel") {
      values[field.id] = getDraftDefaultModel();
      return;
    }

    const input = settingsForm.querySelector(`[data-field-id="${field.id}"]`);
    const normalized = normalizeFieldValue(field, input?.value || "");
    values[field.id] = normalized || field.defaultValue || "";
  });

  return values;
}

async function migrateLegacySharedApiKeyIfNeeded() {
  const [
    localData,
    syncData
  ] = await Promise.all([
    chrome.storage.local.get([
      STORAGE_KEYS.SHARED_API_KEY,
      STORAGE_KEYS.LEGACY_WEBUI_API_KEY,
      STORAGE_KEYS.LEGACY_USER_TOKEN
    ]),
    chrome.storage.sync.get([STORAGE_KEYS.LEGACY_SYNC_API_KEY])
  ]);

  const removeLocalKeys = [];
  const removeSyncKeys = [];

  const currentShared = String(localData[STORAGE_KEYS.SHARED_API_KEY] || "").trim();
  if (currentShared) {
    if (localData[STORAGE_KEYS.LEGACY_WEBUI_API_KEY]) {
      removeLocalKeys.push(STORAGE_KEYS.LEGACY_WEBUI_API_KEY);
    }
    if (localData[STORAGE_KEYS.LEGACY_USER_TOKEN]) {
      removeLocalKeys.push(STORAGE_KEYS.LEGACY_USER_TOKEN);
    }
    if (syncData[STORAGE_KEYS.LEGACY_SYNC_API_KEY]) {
      removeSyncKeys.push(STORAGE_KEYS.LEGACY_SYNC_API_KEY);
    }
    if (removeLocalKeys.length > 0) {
      await chrome.storage.local.remove([...new Set(removeLocalKeys)]);
    }
    if (removeSyncKeys.length > 0) {
      await chrome.storage.sync.remove([...new Set(removeSyncKeys)]);
    }
    return currentShared;
  }

  const migratedShared = String(
    localData[STORAGE_KEYS.LEGACY_WEBUI_API_KEY] ||
    localData[STORAGE_KEYS.LEGACY_USER_TOKEN] ||
    syncData[STORAGE_KEYS.LEGACY_SYNC_API_KEY] ||
    ""
  ).trim();
  if (!migratedShared) {
    return "";
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.SHARED_API_KEY]: migratedShared
  });
  await chrome.storage.local.remove([
    STORAGE_KEYS.LEGACY_WEBUI_API_KEY,
    STORAGE_KEYS.LEGACY_USER_TOKEN
  ]);
  await chrome.storage.sync.remove([STORAGE_KEYS.LEGACY_SYNC_API_KEY]);
  return migratedShared;
}

async function loadSavedValues() {
  const migratedShared = await migrateLegacySharedApiKeyIfNeeded();
  const localData = await chrome.storage.local.get([
    "webuiBaseUrl",
    STORAGE_KEYS.SHARED_API_KEY,
    STORAGE_KEYS.DEFAULT_MODEL
  ]);

  const sharedKeyRaw = localData[STORAGE_KEYS.SHARED_API_KEY] || migratedShared || "";

  return {
    webuiBaseUrl:
      normalizeFieldValue(FIELD_BY_ID.webuiBaseUrl, localData.webuiBaseUrl) || DEFAULT_WEBUI_BASE_URL,
    sharedApiKey: normalizeFieldValue(FIELD_BY_ID.sharedApiKey, sharedKeyRaw),
    defaultModel: NORMALIZE_MODEL_NAME(localData[STORAGE_KEYS.DEFAULT_MODEL], DEFAULT_LLM_MODEL)
  };
}

function buildFieldInput(field, value) {
  const input = document.createElement("input");
  input.dataset.fieldId = field.id;
  input.id = `field-${field.id}`;
  input.type = field.type === "password" ? "password" : field.type === "url" ? "url" : "text";
  input.placeholder = field.placeholder || "";
  input.value = value || "";
  input.autocomplete = "off";

  input.addEventListener("input", () => {
    state.draftValues[field.id] = normalizeFieldValue(field, input.value);
    state.dirty = true;
    if (field.id === "webuiBaseUrl" || field.id === "sharedApiKey") {
      scheduleModelOptionsRefresh();
    }
    updateGateUI();
  });

  return input;
}

function injectSelectedModelOption(options, modelName) {
  const selected = NORMALIZE_MODEL_NAME(modelName, DEFAULT_LLM_MODEL);
  if (options.some((option) => option.id === selected)) {
    return options;
  }
  return [
    { id: selected, label: `${selected} (manual)` },
    ...options
  ];
}

function syncModelFieldUi() {
  const refs = state.modelFieldRefs;
  if (!refs) return;

  const {
    textInput,
    selectInput,
    helpStatus,
    refreshButton
  } = refs;
  const modelLookup = state.modelLookup;
  const selectedModel = getDraftDefaultModel();
  const options = injectSelectedModelOption(modelLookup.options, selectedModel);

  textInput.value = selectedModel;
  selectInput.innerHTML = "";
  options.forEach((option) => {
    const element = document.createElement("option");
    element.value = option.id;
    element.textContent = option.label;
    if (option.id === selectedModel) element.selected = true;
    selectInput.appendChild(element);
  });

  const useSelect = modelLookup.mode === "select";
  textInput.classList.toggle("hidden", useSelect);
  selectInput.classList.toggle("hidden", !useSelect);

  const canRefresh = Boolean(getDraftBaseUrl() && getDraftSharedApiKey() && typeof FETCH_AVAILABLE_MODELS === "function");
  refreshButton.disabled = !canRefresh || modelLookup.loading;
  refreshButton.textContent = modelLookup.loading ? "Loading..." : "Reload Models";

  const fallbackMessage = canRefresh
    ? "Model list will be loaded from OpenWebUI /api/models."
    : "Enter Base URL and API key to load the model list.";
  setStatus(
    helpStatus,
    modelLookup.message || fallbackMessage,
    modelLookup.tone || (canRefresh ? "" : "warn")
  );
}

async function refreshModelOptions({ force = false } = {}) {
  if (typeof FETCH_AVAILABLE_MODELS !== "function") {
    state.modelLookup = {
      ...state.modelLookup,
      mode: "text",
      loading: false,
      options: [],
      message: "Model lookup helper is unavailable. Enter the model ID manually.",
      tone: "warn"
    };
    syncModelFieldUi();
    return;
  }

  const baseUrl = getDraftBaseUrl();
  const sharedApiKey = getDraftSharedApiKey();
  const signature = `${baseUrl}::${sharedApiKey}`;

  if (!sharedApiKey) {
    state.modelLookup = {
      ...state.modelLookup,
      mode: "text",
      loading: false,
      options: [],
      message: "Enter the shared API key to load models.",
      tone: "warn",
      signature: ""
    };
    syncModelFieldUi();
    return;
  }

  if (!force && signature === state.modelLookup.signature && state.modelLookup.options.length > 0) {
    syncModelFieldUi();
    return;
  }

  const nextSeq = state.modelLookup.seq + 1;
  state.modelLookup = {
    ...state.modelLookup,
    loading: true,
    message: "Loading model list from /api/models...",
    tone: "",
    seq: nextSeq
  };
  syncModelFieldUi();

  try {
    const options = await FETCH_AVAILABLE_MODELS({
      baseUrl,
      apiKey: sharedApiKey
    });
    if (state.modelLookup.seq !== nextSeq) return;

    const currentModel = getDraftDefaultModel();
    state.draftValues.defaultModel = NORMALIZE_MODEL_NAME(
      currentModel || DEFAULT_LLM_MODEL,
      DEFAULT_LLM_MODEL
    );
    state.modelLookup = {
      ...state.modelLookup,
      mode: "select",
      loading: false,
      options,
      message: `Loaded ${options.length} model(s) from /api/models.`,
      tone: "ok",
      signature
    };
  } catch (error) {
    if (state.modelLookup.seq !== nextSeq) return;
    state.modelLookup = {
      ...state.modelLookup,
      mode: "text",
      loading: false,
      options: [],
      message: `Model list unavailable: ${toErrorMessage(error)}`,
      tone: "warn",
      signature: ""
    };
  }

  syncModelFieldUi();
}

function scheduleModelOptionsRefresh() {
  clearTimeout(state.modelLookup.timer);
  state.modelLookup.timer = setTimeout(() => {
    void refreshModelOptions();
  }, 300);
}

function buildModelField(field, value) {
  const wrapper = document.createElement("div");
  wrapper.className = "field";

  const label = document.createElement("label");
  label.setAttribute("for", `field-${field.id}`);
  label.textContent = field.label;
  wrapper.appendChild(label);

  const controlRow = document.createElement("div");
  controlRow.className = "field-control-row";

  const textInput = document.createElement("input");
  textInput.id = `field-${field.id}`;
  textInput.type = "text";
  textInput.placeholder = field.placeholder || DEFAULT_LLM_MODEL;
  textInput.autocomplete = "off";
  textInput.value = NORMALIZE_MODEL_NAME(value, DEFAULT_LLM_MODEL);
  textInput.addEventListener("input", () => {
    state.draftValues[field.id] = NORMALIZE_MODEL_NAME(textInput.value, DEFAULT_LLM_MODEL);
    state.dirty = true;
    updateGateUI();
  });

  const selectInput = document.createElement("select");
  selectInput.id = `field-${field.id}-select`;
  selectInput.className = "hidden";
  selectInput.addEventListener("change", () => {
    state.draftValues[field.id] = NORMALIZE_MODEL_NAME(selectInput.value, DEFAULT_LLM_MODEL);
    state.dirty = true;
    updateGateUI();
  });

  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "btn ghost";
  refreshButton.textContent = "Reload Models";
  refreshButton.addEventListener("click", () => {
    void refreshModelOptions({ force: true });
  });

  controlRow.appendChild(textInput);
  controlRow.appendChild(selectInput);
  controlRow.appendChild(refreshButton);
  wrapper.appendChild(controlRow);

  if (field.helpText) {
    const help = document.createElement("div");
    help.className = "field-help";
    help.textContent = field.helpText;
    wrapper.appendChild(help);
  }

  const helpStatus = document.createElement("div");
  helpStatus.className = "status";
  wrapper.appendChild(helpStatus);

  state.modelFieldRefs = {
    textInput,
    selectInput,
    helpStatus,
    refreshButton
  };
  syncModelFieldUi();

  return wrapper;
}

function renderSettingsForm() {
  settingsForm.innerHTML = "";
  state.modelFieldRefs = null;

  SETTINGS_FIELDS.forEach((field) => {
    if (field.id === "defaultModel") {
      settingsForm.appendChild(buildModelField(field, state.draftValues[field.id]));
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "field";

    const label = document.createElement("label");
    label.setAttribute("for", `field-${field.id}`);
    label.textContent = field.label;

    const input = buildFieldInput(field, state.draftValues[field.id]);
    wrapper.appendChild(label);
    wrapper.appendChild(input);

    if (field.helpText) {
      const help = document.createElement("div");
      help.className = "field-help";
      help.textContent = field.helpText;
      wrapper.appendChild(help);
    }

    settingsForm.appendChild(wrapper);
  });

  syncModelFieldUi();
}

function renderModuleCards() {
  moduleGrid.innerHTML = "";

  MODULES.forEach((module) => {
    const context = state.launchContextByModule[module.id] || getModuleLaunchContext(module);
    const launchable = context.launchable;
    const isSettingsBlocked = context.code === "MISSING_SETTINGS";
    const reasonText = String(context.reason || "").trim();

    const card = document.createElement("button");
    card.type = "button";
    card.className = `module-card ${launchable ? "ready" : "blocked"}`;
    if (state.launchInProgress) card.classList.add("busy");
    if (!launchable && !isSettingsBlocked) card.classList.add("context-blocked");
    card.disabled = !launchable || state.launchInProgress;
    if (reasonText) {
      card.title = reasonText;
      card.setAttribute("aria-label", `${module.title}: ${reasonText}`);
    }

    const head = document.createElement("div");
    head.className = "module-head";

    const title = document.createElement("span");
    title.className = "module-title";
    title.textContent = module.title;

    const chip = document.createElement("span");
    chip.className = "module-chip";
    chip.textContent = getLaunchTypeLabel(module.launchType);

    head.appendChild(title);
    head.appendChild(chip);

    const desc = document.createElement("p");
    desc.className = "module-desc";
    desc.textContent = module.description;

    const foot = document.createElement("div");
    foot.className = "module-foot";

    const launchType = document.createElement("span");
    launchType.className = "launch-type";
    launchType.textContent = getModuleLaunchDescription(module);

    const cta = document.createElement("span");
    cta.className = "launch-cta";
    cta.textContent = launchable ? "열기" : (isSettingsBlocked ? "설정 필요" : "탭 조건 미충족");

    foot.appendChild(launchType);
    foot.appendChild(cta);

    card.appendChild(head);
    card.appendChild(desc);
    if (!launchable && reasonText && !isSettingsBlocked) {
      const reason = document.createElement("p");
      reason.className = "module-block-reason";
      reason.textContent = reasonText;
      card.appendChild(reason);
    }
    card.appendChild(foot);

    card.addEventListener("click", () => {
      void launchModule(module.id);
    });

    moduleGrid.appendChild(card);
  });
}

function updateGateUI() {
  const missing = getMissingRequiredFieldIds(state.savedValues);

  if (missing.length === 0) {
    setGateHint("모듈 카드를 눌러 실행하세요.");
  } else {
    setGateHint("공통 API Key를 저장하면 모듈을 실행할 수 있습니다.", "warn");
  }

  if (state.dirty) {
    setStatus(settingsStatus, "저장되지 않은 변경 사항이 있습니다.", "warn");
  }

  recomputeLaunchContexts();
  renderModuleCards();
}

async function persistSettings(showSuccessMessage = true) {
  const values = collectFormValues();
  const missing = getMissingRequiredFieldIds(values);

  if (missing.length > 0) {
    const labels = missing.map((fieldId) => FIELD_BY_ID[fieldId]?.label || fieldId);
    setStatus(settingsStatus, `저장 실패: ${labels.join(", ")} 항목은 필수입니다.`, "error");
    return false;
  }

  const baseUrl = values.webuiBaseUrl || DEFAULT_WEBUI_BASE_URL;
  const sharedApiKey = values.sharedApiKey;
  const defaultModel = NORMALIZE_MODEL_NAME(values.defaultModel, DEFAULT_LLM_MODEL);

  try {
    await chrome.storage.local.set({
      webuiBaseUrl: baseUrl,
      [STORAGE_KEYS.SHARED_API_KEY]: sharedApiKey,
      [STORAGE_KEYS.DEFAULT_MODEL]: defaultModel
    });
    await chrome.storage.local.remove([
      STORAGE_KEYS.LEGACY_WEBUI_API_KEY,
      STORAGE_KEYS.LEGACY_USER_TOKEN
    ]);
    await chrome.storage.sync.remove([STORAGE_KEYS.LEGACY_SYNC_API_KEY]);

    state.savedValues = { ...values, webuiBaseUrl: baseUrl, defaultModel };
    state.draftValues = { ...state.savedValues };
    state.dirty = false;

    if (showSuccessMessage) {
      setStatus(settingsStatus, "설정을 저장했습니다.", "ok");
    }

    updateGateUI();
    return true;
  } catch (error) {
    setStatus(settingsStatus, `저장 실패: ${toErrorMessage(error)}`, "error");
    return false;
  }
}

async function reloadFromStorage(showMessage = true) {
  try {
    const loaded = await loadSavedValues();
    state.savedValues = { ...loaded };
    state.draftValues = { ...loaded };
    state.dirty = false;

    renderSettingsForm();
    await refreshModelOptions({ force: true });
    updateGateUI();

    if (showMessage) {
      setStatus(settingsStatus, "저장된 설정을 불러왔습니다.", "ok");
    }
  } catch (error) {
    setStatus(settingsStatus, `불러오기 실패: ${toErrorMessage(error)}`, "error");
  }
}

function isSidePanelCompatibleTabUrl(url) {
  if (typeof url !== "string") return false;
  if (isBrowserExtensionsSettingsUrl(url)) return false;
  return url.startsWith("http://") || url.startsWith("https://");
}

function isBrowserExtensionsSettingsUrl(url) {
  if (typeof url !== "string") return false;
  return url.startsWith("chrome://extensions") || url.startsWith("edge://extensions");
}

function isKlarcDashboardUrl(url) {
  return isSameModuleUrl(url, chrome.runtime.getURL(KLARC_DASHBOARD_PATH));
}

async function getActiveTab() {
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  if (!tabs || tabs.length === 0 || !tabs[0]?.id) {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  }

  return tabs?.[0] || null;
}

async function createFallbackSidePanelTab() {
  const created = await chrome.tabs.create({
    url: FALLBACK_SIDEPANEL_HOST_URL,
    active: true
  });
  if (!Number.isInteger(created?.id)) {
    throw new Error("사이드패널을 열 수 있는 탭이 없습니다.");
  }
  return created.id;
}

async function getActiveTabId(moduleId = "", requireSidePanelCompatible = false) {
  const activeTab = await getActiveTab();
  const tabId = activeTab?.id;
  const activeUrl = String(activeTab?.url || "");

  if (moduleId === "k-query" && isBrowserExtensionsSettingsUrl(activeUrl)) {
    throw createLaunchError(
      "KQUERY_BLOCKED_TAB",
      "K-Query는 chrome://extensions 또는 edge://extensions 탭에서 열 수 없습니다."
    );
  }

  if ((moduleId === "k-scan" || moduleId === "k-research") && isKlarcDashboardUrl(activeUrl)) {
    throw createLaunchError("KSCAN_REQUIRES_KOMPASS", "K-SCAN / K-Research는 KOMPASS 탭에서 열어 주세요.");
  }

  if (Number.isInteger(tabId) && (!requireSidePanelCompatible || isSidePanelCompatibleTabUrl(activeUrl))) {
    return tabId;
  }

  if (requireSidePanelCompatible && Number.isInteger(activeTab?.windowId)) {
    const sameWindowTabs = await chrome.tabs.query({ windowId: activeTab.windowId });
    const candidate = sameWindowTabs.find((tab) =>
      Number.isInteger(tab?.id) && isSidePanelCompatibleTabUrl(tab?.url)
    );
    if (candidate?.id) return candidate.id;

    const allTabs = await chrome.tabs.query({});
    const fallback = allTabs.find((tab) =>
      Number.isInteger(tab?.id) && isSidePanelCompatibleTabUrl(tab?.url)
    );
    if (fallback?.id) return fallback.id;

    return createFallbackSidePanelTab();
  }

  if (!Number.isInteger(tabId)) {
    throw new Error("활성 탭을 찾을 수 없습니다.");
  }

  return tabId;
}

async function openSidePanel(path, moduleId) {
  const requireCompatible = moduleId !== "k-query";
  const tabId = await getActiveTabId(moduleId, requireCompatible);

  await chrome.sidePanel.setOptions({
    tabId,
    path,
    enabled: true
  });

  await chrome.sidePanel.open({ tabId });
}

function isSameModuleUrl(tabUrl, targetUrl) {
  if (typeof tabUrl !== "string") return false;
  return tabUrl === targetUrl || tabUrl.startsWith(`${targetUrl}?`) || tabUrl.startsWith(`${targetUrl}#`);
}

async function openOrFocusModuleTab(path) {
  const targetUrl = chrome.runtime.getURL(path);
  const tabs = await chrome.tabs.query({});

  const existing = tabs.find((tab) => isSameModuleUrl(tab.url, targetUrl));
  if (existing?.id) {
    if (Number.isInteger(existing.windowId)) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    await chrome.tabs.update(existing.id, { active: true });
    return "focused";
  }

  await chrome.tabs.create({ url: targetUrl });
  return "created";
}

async function launchViaServiceWorker(moduleId) {
  const response = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.LAUNCH_MODULE,
    moduleId
  });

  if (!response?.ok) {
    const error = new Error(response?.error || "알 수 없는 실행 오류");
    error.code = response?.code || "LAUNCH_MODULE_FAILED";
    throw error;
  }
}

function formatLaunchError(module, error) {
  const code = error?.code || "";
  if (code === "KSCAN_REQUIRES_KOMPASS") {
    return "K-SCAN / K-Research는 KOMPASS 탭에서 열어 주세요.";
  }
  if (code === "KQUERY_BLOCKED_TAB") {
    return "K-Query는 chrome://extensions 또는 edge://extensions 탭에서 열 수 없습니다.";
  }
  return `${module.title} 실행 실패: ${toErrorMessage(error)}`;
}

async function launchModule(moduleId) {
  const module = getModuleById(moduleId);
  if (!module) {
    setLaunchFeedback({ message: `알 수 없는 모듈입니다: ${moduleId}`, tone: "error" });
    return;
  }

  if (state.launchInProgress) {
    setLaunchFeedback({ message: "다른 모듈을 실행 중입니다. 잠시 후 다시 시도해 주세요.", tone: "warn" });
    return;
  }

  const missing = getModuleMissingFieldIds(module, state.savedValues);
  if (missing.length > 0) {
    setLaunchFeedback({ message: "실행 전에 공통 API Key를 저장해 주세요.", tone: "error" });
    openSettingsSheet();
    return;
  }

  await refreshActiveTabContext();
  const context = state.launchContextByModule[module.id] || getModuleLaunchContext(module);
  if (!context.launchable) {
    const isWarn =
      context.code === "KQUERY_BLOCKED_TAB" ||
      context.code === "KSCAN_REQUIRES_KOMPASS" ||
      context.code === "REQUIRES_HTTP_TAB";
    setLaunchFeedback({
      message: context.reason || "현재 탭에서는 선택한 모듈을 실행할 수 없습니다.",
      tone: isWarn ? "warn" : "error"
    });
    renderModuleCards();
    return;
  }

  state.launchInProgress = true;
  renderModuleCards();
  setLaunchFeedback({ message: `${module.title} 실행 중...`, tone: "loading" });

  try {
    if (module.launchType === "tab") {
      const tabMode = await openOrFocusModuleTab(module.path);
      if (tabMode === "focused") {
        setLaunchFeedback({ message: `${module.title} 기존 탭으로 이동했습니다.`, tone: "ok" });
      } else {
        setLaunchFeedback({ message: `${module.title} 새 탭으로 열었습니다.`, tone: "ok" });
      }
      return;
    }

    if (module.launchType === "sidepanel") {
      try {
        await openSidePanel(module.path, module.id);
      } catch (error) {
        if (error?.code === "KSCAN_REQUIRES_KOMPASS" || error?.code === "KQUERY_BLOCKED_TAB") {
          throw error;
        }
        await launchViaServiceWorker(module.id);
      }
      setLaunchFeedback({ message: `${module.title} 사이드패널을 열었습니다.`, tone: "ok" });
      return;
    }

    throw new Error(`지원하지 않는 실행 방식입니다: ${module.launchType}`);
  } catch (error) {
    const isWarn =
      error?.code === "KSCAN_REQUIRES_KOMPASS" ||
      error?.code === "KQUERY_BLOCKED_TAB";
    setLaunchFeedback({
      message: formatLaunchError(module, error),
      tone: isWarn ? "warn" : "error",
      showRetry: !isWarn,
      moduleId: isWarn ? "" : module.id
    });
  } finally {
    state.launchInProgress = false;
    renderModuleCards();
  }
}

async function initialize() {
  await refreshActiveTabContext();
  await reloadFromStorage(false);

  if (state.savedValues.sharedApiKey) {
    await persistSettings(false);
  }

  const missing = getMissingRequiredFieldIds(state.savedValues);
  if (missing.length > 0) {
    openSettingsSheet();
    setStatus(settingsStatus, "공통 API Key를 저장하면 모든 모듈을 실행할 수 있습니다.", "warn");
  }

  setLaunchFeedback();
}

settingsToggleBtn.addEventListener("click", () => {
  openSettingsSheet();
});

settingsCloseBtn.addEventListener("click", () => {
  closeSettingsSheet();
});

settingsBackdrop.addEventListener("click", () => {
  closeSettingsSheet();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeSettingsSheet();
  }
});

saveSettingsBtn.addEventListener("click", async () => {
  await persistSettings(true);
});

reloadSettingsBtn.addEventListener("click", async () => {
  await reloadFromStorage(true);
});

retryLaunchBtn.addEventListener("click", async () => {
  if (!state.lastFailedModuleId) return;
  await launchModule(state.lastFailedModuleId);
});

window.addEventListener("focus", () => {
  void refreshActiveTabContext().then(() => {
    renderModuleCards();
  });
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  void refreshActiveTabContext().then(() => {
    renderModuleCards();
  });
});

initialize();
