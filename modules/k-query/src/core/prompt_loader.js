const PROMPT_BUNDLES = {
  layer1Extraction: {
    system: "modules/k-query/prompts/layer_1/extraction/system.txt",
    user: "modules/k-query/prompts/layer_1/extraction/user.txt",
    schema: "modules/k-query/prompts/layer_1/extraction/schema.json"
  },
  layer1Prioritization: {
    system: "modules/k-query/prompts/layer_1/prioritization/system.txt",
    user: "modules/k-query/prompts/layer_1/prioritization/user.txt",
    schema: "modules/k-query/prompts/layer_1/prioritization/schema.json"
  },
  layer1Relations: {
    system: "modules/k-query/prompts/layer_1/relations/system.txt",
    user: "modules/k-query/prompts/layer_1/relations/user.txt",
    schema: "modules/k-query/prompts/layer_1/relations/schema.json"
  },
  layer2Expansion: {
    system: "modules/k-query/prompts/layer_2/expansion/system.txt",
    user: "modules/k-query/prompts/layer_2/expansion/user.txt",
    schema: "modules/k-query/prompts/layer_2/expansion/schema.json"
  },
  layer2Evaluation: {
    system: "modules/k-query/prompts/layer_2/evaluation/system.txt",
    user: "modules/k-query/prompts/layer_2/evaluation/user.txt",
    schema: "modules/k-query/prompts/layer_2/evaluation/schema.json"
  },
  layer2ContextFilter: {
    system: "modules/k-query/prompts/layer_2/context_filter/system.txt",
    user: "modules/k-query/prompts/layer_2/context_filter/user.txt",
    schema: "modules/k-query/prompts/layer_2/context_filter/schema.json"
  },
  layer3Validation: {
    system: "modules/k-query/prompts/layer_3/validation/system.txt",
    user: "modules/k-query/prompts/layer_3/validation/user.txt",
    schema: "modules/k-query/prompts/layer_3/validation/schema.json"
  }
};

const PLACEHOLDER_REGEX = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
const textCache = new Map();
const schemaCache = new Map();
const PROMPT_RUNTIME_DEFAULTS = Object.freeze({
  output_language: "ko",
  strict_mode: true
});
const PROMPT_RUNTIME_TYPES = Object.freeze({
  output_language: "text",
  strict_mode: "boolean"
});

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function extractPlaceholders(template) {
  const names = new Set();
  for (const match of String(template || "").matchAll(PLACEHOLDER_REGEX)) {
    names.add(match[1]);
  }
  return names;
}

function normalizeSchema(rawSchema, systemPrompt, userPrompt) {
  const schema = isObject(rawSchema) ? rawSchema : {};
  const required = Array.isArray(schema.required)
    ? [...new Set(schema.required.filter((key) => typeof key === "string" && key.trim()).map((key) => key.trim()))]
    : [];
  const optional = isObject(schema.optional) ? { ...schema.optional } : {};
  const types = isObject(schema.types) ? { ...schema.types } : {};

  const allPlaceholderNames = new Set([
    ...extractPlaceholders(systemPrompt),
    ...extractPlaceholders(userPrompt)
  ]);
  for (const name of allPlaceholderNames) {
    if (!hasOwn(optional, name) && hasOwn(PROMPT_RUNTIME_DEFAULTS, name)) {
      optional[name] = PROMPT_RUNTIME_DEFAULTS[name];
    }
    if (!hasOwn(types, name)) {
      types[name] = PROMPT_RUNTIME_TYPES[name] || "text";
    }
  }

  return {
    required,
    optional,
    types,
    placeholders: [...allPlaceholderNames]
  };
}

function hasMeaningfulValue(value) {
  return value !== undefined && value !== null;
}

function formatTemplateValue(value, type) {
  if (!hasMeaningfulValue(value)) return "";
  const normalizedType = String(type || "text").trim().toLowerCase();

  if (normalizedType === "boolean" || normalizedType === "bool") {
    if (typeof value === "string") {
      const lowered = value.trim().toLowerCase();
      if (lowered === "true" || lowered === "false") return lowered;
    }
    return value ? "true" : "false";
  }

  if (normalizedType === "json") {
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
  }

  if (normalizedType === "list") {
    if (Array.isArray(value)) return value.map((item) => String(item ?? "")).join("\n");
    return String(value);
  }

  return String(value);
}

function normalizeVariableByType(name, value, type, promptKey) {
  if (!hasMeaningfulValue(value)) return value;
  const normalizedType = String(type || "text").trim().toLowerCase();

  if (normalizedType === "boolean" || normalizedType === "bool") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const lowered = value.trim().toLowerCase();
      if (lowered === "true") return true;
      if (lowered === "false") return false;
    }
    throw new Error(`Invalid boolean prompt variable '${name}' for '${promptKey}'. Use true/false.`);
  }

  if (normalizedType === "json") {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return value;
      try {
        JSON.parse(trimmed);
      } catch {
        throw new Error(`Invalid JSON prompt variable '${name}' for '${promptKey}'.`);
      }
      return value;
    }
    if (typeof value === "object") return value;
    throw new Error(`Invalid JSON prompt variable '${name}' for '${promptKey}'.`);
  }

  if (normalizedType === "list") {
    if (Array.isArray(value) || typeof value === "string") return value;
    throw new Error(`Invalid list prompt variable '${name}' for '${promptKey}'.`);
  }

  if (normalizedType === "text") {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    throw new Error(`Invalid text prompt variable '${name}' for '${promptKey}'.`);
  }

  return value;
}

function resolveTemplateVariables(variables, schema, promptKey) {
  const safeVariables = isObject(variables) ? variables : {};
  const merged = { ...PROMPT_RUNTIME_DEFAULTS, ...schema.optional, ...safeVariables };
  const missing = schema.required.filter((name) => !hasMeaningfulValue(merged[name]));
  if (missing.length > 0) {
    throw new Error(
      `Missing required prompt variables for '${promptKey}': ${missing.join(", ")}`
    );
  }

  const namesToValidate = new Set([
    ...(Array.isArray(schema.placeholders) ? schema.placeholders : []),
    ...schema.required
  ]);
  for (const name of namesToValidate) {
    if (!hasOwn(merged, name)) continue;
    merged[name] = normalizeVariableByType(name, merged[name], schema.types[name], promptKey);
  }
  return merged;
}

function fillTemplateStrict(promptText, variables, schema, promptKey, promptRole) {
  const template = String(promptText || "");
  const rendered = template.replace(PLACEHOLDER_REGEX, (matched, variableName) => {
    if (!hasOwn(variables, variableName)) {
      throw new Error(
        `Unknown placeholder '{{${variableName}}}' in ${promptRole} prompt for '${promptKey}'`
      );
    }
    return formatTemplateValue(variables[variableName], schema.types[variableName]);
  });

  const unresolved = [...rendered.matchAll(PLACEHOLDER_REGEX)].map((match) => match[1]);
  if (unresolved.length > 0) {
    throw new Error(
      `Unresolved placeholders in ${promptRole} prompt for '${promptKey}': ${[...new Set(unresolved)].join(", ")}`
    );
  }

  return rendered;
}

async function fetchText(path) {
  if (!path) return null;
  if (textCache.has(path)) return textCache.get(path);

  const response = await fetch(chrome.runtime.getURL(path));
  if (!response.ok) {
    throw new Error(`Failed to load prompt: ${path}`);
  }

  const text = await response.text();
  textCache.set(path, text);
  return text;
}

async function fetchSchema(path) {
  if (!path) return null;
  if (schemaCache.has(path)) return schemaCache.get(path);

  const response = await fetch(chrome.runtime.getURL(path));
  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`Failed to load prompt schema: ${path}`);
  }

  const parsed = await response.json();
  schemaCache.set(path, parsed);
  return parsed;
}

export async function loadPromptBundle(key) {
  const bundle = PROMPT_BUNDLES[key];
  if (!bundle) throw new Error(`Unknown prompt key: ${key}`);

  const systemPrompt = await fetchText(bundle.system);
  const userPrompt = await fetchText(bundle.user);
  const schema = normalizeSchema(await fetchSchema(bundle.schema), systemPrompt, userPrompt);

  return { key, systemPrompt, userPrompt, schema };
}

export async function renderPromptPair(key, variables) {
  const bundle = await loadPromptBundle(key);
  const resolvedVariables = resolveTemplateVariables(variables, bundle.schema, key);
  const system = fillTemplateStrict(bundle.systemPrompt, resolvedVariables, bundle.schema, key, "system");
  const user = fillTemplateStrict(bundle.userPrompt, resolvedVariables, bundle.schema, key, "user");
  return {
    system,
    user,
    schema: bundle.schema,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  };
}

// Backward-compatible exports
export async function loadPrompt(key) {
  const bundle = await loadPromptBundle(key);
  return bundle.userPrompt;
}

export function fillTemplate(promptText, variables) {
  return String(promptText || "").replace(PLACEHOLDER_REGEX, (_, key) => {
    const value = variables?.[key];
    return value === undefined || value === null ? "" : String(value);
  });
}
