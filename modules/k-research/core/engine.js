import { callOpenWebUI } from "./api.js";
import { makeQueryVersionId, nowIso } from "./ids.js";
import { loadPromptBundle, renderTemplate } from "./prompt_loader.js";
import {
  parseJsonFromText,
  validateAgainstSchema,
  normalizeFeatureExtract,
  normalizeQuerySeed,
  selectInitialActiveFeatureIds,
  selectTermsForMode,
  dephraseTermList,
  atomizeSearchTerm,
  normalizeCitationEval,
  normalizeQueryRefine
} from "./schema.js";
import {
  buildExpression,
  deriveQueryPlanFromExpression,
  normalizeQueryPlan,
  normalizeTermsByFeature,
  dedupeTermsAcrossActiveGroups
} from "./query_builder.js";
import {
  normalizeAtomicTermList,
  enforceAtomicTermsByFeature,
  summarizeLexicalViolations
} from "./query_lexical_policy.js";
import {
  buildQueryFingerprint,
  buildSemanticQueryFingerprint,
  buildActiveTermsFingerprint,
  collectActiveCanonicalTerms
} from "./query_fingerprint.js";
import {
  COUNT_CONTROL_DEFAULTS,
  classifyResultCount,
  computeCountDistanceScore,
  computeReductionRatio,
  buildRepeatReasonSignature,
  computeGroupBudget,
  countRecentSignatureRepeats,
  normalizeCountSource
} from "./count_control.js";
import {
  DEFAULT_REASONING_EFFORT,
  normalizeReasoningEffort,
  resolveReasoningEffortForPrompt
} from "./model_controls.js";

const EVAL_SCORE_HIGH = 85;
const EVAL_SCORE_SUPPORT = 60;
const MAX_EVAL_ROWS = 80;
const MAX_AUTO_ACTIONS = 3;
const MAX_REASON_TEXT = 180;
const MAX_QUERY_EXPRESSION_TEXT = 280;
const REFINE_PROMPT_RECENT_HISTORY_LIMIT = 4;
const REFINE_PROMPT_MAX_FEATURES = 12;
const REFINE_PROMPT_MAX_GROUPS = 8;
const REFINE_DUPLICATE_RETRY_MAX = 2;
const PAIR_PLAUSIBILITY_HIGH = 0.7;
const PAIR_CONFLICT_SOFT_LIMIT = 2;
const HARD_CONFLICT_PATTERN = /(contradict|incompat|inconsistent|mutually\s*exclusive|cannot\s*combine|hard\s*conflict|not\s*combinable|technically\s*incompatible)/i;
const TARGET_COUNT_RANGE_DEFAULT = Array.isArray(COUNT_CONTROL_DEFAULTS?.targetCountRange)
  ? COUNT_CONTROL_DEFAULTS.targetCountRange.slice(0, 2)
  : [0, 300];
const SOFT_TARGET_RANGE_DEFAULT = Array.isArray(COUNT_CONTROL_DEFAULTS?.softTargetRange)
  ? COUNT_CONTROL_DEFAULTS.softTargetRange.slice(0, 2)
  : [50, 180];

const PROMPT_CALL_OPTIONS = {
  feature_extract: { temperature: 0.05, reasoningEffort: "low" },
  query_seed: { temperature: 0, reasoningEffort: "low" },
  query_refine: { temperature: 0, reasoningEffort: "low" },
  query_duplicate_repair: { temperature: 0, reasoningEffort: "low" },
  query_plan_remap: { temperature: 0, reasoningEffort: "low" },
  citation_eval_json: { temperature: 0.05, reasoningEffort: "low" }
};

export function resolvePromptCallOptions(promptName, settings, {
  temperature = null,
  reasoningEffort = ""
} = {}) {
  const defaults = PROMPT_CALL_OPTIONS[promptName] || {
    temperature: 0.1,
    reasoningEffort: DEFAULT_REASONING_EFFORT
  };
  const resolvedTemperature = Number.isFinite(Number(temperature))
    ? Number(temperature)
    : Number(defaults.temperature ?? 0.1);
  const explicitReasoning = String(reasoningEffort || "").trim().toLowerCase();
  const resolvedReasoningEffort = explicitReasoning
    ? normalizeReasoningEffort(explicitReasoning, defaults.reasoningEffort || DEFAULT_REASONING_EFFORT)
    : resolveReasoningEffortForPrompt(promptName, settings, defaults.reasoningEffort || DEFAULT_REASONING_EFFORT);

  return {
    temperature: resolvedTemperature,
    reasoningEffort: resolvedReasoningEffort
  };
}

const QUERY_SEED_TEMPERATURE_MAX = 0.1;

function toUpperId(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeApplicationNo(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}

function uniqueStrings(items) {
  const out = [];
  const seen = new Set();
  (Array.isArray(items) ? items : []).forEach((item) => {
    const value = String(item || "").trim();
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(value);
  });
  return out;
}

function clipText(text, maxLen = 180) {
  const src = String(text || "").trim();
  if (!src) return "";
  if (src.length <= maxLen) return src;
  return `${src.slice(0, Math.max(0, maxLen - 3)).trim()}...`;
}

function collectSchemaEnumHints(schema, path = "$", out = []) {
  if (!schema || typeof schema !== "object") return out;
  if (Array.isArray(schema?.enum) && schema.enum.length > 0) {
    out.push(`${path}: ${schema.enum.join(" | ")}`);
  }
  const properties = schema?.properties;
  if (properties && typeof properties === "object") {
    Object.entries(properties).forEach(([key, value]) => {
      collectSchemaEnumHints(value, `${path}.${key}`, out);
    });
  }
  const items = schema?.items;
  if (items && typeof items === "object") {
    collectSchemaEnumHints(items, `${path}[]`, out);
  }
  const additionalProperties = schema?.additionalProperties;
  if (additionalProperties && typeof additionalProperties === "object") {
    collectSchemaEnumHints(additionalProperties, `${path}.*`, out);
  }
  return out;
}

function buildSchemaPromptAppendix(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return "";
  }
  const enumHints = collectSchemaEnumHints(schema);
  const enumLines = enumHints.length > 0
    ? enumHints.map((line) => `- ${line}`).join("\n")
    : "- (enum 제한 없음)";
  const schemaText = JSON.stringify(schema, null, 2);
  return [
    "[출력 형식 강제]",
    "1) 반드시 JSON 객체 1개만 출력한다.",
    "2) 코드블록 마크다운(````json`)이나 설명 문장을 출력하지 않는다.",
    "3) 키 이름/타입/enum 값은 아래 스키마를 정확히 따른다.",
    "4) 스키마에 없는 임의 토큰(type=remove_all, keep 등)은 출력하지 않는다.",
    "",
    "[ENUM 요약]",
    enumLines,
    "",
    "[SCHEMA JSON]",
    schemaText
  ].join("\n");
}

function composeSchemaBoundSystemPrompt(systemPrompt, schema) {
  const base = String(systemPrompt || "").trim();
  const appendix = buildSchemaPromptAppendix(schema);
  if (!appendix) return base;
  if (!base) return appendix;
  return `${base}\n\n${appendix}`;
}

function getQueryHistoryWeight(version) {
  const explicit = Number(version?.historyWeight);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(1, Math.min(5, Math.round(explicit)));
  }
  return String(version?.source || "").trim() === "manual_user_edit" ? 3 : 1;
}

function normalizeFeatureType(value, fallback = "optional") {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "anchor" || raw === "relation" || raw === "discriminator" || raw === "optional") {
    return raw;
  }
  return fallback;
}

function normalizeQueryRole(value, fallback = "should") {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "must" || raw === "should" || raw === "can_drop") {
    return raw;
  }
  return fallback;
}

function normalizeFeatureWeight(value, fallback = 3) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  if (rounded < 1) return 1;
  if (rounded > 5) return 5;
  return rounded;
}

function normalizeQuerySeedTemperature(value, fallback = PROMPT_CALL_OPTIONS.query_seed.temperature) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 0) return 0;
  if (parsed > QUERY_SEED_TEMPERATURE_MAX) return QUERY_SEED_TEMPERATURE_MAX;
  return parsed;
}

function deriveQueryRole(feature = {}, index = 0) {
  const explicit = normalizeQueryRole(feature?.query_role || feature?.queryRole, "");
  if (explicit) return explicit;
  if (feature?.core === true) return "must";
  if (feature?.core === false) return "should";
  if (index < 2) return "must";
  return "should";
}

function deriveFeatureType(feature = {}, queryRole = "should") {
  const explicit = normalizeFeatureType(feature?.type, "");
  if (explicit) return explicit;
  if (queryRole === "must") return "anchor";
  if (queryRole === "can_drop") return "optional";
  if (feature?.relation_to || feature?.relationTo) return "relation";
  return "discriminator";
}

function deriveFeatureWeight(feature = {}, queryRole = "should") {
  const fallback = queryRole === "must" ? 5 : (queryRole === "can_drop" ? 2 : 3);
  return normalizeFeatureWeight(feature?.weight, fallback);
}

function isMustFeature(feature = {}) {
  return normalizeQueryRole(feature?.query_role || feature?.queryRole, "") === "must";
}
function fallbackFeatureExtract(claimText) {
  const chunks = String(claimText || "")
    .split(/[\n.;]+/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length >= 8);

  const features = chunks.slice(0, 6).map((text, index) => ({
    id: `F${index + 1}`,
    text,
    type: index < 2 ? "anchor" : "discriminator",
    weight: index < 2 ? 5 : 3,
    query_role: index < 2 ? "must" : "should",
    relation_to: [],
    negative: false
  }));

  if (!features.length) {
    return [
      {
        id: "F1",
        text: String(claimText || "").trim() || "core technical feature",
        type: "anchor",
        weight: 5,
        query_role: "must",
        relation_to: [],
        negative: false
      }
    ];
  }
  return features;
}

function ensureCoreFlags(features) {
  const sourceFeatures = Array.isArray(features) ? features : [];
  const next = sourceFeatures.map((feature, index) => ({
    id: toUpperId(feature?.id || `F${index + 1}`) || `F${index + 1}`,
    text: String(feature?.text || "").trim(),
    query_role: deriveQueryRole(feature, index),
    type: "optional",
    weight: 3,
    relation_to: [],
    negative: !!feature?.negative
  })).filter((feature) => feature.id && feature.text);

  if (!next.length) return fallbackFeatureExtract("");

  next.forEach((feature, index) => {
    const source = sourceFeatures[index] || {};
    feature.type = deriveFeatureType(source, feature.query_role);
    feature.weight = deriveFeatureWeight(source, feature.query_role);
    feature.relation_to = uniqueStrings(source?.relation_to || source?.relationTo || [])
      .map((featureId) => toUpperId(featureId))
      .filter((featureId) => featureId && featureId !== feature.id);
  });

  if (!next.some((feature) => feature.query_role === "must")) {
    next.forEach((feature, index) => {
      feature.query_role = index < 2 ? "must" : "should";
      if (feature.query_role === "must") {
        feature.type = "anchor";
        feature.weight = Math.max(4, feature.weight);
      }
    });
  }

  return next;
}

function defaultFeatureStateById(features) {
  const out = {};
  (Array.isArray(features) ? features : []).forEach((feature) => {
    const queryRole = normalizeQueryRole(feature?.query_role, "should");
    const enabled = queryRole !== "can_drop";
    out[feature.id] = {
      enabled,
      active: false,
      core: queryRole === "must",
      text: feature.text,
      type: normalizeFeatureType(feature?.type, queryRole === "must" ? "anchor" : "optional"),
      weight: normalizeFeatureWeight(feature?.weight, queryRole === "must" ? 5 : 3),
      queryRole,
      relationTo: uniqueStrings(feature?.relation_to || []),
      negative: !!feature?.negative,
      focus: false,
      simplified: false,
      phrase_locked_terms: []
    };
  });
  return out;
}

function deriveAtomicFallbackTerms(sourceText, maxCount = 2) {
  const atoms = normalizeAtomicTermList([sourceText], {
    allowLockedBigrams: false
  }).filter((term) => term.length >= 2);
  return uniqueStrings(atoms).slice(0, Math.max(1, maxCount));
}

function deriveFallbackTerm(featureText) {
  return deriveAtomicFallbackTerms(featureText, 1)[0] || "";
}

function deriveLooseFallbackTerms(featureText) {
  return deriveAtomicFallbackTerms(featureText, 2);
}

function pickAtomicTerm(terms, fallbackText) {
  const base = normalizeAtomicTermList(terms, {
    allowLockedBigrams: false
  });
  if (base.length) return base[0];
  return deriveAtomicFallbackTerms(fallbackText, 1)[0] || "";
}

function normalizeQueryExpressionText(expression) {
  const src = String(expression || "").trim();
  if (!src) return "";
  return src.replace(/\s+/g, " ").trim();
}

function buildFeatureSeedMap(features = []) {
  const map = new Map();
  (Array.isArray(features) ? features : []).forEach((feature, index) => {
    const featureId = toUpperId(feature?.id || `F${index + 1}`);
    if (!featureId) return;
    map.set(featureId, feature);
  });
  return map;
}

function isFeatureActiveState(state = {}) {
  return state.enabled !== false && state.active !== false;
}

function isAnchorLikeFeatureState(state = {}) {
  return state.core === true
    || String(state.queryRole || "").toLowerCase() === "must"
    || String(state.type || "").toLowerCase() === "anchor";
}

function resolveFeatureTermLimit(featureId, policy = {}) {
  const normalizedId = toUpperId(featureId);
  const defaultLimit = Number.isFinite(Number(policy?.maxTermsPerFeature))
    ? Math.max(1, Math.round(Number(policy.maxTermsPerFeature)))
    : 1;
  const byFeature = policy?.maxTermsPerFeatureByFeatureId || {};
  const override = Number(byFeature?.[normalizedId]);
  if (Number.isFinite(override) && override > 0) {
    return Math.max(1, Math.round(override));
  }
  const allowTwoSet = new Set(
    uniqueStrings(policy?.allowTwoTermsFeatureIds || [])
      .map((id) => toUpperId(id))
      .filter(Boolean)
  );
  if (normalizedId && allowTwoSet.has(normalizedId)) {
    return Math.max(defaultLimit, 2);
  }
  return defaultLimit;
}

function buildModeTermCapPolicy({
  mode,
  features,
  featureStateById,
  broadenFeatureIds = [],
  focusFeatureId = "",
  balancedSupportFeatureIds = []
} = {}) {
  const normalizedMode = String(mode || "balanced").trim().toLowerCase();
  const featureList = Array.isArray(features) ? features : [];
  const stateById = featureStateById && typeof featureStateById === "object"
    ? featureStateById
    : {};
  const maxTermsPerFeatureByFeatureId = {};
  const broadenSet = new Set(uniqueStrings(broadenFeatureIds || []).map((id) => toUpperId(id)));
  const balancedSet = new Set(uniqueStrings(balancedSupportFeatureIds || []).map((id) => toUpperId(id)));
  const normalizedFocusFeatureId = toUpperId(focusFeatureId);

  featureList.forEach((feature, index) => {
    const featureId = toUpperId(feature?.id || `F${index + 1}`);
    if (!featureId) return;
    const state = stateById?.[featureId] || {};
    const active = isFeatureActiveState(state);
    let limit = 1;
    if (active) {
      if (normalizedMode === "initial" && isAnchorLikeFeatureState(state)) {
        limit = 2;
      } else if (normalizedMode === "widen" && broadenSet.has(featureId)) {
        limit = 2;
      } else if (normalizedMode === "narrow" && normalizedFocusFeatureId === featureId) {
        limit = 2;
      } else if (normalizedMode === "balanced" && balancedSet.has(featureId)) {
        limit = 2;
      }
    }
    maxTermsPerFeatureByFeatureId[featureId] = limit;
  });

  const allowTwoTermsFeatureIds = Object.entries(maxTermsPerFeatureByFeatureId)
    .filter(([, limit]) => Number(limit) >= 2)
    .map(([featureId]) => featureId);

  return {
    maxTermsPerFeature: 1,
    maxTermsPerFeatureByFeatureId,
    allowTwoTermsFeatureIds
  };
}

function applyModeTermCapToFeatureTerms({
  features,
  termsByFeature,
  policy
} = {}) {
  const next = { ...(termsByFeature || {}) };
  (Array.isArray(features) ? features : []).forEach((feature, index) => {
    const featureId = toUpperId(feature?.id || `F${index + 1}`);
    if (!featureId) return;
    const limit = resolveFeatureTermLimit(featureId, policy);
    const normalized = normalizeAtomicTermList(next?.[featureId] || [], {
      allowLockedBigrams: false
    });
    next[featureId] = uniqueStrings(normalized).slice(0, Math.max(1, limit));
  });
  return next;
}

function materializeFeatureTermsForMode(featureId, alternatives, {
  mode = "balanced",
  featureState = {},
  isFocus = false,
  isBroadenTarget = false,
  isBalancedSupport = false
} = {}) {
  const normalized = uniqueStrings(normalizeAtomicTermList(alternatives || [], {
    allowLockedBigrams: false
  }));
  if (!normalized.length) return [];
  const policy = buildModeTermCapPolicy({
    mode,
    features: [{ id: featureId }],
    featureStateById: {
      [featureId]: {
        ...featureState,
        enabled: featureState?.enabled !== false,
        active: featureState?.active !== false,
        focus: featureState?.focus === true || isFocus
      }
    },
    broadenFeatureIds: isBroadenTarget ? [featureId] : [],
    focusFeatureId: isFocus ? featureId : "",
    balancedSupportFeatureIds: isBalancedSupport ? [featureId] : []
  });
  const limit = resolveFeatureTermLimit(featureId, policy);
  return normalized.slice(0, limit);
}

function pickBalancedSupportFeatureIds({
  features,
  featureStateById,
  preferredIds = [],
  limit = 2
} = {}) {
  const featureList = Array.isArray(features) ? features : [];
  const stateById = featureStateById && typeof featureStateById === "object"
    ? featureStateById
    : {};

  const preferred = uniqueStrings(preferredIds || [])
    .map((id) => toUpperId(id))
    .filter((featureId) => {
      const state = stateById?.[featureId] || {};
      return !!featureId && isFeatureActiveState(state);
    });
  if (preferred.length) return preferred.slice(0, Math.max(1, limit));

  return [...featureList]
    .map((feature, index) => ({
      featureId: toUpperId(feature?.id || `F${index + 1}`),
      state: stateById?.[toUpperId(feature?.id || `F${index + 1}`)] || {}
    }))
    .filter((entry) => entry.featureId && isFeatureActiveState(entry.state))
    .sort((left, right) => {
      const leftMust = isAnchorLikeFeatureState(left.state);
      const rightMust = isAnchorLikeFeatureState(right.state);
      if (Number(rightMust) !== Number(leftMust)) {
        return Number(rightMust) - Number(leftMust);
      }
      const leftWeight = Number(left.state?.weight || 0);
      const rightWeight = Number(right.state?.weight || 0);
      if (rightWeight !== leftWeight) return rightWeight - leftWeight;
      return left.featureId.localeCompare(right.featureId);
    })
    .map((entry) => entry.featureId)
    .slice(0, Math.max(1, limit));
}

function buildTermPolicyFromPlannedResult(planned, features) {
  const mode = String(planned?.mode || "balanced").trim().toLowerCase();
  const plannerMeta = planned?.plannerMeta || {};
  const featureStateById = planned?.featureStateById || {};
  const focusFeatureId = mode === "narrow"
    ? toUpperId(plannerMeta?.focusFeatureId || plannerMeta?.promotedFeatureId || "")
    : "";
  const broadenFeatureIds = mode === "widen"
    ? uniqueStrings([
      ...(plannerMeta?.broadenFeatureIds || []),
      ...(plannerMeta?.gapFeatureIds || [])
    ]).map((id) => toUpperId(id)).filter(Boolean).slice(0, 1)
    : [];
  const balancedSupportIds = mode === "balanced"
    ? pickBalancedSupportFeatureIds({
      features,
      featureStateById,
      preferredIds: uniqueStrings([
        ...(plannerMeta?.balancedSupportFeatureIds || []),
        ...(plannerMeta?.saturatedFeatureIds || [])
      ]).map((id) => toUpperId(id)).filter(Boolean),
      limit: 2
    })
    : [];
  const termPolicy = buildModeTermCapPolicy({
    mode,
    features,
    featureStateById,
    focusFeatureId,
    broadenFeatureIds,
    balancedSupportFeatureIds: balancedSupportIds
  });
  const plannerBudget = Number(plannerMeta?.groupBudget);
  if (Number.isFinite(plannerBudget) && plannerBudget > 0) {
    termPolicy.maxActiveGroups = Math.max(2, Math.min(5, Math.floor(plannerBudget)));
  }
  return termPolicy;
}

function getPrimaryFeatureIdFromGroup(group) {
  return toUpperId(
    Array.isArray(group?.feature_ids || group?.featureIds)
      ? ((group.feature_ids || group.featureIds)[0] || "")
      : ""
  );
}

function buildVersionFingerprints(versionLike = {}) {
  const queryPlan = versionLike?.queryPlan || { groups: [] };
  const termsByFeature = versionLike?.termsByFeature || {};
  const featureStateById = versionLike?.featureStateById || {};
  const fingerprint = buildQueryFingerprint({
    queryPlan,
    termsByFeature,
    featureStateById
  });
  const semanticFingerprint = buildSemanticQueryFingerprint({
    queryPlan,
    termsByFeature,
    featureStateById
  });
  const activeTermsFingerprint = buildActiveTermsFingerprint({
    queryPlan,
    termsByFeature,
    featureStateById
  });
  const activeTerms = collectActiveCanonicalTerms({
    queryPlan,
    termsByFeature,
    featureStateById
  });
  return {
    fingerprint,
    semanticFingerprint,
    activeTermsFingerprint,
    activeTerms
  };
}

function buildVersionFingerprintsFromHistoryEntry(version = {}) {
  const existingFingerprint = String(version?.fingerprint || "").trim();
  const existingSemantic = String(version?.semanticFingerprint || "").trim();
  const existingActiveTerms = Array.isArray(version?.activeTerms) ? uniqueStrings(version.activeTerms) : [];
  const existingActiveTermsFingerprint = String(version?.activeTermsFingerprint || "").trim();
  if (existingFingerprint && existingSemantic && (existingActiveTermsFingerprint || existingActiveTerms.length)) {
    return {
      fingerprint: existingFingerprint,
      semanticFingerprint: existingSemantic,
      activeTermsFingerprint: existingActiveTermsFingerprint || existingActiveTerms.join("|"),
      activeTerms: existingActiveTerms
    };
  }
  return buildVersionFingerprints(version);
}

function findDuplicateQueryVersion({
  queryVersions,
  candidateFingerprints,
  excludeQueryVersionId = ""
}) {
  const history = Array.isArray(queryVersions) ? queryVersions : [];
  const excludeId = String(excludeQueryVersionId || "").trim();
  const candidateFingerprint = String(candidateFingerprints?.fingerprint || "").trim();
  const candidateSemantic = String(candidateFingerprints?.semanticFingerprint || "").trim();
  const candidateActiveTerms = String(candidateFingerprints?.activeTermsFingerprint || "").trim();
  if (!candidateFingerprint && !candidateSemantic && !candidateActiveTerms) {
    return null;
  }

  for (const version of history) {
    const queryVersionId = String(version?.queryVersionId || "").trim();
    if (excludeId && queryVersionId && queryVersionId === excludeId) continue;
    const row = buildVersionFingerprintsFromHistoryEntry(version);
    if (candidateFingerprint && row.fingerprint && row.fingerprint === candidateFingerprint) {
      return {
        duplicateOfQueryVersionId: queryVersionId,
        reason: "exact fingerprint match",
        matchType: "fingerprint"
      };
    }
    if (candidateSemantic && row.semanticFingerprint && row.semanticFingerprint === candidateSemantic) {
      return {
        duplicateOfQueryVersionId: queryVersionId,
        reason: "semantic fingerprint match",
        matchType: "semantic_fingerprint"
      };
    }
    if (candidateActiveTerms && row.activeTermsFingerprint && row.activeTermsFingerprint === candidateActiveTerms) {
      return {
        duplicateOfQueryVersionId: queryVersionId,
        reason: "active term multiset match",
        matchType: "active_terms"
      };
    }
  }
  return null;
}

function enrichPlannerMetaWithCrossGroupDedupe(plannerMeta = {}, crossGroupDedupeMeta = {}) {
  return {
    ...(plannerMeta || {}),
    crossGroupDedupe: {
      duplicate_terms_removed: uniqueStrings(crossGroupDedupeMeta?.duplicate_terms_removed || []),
      term_owner_by_group: crossGroupDedupeMeta?.term_owner_by_group || {},
      emptied_groups: uniqueStrings(crossGroupDedupeMeta?.emptied_groups || []),
      rebuild_required_due_to_cross_group_dedupe:
        crossGroupDedupeMeta?.rebuild_required_due_to_cross_group_dedupe === true
    }
  };
}

function applyGroupBudgetToQueryPlan(queryPlan, featureStateById = {}, maxActiveGroups = null) {
  const groups = Array.isArray(queryPlan?.groups) ? queryPlan.groups : [];
  const cap = Number(maxActiveGroups);
  if (!Number.isFinite(cap) || cap <= 0) {
    return {
      queryPlan,
      droppedGroupIds: []
    };
  }

  const active = groups.filter((group) => group?.active !== false);
  if (active.length <= cap) {
    return {
      queryPlan,
      droppedGroupIds: []
    };
  }

  const sorted = [...active].sort((left, right) => {
    if (Number(right.required === true) !== Number(left.required === true)) {
      return Number(right.required === true) - Number(left.required === true);
    }
    if (Number(right.focus === true) !== Number(left.focus === true)) {
      return Number(right.focus === true) - Number(left.focus === true);
    }
    const leftFeatureId = getPrimaryFeatureIdFromGroup(left);
    const rightFeatureId = getPrimaryFeatureIdFromGroup(right);
    const leftWeight = Number(featureStateById?.[leftFeatureId]?.weight || 0);
    const rightWeight = Number(featureStateById?.[rightFeatureId]?.weight || 0);
    if (rightWeight !== leftWeight) return rightWeight - leftWeight;
    return String(left?.group_id || "").localeCompare(String(right?.group_id || ""));
  });

  const keepIds = new Set(
    sorted
      .slice(0, Math.max(1, Math.floor(cap)))
      .map((group) => String(group?.group_id || "").trim())
      .filter(Boolean)
  );
  const droppedGroupIds = [];
  groups.forEach((group) => {
    const groupId = String(group?.group_id || "").trim();
    if (!groupId || group?.active === false) return;
    if (keepIds.has(groupId)) return;
    group.active = false;
    droppedGroupIds.push(groupId);
  });

  return {
    queryPlan: {
      ...queryPlan,
      groups
    },
    droppedGroupIds: uniqueStrings(droppedGroupIds)
  };
}

function dedupeAndMaterializeQuery({
  features,
  termsByFeature,
  featureStateById,
  queryPlan,
  modeByFeatureId,
  reasonByFeatureId,
  maxActiveGroups = null,
  maxTermsPerFeature = 1,
  maxTermsPerFeatureByFeatureId = {},
  allowTwoTermsFeatureIds = []
}) {
  const normalizedTerms = ensureTermsByFeature(termsByFeature || {}, features);
  const normalizedPlan = normalizeQueryPlan({
    queryPlan: queryPlan || null,
    features,
    termsByFeature: normalizedTerms,
    featureStateById,
    maxTermsPerFeature,
    maxTermsPerFeatureByFeatureId,
    allowTwoTermsFeatureIds,
    modeByFeatureId,
    reasonByFeatureId
  });
  const deduped = dedupeTermsAcrossActiveGroups({
    queryPlan: normalizedPlan,
    termsByFeature: normalizedTerms,
    featureStateById
  });
  const dedupedPlan = normalizeQueryPlan({
    queryPlan: deduped?.queryPlan || normalizedPlan,
    features,
    termsByFeature: normalizedTerms,
    featureStateById,
    maxTermsPerFeature,
    maxTermsPerFeatureByFeatureId,
    allowTwoTermsFeatureIds,
    modeByFeatureId,
    reasonByFeatureId
  });
  const crossGroupDedupeMeta = {};
  const budgeted = applyGroupBudgetToQueryPlan(dedupedPlan, featureStateById, maxActiveGroups);
  if (Array.isArray(budgeted?.droppedGroupIds) && budgeted.droppedGroupIds.length > 0) {
    crossGroupDedupeMeta.group_budget_dropped = budgeted.droppedGroupIds.slice(0);
  }
  const expression = buildExpression({
    queryPlan: budgeted?.queryPlan || dedupedPlan,
    features,
    termsByFeature: normalizedTerms,
    featureStateById,
    maxTermsPerFeature,
    maxTermsPerFeatureByFeatureId,
    allowTwoTermsFeatureIds,
    modeByFeatureId,
    reasonByFeatureId,
    maxActiveGroups,
    debugMetaOut: crossGroupDedupeMeta
  });
  return {
    expression: String(expression || "").trim(),
    queryPlan: budgeted?.queryPlan || dedupedPlan,
    termsByFeature: normalizedTerms,
    crossGroupDedupeMeta
  };
}

function pickFeatureTermAlternatives(featureId, {
  seedByFeature,
  termsByFeature,
  featureMap
} = {}) {
  const buckets = seedByFeature?.[featureId] || {};
  const fromSeed = normalizeAtomicTermList([
    ...(buckets.base_terms || []),
    ...(buckets.support_terms || []),
    ...(buckets.broad_terms || []),
    ...(buckets.narrow_terms || [])
  ], { allowLockedBigrams: false });
  const fromCurrent = normalizeAtomicTermList(termsByFeature?.[featureId] || [], { allowLockedBigrams: false });
  const fallback = normalizeAtomicTermList([
    featureMap.get(featureId)?.search_hint || featureMap.get(featureId)?.searchHint || featureMap.get(featureId)?.text || featureId
  ], { allowLockedBigrams: false });
  return uniqueStrings([...fromSeed, ...fromCurrent, ...fallback]);
}

function applyDuplicateCorrectivePolicy({
  mode,
  features,
  queryPlan,
  termsByFeature,
  featureStateById,
  seedByFeature,
  duplicateInfo,
  plannerMeta
}) {
  const featureMap = buildFeatureSeedMap(features);
  const nextTerms = JSON.parse(JSON.stringify(termsByFeature || {}));
  const nextState = JSON.parse(JSON.stringify(featureStateById || {}));
  const feedbackActions = [];
  const normalizedMode = String(mode || "balanced").trim().toLowerCase();
  let correctiveBroadenTarget = "";
  let correctiveFocusFeatureId = toUpperId(plannerMeta?.focusFeatureId || plannerMeta?.promotedFeatureId || "");
  const correctiveBalancedSupportIds = [];

  const allFeatureIds = (Array.isArray(features) ? features : []).map((feature) => toUpperId(feature?.id)).filter(Boolean);
  const activeFeatureIds = () => allFeatureIds.filter((featureId) => {
    const state = nextState?.[featureId] || {};
    return state.enabled !== false && state.active !== false;
  });

  const sortByWeakness = (featureIds) => {
    return [...featureIds].sort((leftId, rightId) => {
      const left = nextState?.[leftId] || {};
      const right = nextState?.[rightId] || {};
      const leftMust = left.core === true || left.queryRole === "must";
      const rightMust = right.core === true || right.queryRole === "must";
      if (Number(leftMust) !== Number(rightMust)) return Number(leftMust) - Number(rightMust);
      const leftWeight = Number(left.weight || 0);
      const rightWeight = Number(right.weight || 0);
      if (leftWeight !== rightWeight) return leftWeight - rightWeight;
      return leftId.localeCompare(rightId);
    });
  };

  const ensureModeTerms = (featureId, preferred = [], extra = {}) => {
    const alternatives = uniqueStrings([
      ...(Array.isArray(preferred) ? preferred : []),
      ...pickFeatureTermAlternatives(featureId, {
        seedByFeature,
        termsByFeature: nextTerms,
        featureMap
      })
    ]);
    if (!alternatives.length) {
      nextTerms[featureId] = [];
      return;
    }
    nextTerms[featureId] = materializeFeatureTermsForMode(featureId, alternatives, {
      mode: extra.mode || normalizedMode,
      featureState: nextState?.[featureId] || {},
      isFocus: extra.isFocus === true,
      isBroadenTarget: extra.isBroadenTarget === true,
      isBalancedSupport: extra.isBalancedSupport === true
    });
  };

  if (normalizedMode === "widen") {
    const activeNow = activeFeatureIds();
    if (activeNow.length >= 3) {
      const weak = sortByWeakness(activeNow).find((featureId) => {
        const state = nextState?.[featureId] || {};
        return !(state.core === true || state.queryRole === "must");
      });
      if (weak) {
        nextState[weak] = {
          ...(nextState[weak] || {}),
          active: false,
          focus: false
        };
        feedbackActions.push(`[${weak}] duplicate-corrective: deactivate weak group`);
      }
    }

    const inactiveCandidates = sortByWeakness(allFeatureIds.filter((featureId) => !activeFeatureIds().includes(featureId))).reverse();
    const broadenTarget = inactiveCandidates[0] || "";
    if (broadenTarget) {
      correctiveBroadenTarget = broadenTarget;
      nextState[broadenTarget] = {
        ...(nextState[broadenTarget] || {}),
        enabled: true,
        active: true,
        focus: false
      };
      const alternatives = pickFeatureTermAlternatives(broadenTarget, {
        seedByFeature,
        termsByFeature: nextTerms,
        featureMap
      });
      ensureModeTerms(broadenTarget, alternatives, {
        mode: "widen",
        isBroadenTarget: true
      });
      feedbackActions.push(`[${broadenTarget}] duplicate-corrective: switch broaden target`);
    }
  } else if (normalizedMode === "narrow") {
    const currentFocus = toUpperId(plannerMeta?.focusFeatureId || plannerMeta?.promotedFeatureId || "");
    const focusCandidates = sortByWeakness(allFeatureIds).reverse().filter((featureId) => featureId !== currentFocus);
    const nextFocus = focusCandidates[0] || currentFocus;
    if (nextFocus) {
      correctiveFocusFeatureId = nextFocus;
      allFeatureIds.forEach((featureId) => {
        nextState[featureId] = {
          ...(nextState[featureId] || {}),
          focus: featureId === nextFocus
        };
      });
      nextState[nextFocus] = {
        ...(nextState[nextFocus] || {}),
        enabled: true,
        active: true,
        core: true,
        focus: true
      };
      ensureModeTerms(nextFocus, pickFeatureTermAlternatives(nextFocus, {
        seedByFeature,
        termsByFeature: nextTerms,
        featureMap
      }).slice(1), {
        mode: "narrow",
        isFocus: true
      });
      feedbackActions.push(`[${nextFocus}] duplicate-corrective: promote alternate focus`);
    }

    activeFeatureIds().forEach((featureId) => {
      if (featureId === nextFocus) return;
      ensureModeTerms(featureId, [], {
        mode: "narrow",
        isFocus: false
      });
    });
  } else {
    const activeNow = activeFeatureIds();
    const weakest = sortByWeakness(activeNow)[0] || "";
    if (weakest) {
      const alternatives = pickFeatureTermAlternatives(weakest, {
        seedByFeature,
        termsByFeature: nextTerms,
        featureMap
      });
      if (alternatives.length >= 2) {
        correctiveBalancedSupportIds.push(weakest);
        nextTerms[weakest] = materializeFeatureTermsForMode(weakest, [
          alternatives[1],
          alternatives[0],
          ...alternatives.slice(2)
        ], {
          mode: "balanced",
          featureState: nextState?.[weakest] || {},
          isBalancedSupport: true
        });
        feedbackActions.push(`[${weakest}] duplicate-corrective: swap representative term`);
      } else {
        nextState[weakest] = {
          ...(nextState[weakest] || {}),
          active: false
        };
        feedbackActions.push(`[${weakest}] duplicate-corrective: drop one weak active group`);
      }
    }
  }

  const materialized = dedupeAndMaterializeQuery({
    features,
    termsByFeature: nextTerms,
    featureStateById: nextState,
    queryPlan,
    maxActiveGroups: normalizedMode === "initial" ? 3 : null,
    ...buildModeTermCapPolicy({
      mode: normalizedMode,
      features,
      featureStateById: nextState,
      focusFeatureId: normalizedMode === "narrow" ? correctiveFocusFeatureId : "",
      broadenFeatureIds: normalizedMode === "widen" && correctiveBroadenTarget ? [correctiveBroadenTarget] : [],
      balancedSupportFeatureIds: normalizedMode === "balanced"
        ? (correctiveBalancedSupportIds.length
          ? uniqueStrings(correctiveBalancedSupportIds)
          : sortByWeakness(activeFeatureIds()).reverse().slice(0, 2))
        : []
    })
  });

  feedbackActions.push(
    `duplicate_query_blocked: ${duplicateInfo?.reason || "fingerprint conflict"}`
  );

  return {
    ...materialized,
    featureStateById: nextState,
    feedbackActions: uniqueStrings(feedbackActions)
  };
}

function forceRebuildForDuplicate({
  mode,
  features,
  seedByFeature,
  featureStateById,
  termsByFeature
}) {
  const nextState = JSON.parse(JSON.stringify(featureStateById || {}));
  const nextTerms = JSON.parse(JSON.stringify(termsByFeature || {}));
  const normalizedMode = String(mode || "balanced").trim().toLowerCase();
  const activeSet = new Set(selectInitialActiveFeatureIds(features, { minActive: 2, maxActive: 3 }).map((id) => toUpperId(id)));

  if (normalizedMode === "narrow") {
    const allIds = (Array.isArray(features) ? features : []).map((feature) => toUpperId(feature?.id)).filter(Boolean);
    const extra = allIds.find((featureId) => !activeSet.has(featureId));
    if (extra) activeSet.add(extra);
  }

  (Array.isArray(features) ? features : []).forEach((feature) => {
    const featureId = toUpperId(feature?.id);
    if (!featureId) return;
    const active = activeSet.has(featureId) && nextState?.[featureId]?.enabled !== false;
    nextState[featureId] = {
      ...(nextState[featureId] || {}),
      active,
      focus: false,
      simplified: true
    };
    const alternatives = pickFeatureTermAlternatives(featureId, {
      seedByFeature,
      termsByFeature: nextTerms,
      featureMap: buildFeatureSeedMap(features)
    });
    nextTerms[featureId] = materializeFeatureTermsForMode(featureId, alternatives, {
      mode: normalizedMode,
      featureState: nextState?.[featureId] || {},
      isFocus: normalizedMode === "narrow" && activeSet.has(featureId),
      isBroadenTarget: normalizedMode === "widen" && activeSet.has(featureId),
      isBalancedSupport: normalizedMode === "balanced" && activeSet.has(featureId)
    });
  });

  const termPolicy = buildModeTermCapPolicy({
    mode: normalizedMode,
    features,
    featureStateById: nextState,
    focusFeatureId: normalizedMode === "narrow"
      ? uniqueStrings(Array.from(activeSet))[0] || ""
      : "",
    broadenFeatureIds: normalizedMode === "widen" ? Array.from(activeSet) : [],
    balancedSupportFeatureIds: normalizedMode === "balanced" ? Array.from(activeSet).slice(0, 2) : []
  });
  const cappedTerms = applyModeTermCapToFeatureTerms({
    features,
    termsByFeature: nextTerms,
    policy: termPolicy
  });

  const materialized = dedupeAndMaterializeQuery({
    features,
    termsByFeature: cappedTerms,
    featureStateById: nextState,
    queryPlan: null,
    maxActiveGroups: 4,
    ...termPolicy
  });
  return {
    ...materialized,
    featureStateById: nextState
  };
}

function resolveDuplicateCandidate({
  candidate,
  mode,
  features,
  queryVersions,
  currentVersion,
  seedByFeature,
  plannerMeta
}) {
  const candidateFingerprints = buildVersionFingerprints(candidate);
  const duplicate = findDuplicateQueryVersion({
    queryVersions,
    candidateFingerprints,
    excludeQueryVersionId: currentVersion?.queryVersionId
  });
  if (!duplicate) {
    return {
      candidate: {
        ...candidate,
        ...candidateFingerprints,
        duplicateOfQueryVersionId: null,
        duplicateBlocked: false
      },
      duplicateBlocked: false,
      stillDuplicate: false,
      duplicateInfo: null,
      correctiveActions: []
    };
  }

  const corrected = applyDuplicateCorrectivePolicy({
    mode,
    features,
    queryPlan: candidate.queryPlan,
    termsByFeature: candidate.termsByFeature,
    featureStateById: candidate.featureStateById,
    seedByFeature,
    duplicateInfo: duplicate,
    plannerMeta
  });
  const correctedCandidate = {
    ...candidate,
    expression: corrected.expression,
    queryPlan: corrected.queryPlan,
    termsByFeature: corrected.termsByFeature,
    featureStateById: corrected.featureStateById,
    crossGroupDedupeMeta: corrected.crossGroupDedupeMeta
  };
  const correctedFingerprints = buildVersionFingerprints(correctedCandidate);
  const stillDuplicate = findDuplicateQueryVersion({
    queryVersions,
    candidateFingerprints: correctedFingerprints,
    excludeQueryVersionId: currentVersion?.queryVersionId
  });
  if (!stillDuplicate) {
    return {
      candidate: {
        ...correctedCandidate,
        ...correctedFingerprints,
        duplicateOfQueryVersionId: duplicate.duplicateOfQueryVersionId || null,
        duplicateBlocked: true
      },
      duplicateBlocked: true,
      stillDuplicate: false,
      duplicateInfo: duplicate,
      correctiveActions: corrected.feedbackActions || []
    };
  }

  const rebuilt = forceRebuildForDuplicate({
    mode,
    features,
    seedByFeature,
    featureStateById: correctedCandidate.featureStateById,
    termsByFeature: correctedCandidate.termsByFeature
  });
  const rebuiltCandidate = {
    ...candidate,
    expression: rebuilt.expression,
    queryPlan: rebuilt.queryPlan,
    termsByFeature: rebuilt.termsByFeature,
    featureStateById: rebuilt.featureStateById,
    crossGroupDedupeMeta: rebuilt.crossGroupDedupeMeta
  };
  const rebuiltFingerprints = buildVersionFingerprints(rebuiltCandidate);
  const finalDuplicate = findDuplicateQueryVersion({
    queryVersions,
    candidateFingerprints: rebuiltFingerprints,
    excludeQueryVersionId: currentVersion?.queryVersionId
  });
  if (finalDuplicate) {
    return {
      candidate: {
        ...rebuiltCandidate,
        ...rebuiltFingerprints,
        duplicateOfQueryVersionId: finalDuplicate.duplicateOfQueryVersionId || duplicate.duplicateOfQueryVersionId || null,
        duplicateBlocked: true
      },
      duplicateBlocked: true,
      stillDuplicate: true,
      duplicateInfo: finalDuplicate,
      correctiveActions: uniqueStrings([
        ...(corrected.feedbackActions || []),
        "duplicate_query_blocked: stronger rebuild exhausted"
      ])
    };
  }

  return {
    candidate: {
      ...rebuiltCandidate,
      ...rebuiltFingerprints,
      duplicateOfQueryVersionId: duplicate.duplicateOfQueryVersionId || null,
      duplicateBlocked: true
    },
    duplicateBlocked: true,
    stillDuplicate: false,
    duplicateInfo: duplicate,
    correctiveActions: uniqueStrings([
      ...(corrected.feedbackActions || []),
      "duplicate_query_blocked: stronger rebuild applied"
    ])
  };
}

function splitTopLevelExpression(text, delimiterChar) {
  const src = String(text || "");
  const out = [];
  let depth = 0;
  let inQuote = false;
  let token = "";

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "\"") {
      inQuote = !inQuote;
      token += ch;
      continue;
    }
    if (!inQuote) {
      if (ch === "(") depth += 1;
      if (ch === ")" && depth > 0) depth -= 1;
      if (ch === delimiterChar && depth === 0) {
        out.push(token);
        token = "";
        continue;
      }
    }
    token += ch;
  }
  out.push(token);
  return out.map((item) => item.trim()).filter(Boolean);
}

function stripOuterParens(text) {
  const out = String(text || "").trim();
  if (out.startsWith("(") && out.endsWith(")")) {
    return out.slice(1, -1).trim();
  }
  return out;
}

function extractTermsFromExpressionGroup(groupText) {
  const body = stripOuterParens(groupText);
  return uniqueStrings(
    splitTopLevelExpression(body, "|").map((raw) => {
      const trimmed = String(raw || "").trim();
      return trimmed.replace(/^"(.*)"$/u, "$1").trim();
    })
  );
}

function deriveTermsByFeatureFromExpression({
  expression,
  features,
  featureStateById,
  fallbackTermsByFeature,
  baseQueryPlan
}) {
  return deriveQueryPlanFromExpression({
    expression,
    features,
    featureStateById,
    fallbackTermsByFeature,
    baseQueryPlan
  });
}

function deriveFeatureStateByExpression({
  expression,
  features,
  baseFeatureStateById,
  queryPlan
}) {
  const groups = splitTopLevelExpression(String(expression || "").trim(), "&");
  const groupCount = groups.length;
  const mappedFeatureIds = new Set();
  (Array.isArray(queryPlan?.groups) ? queryPlan.groups : []).forEach((group) => {
    const featureIds = Array.isArray(group?.feature_ids || group?.featureIds)
      ? (group.feature_ids || group.featureIds)
      : [];
    featureIds.forEach((featureId) => {
      const normalized = toUpperId(featureId);
      if (!normalized) return;
      mappedFeatureIds.add(normalized);
    });
  });
  const nextState = JSON.parse(JSON.stringify(baseFeatureStateById || {}));
  const featureList = Array.isArray(features) ? features : [];

  featureList.forEach((feature, index) => {
    const featureId = toUpperId(feature?.id);
    if (!featureId) return;
    const queryRole = normalizeQueryRole(feature?.query_role || feature?.queryRole, isMustFeature(feature) ? "must" : "should");
    const mappedEnabled = mappedFeatureIds.size > 0 ? mappedFeatureIds.has(featureId) : (index < groupCount);
    nextState[featureId] = {
      ...(nextState[featureId] || {}),
      enabled: mappedEnabled,
      active: mappedEnabled,
      core: queryRole === "must",
      text: String(feature.text || ""),
      queryRole,
      type: normalizeFeatureType(feature?.type, queryRole === "must" ? "anchor" : "optional"),
      weight: normalizeFeatureWeight(feature?.weight, queryRole === "must" ? 5 : 3),
      relationTo: uniqueStrings(feature?.relation_to || []),
      negative: !!feature?.negative,
      focus: false,
      simplified: false,
      phrase_locked_terms: uniqueStrings(nextState?.[featureId]?.phrase_locked_terms || [])
    };
  });

  return nextState;
}

function coveragesForEvaluation(evaluation, featureIds) {
  const hit = new Set((Array.isArray(evaluation?.featureHits) ? evaluation.featureHits : []).map(toUpperId));
  let covered = 0;
  featureIds.forEach((featureId) => {
    if (hit.has(featureId)) covered += 1;
  });
  return {
    covered,
    ratio: featureIds.length > 0 ? covered / featureIds.length : 0
  };
}

function clamp01(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function roundUnit(value) {
  return Number(clamp01(value, 0).toFixed(4));
}

function isCoverageStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  return normalized === "exact" || normalized === "equivalent" || normalized === "partial";
}

function isConflictStatus(status) {
  return String(status || "").trim().toLowerCase() === "conflict";
}

function buildFeatureStatusMap(evaluation, featureIds) {
  const normalizedFeatureIds = Array.isArray(featureIds) ? featureIds.map(toUpperId).filter(Boolean) : [];
  const statusById = {};
  normalizedFeatureIds.forEach((featureId) => {
    statusById[featureId] = "absent";
  });

  const judgments = Array.isArray(evaluation?.featureJudgments) ? evaluation.featureJudgments : [];
  judgments.forEach((judgment) => {
    const featureId = toUpperId(judgment?.featureId || judgment?.feature_id);
    if (!featureId) return;
    if (normalizedFeatureIds.length > 0 && !statusById[featureId]) return;
    const status = String(judgment?.status || "").trim().toLowerCase();
    if (!status) return;
    statusById[featureId] = status;
  });

  const hitSet = new Set((Array.isArray(evaluation?.featureHits) ? evaluation.featureHits : []).map(toUpperId));
  const missingSet = new Set((Array.isArray(evaluation?.missingFeatures) ? evaluation.missingFeatures : []).map(toUpperId));

  normalizedFeatureIds.forEach((featureId) => {
    const cur = statusById[featureId];
    if (hitSet.has(featureId) && !isCoverageStatus(cur)) {
      statusById[featureId] = "exact";
      return;
    }
    if (missingSet.has(featureId) && cur === "absent") {
      statusById[featureId] = "absent";
    }
  });

  return statusById;
}

function buildPairConflictFlags(left, right, leftStatusMap, rightStatusMap, featureIds) {
  const merged = uniqueStrings([
    ...(left?.conflictFlags || []),
    ...(right?.conflictFlags || [])
  ]);
  const out = [...merged];

  (Array.isArray(featureIds) ? featureIds : []).forEach((featureIdRaw) => {
    const featureId = toUpperId(featureIdRaw);
    if (!featureId) return;
    const leftStatus = String(leftStatusMap?.[featureId] || "absent").toLowerCase();
    const rightStatus = String(rightStatusMap?.[featureId] || "absent").toLowerCase();
    const leftCovered = isCoverageStatus(leftStatus);
    const rightCovered = isCoverageStatus(rightStatus);
    const leftConflict = isConflictStatus(leftStatus);
    const rightConflict = isConflictStatus(rightStatus);

    if (leftConflict && rightConflict) {
      out.push(`both_conflict:${featureId}`);
      return;
    }
    if ((leftConflict && rightCovered) || (rightConflict && leftCovered)) {
      out.push(`conflict_overlap:${featureId}`);
    }
  });

  return uniqueStrings(out);
}

function countHardConflicts(conflictFlags) {
  const list = Array.isArray(conflictFlags) ? conflictFlags : [];
  return list.filter((flag) => HARD_CONFLICT_PATTERN.test(String(flag || ""))).length;
}

function buildPairCandidateMetrics(left, right, featureIds) {
  const normalizedFeatureIds = (Array.isArray(featureIds) ? featureIds : []).map(toUpperId).filter(Boolean);
  const leftStatusMap = buildFeatureStatusMap(left, normalizedFeatureIds);
  const rightStatusMap = buildFeatureStatusMap(right, normalizedFeatureIds);

  const union = new Set();
  let leftOnly = 0;
  let rightOnly = 0;
  let shared = 0;

  normalizedFeatureIds.forEach((featureId) => {
    const leftCovered = isCoverageStatus(leftStatusMap[featureId]);
    const rightCovered = isCoverageStatus(rightStatusMap[featureId]);
    if (leftCovered || rightCovered) union.add(featureId);
    if (leftCovered && rightCovered) shared += 1;
    else if (leftCovered) leftOnly += 1;
    else if (rightCovered) rightOnly += 1;
  });

  const covered = union.size;
  const coverageRatio = normalizedFeatureIds.length > 0 ? covered / normalizedFeatureIds.length : 0;
  const remainingGaps = normalizedFeatureIds.filter((featureId) => !union.has(featureId));

  const exclusiveCount = leftOnly + rightOnly;
  const exclusiveRatio = covered > 0 ? (exclusiveCount / covered) : 0;
  const pairBalance = (leftOnly > 0 && rightOnly > 0)
    ? Math.min(leftOnly, rightOnly) / Math.max(leftOnly, rightOnly)
    : 0;
  const complementarity = roundUnit((exclusiveRatio * 0.75) + (pairBalance * 0.25));

  const leftField = clamp01(left?.fieldSimilarity, 0.5);
  const rightField = clamp01(right?.fieldSimilarity, 0.5);
  const fieldProximity = roundUnit(((leftField + rightField) / 2) - (Math.abs(leftField - rightField) * 0.25));

  const pairFillValue = roundUnit((clamp01(left?.pairFillValue, 0.5) + clamp01(right?.pairFillValue, 0.5)) / 2);
  const minScore = Math.min(left?.score ?? 0, right?.score ?? 0);
  const minScoreNormalized = clamp01(minScore / 100, 0);

  const conflictFlags = buildPairConflictFlags(left, right, leftStatusMap, rightStatusMap, normalizedFeatureIds);
  const hardConflictCount = countHardConflicts(conflictFlags);
  const softConflictCount = Math.max(0, conflictFlags.length - hardConflictCount);
  const lowConflict = hardConflictCount === 0 && conflictFlags.length <= PAIR_CONFLICT_SOFT_LIMIT;
  const conflictPenalty = Math.min(0.55, (hardConflictCount * 0.24) + (softConflictCount * 0.08));

  const combinePlausibility = roundUnit(
    (coverageRatio * 0.34)
    + (complementarity * 0.24)
    + (fieldProximity * 0.18)
    + (pairFillValue * 0.14)
    + (minScoreNormalized * 0.10)
    - conflictPenalty
  );

  const pairPlausible = remainingGaps.length === 0
    && minScore >= EVAL_SCORE_SUPPORT
    && lowConflict
    && combinePlausibility >= PAIR_PLAUSIBILITY_HIGH;

  return {
    left,
    right,
    covered,
    coverageRatio: roundUnit(coverageRatio),
    minScore,
    complementarity,
    fieldProximity,
    combinePlausibility,
    conflictFlags,
    hardConflictCount,
    lowConflict,
    remainingGaps,
    pairPlausible
  };
}

function buildPairCandidates(evaluations, featureIds) {
  const candidates = [];
  const top = (Array.isArray(evaluations) ? evaluations : [])
    .filter((item) => typeof item.score === "number" && item.score >= EVAL_SCORE_SUPPORT)
    .slice(0, 12);

  for (let i = 0; i < top.length; i += 1) {
    for (let j = i + 1; j < top.length; j += 1) {
      const left = top[i];
      const right = top[j];
      candidates.push(buildPairCandidateMetrics(left, right, featureIds));
    }
  }

  candidates.sort((a, b) => {
    if (Number(b.pairPlausible) !== Number(a.pairPlausible)) {
      return Number(b.pairPlausible) - Number(a.pairPlausible);
    }
    if (b.combinePlausibility !== a.combinePlausibility) return b.combinePlausibility - a.combinePlausibility;
    if (Number(b.lowConflict) !== Number(a.lowConflict)) {
      return Number(b.lowConflict) - Number(a.lowConflict);
    }
    if (b.coverageRatio !== a.coverageRatio) return b.coverageRatio - a.coverageRatio;
    if (b.minScore !== a.minScore) return b.minScore - a.minScore;
    return 0;
  });

  return candidates;
}

function buildActionSignals(evaluations) {
  const addMap = new Map();
  const removeMap = new Map();

  (Array.isArray(evaluations) ? evaluations : []).forEach((row) => {
    const score = typeof row?.score === "number" ? row.score : null;
    if (score === null) return;

    if (score >= EVAL_SCORE_SUPPORT) {
      (row.addTerms || []).forEach((termEntry) => {
        const featureId = toUpperId(termEntry?.featureId);
        const term = String(termEntry?.term || "").trim();
        if (!term) return;
        const key = `${featureId}::${term.toLowerCase()}`;
        const prev = addMap.get(key) || { featureId, term, count: 0 };
        prev.count += 1;
        addMap.set(key, prev);
      });
    }

    if (score < 40) {
      (row.removeTerms || []).forEach((termEntry) => {
        const featureId = toUpperId(termEntry?.featureId);
        const term = String(termEntry?.term || "").trim();
        if (!term) return;
        const key = `${featureId}::${term.toLowerCase()}`;
        const prev = removeMap.get(key) || { featureId, term, count: 0 };
        prev.count += 1;
        removeMap.set(key, prev);
      });
    }
  });

  const sortFn = (a, b) => b.count - a.count;
  return {
    addCandidates: Array.from(addMap.values()).sort(sortFn),
    removeCandidates: Array.from(removeMap.values()).sort(sortFn)
  };
}

function buildCorpusFeedbackSummary(evaluations, features, summary, signals) {
  const rows = Array.isArray(evaluations) ? evaluations : [];
  const scoredRows = rows.filter((row) => typeof row?.score === "number");
  const featureIds = (Array.isArray(features) ? features : []).map((feature) => toUpperId(feature?.id));
  const featureStatsMap = new Map(
    featureIds.map((featureId) => [
      featureId,
      {
        hitCount: 0,
        missingCount: 0
      }
    ])
  );

  const scoreDistribution = {
    high: 0, // >=85
    support: 0, // 60~84
    mid: 0, // 40~59
    low: 0 // <40
  };

  for (const row of scoredRows) {
    const score = row.score;
    if (score >= EVAL_SCORE_HIGH) scoreDistribution.high += 1;
    else if (score >= EVAL_SCORE_SUPPORT) scoreDistribution.support += 1;
    else if (score >= 40) scoreDistribution.mid += 1;
    else scoreDistribution.low += 1;

    const hitSet = new Set((Array.isArray(row.featureHits) ? row.featureHits : []).map(toUpperId));
    const missingSet = new Set((Array.isArray(row.missingFeatures) ? row.missingFeatures : []).map(toUpperId));

    for (const featureId of featureIds) {
      const stats = featureStatsMap.get(featureId);
      if (!stats) continue;
      if (hitSet.has(featureId)) stats.hitCount += 1;
      if (missingSet.has(featureId)) stats.missingCount += 1;
    }
  }

  const denominator = scoredRows.length || 1;
  const featureStats = (Array.isArray(features) ? features : []).map((feature) => {
    const id = toUpperId(feature?.id);
    const stats = featureStatsMap.get(id) || { hitCount: 0, missingCount: 0 };
    const hitRatio = stats.hitCount / denominator;
    const missingRatio = stats.missingCount / denominator;
    return {
      featureId: id,
      featureText: clipText(feature?.text || "", 140),
      hitCount: stats.hitCount,
      missingCount: stats.missingCount,
      hitRatio: Number(hitRatio.toFixed(4)),
      missingRatio: Number(missingRatio.toFixed(4))
    };
  });

  const reinforceFeatures = [...featureStats]
    .sort((a, b) => {
      if (a.hitRatio !== b.hitRatio) return a.hitRatio - b.hitRatio;
      return b.missingRatio - a.missingRatio;
    })
    .slice(0, 3)
    .map((row) => row.featureId);

  const alreadyCoveredFeatures = [...featureStats]
    .filter((row) => row.hitRatio >= 0.65)
    .sort((a, b) => b.hitRatio - a.hitRatio)
    .slice(0, 3)
    .map((row) => row.featureId);

  const highRows = [...scoredRows]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 5)
    .map((row) => ({
      applicationNo: row.applicationNo || "",
      score: row.score ?? null,
      featureHits: Array.isArray(row.featureHits) ? row.featureHits : [],
      missingFeatures: Array.isArray(row.missingFeatures) ? row.missingFeatures : [],
      reason: clipText(row.reason || "", MAX_REASON_TEXT)
    }));

  const lowRows = [...scoredRows]
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
    .slice(0, 5)
    .map((row) => ({
      applicationNo: row.applicationNo || "",
      score: row.score ?? null,
      featureHits: Array.isArray(row.featureHits) ? row.featureHits : [],
      missingFeatures: Array.isArray(row.missingFeatures) ? row.missingFeatures : [],
      reason: clipText(row.reason || "", MAX_REASON_TEXT)
    }));

  const reasonSamples = uniqueStrings(highRows.map((row) => row.reason).filter(Boolean)).slice(0, 6);

  const addCandidates = (Array.isArray(signals?.addCandidates) ? signals.addCandidates : [])
    .slice(0, 10)
    .map((row) => ({
      featureId: toUpperId(row?.featureId),
      term: String(row?.term || "").trim(),
      count: Number(row?.count || 0)
    }))
    .filter((row) => row.featureId && row.term);

  const removeCandidates = (Array.isArray(signals?.removeCandidates) ? signals.removeCandidates : [])
    .slice(0, 10)
    .map((row) => ({
      featureId: toUpperId(row?.featureId),
      term: String(row?.term || "").trim(),
      count: Number(row?.count || 0)
    }))
    .filter((row) => row.featureId && row.term);

  return {
    totalRows: rows.length,
    scoredRows: scoredRows.length,
    scoreDistribution,
    topScore: summary?.topScore ?? null,
    coverage: summary?.coverage ?? null,
    featureStats,
    reinforceFeatures,
    alreadyCoveredFeatures,
    representativeDocs: {
      high: highRows,
      low: lowRows
    },
    reasonSamples,
    termSignals: {
      addCandidates,
      removeCandidates
    }
  };
}

function normalizeRangeTuple(value, fallback = [0, 0]) {
  const source = Array.isArray(value) ? value : fallback;
  const first = Number(source?.[0]);
  const second = Number(source?.[1]);
  const left = Number.isFinite(first) ? Math.max(0, Math.floor(first)) : Number(fallback?.[0] || 0);
  const rightRaw = Number.isFinite(second) ? Math.max(0, Math.floor(second)) : Number(fallback?.[1] || left);
  const right = Math.max(left, rightRaw);
  return [left, right];
}

function normalizeCountContext({
  countContext = null,
  iterations = [],
  summary = null
} = {}) {
  const safe = countContext && typeof countContext === "object" ? countContext : {};
  const targetCountRange = normalizeRangeTuple(safe.targetCountRange, TARGET_COUNT_RANGE_DEFAULT);
  const softTargetRange = normalizeRangeTuple(safe.softTargetRange, SOFT_TARGET_RANGE_DEFAULT);

  const previousIteration = Array.isArray(iterations) && iterations.length > 0
    ? iterations[iterations.length - 1]
    : null;
  const previousResultCount = Number.isFinite(Number(safe.previousResultCount))
    ? Math.max(0, Math.floor(Number(safe.previousResultCount)))
    : (
      Number.isFinite(Number(previousIteration?.currentResultCount))
        ? Math.max(0, Math.floor(Number(previousIteration.currentResultCount)))
        : null
    );
  const currentResultCount = Number.isFinite(Number(safe.currentResultCount))
    ? Math.max(0, Math.floor(Number(safe.currentResultCount)))
    : (
      Number.isFinite(Number(summary?.resultCount))
        ? Math.max(0, Math.floor(Number(summary.resultCount)))
        : null
    );
  const classified = classifyResultCount(currentResultCount);
  const countSource = normalizeCountSource(safe.countSource || "unknown");
  const countBucket = String(safe.countBucket || classified.bucket || "unknown").trim() || "unknown";
  const reductionRatio = Number.isFinite(Number(safe.reductionRatio))
    ? Number(safe.reductionRatio)
    : computeReductionRatio(previousResultCount, currentResultCount);
  const repeatReasonSignature = String(
    safe.repeatReasonSignature
    || buildRepeatReasonSignature({
      decision: classified.decision,
      countBucket,
      previousBucket: String(previousIteration?.countBucket || ""),
      reductionRatio
    })
  ).trim();
  const repeatReasonCount = Math.max(
    1,
    Number.isFinite(Number(safe.repeatReasonCount))
      ? Math.floor(Number(safe.repeatReasonCount))
      : countRecentSignatureRepeats(iterations, repeatReasonSignature, 4)
  );
  const countDistanceScore = Number.isFinite(Number(safe.countDistanceScore))
    ? Number(safe.countDistanceScore)
    : computeCountDistanceScore(currentResultCount, targetCountRange, softTargetRange);

  return {
    targetCountRange,
    softTargetRange,
    currentResultCount,
    previousResultCount,
    countSource,
    countBucket,
    countDistanceScore,
    reductionRatio,
    repeatReasonSignature,
    repeatReasonCount,
    decision: classified.decision
  };
}

export function deriveEscalationFamily({
  mode = "balanced",
  countBucket = "unknown",
  repeatReasonCount = 1,
  repeatReasonSignature = ""
} = {}) {
  const normalizedMode = String(mode || "balanced").trim().toLowerCase();
  const bucket = String(countBucket || "unknown").trim().toLowerCase();
  const signature = String(repeatReasonSignature || "").trim().toLowerCase();
  const repeat = Math.max(1, Number.isFinite(Number(repeatReasonCount)) ? Math.floor(Number(repeatReasonCount)) : 1);

  if (normalizedMode === "narrow") {
    if (repeat >= 4) return "anti_cluster_rebuild";
    if (repeat >= 3) return "anti_noise_narrow";
    if (repeat >= 2) return "split_feature_narrow";
    if (bucket === "over_10000" || signature.includes("low_reduction")) return "split_feature_narrow";
    return "standard_narrow";
  }

  if (normalizedMode === "widen") {
    if (repeat >= 3) return "anchor_rebuild_widen";
    return "standard_widen";
  }

  if (normalizedMode === "rebuild") {
    return "anti_cluster_rebuild";
  }
  return "balanced_shift";
}

function buildQueryHistoryContext(queryVersions, iterations, feedbackLog) {
  const versionList = Array.isArray(queryVersions) ? queryVersions : [];
  const iterationList = Array.isArray(iterations) ? iterations : [];
  const logs = Array.isArray(feedbackLog) ? feedbackLog : [];

  const iterByQueryVersionId = new Map();
  iterationList.forEach((iteration) => {
    const key = String(iteration?.queryVersionId || "").trim();
    if (!key) return;
    iterByQueryVersionId.set(key, iteration);
  });

  const recentQueries = versionList
    .slice(-12)
    .map((version) => {
      const queryVersionId = String(version?.queryVersionId || "").trim();
      const matchedIter = queryVersionId ? iterByQueryVersionId.get(queryVersionId) : null;
      const historyWeight = getQueryHistoryWeight(version);
      const fingerprints = buildVersionFingerprintsFromHistoryEntry(version);
      return {
        queryVersionId,
        source: String(version?.source || "").trim(),
        refineMode: String(version?.refineMode || "").trim(),
        historyWeight,
        expression: clipText(version?.expression || "", MAX_QUERY_EXPRESSION_TEXT),
        fingerprint: fingerprints.fingerprint,
        semanticFingerprint: fingerprints.semanticFingerprint,
        active_terms: (Array.isArray(fingerprints.activeTerms) ? fingerprints.activeTerms : []).slice(0, 30),
        resultCount: matchedIter?.resultCount ?? null,
        currentResultCount: matchedIter?.currentResultCount ?? null,
        countSource: matchedIter?.countSource ?? null,
        countBucket: matchedIter?.countBucket ?? null,
        countDistanceScore: matchedIter?.countDistanceScore ?? null,
        reductionRatio: matchedIter?.reductionRatio ?? null,
        repeatReasonSignature: matchedIter?.repeatReasonSignature ?? "",
        repeatReasonCount: matchedIter?.repeatReasonCount ?? null,
        topScore: matchedIter?.topScore ?? null,
        coverage: matchedIter?.coverage ?? null,
        feedbackActions: (Array.isArray(version?.feedbackActions) ? version.feedbackActions : []).slice(0, 5)
      };
    })
    .filter((row) => row.queryVersionId);

  const lowQualityQueryVersionIds = recentQueries
    .filter((row) => (typeof row.topScore === "number" && row.topScore < 40) || row.resultCount === 0)
    .map((row) => row.queryVersionId);

  const goodQualityQueryVersionIds = recentQueries
    .filter((row) => (typeof row.topScore === "number" && row.topScore >= 70) || (typeof row.coverage === "number" && row.coverage >= 0.7))
    .map((row) => row.queryVersionId);

  const preferredQueryVersionIds = recentQueries
    .filter((row) => row.historyWeight >= 3)
    .map((row) => row.queryVersionId);

  const avoidQueryFingerprints = uniqueStrings(
    versionList
      .map((version) => buildVersionFingerprintsFromHistoryEntry(version).fingerprint)
      .filter(Boolean)
  ).slice(-120);

  const avoidSemanticQueryFingerprints = uniqueStrings(
    versionList
      .map((version) => buildVersionFingerprintsFromHistoryEntry(version).semanticFingerprint)
      .filter(Boolean)
  ).slice(-120);

  const weightedNotes = [];
  logs.forEach((entry) => {
    const text = String(entry?.text || "").trim();
    if (!text) return;
    const clipped = clipText(text, 220);
    weightedNotes.push(clipped);
    if (/manual[_\s-]*edit|user\s*edit/i.test(text)) {
      weightedNotes.push(clipped);
    }
  });
  const feedbackNotes = weightedNotes.slice(0, 24);
  const repeatReasonSignatures = recentQueries
    .map((row) => String(row?.repeatReasonSignature || "").trim())
    .filter(Boolean);

  return {
    recentQueries,
    lowQualityQueryVersionIds,
    goodQualityQueryVersionIds,
    preferredQueryVersionIds,
    avoidQueryFingerprints,
    avoidSemanticQueryFingerprints,
    feedbackNotes,
    repeatReasonSignatures
  };
}

export function pickRecentQuerySummariesForPrompt(recentQueries, limit = REFINE_PROMPT_RECENT_HISTORY_LIMIT) {
  const rows = Array.isArray(recentQueries) ? recentQueries : [];
  const safeLimit = Math.max(1, Math.min(12, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : REFINE_PROMPT_RECENT_HISTORY_LIMIT));
  return rows
    .slice(-safeLimit)
    .map((row) => ({
      queryVersionId: String(row?.queryVersionId || "").trim(),
      mode: String(row?.refineMode || row?.source || "").trim(),
      resultCount: row?.currentResultCount ?? row?.resultCount ?? null,
      topScore: row?.topScore ?? null,
      coverage: row?.coverage ?? null,
      fingerprint: String(row?.fingerprint || "").trim(),
      semanticFingerprint: String(row?.semanticFingerprint || "").trim(),
      expression: clipText(row?.expression || "", 160)
    }))
    .filter((row) => row.queryVersionId);
}

function summarizeCurrentQueryForRefine({
  currentVersion,
  queryPlan,
  termsByFeature,
  featureStateById
}) {
  const groups = Array.isArray(queryPlan?.groups) ? queryPlan.groups : [];
  const activeGroups = groups
    .filter((group) => group?.active !== false)
    .slice(0, REFINE_PROMPT_MAX_GROUPS)
    .map((group) => {
      const featureIds = Array.isArray(group?.feature_ids || group?.featureIds)
        ? (group.feature_ids || group.featureIds).map((featureId) => toUpperId(featureId)).filter(Boolean)
        : [];
      return {
        group_id: String(group?.group_id || group?.groupId || "").trim(),
        feature_ids: featureIds.slice(0, 3),
        required: group?.required === true,
        mode: String(group?.mode || "").trim(),
        terms: uniqueStrings(group?.terms || []).slice(0, 2)
      };
    });

  const activeFeatureIds = uniqueStrings(
    activeGroups.flatMap((group) => Array.isArray(group?.feature_ids) ? group.feature_ids : [])
  ).map((id) => toUpperId(id)).filter(Boolean);
  const coreOrFocusFeatureIds = Object.entries(featureStateById && typeof featureStateById === "object" ? featureStateById : {})
    .filter(([, state]) => state?.core === true || state?.focus === true || state?.active === true)
    .map(([featureId]) => toUpperId(featureId))
    .filter(Boolean);
  const selectedFeatureIds = uniqueStrings([
    ...activeFeatureIds,
    ...coreOrFocusFeatureIds
  ]).slice(0, REFINE_PROMPT_MAX_FEATURES);

  const compactTermsByFeature = {};
  selectedFeatureIds.forEach((featureId) => {
    const terms = uniqueStrings(termsByFeature?.[featureId] || []).slice(0, 2);
    if (!terms.length) return;
    compactTermsByFeature[featureId] = terms;
  });

  return {
    queryVersionId: String(currentVersion?.queryVersionId || "").trim(),
    expression: clipText(currentVersion?.expression || "", MAX_QUERY_EXPRESSION_TEXT),
    active_groups: activeGroups,
    terms_by_feature: compactTermsByFeature,
    selectedFeatureIds
  };
}

function summarizeFeaturesForRefine(features, featureStateById, selectedFeatureIds = []) {
  const selectedSet = new Set((Array.isArray(selectedFeatureIds) ? selectedFeatureIds : []).map((id) => toUpperId(id)));
  return (Array.isArray(features) ? features : [])
    .map((feature, index) => {
      const featureId = toUpperId(feature?.id || `F${index + 1}`);
      if (!featureId) return null;
      const state = featureStateById?.[featureId] || {};
      return {
        id: featureId,
        type: normalizeFeatureType(feature?.type || state?.type, "optional"),
        query_role: normalizeQueryRole(feature?.query_role || feature?.queryRole || state?.queryRole, "should"),
        weight: normalizeFeatureWeight(feature?.weight ?? state?.weight, 3),
        active: state?.active === true,
        focus: state?.focus === true,
        selected: selectedSet.has(featureId)
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (Number(right.selected) !== Number(left.selected)) {
        return Number(right.selected) - Number(left.selected);
      }
      if (Number(right.active) !== Number(left.active)) {
        return Number(right.active) - Number(left.active);
      }
      return (Number(right.weight) || 0) - (Number(left.weight) || 0);
    })
    .slice(0, REFINE_PROMPT_MAX_FEATURES);
}

function summarizeCorpusSignalForRefine(corpusSummary, signals) {
  const addCandidates = (Array.isArray(signals?.addCandidates) ? signals.addCandidates : [])
    .slice(0, 4)
    .map((row) => ({
      feature_id: toUpperId(row?.featureId),
      term: String(row?.term || "").trim(),
      count: Number(row?.count || 0)
    }))
    .filter((row) => row.feature_id && row.term);
  const removeCandidates = (Array.isArray(signals?.removeCandidates) ? signals.removeCandidates : [])
    .slice(0, 4)
    .map((row) => ({
      feature_id: toUpperId(row?.featureId),
      term: String(row?.term || "").trim(),
      count: Number(row?.count || 0)
    }))
    .filter((row) => row.feature_id && row.term);

  return {
    score_distribution: corpusSummary?.scoreDistribution || { high: 0, support: 0, mid: 0, low: 0 },
    top_score: corpusSummary?.topScore ?? null,
    coverage: corpusSummary?.coverage ?? null,
    reinforce_features: (Array.isArray(corpusSummary?.reinforceFeatures) ? corpusSummary.reinforceFeatures : []).slice(0, 4),
    gap_features: (Array.isArray(corpusSummary?.reinforceFeatures) ? corpusSummary.reinforceFeatures : []).slice(0, 4),
    saturated_features: (Array.isArray(corpusSummary?.alreadyCoveredFeatures) ? corpusSummary.alreadyCoveredFeatures : []).slice(0, 4),
    add_term_candidates: addCandidates,
    remove_term_candidates: removeCandidates
  };
}

function summarizeCountControlForRefine(normalizedCountContext) {
  return {
    target_range: Array.isArray(normalizedCountContext?.targetCountRange)
      ? normalizedCountContext.targetCountRange.slice(0, 2)
      : TARGET_COUNT_RANGE_DEFAULT.slice(0, 2),
    current: normalizedCountContext?.currentResultCount ?? null,
    previous: normalizedCountContext?.previousResultCount ?? null,
    bucket: String(normalizedCountContext?.countBucket || "unknown").trim() || "unknown",
    source: normalizeCountSource(normalizedCountContext?.countSource || "unknown"),
    reduction_ratio: normalizedCountContext?.reductionRatio ?? null,
    repeat_reason_signature: String(normalizedCountContext?.repeatReasonSignature || "").trim(),
    repeat_reason_count: Number.isFinite(Number(normalizedCountContext?.repeatReasonCount))
      ? Math.max(1, Math.floor(Number(normalizedCountContext.repeatReasonCount)))
      : 1
  };
}

export function buildDuplicateRetryHintPayload({
  resolved,
  historyContext,
  retryAttempt = 2
} = {}) {
  const duplicateInfo = resolved?.duplicateInfo || {};
  const matchType = String(duplicateInfo?.matchType || "").trim() || "unknown";
  const blockedFingerprints = uniqueStrings([
    ...(matchType === "fingerprint"
      ? [String(duplicateInfo?.fingerprint || "").trim()]
      : []),
    ...(matchType === "semantic_fingerprint"
      ? [String(duplicateInfo?.semanticFingerprint || "").trim()]
      : []),
    ...(Array.isArray(historyContext?.avoidQueryFingerprints) ? historyContext.avoidQueryFingerprints.slice(-3) : []),
    ...(Array.isArray(historyContext?.avoidSemanticQueryFingerprints) ? historyContext.avoidSemanticQueryFingerprints.slice(-3) : [])
  ]).filter(Boolean).slice(0, 6);

  return {
    duplicateOfQueryVersionId: String(duplicateInfo?.duplicateOfQueryVersionId || "").trim(),
    matchType,
    blockedFingerprints,
    retryAttempt: Math.max(2, Number.isFinite(Number(retryAttempt)) ? Math.floor(Number(retryAttempt)) : 2)
  };
}

export function shouldRetryDuplicateRefine({
  stillDuplicate = false,
  skipLlm = false,
  retryAttempt = 1,
  maxAttempts = REFINE_DUPLICATE_RETRY_MAX
} = {}) {
  if (skipLlm === true) return false;
  if (stillDuplicate !== true) return false;
  const attempt = Number.isFinite(Number(retryAttempt)) ? Math.floor(Number(retryAttempt)) : 1;
  const max = Math.max(1, Number.isFinite(Number(maxAttempts)) ? Math.floor(Number(maxAttempts)) : REFINE_DUPLICATE_RETRY_MAX);
  return attempt < max;
}

export function buildCompactRefineContext({
  features,
  currentVersion,
  workingQueryPlan,
  workingTermsByFeature,
  featureStateById,
  summary,
  signals,
  corpusSummary,
  normalizedCountContext,
  historyContext,
  manualGate = null,
  duplicateRetryHint = null
} = {}) {
  const currentQuery = summarizeCurrentQueryForRefine({
    currentVersion,
    queryPlan: workingQueryPlan,
    termsByFeature: workingTermsByFeature,
    featureStateById
  });
  const featureSummary = summarizeFeaturesForRefine(
    features,
    featureStateById,
    currentQuery.selectedFeatureIds
  );
  const historyRecent = pickRecentQuerySummariesForPrompt(
    historyContext?.recentQueries,
    REFINE_PROMPT_RECENT_HISTORY_LIMIT
  );

  const out = {
    current_query: {
      queryVersionId: currentQuery.queryVersionId,
      expression: currentQuery.expression,
      active_groups: currentQuery.active_groups,
      terms_by_feature: currentQuery.terms_by_feature
    },
    features: featureSummary,
    summary: {
      resultCount: summary?.resultCount ?? null,
      topScore: summary?.topScore ?? null,
      coverage: summary?.coverage ?? null
    },
    count_control: summarizeCountControlForRefine(normalizedCountContext),
    corpus_signal: summarizeCorpusSignalForRefine(corpusSummary, signals),
    history_recent: historyRecent
  };

  if (manualGate && typeof manualGate === "object") {
    out.manual_gate = {
      decision: String(manualGate?.decision || "").trim(),
      desired_mode: String(manualGate?.desired_mode || manualGate?.desiredMode || "").trim(),
      repeat_count: Number.isFinite(Number(manualGate?.repeat_count ?? manualGate?.repeatCount))
        ? Math.max(1, Math.floor(Number(manualGate.repeat_count ?? manualGate.repeatCount)))
        : 1,
      intensity: String(manualGate?.intensity || "").trim(),
      instruction: clipText(manualGate?.instruction || "", 220)
    };
  }

  if (duplicateRetryHint && typeof duplicateRetryHint === "object") {
    out.duplicate_retry_hint = {
      duplicateOfQueryVersionId: String(duplicateRetryHint?.duplicateOfQueryVersionId || "").trim(),
      matchType: String(duplicateRetryHint?.matchType || "").trim(),
      blockedFingerprints: uniqueStrings(duplicateRetryHint?.blockedFingerprints || []).slice(0, 6),
      retryAttempt: Number.isFinite(Number(duplicateRetryHint?.retryAttempt))
        ? Math.max(2, Math.floor(Number(duplicateRetryHint.retryAttempt)))
        : 2
    };
  }

  return out;
}

function buildDuplicateRepairContext({
  features,
  currentVersion,
  workingQueryPlan,
  workingTermsByFeature,
  featureStateById,
  trigger = null
} = {}) {
  const currentQuery = summarizeCurrentQueryForRefine({
    currentVersion,
    queryPlan: workingQueryPlan,
    termsByFeature: workingTermsByFeature,
    featureStateById
  });
  const featureSummary = summarizeFeaturesForRefine(
    features,
    featureStateById,
    currentQuery.selectedFeatureIds
  );

  const triggerObj = trigger && typeof trigger === "object" ? trigger : {};
  return {
    current_query: {
      queryVersionId: currentQuery.queryVersionId,
      expression: currentQuery.expression,
      active_groups: currentQuery.active_groups,
      terms_by_feature: currentQuery.terms_by_feature
    },
    features: featureSummary,
    trigger: {
      reason: String(triggerObj?.reason || triggerObj?.type || "").trim(),
      duplicate_of_query_version_id: String(
        triggerObj?.duplicateOfQueryVersionId
        || triggerObj?.duplicate_of_query_version_id
        || ""
      ).trim(),
      duplicate_match_type: String(triggerObj?.matchType || triggerObj?.duplicate_match_type || "").trim(),
      duplicate_fingerprint: String(triggerObj?.fingerprint || "").trim(),
      duplicate_semantic_fingerprint: String(triggerObj?.semanticFingerprint || "").trim()
    }
  };
}

function getDesiredModeFromManualDecision(decision) {
  const value = String(decision || "").trim().toLowerCase();
  if (value === "too_many") return "narrow";
  if (value === "too_few") return "widen";
  return "balanced";
}

function buildManualGateFeedback(decision, repeatCount) {
  const desiredMode = getDesiredModeFromManualDecision(decision);
  const level = Math.max(1, Math.min(3, Number.isFinite(Number(repeatCount)) ? Number(repeatCount) : 1));
  const intensity = level >= 3 ? "strict" : (level === 2 ? "strong" : "normal");

  if (desiredMode === "widen") {
    const instruction = level >= 3
      ? "Simplify first: atomize phrase-like terms, remove narrow/locked over-specific terms, drop one weak restrictive group, and broaden only one selected gap feature with one atomic term."
      : (level === 2
        ? "Simplify first: dephrase to one-word atoms, denarrow, then broaden only selected gap features."
        : "Widen by simplification first: one-word atoms, remove over-specific terms, optional single weak group drop.");
    return { desiredMode, level, intensity, instruction };
  }

  if (desiredMode === "narrow") {
    const instruction = level >= 3
      ? "Narrow by precision first: promote one high-priority feature to required AND, keep one atomic term per group, then trim noisy terms and apply one extra narrow atom only on focus feature."
      : (level === 2
        ? "Add one more important AND constraint first, then remove noisy terms; keep atomic one-word terms."
        : "Do not only prune synonyms: add one discriminative required group, then trim noise.");
    return { desiredMode, level, intensity, instruction };
  }

  return {
    desiredMode: "balanced",
    level,
    intensity,
    instruction: "Keep direction but apply small adjustments around weak features."
  };
}

function hasUnmappedQueryPlanGroups(queryPlan) {
  const groups = Array.isArray(queryPlan?.groups) ? queryPlan.groups : [];
  return groups.some((group) => {
    const featureIds = Array.isArray(group?.feature_ids || group?.featureIds)
      ? (group.feature_ids || group.featureIds)
      : [];
    const groupId = String(group?.group_id || group?.groupId || "").trim().toUpperCase();
    return featureIds.length === 0 || groupId.startsWith("UNMAPPED");
  });
}

function applyQueryPlanToTermsByFeature(baseTermsByFeature, queryPlan) {
  const next = JSON.parse(JSON.stringify(baseTermsByFeature || {}));
  (Array.isArray(queryPlan?.groups) ? queryPlan.groups : []).forEach((group) => {
    const terms = uniqueStrings(group?.terms || []);
    if (!terms.length) return;
    const featureIds = Array.isArray(group?.feature_ids || group?.featureIds)
      ? (group.feature_ids || group.featureIds)
      : [];
    featureIds.forEach((featureIdRaw) => {
      const featureId = toUpperId(featureIdRaw);
      if (!featureId) return;
      next[featureId] = terms.slice(0, 10);
    });
  });
  return next;
}

async function remapUnmappedQueryPlanWithLlm({
  claimText,
  features,
  expression,
  queryPlan,
  termsByFeature,
  featureStateById,
  modelName,
  onLog,
  settings = null
}) {
  const groups = Array.isArray(queryPlan?.groups) ? queryPlan.groups : [];
  const unmappedGroups = groups.filter((group) => {
    const featureIds = Array.isArray(group?.feature_ids || group?.featureIds)
      ? (group.feature_ids || group.featureIds)
      : [];
    const groupId = String(group?.group_id || group?.groupId || "").trim().toUpperCase();
    return featureIds.length === 0 || groupId.startsWith("UNMAPPED");
  });

  if (!unmappedGroups.length) {
    return {
      applied: false,
      queryPlan,
      termsByFeature
    };
  }

  try {
    const result = await requestStructuredJson("query_plan_remap", {
      claim_text: claimText,
      features_json: JSON.stringify(features || []),
      query_expression: String(expression || "").trim(),
      query_plan_json: JSON.stringify(queryPlan || { groups: [] }),
      unmapped_groups_json: JSON.stringify(unmappedGroups)
    }, {
      modelName,
      onLog,
      settings
    });

    const featureIdSet = new Set((Array.isArray(features) ? features : []).map((feature) => toUpperId(feature?.id)).filter(Boolean));
    const normalizedMappings = (Array.isArray(result?.parsed?.group_mappings) ? result.parsed.group_mappings : [])
      .map((entry) => {
        const groupId = String(entry?.group_id || entry?.groupId || "").trim();
        if (!groupId) return null;
        const confidenceRaw = Number(entry?.confidence);
        const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0;
        const featureIds = uniqueStrings(entry?.feature_ids || entry?.featureIds)
          .map((id) => toUpperId(id))
          .filter((id) => featureIdSet.has(id));
        if (!featureIds.length) return null;
        if (confidence < 0.55) return null;
        return {
          groupId,
          confidence,
          featureIds,
          reason: String(entry?.reason || "").trim()
        };
      })
      .filter(Boolean);

    if (!normalizedMappings.length) {
      return {
        applied: false,
        queryPlan,
        termsByFeature,
        notes: String(result?.parsed?.notes || "").trim()
      };
    }

    const mappingByGroupId = new Map(normalizedMappings.map((entry) => [entry.groupId, entry]));
    const nextGroups = groups.map((group) => {
      const groupId = String(group?.group_id || group?.groupId || "").trim();
      const mapped = mappingByGroupId.get(groupId);
      if (!mapped) return group;
      return {
        ...group,
        feature_ids: mapped.featureIds,
        reason: `${String(group?.reason || "").trim()} | LLM remap(${mapped.confidence.toFixed(2)}): ${mapped.reason || "mapped"}`
      };
    });

    const normalizedQueryPlan = normalizeQueryPlan({
      queryPlan: { groups: nextGroups },
      features,
      termsByFeature,
      featureStateById
    });
    const nextTermsByFeature = applyQueryPlanToTermsByFeature(termsByFeature, normalizedQueryPlan);

    return {
      applied: true,
      queryPlan: normalizedQueryPlan,
      termsByFeature: nextTermsByFeature,
      notes: String(result?.parsed?.notes || "").trim(),
      mappedGroupIds: normalizedMappings.map((entry) => entry.groupId)
    };
  } catch (error) {
    onLog?.(`query_plan_remap skipped: ${error?.message || String(error)}`);
    return {
      applied: false,
      queryPlan,
      termsByFeature
    };
  }
}

function normalizeNoisyTermsByFeatureMap(raw, featureIds) {
  const out = {};
  const featureSet = new Set((Array.isArray(featureIds) ? featureIds : []).map(toUpperId));
  if (!raw || typeof raw !== "object") return out;
  Object.entries(raw).forEach(([featureIdRaw, terms]) => {
    const featureId = toUpperId(featureIdRaw);
    if (!featureId) return;
    if (featureSet.size && !featureSet.has(featureId)) return;
    const normalized = uniqueStrings(terms);
    if (!normalized.length) return;
    out[featureId] = normalized;
  });
  return out;
}

function inferCorpusDecisionLabel({ summary, corpusSummary, requestedMode }) {
  const dist = corpusSummary?.scoreDistribution || {};
  const low = Number(dist.low || 0);
  const high = Number(dist.high || 0);
  const support = Number(dist.support || 0);
  const scoredRows = Number(corpusSummary?.scoredRows || 0);

  if (summary?.singleHit) return "single_near_hit";
  if (summary?.pairHit) return "pair_candidate_region";

  if (scoredRows > 0 && low >= Math.max(4, high + support + 1)) {
    return "noise_cluster_dominant";
  }

  const featureStats = Array.isArray(corpusSummary?.featureStats) ? corpusSummary.featureStats : [];
  const missingHeavy = featureStats.filter((row) => Number(row?.missingRatio || 0) >= 0.6).length;
  if (missingHeavy >= Math.max(1, Math.ceil(featureStats.length / 2))) {
    return "gap_feature_missing_everywhere";
  }

  if (requestedMode === "narrow") return "noise_cluster_dominant";
  if (requestedMode === "widen") return "gap_feature_missing_everywhere";
  return "restart_direction";
}

function deriveDefaultNoisyTermsByFeature(signals, featureIds) {
  const out = {};
  const featureSet = new Set((Array.isArray(featureIds) ? featureIds : []).map(toUpperId));
  (Array.isArray(signals?.removeCandidates) ? signals.removeCandidates : []).forEach((entry) => {
    const featureId = toUpperId(entry?.featureId);
    const term = String(entry?.term || "").trim();
    if (!term) return;
    if (featureSet.size && featureId && !featureSet.has(featureId)) return;
    const key = featureId || "__UNSCOPED__";
    out[key] = uniqueStrings([...(out[key] || []), term]).slice(0, 8);
  });
  return out;
}

function buildCorpusDecisionEnvelope({
  features,
  summary,
  corpusSummary,
  signals,
  historyContext,
  requestedMode,
  explicitDecision,
  countContext
}) {
  const featureIds = (Array.isArray(features) ? features : []).map((feature) => toUpperId(feature?.id)).filter(Boolean);
  const featureStats = Array.isArray(corpusSummary?.featureStats) ? corpusSummary.featureStats : [];

  const saturatedFeatureIds = uniqueStrings(
    featureStats
      .filter((row) => Number(row?.hitRatio || 0) >= 0.65)
      .map((row) => toUpperId(row?.featureId))
  );

  const gapFeatureIds = uniqueStrings(
    featureStats
      .filter((row) => Number(row?.missingRatio || 0) >= 0.55)
      .sort((a, b) => Number(b?.missingRatio || 0) - Number(a?.missingRatio || 0))
      .map((row) => toUpperId(row?.featureId))
  );

  const noisyByFeature = normalizeNoisyTermsByFeatureMap(
    explicitDecision?.noisyTermsByFeature || explicitDecision?.noisy_terms_by_feature,
    featureIds
  );
  const derivedNoisy = deriveDefaultNoisyTermsByFeature(signals, featureIds);

  const mergedNoisy = {};
  const noiseKeys = uniqueStrings([
    ...Object.keys(derivedNoisy),
    ...Object.keys(noisyByFeature)
  ]);
  noiseKeys.forEach((key) => {
    mergedNoisy[key] = uniqueStrings([...(derivedNoisy[key] || []), ...(noisyByFeature[key] || [])]).slice(0, 10);
  });

  const normalizedCount = normalizeCountContext({
    countContext,
    iterations: [],
    summary
  });

  return {
    decision: String(
      explicitDecision?.decision
      || inferCorpusDecisionLabel({ summary, corpusSummary, requestedMode })
    ).trim(),
    saturatedFeatureIds: uniqueStrings([
      ...(explicitDecision?.saturatedFeatureIds || explicitDecision?.saturated_feature_ids || []),
      ...saturatedFeatureIds
    ]).map(toUpperId).filter((id) => !featureIds.length || featureIds.includes(id)),
    gapFeatureIds: uniqueStrings([
      ...(explicitDecision?.gapFeatureIds || explicitDecision?.gap_feature_ids || []),
      ...gapFeatureIds
    ]).map(toUpperId).filter((id) => !featureIds.length || featureIds.includes(id)),
    noisyTermsByFeature: mergedNoisy,
    bestDocIds: uniqueStrings(explicitDecision?.bestDocIds || explicitDecision?.best_doc_ids || []),
    bestPairCandidates: Array.isArray(explicitDecision?.bestPairCandidates || explicitDecision?.best_pair_candidates)
      ? (explicitDecision.bestPairCandidates || explicitDecision.best_pair_candidates)
      : [],
    keepDirectionQueryVersionIds: uniqueStrings([
      ...(explicitDecision?.keepDirectionQueryVersionIds || explicitDecision?.keep_direction_query_version_ids || []),
      ...(historyContext?.goodQualityQueryVersionIds || []),
      ...(historyContext?.preferredQueryVersionIds || [])
    ]),
    avoidQueryVersionIds: uniqueStrings([
      ...(explicitDecision?.avoidQueryVersionIds || explicitDecision?.avoid_query_version_ids || []),
      ...(historyContext?.lowQualityQueryVersionIds || [])
    ]),
    targetCountRange: normalizedCount.targetCountRange,
    softTargetRange: normalizedCount.softTargetRange,
    currentResultCount: normalizedCount.currentResultCount,
    previousResultCount: normalizedCount.previousResultCount,
    countSource: normalizedCount.countSource,
    countBucket: normalizedCount.countBucket,
    countDistanceScore: normalizedCount.countDistanceScore,
    reductionRatio: normalizedCount.reductionRatio,
    repeatReasonSignature: normalizedCount.repeatReasonSignature,
    repeatReasonCount: normalizedCount.repeatReasonCount
  };
}

function ensurePlannerStateDefaults(state, feature) {
  const featureId = toUpperId(feature?.id);
  if (!featureId) return state;
  const queryRole = normalizeQueryRole(feature?.query_role || feature?.queryRole, isMustFeature(feature) ? "must" : "should");
  const enabled = state?.enabled !== false;
  return {
    ...(state || {}),
    enabled,
    active: state?.active === false ? false : enabled,
    core: queryRole === "must",
    text: String(state?.text || feature?.text || ""),
    queryRole,
    type: normalizeFeatureType(state?.type || feature?.type, queryRole === "must" ? "anchor" : "optional"),
    weight: normalizeFeatureWeight(state?.weight ?? feature?.weight, queryRole === "must" ? 5 : 3),
    relationTo: uniqueStrings(state?.relationTo || feature?.relation_to || []),
    negative: state?.negative === true || feature?.negative === true,
    focus: state?.focus === true,
    simplified: state?.simplified === true,
    phrase_locked_terms: uniqueStrings(state?.phrase_locked_terms || state?.phraseLockedTerms || [])
  };
}

function plannerSortFeatureIds(featureIds, featureMap, preferOptional = false) {
  const list = Array.isArray(featureIds) ? featureIds : [];
  return [...list].sort((leftIdRaw, rightIdRaw) => {
    const leftId = toUpperId(leftIdRaw);
    const rightId = toUpperId(rightIdRaw);
    const left = featureMap.get(leftId);
    const right = featureMap.get(rightId);
    const leftMust = left ? isMustFeature(left) : false;
    const rightMust = right ? isMustFeature(right) : false;
    if (preferOptional) {
      if (leftMust !== rightMust) return leftMust ? 1 : -1;
    } else if (leftMust !== rightMust) {
      return leftMust ? -1 : 1;
    }
    const leftWeight = normalizeFeatureWeight(left?.weight, leftMust ? 5 : 3);
    const rightWeight = normalizeFeatureWeight(right?.weight, rightMust ? 5 : 3);
    if (rightWeight !== leftWeight) return rightWeight - leftWeight;
    return leftId.localeCompare(rightId);
  });
}

export function planQueryAdjustment(decision, corpusDecision, repeatCount, currentQueryPlan = {}) {
  const features = Array.isArray(currentQueryPlan?.features) ? currentQueryPlan.features : [];
  const featureMap = new Map(features.map((feature) => [toUpperId(feature?.id), feature]));
  const featureIds = features.map((feature) => toUpperId(feature?.id)).filter(Boolean);
  const seedByFeature = currentQueryPlan?.seedByFeature && typeof currentQueryPlan.seedByFeature === "object"
    ? currentQueryPlan.seedByFeature
    : {};

  const currentExpression = normalizeQueryExpressionText(
    currentQueryPlan?.currentExpression || currentQueryPlan?.expression || ""
  );
  const countBucketHint = String(corpusDecision?.countBucket || "unknown").trim().toLowerCase();
  const countRepeatHint = Math.max(
    1,
    Number.isFinite(Number(corpusDecision?.repeatReasonCount))
      ? Math.floor(Number(corpusDecision.repeatReasonCount))
      : 1
  );
  const countResultClass = classifyResultCount(corpusDecision?.currentResultCount);
  const modeHint = String(currentQueryPlan?.modeHint || currentQueryPlan?.mode || "").trim().toLowerCase();
  const manualMode = getDesiredModeFromManualDecision(decision);
  const rawCorpusDecision = String(corpusDecision?.decision || "").trim().toLowerCase();
  const repeatLevel = Math.max(
    1,
    Math.min(
      4,
      Math.max(
        Number.isFinite(Number(repeatCount)) ? Number(repeatCount) : 1,
        countRepeatHint
      )
    )
  );
  const refineHints = currentQueryPlan?.refineHints || {};
  const explicitFinalTermsByFeature = {};
  Object.entries(refineHints?.explicitFinalTermsByFeature || {}).forEach(([featureIdRaw, terms]) => {
    const featureId = toUpperId(featureIdRaw);
    if (!featureId) return;
    const normalized = uniqueStrings(normalizeAtomicTermList(terms || [], {
      allowLockedBigrams: false
    })).slice(0, 2);
    if (!normalized.length) return;
    explicitFinalTermsByFeature[featureId] = normalized;
  });

  let mode = manualMode;
  if (mode !== "narrow" && mode !== "widen") {
    if (modeHint === "narrow" || modeHint === "widen" || modeHint === "balanced") {
      mode = modeHint;
    } else if (rawCorpusDecision === "noise_cluster_dominant") {
      mode = "narrow";
    } else if (rawCorpusDecision === "gap_feature_missing_everywhere") {
      mode = "widen";
    } else {
      mode = "balanced";
    }
  }
  if (countResultClass.isTooMany) {
    mode = "narrow";
  } else if (countResultClass.isTooFew || countResultClass.isEmpty) {
    mode = "widen";
  } else if (countResultClass.isProceed && mode !== "narrow" && mode !== "widen") {
    mode = "balanced";
  }

  const repeatReasonSignature = String(
    corpusDecision?.repeatReasonSignature
    || currentQueryPlan?.repeatReasonSignature
    || ""
  ).trim();
  const recentEscalationFamilies = Array.isArray(currentQueryPlan?.recentEscalationFamilies)
    ? currentQueryPlan.recentEscalationFamilies
    : [];
  const lastEscalationFamily = String(
    recentEscalationFamilies[recentEscalationFamilies.length - 1]
    || currentQueryPlan?.plannerMeta?.escalationFamily
    || ""
  ).trim();
  let escalationFamily = deriveEscalationFamily({
    mode,
    countBucket: countBucketHint || countResultClass.bucket || "unknown",
    repeatReasonCount: repeatLevel,
    repeatReasonSignature
  });
  if (repeatLevel >= 2 && escalationFamily && escalationFamily === lastEscalationFamily) {
    if (escalationFamily === "standard_narrow") escalationFamily = "split_feature_narrow";
    else if (escalationFamily === "split_feature_narrow") escalationFamily = "anti_noise_narrow";
    else if (escalationFamily === "anti_noise_narrow") escalationFamily = "anti_cluster_rebuild";
    else if (escalationFamily === "standard_widen") escalationFamily = "anchor_rebuild_widen";
  }
  const groupBudget = computeGroupBudget({
    mode: escalationFamily === "anti_cluster_rebuild" ? "rebuild" : mode,
    countBucket: countBucketHint || countResultClass.bucket || "unknown",
    repeatReasonCount: repeatLevel
  });

  const nextTerms = JSON.parse(JSON.stringify(currentQueryPlan?.termsByFeature || {}));
  const nextState = JSON.parse(JSON.stringify(currentQueryPlan?.featureStateById || {}));
  const feedbackActions = [];
  const featureActions = Array.isArray(currentQueryPlan?.featureActions) ? currentQueryPlan.featureActions : [];
  const signals = currentQueryPlan?.signals || {};
  const changedFeatureIds = new Set();
  const dephrasedTerms = new Set();
  let droppedFeatureId = "";
  let promotedFeatureId = "";
  let focusFeatureId = "";
  let simplificationApplied = false;
  const broadenAppliedFeatureIds = new Set();
  const balancedSupportFeatureIds = new Set();
  const splitFeaturePlanMap = new Map();

  const normalizedNoisyMap = normalizeNoisyTermsByFeatureMap(corpusDecision?.noisyTermsByFeature, featureIds);
  const derivedNoise = deriveDefaultNoisyTermsByFeature(signals, featureIds);
  const refineAntiNoise = uniqueStrings(normalizeAtomicTermList(refineHints?.antiNoiseTerms || [], {
    allowLockedBigrams: false
  }));
  const noisyByFeature = {};
  const noisyKeys = uniqueStrings([...Object.keys(derivedNoise), ...Object.keys(normalizedNoisyMap)]);
  noisyKeys.forEach((key) => {
    noisyByFeature[key] = uniqueStrings([...(derivedNoise[key] || []), ...(normalizedNoisyMap[key] || [])]).slice(0, 12);
  });
  if (refineAntiNoise.length > 0) {
    noisyByFeature.__UNSCOPED__ = uniqueStrings([
      ...(noisyByFeature.__UNSCOPED__ || []),
      ...refineAntiNoise
    ]).slice(0, 18);
  }

  const saturatedSet = new Set(uniqueStrings(corpusDecision?.saturatedFeatureIds || []).map(toUpperId));
  const gapSet = new Set(uniqueStrings(corpusDecision?.gapFeatureIds || []).map(toUpperId));

  const getSeedBuckets = (featureId) => {
    const raw = seedByFeature?.[featureId] || {};
    const locked = uniqueStrings(normalizeAtomicTermList(
      raw.locked_bigrams || raw.lockedBigrams || raw.exact_phrase_terms || raw.exactPhraseTerms || [],
      {
        allowLockedBigrams: true,
        lockedBigrams: raw.locked_bigrams || raw.lockedBigrams || raw.exact_phrase_terms || raw.exactPhraseTerms || []
      }
    ).filter((term) => term.includes(" ")));
    const base = uniqueStrings(normalizeAtomicTermList(raw.base_terms || raw.baseTerms || raw.must_terms || raw.mustTerms || [], {
      allowLockedBigrams: false
    })).slice(0, 3);
    const support = uniqueStrings(normalizeAtomicTermList(raw.support_terms || raw.supportTerms || raw.should_terms || raw.shouldTerms || [], {
      allowLockedBigrams: false
    })).slice(0, 3);
    const broad = uniqueStrings(normalizeAtomicTermList(raw.broad_terms || raw.broadTerms || [], {
      allowLockedBigrams: false
    })).slice(0, 3);
    const narrow = uniqueStrings(normalizeAtomicTermList(raw.narrow_terms || raw.narrowTerms || [], {
      allowLockedBigrams: false
    })).slice(0, 3);
    const avoid = uniqueStrings(normalizeAtomicTermList(raw.avoid_terms || raw.avoidTerms || [], {
      allowLockedBigrams: false
    })).slice(0, 6);
    const entity = uniqueStrings(normalizeAtomicTermList(raw.entity_terms || raw.entityTerms || [], {
      allowLockedBigrams: false
    })).slice(0, 3);
    const action = uniqueStrings(normalizeAtomicTermList(raw.action_terms || raw.actionTerms || [], {
      allowLockedBigrams: false
    })).slice(0, 3);
    const qualifier = uniqueStrings(normalizeAtomicTermList(raw.qualifier_terms || raw.qualifierTerms || [], {
      allowLockedBigrams: false
    })).slice(0, 3);
    const noiseProne = uniqueStrings(normalizeAtomicTermList(raw.noise_prone_terms || raw.noiseProneTerms || [], {
      allowLockedBigrams: false
    })).slice(0, 6);
    return {
      base_terms: base,
      support_terms: support,
      broad_terms: broad,
      narrow_terms: narrow,
      avoid_terms: avoid,
      locked_bigrams: locked,
      entity_terms: entity,
      action_terms: action,
      qualifier_terms: qualifier,
      noise_prone_terms: noiseProne
    };
  };

  const getPhraseLockedSet = (featureId) => {
    const stateLocked = uniqueStrings(nextState?.[featureId]?.phrase_locked_terms || []);
    const seedLocked = uniqueStrings(getSeedBuckets(featureId).locked_bigrams || []);
    return new Set(uniqueStrings([...stateLocked, ...seedLocked]).map((term) => term.toLowerCase()));
  };

  const getTermWordCount = (term) => {
    return String(term || "")
      .trim()
      .split(/\s+/)
      .map((word) => word.trim())
      .filter(Boolean).length;
  };

  const markChanged = (featureId, reason) => {
    changedFeatureIds.add(featureId);
    if (reason) feedbackActions.push(`[${featureId}] ${reason}`);
  };

  features.forEach((feature) => {
    const featureId = toUpperId(feature?.id);
    if (!featureId) return;
    nextState[featureId] = ensurePlannerStateDefaults(nextState[featureId], feature);
    if (typeof nextState[featureId].active !== "boolean") {
      nextState[featureId].active = nextState[featureId].enabled !== false && nextState[featureId].core === true;
    }
    if (!Array.isArray(nextState[featureId].phrase_locked_terms)) {
      nextState[featureId].phrase_locked_terms = [];
    }
    nextTerms[featureId] = normalizeAtomicTermList(nextTerms[featureId] || [], {
      allowLockedBigrams: false
    }).slice(0, 2);
  });

  applyFeatureActions({
    featureActions,
    nextTerms,
    nextState,
    feedbackActions,
    budgetLimit: MAX_AUTO_ACTIONS + Math.max(0, repeatLevel - 1)
  });

  const lexicalAfterActions = enforceAtomicTermsByFeature(nextTerms, {}, {
    allowLockedBigrams: false
  });
  if (Array.isArray(lexicalAfterActions.violations) && lexicalAfterActions.violations.length > 0) {
    feedbackActions.push(`lexical: ${summarizeLexicalViolations(lexicalAfterActions.violations)}`);
  }
  Object.assign(nextTerms, lexicalAfterActions.termsByFeature);

  const getActiveFeatureIds = () => featureIds.filter((featureId) => {
    const state = nextState[featureId] || {};
    return state.enabled !== false && state.active !== false;
  });

  const deactivateFeature = (featureId, reason) => {
    if (!featureId) return false;
    if (nextState[featureId]?.active === false) return false;
    nextState[featureId] = {
      ...(nextState[featureId] || {}),
      active: false,
      focus: false
    };
    if (!droppedFeatureId) droppedFeatureId = featureId;
    markChanged(featureId, reason || "group dropped");
    return true;
  };

  const activateFeature = (featureId, { required = false, focus = false, reason = "" } = {}) => {
    if (!featureId) return false;
    const prev = nextState[featureId] || {};
    const changed = prev.active === false || prev.enabled === false || (focus && prev.focus !== true);
    nextState[featureId] = {
      ...prev,
      enabled: true,
      active: true,
      core: required ? true : !!prev.core,
      focus: focus ? true : false
    };
    if (focus) {
      focusFeatureId = featureId;
    }
    if (required && !promotedFeatureId) {
      promotedFeatureId = featureId;
    }
    if (changed) {
      markChanged(featureId, reason || "feature promoted to active");
    }
    return changed;
  };

  uniqueStrings(refineHints?.dropFeatureIds || [])
    .map((id) => toUpperId(id))
    .forEach((featureId) => {
      if (!featureId) return;
      deactivateFeature(featureId, "planner_hint: drop feature");
    });

  const dephraseFeature = (featureId) => {
    const lockedSet = getPhraseLockedSet(featureId);
    const before = uniqueStrings(nextTerms[featureId] || []);
    const after = dephraseTermList(before, Array.from(lockedSet));
    if (!after.length) return false;
    const changed = normalizeQueryExpressionText(before.join(" | ")) !== normalizeQueryExpressionText(after.join(" | "));
    if (!changed) return false;
    before.forEach((term) => {
      const key = String(term || "").toLowerCase();
      if (lockedSet.has(key)) return;
      if (getTermWordCount(term) >= 2) {
        dephrasedTerms.add(term);
      }
    });
    nextTerms[featureId] = uniqueStrings(after).slice(0, 2);
    nextState[featureId] = {
      ...(nextState[featureId] || {}),
      simplified: true
    };
    simplificationApplied = true;
    markChanged(featureId, "simplify: dephrase terms");
    return true;
  };

  const denarrowFeature = (featureId) => {
    const buckets = getSeedBuckets(featureId);
    const narrowSet = new Set(uniqueStrings(buckets.narrow_terms || []).map((term) => term.toLowerCase()));
    const lockedSet = getPhraseLockedSet(featureId);
    const before = uniqueStrings(nextTerms[featureId] || []);
    const after = before.filter((term) => {
      const key = term.toLowerCase();
      if (narrowSet.has(key)) return false;
      if (lockedSet.has(key)) return false;
      if (getTermWordCount(term) >= 4 || String(term || "").length >= 30) return false;
      return true;
    });
    if (!after.length) return false;
    if (after.length === before.length) return false;
    nextTerms[featureId] = uniqueStrings(after).slice(0, 2);
    nextState[featureId] = {
      ...(nextState[featureId] || {}),
      simplified: true
    };
    simplificationApplied = true;
    markChanged(featureId, "simplify: remove narrow/exact/over-specific terms");
    return true;
  };

  const trimNoisyFeature = (featureId, limit = 2) => {
    const noisy = uniqueStrings([
      ...(noisyByFeature[featureId] || []),
      ...(noisyByFeature.__UNSCOPED__ || []),
      ...(getSeedBuckets(featureId).avoid_terms || [])
    ]);
    if (!noisy.length) return false;
    let removed = 0;
    const before = uniqueStrings(nextTerms[featureId] || []);
    const after = before.filter((term) => {
      if (removed >= limit) return true;
      const matched = noisy.some((candidate) => candidate.toLowerCase() === term.toLowerCase());
      if (matched && before.length - removed > 1) {
        removed += 1;
        return false;
      }
      return true;
    });
    if (after.length === before.length) return false;
    nextTerms[featureId] = uniqueStrings(after).slice(0, 2);
    markChanged(featureId, "trim noisy terms");
    return true;
  };

  const rebuildWithBaseOnly = ({ includeGap = false } = {}) => {
    const initialIds = selectInitialActiveFeatureIds(features, { minActive: 2, maxActive: 3 });
    const activeSet = new Set(initialIds.map((id) => toUpperId(id)));
    const gapCandidates = plannerSortFeatureIds(uniqueStrings([...gapSet]), featureMap, false).slice(0, 1);
    if (includeGap && gapCandidates[0]) {
      activeSet.add(gapCandidates[0]);
    }

    featureIds.forEach((featureId) => {
      const shouldActive = activeSet.has(featureId) && nextState[featureId]?.enabled !== false;
      nextState[featureId] = {
        ...(nextState[featureId] || {}),
        active: shouldActive,
        focus: false,
        simplified: true
      };
      if (shouldActive) {
        const meta = featureMap.get(featureId);
        const includeBroad = includeGap && gapCandidates.includes(featureId);
        if (includeBroad) {
          broadenAppliedFeatureIds.add(featureId);
        }
        const selected = selectTermsForMode({
          id: featureId,
          text: meta?.text || featureId,
          type: nextState[featureId]?.type,
          queryRole: nextState[featureId]?.queryRole,
          weight: nextState[featureId]?.weight
        }, getSeedBuckets(featureId), "widen", {
          active: true,
          includeBroad,
          phraseLockedTerms: nextState[featureId]?.phrase_locked_terms || []
        });
        nextTerms[featureId] = uniqueStrings(selected.terms).slice(0, includeBroad ? 2 : 1);
      }
      changedFeatureIds.add(featureId);
    });
    simplificationApplied = true;
    feedbackActions.push("planner_guard: force rebuild with base-only active groups");
  };

  const selectFocusFeature = () => {
    const hinted = uniqueStrings(refineHints?.promoteFeatureIds || []).map((id) => toUpperId(id));
    for (const featureId of hinted) {
      if (!featureMap.has(featureId)) continue;
      if (nextState[featureId]?.enabled === false) continue;
      return featureId;
    }

    const candidates = featureIds.filter((featureId) => {
      const state = nextState[featureId] || {};
      if (state.enabled === false) return false;
      const type = String(state.type || "").toLowerCase();
      const mustLike = state.core === true || state.queryRole === "must" || type === "anchor" || type === "discriminator";
      if (!mustLike) return false;
      return !(state.active !== false && state.core === true);
    });

    const ordered = plannerSortFeatureIds(candidates, featureMap, false);
    return ordered[0] || "";
  };

  const addSplitPlan = (featureId, groups = [], reason = "") => {
    const normalizedFeatureId = toUpperId(featureId);
    if (!normalizedFeatureId || !Array.isArray(groups) || groups.length <= 0) return;
    const normalizedGroups = groups
      .map((group, index) => {
        const role = String(group?.group_role || group?.groupRole || "").trim().toLowerCase();
        const terms = uniqueStrings(normalizeAtomicTermList(group?.terms || [], { allowLockedBigrams: false })).slice(0, 2);
        if (!terms.length) return null;
        const modeMap = {
          micro_entity: "micro_entity",
          micro_action: "micro_action",
          micro_qualifier: "micro_qualifier",
          anchor: "anchor",
          support: "support",
          noise_cut: "noise_cut"
        };
        const normalizedRole = role && modeMap[role] ? role : (index === 0 ? "micro_entity" : "micro_action");
        const groupRole = normalizedRole === "micro_qualifier"
          ? "qualifier_and"
          : (normalizedRole === "support" ? "optional_or" : "must_and");
        return {
          group_role: normalizedRole,
          groupRole,
          terms
        };
      })
      .filter(Boolean);
    if (!normalizedGroups.length) return;
    splitFeaturePlanMap.set(normalizedFeatureId, {
      featureId: normalizedFeatureId,
      groups: normalizedGroups,
      reason: String(reason || "").trim()
    });
  };

  const createDefaultSplitPlanForFeature = (featureId, {
    includeQualifier = false
  } = {}) => {
    const buckets = getSeedBuckets(featureId);
    const entityTerms = uniqueStrings([
      ...(buckets.entity_terms || []),
      ...(buckets.base_terms || []),
      ...(buckets.support_terms || [])
    ]).slice(0, 2);
    const actionTerms = uniqueStrings([
      ...(buckets.action_terms || []),
      ...(buckets.support_terms || []),
      ...(buckets.narrow_terms || [])
    ]).slice(0, 2);
    const qualifierTerms = uniqueStrings([
      ...(buckets.qualifier_terms || []),
      ...(buckets.narrow_terms || [])
    ]).slice(0, 2);

    const groups = [];
    if (entityTerms.length) groups.push({ group_role: "micro_entity", terms: entityTerms });
    if (actionTerms.length) groups.push({ group_role: "micro_action", terms: actionTerms });
    if (includeQualifier && qualifierTerms.length) {
      groups.push({ group_role: "micro_qualifier", terms: qualifierTerms });
    }
    return groups;
  };

  (Array.isArray(refineHints?.splitFeaturePlans) ? refineHints.splitFeaturePlans : [])
    .forEach((entry) => {
      const featureId = toUpperId(entry?.featureId || entry?.feature_id);
      addSplitPlan(featureId, entry?.groups || [], "llm split_feature_plans");
    });

  if (mode === "widen") {
    if (escalationFamily === "anchor_rebuild_widen") {
      rebuildWithBaseOnly({ includeGap: false });
    }
    getActiveFeatureIds().forEach((featureId) => {
      dephraseFeature(featureId);
      denarrowFeature(featureId);
    });

    const broadenTargets = plannerSortFeatureIds(uniqueStrings([...gapSet]), featureMap, false).slice(0, 1);
    const activeNow = getActiveFeatureIds();
    if (activeNow.length >= 3) {
      let weak = plannerSortFeatureIds(activeNow, featureMap, true).find((featureId) => {
        const state = nextState[featureId] || {};
        return !state.core && state.queryRole !== "must" && !broadenTargets.includes(featureId);
      });
      if (!weak) {
        weak = plannerSortFeatureIds(activeNow, featureMap, true).find((featureId) => {
          const state = nextState[featureId] || {};
          return !state.core && state.queryRole !== "must";
        });
      }
      if (weak) {
        deactivateFeature(weak, "widen: drop one weak group");
      }
    }
    broadenTargets.forEach((featureId) => {
      activateFeature(featureId, { required: false, focus: false, reason: "widen: selected gap group active" });
      broadenAppliedFeatureIds.add(featureId);
      const selected = selectTermsForMode({
        id: featureId,
        text: featureMap.get(featureId)?.text || featureId,
        type: nextState[featureId]?.type,
        queryRole: nextState[featureId]?.queryRole,
        weight: nextState[featureId]?.weight
      }, getSeedBuckets(featureId), "widen", {
        active: true,
        includeBroad: true,
        phraseLockedTerms: nextState[featureId]?.phrase_locked_terms || []
      });
      if (selected.terms.length > 0) {
        nextTerms[featureId] = uniqueStrings(selected.terms).slice(0, 2);
        markChanged(featureId, "widen: broaden selected gap");
      }
    });
  } else if (mode === "narrow") {
    const focus = selectFocusFeature();
    if (focus) {
      activateFeature(focus, {
        required: true,
        focus: true,
        reason: "narrow: promote focus feature as required AND group"
      });
      focusFeatureId = focus;
    }

    if (focusFeatureId && escalationFamily === "split_feature_narrow" && !splitFeaturePlanMap.has(focusFeatureId)) {
      const splitGroups = createDefaultSplitPlanForFeature(focusFeatureId, { includeQualifier: false });
      if (splitGroups.length >= 2) {
        addSplitPlan(focusFeatureId, splitGroups, "narrow escalation: split feature into micro groups");
        feedbackActions.push(`[${focusFeatureId}] split feature for discriminative AND control`);
      }
    }

    if (focusFeatureId && escalationFamily === "anti_noise_narrow") {
      const splitGroups = createDefaultSplitPlanForFeature(focusFeatureId, { includeQualifier: true });
      if (splitGroups.length >= 2) {
        addSplitPlan(focusFeatureId, splitGroups, "narrow escalation: add qualifier/noise-cut groups");
      }
    }

    if (escalationFamily === "anti_cluster_rebuild") {
      const anchorCandidates = plannerSortFeatureIds(
        featureIds.filter((featureId) => {
          const state = nextState[featureId] || {};
          return state.enabled !== false && (state.core === true || state.queryRole === "must");
        }),
        featureMap,
        false
      ).slice(0, 2);
      const differentiator = plannerSortFeatureIds(
        featureIds.filter((featureId) => {
          const state = nextState[featureId] || {};
          return state.enabled !== false && state.type === "discriminator";
        }),
        featureMap,
        false
      )[0] || "";
      const relation = plannerSortFeatureIds(
        featureIds.filter((featureId) => {
          const state = nextState[featureId] || {};
          return state.enabled !== false && state.type === "relation";
        }),
        featureMap,
        false
      )[0] || "";
      const keepSet = new Set(uniqueStrings([...anchorCandidates, differentiator, relation]).filter(Boolean));
      featureIds.forEach((featureId) => {
        const keep = keepSet.has(featureId);
        nextState[featureId] = {
          ...(nextState[featureId] || {}),
          active: keep,
          enabled: nextState[featureId]?.enabled !== false,
          focus: keep && featureId === focusFeatureId
        };
      });
      keepSet.forEach((featureId) => {
        activateFeature(featureId, {
          required: featureId === anchorCandidates[0] || featureId === anchorCandidates[1],
          focus: featureId === focusFeatureId,
          reason: "anti-cluster rebuild: selective AND baseline"
        });
        const splitGroups = createDefaultSplitPlanForFeature(featureId, {
          includeQualifier: featureId === relation
        });
        if (splitGroups.length >= 2) {
          addSplitPlan(featureId, splitGroups, "anti-cluster rebuild split");
        }
      });
      feedbackActions.push("anti-cluster rebuild: anchor2 + differentiator + relation");
    }

    const trimTargets = plannerSortFeatureIds(uniqueStrings([...saturatedSet]), featureMap, true);
    trimTargets.forEach((featureId) => {
      if (featureId === focusFeatureId) return;
      trimNoisyFeature(featureId, 2);
    });

    if (focusFeatureId) {
      const selected = selectTermsForMode({
        id: focusFeatureId,
        text: featureMap.get(focusFeatureId)?.text || focusFeatureId,
        type: nextState[focusFeatureId]?.type,
        queryRole: nextState[focusFeatureId]?.queryRole,
        weight: nextState[focusFeatureId]?.weight
      }, getSeedBuckets(focusFeatureId), "narrow", {
        active: true,
        isFocusFeature: true,
        phraseLockedTerms: nextState[focusFeatureId]?.phrase_locked_terms || [],
        allowLockedBigrams: true
      });
      if (selected.terms.length > 0) {
        nextTerms[focusFeatureId] = uniqueStrings(selected.terms).slice(0, 2);
        markChanged(focusFeatureId, "narrow: focus feature terms tightened");
      }
    }

    const activeNow = getActiveFeatureIds();
    if (activeNow.length > 4) {
      const ordered = plannerSortFeatureIds(activeNow, featureMap, true);
      ordered.forEach((featureId) => {
        if (getActiveFeatureIds().length <= 4) return;
        if (featureId === focusFeatureId) return;
        const state = nextState[featureId] || {};
        if (state.core === true || state.queryRole === "must") return;
        deactivateFeature(featureId, "narrow: cap active groups");
      });
    }
  } else {
    const supportCandidates = pickBalancedSupportFeatureIds({
      features,
      featureStateById: nextState,
      preferredIds: plannerSortFeatureIds(uniqueStrings([...saturatedSet]), featureMap, false),
      limit: 2
    });
    supportCandidates.forEach((featureId) => {
      balancedSupportFeatureIds.add(featureId);
      const selected = selectTermsForMode({
        id: featureId,
        text: featureMap.get(featureId)?.text || featureId,
        type: nextState[featureId]?.type,
        queryRole: nextState[featureId]?.queryRole,
        weight: nextState[featureId]?.weight
      }, getSeedBuckets(featureId), "balanced", {
        active: nextState[featureId]?.enabled !== false && nextState[featureId]?.active !== false,
        includeSupport: true,
        isBalancedSupportFeature: true,
        phraseLockedTerms: nextState[featureId]?.phrase_locked_terms || []
      });
      if (selected.terms.length > 0) {
        nextTerms[featureId] = uniqueStrings(selected.terms).slice(0, 2);
        markChanged(featureId, "balanced: add support synonym");
      }
    });
    const satCandidate = plannerSortFeatureIds(uniqueStrings([...saturatedSet]), featureMap, true)[0];
    if (satCandidate) {
      trimNoisyFeature(satCandidate, 1);
    }
  }

  Object.entries(explicitFinalTermsByFeature).forEach(([featureId, terms]) => {
    if (!featureId || !Array.isArray(terms) || !terms.length) return;
    const state = nextState[featureId] || {};
    if (state.enabled === false || state.active === false) return;
    const before = uniqueStrings(nextTerms[featureId] || []);
    const after = uniqueStrings(normalizeAtomicTermList(terms, {
      allowLockedBigrams: false
    })).slice(0, 2);
    if (!after.length) return;
    if (normalizeQueryExpressionText(before.join(" | ")) === normalizeQueryExpressionText(after.join(" | "))) return;
    nextTerms[featureId] = after;
    markChanged(featureId, "llm final terms priority applied");
  });

  const termPolicy = buildModeTermCapPolicy({
    mode,
    features,
    featureStateById: nextState,
    broadenFeatureIds: Array.from(broadenAppliedFeatureIds),
    focusFeatureId,
    balancedSupportFeatureIds: Array.from(balancedSupportFeatureIds)
  });
  Object.keys(nextTerms).forEach((featureIdRaw) => {
    const featureId = toUpperId(featureIdRaw);
    if (!featureId) return;
    const termLimit = resolveFeatureTermLimit(featureId, termPolicy);
    const normalized = normalizeAtomicTermList(nextTerms[featureId] || [], {
      allowLockedBigrams: false
    });
    nextTerms[featureId] = uniqueStrings(normalized).slice(0, termLimit);
  });

  const mustIds = features.filter((feature) => isMustFeature(feature)).map((feature) => toUpperId(feature?.id));
  const requiredMust = Math.min(2, mustIds.length);
  const enabledMust = mustIds.filter((featureId) => nextState[featureId]?.enabled !== false && nextState[featureId]?.active !== false);
  if (enabledMust.length < requiredMust) {
    mustIds.slice(0, requiredMust).forEach((featureId) => {
      activateFeature(featureId, { required: true, reason: "planner_guard: keep core anchors active" });
    });
  }

  const modeByFeatureId = {};
  const reasonByFeatureId = {};
  featureIds.forEach((featureId) => {
    const state = nextState[featureId] || {};
    if (splitFeaturePlanMap.has(featureId)) {
      reasonByFeatureId[featureId] = "Split retrieval groups (micro control)";
      return;
    }
    if (state.focus === true) {
      modeByFeatureId[featureId] = "anchor";
      reasonByFeatureId[featureId] = "Focus feature required group";
      return;
    }
    if (gapSet.has(featureId)) {
      modeByFeatureId[featureId] = "gap";
      reasonByFeatureId[featureId] = "Gap feature reinforcement";
      return;
    }
    if (mode === "narrow" && saturatedSet.has(featureId)) {
      modeByFeatureId[featureId] = "noise_cut";
      reasonByFeatureId[featureId] = "Saturated/noisy feature trimming";
      return;
    }
    modeByFeatureId[featureId] = "anchor";
    reasonByFeatureId[featureId] = "Anchor coverage";
  });

  const existingPlan = normalizeQueryPlan({
    queryPlan: currentQueryPlan?.queryPlan,
    features,
    termsByFeature: nextTerms,
    featureStateById: nextState,
    ...termPolicy,
    modeByFeatureId,
    reasonByFeatureId
  });
  const existingByFeature = new Map();
  const passthroughGroups = [];
  (Array.isArray(existingPlan?.groups) ? existingPlan.groups : []).forEach((group) => {
    const featureIdsFromGroup = Array.isArray(group?.feature_ids || group?.featureIds)
      ? (group.feature_ids || group.featureIds)
      : [];
    if (!featureIdsFromGroup.length) {
      passthroughGroups.push(group);
      return;
    }
    const featureId = toUpperId(featureIdsFromGroup[0]);
    if (!featureId || existingByFeature.has(featureId)) return;
    existingByFeature.set(featureId, group);
  });

  const rebuiltGroups = [];
  features.forEach((feature, index) => {
    const featureId = toUpperId(feature?.id || `F${index + 1}`);
    const state = nextState[featureId] || {};
    const prevGroup = existingByFeature.get(featureId) || {};
    const termLimit = resolveFeatureTermLimit(featureId, termPolicy);
    const splitPlan = splitFeaturePlanMap.get(featureId) || null;
    if (splitPlan && state.enabled !== false && state.active !== false) {
      const splitGroups = Array.isArray(splitPlan.groups) ? splitPlan.groups : [];
      splitGroups.forEach((splitGroup, splitIndex) => {
        const normalizedRole = String(splitGroup?.group_role || splitGroup?.groupRole || "").trim().toLowerCase();
        const groupMode = normalizedRole || "micro_entity";
        const groupRole = normalizedRole === "micro_qualifier"
          ? "qualifier_and"
          : (normalizedRole === "support" ? "optional_or" : "must_and");
        const splitTerms = uniqueStrings(normalizeAtomicTermList(splitGroup?.terms || [], {
          allowLockedBigrams: false
        })).slice(0, Math.max(1, Math.min(2, termLimit)));
        if (!splitTerms.length) return;
        rebuiltGroups.push({
          group_id: `${String(prevGroup.group_id || prevGroup.groupId || `G${index + 1}`)}_S${splitIndex + 1}`,
          feature_ids: [featureId],
          sourceFeatureIds: [featureId],
          groupRole: splitGroup?.groupRole || splitGroup?.group_role || groupRole,
          splitFromFeatureId: featureId,
          required: groupRole !== "optional_or",
          active: true,
          focus: state.focus === true && splitIndex === 0,
          simplified: state.simplified === true,
          terms: splitTerms,
          phrase_locked_terms: uniqueStrings(state.phrase_locked_terms || []),
          reason: String(splitPlan?.reason || prevGroup.reason || reasonByFeatureId[featureId] || `${featureId} split planner group`),
          mode: groupMode
        });
      });
      return;
    }
    const terms = uniqueStrings(nextTerms[featureId] || []).slice(0, termLimit);
    if (!terms.length) return;
    rebuiltGroups.push({
      group_id: String(prevGroup.group_id || prevGroup.groupId || `G${index + 1}`),
      feature_ids: [featureId],
      sourceFeatureIds: [featureId],
      groupRole: state.core === true || state.queryRole === "must" ? "must_and" : "optional_or",
      splitFromFeatureId: "",
      required: state.core === true && state.active !== false,
      active: state.enabled !== false && state.active !== false,
      focus: state.focus === true,
      simplified: state.simplified === true,
      terms,
      phrase_locked_terms: uniqueStrings(state.phrase_locked_terms || []),
      reason: String(prevGroup.reason || reasonByFeatureId[featureId] || `${featureId} planner group`),
      mode: modeByFeatureId[featureId] || prevGroup.mode || "anchor"
    });
  });

  let normalizedTerms = ensureTermsByFeature(nextTerms, features);
  normalizedTerms = applyModeTermCapToFeatureTerms({
    features,
    termsByFeature: normalizedTerms,
    policy: termPolicy
  });
  let materialized = dedupeAndMaterializeQuery({
    queryPlan: { groups: [...rebuiltGroups, ...passthroughGroups] },
    features,
    termsByFeature: normalizedTerms,
    featureStateById: nextState,
    ...termPolicy,
    maxActiveGroups: groupBudget,
    modeByFeatureId,
    reasonByFeatureId
  });
  let finalPlan = materialized.queryPlan;
  let expression = materialized.expression;
  let crossGroupDedupeMeta = materialized.crossGroupDedupeMeta || {};

  if (normalizeQueryExpressionText(expression) === currentExpression || refineHints?.rebuildRequired === true) {
    if (mode === "widen") {
      rebuildWithBaseOnly({ includeGap: true });
    } else if (mode === "narrow") {
      const altFocus = plannerSortFeatureIds(featureIds, featureMap, false).find((featureId) => {
        if (featureId === focusFeatureId) return false;
        const state = nextState[featureId] || {};
        return state.enabled !== false && state.active === false && state.queryRole !== "can_drop";
      });
      if (altFocus) {
        activateFeature(altFocus, {
          required: true,
          focus: true,
          reason: "planner_guard: add additional AND constraint"
        });
      } else {
        trimNoisyFeature(focusFeatureId || featureIds[0], 3);
      }
    } else {
      rebuildWithBaseOnly({ includeGap: false });
    }

    normalizedTerms = ensureTermsByFeature(nextTerms, features);
    normalizedTerms = applyModeTermCapToFeatureTerms({
      features,
      termsByFeature: normalizedTerms,
      policy: termPolicy
    });
    materialized = dedupeAndMaterializeQuery({
      queryPlan: { groups: [...rebuiltGroups, ...passthroughGroups] },
      features,
      termsByFeature: normalizedTerms,
      featureStateById: nextState,
      ...termPolicy,
      maxActiveGroups: groupBudget,
      modeByFeatureId,
      reasonByFeatureId
    });
    finalPlan = materialized.queryPlan;
    expression = materialized.expression;
    crossGroupDedupeMeta = materialized.crossGroupDedupeMeta || {};
  }

  const expressionChanged = normalizeQueryExpressionText(expression) !== currentExpression;
  const changedGroupIds = (Array.isArray(finalPlan?.groups) ? finalPlan.groups : [])
    .filter((group) => {
      const featureId = toUpperId((Array.isArray(group?.feature_ids || group?.featureIds) ? (group.feature_ids || group.featureIds)[0] : ""));
      return featureId && changedFeatureIds.has(featureId);
    })
    .map((group) => String(group.group_id || group.groupId || "").trim())
    .filter(Boolean);

  const activeGroupIds = (Array.isArray(finalPlan?.groups) ? finalPlan.groups : [])
    .filter((group) => group.active !== false)
    .map((group) => String(group.group_id || group.groupId || "").trim())
    .filter(Boolean);
  const inactiveGroupIds = (Array.isArray(finalPlan?.groups) ? finalPlan.groups : [])
    .filter((group) => group.active === false)
    .map((group) => String(group.group_id || group.groupId || "").trim())
    .filter(Boolean);

  return {
    mode,
    expression: String(expression || "").trim(),
    queryPlan: finalPlan,
    termsByFeature: normalizedTerms,
    featureStateById: nextState,
    feedbackActions: uniqueStrings(feedbackActions).slice(0, 50),
    plannerMeta: enrichPlannerMetaWithCrossGroupDedupe({
      decision: String(rawCorpusDecision || "").trim(),
      saturatedFeatureIds: uniqueStrings([...saturatedSet]),
      gapFeatureIds: uniqueStrings([...gapSet]),
      noisyTermsByFeature: noisyByFeature,
      changedGroupIds: uniqueStrings(changedGroupIds),
      promotedFeatureId: promotedFeatureId || focusFeatureId || "",
      droppedFeatureId: droppedFeatureId || "",
      dephrasedTerms: uniqueStrings(Array.from(dephrasedTerms)),
      simplificationApplied: simplificationApplied === true,
      focusFeatureId: focusFeatureId || "",
      broadenFeatureIds: uniqueStrings(Array.from(broadenAppliedFeatureIds)),
      balancedSupportFeatureIds: uniqueStrings(Array.from(balancedSupportFeatureIds)),
      activeGroupIds: uniqueStrings(activeGroupIds),
      inactiveGroupIds: uniqueStrings(inactiveGroupIds),
      groupBudget,
      escalationFamily,
      repeatReasonSignature,
      repeatReasonCount: repeatLevel,
      expressionChanged
    }, crossGroupDedupeMeta)
  };
}


function ensureTermsByFeature(termsByFeature, features) {
  const normalized = normalizeTermsByFeature(termsByFeature || {}, features);
  const lexical = enforceAtomicTermsByFeature(normalized, {}, {
    allowLockedBigrams: false
  });
  (Array.isArray(features) ? features : []).forEach((feature) => {
    if (!Array.isArray(lexical.termsByFeature[feature.id]) || lexical.termsByFeature[feature.id].length === 0) {
      const fallbackAtoms = normalizeAtomicTermList([
        String(feature?.search_hint || feature?.searchHint || feature?.text || feature?.id || "").trim()
      ], { allowLockedBigrams: false });
      lexical.termsByFeature[feature.id] = fallbackAtoms.length > 0
        ? [fallbackAtoms[0]]
        : [String(feature?.id || "feature")];
    }
  });
  return lexical.termsByFeature;
}

function applyFeatureActions({
  featureActions,
  nextTerms,
  nextState,
  feedbackActions,
  budgetLimit = MAX_AUTO_ACTIONS
}) {
  let budget = Math.max(1, Number.isFinite(Number(budgetLimit)) ? Number(budgetLimit) : MAX_AUTO_ACTIONS);

  for (const action of Array.isArray(featureActions) ? featureActions : []) {
    if (budget <= 0) break;
    const featureId = toUpperId(action?.featureId);
    if (!featureId) continue;

     const replaceTerms = normalizeAtomicTermList(action?.replaceTerms || [], {
      allowLockedBigrams: false
    });
    const addTerms = normalizeAtomicTermList(action?.addTerms || [], {
      allowLockedBigrams: false
    });
    const removeTerms = normalizeAtomicTermList(action?.removeTerms || [], {
      allowLockedBigrams: false
    });

    if (action.enableFeature) {
      nextState[featureId] = {
        ...(nextState[featureId] || {}),
        enabled: true,
        active: true
      };
      feedbackActions.push(`[${featureId}] enabled`);
      budget -= 1;
    } else if (action.disableFeature) {
      nextState[featureId] = {
        ...(nextState[featureId] || {}),
        enabled: false,
        active: false
      };
      feedbackActions.push(`[${featureId}] disabled`);
      budget -= 1;
    }

    if (replaceTerms.length > 0 && budget > 0) {
      nextTerms[featureId] = uniqueStrings(replaceTerms).slice(0, 2);
      feedbackActions.push(`[${featureId}] replace terms`);
      budget -= 1;
    }

    for (const term of uniqueStrings(addTerms)) {
      if (budget <= 0) break;
      const prev = uniqueStrings(nextTerms[featureId] || []);
      const merged = uniqueStrings(normalizeAtomicTermList([...prev, term], { allowLockedBigrams: false })).slice(0, 2);
      if (merged.length === prev.length) continue;
      nextTerms[featureId] = merged;
      feedbackActions.push(`[${featureId}] add '${term}'`);
      budget -= 1;
    }

    for (const term of uniqueStrings(removeTerms)) {
      if (budget <= 0) break;
      const prev = uniqueStrings(nextTerms[featureId] || []);
      const filtered = prev.filter((entry) => entry.toLowerCase() !== term.toLowerCase());
      if (filtered.length === prev.length) continue;
      if (filtered.length === 0) continue;
      nextTerms[featureId] = filtered;
      feedbackActions.push(`[${featureId}] remove '${term}'`);
      budget -= 1;
    }

    if (action.promoteToRequired && budget > 0) {
      nextState[featureId] = {
        ...(nextState[featureId] || {}),
        enabled: true,
        active: true,
        core: true,
        focus: true
      };
      feedbackActions.push(`[${featureId}] promoted to required`);
      budget -= 1;
    }

    if (action.simplifyFirst === true && budget > 0) {
      const simplified = normalizeAtomicTermList(nextTerms[featureId] || [], {
        allowLockedBigrams: false
      }).slice(0, 1);
      if (simplified.length > 0) {
        nextTerms[featureId] = simplified;
        nextState[featureId] = {
          ...(nextState[featureId] || {}),
          simplified: true
        };
        feedbackActions.push(`[${featureId}] simplify-first applied`);
        budget -= 1;
      }
    }
  }
}

function summarizeFeatureJudgments(evaluation) {
  const counts = {
    exact: 0,
    equivalent: 0,
    partial: 0,
    absent: 0,
    conflict: 0
  };
  const highlights = [];
  const judgments = Array.isArray(evaluation?.featureJudgments) ? evaluation.featureJudgments : [];
  judgments.forEach((entry) => {
    const featureId = toUpperId(entry?.featureId || entry?.feature_id);
    const status = String(entry?.status || "").trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(counts, status)) {
      counts[status] += 1;
    }
    if (featureId && highlights.length < 5 && (status === "exact" || status === "equivalent" || status === "partial")) {
      highlights.push(`${featureId}:${status}`);
    }
  });

  return {
    counts,
    highlights,
    text: `exact ${counts.exact}, equivalent ${counts.equivalent}, partial ${counts.partial}, conflict ${counts.conflict}, absent ${counts.absent}`
  };
}

function buildPairRationaleText(candidate) {
  const parts = [
    `complementarity ${Math.round((Number(candidate?.complementarity) || 0) * 100)}%`,
    `field proximity ${Math.round((Number(candidate?.fieldProximity) || 0) * 100)}%`,
    `combine plausibility ${Math.round((Number(candidate?.combinePlausibility) || 0) * 100)}%`
  ];
  const conflictFlags = Array.isArray(candidate?.conflictFlags) ? candidate.conflictFlags : [];
  parts.push(conflictFlags.length ? `conflicts ${conflictFlags.slice(0, 3).join(", ")}` : "conflicts none");
  const gaps = Array.isArray(candidate?.remainingGaps) ? candidate.remainingGaps : [];
  parts.push(gaps.length ? `remaining gaps ${gaps.join(", ")}` : "remaining gaps none");
  return parts.join(" | ");
}

function buildSummary(evaluations, features, featureStateById) {
  const enabledFeatureIds = (Array.isArray(features) ? features : [])
    .map((feature) => feature.id)
    .filter((id) => featureStateById?.[id]?.enabled !== false);

  const sorted = (Array.isArray(evaluations) ? evaluations : [])
    .filter((row) => typeof row.score === "number")
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  const top = sorted[0] || null;
  const coveredSet = new Set();
  sorted
    .filter((row) => (row.score ?? 0) >= EVAL_SCORE_SUPPORT)
    .forEach((row) => {
      (row.featureHits || []).forEach((featureId) => {
        if (enabledFeatureIds.includes(toUpperId(featureId))) {
          coveredSet.add(toUpperId(featureId));
        }
      });
    });

  const coverage = enabledFeatureIds.length > 0
    ? coveredSet.size / enabledFeatureIds.length
    : 0;

  const singleHit = !!sorted.find((row) => {
    if ((row.score ?? 0) < EVAL_SCORE_HIGH) return false;
    const c = coveragesForEvaluation(row, enabledFeatureIds);
    return c.covered === enabledFeatureIds.length;
  });

  const pairCandidates = buildPairCandidates(sorted, enabledFeatureIds);
  const pairWinner = pairCandidates.find((candidate) => candidate.pairPlausible) || null;
  const pairHit = !!pairWinner;

  return {
    resultCount: evaluations.length,
    topScore: top?.score ?? null,
    coverage,
    coveredFeatureCount: coveredSet.size,
    enabledFeatureCount: enabledFeatureIds.length,
    singleHit,
    pairHit,
    topDocs: sorted.slice(0, 5).map((row) => {
      const judgment = summarizeFeatureJudgments(row);
      return {
        applicationNo: row.applicationNo,
        score: row.score,
        featureHits: row.featureHits || [],
        reason: row.reason || "",
        featureJudgmentSummary: judgment.text,
        featureJudgmentHighlights: judgment.highlights
      };
    }),
    pairCandidates: pairCandidates.slice(0, 5).map((candidate) => ({
      leftApplicationNo: candidate.left.applicationNo,
      rightApplicationNo: candidate.right.applicationNo,
      coverage: candidate.coverageRatio,
      minScore: candidate.minScore,
      complementarity: candidate.complementarity,
      fieldProximity: candidate.fieldProximity,
      combinePlausibility: candidate.combinePlausibility,
      conflictFlags: candidate.conflictFlags,
      hardConflictCount: candidate.hardConflictCount,
      lowConflict: candidate.lowConflict,
      remainingGaps: candidate.remainingGaps,
      pairPlausible: candidate.pairPlausible,
      field_proximity: candidate.fieldProximity,
      combine_plausibility: candidate.combinePlausibility,
      conflict_flags: candidate.conflictFlags,
      remaining_gaps: candidate.remainingGaps,
      pairRationale: buildPairRationaleText(candidate)
    })),
    pairDecision: pairWinner
      ? {
        leftApplicationNo: pairWinner.left?.applicationNo || "",
        rightApplicationNo: pairWinner.right?.applicationNo || "",
        combinePlausibility: pairWinner.combinePlausibility,
        lowConflict: pairWinner.lowConflict,
        remainingGaps: pairWinner.remainingGaps,
        combine_plausibility: pairWinner.combinePlausibility,
        remaining_gaps: pairWinner.remainingGaps
      }
      : null
  };
}

async function requestStructuredJson(promptKey, variables, {
  modelName,
  temperature = null,
  reasoningEffort = "",
  maxOutputTokens = null,
  onLog,
  settings = null
} = {}) {
  const bundle = await loadPromptBundle(promptKey);
  const systemPrompt = composeSchemaBoundSystemPrompt(
    renderTemplate(bundle.system, variables),
    bundle.schema
  );
  const userPrompt = renderTemplate(bundle.user, variables);

  const callOptions = resolvePromptCallOptions(promptKey, settings, {
    temperature,
    reasoningEffort
  });
  const callTemperature = callOptions.temperature;
  const callReasoningEffort = callOptions.reasoningEffort;

  onLog?.(`LLM request -> ${promptKey}`);
  const response = await callOpenWebUI([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ], {
    model: modelName,
    temperature: callTemperature,
    reasoningEffort: callReasoningEffort,
    maxOutputTokens
  });

  if (Array.isArray(response?.unsupportedOptions) && response.unsupportedOptions.length > 0) {
    onLog?.(`LLM unsupported options (${promptKey}): ${response.unsupportedOptions.join(", ")}`);
  }

  if (!response.ok) {
    throw new Error(`${promptKey} failed: HTTP ${response.status}`);
  }

  onLog?.(`LLM response <- ${promptKey}`);
  const parsed = parseJsonFromText(response.content);
  const validation = validateAgainstSchema(parsed, bundle.schema);
  if (!validation.valid) {
    throw new Error(`invalid_output:${validation.errors[0] || "schema_mismatch"}`);
  }

  return {
    parsed,
    raw: response.content,
    schema: bundle.schema,
    repairUser: bundle.repairUser
  };
}

async function requestCitationEvalJsonWithRepair(input, {
  modelName,
  onLog,
  settings = null
} = {}) {
  const bundle = await loadPromptBundle("citation_eval_json");
  const systemPrompt = composeSchemaBoundSystemPrompt(
    renderTemplate(bundle.system, input),
    bundle.schema
  );
  const userPrompt = renderTemplate(bundle.user, input);

  const citationCallOptions = resolvePromptCallOptions("citation_eval_json", settings);

  let first = await callOpenWebUI([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ], {
    model: modelName,
    temperature: citationCallOptions.temperature,
    reasoningEffort: citationCallOptions.reasoningEffort
  });

  const firstRaw = first.content || "";
  if (first.ok) {
    try {
      const parsed = parseJsonFromText(firstRaw);
      const validation = validateAgainstSchema(parsed, bundle.schema);
      if (!validation.valid) {
        throw new Error(`invalid_output:${validation.errors[0] || "schema_mismatch"}`);
      }
      return {
        parsed,
        raw: firstRaw,
        repaired: false
      };
    } catch {
      // continue to repair path
    }
  }

  const repairPrompt = renderTemplate(bundle.repairUser, {
    raw_output: firstRaw,
    claim_text: input.claim_text,
    features_json: input.features_json,
    citation_text: input.citation_text,
    dwpi_text: input.dwpi_text,
    application_no: input.application_no
  });

  onLog?.("LLM repair request -> citation_eval_json");
  let repaired = await callOpenWebUI([
    { role: "system", content: systemPrompt },
    { role: "user", content: repairPrompt }
  ], {
    model: modelName,
    temperature: citationCallOptions.temperature,
    reasoningEffort: citationCallOptions.reasoningEffort
  });

  if (!repaired.ok) {
    throw new Error(`citation_eval_json repair failed: HTTP ${repaired.status}`);
  }

  const parsed = parseJsonFromText(repaired.content || "");
  const validation = validateAgainstSchema(parsed, bundle.schema);
  if (!validation.valid) {
    throw new Error(`invalid_output:${validation.errors[0] || "schema_mismatch"}`);
  }

  return {
    parsed,
    raw: repaired.content || "",
    repaired: true
  };
}

export async function generateInitialQuery(claimText, {
  modelName,
  onLog,
  querySeedTemperature,
  settings = null
} = {}) {
  const normalizedClaim = String(claimText || "").trim();
  if (!normalizedClaim) {
    throw new Error("claim text is empty");
  }

  let features;
  try {
    const featureExtractCallOptions = resolvePromptCallOptions("feature_extract", settings);
    const extracted = await requestStructuredJson("feature_extract", {
      claim_text: normalizedClaim
    }, {
      modelName,
      temperature: featureExtractCallOptions.temperature,
      reasoningEffort: featureExtractCallOptions.reasoningEffort,
      onLog,
      settings
    });
    features = ensureCoreFlags(normalizeFeatureExtract(extracted.parsed).features);
  } catch (error) {
    onLog?.(`feature_extract fallback: ${error?.message || String(error)}`);
    features = ensureCoreFlags(fallbackFeatureExtract(normalizedClaim));
  }

  const initialActiveFeatureIds = selectInitialActiveFeatureIds(features, {
    minActive: 2,
    maxActive: 3
  });

  let seedNormalized;
  const resolvedQuerySeedTemperature = normalizeQuerySeedTemperature(querySeedTemperature);
  try {
    const querySeedCallOptions = resolvePromptCallOptions("query_seed", settings, {
      temperature: resolvedQuerySeedTemperature
    });
    const seeded = await requestStructuredJson("query_seed", {
      claim_text: normalizedClaim,
      features_json: JSON.stringify(features)
    }, {
      modelName,
      temperature: querySeedCallOptions.temperature,
      reasoningEffort: querySeedCallOptions.reasoningEffort,
      onLog,
      settings
    });

    seedNormalized = normalizeQuerySeed(
      seeded.parsed,
      features,
      {
        mode: "initial",
        activeFeatureIds: initialActiveFeatureIds
      }
    );
  } catch (error) {
    onLog?.(`query_seed fallback: ${error?.message || String(error)}`);
    const fallbackSeed = {
      terms_by_feature: features.map((feature) => ({
        feature_id: feature.id,
        base_terms: normalizeAtomicTermList([feature?.search_hint || feature?.searchHint || feature.text || ""], {
          allowLockedBigrams: false
        }).slice(0, 1),
        support_terms: [],
        broad_terms: deriveLooseFallbackTerms(feature.text || "").slice(0, 2),
        narrow_terms: [],
        avoid_terms: [],
        locked_bigrams: []
      }))
    };
    seedNormalized = normalizeQuerySeed(fallbackSeed, features, {
      mode: "initial",
      activeFeatureIds: initialActiveFeatureIds
    });
  }

  const featureStateById = defaultFeatureStateById(features);
  const seedByFeature = seedNormalized.seedByFeature || {};

  features.forEach((feature) => {
    const featureId = toUpperId(feature?.id);
    if (!featureId) return;
    const baseState = featureStateById[featureId] || {};
    const queryRole = normalizeQueryRole(feature?.query_role || feature?.queryRole, baseState.core ? "must" : "should");
    const enabled = queryRole !== "can_drop";
    featureStateById[featureId] = {
      ...baseState,
      enabled,
      active: enabled && initialActiveFeatureIds.includes(featureId),
      core: queryRole === "must",
      text: String(feature?.text || baseState.text || "").trim(),
      type: normalizeFeatureType(feature?.type || baseState.type, queryRole === "must" ? "anchor" : "optional"),
      weight: normalizeFeatureWeight(feature?.weight ?? baseState.weight, queryRole === "must" ? 5 : 3),
      queryRole,
      relationTo: uniqueStrings(feature?.relation_to || baseState.relationTo || []),
      negative: !!feature?.negative,
      focus: false,
      simplified: false,
      phrase_locked_terms: uniqueStrings(seedNormalized?.phraseLockedTermsByFeature?.[featureId] || [])
    };
  });

  let termsByFeature = ensureTermsByFeature(seedNormalized.termsByFeature || {}, features);
  const initialTermPolicy = buildModeTermCapPolicy({
    mode: "initial",
    features,
    featureStateById,
    broadenFeatureIds: [],
    focusFeatureId: "",
    balancedSupportFeatureIds: []
  });

  features.forEach((feature) => {
    const featureId = toUpperId(feature?.id);
    const state = featureStateById[featureId] || {};
    const buckets = seedByFeature[featureId] || {};
    const selected = selectTermsForMode({
      id: featureId,
      text: feature?.text || featureId,
      type: state.type,
      queryRole: state.queryRole,
      weight: state.weight
    }, buckets, "initial", {
      active: state.active === true,
      includeSupport: resolveFeatureTermLimit(featureId, initialTermPolicy) >= 2,
      isBalancedSupportFeature: resolveFeatureTermLimit(featureId, initialTermPolicy) >= 2,
      phraseLockedTerms: state.phrase_locked_terms || []
    });

    if (selected.terms.length > 0) {
      const termLimit = resolveFeatureTermLimit(featureId, initialTermPolicy);
      termsByFeature[featureId] = uniqueStrings(selected.terms).slice(0, termLimit);
    }
  });
  termsByFeature = applyModeTermCapToFeatureTerms({
    features,
    termsByFeature,
    policy: initialTermPolicy
  });

  const initialGroups = features.map((feature, index) => {
    const featureId = toUpperId(feature?.id || `F${index + 1}`);
    const state = featureStateById[featureId] || {};
    const termLimit = resolveFeatureTermLimit(featureId, initialTermPolicy);
    const terms = uniqueStrings(termsByFeature[featureId] || []).slice(0, termLimit);
    return {
      group_id: `G${index + 1}`,
      feature_ids: [featureId],
      required: state.core === true && state.active === true,
      active: state.active === true,
      focus: false,
      simplified: false,
      terms,
      phrase_locked_terms: uniqueStrings(state.phrase_locked_terms || []),
      reason: state.active === true ? "Initial active anchor group" : "Stored inactive group",
      mode: state.core === true ? "anchor" : "gap"
    };
  });

  const materialized = dedupeAndMaterializeQuery({
    queryPlan: { groups: initialGroups },
    features,
    termsByFeature,
    featureStateById,
    maxActiveGroups: 3,
    ...initialTermPolicy
  });
  termsByFeature = materialized.termsByFeature;
  const queryPlan = materialized.queryPlan;
  const expression = materialized.expression;
  const crossGroupDedupeMeta = materialized.crossGroupDedupeMeta || {};
  const fingerprints = buildVersionFingerprints({
    queryPlan,
    termsByFeature,
    featureStateById
  });

  return {
    features,
    featureStateById,
    termsByFeature,
    seedByFeature,
    queryPlan,
    expression,
    queryVersionId: makeQueryVersionId(),
    createdAt: nowIso(),
    source: "initial",
    historyWeight: 1,
    fingerprint: fingerprints.fingerprint,
    semanticFingerprint: fingerprints.semanticFingerprint,
    activeTermsFingerprint: fingerprints.activeTermsFingerprint,
    activeTerms: fingerprints.activeTerms,
    duplicateOfQueryVersionId: null,
    duplicateBlocked: false,
    feedbackBasis: {
      mode: "initial",
      activeGroupIds: (Array.isArray(queryPlan?.groups) ? queryPlan.groups : [])
        .filter((group) => group.active === true)
        .map((group) => String(group.group_id || group.groupId || "").trim())
        .filter(Boolean),
      inactiveGroupIds: (Array.isArray(queryPlan?.groups) ? queryPlan.groups : [])
        .filter((group) => group.active === false)
        .map((group) => String(group.group_id || group.groupId || "").trim())
        .filter(Boolean),
      focusFeatureId: "",
      simplificationApplied: false,
      changedGroupIds: [],
      crossGroupDedupe: {
        duplicate_terms_removed: uniqueStrings(crossGroupDedupeMeta?.duplicate_terms_removed || []),
        term_owner_by_group: crossGroupDedupeMeta?.term_owner_by_group || {},
        emptied_groups: uniqueStrings(crossGroupDedupeMeta?.emptied_groups || []),
        rebuild_required_due_to_cross_group_dedupe:
          crossGroupDedupeMeta?.rebuild_required_due_to_cross_group_dedupe === true
      }
    }
  };
}


export async function evaluateCapturedRows({
  claimText,
  features,
  rows,
  queryVersionId,
  runId,
  modelName,
  onLog,
  onProgress,
  concurrency = 4,
  alreadyEvaluatedApplicationNos = [],
  settings = null
}) {
  const featureIds = (Array.isArray(features) ? features : []).map((feature) => feature.id);
  const knownApplicationNos = new Set(
    (Array.isArray(alreadyEvaluatedApplicationNos) ? alreadyEvaluatedApplicationNos : [])
      .map((applicationNo) => normalizeApplicationNo(applicationNo))
      .filter(Boolean)
  );
  const sourceRows = Array.isArray(rows) ? rows : [];
  const dedupeSeen = new Set();
  const dedupedRows = [];
  sourceRows.forEach((row, index) => {
    const applicationNo = normalizeApplicationNo(row?.applicationNo);
    if (applicationNo && knownApplicationNos.has(applicationNo)) return;
    const rowId = String(row?.id || "").trim() || `eval_${index + 1}`;
    const dedupeKey = applicationNo ? `app:${applicationNo}` : `id:${rowId}`;
    if (dedupeSeen.has(dedupeKey)) return;
    dedupeSeen.add(dedupeKey);
    dedupedRows.push(row);
  });
  const limitedRows = dedupedRows.slice(0, MAX_EVAL_ROWS);
  const total = limitedRows.length;
  const normalizedConcurrency = Math.max(
    1,
    Math.min(8, Number.isFinite(Number(concurrency)) ? Number(concurrency) : 4)
  );

  let pending = total;
  let running = 0;
  let completed = 0;
  let failed = 0;

  const evaluationsWithIndex = [];
  const invalidWithIndex = [];

  const rowMetas = limitedRows.map((row, index) => ({
    index,
    resultId: String(row?.id || "").trim() || `eval_${index + 1}`,
    applicationNo: String(row?.applicationNo || "").trim()
  }));

  const emitProgress = (phase, row = null) => {
    onProgress?.({
      phase,
      total,
      pending,
      running,
      completed,
      failed,
      rows: phase === "init" ? rowMetas : undefined,
      row
    });
  };

  emitProgress("init");

  const evaluateOne = async (row, index) => {
    const resultId = String(row?.id || "").trim() || `eval_${index + 1}`;
    const input = {
      claim_text: claimText,
      features_json: JSON.stringify(features),
      application_no: String(row?.applicationNo || "").trim(),
      citation_text: String(row?.citationText || "").trim(),
      dwpi_text: String(row?.dwpiText || "").trim()
    };

    try {
      const result = await requestCitationEvalJsonWithRepair(input, {
        modelName,
        onLog,
        settings
      });
      const normalized = normalizeCitationEval(result.parsed, featureIds);
      return {
        ok: true,
        index,
        row: {
          index,
          resultId,
          applicationNo: input.application_no
        },
        value: {
          resultId,
          applicationNo: input.application_no,
          runId: String(runId || row?.runId || "").trim(),
          queryVersionId: String(queryVersionId || row?.queryVersionId || "").trim(),
          score: normalized.score,
          reason: normalized.reason,
          featureJudgments: normalized.featureJudgments,
          featureHits: normalized.featureHits,
          missingFeatures: normalized.missingFeatures,
          noisyTerms: normalized.noisyTerms,
          fieldSimilarity: normalized.fieldSimilarity,
          pairFillValue: normalized.pairFillValue,
          conflictFlags: normalized.conflictFlags,
          addTerms: normalized.addTerms,
          removeTerms: normalized.removeTerms,
          rawCitationText: input.citation_text,
          rawDwpiText: input.dwpi_text,
          repaired: !!result.repaired
        }
      };
    } catch (error) {
      const errorText = String(error?.message || error || "");
      const invalidType = errorText.startsWith("invalid_output")
        ? "invalid_output"
        : "parse_error";
      return {
        ok: false,
        index,
        row: {
          index,
          resultId,
          applicationNo: input.application_no
        },
        value: {
          resultId,
          applicationNo: input.application_no,
          type: invalidType,
          reason: `${invalidType}: ${errorText}`
        }
      };
    }
  };

  let cursor = 0;
  const workerCount = Math.min(normalizedConcurrency, Math.max(1, total));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= total) return;
      const row = limitedRows[index];

      pending = Math.max(0, pending - 1);
      running += 1;
      emitProgress("row_start", {
        index,
        resultId: String(row?.id || "").trim() || `eval_${index + 1}`,
        applicationNo: String(row?.applicationNo || "").trim(),
        status: "running"
      });

      const result = await evaluateOne(row, index);
      running = Math.max(0, running - 1);

      if (result.ok) {
        completed += 1;
        evaluationsWithIndex.push(result);
        emitProgress("row_done", {
          ...result.row,
          status: "completed"
        });
      } else {
        failed += 1;
        invalidWithIndex.push(result);
        emitProgress("row_done", {
          ...result.row,
          status: "failed"
        });
      }
    }
  });

  await Promise.all(workers);
  emitProgress("complete");

  const evaluations = evaluationsWithIndex
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.value);
  const invalidOutputs = invalidWithIndex
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.value);

  return { evaluations, invalidOutputs };
}

function applyFallbackRefineSignals({
  mode,
  featureStateById,
  termsByFeature,
  features,
  signals,
  feedbackActions
}) {
  const nextTerms = { ...termsByFeature };
  const nextState = JSON.parse(JSON.stringify(featureStateById || {}));

  const addCandidates = Array.isArray(signals?.addCandidates) ? signals.addCandidates : [];
  const removeCandidates = Array.isArray(signals?.removeCandidates) ? signals.removeCandidates : [];

  let budget = MAX_AUTO_ACTIONS;

  if (mode === "widen") {
    for (const feature of features) {
      if (budget <= 0) break;
      const id = feature.id;
      const terms = normalizeAtomicTermList(nextTerms[id] || [], { allowLockedBigrams: false });
      if (terms.length >= 2) continue;
      const fallback = deriveFallbackTerm(feature.text);
      if (!fallback) continue;
      terms.push(fallback);
      nextTerms[id] = uniqueStrings(terms).slice(0, 2);
      feedbackActions.push(`[${id}] widen: + ${fallback}`);
      budget -= 1;
    }
  }

  if (mode === "narrow") {
    for (const feature of features) {
      if (budget <= 0) break;
      const id = feature.id;
      const terms = normalizeAtomicTermList(nextTerms[id] || [], { allowLockedBigrams: false });
      if (terms.length <= 1) continue;
      nextTerms[id] = [terms[0]];
      feedbackActions.push(`[${id}] narrow: keep '${terms[0]}'`);
      budget -= 1;
    }
  }

  for (const candidate of addCandidates) {
    if (budget <= 0) break;
    const featureId = toUpperId(candidate?.featureId);
    const term = normalizeAtomicTermList([candidate?.term], { allowLockedBigrams: false })[0] || "";
    if (!featureId || !term) continue;
    const terms = uniqueStrings(normalizeAtomicTermList([...(nextTerms[featureId] || []), term], { allowLockedBigrams: false })).slice(0, 2);
    if (terms.length === (nextTerms[featureId] || []).length) continue;
    nextTerms[featureId] = terms;
    feedbackActions.push(`[${featureId}] add term '${term}'`);
    budget -= 1;
  }

  for (const candidate of removeCandidates) {
    if (budget <= 0) break;
    const featureId = toUpperId(candidate?.featureId);
    const term = normalizeAtomicTermList([candidate?.term], { allowLockedBigrams: false })[0] || "";
    if (!featureId || !term) continue;
    const prev = uniqueStrings(nextTerms[featureId] || []);
    const filtered = prev.filter((entry) => entry.toLowerCase() !== term.toLowerCase());
    if (filtered.length === prev.length || filtered.length === 0) continue;
    nextTerms[featureId] = filtered;
    feedbackActions.push(`[${featureId}] remove term '${term}'`);
    budget -= 1;
  }

  const coreIds = features
    .filter((feature) => isMustFeature(feature))
    .map((feature) => feature.id);
  const enabledCore = coreIds.filter((id) => nextState[id]?.enabled !== false);
  if (enabledCore.length < Math.min(2, coreIds.length)) {
    coreIds.forEach((id) => {
      nextState[id] = {
        ...(nextState[id] || {}),
        enabled: true,
        core: true,
        text: nextState[id]?.text || features.find((feature) => feature.id === id)?.text || ""
      };
    });
    feedbackActions.push("Core feature guard: re-enabled core features.");
  }

  const lexical = enforceAtomicTermsByFeature(nextTerms, {}, {
    allowLockedBigrams: false
  });
  Object.assign(nextTerms, lexical.termsByFeature);

  return {
    termsByFeature: nextTerms,
    featureStateById: nextState
  };
}

function ensureRefinedExpressionChanged({
  currentExpression,
  mode,
  features,
  termsByFeature,
  featureStateById,
  feedbackActions
}) {
  const nextTerms = JSON.parse(JSON.stringify(termsByFeature || {}));
  const nextState = JSON.parse(JSON.stringify(featureStateById || {}));

  let expression = buildExpression({
    features,
    termsByFeature: nextTerms,
    featureStateById: nextState
  });
  if (String(expression || "").trim() && String(expression || "").trim() !== String(currentExpression || "").trim()) {
    return {
      expression,
      termsByFeature: nextTerms,
      featureStateById: nextState
    };
  }

  if (mode === "narrow") {
    const optionalEnabled = (Array.isArray(features) ? features : []).find((feature) => {
      const id = toUpperId(feature?.id);
      return id && !isMustFeature(feature) && nextState[id]?.enabled !== false;
    });
    if (optionalEnabled) {
      const id = toUpperId(optionalEnabled.id);
      const queryRole = normalizeQueryRole(optionalEnabled?.query_role || optionalEnabled?.queryRole, "should");
      nextState[id] = {
        ...(nextState[id] || {}),
        enabled: false,
        core: queryRole === "must",
        text: String(optionalEnabled.text || ""),
        queryRole,
        type: normalizeFeatureType(optionalEnabled?.type, queryRole === "must" ? "anchor" : "optional"),
        weight: normalizeFeatureWeight(optionalEnabled?.weight, queryRole === "must" ? 5 : 3),
        relationTo: uniqueStrings(optionalEnabled?.relation_to || []),
        negative: !!optionalEnabled?.negative
      };
      feedbackActions.push(`[${id}] narrow_guard: disable optional feature`);
    } else {
      const firstEnabled = (Array.isArray(features) ? features : []).find((feature) => {
        const id = toUpperId(feature?.id);
        return id && nextState[id]?.enabled !== false;
      });
      if (firstEnabled) {
        const id = toUpperId(firstEnabled.id);
        const strict = pickAtomicTerm(nextTerms[id] || [], firstEnabled.text);
        if (strict) {
          nextTerms[id] = [strict];
          feedbackActions.push(`[${id}] narrow_guard: keep strict term '${strict}'`);
        }
      }
    }
  } else {
    const firstEnabled = (Array.isArray(features) ? features : []).find((feature) => {
      const id = toUpperId(feature?.id);
      return id && nextState[id]?.enabled !== false;
    });
    if (firstEnabled) {
      const id = toUpperId(firstEnabled.id);
      const prev = uniqueStrings(nextTerms[id] || []);
      const loose = deriveLooseFallbackTerms(firstEnabled.text).find((term) => {
        return !prev.some((entry) => entry.toLowerCase() === String(term || "").toLowerCase());
      });
      if (loose) {
        nextTerms[id] = uniqueStrings(normalizeAtomicTermList([...prev, loose], { allowLockedBigrams: false })).slice(0, 2);
        feedbackActions.push(`[${id}] widen_guard: add loose term '${loose}'`);
      }
    }
  }

  expression = buildExpression({
    features,
    termsByFeature: nextTerms,
    featureStateById: nextState
  });

  if (String(expression || "").trim() === String(currentExpression || "").trim()) {
    const firstEnabled = (Array.isArray(features) ? features : []).find((feature) => {
      const id = toUpperId(feature?.id);
      return id && nextState[id]?.enabled !== false;
    });
    if (firstEnabled) {
      const id = toUpperId(firstEnabled.id);
      const base = pickAtomicTerm(nextTerms[id] || [], firstEnabled.text);
      if (base) {
        if (mode === "narrow") {
          nextTerms[id] = [base];
          feedbackActions.push(`[${id}] narrow_guard: force atomic strict term`);
        } else {
          const loose = deriveLooseFallbackTerms(base).find((term) => term && term.length >= 2) || base;
          if (loose) {
            nextTerms[id] = uniqueStrings(normalizeAtomicTermList([...(nextTerms[id] || []), loose], { allowLockedBigrams: false })).slice(0, 2);
            feedbackActions.push(`[${id}] widen_guard: force loose seed '${loose}'`);
          }
        }
      }
    }

    expression = buildExpression({
      features,
      termsByFeature: nextTerms,
      featureStateById: nextState
    });
  }

  return {
    expression,
    termsByFeature: nextTerms,
    featureStateById: nextState
  };
}

function buildDeterministicDuplicateRepairCandidate({
  features,
  currentVersion,
  queryPlan,
  termsByFeature,
  featureStateById,
  trigger = null
}) {
  const triggerObj = trigger && typeof trigger === "object" ? trigger : {};
  const duplicateInfo = {
    reason: String(triggerObj?.reason || "duplicate preflight").trim() || "duplicate preflight",
    matchType: String(triggerObj?.matchType || "unknown").trim() || "unknown",
    duplicateOfQueryVersionId: String(triggerObj?.duplicateOfQueryVersionId || "").trim()
  };

  const corrected = applyDuplicateCorrectivePolicy({
    mode: "balanced",
    features,
    queryPlan,
    termsByFeature,
    featureStateById,
    seedByFeature: currentVersion?.seedByFeature || {},
    duplicateInfo,
    plannerMeta: {}
  });

  let candidate = {
    expression: String(corrected?.expression || "").trim(),
    queryPlan: corrected?.queryPlan || queryPlan,
    termsByFeature: corrected?.termsByFeature || termsByFeature,
    featureStateById: corrected?.featureStateById || featureStateById,
    crossGroupDedupeMeta: corrected?.crossGroupDedupeMeta || {}
  };

  const currentExpression = normalizeQueryExpressionText(currentVersion?.expression || "");
  let expressionChanged = normalizeQueryExpressionText(candidate.expression) !== currentExpression;
  let feedbackActions = uniqueStrings(corrected?.feedbackActions || []);

  if (!expressionChanged) {
    const rebuilt = forceRebuildForDuplicate({
      mode: "balanced",
      features,
      seedByFeature: currentVersion?.seedByFeature || {},
      featureStateById: candidate.featureStateById,
      termsByFeature: candidate.termsByFeature
    });
    candidate = {
      expression: String(rebuilt?.expression || "").trim(),
      queryPlan: rebuilt?.queryPlan || candidate.queryPlan,
      termsByFeature: rebuilt?.termsByFeature || candidate.termsByFeature,
      featureStateById: rebuilt?.featureStateById || candidate.featureStateById,
      crossGroupDedupeMeta: rebuilt?.crossGroupDedupeMeta || candidate.crossGroupDedupeMeta
    };
    expressionChanged = normalizeQueryExpressionText(candidate.expression) !== currentExpression;
    feedbackActions = uniqueStrings([
      ...feedbackActions,
      "duplicate_repair_deterministic: stronger rebuild applied"
    ]);
  }

  return {
    candidate,
    expressionChanged,
    feedbackActions
  };
}

export async function autoRepairDuplicateQuery({
  claimText,
  features,
  currentVersion,
  queryVersions,
  modelName,
  onLog,
  trigger = null,
  skipLlm = false,
  settings = null
}) {
  const featureIds = (Array.isArray(features) ? features : []).map((feature) => feature.id);
  const workingTermsByFeature = JSON.parse(JSON.stringify(currentVersion?.termsByFeature || {}));
  const workingQueryPlan = normalizeQueryPlan({
    queryPlan: currentVersion?.queryPlan || null,
    features,
    termsByFeature: workingTermsByFeature,
    featureStateById: currentVersion?.featureStateById || {}
  });
  const feedbackActions = [];

  let planSeedTerms = JSON.parse(JSON.stringify(workingTermsByFeature || {}));
  const planSeedState = JSON.parse(JSON.stringify(currentVersion?.featureStateById || {}));
  let planSeedQueryPlan = normalizeQueryPlan({
    queryPlan: workingQueryPlan,
    features,
    termsByFeature: planSeedTerms,
    featureStateById: planSeedState
  });

  let refinedMode = "balanced";
  let featureActions = [];
  let finalTermsByFeature = {};
  let repairNotes = "";
  let llmFailed = false;

  if (skipLlm !== true) {
    try {
      const repairContext = buildDuplicateRepairContext({
        features,
        currentVersion,
        workingQueryPlan: planSeedQueryPlan,
        workingTermsByFeature: planSeedTerms,
        featureStateById: planSeedState,
        trigger
      });

      const result = await requestStructuredJson("query_duplicate_repair", {
        claim_text: String(claimText || "").trim(),
        repair_context_json: JSON.stringify(repairContext)
      }, {
        modelName,
        onLog,
        settings
      });
      const normalized = normalizeQueryRefine(result.parsed, featureIds);
      refinedMode = normalized.mode === "rebuild" ? "balanced" : (normalized.mode || "balanced");
      featureActions = normalized.featureActions || [];
      finalTermsByFeature = normalized.finalTermsByFeature || {};
      repairNotes = normalized.notes || "";
      feedbackActions.push("duplicate_repair_llm: response accepted");
    } catch (error) {
      llmFailed = true;
      onLog?.(`query_duplicate_repair fallback: ${error?.message || String(error)}`);
      feedbackActions.push(`duplicate_repair_llm: failed (${error?.message || String(error)})`);
    }
  } else {
    feedbackActions.push("duplicate_repair_deterministic: skipLlm=true");
  }

  let materialized;
  let expressionChanged = false;
  if (skipLlm === true || llmFailed === true) {
    const deterministic = buildDeterministicDuplicateRepairCandidate({
      features,
      currentVersion,
      queryPlan: planSeedQueryPlan,
      termsByFeature: planSeedTerms,
      featureStateById: planSeedState,
      trigger
    });
    materialized = deterministic.candidate;
    expressionChanged = deterministic.expressionChanged;
    feedbackActions.push(...(deterministic.feedbackActions || []));
  } else {
    if (finalTermsByFeature && typeof finalTermsByFeature === "object") {
      Object.entries(finalTermsByFeature).forEach(([featureIdRaw, terms]) => {
        const featureId = toUpperId(featureIdRaw);
        if (!featureId) return;
        const normalized = normalizeAtomicTermList(terms, { allowLockedBigrams: false }).slice(0, 2);
        if (!normalized.length) return;
        planSeedTerms[featureId] = normalized;
      });
      feedbackActions.push("duplicate_repair_llm_final_terms: applied");
    }

    const lexicalPlanSeed = enforceAtomicTermsByFeature(planSeedTerms, {}, {
      allowLockedBigrams: false
    });
    planSeedTerms = ensureTermsByFeature(lexicalPlanSeed.termsByFeature, features);

    const planned = planQueryAdjustment(null, {
      decision: "restart_direction",
      countBucket: "unknown",
      repeatReasonCount: 1,
      currentResultCount: null,
      saturatedFeatureIds: [],
      gapFeatureIds: [],
      noisyTermsByFeature: {}
    }, 1, {
      features,
      currentExpression: currentVersion?.expression || "",
      expression: currentVersion?.expression || "",
      queryPlan: planSeedQueryPlan,
      termsByFeature: planSeedTerms,
      seedByFeature: currentVersion?.seedByFeature || {},
      featureStateById: planSeedState,
      modeHint: refinedMode,
      featureActions,
      signals: {},
      refineHints: {
        promoteFeatureIds: [],
        dropFeatureIds: [],
        dephraseTerms: [],
        dropGroupIds: [],
        splitFeaturePlans: [],
        antiNoiseTerms: [],
        countStrategyNote: "",
        rebuildRequired: false,
        explicitFinalTermsByFeature: finalTermsByFeature || {}
      },
      maxActions: MAX_AUTO_ACTIONS
    });

    const plannedTermPolicy = buildTermPolicyFromPlannedResult(planned, features);
    const plannedTermsByFeature = applyModeTermCapToFeatureTerms({
      features,
      termsByFeature: planned.termsByFeature,
      policy: plannedTermPolicy
    });

    const plannedFeatureStateById = planned.featureStateById;
    materialized = dedupeAndMaterializeQuery({
      queryPlan: planned.queryPlan,
      features,
      termsByFeature: plannedTermsByFeature,
      featureStateById: plannedFeatureStateById,
      ...plannedTermPolicy
    });
    materialized.featureStateById = plannedFeatureStateById;

    expressionChanged = normalizeQueryExpressionText(materialized?.expression || "")
      !== normalizeQueryExpressionText(currentVersion?.expression || "");
    feedbackActions.push(...(planned.feedbackActions || []));
  }

  const candidateExpression = String(materialized?.expression || "").trim();
  if (!expressionChanged || !candidateExpression) {
    return {
      noChange: true,
      mode: refinedMode,
      notes: repairNotes,
      duplicateBlocked: false,
      feedbackActions: uniqueStrings([
        ...feedbackActions,
        "duplicate_repair: no expression change"
      ]).slice(0, 50),
      failureReason: "same_expression"
    };
  }

  const candidateFingerprints = buildVersionFingerprints({
    queryPlan: materialized.queryPlan,
    termsByFeature: materialized.termsByFeature,
    featureStateById: materialized.featureStateById
  });
  const duplicate = findDuplicateQueryVersion({
    queryVersions,
    candidateFingerprints,
    excludeQueryVersionId: currentVersion?.queryVersionId
  });
  if (duplicate) {
    return {
      noChange: true,
      mode: refinedMode,
      notes: repairNotes,
      duplicateBlocked: true,
      duplicateOfQueryVersionId: duplicate.duplicateOfQueryVersionId || "",
      feedbackActions: uniqueStrings([
        ...feedbackActions,
        `duplicate_repair: duplicate persisted (${duplicate.reason || "unknown"})`
      ]).slice(0, 50),
      failureReason: "duplicate_persisted"
    };
  }

  return {
    queryVersionId: makeQueryVersionId(),
    createdAt: nowIso(),
    source: skipLlm === true || llmFailed === true ? "duplicate_repair_deterministic" : "duplicate_repair_llm",
    historyWeight: 1,
    refineMode: refinedMode,
    notes: repairNotes,
    expression: candidateExpression,
    queryPlan: materialized.queryPlan,
    termsByFeature: materialized.termsByFeature,
    seedByFeature: currentVersion?.seedByFeature || {},
    featureStateById: materialized.featureStateById,
    fingerprint: candidateFingerprints.fingerprint || "",
    semanticFingerprint: candidateFingerprints.semanticFingerprint || "",
    activeTermsFingerprint: candidateFingerprints.activeTermsFingerprint || "",
    activeTerms: candidateFingerprints.activeTerms || [],
    duplicateOfQueryVersionId: null,
    duplicateBlocked: false,
    targetCountRange: currentVersion?.targetCountRange || TARGET_COUNT_RANGE_DEFAULT,
    softTargetRange: currentVersion?.softTargetRange || SOFT_TARGET_RANGE_DEFAULT,
    currentResultCount: currentVersion?.currentResultCount ?? null,
    previousResultCount: currentVersion?.previousResultCount ?? null,
    countSource: currentVersion?.countSource || "unknown",
    countBucket: currentVersion?.countBucket || "unknown",
    countDistanceScore: currentVersion?.countDistanceScore ?? null,
    reductionRatio: currentVersion?.reductionRatio ?? null,
    repeatReasonSignature: currentVersion?.repeatReasonSignature || "",
    repeatReasonCount: currentVersion?.repeatReasonCount || 1,
    feedbackActions: uniqueStrings([
      ...feedbackActions,
      "duplicate_repair: applied"
    ]).slice(0, 50),
    feedbackBasis: {
      nextQueryRationale: "Duplicate repair route applied",
      duplicateRepairTrigger: trigger && typeof trigger === "object" ? trigger : {},
      expressionChanged: true
    }
  };
}

export async function autoRefineQuery({
  claimText,
  features,
  currentVersion,
  evaluations,
  summary,
  countContext = null,
  queryVersions,
  iterations,
  feedbackLog,
  modelName,
  onLog,
  settings = null,
  _retryAttempt = 1,
  _duplicateRetryHint = null
}) {
  const featureIds = features.map((feature) => feature.id);
  const signals = buildActionSignals(evaluations);
  const corpusSummary = buildCorpusFeedbackSummary(evaluations, features, summary, signals);
  const historyContext = buildQueryHistoryContext(queryVersions, iterations, feedbackLog);
  const feedbackActions = [];
  let workingTermsByFeature = JSON.parse(JSON.stringify(currentVersion?.termsByFeature || {}));
  let workingQueryPlan = normalizeQueryPlan({
    queryPlan: currentVersion?.queryPlan || null,
    features,
    termsByFeature: workingTermsByFeature,
    featureStateById: currentVersion?.featureStateById || {}
  });

  const summarySafe = summary && typeof summary === "object"
    ? summary
    : {
      resultCount: 0,
      topScore: null,
      coverage: null,
      singleHit: false,
      pairHit: false
    };

  const normalizedCountContext = normalizeCountContext({
    countContext,
    iterations,
    summary: summarySafe
  });
  const countBucketClass = classifyResultCount(normalizedCountContext.currentResultCount);
  corpusSummary.count = {
    targetCountRange: normalizedCountContext.targetCountRange,
    softTargetRange: normalizedCountContext.softTargetRange,
    currentResultCount: normalizedCountContext.currentResultCount,
    previousResultCount: normalizedCountContext.previousResultCount,
    countSource: normalizedCountContext.countSource,
    countBucket: normalizedCountContext.countBucket,
    countDistanceScore: normalizedCountContext.countDistanceScore,
    reductionRatio: normalizedCountContext.reductionRatio,
    repeatReasonSignature: normalizedCountContext.repeatReasonSignature,
    repeatReasonCount: normalizedCountContext.repeatReasonCount
  };

  let refineMode = "balanced";
  if (countBucketClass.isTooMany) {
    refineMode = "narrow";
  } else if (countBucketClass.isEmpty) {
    refineMode = "widen";
  } else if (countBucketClass.isTooFew) {
    refineMode = summarySafe.topScore !== null && summarySafe.topScore >= 70 ? "balanced" : "widen";
  } else if (summarySafe.resultCount === 0 || (summarySafe.topScore !== null && summarySafe.topScore < 40)) {
    refineMode = "widen";
  }
  let featureActions = [];
  let llmNotes = "";
  let finalTermsByFeature = {};
  let refineHints = {
    promoteFeatureIds: [],
    dropFeatureIds: [],
    dephraseTerms: [],
    dropGroupIds: [],
    splitFeaturePlans: [],
    antiNoiseTerms: [],
    countStrategyNote: "",
    rebuildRequired: false,
    explicitFinalTermsByFeature: {}
  };

  if (hasUnmappedQueryPlanGroups(workingQueryPlan)) {
    const remapped = await remapUnmappedQueryPlanWithLlm({
      claimText,
      features,
      expression: currentVersion?.expression || "",
      queryPlan: workingQueryPlan,
      termsByFeature: workingTermsByFeature,
      featureStateById: currentVersion?.featureStateById || {},
      modelName,
      onLog,
      settings
    });
    if (remapped.applied) {
      workingQueryPlan = remapped.queryPlan;
      workingTermsByFeature = remapped.termsByFeature;
      feedbackActions.push(`query_plan_remap: ${Array.isArray(remapped.mappedGroupIds) ? remapped.mappedGroupIds.length : 0} group(s) remapped`);
      if (remapped.notes) feedbackActions.push(`query_plan_remap_note: ${clipText(remapped.notes, 120)}`);
    } else {
      feedbackActions.push("query_plan_remap: pending/unresolved");
    }
  }

  try {
    const refineContext = buildCompactRefineContext({
      features,
      currentVersion,
      workingQueryPlan,
      workingTermsByFeature,
      featureStateById: currentVersion?.featureStateById || {},
      summary: summarySafe,
      signals,
      corpusSummary,
      normalizedCountContext,
      historyContext,
      duplicateRetryHint: _duplicateRetryHint
    });
    const result = await requestStructuredJson("query_refine", {
      claim_text: claimText,
      refine_context_json: JSON.stringify(refineContext)
    }, {
      modelName,
      onLog,
      settings
    });

    const normalized = normalizeQueryRefine(result.parsed, featureIds);
    refineMode = normalized.mode;
    featureActions = normalized.featureActions;
    finalTermsByFeature = normalized.finalTermsByFeature || {};
    llmNotes = normalized.notes;
    if (String(normalized.queryExpression || "").trim()) {
      feedbackActions.push("llm_query_expression: ignored (deterministic builder policy)");
    }
    refineHints = {
      promoteFeatureIds: normalized.promoteFeatureIds || [],
      dropFeatureIds: normalized.dropFeatureIds || [],
      dephraseTerms: normalized.dephraseTerms || [],
      dropGroupIds: normalized.dropGroupIds || [],
      splitFeaturePlans: normalized.splitFeaturePlans || [],
      antiNoiseTerms: normalized.antiNoiseTerms || [],
      countStrategyNote: normalized.countStrategyNote || "",
      rebuildRequired: normalized.rebuildRequired === true,
      explicitFinalTermsByFeature: normalized.finalTermsByFeature || {}
    };
  } catch (error) {
    onLog?.(`query_refine fallback: ${error?.message || String(error)}`);
  }

  let planSeedTerms = JSON.parse(JSON.stringify(workingTermsByFeature || {}));
  let planSeedState = JSON.parse(JSON.stringify(currentVersion.featureStateById || {}));
  let planSeedQueryPlan = normalizeQueryPlan({
    queryPlan: workingQueryPlan,
    features,
    termsByFeature: planSeedTerms,
    featureStateById: planSeedState
  });
  if (finalTermsByFeature && typeof finalTermsByFeature === "object") {
    Object.entries(finalTermsByFeature).forEach(([featureIdRaw, terms]) => {
      const featureId = toUpperId(featureIdRaw);
      if (!featureId) return;
      const normalized = normalizeAtomicTermList(terms, { allowLockedBigrams: false }).slice(0, 2);
      if (!normalized.length) return;
      planSeedTerms[featureId] = normalized;
    });
    feedbackActions.push("llm_final_terms_by_feature: applied");
  }

  const lexicalPlanSeed = enforceAtomicTermsByFeature(planSeedTerms, {}, {
    allowLockedBigrams: false
  });
  if (Array.isArray(lexicalPlanSeed.violations) && lexicalPlanSeed.violations.length > 0) {
    onLog?.(`lexical normalize(auto): ${summarizeLexicalViolations(lexicalPlanSeed.violations)}`);
  }
  planSeedTerms = ensureTermsByFeature(lexicalPlanSeed.termsByFeature, features);

  const corpusDecision = buildCorpusDecisionEnvelope({
    features,
    summary: summarySafe,
    corpusSummary,
    signals,
    historyContext,
    requestedMode: refineMode,
    countContext: normalizedCountContext
  });

  const planned = planQueryAdjustment(null, corpusDecision, Math.max(1, Number(normalizedCountContext.repeatReasonCount || 1)), {
    features,
    currentExpression: currentVersion?.expression || "",
    expression: currentVersion?.expression || "",
    queryPlan: planSeedQueryPlan || currentVersion?.queryPlan || null,
    termsByFeature: planSeedTerms,
    seedByFeature: currentVersion?.seedByFeature || {},
    featureStateById: planSeedState,
    modeHint: refineMode,
    featureActions,
    signals,
    refineHints,
    maxActions: MAX_AUTO_ACTIONS
  });

  const plannedTermPolicy = buildTermPolicyFromPlannedResult(planned, features);
  const plannedTermsByFeature = applyModeTermCapToFeatureTerms({
    features,
    termsByFeature: planned.termsByFeature,
    policy: plannedTermPolicy
  });

  let materialized = dedupeAndMaterializeQuery({
    queryPlan: planned.queryPlan,
    features,
    termsByFeature: plannedTermsByFeature,
    featureStateById: planned.featureStateById,
    ...plannedTermPolicy
  });
  const plannerMetaWithDedupe = enrichPlannerMetaWithCrossGroupDedupe(
    planned?.plannerMeta || {},
    materialized.crossGroupDedupeMeta || {}
  );
  let candidateExpression = String(materialized.expression || "").trim();
  const hasStructuredLlmSignals = (
    (Array.isArray(featureActions) && featureActions.length > 0)
    || Object.keys(finalTermsByFeature || {}).length > 0
  );
  let expressionChanged = normalizeQueryExpressionText(candidateExpression)
    !== normalizeQueryExpressionText(currentVersion?.expression || "");

  if (!expressionChanged && hasStructuredLlmSignals) {
    const forced = ensureRefinedExpressionChanged({
      currentExpression: currentVersion?.expression || "",
      mode: planned.mode || refineMode,
      features,
      termsByFeature: materialized.termsByFeature,
      featureStateById: planned.featureStateById,
      feedbackActions
    });
    const forcedChanged = normalizeQueryExpressionText(forced.expression)
      !== normalizeQueryExpressionText(currentVersion?.expression || "");
    if (forcedChanged) {
      materialized = dedupeAndMaterializeQuery({
        queryPlan: planned.queryPlan,
        features,
        termsByFeature: forced.termsByFeature,
        featureStateById: forced.featureStateById,
        ...plannedTermPolicy
      });
      candidateExpression = String(materialized.expression || "").trim();
      expressionChanged = normalizeQueryExpressionText(candidateExpression)
        !== normalizeQueryExpressionText(currentVersion?.expression || "");
    }
  }

  const effectivePlannerMeta = {
    ...(plannerMetaWithDedupe || {}),
    expressionChanged
  };

  if (!expressionChanged) {
    return {
      noChange: true,
      mode: planned.mode || refineMode,
      notes: llmNotes,
      plannerMeta: effectivePlannerMeta,
      duplicateBlocked: false,
      feedbackActions: uniqueStrings([
        ...feedbackActions,
        ...(planned.feedbackActions || []),
        ...(Array.isArray(materialized?.crossGroupDedupeMeta?.duplicate_terms_removed) && materialized.crossGroupDedupeMeta.duplicate_terms_removed.length
          ? [`cross_group_dedupe_removed=${materialized.crossGroupDedupeMeta.duplicate_terms_removed.length}`]
          : []),
        "no_change_guard: skip new query version"
      ]).slice(0, 40)
    };
  }

  const resolved = resolveDuplicateCandidate({
    candidate: {
      expression: candidateExpression,
      queryPlan: materialized.queryPlan,
      termsByFeature: materialized.termsByFeature,
      featureStateById: planned.featureStateById,
      crossGroupDedupeMeta: materialized.crossGroupDedupeMeta || {}
    },
    mode: planned.mode || refineMode,
    features,
    queryVersions,
    currentVersion,
    seedByFeature: currentVersion?.seedByFeature || {},
    plannerMeta: plannerMetaWithDedupe
  });

  if (resolved?.stillDuplicate) {
    if (shouldRetryDuplicateRefine({
      stillDuplicate: true,
      skipLlm: false,
      retryAttempt: _retryAttempt,
      maxAttempts: REFINE_DUPLICATE_RETRY_MAX
    })) {
      const retryAttempt = Math.max(2, Number(_retryAttempt) + 1);
      const retryHint = buildDuplicateRetryHintPayload({
        resolved,
        historyContext,
        retryAttempt
      });
      onLog?.(`query_refine duplicate retry(${retryAttempt})`);
      const retried = await autoRefineQuery({
        claimText,
        features,
        currentVersion,
        evaluations,
        summary,
        countContext: normalizedCountContext,
        queryVersions,
        iterations,
        feedbackLog,
        modelName,
        onLog,
        _retryAttempt: retryAttempt,
        _duplicateRetryHint: retryHint
      });
      if (retried && typeof retried === "object") {
        retried.feedbackActions = uniqueStrings([
          `duplicate_retry: attempt=${retryAttempt}`,
          ...(retried.feedbackActions || [])
        ]).slice(0, 50);
      }
      return retried;
    }
    return {
      noChange: true,
      mode: planned.mode || refineMode,
      notes: llmNotes,
      plannerMeta: effectivePlannerMeta,
      duplicateBlocked: true,
      duplicateOfQueryVersionId: resolved?.duplicateInfo?.duplicateOfQueryVersionId || "",
      feedbackActions: uniqueStrings([
        ...feedbackActions,
        ...(planned.feedbackActions || []),
        ...(resolved?.correctiveActions || []),
        `duplicate_query_blocked: duplicate_of=${resolved?.duplicateInfo?.duplicateOfQueryVersionId || "unknown"}`,
        "no_change_guard: duplicate fingerprint persisted"
      ]).slice(0, 50)
    };
  }

  const finalizedCandidate = resolved?.candidate || {
    expression: candidateExpression,
    queryPlan: materialized.queryPlan,
    termsByFeature: materialized.termsByFeature,
    featureStateById: planned.featureStateById,
    ...buildVersionFingerprints({
      queryPlan: materialized.queryPlan,
      termsByFeature: materialized.termsByFeature,
      featureStateById: planned.featureStateById
    }),
    duplicateOfQueryVersionId: null,
    duplicateBlocked: false
  };

  const mergedFeedbackActions = uniqueStrings([
    ...feedbackActions,
    ...(planned.feedbackActions || []),
    ...(resolved?.correctiveActions || []),
    ...(finalizedCandidate?.duplicateBlocked
      ? [
        `duplicate_query_blocked: duplicate_of=${finalizedCandidate.duplicateOfQueryVersionId || "unknown"}`,
        `duplicate_query_blocked: reason=${resolved?.duplicateInfo?.reason || "fingerprint conflict"}`
      ]
      : []),
    ...(Array.isArray(finalizedCandidate?.crossGroupDedupeMeta?.duplicate_terms_removed) && finalizedCandidate.crossGroupDedupeMeta.duplicate_terms_removed.length
      ? [`cross_group_dedupe_removed=${finalizedCandidate.crossGroupDedupeMeta.duplicate_terms_removed.length}`]
      : [])
  ]).slice(0, 50);
  const nextQueryRationale = uniqueStrings([
    `mode=${planned.mode || refineMode}`,
    `decision=${planned?.plannerMeta?.decision || corpusDecision.decision || "balanced"}`,
    `saturated=${(corpusDecision.saturatedFeatureIds || []).length}`,
    `gaps=${(corpusDecision.gapFeatureIds || []).length}`,
    corpusSummary?.reasonSamples?.[0] ? `signal=${clipText(corpusSummary.reasonSamples[0], 120)}` : ""
  ]).join(" | ");

  return {
    queryVersionId: makeQueryVersionId(),
    createdAt: nowIso(),
    source: "refine",
    historyWeight: 1,
    expression: String(finalizedCandidate.expression || "").trim(),
    queryPlan: finalizedCandidate.queryPlan,
    termsByFeature: finalizedCandidate.termsByFeature,
    seedByFeature: currentVersion?.seedByFeature || {},
    featureStateById: finalizedCandidate.featureStateById,
    refineMode: planned.mode || refineMode,
    fingerprint: finalizedCandidate.fingerprint || "",
    semanticFingerprint: finalizedCandidate.semanticFingerprint || "",
    activeTermsFingerprint: finalizedCandidate.activeTermsFingerprint || "",
    activeTerms: finalizedCandidate.activeTerms || [],
    duplicateOfQueryVersionId: finalizedCandidate.duplicateOfQueryVersionId || null,
    duplicateBlocked: finalizedCandidate.duplicateBlocked === true,
    recentEscalationFamilies: uniqueStrings([
      ...(Array.isArray(currentVersion?.recentEscalationFamilies) ? currentVersion.recentEscalationFamilies : []),
      plannerMetaWithDedupe?.escalationFamily || ""
    ]).slice(-4),
    notes: llmNotes,
    targetCountRange: normalizedCountContext.targetCountRange,
    softTargetRange: normalizedCountContext.softTargetRange,
    currentResultCount: normalizedCountContext.currentResultCount,
    previousResultCount: normalizedCountContext.previousResultCount,
    countSource: normalizedCountContext.countSource,
    countBucket: normalizedCountContext.countBucket,
    countDistanceScore: normalizedCountContext.countDistanceScore,
    reductionRatio: normalizedCountContext.reductionRatio,
    repeatReasonSignature: normalizedCountContext.repeatReasonSignature,
    repeatReasonCount: normalizedCountContext.repeatReasonCount,
    feedbackActions: mergedFeedbackActions,
    feedbackBasis: {
      reinforceFeatures: corpusSummary.reinforceFeatures,
      alreadyCoveredFeatures: corpusSummary.alreadyCoveredFeatures,
      saturatedFeatureIds: corpusDecision.saturatedFeatureIds,
      gapFeatureIds: corpusDecision.gapFeatureIds,
      noisyTermsByFeature: corpusDecision.noisyTermsByFeature,
      plannerDecision: plannerMetaWithDedupe?.decision || corpusDecision.decision || "",
      nextQueryRationale,
      changedGroupIds: plannerMetaWithDedupe?.changedGroupIds || [],
      promotedFeatureId: plannerMetaWithDedupe?.promotedFeatureId || "",
      droppedFeatureId: plannerMetaWithDedupe?.droppedFeatureId || "",
      dephrasedTerms: plannerMetaWithDedupe?.dephrasedTerms || [],
      simplificationApplied: plannerMetaWithDedupe?.simplificationApplied === true,
      focusFeatureId: plannerMetaWithDedupe?.focusFeatureId || "",
      activeGroupIds: plannerMetaWithDedupe?.activeGroupIds || [],
      inactiveGroupIds: plannerMetaWithDedupe?.inactiveGroupIds || [],
      expressionChanged: true,
      crossGroupDedupe: plannerMetaWithDedupe?.crossGroupDedupe || {
        duplicate_terms_removed: [],
        term_owner_by_group: {},
        emptied_groups: [],
        rebuild_required_due_to_cross_group_dedupe: false
      },
      duplicateQueryBlocked: finalizedCandidate.duplicateBlocked === true,
      duplicateOfQueryVersionId: finalizedCandidate.duplicateOfQueryVersionId || "",
      avoidQueryVersionIds: historyContext.lowQualityQueryVersionIds,
      keepDirectionQueryVersionIds: historyContext.goodQualityQueryVersionIds,
      preferredQueryVersionIds: historyContext.preferredQueryVersionIds,
      avoidQueryFingerprints: historyContext.avoidQueryFingerprints || [],
      avoidSemanticQueryFingerprints: historyContext.avoidSemanticQueryFingerprints || [],
      targetCountRange: normalizedCountContext.targetCountRange,
      softTargetRange: normalizedCountContext.softTargetRange,
      currentResultCount: normalizedCountContext.currentResultCount,
      previousResultCount: normalizedCountContext.previousResultCount,
      countSource: normalizedCountContext.countSource,
      countBucket: normalizedCountContext.countBucket,
      countDistanceScore: normalizedCountContext.countDistanceScore,
      reductionRatio: normalizedCountContext.reductionRatio,
      repeatReasonSignature: normalizedCountContext.repeatReasonSignature,
      repeatReasonCount: normalizedCountContext.repeatReasonCount,
      escalationFamily: plannerMetaWithDedupe?.escalationFamily || "",
      groupBudget: plannerMetaWithDedupe?.groupBudget || null
    }
  };
}


export async function manualGateRefineQuery({
  claimText,
  features,
  currentVersion,
  queryVersions,
  iterations,
  feedbackLog,
  decision,
  countContext = null,
  repeatCount = 1,
  skipLlm = false,
  corpusDecision = null,
  modelName,
  onLog,
  settings = null,
  _retryAttempt = 1,
  _duplicateRetryHint = null
}) {
  const featureIds = (Array.isArray(features) ? features : []).map((feature) => feature.id);
  const historyContext = buildQueryHistoryContext(queryVersions, iterations, feedbackLog);
  const feedbackActions = [];
  const gate = buildManualGateFeedback(decision, repeatCount);
  let featureActions = [];
  let llmNotes = "";
  let finalTermsByFeature = {};
  let refineHints = {
    promoteFeatureIds: [],
    dropFeatureIds: [],
    dephraseTerms: [],
    dropGroupIds: [],
    splitFeaturePlans: [],
    antiNoiseTerms: [],
    countStrategyNote: "",
    rebuildRequired: false,
    explicitFinalTermsByFeature: {}
  };
  let workingTermsByFeature = JSON.parse(JSON.stringify(currentVersion?.termsByFeature || {}));
  let workingQueryPlan = normalizeQueryPlan({
    queryPlan: currentVersion?.queryPlan || null,
    features,
    termsByFeature: workingTermsByFeature,
    featureStateById: currentVersion?.featureStateById || {}
  });

  const enabledFeatureIds = (Array.isArray(features) ? features : [])
    .map((feature) => toUpperId(feature?.id))
    .filter((id) => id && currentVersion?.featureStateById?.[id]?.enabled !== false);

  const summary = {
    resultCount: null,
    topScore: null,
    coverage: null,
    singleHit: false,
    pairHit: false,
    manualGate: {
      decision: String(decision || "").trim(),
      desiredMode: gate.desiredMode,
      repeatCount: gate.level,
      intensity: gate.intensity
    }
  };
  const normalizedCountContext = normalizeCountContext({
    countContext,
    iterations,
    summary
  });
  const signals = { addCandidates: [], removeCandidates: [] };
  const corpusSummary = {
    totalRows: 0,
    scoredRows: 0,
    scoreDistribution: { high: 0, support: 0, mid: 0, low: 0 },
    topScore: null,
    coverage: null,
    featureStats: enabledFeatureIds.map((featureId) => ({
      featureId,
      featureText: clipText((features.find((feature) => toUpperId(feature?.id) === featureId)?.text || ""), 140),
      hitCount: 0,
      missingCount: 0,
      hitRatio: 0,
      missingRatio: 1
    })),
    reinforceFeatures: enabledFeatureIds.slice(0, 4),
    alreadyCoveredFeatures: [],
    representativeDocs: { high: [], low: [] },
    reasonSamples: [],
    termSignals: { addCandidates: [], removeCandidates: [] },
    manualGateOnly: true,
    count: {
      targetCountRange: normalizedCountContext.targetCountRange,
      softTargetRange: normalizedCountContext.softTargetRange,
      currentResultCount: normalizedCountContext.currentResultCount,
      previousResultCount: normalizedCountContext.previousResultCount,
      countSource: normalizedCountContext.countSource,
      countBucket: normalizedCountContext.countBucket,
      countDistanceScore: normalizedCountContext.countDistanceScore,
      reductionRatio: normalizedCountContext.reductionRatio,
      repeatReasonSignature: normalizedCountContext.repeatReasonSignature,
      repeatReasonCount: normalizedCountContext.repeatReasonCount
    }
  };

  if (hasUnmappedQueryPlanGroups(workingQueryPlan)) {
    const remapped = await remapUnmappedQueryPlanWithLlm({
      claimText,
      features,
      expression: currentVersion?.expression || "",
      queryPlan: workingQueryPlan,
      termsByFeature: workingTermsByFeature,
      featureStateById: currentVersion?.featureStateById || {},
      modelName,
      onLog,
      settings
    });
    if (remapped.applied) {
      workingQueryPlan = remapped.queryPlan;
      workingTermsByFeature = remapped.termsByFeature;
      feedbackActions.push(`query_plan_remap: ${Array.isArray(remapped.mappedGroupIds) ? remapped.mappedGroupIds.length : 0} group(s) remapped`);
      if (remapped.notes) feedbackActions.push(`query_plan_remap_note: ${clipText(remapped.notes, 120)}`);
    } else {
      feedbackActions.push("query_plan_remap: pending/unresolved");
    }
  }

  if (!skipLlm) {
    try {
      const refineContext = buildCompactRefineContext({
        features,
        currentVersion,
        workingQueryPlan,
        workingTermsByFeature,
        featureStateById: currentVersion?.featureStateById || {},
        summary,
        signals,
        corpusSummary,
        normalizedCountContext,
        historyContext,
        manualGate: {
          decision: String(decision || "").trim(),
          desired_mode: gate.desiredMode,
          repeat_count: gate.level,
          intensity: gate.intensity,
          instruction: gate.instruction
        },
        duplicateRetryHint: _duplicateRetryHint
      });
      const result = await requestStructuredJson("query_refine", {
        claim_text: claimText,
        refine_context_json: JSON.stringify(refineContext)
      }, {
        modelName,
        onLog,
        settings
      });

      const normalized = normalizeQueryRefine(result.parsed, featureIds);
      featureActions = normalized.featureActions;
      finalTermsByFeature = normalized.finalTermsByFeature || {};
      llmNotes = normalized.notes;
      if (String(normalized.queryExpression || "").trim()) {
        feedbackActions.push("llm_query_expression: ignored (deterministic builder policy)");
      }
      refineHints = {
        promoteFeatureIds: normalized.promoteFeatureIds || [],
        dropFeatureIds: normalized.dropFeatureIds || [],
        dephraseTerms: normalized.dephraseTerms || [],
        dropGroupIds: normalized.dropGroupIds || [],
        splitFeaturePlans: normalized.splitFeaturePlans || [],
        antiNoiseTerms: normalized.antiNoiseTerms || [],
        countStrategyNote: normalized.countStrategyNote || "",
        rebuildRequired: normalized.rebuildRequired === true,
        explicitFinalTermsByFeature: normalized.finalTermsByFeature || {}
      };
    } catch (error) {
      onLog?.(`manual query_refine fallback: ${error?.message || String(error)}`);
    }
  }

  let planSeedTerms = JSON.parse(JSON.stringify(workingTermsByFeature || {}));
  let planSeedState = JSON.parse(JSON.stringify(currentVersion.featureStateById || {}));
  let planSeedQueryPlan = normalizeQueryPlan({
    queryPlan: workingQueryPlan,
    features,
    termsByFeature: planSeedTerms,
    featureStateById: planSeedState
  });

  if (finalTermsByFeature && typeof finalTermsByFeature === "object") {
    Object.entries(finalTermsByFeature).forEach(([featureIdRaw, terms]) => {
      const featureId = toUpperId(featureIdRaw);
      if (!featureId) return;
      const normalized = normalizeAtomicTermList(terms, { allowLockedBigrams: false }).slice(0, 2);
      if (!normalized.length) return;
      planSeedTerms[featureId] = normalized;
    });
    feedbackActions.push("llm_final_terms_by_feature: applied");
  }

  const lexicalPlanSeed = enforceAtomicTermsByFeature(planSeedTerms, {}, {
    allowLockedBigrams: false
  });
  if (Array.isArray(lexicalPlanSeed.violations) && lexicalPlanSeed.violations.length > 0) {
    onLog?.(`lexical normalize(manual): ${summarizeLexicalViolations(lexicalPlanSeed.violations)}`);
  }
  planSeedTerms = ensureTermsByFeature(lexicalPlanSeed.termsByFeature, features);

  const defaultDecision = decision === "too_many"
    ? "noise_cluster_dominant"
    : (decision === "too_few" ? "gap_feature_missing_everywhere" : "restart_direction");
  const explicitCorpusDecision = {
    ...(corpusDecision && typeof corpusDecision === "object" ? corpusDecision : {}),
    decision: String(
      (corpusDecision && typeof corpusDecision === "object" && corpusDecision.decision) || defaultDecision
    ).trim(),
    saturatedFeatureIds: decision === "too_many"
      ? enabledFeatureIds
      : (corpusDecision?.saturatedFeatureIds || corpusDecision?.saturated_feature_ids || []),
    gapFeatureIds: decision === "too_few"
      ? enabledFeatureIds
      : (corpusDecision?.gapFeatureIds || corpusDecision?.gap_feature_ids || [])
  };
  const envelope = buildCorpusDecisionEnvelope({
    features,
    summary,
    corpusSummary,
    signals,
    historyContext,
    requestedMode: gate.desiredMode,
    explicitDecision: explicitCorpusDecision,
    countContext: normalizedCountContext
  });

  const planned = planQueryAdjustment(
    decision,
    envelope,
    Math.max(gate.level, Number(normalizedCountContext.repeatReasonCount || 1)),
    {
    features,
    currentExpression: currentVersion?.expression || "",
    expression: currentVersion?.expression || "",
    queryPlan: planSeedQueryPlan || currentVersion?.queryPlan || null,
    termsByFeature: planSeedTerms,
    seedByFeature: currentVersion?.seedByFeature || {},
    featureStateById: planSeedState,
    modeHint: gate.desiredMode,
    featureActions,
    signals,
    refineHints,
      maxActions: MAX_AUTO_ACTIONS
    }
  );

  const plannedTermPolicy = buildTermPolicyFromPlannedResult(planned, features);
  const plannedTermsByFeature = applyModeTermCapToFeatureTerms({
    features,
    termsByFeature: planned.termsByFeature,
    policy: plannedTermPolicy
  });

  let materialized = dedupeAndMaterializeQuery({
    queryPlan: planned.queryPlan,
    features,
    termsByFeature: plannedTermsByFeature,
    featureStateById: planned.featureStateById,
    ...plannedTermPolicy
  });
  const plannerMetaWithDedupe = enrichPlannerMetaWithCrossGroupDedupe(
    planned?.plannerMeta || {},
    materialized.crossGroupDedupeMeta || {}
  );
  let candidateExpression = String(materialized.expression || "").trim();
  const hasStructuredLlmSignals = (
    (Array.isArray(featureActions) && featureActions.length > 0)
    || Object.keys(finalTermsByFeature || {}).length > 0
  );
  let expressionChanged = normalizeQueryExpressionText(candidateExpression)
    !== normalizeQueryExpressionText(currentVersion?.expression || "");

  if (!expressionChanged && hasStructuredLlmSignals) {
    const forced = ensureRefinedExpressionChanged({
      currentExpression: currentVersion?.expression || "",
      mode: planned.mode || gate.desiredMode,
      features,
      termsByFeature: materialized.termsByFeature,
      featureStateById: planned.featureStateById,
      feedbackActions
    });
    const forcedChanged = normalizeQueryExpressionText(forced.expression)
      !== normalizeQueryExpressionText(currentVersion?.expression || "");
    if (forcedChanged) {
      materialized = dedupeAndMaterializeQuery({
        queryPlan: planned.queryPlan,
        features,
        termsByFeature: forced.termsByFeature,
        featureStateById: forced.featureStateById,
        ...plannedTermPolicy
      });
      candidateExpression = String(materialized.expression || "").trim();
      expressionChanged = normalizeQueryExpressionText(candidateExpression)
        !== normalizeQueryExpressionText(currentVersion?.expression || "");
    }
  }

  const effectivePlannerMeta = {
    ...(plannerMetaWithDedupe || {}),
    expressionChanged
  };

  if (!expressionChanged) {
    return {
      noChange: true,
      mode: planned.mode || gate.desiredMode,
      notes: llmNotes || `Manual gate planner (${gate.intensity})`,
      plannerMeta: effectivePlannerMeta,
      duplicateBlocked: false,
      feedbackActions: uniqueStrings([
        `manual_gate_feedback: ${gate.intensity} (repeat=${gate.level})`,
        ...feedbackActions,
        ...(planned.feedbackActions || []),
        ...(Array.isArray(materialized?.crossGroupDedupeMeta?.duplicate_terms_removed) && materialized.crossGroupDedupeMeta.duplicate_terms_removed.length
          ? [`cross_group_dedupe_removed=${materialized.crossGroupDedupeMeta.duplicate_terms_removed.length}`]
          : []),
        "no_change_guard: skip new query version"
      ]).slice(0, 40)
    };
  }

  const resolved = resolveDuplicateCandidate({
    candidate: {
      expression: candidateExpression,
      queryPlan: materialized.queryPlan,
      termsByFeature: materialized.termsByFeature,
      featureStateById: planned.featureStateById,
      crossGroupDedupeMeta: materialized.crossGroupDedupeMeta || {}
    },
    mode: planned.mode || gate.desiredMode,
    features,
    queryVersions,
    currentVersion,
    seedByFeature: currentVersion?.seedByFeature || {},
    plannerMeta: plannerMetaWithDedupe
  });

  if (resolved?.stillDuplicate) {
    if (shouldRetryDuplicateRefine({
      stillDuplicate: true,
      skipLlm,
      retryAttempt: _retryAttempt,
      maxAttempts: REFINE_DUPLICATE_RETRY_MAX
    })) {
      const retryAttempt = Math.max(2, Number(_retryAttempt) + 1);
      const retryHint = buildDuplicateRetryHintPayload({
        resolved,
        historyContext,
        retryAttempt
      });
      onLog?.(`manual query_refine duplicate retry(${retryAttempt})`);
      const retried = await manualGateRefineQuery({
        claimText,
        features,
        currentVersion,
        queryVersions,
        iterations,
        feedbackLog,
        decision,
        countContext: normalizedCountContext,
        repeatCount,
        skipLlm,
        corpusDecision,
        modelName,
        onLog,
        _retryAttempt: retryAttempt,
        _duplicateRetryHint: retryHint
      });
      if (retried && typeof retried === "object") {
        retried.feedbackActions = uniqueStrings([
          `manual_duplicate_retry: attempt=${retryAttempt}`,
          ...(retried.feedbackActions || [])
        ]).slice(0, 50);
      }
      return retried;
    }
    return {
      noChange: true,
      mode: planned.mode || gate.desiredMode,
      notes: llmNotes || `Manual gate planner (${gate.intensity})`,
      plannerMeta: effectivePlannerMeta,
      duplicateBlocked: true,
      duplicateOfQueryVersionId: resolved?.duplicateInfo?.duplicateOfQueryVersionId || "",
      feedbackActions: uniqueStrings([
        `manual_gate_feedback: ${gate.intensity} (repeat=${gate.level})`,
        ...feedbackActions,
        ...(planned.feedbackActions || []),
        ...(resolved?.correctiveActions || []),
        `duplicate_query_blocked: duplicate_of=${resolved?.duplicateInfo?.duplicateOfQueryVersionId || "unknown"}`,
        "no_change_guard: duplicate fingerprint persisted"
      ]).slice(0, 50)
    };
  }

  const finalizedCandidate = resolved?.candidate || {
    expression: candidateExpression,
    queryPlan: materialized.queryPlan,
    termsByFeature: materialized.termsByFeature,
    featureStateById: planned.featureStateById,
    ...buildVersionFingerprints({
      queryPlan: materialized.queryPlan,
      termsByFeature: materialized.termsByFeature,
      featureStateById: planned.featureStateById
    }),
    duplicateOfQueryVersionId: null,
    duplicateBlocked: false
  };

  const mergedFeedbackActions = uniqueStrings([
    `manual_gate_feedback: ${gate.intensity} (repeat=${gate.level})`,
    ...feedbackActions,
    ...(planned.feedbackActions || []),
    ...(resolved?.correctiveActions || []),
    ...(finalizedCandidate?.duplicateBlocked
      ? [
        `duplicate_query_blocked: duplicate_of=${finalizedCandidate.duplicateOfQueryVersionId || "unknown"}`,
        `duplicate_query_blocked: reason=${resolved?.duplicateInfo?.reason || "fingerprint conflict"}`
      ]
      : []),
    ...(Array.isArray(finalizedCandidate?.crossGroupDedupeMeta?.duplicate_terms_removed) && finalizedCandidate.crossGroupDedupeMeta.duplicate_terms_removed.length
      ? [`cross_group_dedupe_removed=${finalizedCandidate.crossGroupDedupeMeta.duplicate_terms_removed.length}`]
      : [])
  ]).slice(0, 50);
  const manualNextQueryRationale = uniqueStrings([
    `mode=${planned.mode || gate.desiredMode}`,
    `decision=${plannerMetaWithDedupe?.decision || envelope.decision || gate.desiredMode}`,
    `manual_decision=${String(decision || "").trim() || "unknown"}`,
    `saturated=${(envelope.saturatedFeatureIds || []).length}`,
    `gaps=${(envelope.gapFeatureIds || []).length}`
  ]).join(" | ");

  return {
    queryVersionId: makeQueryVersionId(),
    createdAt: nowIso(),
    source: skipLlm ? "manual_count_gate" : "manual_count_gate_llm",
    refineMode: planned.mode || gate.desiredMode,
    notes: llmNotes || `Manual gate planner (${gate.intensity})`,
    expression: String(finalizedCandidate.expression || "").trim(),
    queryPlan: finalizedCandidate.queryPlan,
    termsByFeature: finalizedCandidate.termsByFeature,
    seedByFeature: currentVersion?.seedByFeature || {},
    featureStateById: finalizedCandidate.featureStateById,
    fingerprint: finalizedCandidate.fingerprint || "",
    semanticFingerprint: finalizedCandidate.semanticFingerprint || "",
    activeTermsFingerprint: finalizedCandidate.activeTermsFingerprint || "",
    activeTerms: finalizedCandidate.activeTerms || [],
    duplicateOfQueryVersionId: finalizedCandidate.duplicateOfQueryVersionId || null,
    duplicateBlocked: finalizedCandidate.duplicateBlocked === true,
    recentEscalationFamilies: uniqueStrings([
      ...(Array.isArray(currentVersion?.recentEscalationFamilies) ? currentVersion.recentEscalationFamilies : []),
      plannerMetaWithDedupe?.escalationFamily || ""
    ]).slice(-4),
    historyWeight: 1,
    targetCountRange: normalizedCountContext.targetCountRange,
    softTargetRange: normalizedCountContext.softTargetRange,
    currentResultCount: normalizedCountContext.currentResultCount,
    previousResultCount: normalizedCountContext.previousResultCount,
    countSource: normalizedCountContext.countSource,
    countBucket: normalizedCountContext.countBucket,
    countDistanceScore: normalizedCountContext.countDistanceScore,
    reductionRatio: normalizedCountContext.reductionRatio,
    repeatReasonSignature: normalizedCountContext.repeatReasonSignature,
    repeatReasonCount: normalizedCountContext.repeatReasonCount,
    feedbackActions: mergedFeedbackActions,
    feedbackBasis: {
      manualGateDecision: String(decision || "").trim(),
      manualGateIntensity: gate.intensity,
      manualGateRepeatCount: gate.level,
      saturatedFeatureIds: envelope.saturatedFeatureIds,
      gapFeatureIds: envelope.gapFeatureIds,
      noisyTermsByFeature: envelope.noisyTermsByFeature,
      plannerDecision: plannerMetaWithDedupe?.decision || envelope.decision || "",
      nextQueryRationale: manualNextQueryRationale,
      changedGroupIds: plannerMetaWithDedupe?.changedGroupIds || [],
      promotedFeatureId: plannerMetaWithDedupe?.promotedFeatureId || "",
      droppedFeatureId: plannerMetaWithDedupe?.droppedFeatureId || "",
      dephrasedTerms: plannerMetaWithDedupe?.dephrasedTerms || [],
      simplificationApplied: plannerMetaWithDedupe?.simplificationApplied === true,
      focusFeatureId: plannerMetaWithDedupe?.focusFeatureId || "",
      activeGroupIds: plannerMetaWithDedupe?.activeGroupIds || [],
      inactiveGroupIds: plannerMetaWithDedupe?.inactiveGroupIds || [],
      expressionChanged: true,
      crossGroupDedupe: plannerMetaWithDedupe?.crossGroupDedupe || {
        duplicate_terms_removed: [],
        term_owner_by_group: {},
        emptied_groups: [],
        rebuild_required_due_to_cross_group_dedupe: false
      },
      duplicateQueryBlocked: finalizedCandidate.duplicateBlocked === true,
      duplicateOfQueryVersionId: finalizedCandidate.duplicateOfQueryVersionId || "",
      avoidQueryVersionIds: historyContext.lowQualityQueryVersionIds,
      keepDirectionQueryVersionIds: historyContext.goodQualityQueryVersionIds,
      preferredQueryVersionIds: historyContext.preferredQueryVersionIds,
      avoidQueryFingerprints: historyContext.avoidQueryFingerprints || [],
      avoidSemanticQueryFingerprints: historyContext.avoidSemanticQueryFingerprints || [],
      targetCountRange: normalizedCountContext.targetCountRange,
      softTargetRange: normalizedCountContext.softTargetRange,
      currentResultCount: normalizedCountContext.currentResultCount,
      previousResultCount: normalizedCountContext.previousResultCount,
      countSource: normalizedCountContext.countSource,
      countBucket: normalizedCountContext.countBucket,
      countDistanceScore: normalizedCountContext.countDistanceScore,
      reductionRatio: normalizedCountContext.reductionRatio,
      repeatReasonSignature: normalizedCountContext.repeatReasonSignature,
      repeatReasonCount: normalizedCountContext.repeatReasonCount,
      escalationFamily: plannerMetaWithDedupe?.escalationFamily || "",
      groupBudget: plannerMetaWithDedupe?.groupBudget || null
    }
  };
}


export function summarizeIteration({
  evaluations,
  features,
  featureStateById
}) {
  return buildSummary(evaluations, features, featureStateById);
}
