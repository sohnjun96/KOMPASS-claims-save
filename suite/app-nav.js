(() => {
  const MESSAGE_TYPES = globalThis.KSUITE_MESSAGE_TYPES;
  const MODULES = Array.isArray(globalThis.KSUITE_MODULES) ? globalThis.KSUITE_MODULES : [];
  const BUILD_MODULE_LAUNCHERS = globalThis.KSUITE_BUILD_MODULE_LAUNCHERS;
  const FALLBACK_SIDEPANEL_HOST_URL =
    globalThis.KSUITE_FALLBACK_SIDEPANEL_HOST_URL || "https://example.com/";
  const FEEDBACK = globalThis.KSUITE_FEEDBACK;
  const KLARC_DASHBOARD_PATH = "modules/k-larc/dashboard.html";

  if (!MESSAGE_TYPES || MODULES.length === 0 || typeof BUILD_MODULE_LAUNCHERS !== "function") {
    console.error("K-SUITE navigation constants are not initialized.");
    return;
  }

  const MODULE_LAUNCHERS = BUILD_MODULE_LAUNCHERS(MODULES);
  const navContainers = Array.from(document.querySelectorAll(".ksuite-nav"));
  if (navContainers.length === 0) return;

  let launching = false;

  function getModuleById(moduleId) {
    return MODULES.find((module) => module.id === moduleId) || null;
  }

  function createLaunchError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function inferCurrentModuleId(nav) {
    if (nav.dataset.currentModule) return nav.dataset.currentModule;

    const active = nav.querySelector("a[data-launch-module].active");
    if (active?.dataset?.launchModule) {
      return active.dataset.launchModule;
    }

    const pathname = String(location.pathname || "").replace(/^\//, "");
    const matched = MODULES.find((module) => pathname.endsWith(module.path));
    return matched?.id || "";
  }

  function renderNav(nav) {
    const currentModuleId = inferCurrentModuleId(nav);
    const existingHome = nav.querySelector("a:not([data-launch-module])");
    const homeLabel = nav.dataset.homeLabel || existingHome?.textContent?.trim() || "K-SUITE Home";
    const homeHref = chrome.runtime.getURL("suite/popup.html");

    nav.innerHTML = "";

    const homeLink = document.createElement("a");
    homeLink.className = "ksuite-nav-link";
    homeLink.href = homeHref;
    homeLink.textContent = homeLabel;
    nav.appendChild(homeLink);

    MODULES.forEach((module) => {
      const link = document.createElement("a");
      link.className = `ksuite-nav-link ${module.id === currentModuleId ? "active" : ""}`.trim();
      link.href = "#";
      link.dataset.launchModule = module.id;
      link.textContent = module.title;
      nav.appendChild(link);
    });
  }

  function showFeedback(options) {
    if (FEEDBACK?.show) {
      FEEDBACK.show(options);
      return;
    }
    if (options?.message) {
      console.info(options.message);
    }
  }

  function formatLaunchError(moduleId, error) {
    const module = getModuleById(moduleId);
    const moduleTitle = module?.title || moduleId || "Module";
    const code = error?.code || "";
    const raw = String(error?.message || error || "").trim();

    if (code === "NO_MODULE") return `${moduleTitle} cannot be launched due to invalid configuration.`;
    if (code === "NO_TAB") return "No tab available to open side panel.";
    if (code === "UNSUPPORTED_LAUNCH_TYPE") return `${moduleTitle} launch type is not supported.`;
    if (code === "LAUNCH_MODULE_FAILED") return `${moduleTitle} launch failed.`;
    if (code === "KSCAN_REQUIRES_KOMPASS") return "K-SCAN / K-Research must be opened on a KOMPASS tab.";
    if (code === "KQUERY_BLOCKED_TAB") return "K-Query cannot be opened on chrome://extensions settings tabs.";

    if (raw) return `${moduleTitle} launch failed: ${raw}`;
    return `${moduleTitle} launch failed`;
  }

  function isSameModuleUrl(tabUrl, targetUrl) {
    if (typeof tabUrl !== "string") return false;
    return tabUrl === targetUrl || tabUrl.startsWith(`${targetUrl}?`) || tabUrl.startsWith(`${targetUrl}#`);
  }

  function isBrowserExtensionsSettingsUrl(url) {
    if (typeof url !== "string") return false;
    return url.startsWith("chrome://extensions") || url.startsWith("edge://extensions");
  }

  function isSidePanelCompatibleTabUrl(url) {
    if (typeof url !== "string") return false;
    if (isBrowserExtensionsSettingsUrl(url)) return false;
    return url.startsWith("http://") || url.startsWith("https://");
  }

  function isKlarcDashboardUrl(url) {
    return isSameModuleUrl(url, chrome.runtime.getURL(KLARC_DASHBOARD_PATH));
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

  async function createFallbackSidePanelTab() {
    const created = await chrome.tabs.create({
      url: FALLBACK_SIDEPANEL_HOST_URL,
      active: true
    });
    if (Number.isInteger(created?.id)) {
      return created.id;
    }
    throw createLaunchError("NO_TAB", "Failed to create fallback side panel tab.");
  }

  async function getSidePanelTargetTabId(moduleId) {
    let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

    if (!tabs || tabs.length === 0 || !tabs[0]?.id) {
      tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    }

    const activeTab = tabs?.[0];
    const activeUrl = String(activeTab?.url || "");

    if (moduleId === "k-query" && isBrowserExtensionsSettingsUrl(activeUrl)) {
      throw createLaunchError(
        "KQUERY_BLOCKED_TAB",
        "K-Query cannot be opened on chrome://extensions settings tabs."
      );
    }

    if ((moduleId === "k-scan" || moduleId === "k-research") && isKlarcDashboardUrl(activeUrl)) {
      throw createLaunchError(
        "KSCAN_REQUIRES_KOMPASS",
        "K-SCAN / K-Research must be opened on a KOMPASS tab."
      );
    }

    const requireHttpTab = moduleId !== "k-query";
    if (Number.isInteger(activeTab?.id) && (!requireHttpTab || isSidePanelCompatibleTabUrl(activeTab?.url))) {
      return activeTab.id;
    }

    const activeWindowId = activeTab?.windowId;
    if (Number.isInteger(activeWindowId)) {
      const sameWindowTabs = await chrome.tabs.query({ windowId: activeWindowId });
      const preferred = sameWindowTabs.find((tab) =>
        Number.isInteger(tab?.id) && isSidePanelCompatibleTabUrl(tab?.url)
      );
      if (preferred?.id) return preferred.id;
    }

    const allTabs = await chrome.tabs.query({});
    const fallback = allTabs.find((tab) =>
      Number.isInteger(tab?.id) && isSidePanelCompatibleTabUrl(tab?.url)
    );
    if (fallback?.id) return fallback.id;

    return createFallbackSidePanelTab();
  }

  async function openModuleInSidePanel(path, moduleId) {
    const tabId = await getSidePanelTargetTabId(moduleId);

    await chrome.sidePanel.setOptions({
      tabId,
      path,
      enabled: true
    });

    await chrome.sidePanel.open({ tabId });
  }

  async function launchViaServiceWorker(moduleId) {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.LAUNCH_MODULE,
      moduleId
    });
    if (!response?.ok) {
      throw createLaunchError(
        response?.code || "LAUNCH_MODULE_FAILED",
        response?.error || "Module launch failed."
      );
    }
  }

  async function launchModule(moduleId, link) {
    if (!moduleId || launching) return;

    const launcher = MODULE_LAUNCHERS[moduleId];
    const linkEl = link || document.querySelector(`a[data-launch-module="${moduleId}"]`);

    if (!launcher) {
      const error = createLaunchError("NO_MODULE", `Unsupported module: ${moduleId}`);
      showFeedback({ tone: "error", message: formatLaunchError(moduleId, error), durationMs: 4200 });
      return;
    }

    launching = true;
    if (linkEl) linkEl.classList.add("is-launching");

    try {
      if (launcher.type === "tab") {
        await openOrFocusModuleTab(launcher.path);
        showFeedback({
          tone: "ok",
          message: `${getModuleById(moduleId)?.title || moduleId} opened`,
          durationMs: 1700
        });
        return;
      }

      if (launcher.type === "sidepanel") {
        try {
          await openModuleInSidePanel(launcher.path, moduleId);
        } catch (error) {
          if (error?.code === "KSCAN_REQUIRES_KOMPASS" || error?.code === "KQUERY_BLOCKED_TAB") {
            throw error;
          }
          await launchViaServiceWorker(moduleId);
        }
        showFeedback({
          tone: "ok",
          message: `${getModuleById(moduleId)?.title || moduleId} side panel opened`,
          durationMs: 1700
        });
        return;
      }

      throw createLaunchError("UNSUPPORTED_LAUNCH_TYPE", `Unsupported launch type: ${launcher.type}`);
    } catch (error) {
      showFeedback({
        tone: "error",
        message: formatLaunchError(moduleId, error),
        actionLabel: "Retry",
        onAction: () => void launchModule(moduleId),
        durationMs: 5200
      });
      console.error("Module launch failed:", error);
    } finally {
      launching = false;
      if (linkEl) linkEl.classList.remove("is-launching");
    }
  }

  navContainers.forEach(renderNav);

  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-launch-module]");
    if (!link) return;

    event.preventDefault();
    const moduleId = link.dataset.launchModule;
    void launchModule(moduleId, link);
  });
})();