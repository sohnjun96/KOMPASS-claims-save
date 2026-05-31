(function initKSuiteSharedConstants(globalScope) {
  const DEFAULT_WEBUI_BASE_URL = "https://llm.moip.go.kr";
  const FALLBACK_SIDEPANEL_HOST_URL = "https://example.com/";
  const DEFAULT_LLM_MODEL = "gemma-26b-moe";
  const APP_VERSION = (() => {
    try {
      const version = globalScope.chrome?.runtime?.getManifest?.()?.version;
      return version ? `v${version}` : "";
    } catch {
      return "";
    }
  })();

  const MESSAGE_TYPES = Object.freeze({
    LAUNCH_MODULE: "LAUNCH_MODULE"
  });

  const STORAGE_KEYS = Object.freeze({
    SHARED_API_KEY: "ksuiteSharedApiKey",
    DEFAULT_MODEL: "ksuiteDefaultModel",
    KQUERY_CLAIM_TEXT: "ksuiteClaimKQuery",
    KSCAN_CLAIM_TEXT: "ksuiteClaimKScan",
    LEGACY_WEBUI_API_KEY: "webuiApiKey",
    LEGACY_USER_TOKEN: "user_token",
    LEGACY_SYNC_API_KEY: "apiKey"
  });

  const SETTINGS_FIELDS = Object.freeze([
    {
      id: "webuiBaseUrl",
      label: "OpenWebUI Base URL",
      type: "url",
      placeholder: DEFAULT_WEBUI_BASE_URL,
      required: false,
      defaultValue: DEFAULT_WEBUI_BASE_URL,
      helpText: "Leave blank to use the default base URL."
    },
    {
      id: "sharedApiKey",
      label: "Shared API Key / Token",
      type: "password",
      placeholder: "e.g. sk-...",
      required: true,
      defaultValue: "",
      helpText: "Shared across K-LARC, K-Query, K-SCAN, and K-Research."
    },
    {
      id: "defaultModel",
      label: "Default Model",
      type: "text",
      placeholder: DEFAULT_LLM_MODEL,
      required: false,
      defaultValue: DEFAULT_LLM_MODEL,
      helpText: "If /api/models loads successfully, choose from the list. Otherwise type the model ID manually."
    }
  ]);

  const MODULES = Object.freeze([
    {
      id: "k-larc",
      title: "K-LARC",
      description: "Claim-to-reference analysis dashboard.",
      launchType: "tab",
      path: "modules/k-larc/dashboard.html",
      requiredSettingIds: ["sharedApiKey"]
    },
    {
      id: "k-query",
      title: "K-Query",
      description: "Claim-based search expression generator.",
      launchType: "sidepanel",
      path: "modules/k-query/src/sidebar/sidepanel.html",
      requiredSettingIds: ["sharedApiKey"]
    },
    {
      id: "k-scan",
      title: "K-SCAN",
      description: "Capture and export patent claim pairs.",
      launchType: "sidepanel",
      path: "modules/k-scan/sidepanel.html",
      requiredSettingIds: []
    },
    {
      id: "k-research",
      title: "K-Research",
      description: "Automated iterative search side panel.",
      launchType: "sidepanel",
      path: "modules/k-research/sidepanel.html",
      requiredSettingIds: ["sharedApiKey"]
    }
  ]);

  function buildModuleLaunchers(modules) {
    const source = Array.isArray(modules) ? modules : [];
    return Object.freeze(
      Object.fromEntries(
        source
          .filter((module) => module?.id && module?.path && module?.launchType)
          .map((module) => [
            module.id,
            {
              type: module.launchType,
              path: module.path
            }
          ])
      )
    );
  }

  function trimTrailingSlash(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  function normalizeModelName(rawValue, fallback = DEFAULT_LLM_MODEL) {
    const value = String(rawValue || "").trim();
    return value || fallback;
  }

  async function getSharedSettings() {
    const storage = globalScope.chrome?.storage?.local;
    if (!storage?.get) {
      return {
        webuiBaseUrl: DEFAULT_WEBUI_BASE_URL,
        sharedApiKey: "",
        defaultModel: DEFAULT_LLM_MODEL
      };
    }

    const data = await storage.get([
      "webuiBaseUrl",
      STORAGE_KEYS.SHARED_API_KEY,
      STORAGE_KEYS.DEFAULT_MODEL
    ]);

    return {
      webuiBaseUrl: trimTrailingSlash(data.webuiBaseUrl) || DEFAULT_WEBUI_BASE_URL,
      sharedApiKey: String(data[STORAGE_KEYS.SHARED_API_KEY] || "").trim(),
      defaultModel: normalizeModelName(data[STORAGE_KEYS.DEFAULT_MODEL], DEFAULT_LLM_MODEL)
    };
  }

  function extractAvailableModels(payload) {
    const source = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.models)
          ? payload.models
          : Array.isArray(payload?.items)
            ? payload.items
            : [];

    const seen = new Set();
    return source
      .map((entry) => {
        const id = String(
          entry?.id
          || entry?.model
          || entry?.name
          || entry?.slug
          || ""
        ).trim();
        if (!id || seen.has(id)) return null;
        seen.add(id);

        const label = String(
          entry?.name
          || entry?.display_name
          || entry?.displayName
          || entry?.info?.meta?.name
          || id
        ).trim() || id;

        return {
          id,
          label,
          raw: entry
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.label.localeCompare(right.label, "en"));
  }

  async function fetchAvailableModels({ baseUrl = "", apiKey = "" } = {}) {
    const normalizedBaseUrl = trimTrailingSlash(baseUrl) || DEFAULT_WEBUI_BASE_URL;
    const token = String(apiKey || "").trim();

    if (!normalizedBaseUrl || !token) {
      throw new Error("Base URL and API key are required to load models.");
    }

    const response = await fetch(`${normalizedBaseUrl}/api/models`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`
      }
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = String(payload?.detail || payload?.error || response.statusText || "").trim();
      throw new Error(detail || `Model list request failed (${response.status}).`);
    }

    const models = extractAvailableModels(payload);
    if (models.length === 0) {
      throw new Error("No models were returned by /api/models.");
    }

    return models;
  }

  if (!globalScope.KSUITE_MESSAGE_TYPES) {
    globalScope.KSUITE_MESSAGE_TYPES = MESSAGE_TYPES;
  }

  if (!globalScope.KSUITE_STORAGE_KEYS) {
    globalScope.KSUITE_STORAGE_KEYS = STORAGE_KEYS;
  }

  if (!globalScope.KSUITE_DEFAULT_WEBUI_BASE_URL) {
    globalScope.KSUITE_DEFAULT_WEBUI_BASE_URL = DEFAULT_WEBUI_BASE_URL;
  }

  if (!globalScope.KSUITE_DEFAULT_LLM_MODEL) {
    globalScope.KSUITE_DEFAULT_LLM_MODEL = DEFAULT_LLM_MODEL;
  }

  if (!globalScope.KSUITE_NORMALIZE_MODEL_NAME) {
    globalScope.KSUITE_NORMALIZE_MODEL_NAME = normalizeModelName;
  }

  if (!globalScope.KSUITE_GET_SHARED_SETTINGS) {
    globalScope.KSUITE_GET_SHARED_SETTINGS = getSharedSettings;
  }

  if (!globalScope.KSUITE_FETCH_AVAILABLE_MODELS) {
    globalScope.KSUITE_FETCH_AVAILABLE_MODELS = fetchAvailableModels;
  }

  if (!globalScope.KSUITE_APP_VERSION && APP_VERSION) {
    globalScope.KSUITE_APP_VERSION = APP_VERSION;
  }

  if (!globalScope.KSUITE_FALLBACK_SIDEPANEL_HOST_URL) {
    globalScope.KSUITE_FALLBACK_SIDEPANEL_HOST_URL = FALLBACK_SIDEPANEL_HOST_URL;
  }

  if (!globalScope.KSUITE_SETTINGS_FIELDS) {
    globalScope.KSUITE_SETTINGS_FIELDS = SETTINGS_FIELDS;
  }

  if (!globalScope.KSUITE_MODULES) {
    globalScope.KSUITE_MODULES = MODULES;
  }

  if (!globalScope.KSUITE_BUILD_MODULE_LAUNCHERS) {
    globalScope.KSUITE_BUILD_MODULE_LAUNCHERS = buildModuleLaunchers;
  }
})(typeof globalThis !== "undefined" ? globalThis : self);
