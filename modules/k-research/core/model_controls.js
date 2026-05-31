const ALLOWED_REASONING_EFFORT_SET = new Set(["low", "medium", "high"]);

export const REASONING_EFFORT_ENUM = Object.freeze(["low", "medium", "high"]);
export const REASONING_PROMPT_KEYS = Object.freeze([
  "feature_extract",
  "query_seed",
  "query_refine",
  "query_duplicate_repair",
  "query_plan_remap",
  "citation_eval_json"
]);
export const DEFAULT_REASONING_EFFORT = "low";

export const DEFAULT_PER_PROMPT_REASONING_EFFORT = Object.freeze(
  REASONING_PROMPT_KEYS.reduce((acc, key) => {
    acc[key] = DEFAULT_REASONING_EFFORT;
    return acc;
  }, {})
);

export const DEFAULT_MODEL_CONTROLS = Object.freeze({
  globalReasoningEffort: DEFAULT_REASONING_EFFORT,
  enablePerPromptReasoningEffort: false,
  perPromptReasoningEffort: { ...DEFAULT_PER_PROMPT_REASONING_EFFORT }
});

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizePromptKey(value) {
  const key = String(value || "").trim();
  if (!key) return "";
  return REASONING_PROMPT_KEYS.includes(key) ? key : "";
}

export function normalizeReasoningEffort(value, fallback = DEFAULT_REASONING_EFFORT) {
  const fallbackNormalized = String(fallback || DEFAULT_REASONING_EFFORT).trim().toLowerCase();
  const fallbackSafe = ALLOWED_REASONING_EFFORT_SET.has(fallbackNormalized)
    ? fallbackNormalized
    : DEFAULT_REASONING_EFFORT;
  const normalized = String(value || "").trim().toLowerCase();
  if (ALLOWED_REASONING_EFFORT_SET.has(normalized)) return normalized;
  return fallbackSafe;
}

export function normalizePerPromptReasoningEffort(raw, fallback = DEFAULT_REASONING_EFFORT) {
  const source = isPlainObject(raw) ? raw : {};
  const out = {};
  REASONING_PROMPT_KEYS.forEach((promptKey) => {
    out[promptKey] = normalizeReasoningEffort(source[promptKey], fallback);
  });
  return out;
}

export function normalizeModelControls(rawControls) {
  const source = isPlainObject(rawControls) ? rawControls : {};
  const globalReasoningEffort = normalizeReasoningEffort(
    source.globalReasoningEffort ?? source.global_reasoning_effort,
    DEFAULT_REASONING_EFFORT
  );
  const perPromptReasoningEffort = normalizePerPromptReasoningEffort(
    source.perPromptReasoningEffort ?? source.per_prompt_reasoning_effort,
    globalReasoningEffort
  );
  const enablePerPromptReasoningEffort = source.enablePerPromptReasoningEffort === true
    || source.enable_per_prompt_reasoning_effort === true;

  return {
    globalReasoningEffort,
    enablePerPromptReasoningEffort,
    perPromptReasoningEffort
  };
}

export function resolveReasoningEffortForPrompt(promptName, settingsOrModelControls, fallback = DEFAULT_REASONING_EFFORT) {
  const modelControlsSource = isPlainObject(settingsOrModelControls?.modelControls)
    ? settingsOrModelControls.modelControls
    : settingsOrModelControls;
  const modelControls = normalizeModelControls(modelControlsSource);
  const promptKey = normalizePromptKey(promptName);

  if (
    promptKey
    && modelControls.enablePerPromptReasoningEffort === true
    && isPlainObject(modelControls.perPromptReasoningEffort)
  ) {
    return normalizeReasoningEffort(
      modelControls.perPromptReasoningEffort[promptKey],
      modelControls.globalReasoningEffort
    );
  }

  return normalizeReasoningEffort(modelControls.globalReasoningEffort, fallback);
}
