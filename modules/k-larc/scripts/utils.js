function extractFirstJsonCandidate(text) {
  const source = String(text || '');
  const objectStart = source.indexOf('{');
  const arrayStart = source.indexOf('[');

  let start = -1;
  if (objectStart === -1) start = arrayStart;
  else if (arrayStart === -1) start = objectStart;
  else start = Math.min(objectStart, arrayStart);

  if (start === -1) return null;

  const stack = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{' || ch === '[') {
      stack.push(ch);
      continue;
    }

    if (ch === '}' || ch === ']') {
      const last = stack.pop();
      const matched = (last === '{' && ch === '}') || (last === '[' && ch === ']');
      if (!matched) return null;
      if (stack.length === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  return null;
}

function safeJsonParse(raw) {
  if (typeof raw !== 'string') return raw;
  const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const candidate = extractFirstJsonCandidate(cleaned);
    if (candidate) {
      return JSON.parse(candidate);
    }
    throw e;
  }
}

const LARC_PROMPT_BUNDLES = Object.freeze({
  chat: {
    system: 'prompts/chat/system.txt',
    user: 'prompts/chat/user.txt',
    schema: 'prompts/chat/schema.json'
  },
  stepAFeatures: {
    system: 'prompts/step_a_features/system.txt',
    user: 'prompts/step_a_features/user.txt',
    schema: 'prompts/step_a_features/schema.json'
  },
  stepQuickAnalysis: {
    system: 'prompts/step_quick_analysis/system.txt',
    user: 'prompts/step_quick_analysis/user.txt',
    schema: 'prompts/step_quick_analysis/schema.json'
  },
  stepBQuery: {
    system: 'prompts/step_b_query/system.txt',
    user: 'prompts/step_b_query/user.txt',
    schema: 'prompts/step_b_query/schema.json'
  },
  stepBMerge: {
    system: 'prompts/step_b_merge/system.txt',
    user: 'prompts/step_b_merge/user.txt',
    schema: 'prompts/step_b_merge/schema.json'
  },
  stepBRag: {
    system: 'prompts/step_b_rag/system.txt',
    user: 'prompts/step_b_rag/user.txt',
    schema: 'prompts/step_b_rag/schema.json'
  },
  stepBRagRepair: {
    system: 'prompts/step_b_rag_repair/system.txt',
    user: 'prompts/step_b_rag_repair/user.txt',
    schema: 'prompts/step_b_rag_repair/schema.json'
  },
  stepCMultiJudge: {
    system: 'prompts/step_c_multijudge/system.txt',
    user: 'prompts/step_c_multijudge/user.txt',
    schema: 'prompts/step_c_multijudge/schema.json'
  },
  stepDRepair: {
    system: 'prompts/step_d_repair/system.txt',
    user: 'prompts/step_d_repair/user.txt',
    schema: 'prompts/step_d_repair/schema.json'
  },
  verification: {
    system: 'prompts/verification/system.txt',
    user: 'prompts/verification/user.txt',
    schema: 'prompts/verification/schema.json'
  },
  opinionNoticeReview: {
    system: 'prompts/opinion_notice_review/system.txt',
    user: 'prompts/opinion_notice_review/user.txt',
    schema: 'prompts/opinion_notice_review/schema.json'
  }
});

const LARC_PROMPT_PLACEHOLDER_REGEX = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
const larcPromptTextCache = new Map();
const larcPromptSchemaCache = new Map();
const larcSkillTextCache = new Map();
const LARC_PROMPT_RUNTIME_DEFAULTS = Object.freeze({
  output_language: 'ko',
  strict_mode: true
});
const LARC_PROMPT_RUNTIME_TYPES = Object.freeze({
  output_language: 'text',
  strict_mode: 'boolean'
});

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function extractPromptPlaceholders(template) {
  const names = new Set();
  for (const match of String(template || '').matchAll(LARC_PROMPT_PLACEHOLDER_REGEX)) {
    names.add(match[1]);
  }
  return names;
}

function normalizePromptSchema(rawSchema, systemTemplate, userTemplate) {
  const schema = isPlainObject(rawSchema) ? rawSchema : {};
  const required = Array.isArray(schema.required)
    ? [...new Set(schema.required.filter(key => typeof key === 'string' && key.trim()).map(key => key.trim()))]
    : [];
  const optional = isPlainObject(schema.optional) ? { ...schema.optional } : {};
  const types = isPlainObject(schema.types) ? { ...schema.types } : {};

  const placeholders = new Set([
    ...extractPromptPlaceholders(systemTemplate),
    ...extractPromptPlaceholders(userTemplate)
  ]);
  placeholders.forEach((name) => {
    if (!hasOwn(optional, name) && hasOwn(LARC_PROMPT_RUNTIME_DEFAULTS, name)) {
      optional[name] = LARC_PROMPT_RUNTIME_DEFAULTS[name];
    }
    if (!hasOwn(types, name)) {
      types[name] = LARC_PROMPT_RUNTIME_TYPES[name] || 'text';
    }
  });

  return {
    required,
    optional,
    types,
    placeholders: [...placeholders]
  };
}

function hasPromptValue(value) {
  return value !== undefined && value !== null;
}

function formatPromptValue(value, type) {
  if (!hasPromptValue(value)) return '';
  const normalizedType = String(type || 'text').trim().toLowerCase();

  if (normalizedType === 'boolean' || normalizedType === 'bool') {
    if (typeof value === 'string') {
      const lowered = value.trim().toLowerCase();
      if (lowered === 'true' || lowered === 'false') return lowered;
    }
    return value ? 'true' : 'false';
  }

  if (normalizedType === 'json') {
    if (typeof value === 'string') return value;
    return JSON.stringify(value, null, 2);
  }

  if (normalizedType === 'list') {
    if (Array.isArray(value)) return value.map(item => String(item ?? '')).join('\n');
    return String(value);
  }

  return String(value);
}

function normalizePromptVariableByType(name, value, type, promptKey) {
  if (!hasPromptValue(value)) return value;
  const normalizedType = String(type || 'text').trim().toLowerCase();

  if (normalizedType === 'boolean' || normalizedType === 'bool') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const lowered = value.trim().toLowerCase();
      if (lowered === 'true') return true;
      if (lowered === 'false') return false;
    }
    throw new Error(`Invalid boolean prompt variable '${name}' for '${promptKey}'. Use true/false.`);
  }

  if (normalizedType === 'json') {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return value;
      try {
        JSON.parse(trimmed);
      } catch (_error) {
        throw new Error(`Invalid JSON prompt variable '${name}' for '${promptKey}'.`);
      }
      return value;
    }
    if (typeof value === 'object') return value;
    throw new Error(`Invalid JSON prompt variable '${name}' for '${promptKey}'.`);
  }

  if (normalizedType === 'list') {
    if (Array.isArray(value) || typeof value === 'string') return value;
    throw new Error(`Invalid list prompt variable '${name}' for '${promptKey}'.`);
  }

  if (normalizedType === 'text') {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    throw new Error(`Invalid text prompt variable '${name}' for '${promptKey}'.`);
  }

  return value;
}

function resolvePromptVariables(schema, variables, promptKey) {
  const safeVariables = isPlainObject(variables) ? variables : {};
  const merged = { ...LARC_PROMPT_RUNTIME_DEFAULTS, ...schema.optional, ...safeVariables };
  const missing = schema.required.filter(name => !hasPromptValue(merged[name]));
  if (missing.length > 0) {
    throw new Error(`Missing required prompt variables for '${promptKey}': ${missing.join(', ')}`);
  }

  const namesToValidate = new Set([
    ...(Array.isArray(schema.placeholders) ? schema.placeholders : []),
    ...schema.required
  ]);
  namesToValidate.forEach((name) => {
    if (!hasOwn(merged, name)) return;
    merged[name] = normalizePromptVariableByType(name, merged[name], schema.types[name], promptKey);
  });
  return merged;
}

function fillPromptTemplateStrict(template, variables, schema, promptKey, role) {
  const text = String(template || '');
  const rendered = text.replace(LARC_PROMPT_PLACEHOLDER_REGEX, (_, name) => {
    if (!hasOwn(variables, name)) {
      throw new Error(`Unknown placeholder '{{${name}}}' in ${role} prompt for '${promptKey}'`);
    }
    return formatPromptValue(variables[name], schema.types[name]);
  });

  const unresolved = [...rendered.matchAll(LARC_PROMPT_PLACEHOLDER_REGEX)].map(match => match[1]);
  if (unresolved.length > 0) {
    throw new Error(
      `Unresolved placeholders in ${role} prompt for '${promptKey}': ${[...new Set(unresolved)].join(', ')}`
    );
  }

  return rendered;
}

async function loadPromptText(path) {
  if (!path) return null;
  if (larcPromptTextCache.has(path)) return larcPromptTextCache.get(path);

  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to load prompt text: ${path}`);
  }

  const text = await response.text();
  larcPromptTextCache.set(path, text);
  return text;
}

async function loadLarcSkillMarkdown(path) {
  const normalizedPath = String(path || '').trim();
  if (!normalizedPath) return '';
  if (larcSkillTextCache.has(normalizedPath)) return larcSkillTextCache.get(normalizedPath);

  const response = await fetch(normalizedPath);
  if (!response.ok) {
    throw new Error(`Failed to load skill markdown: ${normalizedPath}`);
  }

  const text = await response.text();
  larcSkillTextCache.set(normalizedPath, text);
  return text;
}

async function loadPromptSchema(path) {
  if (!path) return null;
  if (larcPromptSchemaCache.has(path)) return larcPromptSchemaCache.get(path);

  const response = await fetch(path);
  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`Failed to load prompt schema: ${path}`);
  }

  const parsed = await response.json();
  larcPromptSchemaCache.set(path, parsed);
  return parsed;
}

async function renderLarcPromptPair(promptKey, variables) {
  const bundle = LARC_PROMPT_BUNDLES[promptKey];
  if (!bundle) throw new Error(`Unknown prompt key: ${promptKey}`);

  const systemTemplate = await loadPromptText(bundle.system);
  const userTemplate = await loadPromptText(bundle.user);
  const schema = normalizePromptSchema(await loadPromptSchema(bundle.schema), systemTemplate, userTemplate);
  const resolvedVariables = resolvePromptVariables(schema, variables, promptKey);

  const systemPrompt = fillPromptTemplateStrict(systemTemplate, resolvedVariables, schema, promptKey, 'system');
  const userPrompt = fillPromptTemplateStrict(userTemplate, resolvedVariables, schema, promptKey, 'user');

  return {
    system: systemPrompt,
    user: userPrompt,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  };
}

function resolveLarcModelName() {
  const configuredModel = String(settings?.model || '').trim();
  if (configuredModel) return configuredModel;

  const sharedDefaultModel = String(globalThis.KSUITE_DEFAULT_LLM_MODEL || 'gemma-26b-moe').trim();
  if (sharedDefaultModel) return sharedDefaultModel;

  return 'gemma-26b-moe';
}

const K_LARC_OPENWEBUI_API_FIELD_SPECS = Object.freeze({
  temperature: Object.freeze({ min: 0, max: 2, integer: false }),
  top_p: Object.freeze({ min: 0, max: 1, integer: false }),
  max_tokens: Object.freeze({ min: 1, max: 131072, integer: true }),
  frequency_penalty: Object.freeze({ min: -2, max: 2, integer: false }),
  presence_penalty: Object.freeze({ min: -2, max: 2, integer: false }),
  reasoning_effort: Object.freeze({
    type: 'enum',
    values: Object.freeze(['low', 'medium', 'high'])
  })
});
const K_LARC_DEFAULT_REASONING_EFFORT = 'high';
const K_LARC_RECOMMENDED_STEP_API_OPTIONS = Object.freeze({
  stepAFeatures: Object.freeze({ temperature: 0.2, top_p: 0.9, reasoning_effort: K_LARC_DEFAULT_REASONING_EFFORT }),
  stepQuickAnalysis: Object.freeze({ temperature: 0.15, top_p: 0.9, reasoning_effort: K_LARC_DEFAULT_REASONING_EFFORT }),
  stepBQuery: Object.freeze({ temperature: 0.35, top_p: 0.95, reasoning_effort: K_LARC_DEFAULT_REASONING_EFFORT }),
  stepBRag: Object.freeze({ temperature: 0.05, top_p: 0.9, reasoning_effort: K_LARC_DEFAULT_REASONING_EFFORT }),
  stepBRagRepair: Object.freeze({ temperature: 0, top_p: 0.9, reasoning_effort: K_LARC_DEFAULT_REASONING_EFFORT }),
  stepBMerge: Object.freeze({ temperature: 0, top_p: 0.9, reasoning_effort: K_LARC_DEFAULT_REASONING_EFFORT }),
  stepCMultiJudge: Object.freeze({ temperature: 0.1, top_p: 0.9, reasoning_effort: K_LARC_DEFAULT_REASONING_EFFORT }),
  stepDRepair: Object.freeze({ temperature: 0.25, top_p: 0.9, reasoning_effort: K_LARC_DEFAULT_REASONING_EFFORT }),
  verification: Object.freeze({ temperature: 0, top_p: 0.9, reasoning_effort: K_LARC_DEFAULT_REASONING_EFFORT }),
  opinionNoticeReview: Object.freeze({ temperature: 0.1, top_p: 0.9, reasoning_effort: 'high' }),
  chat: Object.freeze({ temperature: 0.2, top_p: 0.9, reasoning_effort: K_LARC_DEFAULT_REASONING_EFFORT }),
  translation: Object.freeze({ temperature: 0.1, top_p: 0.9, reasoning_effort: K_LARC_DEFAULT_REASONING_EFFORT })
});

function getOpenWebUiApiFieldKeys() {
  if (!Array.isArray(K_LARC_OPENWEBUI_API_FIELDS) || K_LARC_OPENWEBUI_API_FIELDS.length === 0) {
    return ['temperature', 'top_p', 'max_tokens', 'frequency_penalty', 'presence_penalty', 'reasoning_effort'];
  }
  return K_LARC_OPENWEBUI_API_FIELDS.map(field => field.key);
}

function normalizeOpenWebUiApiFieldValue(fieldKey, rawValue) {
  if (rawValue === null || rawValue === undefined) return null;
  const spec = K_LARC_OPENWEBUI_API_FIELD_SPECS[fieldKey];
  if (spec?.type === 'enum') {
    const text = String(rawValue).trim().toLowerCase();
    if (!text) return null;
    const values = Array.isArray(spec.values) ? spec.values : [];
    return values.includes(text) ? text : null;
  }

  const text = typeof rawValue === 'string' ? rawValue.trim() : rawValue;
  if (text === '') return null;

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;

  if (!spec) return parsed;

  let value = parsed;
  if (spec.integer) {
    value = Math.round(value);
  }
  if (Number.isFinite(spec.min) && value < spec.min) value = spec.min;
  if (Number.isFinite(spec.max) && value > spec.max) value = spec.max;
  return value;
}

function normalizeOpenWebUiApiFieldSet(rawSet) {
  const fieldKeys = getOpenWebUiApiFieldKeys();
  const next = typeof createEmptyOpenWebUiApiFieldSet === 'function'
    ? createEmptyOpenWebUiApiFieldSet()
    : Object.fromEntries(fieldKeys.map(key => [key, null]));

  const source = isPlainObject(rawSet) ? rawSet : {};
  fieldKeys.forEach((fieldKey) => {
    next[fieldKey] = normalizeOpenWebUiApiFieldValue(fieldKey, source[fieldKey]);
  });
  return next;
}

function normalizeOpenWebUiApiSettings(rawSettings) {
  const fallback = typeof createDefaultOpenWebUiApiSettings === 'function'
    ? createDefaultOpenWebUiApiSettings()
    : { global: normalizeOpenWebUiApiFieldSet({}), perStep: {} };

  const source = isPlainObject(rawSettings) ? rawSettings : {};
  const normalized = {
    global: normalizeOpenWebUiApiFieldSet(source.global),
    perStep: {}
  };

  const stepOrder = Array.isArray(K_LARC_OPENWEBUI_STEP_ORDER) ? K_LARC_OPENWEBUI_STEP_ORDER : [];
  stepOrder.forEach((stepKey) => {
    const rawStep = isPlainObject(source?.perStep?.[stepKey]) ? source.perStep[stepKey] : {};
    normalized.perStep[stepKey] = {
      enabled: !!rawStep.enabled,
      ...normalizeOpenWebUiApiFieldSet(rawStep)
    };
  });

  if (stepOrder.length === 0) {
    normalized.perStep = fallback.perStep;
  }
  return normalized;
}

function resolveOpenWebUiApiSettings() {
  const normalized = normalizeOpenWebUiApiSettings(settings?.openwebuiApiSettings);
  if (settings) {
    settings.openwebuiApiSettings = normalized;
  }
  return normalized;
}

function getRecommendedStepApiOptions(stepKey) {
  const key = String(stepKey || '').trim();
  if (!key) return {};
  const profile = K_LARC_RECOMMENDED_STEP_API_OPTIONS[key];
  if (!profile || typeof profile !== 'object') return {};
  return { ...profile };
}

function getStepOpenWebUiApiOptions(stepKey) {
  const normalized = resolveOpenWebUiApiSettings();
  const stepConfig = isPlainObject(normalized?.perStep?.[stepKey]) ? normalized.perStep[stepKey] : null;
  const useStepOverride = !!(stepConfig && stepConfig.enabled);

  const options = {};
  getOpenWebUiApiFieldKeys().forEach((fieldKey) => {
    const stepValue = useStepOverride ? stepConfig[fieldKey] : null;
    const value = stepValue !== null && stepValue !== undefined
      ? stepValue
      : normalized.global[fieldKey];
    if (value !== null && value !== undefined) {
      options[fieldKey] = value;
    }
  });
  if (Object.keys(options).length > 0) return options;
  return getRecommendedStepApiOptions(stepKey);
}

function applyStepApiOptions(payload, stepKey) {
  const safePayload = isPlainObject(payload) ? { ...payload } : {};
  const options = getStepOpenWebUiApiOptions(stepKey);
  const merged = Object.keys(options).length === 0
    ? { ...safePayload }
    : { ...safePayload, ...options };
  const normalizedEffort = String(merged.reasoning_effort || '').trim().toLowerCase();
  if (!normalizedEffort || !['low', 'medium', 'high'].includes(normalizedEffort)) {
    merged.reasoning_effort = K_LARC_DEFAULT_REASONING_EFFORT;
  } else {
    merged.reasoning_effort = normalizedEffort;
  }
  return merged;
}

const K_LARC_LLM_TRACE_MAX_STRING_LENGTH = 20000;
const K_LARC_LLM_TRACE_MAX_ARRAY_ITEMS = 80;
const K_LARC_LLM_TRACE_MAX_OBJECT_KEYS = 120;
const K_LARC_LLM_TRACE_MAX_DEPTH = 8;

function truncateLlmTraceString(value, maxLength = K_LARC_LLM_TRACE_MAX_STRING_LENGTH) {
  const text = String(value ?? '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)} ...(truncated ${text.length - maxLength} chars)`;
}

function sanitizeForLlmTrace(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth >= K_LARC_LLM_TRACE_MAX_DEPTH) return '[truncated: max depth]';

  if (typeof value === 'string') {
    return truncateLlmTraceString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'function') {
    return `[function ${value.name || 'anonymous'}]`;
  }

  if (Array.isArray(value)) {
    const sliced = value.slice(0, K_LARC_LLM_TRACE_MAX_ARRAY_ITEMS);
    const sanitized = sliced.map(item => sanitizeForLlmTrace(item, depth + 1));
    const extra = value.length - sliced.length;
    if (extra > 0) {
      sanitized.push(`[... ${extra} more item(s)]`);
    }
    return sanitized;
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value);
    const limitedKeys = keys.slice(0, K_LARC_LLM_TRACE_MAX_OBJECT_KEYS);
    const sanitized = {};
    limitedKeys.forEach((key) => {
      sanitized[key] = sanitizeForLlmTrace(value[key], depth + 1);
    });
    const extra = keys.length - limitedKeys.length;
    if (extra > 0) {
      sanitized.__truncated_keys__ = extra;
    }
    return sanitized;
  }

  return String(value);
}

function buildLlmTraceEntry(requestPayload, rawResponse, options, requestedAt, respondedAt) {
  const safeOptions = isPlainObject(options) ? options : {};
  const responseText = String(rawResponse?.data?.choices?.[0]?.message?.content || '').trim();
  const stepKey = String(safeOptions.stepKey || '').trim();
  const promptKey = String(safeOptions.promptKey || stepKey || '').trim();
  const label = String(safeOptions.label || '').trim();

  return {
    traceId: `llm_${respondedAt}_${Math.random().toString(36).slice(2, 8)}`,
    requestedAt: new Date(requestedAt).toISOString(),
    respondedAt: new Date(respondedAt).toISOString(),
    elapsedMs: Math.max(0, respondedAt - requestedAt),
    mode: settings?.mockMode ? 'mock' : 'live',
    stepKey,
    promptKey,
    label,
    request: sanitizeForLlmTrace(requestPayload),
    response: sanitizeForLlmTrace(rawResponse),
    responseText: responseText ? truncateLlmTraceString(responseText) : ''
  };
}

function attachLlmTraceToResponse(rawResponse, traceEntry) {
  if (rawResponse && typeof rawResponse === 'object' && !Array.isArray(rawResponse)) {
    return {
      ...rawResponse,
      _llmTrace: traceEntry
    };
  }
  return {
    ok: false,
    error: 'Invalid LLM response format.',
    _llmTrace: traceEntry
  };
}

function collectLlmTrace(traceEntry, options) {
  const safeOptions = isPlainObject(options) ? options : {};
  if (Array.isArray(safeOptions.collector)) {
    safeOptions.collector.push(traceEntry);
  }
  if (typeof safeOptions.onTrace === 'function') {
    try {
      safeOptions.onTrace(traceEntry);
    } catch (error) {
      console.warn('Failed to collect LLM trace:', error);
    }
  }
}

async function sendLLMRequest(payload, options = {}) {
  const requestedAt = Date.now();
  let rawResponse = null;

  if (settings.mockMode) {
    rawResponse = await buildMockLLMResponse(payload);
  } else {
    rawResponse = await new Promise(resolve => {
      chrome.runtime.sendMessage({
        type: 'ANALYZE_CLAIM',
        payload,
        baseUrl: settings.url,
        apiKey: settings.key
      }, resolve);
    });
  }

  const normalizedResponse = (rawResponse && typeof rawResponse === 'object')
    ? rawResponse
    : { ok: false, error: 'Empty LLM response.' };
  const respondedAt = Date.now();
  const traceEntry = buildLlmTraceEntry(payload, normalizedResponse, options, requestedAt, respondedAt);
  collectLlmTrace(traceEntry, options);
  return attachLlmTraceToResponse(normalizedResponse, traceEntry);
}

async function translateSourceTextToKorean(sourceText) {
  const normalizedText = String(sourceText || '').trim();
  if (!normalizedText) {
    throw new Error('\uBC88\uC5ED\uD560 \uC6D0\uBB38\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.');
  }

  const payload = applyStepApiOptions({
    model: resolveLarcModelName(),
    messages: [
      {
        role: 'system',
        content: [
          'You are a professional translator for patent and technical documents.',
          'Translate the user-provided source text into Korean.',
          'Preserve the original structure, line breaks, labels, paragraph markers, claim numbers, and bracketed tokens when possible.',
          'Do not summarize, omit content, or add explanations.',
          'Return only the Korean translation.'
        ].join(' ')
      },
      {
        role: 'user',
        content: `[[K_LARC_TRANSLATE_SOURCE_TO_KO]]\n${normalizedText}`
      }
    ]
  }, 'translation');

  const response = await sendLLMRequest(payload);
  const translatedText = String(response?.data?.choices?.[0]?.message?.content || '').trim();
  if (response?.ok && translatedText) {
    return translatedText;
  }

  throw new Error(response?.error || '\uBC88\uC5ED \uC694\uCCAD\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.');
}

function mockResponseFromObject(obj) {
  return {
    ok: true,
    data: {
      choices: [
        {
          message: {
            content: JSON.stringify(obj, null, 2)
          }
        }
      ]
    }
  };
}

function extractBetween(text, startMarker, endMarker) {
  const normalizedText = String(text || '').replace(/\r\n/g, '\n');
  const normalizedStart = String(startMarker || '').replace(/\r\n/g, '\n');
  const normalizedEnd = endMarker ? String(endMarker).replace(/\r\n/g, '\n') : '';

  const startIndex = normalizedText.indexOf(normalizedStart);
  if (startIndex === -1) return '';
  const from = startIndex + normalizedStart.length;
  const endIndex = normalizedEnd ? normalizedText.indexOf(normalizedEnd, from) : -1;
  if (endIndex === -1) return normalizedText.slice(from).trim();
  return normalizedText.slice(from, endIndex).trim();
}

const MOCK_DOC_FIXTURE_KEYS = ['D1', 'D2', 'D3', 'D4', 'D5'];
const MOCK_PARAGRAPH_KEYS = ['[0010]', '[0012]', '[0015]', '[0020]', '[0024]', '[0030]', '[0035]', '[0040]'];
const MOCK_FEATURE_TEMPLATES = [
  'A sensor module measures an external input signal and outputs sampling data.',
  'A preprocessing unit filters noise from the sampling data and normalizes amplitude.',
  'A feature extractor derives a state vector using frequency and trend components.',
  'A decision unit compares the state vector with reference thresholds for classification.',
  'A control unit adjusts an actuator according to the classification result.',
  'A feedback loop updates control parameters based on a measured output response.'
];
const MOCK_CLAIM_FIXTURES = [
  [
    'A system includes a sensor module, preprocessing unit, feature extractor, and decision unit.',
    'The control unit drives an actuator based on a classification result.',
    'A feedback loop updates control parameters using measured output response.'
  ].join(' '),
  [
    'A diagnostic apparatus receives vibration and temperature signals from rotating equipment.',
    'A fusion model estimates a fault score and outputs a maintenance trigger when a threshold is exceeded.',
    'The trigger is corrected by confidence calibration using historical operation profiles.'
  ].join(' '),
  [
    'A vision pipeline captures an image stream and detects a target region with a lightweight detector.',
    'A tracking block predicts motion vectors and smooths jitter using temporal filtering.',
    'A control command is generated for autonomous alignment based on the tracked target position.'
  ].join(' '),
  [
    'A network security gateway extracts packet metadata and behavioral signatures in real time.',
    'A policy engine assigns risk levels using anomaly and rule-based hybrid scoring.',
    'An adaptive response controller updates blocking policies according to verified incident feedback.'
  ].join(' ')
];

function getMockDocNameByIndex(index) {
  const safeIndex = Number.isFinite(index) ? Math.max(0, index) : 0;
  return MOCK_DOC_FIXTURE_KEYS[safeIndex % MOCK_DOC_FIXTURE_KEYS.length];
}

function getMockClaimFixtures() {
  return [...MOCK_CLAIM_FIXTURES];
}

function getMockDefaultClaimText() {
  return MOCK_CLAIM_FIXTURES[0];
}

function buildMockParagraphMap(docName) {
  const doc = String(docName || 'D1').trim() || 'D1';
  const variantByDoc = {
    D1: 'baseline architecture',
    D2: 'equivalent control flow',
    D3: 'implementation-level refinement',
    D4: 'safety-oriented fallback strategy',
    D5: 'multi-sensor redundancy scheme'
  };
  const variant = variantByDoc[doc] || 'implementation-level refinement';

  return {
    '[0010]': `${doc} describes a ${variant} with sensor sampling and preprocessing steps.`,
    '[0012]': `${doc} explains noise filtering and normalization before feature extraction.`,
    '[0015]': `${doc} defines feature extraction with frequency-domain and trend-domain vectors.`,
    '[0020]': `${doc} presents threshold-based decision logic for state classification.`,
    '[0024]': `${doc} shows control command generation linked to classification outcomes.`,
    '[0030]': `${doc} states actuator operation under dynamic control parameters.`,
    '[0035]': `${doc} introduces closed-loop feedback from measured output response.`,
    '[0040]': `${doc} updates model coefficients and control gains using feedback history.`
  };
}

function buildMockCitationPayload(docName, title) {
  const doc = String(docName || 'D1').trim() || 'D1';
  const rawParagraphs = buildMockParagraphMap(doc);
  const rawClaims = {
    'Claim 1': `${doc} discloses sensing, classification, and control integration.`,
    'Claim 2': `${doc} discloses adaptive feedback-based parameter tuning.`
  };

  const paragraphs = {};
  const claims = {};
  const sentinelMap = {};
  let order = 0;

  Object.entries(rawParagraphs)
    .sort((a, b) => parseParagraphNumberFromKey(a[0]) - parseParagraphNumberFromKey(b[0]))
    .forEach(([key, text]) => {
      order += 1;
      const id = formatSentinelId(order);
      paragraphs[key] = wrapWithSentinel(id, text);
      sentinelMap[id] = {
        id,
        order,
        source: 'mock',
        targetType: 'paragraph',
        sourceKey: key,
        displayKey: key
      };
    });

  Object.entries(rawClaims)
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'ko'))
    .forEach(([key, text]) => {
      order += 1;
      const id = formatSentinelId(order);
      claims[key] = wrapWithSentinel(id, text);
      sentinelMap[id] = {
        id,
        order,
        source: 'mock',
        targetType: 'claim',
        sourceKey: key,
        displayKey: key
      };
    });

  return {
    paragraphs,
    claims,
    sentinelMap,
    meta: {
      docName: doc,
      title: title || doc,
      source: 'mock',
      paragraphCount: Object.keys(paragraphs).length,
      claimCount: Object.keys(claims).length,
      sentinelCount: Object.keys(sentinelMap).length,
      chunkSize: CITATION_SENTINEL_CHUNK_SIZE
    }
  };
}

function buildMockCitationFixtures() {
  return MOCK_DOC_FIXTURE_KEYS.map((docName) => {
    const title = docName;
    const payload = buildMockCitationPayload(docName, title);
    const payloadText = JSON.stringify(payload, null, 2);
    const uploadText = buildUploadTextFromCitationPayload(payload);
    return {
      name: docName,
      title,
      fileId: `mock-file-${docName.toLowerCase()}`,
      status: 'completed',
      text: uploadText,
      payloadText
    };
  });
}

function getMockDocNames() {
  const docs = citations
    .filter(c => c.status === 'completed')
    .map(c => c.name)
    .filter(Boolean);
  return docs.length > 0 ? docs : ['D1', 'D2'];
}

function buildMockClaimFeatures(claimText) {
  const normalized = String(claimText || '').replace(/\s+/g, ' ').trim();
  const chunks = normalized
    .split(/[.;\n]/g)
    .map(v => v.trim())
    .filter(v => v.length >= 4);

  const unique = [];
  chunks.forEach(chunk => {
    if (!unique.includes(chunk)) unique.push(chunk);
  });

  const picked = unique.slice(0, 4);
  if (picked.length === 0 && normalized) picked.push(normalized.slice(0, 120));
  if (picked.length === 0) picked.push('핵심 구성요소');

  return picked.map((description, idx) => ({
    Id: `F${idx + 1}`,
    Description: description
  }));
}

function buildMockRelevant(features, labelSuffix) {
  const docs = getMockDocNames();
  const relevant = {};

  (features || []).forEach((feature, idx) => {
    const docName = docs[idx % docs.length];
    if (!relevant[docName]) relevant[docName] = [];

    relevant[docName].push({
      Feature: feature.Id || `F${idx + 1}`,
      MatchType: idx % 2 === 0 ? 'Explicit' : 'Equivalent',
      Content: `${docName}에서 ${feature.Description || '구성요소'} 관련 문장 (${labelSuffix || 'Mock'})`,
      Position: `문단 ${idx + 1}`
    });
  });

  return relevant;
}

// Mock dataset override: richer demo with 6 features, up to 5 docs, and paragraph positions.
function getMockDocNames() {
  const docs = citations
    .filter(c => c.status === 'completed')
    .map(c => c.name)
    .filter(Boolean);

  const ordered = [...MOCK_DOC_FIXTURE_KEYS, ...docs];
  const unique = [];
  ordered.forEach(name => {
    const normalized = String(name || '').trim();
    if (!normalized) return;
    if (!unique.includes(normalized)) unique.push(normalized);
  });

  return unique.slice(0, 5);
}

function buildMockClaimFeatures(claimText) {
  const normalized = String(claimText || '').replace(/\s+/g, ' ').trim();
  const chunks = normalized
    .split(/[.;\n]/g)
    .map(v => v.trim())
    .filter(v => v.length >= 4);

  const unique = [];
  chunks.forEach(chunk => {
    if (!unique.includes(chunk)) unique.push(chunk);
  });

  const picked = unique.slice(0, 6);
  if (picked.length === 0 && normalized) picked.push(normalized.slice(0, 180));

  let templateIndex = 0;
  while (picked.length < 6) {
    const template = MOCK_FEATURE_TEMPLATES[templateIndex % MOCK_FEATURE_TEMPLATES.length];
    if (!picked.includes(template)) picked.push(template);
    templateIndex += 1;
  }

  return picked.map((description, idx) => ({
    Id: `F${idx + 1}`,
    Description: description
  })).slice(0, 6);
}

function buildMockRelevant(features, labelSuffix) {
  const docs = getMockDocNames();
  const relevant = {};
  const positions = MOCK_PARAGRAPH_KEYS;

  function buildMockGroundedItem(docName, feature, matchType, startSourceKey, endSourceKey, summaryText) {
    const payload = buildMockCitationPayload(docName, docName);
    const sentinelEntries = Object.entries(payload?.sentinelMap || {})
      .map(([id, entry]) => ({
        id: formatSentinelId(id),
        sourceKey: String(entry?.sourceKey || '').trim()
      }));
    const startEntry = sentinelEntries.find(entry => entry.sourceKey === String(startSourceKey || '').trim());
    const endEntry = sentinelEntries.find(entry => entry.sourceKey === String(endSourceKey || startSourceKey || '').trim());
    const startId = startEntry?.id || '0001';
    const endId = endEntry?.id || startId;
    const collected = getSentinelRangeSourceText(payload, startId, endId);

    return {
      Feature: feature.Id || 'F1',
      MatchType: matchType,
      Content: summaryText,
      SourceExcerpt: collected.text || `${docName} mock source excerpt for ${feature.Description || 'feature'}.`,
      Position: formatSentinelRange(startId, endId)
    };
  }

  (features || []).forEach((feature, idx) => {
    const primaryDoc = docs[idx % docs.length];
    const secondaryDoc = docs[(idx + 1) % docs.length];
    const primaryPos = positions[idx % positions.length];
    const secondaryStart = positions[(idx + 1) % positions.length];
    const secondaryEnd = positions[(idx + 2) % positions.length];

    if (!relevant[primaryDoc]) relevant[primaryDoc] = [];
    relevant[primaryDoc].push(buildMockGroundedItem(
      primaryDoc,
      feature,
      idx % 2 === 0 ? 'Explicit' : 'Equivalent',
      primaryPos,
      primaryPos,
      `${primaryDoc} contains evidence aligned with ${feature.Description || 'feature'} (${labelSuffix || 'Mock'}).`
    ));

    if (idx % 2 === 1) {
      if (!relevant[secondaryDoc]) relevant[secondaryDoc] = [];
      relevant[secondaryDoc].push(buildMockGroundedItem(
        secondaryDoc,
        feature,
        'Equivalent',
        secondaryStart,
        secondaryEnd,
        `${secondaryDoc} provides functionally equivalent support for ${feature.Description || 'feature'} (${labelSuffix || 'Mock'}).`
      ));
    }
  });

  return relevant;
}

async function buildMockLLMResponse(payload) {
  await new Promise(resolve => setTimeout(resolve, 220));

  try {
    const userMessage = payload?.messages?.find(m => m.role === 'user')?.content || '';

    if (userMessage.includes('[[K_LARC_TRANSLATE_SOURCE_TO_KO]]')) {
      const sourceText = extractBetween(userMessage, '[[K_LARC_TRANSLATE_SOURCE_TO_KO]]\n');
      return {
        ok: true,
        data: {
          choices: [
            {
              message: {
                content: `[\uBAA8\uC758 \uBC88\uC5ED]\n${String(sourceText || '').trim()}`
              }
            }
          ]
        }
      };
    }

    if (userMessage.includes('Step B-2 Repair Request for Query Bundle #')) {
      const repairBlock = extractBetween(userMessage, 'Repair Request (JSON):\n', '\n\nInstructions:');
      const repairRequest = safeJsonParse(repairBlock) || {};
      const features = Array.isArray(repairRequest?.target_features) && repairRequest.target_features.length > 0
        ? repairRequest.target_features.map((entry, index) => ({
          Id: entry?.Feature || entry?.Id || `F${index + 1}`,
          Description: entry?.Description || entry?.Query || `Repair feature ${index + 1}`
        }))
        : (repairRequest?.invalid_items || []).map((entry, index) => ({
          Id: entry?.item?.Feature || `F${index + 1}`,
          Description: entry?.item?.Content || entry?.validationMessage || `Repair feature ${index + 1}`
        }));
      return mockResponseFromObject({ Relevant: buildMockRelevant(features, 'B2 Repair') });
    }

    if (
      userMessage.includes('Claim Features (JSON):') &&
      !userMessage.includes('Step A Claim Features (JSON):')
    ) {
      const block = extractBetween(userMessage, 'Claim Features (JSON):\n');
      const claimFeatures = safeJsonParse(block);
      const queries = {};
      (claimFeatures || []).forEach(feature => {
        const base = [
          feature.Description,
          `${feature.Description} 기능`,
          `${feature.Description} 구조`
        ];
        queries[feature.Id] = ensureQueryCount(feature, base, 6);
      });
      return mockResponseFromObject({ Queries: queries });
    }

    if (userMessage.includes('Query Bundle #')) {
      const block = extractBetween(userMessage, 'Features (JSON):\n');
      const features = safeJsonParse(block);
      return mockResponseFromObject({ Relevant: buildMockRelevant(features, 'B2') });
    }

    if (userMessage.includes('Step B-2 Responses (JSON):')) {
      const block = extractBetween(userMessage, 'Step B-2 Responses (JSON):\n');
      const responses = safeJsonParse(block);
      let merged = {};
      (responses || []).forEach(entry => {
        merged = mergeRelevantWithPositions(merged, entry?.Relevant || {});
      });
      return mockResponseFromObject({ Relevant: merged, mockMerged: true });
    }

    if (userMessage.includes('Quick Mode Input (JSON):')) {
      const quickBlock = extractBetween(userMessage, 'Quick Mode Input (JSON):\n', '\n\nTarget Claim:\n');
      const quickInput = safeJsonParse(quickBlock) || {};
      const claimFeatures = buildMockClaimFeatures(quickInput.claimText || quickInput.claim || '');
      const baseRelevant = buildMockRelevant(claimFeatures, 'Quick');
      const relevant = {};
      const verification = {};

      Object.entries(baseRelevant || {}).forEach(([docName, items]) => {
        if (!Array.isArray(items)) return;
        relevant[docName] = items.map((item, idx) => {
          const flag = idx % 3 === 0 ? 'F' : 'P';
          const key = `${item.Feature}_${docName}`;
          if (verification[key] !== 'F') verification[key] = flag;
          return {
            ...item,
            Verification: flag
          };
        });
      });

      const featureStatus = {};
      claimFeatures.forEach(feature => {
        featureStatus[feature.Id] = 'ENTAIL';
      });

      return mockResponseFromObject({
        ClaimFeatures: claimFeatures,
        FeatureStatus: featureStatus,
        Relevant: relevant,
        Verification: verification
      });
    }

    if (userMessage.includes('Step A Claim Features (JSON):')) {
      const judgeBlock = userMessage.includes('Judge Profile (JSON):')
        ? extractBetween(userMessage, 'Judge Profile (JSON):\n', '\n\nTarget Claim:')
        : '{}';
      const judgeProfile = safeJsonParse(judgeBlock) || {};
      const judgeId = String(judgeProfile?.judge_id || judgeProfile?.id || '').trim().toUpperCase();
      const stepBMarker = userMessage.includes('Step B Merged Relevant (JSON):')
        ? 'Step B Merged Relevant (JSON):'
        : 'Step B Output (JSON):';
      const featureBlock = extractBetween(
        userMessage,
        'Step A Claim Features (JSON):\n',
        `\n\n${stepBMarker}`
      );
      const stepBBlock = extractBetween(userMessage, `${stepBMarker}\n`);
      const claimFeatures = safeJsonParse(featureBlock);
      const parsedStepB = safeJsonParse(stepBBlock);
      const stepBMergedRelevant = parsedStepB?.Relevant || parsedStepB || {};
      const featureStatus = {};
      const evidenceDecision = {};
      const featureRank = {};

      const updateFeatureRank = (featureId, rank) => {
        const id = String(featureId || '').trim();
        if (!id) return;
        const prev = Number.isFinite(featureRank[id]) ? featureRank[id] : -1;
        if (rank > prev) featureRank[id] = rank;
      };

      Object.values(stepBMergedRelevant || {}).forEach(items => {
        if (!Array.isArray(items)) return;
        items.forEach(item => {
          const evidenceId = String(item?.EvidenceId || item?.evidenceId || '').trim();
          if (!evidenceId) return;
          const matchType = String(item?.MatchType || item?.matchType || '').trim().toLowerCase();
          const featureId = String(item?.Feature || item?.feature || '').trim();
          const order = Number.parseInt(evidenceId.replace(/\D/g, ''), 10) || 0;

          let decision = 'F';
          if (judgeId === 'J_STRICT' || judgeId === 'J_LEGACY') {
            decision = matchType === 'explicit' ? 'P' : 'F';
          } else if (judgeId === 'J_EQUIV') {
            decision = (matchType === 'explicit' || matchType === 'equivalent') ? 'P' : 'F';
          } else if (judgeId === 'J_SKEPTIC') {
            decision = (matchType === 'explicit' && order % 2 === 1) ? 'P' : 'F';
          } else {
            decision = (matchType === 'explicit' || (matchType === 'equivalent' && order % 3 !== 0)) ? 'P' : 'F';
          }

          evidenceDecision[evidenceId] = decision;
          if (decision === 'P') {
            const rank = matchType === 'explicit' ? 2 : (matchType === 'equivalent' ? 1 : 0);
            updateFeatureRank(featureId, rank);
          }
        });
      });

      (claimFeatures || []).forEach(feature => {
        const featureId = String(feature?.Id || '').trim();
        if (!featureId) return;
        const rank = Number.isFinite(featureRank[featureId]) ? featureRank[featureId] : -1;
        if (rank >= 2) {
          featureStatus[featureId] = 'ENTAIL';
        } else if (rank >= 1) {
          featureStatus[featureId] = 'PARTIAL';
        } else {
          featureStatus[featureId] = 'NOT_FOUND';
        }
      });

      return mockResponseFromObject({
        FeatureStatus: featureStatus,
        EvidenceDecision: evidenceDecision,
        mockJudge: true,
        judgeId: judgeId || 'DEFAULT'
      });
    }

    if (userMessage.includes('Missing Features (JSON):')) {
      const missingBlock = extractBetween(
        userMessage,
        'Missing Features (JSON):\n',
        '\n\nCurrent Relevant (JSON):'
      );
      const missing = safeJsonParse(missingBlock);
      return mockResponseFromObject({ Relevant: buildMockRelevant(missing, 'D') });
    }

    if (userMessage.includes('**[1차 분석 결과 (JSON)]**')) {
      const summaryBlock = extractBetween(
        userMessage,
        '**[1차 분석 결과 (JSON)]**\n',
        '\n\n**[지시]**'
      );
      const summary = safeJsonParse(summaryBlock);
      const verifications = {};

      const claimIds = Object.keys(summary || {});
      if (claimIds.length > 0) {
        const claimId = claimIds[0];
        const relevant = summary?.[claimId]?.Relevant || {};
        const firstDoc = Object.keys(relevant)[0];
        const firstItem = Array.isArray(relevant[firstDoc]) ? relevant[firstDoc][0] : null;
        const firstEvidenceId = normalizeEvidenceId(firstItem?.EvidenceId || firstItem?.evidenceId);

        if (firstEvidenceId) {
          verifications[`${claimId}_${firstEvidenceId}`] = {
            status: 'caution',
            reason: `[Mock 검증] '${firstEvidenceId}' 증거는 보완 확인이 필요하다는 가정 결과입니다.`
          };
        } else if (firstDoc && firstItem?.Feature) {
          verifications[`${claimId}_${firstItem.Feature}_${firstDoc}`] = {
            status: 'caution',
            reason: `[Mock 검증] '${firstItem.Feature}' 항목은 보완 확인이 필요하다는 가정 결과입니다.`
          };
        }
      }

      return mockResponseFromObject({ verifications });
    }

    if (userMessage.includes('[Claim ID:')) {
      const claimMarkerMatch = userMessage.match(/\[Claim ID:\s*([^\]]+)\]/);
      const claimMarker = claimMarkerMatch?.[0] || '';
      const markerIndex = claimMarker ? userMessage.indexOf(claimMarker) : -1;
      const claimText = markerIndex >= 0
        ? userMessage.slice(markerIndex + claimMarker.length).trim()
        : userMessage.split('\n').slice(1).join('\n').trim();
      return mockResponseFromObject({ ClaimFeatures: buildMockClaimFeatures(claimText) });
    }

    return mockResponseFromObject({ mock: true });
  } catch (error) {
    return { ok: false, error: `Mock 응답 생성 실패: ${error.message}` };
  }
}

function buildFileRefs(fileIds) {
  return fileIds.map(id => ({ type: 'file', id: id }));
}

function normalizeEvidenceId(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  return normalized;
}

function normalizeRelevantItemRecord(raw, featureFallback = '') {
  return {
    EvidenceId: normalizeEvidenceId(raw?.EvidenceId || raw?.evidenceId || raw?.evidence_id || ''),
    Feature: String(raw?.Feature || raw?.feature || featureFallback || '').trim(),
    MatchType: String(raw?.MatchType || raw?.matchType || raw?.match_type || '').trim(),
    Content: String(raw?.Content || raw?.content || '').trim(),
    SourceExcerpt: String(raw?.SourceExcerpt || raw?.sourceExcerpt || raw?.source_excerpt || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim(),
    Position: normalizePositionText(String(raw?.Position || raw?.position || '').trim())
  };
}

function getRelevantMatchTypeRank(matchType) {
  const normalized = String(matchType || '').trim().toLowerCase();
  if (normalized === 'explicit') return 2;
  if (normalized === 'equivalent') return 1;
  return 0;
}

function chooseMergedRelevantContent(currentContent, nextContent) {
  const current = String(currentContent || '').trim();
  const next = String(nextContent || '').trim();
  if (!current) return next;
  if (!next) return current;
  if (next.length > current.length) return next;
  return current;
}

function mergeRelevantBySnippet(relevant, options = {}) {
  const dropSourceExcerpt = options.dropSourceExcerpt !== false;
  const merged = {};

  Object.entries(relevant || {}).forEach(([docName, items]) => {
    if (!Array.isArray(items)) return;
    const bucket = new Map();
    const keyOrder = [];

    items.forEach((rawItem) => {
      const item = normalizeRelevantItemRecord(rawItem);
      if (!item.Feature || !item.MatchType || !item.Content) return;

      const normalizedPosition = normalizePositionText(item.Position || '');
      const normalizedExcerpt = normalizeGroundingComparisonText(item.SourceExcerpt || '');
      const snippetKey = normalizedPosition || (normalizedExcerpt ? `excerpt:${normalizedExcerpt}` : '');
      const evidenceKeySuffix = item.EvidenceId ? `||eid:${item.EvidenceId}` : '';
      const mergeKey = snippetKey
        ? `${item.Feature}||${snippetKey}${evidenceKeySuffix}`
        : `${item.Feature}||fallback||${item.MatchType}||${item.Content}${evidenceKeySuffix}`;

      if (!bucket.has(mergeKey)) {
        const seed = {
          EvidenceId: item.EvidenceId || '',
          Feature: item.Feature,
          MatchType: item.MatchType,
          Content: item.Content,
          Position: normalizedPosition
        };
        if (!dropSourceExcerpt && item.SourceExcerpt) {
          seed.SourceExcerpt = item.SourceExcerpt;
        }
        bucket.set(mergeKey, seed);
        keyOrder.push(mergeKey);
        return;
      }

      const existing = bucket.get(mergeKey);
      if (!existing) return;

      if (!existing.EvidenceId && item.EvidenceId) {
        existing.EvidenceId = item.EvidenceId;
      }
      if (getRelevantMatchTypeRank(item.MatchType) > getRelevantMatchTypeRank(existing.MatchType)) {
        existing.MatchType = item.MatchType;
      }
      existing.Content = chooseMergedRelevantContent(existing.Content, item.Content);
      existing.Position = mergePositionText(existing.Position, normalizedPosition);

      if (!dropSourceExcerpt) {
        if (!existing.SourceExcerpt && item.SourceExcerpt) {
          existing.SourceExcerpt = item.SourceExcerpt;
        }
      } else {
        delete existing.SourceExcerpt;
      }
    });

    const deduped = keyOrder
      .map(key => bucket.get(key))
      .filter(Boolean);
    if (deduped.length > 0) {
      merged[docName] = deduped;
    }
  });

  return merged;
}

function makeRelevantKey(item) {
  const normalized = normalizeRelevantItemRecord(item);
  return [normalized.Feature, normalized.MatchType, normalized.Content, normalized.SourceExcerpt, normalized.Position]
    .map(v => (v || '').trim())
    .join('||');
}

function mergeRelevant(base, extra) {
  const merged = JSON.parse(JSON.stringify(base || {}));
  Object.entries(extra || {}).forEach(([doc, items]) => {
    if (!Array.isArray(items)) return;
    if (!merged[doc]) merged[doc] = [];
    items.forEach(raw => {
      const item = normalizeRelevantItemRecord(raw);
      if (!item.Feature || !item.MatchType || !item.Content) return;
      const existing = merged[doc].find((entry) => {
        const existingItem = normalizeRelevantItemRecord(entry);
        const evidenceCompatible = !existingItem.EvidenceId
          || !item.EvidenceId
          || existingItem.EvidenceId === item.EvidenceId;
        const excerptsCompatible = !existingItem.SourceExcerpt
          || !item.SourceExcerpt
          || existingItem.SourceExcerpt === item.SourceExcerpt;
        return existingItem.Feature === item.Feature
          && existingItem.MatchType === item.MatchType
          && existingItem.Content === item.Content
          && existingItem.Position === item.Position
          && evidenceCompatible
          && excerptsCompatible;
      });
      if (existing) {
        if (!existing.EvidenceId && item.EvidenceId) {
          existing.EvidenceId = item.EvidenceId;
        }
        if (!existing.SourceExcerpt && item.SourceExcerpt) {
          existing.SourceExcerpt = item.SourceExcerpt;
        }
      } else {
        merged[doc].push(item);
      }
    });
  });
  return merged;
}

function getSentinelDigits() {
  const parsed = Number.parseInt(CITATION_SENTINEL_DIGITS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
}

function formatSentinelId(value) {
  const digits = getSentinelDigits();
  const number = Number.parseInt(value, 10);
  const safe = Number.isFinite(number) ? Math.max(0, number) : 0;
  return String(safe).padStart(digits, '0');
}

function formatSentinelOpenToken(id) {
  return `⟪${formatSentinelId(id)}⟫`;
}

function formatSentinelCloseToken(id) {
  return `⟪/${formatSentinelId(id)}⟫`;
}

function parseSentinelToken(token) {
  const match = String(token || '').trim().match(/^⟪\s*(\/)?\s*(\d{1,8})\s*⟫$/);
  if (!match) return null;
  return {
    id: formatSentinelId(match[2]),
    isClose: Boolean(match[1])
  };
}

function parseSentinelPositionRange(token) {
  const text = String(token || '').trim();
  if (!text) return null;
  const rangeMatch = text.match(
    /^⟪\s*\/?\s*(\d{1,8})\s*⟫\s*(?:-|~|to|through|until|from)\s*⟪\s*\/?\s*(\d{1,8})\s*⟫$/i
  );
  if (!rangeMatch) return null;

  const start = Number.parseInt(rangeMatch[1], 10);
  const end = Number.parseInt(rangeMatch[2], 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  const normalizedStart = Math.min(start, end);
  const normalizedEnd = Math.max(start, end);
  return {
    start: formatSentinelId(normalizedStart),
    end: formatSentinelId(normalizedEnd)
  };
}

function formatSentinelRange(start, end) {
  const startId = formatSentinelId(start);
  const endId = formatSentinelId(end);
  if (startId === endId) return formatSentinelOpenToken(startId);
  return `${formatSentinelOpenToken(startId)}-${formatSentinelOpenToken(endId)}`;
}

function splitPositions(value) {
  return String(value || '')
    .split(/\s*(?:\||;|,)\s*/g)
    .map(v => v.trim())
    .filter(Boolean);
}

function formatParagraphNumberKey(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return null;
  return `[${String(number).padStart(4, '0')}]`;
}

function normalizeParagraphLookupKey(value) {
  const match = String(value || '').match(/\d{1,6}/);
  if (!match) return null;
  return formatParagraphNumberKey(match[0]);
}

function parseParagraphNumberFromKey(value) {
  const normalized = normalizeParagraphLookupKey(value);
  if (!normalized) return null;
  const matched = normalized.match(/\d{1,6}/);
  if (!matched) return null;
  const number = Number.parseInt(matched[0], 10);
  return Number.isFinite(number) ? number : null;
}

function formatClaimPositionRange(start, end) {
  const startNum = Number.parseInt(start, 10);
  const endNum = Number.parseInt(end, 10);
  if (!Number.isFinite(startNum) || !Number.isFinite(endNum)) return '';
  const from = Math.min(startNum, endNum);
  const to = Math.max(startNum, endNum);
  if (from === to) return `청구항 ${from}`;
  return `청구항 ${from}-${to}`;
}

function parseClaimPositionToken(token) {
  const text = String(token || '').trim();
  if (!text) return null;

  const rangePatterns = [
    /^청구항\s*(\d{1,6})\s*(?:-|~|to|through|until|from|내지)\s*(\d{1,6})$/i,
    /^제\s*(\d{1,6})\s*항\s*(?:-|~|to|through|until|from|내지)\s*(?:제\s*)?(\d{1,6})\s*항$/i,
    /^claim\s*#?\s*(\d{1,6})\s*(?:-|~|to|through|until|from)\s*(\d{1,6})$/i
  ];
  for (const pattern of rangePatterns) {
    const matched = text.match(pattern);
    if (!matched) continue;
    const a = Number.parseInt(matched[1], 10);
    const b = Number.parseInt(matched[2], 10);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    return { start: Math.min(a, b), end: Math.max(a, b) };
  }

  const singlePatterns = [
    /^청구항\s*(\d{1,6})$/i,
    /^제\s*(\d{1,6})\s*항$/i,
    /^claim\s*#?\s*(\d{1,6})$/i
  ];
  for (const pattern of singlePatterns) {
    const matched = text.match(pattern);
    if (!matched) continue;
    const value = Number.parseInt(matched[1], 10);
    if (!Number.isFinite(value)) continue;
    return { start: value, end: value };
  }

  return null;
}

function parseNumericPositionToken(token) {
  const text = String(token || '').trim();
  if (!text) return null;

  const rangeMatch = text.match(
    /^[\[\(<]?\s*(\d{1,6})\s*[\]\)>]?\s*(?:-|~|to|through|until|from)\s*[\[\(<]?\s*(\d{1,6})\s*[\]\)>]?$/i
  );
  if (rangeMatch) {
    const a = Number.parseInt(rangeMatch[1], 10);
    const b = Number.parseInt(rangeMatch[2], 10);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      return { start: Math.min(a, b), end: Math.max(a, b) };
    }
  }

  const singleMatch = text.match(/^[\[\(<]?\s*(\d{1,6})\s*[\]\)>]?$/);
  if (singleMatch) {
    const value = Number.parseInt(singleMatch[1], 10);
    if (Number.isFinite(value)) {
      return { start: value, end: value };
    }
  }

  return null;
}

function formatNumericPositionRange(start, end) {
  const startKey = formatParagraphNumberKey(start);
  const endKey = formatParagraphNumberKey(end);
  if (!startKey || !endKey) return '';
  if (start === end) return startKey;
  return `${startKey}-${endKey}`;
}

function parseParagraphKeyRange(rawValue) {
  const text = String(rawValue || '').trim();
  if (!text) return null;

  const sentinelRange = parseSentinelPositionRange(text);
  if (sentinelRange) {
    return {
      kind: 'sentinel',
      isRange: sentinelRange.start !== sentinelRange.end,
      startSentinel: sentinelRange.start,
      endSentinel: sentinelRange.end,
      label: formatSentinelRange(sentinelRange.start, sentinelRange.end)
    };
  }

  const singleSentinel = parseSentinelToken(text);
  if (singleSentinel) {
    return {
      kind: 'sentinel',
      isRange: false,
      startSentinel: singleSentinel.id,
      endSentinel: singleSentinel.id,
      label: formatSentinelOpenToken(singleSentinel.id)
    };
  }

  const claimRange = parseClaimPositionToken(text);
  if (claimRange) {
    return {
      kind: 'claim',
      isRange: claimRange.start !== claimRange.end,
      startClaim: claimRange.start,
      endClaim: claimRange.end,
      label: formatClaimPositionRange(claimRange.start, claimRange.end)
    };
  }

  const numeric = parseNumericPositionToken(text);
  if (!numeric) return null;

  const startKey = formatParagraphNumberKey(numeric.start);
  const endKey = formatParagraphNumberKey(numeric.end);
  if (!startKey || !endKey) return null;

  return {
    kind: 'numeric',
    isRange: numeric.start !== numeric.end,
    start: numeric.start,
    end: numeric.end,
    label: numeric.start === numeric.end ? startKey : `${startKey}-${endKey}`
  };
}

function extractPositionMarkerTokens(positionText) {
  const normalized = normalizePositionText(positionText || '');
  if (!normalized) {
    return { normalized: '', markers: [] };
  }

  const markerRe = /(?:\[(\d{1,6})\](?:\s*-\s*\[(\d{1,6})\])?)|(?:⟪(\d{1,8})⟫(?:\s*-\s*⟪(\d{1,8})⟫)?)|(?:청구항\s*(\d{1,6})(?:\s*(?:-|~|to|through|until|from|내지)\s*(\d{1,6}))?)|(?:제\s*(\d{1,6})\s*항(?:\s*(?:-|~|to|through|until|from|내지)\s*(?:제\s*)?(\d{1,6})\s*항)?)|(?:claim\s*#?\s*(\d{1,6})(?:\s*(?:-|~|to|through|until|from)\s*(\d{1,6}))?)/gi;
  const markers = [];
  let match;
  while ((match = markerRe.exec(normalized)) !== null) {
    const numericStart = formatParagraphNumberKey(match[1]);
    const numericEnd = formatParagraphNumberKey(match[2]);
    const sentinelStart = match[3] ? formatSentinelOpenToken(match[3]) : null;
    const sentinelEnd = match[4] ? formatSentinelOpenToken(match[4]) : null;
    const claimStart = match[5] || match[7] || match[9];
    const claimEnd = match[6] || match[8] || match[10];
    const claimMarker = claimStart ? formatClaimPositionRange(claimStart, claimEnd || claimStart) : null;
    const marker = sentinelStart
      ? (sentinelEnd ? `${sentinelStart}-${sentinelEnd}` : sentinelStart)
      : (claimMarker || (numericEnd ? `${numericStart}-${numericEnd}` : numericStart));
    if (!marker) continue;
    markers.push({
      marker,
      start: match.index,
      end: match.index + match[0].length,
      isRange: Boolean(sentinelEnd || claimEnd || numericEnd)
    });
  }

  return { normalized, markers };
}

function normalizePositionTokens(value) {
  const sentinelRanges = [];
  const sentinelSingles = [];
  const claimRanges = [];
  const claimSingles = [];
  const numericRanges = [];
  const textParts = [];
  const seenSentinelSingle = new Set();
  const seenClaimSingle = new Set();
  const seenText = new Set();

  splitPositions(value).forEach(token => {
    const sentinelRange = parseSentinelPositionRange(token);
    if (sentinelRange) {
      sentinelRanges.push(sentinelRange);
      return;
    }

    const sentinelSingle = parseSentinelToken(token);
    if (sentinelSingle) {
      if (!seenSentinelSingle.has(sentinelSingle.id)) {
        seenSentinelSingle.add(sentinelSingle.id);
        sentinelSingles.push(sentinelSingle.id);
      }
      return;
    }

    const claimToken = parseClaimPositionToken(token);
    if (claimToken) {
      if (claimToken.start === claimToken.end) {
        if (!seenClaimSingle.has(claimToken.start)) {
          seenClaimSingle.add(claimToken.start);
          claimSingles.push(claimToken.start);
        }
      } else {
        claimRanges.push(claimToken);
      }
      return;
    }

    const numeric = parseNumericPositionToken(token);
    if (numeric) {
      numericRanges.push(numeric);
      return;
    }

    if (!seenText.has(token)) {
      seenText.add(token);
      textParts.push(token);
    }
  });

  sentinelRanges.sort((a, b) => {
    if (a.start !== b.start) return Number(a.start) - Number(b.start);
    return Number(b.end) - Number(a.end);
  });

  const compactSentinelRanges = [];
  sentinelRanges.forEach(range => {
    const last = compactSentinelRanges[compactSentinelRanges.length - 1];
    if (!last) {
      compactSentinelRanges.push(range);
      return;
    }
    const isContained = Number(range.start) >= Number(last.start) && Number(range.end) <= Number(last.end);
    if (isContained) return;
    compactSentinelRanges.push(range);
  });

  const remainingSentinelSingles = sentinelSingles.filter((id) =>
    !compactSentinelRanges.some((range) => Number(id) >= Number(range.start) && Number(id) <= Number(range.end))
  );

  remainingSentinelSingles.sort((a, b) => Number(a) - Number(b));

  claimRanges.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - a.end;
  });

  const compactClaimRanges = [];
  claimRanges.forEach((range) => {
    const last = compactClaimRanges[compactClaimRanges.length - 1];
    if (!last) {
      compactClaimRanges.push(range);
      return;
    }
    const isContained = range.start >= last.start && range.end <= last.end;
    if (isContained) return;
    compactClaimRanges.push(range);
  });

  const remainingClaimSingles = claimSingles.filter((value) =>
    !compactClaimRanges.some((range) => value >= range.start && value <= range.end)
  );
  remainingClaimSingles.sort((a, b) => a - b);

  numericRanges.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - a.end;
  });

  const compactNumeric = [];
  numericRanges.forEach(range => {
    const last = compactNumeric[compactNumeric.length - 1];
    if (!last) {
      compactNumeric.push(range);
      return;
    }

    const isContained = range.start >= last.start && range.end <= last.end;
    if (isContained) return;
    compactNumeric.push(range);
  });

  const sentinelRangeText = compactSentinelRanges.map((range) => formatSentinelRange(range.start, range.end));
  const sentinelSingleText = remainingSentinelSingles.map((id) => formatSentinelOpenToken(id));
  const claimRangeText = compactClaimRanges.map((range) => formatClaimPositionRange(range.start, range.end));
  const claimSingleText = remainingClaimSingles.map((value) => formatClaimPositionRange(value, value));
  const numericText = compactNumeric.map(range => formatNumericPositionRange(range.start, range.end));
  return [...sentinelRangeText, ...sentinelSingleText, ...claimRangeText, ...claimSingleText, ...numericText, ...textParts];
}

function normalizePositionText(value) {
  return normalizePositionTokens(value).join(', ');
}

function mergePositionText(a, b) {
  return normalizePositionText(`${a || ''}, ${b || ''}`);
}

function parseCitationPayload(citation) {
  if (!citation || typeof citation !== 'object') return null;
  const payloadText = typeof citation.payloadText === 'string'
    ? citation.payloadText
    : (typeof citation.payload === 'string' ? citation.payload : citation.text);
  if (typeof payloadText !== 'string') return null;
  try {
    const parsed = safeJsonParse(payloadText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch (_error) {
    return null;
  }
}

function resolveCitationByDocName(docName) {
  const target = String(docName || '').trim();
  if (!target) return null;

  const byName = citations.find(c => String(c?.name || '').trim() === target);
  if (byName) return byName;

  const byTitle = citations.find(c => String(c?.title || '').trim() === target);
  if (byTitle) return byTitle;

  const docAlias = target.match(/^D\s*(\d{1,3})$/i);
  if (docAlias) {
    const index = Number.parseInt(docAlias[1], 10) - 1;
    if (Number.isFinite(index) && index >= 0 && index < citations.length) {
      return citations[index];
    }
  }

  return null;
}

function getCitationSentinelMap(citation) {
  const parsed = parseCitationPayload(citation);
  const map = parsed?.sentinelMap;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
  return map;
}

function getCitationSentinelEntry(citation, sentinelId) {
  const map = getCitationSentinelMap(citation);
  const id = formatSentinelId(sentinelId);
  const entry = map?.[id];
  if (!entry || typeof entry !== 'object') return null;
  return entry;
}

function getSentinelDisplayKey(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const custom = String(entry.displayKey || '').trim();
  if (custom) return custom;

  const sourceKey = String(entry.sourceKey || '').trim();
  if (sourceKey) return sourceKey;
  return formatSentinelOpenToken(entry.id);
}

function getSentinelMetaLabel(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const page = Number(entry.pageNumber);
  const pageLabel = Number.isFinite(page) && page > 0 ? `P${String(page).padStart(3, '0')}` : '';
  const sectionId = String(entry.sectionId || '').trim();
  if (pageLabel && sectionId) return `${pageLabel}/${sectionId}`;
  return pageLabel || sectionId;
}

function formatSentinelDisplay(entry, options = {}) {
  const includeMeta = !!options.includeMeta;
  const metaOnly = !!options.metaOnly;
  const sourceType = String(entry?.source || '').trim().toLowerCase();
  const displayKey = getSentinelDisplayKey(entry) || formatSentinelOpenToken(entry?.id || '0000');
  const meta = getSentinelMetaLabel(entry);
  if (!includeMeta) return displayKey;
  if (metaOnly && meta && sourceType === 'pdf') return meta;
  if (!meta) return displayKey;
  return `${displayKey} (${meta})`;
}

function transformPositionTextForDisplay(positionText, docName, options = {}) {
  const normalized = normalizePositionText(positionText || '');
  if (!normalized) return '';

  const citation = resolveCitationByDocName(docName);
  if (!citation) return normalized;

  return normalized.replace(/⟪(?:\/)?(\d{4})⟫/g, (_matched, idText) => {
    const entry = getCitationSentinelEntry(citation, idText);
    if (!entry) return formatSentinelOpenToken(idText);
    return formatSentinelDisplay(entry, options);
  });
}

const VERIFICATION_GROUNDING_MAX_POSITION_TOKENS = 8;
const VERIFICATION_GROUNDING_MAX_SNIPPETS_PER_ITEM = 3;
const VERIFICATION_GROUNDING_MAX_RANGE_SPAN = 24;
const VERIFICATION_GROUNDING_MAX_SNIPPET_CHARS = 320;
const VERIFICATION_GROUNDING_MAX_LIST_ITEMS = 8;

function truncateVerificationGroundingText(text, maxLength = VERIFICATION_GROUNDING_MAX_SNIPPET_CHARS) {
  const normalized = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
  const limit = Number.isFinite(Number(maxLength)) ? Math.max(60, Number(maxLength)) : VERIFICATION_GROUNDING_MAX_SNIPPET_CHARS;
  if (!normalized) return '';
  if (normalized.length <= limit) return normalized;
  const clipped = normalized.slice(0, limit).trim();
  return `${clipped} ...(truncated)`;
}

function normalizeGroundingList(values, limit = VERIFICATION_GROUNDING_MAX_LIST_ITEMS) {
  const maxItems = Number.isFinite(Number(limit)) ? Math.max(1, Number(limit)) : VERIFICATION_GROUNDING_MAX_LIST_ITEMS;
  const unique = [...new Set(
    (Array.isArray(values) ? values : [])
      .map(value => String(value || '').trim())
      .filter(Boolean)
  )];
  return {
    items: unique.slice(0, maxItems),
    omittedCount: Math.max(0, unique.length - maxItems)
  };
}

function getPayloadParagraphCollection(payload) {
  const paragraphs = payload?.paragraphs;
  if (!paragraphs || typeof paragraphs !== 'object' || Array.isArray(paragraphs)) return null;
  return paragraphs;
}

function getPayloadClaimCollection(payload) {
  const claimsCollection = payload?.claims;
  if (!claimsCollection || typeof claimsCollection !== 'object' || Array.isArray(claimsCollection)) return null;
  return claimsCollection;
}

function getPayloadSentinelCollection(payload) {
  const sentinelMap = payload?.sentinelMap;
  if (!sentinelMap || typeof sentinelMap !== 'object' || Array.isArray(sentinelMap)) return null;
  return sentinelMap;
}

function stripGroundingSentinelTokens(text) {
  return String(text || '')
    .replace(/⟪\s*\/?\s*\d{1,8}\s*⟫/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildParagraphLookupMap(paragraphs) {
  const map = new Map();
  Object.entries(paragraphs || {}).forEach(([rawKey, rawValue]) => {
    const normalizedKey = normalizeParagraphLookupKey(rawKey);
    if (!normalizedKey) return;
    const cleaned = stripGroundingSentinelTokens(rawValue);
    if (!cleaned) return;
    if (!map.has(normalizedKey)) {
      map.set(normalizedKey, cleaned);
    }
  });
  return map;
}

function collectParagraphRangeFromPayload(payload, start, end) {
  const paragraphs = getPayloadParagraphCollection(payload);
  if (!paragraphs) {
    return {
      entries: [],
      missingKeys: [],
      rangeTruncated: false
    };
  }

  const parsedStart = Number(start);
  const parsedEnd = Number(end);
  if (!Number.isFinite(parsedStart) || !Number.isFinite(parsedEnd)) {
    return {
      entries: [],
      missingKeys: [],
      rangeTruncated: false
    };
  }

  const from = Math.min(parsedStart, parsedEnd);
  const to = Math.max(parsedStart, parsedEnd);
  const boundedTo = Math.min(to, from + VERIFICATION_GROUNDING_MAX_RANGE_SPAN - 1);
  const paragraphMap = buildParagraphLookupMap(paragraphs);
  const entries = [];
  const missingKeys = [];

  for (let number = from; number <= boundedTo; number += 1) {
    const key = formatParagraphNumberKey(number);
    if (!key) continue;
    const text = paragraphMap.get(key);
    if (text) {
      entries.push({ key, text });
    } else {
      missingKeys.push(key);
    }
  }

  return {
    entries,
    missingKeys,
    rangeTruncated: boundedTo < to
  };
}

function getSentinelEntrySourceTextForGrounding(payload, entry) {
  if (!payload || !entry || typeof entry !== 'object') return '';
  const sourceKey = String(entry.sourceKey || '').trim();
  if (!sourceKey) return '';

  const targetType = String(entry.targetType || 'paragraph').trim().toLowerCase();
  const sourceCollection = targetType === 'claim'
    ? getPayloadClaimCollection(payload)
    : getPayloadParagraphCollection(payload);
  if (!sourceCollection) return '';

  const sourceText = sourceCollection[sourceKey];
  if (typeof sourceText !== 'string') return '';
  return stripGroundingSentinelTokens(sourceText);
}

function collectSentinelRangeFromPayload(payload, startSentinel, endSentinel) {
  const sentinelMap = getPayloadSentinelCollection(payload);
  if (!sentinelMap) {
    return {
      entries: [],
      missingIds: [],
      rangeTruncated: false
    };
  }

  const parsedStart = Number.parseInt(startSentinel, 10);
  const parsedEnd = Number.parseInt(endSentinel, 10);
  if (!Number.isFinite(parsedStart) || !Number.isFinite(parsedEnd)) {
    return {
      entries: [],
      missingIds: [],
      rangeTruncated: false
    };
  }

  const from = Math.min(parsedStart, parsedEnd);
  const to = Math.max(parsedStart, parsedEnd);
  const boundedTo = Math.min(to, from + VERIFICATION_GROUNDING_MAX_RANGE_SPAN - 1);
  const entries = [];
  const missingIds = [];

  for (let number = from; number <= boundedTo; number += 1) {
    const id = formatSentinelId(number);
    const rawEntry = sentinelMap[id];
    if (!rawEntry || typeof rawEntry !== 'object') {
      missingIds.push(id);
      continue;
    }

    const sourceKey = String(rawEntry.sourceKey || '').trim();
    const sourceText = getSentinelEntrySourceTextForGrounding(payload, rawEntry);
    entries.push({
      id,
      sourceKey,
      targetType: String(rawEntry.targetType || '').trim().toLowerCase(),
      pageNumber: Number(rawEntry.pageNumber) || null,
      sectionId: String(rawEntry.sectionId || '').trim(),
      sectionTitle: String(rawEntry.sectionTitle || '').trim(),
      sourceText
    });
  }

  return {
    entries,
    missingIds,
    rangeTruncated: boundedTo < to
  };
}

const STEP_B_LOCAL_GROUNDING_MAX_SEARCH_SPAN = 8;
const STEP_B_LOCAL_GROUNDING_MAX_CANDIDATE_POSITIONS = 5;

function normalizeGroundingComparisonText(text) {
  return stripGroundingSentinelTokens(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function buildPayloadSentinelSearchEntries(payload) {
  const sentinelMap = getPayloadSentinelCollection(payload);
  if (!sentinelMap) return [];

  return Object.entries(sentinelMap)
    .map(([id, rawEntry]) => {
      if (!rawEntry || typeof rawEntry !== 'object') return null;
      return {
        id: formatSentinelId(id),
        order: Number(rawEntry.order) || Number.parseInt(id, 10) || 0,
        sourceKey: String(rawEntry.sourceKey || '').trim(),
        sourceText: getSentinelEntrySourceTextForGrounding(payload, rawEntry)
      };
    })
    .filter(entry => entry && entry.sourceText)
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' });
    });
}

function reduceToMinimalSentinelMatches(matches) {
  const sorted = [...(matches || [])].sort((a, b) => {
    const aSpan = Number(a.end) - Number(a.start);
    const bSpan = Number(b.end) - Number(b.start);
    if (aSpan !== bSpan) return aSpan - bSpan;
    if (Number(a.start) !== Number(b.start)) return Number(a.start) - Number(b.start);
    return Number(a.end) - Number(b.end);
  });

  const minimal = [];
  sorted.forEach((match) => {
    const superseded = minimal.some((existing) =>
      Number(existing.start) >= Number(match.start)
      && Number(existing.end) <= Number(match.end)
    );
    if (!superseded) {
      minimal.push(match);
    }
  });
  return minimal;
}

function findSourceExcerptSentinelMatches(payload, sourceExcerpt, options = {}) {
  const normalizedExcerpt = normalizeGroundingComparisonText(sourceExcerpt);
  if (!normalizedExcerpt) return [];

  const entries = buildPayloadSentinelSearchEntries(payload);
  if (entries.length === 0) return [];

  const maxSpan = Number.isFinite(Number(options.maxSpan))
    ? Math.max(1, Number(options.maxSpan))
    : STEP_B_LOCAL_GROUNDING_MAX_SEARCH_SPAN;
  const matches = [];

  for (let startIdx = 0; startIdx < entries.length; startIdx += 1) {
    let combined = '';
    for (
      let endIdx = startIdx;
      endIdx < entries.length && endIdx < startIdx + maxSpan;
      endIdx += 1
    ) {
      combined = combined ? `${combined} ${entries[endIdx].sourceText}` : entries[endIdx].sourceText;
      if (!normalizeGroundingComparisonText(combined).includes(normalizedExcerpt)) continue;

      matches.push({
        start: entries[startIdx].id,
        end: entries[endIdx].id
      });
    }
  }

  return reduceToMinimalSentinelMatches(matches);
}

function getSentinelRangeSourceText(payload, startSentinel, endSentinel) {
  const collected = collectSentinelRangeFromPayload(payload, startSentinel, endSentinel);
  return {
    collected,
    text: collected.entries
      .map(entry => String(entry.sourceText || '').trim())
      .filter(Boolean)
      .join(' ')
      .trim()
  };
}

function validateRelevantItemAgainstCitation(rawItem, docName, payload) {
  const item = normalizeRelevantItemRecord(rawItem);
  const base = {
    docName: String(docName || '').trim(),
    item
  };

  if (!item.Feature || !item.MatchType || !item.Content) {
    return {
      ...base,
      status: 'invalid',
      validationError: 'missing_required_fields',
      validationMessage: 'Feature, MatchType, and Content are required.'
    };
  }

  if (!payload || typeof payload !== 'object') {
    return {
      ...base,
      status: 'invalid',
      validationError: 'missing_citation_payload',
      validationMessage: 'Citation payload is unavailable for local grounding validation.'
    };
  }

  if (!item.SourceExcerpt) {
    return {
      ...base,
      status: 'invalid',
      validationError: 'missing_source_excerpt',
      validationMessage: 'SourceExcerpt is required for local grounding validation.'
    };
  }

  const normalizedExcerpt = normalizeGroundingComparisonText(item.SourceExcerpt);
  if (!normalizedExcerpt) {
    return {
      ...base,
      status: 'invalid',
      validationError: 'missing_source_excerpt',
      validationMessage: 'SourceExcerpt is empty after normalization.'
    };
  }

  const rangeInfo = parseParagraphKeyRange(item.Position);
  if (rangeInfo?.kind === 'sentinel') {
    const canonicalPosition = formatSentinelRange(rangeInfo.startSentinel, rangeInfo.endSentinel);
    const source = getSentinelRangeSourceText(payload, rangeInfo.startSentinel, rangeInfo.endSentinel);
    const normalizedRangeText = normalizeGroundingComparisonText(source.text);
    const isRangeResolved = source.collected.entries.length > 0
      && source.collected.missingIds.length === 0
      && !source.collected.rangeTruncated;

    if (isRangeResolved && normalizedRangeText.includes(normalizedExcerpt)) {
      return {
        ...base,
        status: canonicalPosition === item.Position ? 'valid' : 'autocorrected',
        autoCorrected: canonicalPosition !== item.Position,
        item: {
          ...item,
          Position: canonicalPosition
        },
        matchedPosition: canonicalPosition
      };
    }
  }

  const matches = findSourceExcerptSentinelMatches(payload, item.SourceExcerpt);
  const candidatePositions = matches
    .slice(0, STEP_B_LOCAL_GROUNDING_MAX_CANDIDATE_POSITIONS)
    .map(match => formatSentinelRange(match.start, match.end));

  if (matches.length === 1) {
    const correctedPosition = formatSentinelRange(matches[0].start, matches[0].end);
    return {
      ...base,
      status: 'autocorrected',
      autoCorrected: true,
      item: {
        ...item,
        Position: correctedPosition
      },
      matchedPosition: correctedPosition,
      candidatePositions
    };
  }

  return {
    ...base,
    status: 'invalid',
    validationError: matches.length === 0 ? 'source_excerpt_not_found' : 'source_excerpt_ambiguous',
    validationMessage: matches.length === 0
      ? 'SourceExcerpt was not found in the local source text.'
      : 'SourceExcerpt matched multiple possible sentinel ranges.',
    candidatePositions
  };
}

function validateAndRepairRelevantEntries(relevant) {
  let validatedRelevant = {};
  const validationItems = [];
  const invalidItems = [];
  const autoCorrectedItems = [];

  Object.entries(relevant || {}).forEach(([docName, items]) => {
    if (!Array.isArray(items)) return;
    const citation = resolveCitationByDocName(docName);
    const payload = parseCitationPayload(citation);

    items.forEach((rawItem, itemIndex) => {
      const validation = validateRelevantItemAgainstCitation(rawItem, docName, payload);
      const record = {
        ...validation,
        itemIndex
      };
      validationItems.push(record);

      if (validation.status === 'invalid') {
        invalidItems.push(record);
        return;
      }

      if (validation.status === 'autocorrected') {
        autoCorrectedItems.push(record);
      }

      validatedRelevant = mergeRelevantWithPositions(validatedRelevant, {
        [docName]: [validation.item]
      });
    });
  });

  return {
    relevant: validatedRelevant,
    invalidItems,
    autoCorrectedItems,
    validationItems
  };
}

function extractClaimNumberForGrounding(value) {
  const text = String(value || '').trim();
  const parsed = parseClaimPositionToken(text);
  if (parsed && parsed.start === parsed.end) return parsed.start;

  const withKeyword = text.match(/(?:청구항|claim)\s*#?\s*(\d{1,6})/i);
  if (withKeyword) {
    const number = Number.parseInt(withKeyword[1], 10);
    return Number.isFinite(number) ? number : null;
  }

  const koreanStyle = text.match(/제\s*(\d{1,6})\s*항/i);
  if (koreanStyle) {
    const number = Number.parseInt(koreanStyle[1], 10);
    return Number.isFinite(number) ? number : null;
  }

  return null;
}

function buildClaimLookupMapForGrounding(claimsCollection) {
  const map = new Map();
  Object.entries(claimsCollection || {}).forEach(([rawKey, rawValue]) => {
    const number = extractClaimNumberForGrounding(rawKey);
    if (!Number.isFinite(number)) return;
    const text = stripGroundingSentinelTokens(rawValue);
    if (!text) return;
    if (!map.has(number)) {
      map.set(number, {
        number,
        key: String(rawKey || '').trim() || formatClaimPositionRange(number, number),
        text
      });
    }
  });
  return map;
}

function collectClaimRangeFromPayload(payload, start, end) {
  const claimsCollection = getPayloadClaimCollection(payload);
  if (!claimsCollection) {
    return {
      entries: [],
      missingClaims: [],
      rangeTruncated: false
    };
  }

  const parsedStart = Number(start);
  const parsedEnd = Number(end);
  if (!Number.isFinite(parsedStart) || !Number.isFinite(parsedEnd)) {
    return {
      entries: [],
      missingClaims: [],
      rangeTruncated: false
    };
  }

  const from = Math.min(parsedStart, parsedEnd);
  const to = Math.max(parsedStart, parsedEnd);
  const boundedTo = Math.min(to, from + VERIFICATION_GROUNDING_MAX_RANGE_SPAN - 1);
  const claimMap = buildClaimLookupMapForGrounding(claimsCollection);
  const entries = [];
  const missingClaims = [];

  for (let number = from; number <= boundedTo; number += 1) {
    const hit = claimMap.get(number);
    if (hit) {
      entries.push(hit);
    } else {
      missingClaims.push(formatClaimPositionRange(number, number));
    }
  }

  return {
    entries,
    missingClaims,
    rangeTruncated: boundedTo < to
  };
}

function buildSourceSnippetForGroundingToken(payload, token) {
  const rangeInfo = parseParagraphKeyRange(token);
  if (!rangeInfo) return null;

  if (rangeInfo.kind === 'numeric') {
    const collected = collectParagraphRangeFromPayload(payload, rangeInfo.start, rangeInfo.end);
    const lines = collected.entries.map(entry => `${entry.key}: ${entry.text}`);
    const foundKeys = normalizeGroundingList(collected.entries.map(entry => entry.key));
    const missingKeys = normalizeGroundingList(collected.missingKeys);

    return {
      snippet: {
        marker: rangeInfo.label || token,
        kind: 'paragraph',
        found_keys: foundKeys.items,
        found_keys_omitted: foundKeys.omittedCount,
        missing_keys: missingKeys.items,
        missing_keys_omitted: missingKeys.omittedCount,
        range_truncated: collected.rangeTruncated,
        source_excerpt: truncateVerificationGroundingText(lines.join('\n'))
      },
      resolved: lines.length > 0,
      complete: lines.length > 0 && collected.missingKeys.length === 0 && !collected.rangeTruncated
    };
  }

  if (rangeInfo.kind === 'claim') {
    const collected = collectClaimRangeFromPayload(payload, rangeInfo.startClaim, rangeInfo.endClaim);
    const lines = collected.entries.map((entry) => `${entry.key}: ${entry.text}`);
    const foundClaims = normalizeGroundingList(collected.entries.map(entry => entry.key));
    const missingClaims = normalizeGroundingList(collected.missingClaims);

    return {
      snippet: {
        marker: rangeInfo.label || token,
        kind: 'claim',
        found_claims: foundClaims.items,
        found_claims_omitted: foundClaims.omittedCount,
        missing_claims: missingClaims.items,
        missing_claims_omitted: missingClaims.omittedCount,
        range_truncated: collected.rangeTruncated,
        source_excerpt: truncateVerificationGroundingText(lines.join('\n'))
      },
      resolved: lines.length > 0,
      complete: lines.length > 0 && collected.missingClaims.length === 0 && !collected.rangeTruncated
    };
  }

  if (rangeInfo.kind === 'sentinel') {
    const collected = collectSentinelRangeFromPayload(payload, rangeInfo.startSentinel, rangeInfo.endSentinel);
    const lines = collected.entries.map((entry) => {
      const sentinelToken = formatSentinelOpenToken(entry.id);
      const sourceKey = entry.sourceKey ? ` ${entry.sourceKey}` : '';
      const text = entry.sourceText || '(empty source text)';
      return `${sentinelToken}${sourceKey}: ${text}`;
    });
    const foundIds = normalizeGroundingList(collected.entries.map(entry => entry.id));
    const missingIds = normalizeGroundingList(collected.missingIds);
    const sourceKeys = normalizeGroundingList(collected.entries.map(entry => entry.sourceKey));

    return {
      snippet: {
        marker: rangeInfo.label || token,
        kind: 'sentinel',
        found_ids: foundIds.items,
        found_ids_omitted: foundIds.omittedCount,
        missing_ids: missingIds.items,
        missing_ids_omitted: missingIds.omittedCount,
        source_keys: sourceKeys.items,
        source_keys_omitted: sourceKeys.omittedCount,
        range_truncated: collected.rangeTruncated,
        source_excerpt: truncateVerificationGroundingText(lines.join('\n'))
      },
      resolved: lines.length > 0,
      complete: lines.length > 0 && collected.missingIds.length === 0 && !collected.rangeTruncated
    };
  }

  return null;
}

function determineGroupGroundingStatus(statuses) {
  const normalized = (Array.isArray(statuses) ? statuses : [])
    .map(status => String(status || '').trim().toLowerCase())
    .filter(Boolean);
  if (normalized.length === 0) return 'unresolved';
  const hasResolved = normalized.includes('resolved');
  const hasPartial = normalized.includes('partial');
  const hasUnresolved = normalized.includes('unresolved');
  if (hasResolved && !hasPartial && !hasUnresolved) return 'resolved';
  if (hasUnresolved && !hasResolved && !hasPartial) return 'unresolved';
  return 'partial';
}

function buildGroundingForRelevantEvidence(rawItem, citation, payload) {
  const normalizedPosition = normalizePositionText(rawItem?.Position || '');
  const notes = [];

  if (!citation) {
    return {
      status: 'unresolved',
      normalizedPosition,
      notes: ['Citation document was not resolved from doc_name.'],
      sourceSnippets: []
    };
  }

  if (!payload || typeof payload !== 'object') {
    return {
      status: 'unresolved',
      normalizedPosition,
      notes: ['Citation payload JSON is missing or invalid.'],
      sourceSnippets: []
    };
  }

  if (!normalizedPosition) {
    return {
      status: 'unresolved',
      normalizedPosition,
      notes: ['Position is empty.'],
      sourceSnippets: []
    };
  }

  const tokens = normalizePositionTokens(normalizedPosition);
  if (tokens.length === 0) {
    return {
      status: 'unresolved',
      normalizedPosition,
      notes: ['No position token was parsed from Position.'],
      sourceSnippets: []
    };
  }

  if (tokens.length > VERIFICATION_GROUNDING_MAX_POSITION_TOKENS) {
    notes.push(`Only first ${VERIFICATION_GROUNDING_MAX_POSITION_TOKENS} position tokens were processed.`);
  }

  const unresolvedTokens = [];
  const snippetResults = [];
  let skippedBySnippetLimit = 0;
  const dedupedTokens = [...new Set(tokens)];

  for (let index = 0; index < dedupedTokens.length; index += 1) {
    if (index >= VERIFICATION_GROUNDING_MAX_POSITION_TOKENS) break;
    const token = dedupedTokens[index];
    const snippetResult = buildSourceSnippetForGroundingToken(payload, token);
    if (!snippetResult) {
      unresolvedTokens.push(token);
      continue;
    }
    if (snippetResults.length >= VERIFICATION_GROUNDING_MAX_SNIPPETS_PER_ITEM) {
      skippedBySnippetLimit += 1;
      continue;
    }
    snippetResults.push(snippetResult);
  }

  if (skippedBySnippetLimit > 0) {
    notes.push(`Snippet limit exceeded: skipped ${skippedBySnippetLimit} parsed position token(s).`);
  }

  if (unresolvedTokens.length > 0) {
    const unresolved = normalizeGroundingList(unresolvedTokens);
    const label = unresolved.omittedCount > 0
      ? `${unresolved.items.join(', ')} (+${unresolved.omittedCount} more)`
      : unresolved.items.join(', ');
    notes.push(`Unparsed or unsupported position token(s): ${label}`);
  }

  const resolvedCount = snippetResults.filter(result => result.resolved).length;
  const completeCount = snippetResults.filter(result => result.complete).length;

  let status = 'unresolved';
  if (resolvedCount === 0) {
    status = 'unresolved';
  } else if (
    resolvedCount === snippetResults.length &&
    completeCount === snippetResults.length &&
    unresolvedTokens.length === 0 &&
    skippedBySnippetLimit === 0
  ) {
    status = 'resolved';
  } else {
    status = 'partial';
  }

  return {
    status,
    normalizedPosition,
    notes,
    sourceSnippets: snippetResults.map(result => result.snippet)
  };
}

function buildVerificationGroundedEvidence(summaryResults) {
  const entries = [];
  const stats = {
    groupCount: 0,
    entryCount: 0,
    evidenceCount: 0,
    resolved: 0,
    partial: 0,
    unresolved: 0
  };

  Object.entries(summaryResults || {}).forEach(([claimId, claimSummary]) => {
    const relevant = claimSummary?.Relevant;
    if (!relevant || typeof relevant !== 'object' || Array.isArray(relevant)) return;

    Object.entries(relevant).forEach(([docName, items]) => {
      if (!Array.isArray(items) || items.length === 0) return;
      const safeDocName = String(docName || '').trim();
      if (!safeDocName) return;

      const citation = resolveCitationByDocName(safeDocName);
      const payload = parseCitationPayload(citation);

      items.forEach((rawItem, index) => {
        const featureId = String(rawItem?.Feature || '').trim();
        const evidenceId = normalizeEvidenceId(rawItem?.EvidenceId || rawItem?.evidenceId)
          || `AUTO-${String(claimId)}-${safeDocName}-${featureId || 'F'}-${index + 1}`;
        if (!featureId) return;

        const key = `${String(claimId)}_${evidenceId}`;

        const grounding = buildGroundingForRelevantEvidence(rawItem, citation, payload);
        entries.push({
          key,
          claim_id: String(claimId),
          evidence_id: evidenceId,
          feature_id: featureId,
          doc_name: safeDocName,
          citation_name: String(citation?.name || '').trim(),
          citation_title: String(citation?.title || '').trim(),
          citation_resolved: Boolean(citation),
          payload_resolved: Boolean(payload),
          evidence_index: index + 1,
          match_type: String(rawItem?.MatchType || rawItem?.matchType || rawItem?.match_type || '').trim(),
          content: truncateVerificationGroundingText(rawItem?.Content || '', 260),
          position: grounding.normalizedPosition,
          grounding_status: grounding.status,
          grounding_notes: grounding.notes,
          source_snippets: grounding.sourceSnippets
        });

        stats.evidenceCount += 1;
        if (grounding.status === 'resolved' || grounding.status === 'partial' || grounding.status === 'unresolved') {
          stats[grounding.status] += 1;
        }
      });
    });
  });

  entries.sort((a, b) => String(a.key).localeCompare(String(b.key), undefined, { numeric: true, sensitivity: 'base' }));
  stats.groupCount = entries.length;
  stats.entryCount = entries.length;

  return {
    entries,
    stats
  };
}

function splitTextIntoSentences(rawText) {
  const normalized = String(rawText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u00A0/g, ' ');

  const lines = normalized
    .split(/\n+/g)
    .map(line => line.trim())
    .filter(Boolean);

  const sentences = [];
  lines.forEach((line) => {
    const parts = line
      .split(/(?<=[.!?。！？])\s+/g)
      .map(part => part.trim())
      .filter(Boolean);
    if (parts.length === 0) {
      sentences.push(line);
      return;
    }
    parts.forEach(part => sentences.push(part));
  });
  return sentences;
}

function splitLongTextForChunk(text, chunkSize) {
  const clean = String(text || '').trim();
  if (!clean) return [];
  if (clean.length <= chunkSize) return [clean];

  const pieces = [];
  let cursor = 0;
  while (cursor < clean.length) {
    let end = Math.min(clean.length, cursor + chunkSize);
    if (end < clean.length) {
      const candidate = clean.slice(cursor, Math.min(clean.length, cursor + chunkSize + 40));
      const splitAt = Math.max(
        candidate.lastIndexOf('. '),
        candidate.lastIndexOf('? '),
        candidate.lastIndexOf('! '),
        candidate.lastIndexOf('。'),
        candidate.lastIndexOf('！'),
        candidate.lastIndexOf('？'),
        candidate.lastIndexOf(' ')
      );
      if (splitAt > chunkSize * 0.6) {
        end = cursor + splitAt + 1;
      }
    }
    pieces.push(clean.slice(cursor, end).trim());
    cursor = end;
  }
  return pieces.filter(Boolean);
}

function chunkTextBySentence(rawText, chunkSize = CITATION_SENTINEL_CHUNK_SIZE, overflow = CITATION_SENTINEL_CHUNK_OVERFLOW) {
  const size = Number.isFinite(Number(chunkSize)) ? Math.max(60, Number(chunkSize)) : 400;
  const extra = Number.isFinite(Number(overflow)) ? Math.max(0, Number(overflow)) : 80;
  const hardMax = size + extra;
  const sentences = splitTextIntoSentences(rawText);

  const chunks = [];
  let current = '';

  const flush = () => {
    const normalized = String(current || '').trim();
    if (normalized) chunks.push(normalized);
    current = '';
  };

  sentences.forEach((sentence) => {
    const text = String(sentence || '').trim();
    if (!text) return;

    if (text.length > hardMax) {
      flush();
      splitLongTextForChunk(text, size).forEach(part => chunks.push(part));
      return;
    }

    if (!current) {
      current = text;
      return;
    }

    const merged = `${current} ${text}`.trim();
    if (merged.length <= hardMax) {
      current = merged;
      return;
    }

    flush();
    current = text;
  });

  flush();
  return chunks;
}

function wrapWithSentinel(id, text) {
  const open = formatSentinelOpenToken(id);
  const close = formatSentinelCloseToken(id);
  const body = String(text || '').trim();
  return `${open} ${body} ${close}`.trim();
}

function buildUploadTextFromCitationPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const map = payload.sentinelMap && typeof payload.sentinelMap === 'object' ? payload.sentinelMap : {};
  const sortedIds = Object.keys(map).sort((a, b) => Number(a) - Number(b));
  const paragraphs = payload.paragraphs && typeof payload.paragraphs === 'object' ? payload.paragraphs : {};
  const claims = payload.claims && typeof payload.claims === 'object' ? payload.claims : {};

  const rows = [];
  sortedIds.forEach((id) => {
    const entry = map[id];
    if (!entry || typeof entry !== 'object') return;
    const sourceKey = String(entry.sourceKey || '').trim();
    if (!sourceKey) return;
    const text = entry.targetType === 'claim' ? claims[sourceKey] : paragraphs[sourceKey];
    if (typeof text === 'string' && text.trim()) {
      rows.push(text.trim());
    }
  });

  return rows.join('\n').trim();
}

function mergeRelevantWithPositions(base, extra) {
  const merged = JSON.parse(JSON.stringify(base || {}));
  Object.entries(extra || {}).forEach(([doc, items]) => {
    if (!Array.isArray(items)) return;
    if (!merged[doc]) merged[doc] = [];
    items.forEach(raw => {
      const item = normalizeRelevantItemRecord(raw);
      if (!item.Feature || !item.MatchType || !item.Content) return;
      const existing = merged[doc].find(entry =>
        entry.Feature === item.Feature &&
        entry.MatchType === item.MatchType &&
        entry.Content === item.Content &&
        (
          !normalizeEvidenceId(entry.EvidenceId) ||
          !item.EvidenceId ||
          normalizeEvidenceId(entry.EvidenceId) === item.EvidenceId
        ) &&
        (
          !String(entry.SourceExcerpt || '').trim() ||
          !item.SourceExcerpt ||
          String(entry.SourceExcerpt || '').trim() === item.SourceExcerpt
        )
      );
      if (existing) {
        if (!existing.EvidenceId && item.EvidenceId) {
          existing.EvidenceId = item.EvidenceId;
        }
        existing.Position = mergePositionText(existing.Position, item.Position);
        if (!existing.SourceExcerpt && item.SourceExcerpt) {
          existing.SourceExcerpt = item.SourceExcerpt;
        }
      } else {
        merged[doc].push(item);
      }
    });
  });
  return merged;
}

function normalizeRelevantForFeature(relevant, featureId) {
  const normalized = {};
  Object.entries(relevant || {}).forEach(([doc, items]) => {
    if (!Array.isArray(items)) return;
    const cleaned = items.map(item => normalizeRelevantItemRecord(item, featureId))
    .filter(item => item.Feature === featureId && item.MatchType && item.Content);

    if (cleaned.length > 0) normalized[doc] = cleaned;
  });
  return normalized;
}

function ensureQueryCount(feature, queries, count) {
  const targetCount = Math.max(1, Number(count) || 1);
  const cleaned = (queries || [])
    .filter(q => typeof q === 'string')
    .map(q => q.trim())
    .filter(Boolean);

  const description = feature?.Description || 'feature';
  const fallback = [
    description,
    `functional: ${description}`,
    `structural: ${description}`,
    `synonyms: ${description}`
  ];

  let i = 0;
  while (cleaned.length < targetCount) {
    const base = fallback[i % fallback.length];
    const candidate = i < fallback.length ? base : `${base} #${i + 1}`;
    if (!cleaned.includes(candidate)) {
      cleaned.push(candidate);
    }
    i += 1;
  }

  return cleaned.slice(0, targetCount);
}

function getMissingFeatures(claimFeatures, featureStatus, relevant) {
  const missing = [];
  (claimFeatures || []).forEach(feature => {
    const status = featureStatus?.[feature.Id];
    if (status && status !== 'ENTAIL') {
      missing.push(feature);
      return;
    }
    if (!status) {
      const hasMatch = Object.values(relevant || {}).some(list =>
        Array.isArray(list) && list.some(item => item.Feature === feature.Id)
      );
      if (!hasMatch) missing.push(feature);
    }
  });
  return missing;
}

function formatDownloadTimestamp(date) {
  const target = date instanceof Date ? date : new Date();
  const pad = value => String(value).padStart(2, '0');
  const yyyy = target.getFullYear();
  const mm = pad(target.getMonth() + 1);
  const dd = pad(target.getDate());
  const hh = pad(target.getHours());
  const min = pad(target.getMinutes());
  const ss = pad(target.getSeconds());
  return `${yyyy}${mm}${dd}_${hh}${min}${ss}`;
}

function triggerJsonDownload(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json;charset=utf-8'
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function buildAnalysisExportPayload() {
  const claimsSnapshot = (claims || []).map(claim => ({
    id: claim.id,
    name: claim.name,
    text: claim.text || ''
  }));

  const citationsSnapshot = (citations || []).map(citation => ({
    id: citation.id,
    referenceName: citation.name || '',
    documentName: citation.title || citation.name || '',
    status: citation.status || '',
    fileId: citation.fileId || null,
    tabId: citation.tabId || null
  }));

  const resultsSnapshot = JSON.parse(JSON.stringify(analysisResults || {}));
  const progressSnapshot = JSON.parse(JSON.stringify(claimProgressById || {}));
  const debugLogsByClaim = {};

  Object.entries(resultsSnapshot).forEach(([claimId, result]) => {
    const errors = {};

    if (result?.error) {
      errors.error = result.error;
    }

    Object.entries(result?.debug || {}).forEach(([key, value]) => {
      if (key.toLowerCase().endsWith('error') && value) {
        errors[key] = value;
      }
    });

    debugLogsByClaim[claimId] = {
      debug: result?.debug || null,
      errors,
      progress: progressSnapshot?.[String(claimId)] || null
    };
  });

  return {
    exportType: 'k-larc-analysis',
    exportedAt: new Date().toISOString(),
    summary: {
      claimCount: claimsSnapshot.length,
      citationCount: citationsSnapshot.length,
      resultCount: Object.keys(resultsSnapshot).length,
      hasDebugLogs: Object.keys(debugLogsByClaim).length > 0
    },
    claims: claimsSnapshot,
    citations: citationsSnapshot,
    analysisResults: resultsSnapshot,
    debugLogs: {
      byClaim: debugLogsByClaim,
      claimProgressById: progressSnapshot
    }
  };
}

function downloadAnalysisSnapshot() {
  if (isAnalysisRunning) {
    alert('분석 진행 중에는 다운로드할 수 없습니다. 분석 완료 후 다시 시도해주세요.');
    return false;
  }

  if (!analysisResults || Object.keys(analysisResults).length === 0) {
    alert('다운로드할 분석 결과가 없습니다.');
    return false;
  }

  const payload = buildAnalysisExportPayload();
  const filename = `k-larc-analysis_${formatDownloadTimestamp(new Date())}.json`;
  triggerJsonDownload(filename, payload);
  return true;
}

function autoResizeTextarea(textarea) {
  const MAX_HEIGHT = 240;
  textarea.style.height = 'auto';
  const nextHeight = Math.min(textarea.scrollHeight, MAX_HEIGHT);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden';
}
