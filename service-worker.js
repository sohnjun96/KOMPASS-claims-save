importScripts(
  "suite/shared-constants.js",
  "modules/k-larc/background.js",
  "modules/k-scan/background.js",
  "modules/k-research/background-capture.js"
);

const DEFAULT_WEBUI_BASE_URL =
  globalThis.KSUITE_DEFAULT_WEBUI_BASE_URL || "https://llm.moip.go.kr";
const FALLBACK_SIDEPANEL_HOST_URL =
  globalThis.KSUITE_FALLBACK_SIDEPANEL_HOST_URL || "https://example.com/";
const MESSAGE_TYPES = globalThis.KSUITE_MESSAGE_TYPES;
const STORAGE_KEYS = globalThis.KSUITE_STORAGE_KEYS;
const MODULES = Array.isArray(globalThis.KSUITE_MODULES) ? globalThis.KSUITE_MODULES : [];
const BUILD_MODULE_LAUNCHERS = globalThis.KSUITE_BUILD_MODULE_LAUNCHERS;
const KLARC_DASHBOARD_PATH = "modules/k-larc/dashboard.html";

if (!MESSAGE_TYPES || !STORAGE_KEYS || MODULES.length === 0 || typeof BUILD_MODULE_LAUNCHERS !== "function") {
  throw new Error("K-SUITE shared constants are not initialized.");
}

const MODULE_LAUNCHERS = BUILD_MODULE_LAUNCHERS(MODULES);

function createLaunchError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isBrowserExtensionsSettingsUrl(url) {
  if (typeof url !== "string") return false;
  return url.startsWith("chrome://extensions") || url.startsWith("edge://extensions");
}

function isSidePanelCompatibleTabUrl(url, moduleId = "") {
  if (typeof url !== "string") return false;

  if (moduleId === "k-query") {
    return !isBrowserExtensionsSettingsUrl(url);
  }

  return url.startsWith("http://") || url.startsWith("https://");
}

async function createFallbackSidePanelTab() {
  const created = await chrome.tabs.create({
    url: FALLBACK_SIDEPANEL_HOST_URL,
    active: true
  });
  if (Number.isInteger(created?.id)) {
    return created.id;
  }
  throw createLaunchError("NO_TAB", "No tab found to open side panel.");
}

function isKlarcDashboardUrl(url) {
  const targetUrl = chrome.runtime.getURL(KLARC_DASHBOARD_PATH);
  return isSameModuleUrl(url, targetUrl);
}

function assertSidePanelLaunchContext(tab, moduleId) {
  const tabUrl = String(tab?.url || "");
  if (moduleId === "k-query" && isBrowserExtensionsSettingsUrl(tabUrl)) {
    throw createLaunchError(
      "KQUERY_BLOCKED_TAB",
      "K-Query cannot be opened on chrome://extensions settings tabs."
    );
  }
  if ((moduleId === "k-scan" || moduleId === "k-research") && isKlarcDashboardUrl(tabUrl)) {
    throw createLaunchError(
      "KSCAN_REQUIRES_KOMPASS",
      "K-SCAN / K-Research must be opened on a KOMPASS tab."
    );
  }
}

async function pickSidePanelTabId(fallbackTabId, moduleId = "") {
  const visited = new Set();

  const tryTabId = async (tabId) => {
    if (!Number.isInteger(tabId) || visited.has(tabId)) return null;
    visited.add(tabId);

    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab?.id) return null;
      assertSidePanelLaunchContext(tab, moduleId);
      if (isSidePanelCompatibleTabUrl(tab.url, moduleId)) {
        return tab.id;
      }
    } catch (error) {
      if (error?.code === "KQUERY_BLOCKED_TAB" || error?.code === "KSCAN_REQUIRES_KOMPASS") {
        throw error;
      }
      return null;
    }
    return null;
  };

  const fallback = await tryTabId(fallbackTabId);
  if (fallback) return fallback;

  let tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });

  if (!tabs || tabs.length === 0 || !tabs[0]?.id) {
    tabs = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });
  }

  const activeTab = tabs?.[0];
  if (activeTab) {
    assertSidePanelLaunchContext(activeTab, moduleId);
  }

  const activePreferred = await tryTabId(activeTab?.id);
  if (activePreferred) return activePreferred;

  const activeWindowId = activeTab?.windowId;
  if (Number.isInteger(activeWindowId)) {
    const sameWindowTabs = await chrome.tabs.query({ windowId: activeWindowId });
    const preferred = sameWindowTabs.find((tab) =>
      Number.isInteger(tab?.id) && isSidePanelCompatibleTabUrl(tab?.url, moduleId)
    );
    if (preferred?.id) return preferred.id;
  }

  const allTabs = await chrome.tabs.query({});
  const fallbackPreferred = allTabs.find((tab) =>
    Number.isInteger(tab?.id) && isSidePanelCompatibleTabUrl(tab?.url, moduleId)
  );
  if (fallbackPreferred?.id) return fallbackPreferred.id;

  return createFallbackSidePanelTab();
}

async function openModuleInSidePanel(path, fallbackTabId, moduleId = "") {
  const tabId = await pickSidePanelTabId(fallbackTabId, moduleId);

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
      try {
        await chrome.windows.update(existing.windowId, { focused: true });
      } catch (error) {
        console.warn("Failed to focus existing module window:", error);
      }
    }
    await chrome.tabs.update(existing.id, { active: true });
    return;
  }

  await chrome.tabs.create({ url: targetUrl });
}

async function launchModule(moduleId, fallbackTabId) {
  const launcher = MODULE_LAUNCHERS[moduleId];
  if (!launcher) {
    throw createLaunchError("NO_MODULE", `Unsupported module: ${moduleId}`);
  }

  if (launcher.type === "tab") {
    await openOrFocusModuleTab(launcher.path);
    return;
  }

  if (launcher.type === "sidepanel") {
    await openModuleInSidePanel(launcher.path, fallbackTabId, moduleId);
    return;
  }

  throw createLaunchError("UNSUPPORTED_LAUNCH_TYPE", `Unsupported launch type: ${launcher.type}`);
}

async function handleScanCaptureControl(message) {
  const type = String(message?.type || "");
  const tabId = message?.tabId;
  if (!Number.isInteger(tabId)) {
    throw createLaunchError("INVALID_TAB_ID", "Invalid tab ID.");
  }

  if (type === "START_CAPTURE") {
    if (typeof attachDebugger !== "function") {
      throw createLaunchError("KSCAN_HANDLER_MISSING", "K-SCAN capture handler is missing.");
    }
    await attachDebugger(tabId, { rootTabId: tabId });
    return;
  }

  if (type === "STOP_CAPTURE") {
    if (typeof detachCaptureScope === "function") {
      await detachCaptureScope(tabId);
      return;
    }
    if (typeof detachDebugger !== "function") {
      throw createLaunchError("KSCAN_HANDLER_MISSING", "K-SCAN stop handler is missing.");
    }
    await detachDebugger(tabId);
    return;
  }

  throw createLaunchError("UNSUPPORTED_CAPTURE_TYPE", `Unsupported capture message: ${type}`);
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
  } else {
    const migratedShared = String(
      localData[STORAGE_KEYS.LEGACY_WEBUI_API_KEY] ||
      localData[STORAGE_KEYS.LEGACY_USER_TOKEN] ||
      syncData[STORAGE_KEYS.LEGACY_SYNC_API_KEY] ||
      ""
    ).trim();

    if (migratedShared) {
      await chrome.storage.local.set({
        [STORAGE_KEYS.SHARED_API_KEY]: migratedShared
      });
      removeLocalKeys.push(STORAGE_KEYS.LEGACY_WEBUI_API_KEY, STORAGE_KEYS.LEGACY_USER_TOKEN);
      removeSyncKeys.push(STORAGE_KEYS.LEGACY_SYNC_API_KEY);
    }
  }

  if (removeLocalKeys.length > 0) {
    await chrome.storage.local.remove([...new Set(removeLocalKeys)]);
  }
  if (removeSyncKeys.length > 0) {
    await chrome.storage.sync.remove([...new Set(removeSyncKeys)]);
  }
}

async function initializeDefaultsAndMigration() {
  try {
    const data = await chrome.storage.local.get(["webuiBaseUrl"]);
    const current = String(data.webuiBaseUrl || "").trim();
    if (!current) {
      await chrome.storage.local.set({ webuiBaseUrl: DEFAULT_WEBUI_BASE_URL });
    }

    await migrateLegacySharedApiKeyIfNeeded();
  } catch (error) {
    console.warn("Failed to initialize default settings:", error);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await initializeDefaultsAndMigration();
});

chrome.runtime.onStartup.addListener(async () => {
  await initializeDefaultsAndMigration();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_CAPTURE" || message?.type === "STOP_CAPTURE") {
    Promise.resolve()
      .then(() => handleScanCaptureControl(message))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error?.message || String(error),
          code: error?.code || "KSCAN_CAPTURE_FAILED"
        });
      });
    return true;
  }

  if (message?.type !== MESSAGE_TYPES.LAUNCH_MODULE) return undefined;

  Promise.resolve()
    .then(() => migrateLegacySharedApiKeyIfNeeded())
    .then(() => launchModule(message.moduleId, sender?.tab?.id))
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error?.message || String(error),
        code: error?.code || "LAUNCH_MODULE_FAILED"
      });
    });

  return true;
});
