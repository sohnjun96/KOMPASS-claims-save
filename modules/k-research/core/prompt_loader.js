const PROMPT_FILES = {
  feature_extract: {
    system: "modules/k-research/prompts/feature_extract/system.txt",
    user: "modules/k-research/prompts/feature_extract/user.txt",
    schema: "modules/k-research/prompts/feature_extract/schema.json"
  },
  query_seed: {
    system: "modules/k-research/prompts/query_seed/system.txt",
    user: "modules/k-research/prompts/query_seed/user.txt",
    schema: "modules/k-research/prompts/query_seed/schema.json"
  },
  citation_eval_json: {
    system: "modules/k-research/prompts/citation_eval_json/system.txt",
    user: "modules/k-research/prompts/citation_eval_json/user.txt",
    repairUser: "modules/k-research/prompts/citation_eval_json/repair_user.txt",
    schema: "modules/k-research/prompts/citation_eval_json/schema.json"
  },
  query_refine: {
    system: "modules/k-research/prompts/query_refine/system.txt",
    user: "modules/k-research/prompts/query_refine/user.txt",
    schema: "modules/k-research/prompts/query_refine/schema.json"
  },
  query_duplicate_repair: {
    system: "modules/k-research/prompts/query_duplicate_repair/system.txt",
    user: "modules/k-research/prompts/query_duplicate_repair/user.txt",
    schema: "modules/k-research/prompts/query_duplicate_repair/schema.json"
  },
  query_plan_remap: {
    system: "modules/k-research/prompts/query_plan_remap/system.txt",
    user: "modules/k-research/prompts/query_plan_remap/user.txt",
    schema: "modules/k-research/prompts/query_plan_remap/schema.json"
  }
};

const textCache = new Map();
const jsonCache = new Map();

async function readText(path) {
  if (!path) return "";
  if (!textCache.has(path)) {
    const promise = fetch(chrome.runtime.getURL(path))
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to load prompt: ${path}`);
        }
        return response.text();
      });
    textCache.set(path, promise);
  }
  return textCache.get(path);
}

async function readJson(path) {
  if (!path) return {};
  if (!jsonCache.has(path)) {
    const promise = fetch(chrome.runtime.getURL(path))
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to load schema: ${path}`);
        }
        return response.json();
      });
    jsonCache.set(path, promise);
  }
  return jsonCache.get(path);
}

export function renderTemplate(template, variables = {}) {
  return String(template || "").replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, key) => {
    const value = variables[key];
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  });
}

export async function loadPromptBundle(promptKey) {
  const entry = PROMPT_FILES[promptKey];
  if (!entry) {
    throw new Error(`Unknown prompt key: ${promptKey}`);
  }

  const [system, user, schema, repairUser] = await Promise.all([
    readText(entry.system),
    readText(entry.user),
    readJson(entry.schema),
    readText(entry.repairUser)
  ]);

  return {
    system,
    user,
    schema,
    repairUser
  };
}
