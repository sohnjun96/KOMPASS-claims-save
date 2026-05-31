const DEFAULT_WEBUI_BASE_URL_FALLBACK = "https://llm.moip.go.kr";
const DEFAULT_LLM_MODEL_FALLBACK = "gemma-26b-moe";

const SETTINGS_FIELDS_FALLBACK = Object.freeze([
  {
    id: "webuiBaseUrl",
    label: "OpenWebUI Base URL",
    type: "url",
    placeholder: DEFAULT_WEBUI_BASE_URL_FALLBACK,
    required: false,
    defaultValue: DEFAULT_WEBUI_BASE_URL_FALLBACK,
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
    placeholder: DEFAULT_LLM_MODEL_FALLBACK,
    required: false,
    defaultValue: DEFAULT_LLM_MODEL_FALLBACK,
    helpText: "If /api/models loads successfully, choose from the list. Otherwise type the model ID manually."
  }
]);

const MODULES_FALLBACK = Object.freeze([
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

export const DEFAULT_WEBUI_BASE_URL =
  globalThis.KSUITE_DEFAULT_WEBUI_BASE_URL || DEFAULT_WEBUI_BASE_URL_FALLBACK;

export const SETTINGS_FIELDS =
  globalThis.KSUITE_SETTINGS_FIELDS || SETTINGS_FIELDS_FALLBACK;

export const MODULES =
  globalThis.KSUITE_MODULES || MODULES_FALLBACK;

export const FIELD_BY_ID = Object.freeze(
  Object.fromEntries(SETTINGS_FIELDS.map((field) => [field.id, field]))
);

export const REQUIRED_FIELD_IDS = Object.freeze(
  SETTINGS_FIELDS.filter((field) => field.required).map((field) => field.id)
);

export function normalizeFieldValue(field, rawValue) {
  const value = typeof rawValue === "string" ? rawValue : "";
  if (field.type === "url") {
    return value.trim().replace(/\/+$/, "");
  }
  return value.trim();
}

export function isFieldFilled(field, value) {
  if (!field || !field.required) return true;
  return String(value || "").trim().length > 0;
}

export function getMissingRequiredFieldIds(values) {
  return REQUIRED_FIELD_IDS.filter((fieldId) => {
    const field = FIELD_BY_ID[fieldId];
    return !isFieldFilled(field, values[fieldId]);
  });
}

export function getModuleMissingFieldIds(module, values) {
  const requiredIds = Array.isArray(module?.requiredSettingIds)
    ? module.requiredSettingIds
    : REQUIRED_FIELD_IDS;

  return requiredIds.filter((fieldId) => {
    const field = FIELD_BY_ID[fieldId];
    return !isFieldFilled(field, values[fieldId]);
  });
}
