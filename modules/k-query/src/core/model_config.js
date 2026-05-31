const FALLBACK_LLM_MODEL = String(globalThis.KSUITE_DEFAULT_LLM_MODEL || "gemma-26b-moe").trim() || "gemma-26b-moe";

async function resolveConfiguredModel() {
  if (typeof globalThis.KSUITE_GET_SHARED_SETTINGS === "function") {
    try {
      const sharedSettings = await globalThis.KSUITE_GET_SHARED_SETTINGS();
      const configuredModel = String(sharedSettings?.defaultModel || "").trim();
      if (configuredModel) {
        return configuredModel;
      }
    } catch (error) {
      console.warn("[K-QUERY] Failed to read shared model setting:", error);
    }
  }

  return FALLBACK_LLM_MODEL;
}

const DEFAULT_LLM_MODEL = await resolveConfiguredModel();

export const ANALYST_MODEL = DEFAULT_LLM_MODEL;
export const JUDGE_MODEL = DEFAULT_LLM_MODEL;
export const ENSEMBLE_MODELS = [DEFAULT_LLM_MODEL];

export const TEMPERATURES = {
  analysis: 0.2,
  expansion: 0.6,
  evaluation: 0.2,
  validation: 0.0
};

export const DEFAULT_NEAR_DISTANCE = 3;
