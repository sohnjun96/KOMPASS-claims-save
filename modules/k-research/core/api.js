const DEFAULT_WEBUI_BASE_URL = "https://llm.moip.go.kr";
const CHAT_COMPLETIONS_PATH = "/api/chat/completions";
const DEFAULT_LLM_MODEL = String(globalThis.KSUITE_DEFAULT_LLM_MODEL || "gemma-26b-moe").trim() || "gemma-26b-moe";

function trimSlash(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function extractMessageContent(rawContent) {
  if (typeof rawContent === "string") return rawContent;
  if (Array.isArray(rawContent)) {
    return rawContent
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item.text === "string") return item.text;
        return "";
      })
      .join("\n")
      .trim();
  }
  return "";
}

function normalizeMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((entry) => ({
      role: String(entry?.role || "user").trim() || "user",
      content: String(entry?.content || "").trim()
    }))
    .filter((entry) => entry.content);
}

function prependReasoningHint(messages, reasoningEffort) {
  const normalized = normalizeMessages(messages);
  if (!normalized.length) return normalized;
  const effort = String(reasoningEffort || "").trim().toLowerCase();
  if (!effort) return normalized;

  const hint = `Reasoning: ${effort}`;
  const firstSystemIndex = normalized.findIndex((entry) => entry.role === "system");
  if (firstSystemIndex >= 0) {
    const first = normalized[firstSystemIndex];
    if (!first.content.toLowerCase().startsWith("reasoning:")) {
      normalized[firstSystemIndex] = {
        ...first,
        content: `${hint}\n\n${first.content}`
      };
    }
    return normalized;
  }

  return [{ role: "system", content: hint }, ...normalized];
}

export async function getApiSettings() {
  const data = await chrome.storage.local.get([
    "webuiBaseUrl",
    "ksuiteSharedApiKey",
    "kresearchCapabilityReasoningEffort",
    "kresearchCapabilityResponseFormat",
    "kresearchCapabilityMaxOutputTokens",
    "kresearchUseHarmonyReasoningPrefix",
    "kresearchDefaultReasoningLow"
  ]);

  return {
    apiUrl: `${trimSlash(data.webuiBaseUrl || DEFAULT_WEBUI_BASE_URL)}${CHAT_COMPLETIONS_PATH}`,
    apiKey: String(data.ksuiteSharedApiKey || "").trim(),
    capabilities: {
      reasoningEffort: data.kresearchCapabilityReasoningEffort === true,
      responseFormat: data.kresearchCapabilityResponseFormat === true,
      maxOutputTokens: data.kresearchCapabilityMaxOutputTokens === true
    },
    useHarmonyReasoningPrefix: data.kresearchUseHarmonyReasoningPrefix === true,
    defaultReasoningLow: data.kresearchDefaultReasoningLow !== false
  };
}

async function resolveDefaultModelName() {
  if (typeof globalThis.KSUITE_GET_SHARED_SETTINGS === "function") {
    try {
      const sharedSettings = await globalThis.KSUITE_GET_SHARED_SETTINGS();
      const configuredModel = String(sharedSettings?.defaultModel || "").trim();
      if (configuredModel) return configuredModel;
    } catch (error) {
      console.warn("[K-Research] Failed to read shared model setting:", error);
    }
  }

  return DEFAULT_LLM_MODEL;
}

export async function callOpenWebUI(messages, {
  model = "",
  temperature = 0.2,
  reasoningEffort = "",
  responseFormat = null,
  maxOutputTokens = null,
  capabilities = null,
  useHarmonyReasoningPrefix = null
} = {}) {
  const settings = await getApiSettings();
  const { apiUrl, apiKey } = settings;
  const resolvedModel = String(model || "").trim() || await resolveDefaultModelName();
  if (!apiKey) {
    throw new Error("Shared API key is not set.");
  }

  const effectiveCapabilities = {
    ...(settings.capabilities || {}),
    ...(capabilities && typeof capabilities === "object" ? capabilities : {})
  };

  const unsupportedOptions = [];
  let outgoingMessages = normalizeMessages(messages);
  const normalizedReasoningEffort = String(reasoningEffort || "").trim().toLowerCase();

  const requestPayload = {
    model: resolvedModel,
    temperature,
    messages: outgoingMessages
  };

  if (normalizedReasoningEffort) {
    if (effectiveCapabilities.reasoningEffort === true) {
      requestPayload.reasoning = {
        effort: normalizedReasoningEffort
      };
    } else {
      const useHarmony = useHarmonyReasoningPrefix === true
        || (useHarmonyReasoningPrefix === null && settings.useHarmonyReasoningPrefix === true);
      if (useHarmony) {
        outgoingMessages = prependReasoningHint(outgoingMessages, normalizedReasoningEffort);
        requestPayload.messages = outgoingMessages;
      } else {
        unsupportedOptions.push("reasoningEffort");
      }
    }
  }

  // K-Research policy: response_format transport is disabled.
  // Structured schema constraints are enforced via system prompt + local schema validation.
  if (responseFormat) {
    unsupportedOptions.push("responseFormat");
  }

  if (Number.isFinite(Number(maxOutputTokens)) && Number(maxOutputTokens) > 0) {
    if (effectiveCapabilities.maxOutputTokens === true) {
      requestPayload.max_tokens = Math.max(1, Math.round(Number(maxOutputTokens)));
    } else {
      unsupportedOptions.push("maxOutputTokens");
    }
  }

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify(requestPayload)
  });

  const payload = await response.json().catch(() => ({}));
  const content = extractMessageContent(payload?.choices?.[0]?.message?.content);

  return {
    ok: response.ok,
    status: response.status,
    payload,
    content,
    unsupportedOptions,
    requestMeta: {
      usedReasoningEffort: normalizedReasoningEffort || "",
      usedResponseFormat: !!responseFormat,
      usedMaxOutputTokens: Number.isFinite(Number(maxOutputTokens)) && Number(maxOutputTokens) > 0
    }
  };
}
