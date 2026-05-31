import { buildExpression, normalizeQueryPlan, normalizeTermsByFeature } from "./query_builder.js";
import {
  buildQueryFingerprint,
  buildSemanticQueryFingerprint,
  buildActiveTermsFingerprint,
  collectActiveCanonicalTerms
} from "./query_fingerprint.js";
import { normalizeModelControls } from "./model_controls.js";

const STORAGE_KEYS = {
  sessions: "kresearch_sessions_v1",
  activeSessionId: "kresearch_active_session_v1",
  evalHistory: "kresearch_eval_history_v1",
  settings: "kresearch_settings_v1"
};

const MAX_EVAL_HISTORY = 120;
const MAX_SESSIONS = 30;
const ALLOWED_SESSION_STATUS = new Set([
  "idle",
  "ready",
  "capturing",
  "evaluating",
  "success",
  "max_iterations",
  "aborted",
  "error"
]);
const ALLOWED_MANUAL_DECISION = new Set([
  "pending",
  "too_many",
  "too_few",
  "proceed"
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || String(fallback ?? "");
}

function asInteger(value, fallback = 0, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function asNumberOrNull(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function normalizeUnitScore(value) {
  const parsed = asNumberOrNull(value);
  if (parsed === null) return null;
  if (parsed > 1 && parsed <= 100) {
    return Math.max(0, Math.min(1, parsed / 100));
  }
  return Math.max(0, Math.min(1, parsed));
}

function uniqueStrings(items) {
  const out = [];
  const seen = new Set();
  asArray(items).forEach((item) => {
    const value = asString(item);
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(value);
  });
  return out;
}

function normalizeJudgmentStatus(value) {
  const raw = asString(value).toLowerCase();
  if (raw === "exact" || raw === "equivalent" || raw === "partial" || raw === "absent" || raw === "conflict") {
    return raw;
  }
  return "absent";
}

function normalizeEvidenceSource(value) {
  const raw = asString(value).toLowerCase();
  if (raw === "claim" || raw === "description" || raw === "title" || raw === "unknown") {
    return raw;
  }
  return "unknown";
}

function normalizeFeatureJudgments(items) {
  return asArray(items)
    .map((entry, index) => {
      if (!isPlainObject(entry)) return null;
      const featureId = normalizeFeatureId(entry.featureId || entry.feature_id, index);
      return {
        featureId,
        status: normalizeJudgmentStatus(entry.status),
        evidenceText: asString(entry.evidenceText || entry.evidence_text),
        evidenceSource: normalizeEvidenceSource(entry.evidenceSource || entry.evidence_source),
        confidence: normalizeUnitScore(entry.confidence) ?? 0.5
      };
    })
    .filter(Boolean);
}

function normalizeFeatureId(value, fallbackIndex = 0) {
  const raw = asString(value, `F${fallbackIndex + 1}`).toUpperCase();
  if (!raw) return `F${fallbackIndex + 1}`;
  return raw.startsWith("F") ? raw : `F${fallbackIndex + 1}`;
}

function normalizeFeatureType(value, fallback = "optional") {
  const raw = asString(value).toLowerCase();
  if (raw === "anchor" || raw === "relation" || raw === "discriminator" || raw === "optional") {
    return raw;
  }
  return fallback;
}

function normalizeQueryRole(value, fallback = "should") {
  const raw = asString(value).toLowerCase();
  if (raw === "must" || raw === "should" || raw === "can_drop") {
    return raw;
  }
  return fallback;
}

function normalizeFeatureWeight(value, fallback = 3) {
  return asInteger(value, fallback, 1, 5);
}

function deriveFeatureRole(raw = {}, index = 0) {
  const explicit = normalizeQueryRole(raw?.query_role || raw?.queryRole, "");
  if (explicit) return explicit;
  if (raw?.core === true) return "must";
  if (raw?.core === false) return "should";
  if (index < 2) return "must";
  return "should";
}

function deriveFeatureType(raw = {}, queryRole = "should") {
  const explicit = normalizeFeatureType(raw?.type, "");
  if (explicit) return explicit;
  if (queryRole === "must") return "anchor";
  if (queryRole === "can_drop") return "optional";
  if (raw?.relation_to || raw?.relationTo) return "relation";
  return "discriminator";
}

function deriveFeatureWeight(raw = {}, queryRole = "should") {
  const fallback = queryRole === "must" ? 5 : (queryRole === "can_drop" ? 2 : 3);
  return normalizeFeatureWeight(raw?.weight, fallback);
}

function normalizeFeatureList(rawFeatures, fallbackFromQueryVersions = []) {
  const out = [];
  const seen = new Set();

  const appendFeature = (raw, index) => {
    const id = normalizeFeatureId(raw?.id, index);
    const text = asString(raw?.text || raw?.description || raw?.feature || "");
    if (!id || !text) return;
    if (seen.has(id)) return;
    seen.add(id);

    const queryRole = deriveFeatureRole(raw, index);
    out.push({
      id,
      text,
      type: deriveFeatureType(raw, queryRole),
      weight: deriveFeatureWeight(raw, queryRole),
      query_role: queryRole,
      relation_to: uniqueStrings(raw?.relation_to || raw?.relationTo)
        .map((featureId) => normalizeFeatureId(featureId))
        .filter((featureId) => featureId && featureId !== id),
      negative: !!raw?.negative
    });
  };

  asArray(rawFeatures).forEach((item, index) => appendFeature(item, index));
  if (out.length > 0) return out;

  asArray(fallbackFromQueryVersions).forEach((item, index) => appendFeature(item, index));
  return out;
}

function deriveFeaturesFromQueryVersions(queryVersions) {
  const out = [];
  const seen = new Set();

  const append = (idRaw, textRaw = "", options = {}) => {
    const id = normalizeFeatureId(idRaw, out.length);
    if (!id || seen.has(id)) return;
    seen.add(id);

    const queryRole = normalizeQueryRole(options?.queryRole, options?.core ? "must" : "should");
    out.push({
      id,
      text: asString(textRaw || id),
      type: normalizeFeatureType(options?.type, queryRole === "must" ? "anchor" : "discriminator"),
      weight: normalizeFeatureWeight(options?.weight, queryRole === "must" ? 5 : 3),
      query_role: queryRole,
      relation_to: uniqueStrings(options?.relationTo || []),
      negative: !!options?.negative
    });
  };

  asArray(queryVersions).forEach((version) => {
    const state = isPlainObject(version?.featureStateById) ? version.featureStateById : {};
    Object.entries(state).forEach(([featureId, entry]) => {
      append(featureId, entry?.text || featureId, {
        core: !!entry?.core,
        queryRole: entry?.queryRole,
        type: entry?.type,
        weight: entry?.weight,
        relationTo: entry?.relationTo,
        negative: entry?.negative
      });
    });

    const terms = isPlainObject(version?.termsByFeature) ? version.termsByFeature : {};
    Object.keys(terms).forEach((featureId) => append(featureId, featureId, {
      core: false,
      queryRole: "should",
      type: "discriminator",
      weight: 3
    }));

    const queryPlanGroups = Array.isArray(version?.queryPlan?.groups) ? version.queryPlan.groups : [];
    queryPlanGroups.forEach((group) => {
      const featureIds = Array.isArray(group?.feature_ids || group?.featureIds)
        ? (group.feature_ids || group.featureIds)
        : [];
      featureIds.forEach((featureId) => append(featureId, featureId, {
        core: false,
        queryRole: "should",
        type: "discriminator",
        weight: 3
      }));
    });
  });

  return out;
}

function normalizeFeatureStateById(rawState, features, rawTermsByFeature) {
  const out = {};
  const featureMap = new Map(
    asArray(features).map((feature) => [normalizeFeatureId(feature?.id), feature])
  );

  featureMap.forEach((feature, id) => {
    const queryRole = normalizeQueryRole(feature?.query_role, "should");
    const enabled = queryRole !== "can_drop";
    out[id] = {
      enabled,
      active: enabled && queryRole !== "can_drop",
      core: queryRole === "must",
      text: asString(feature?.text || id),
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

  if (isPlainObject(rawState)) {
    Object.entries(rawState).forEach(([featureIdRaw, entry]) => {
      const featureId = normalizeFeatureId(featureIdRaw);
      const base = out[featureId] || {};
      const queryRole = normalizeQueryRole(entry?.queryRole, entry?.core === true ? "must" : (base.queryRole || "should"));
      const enabled = entry?.enabled !== false;
      out[featureId] = {
        enabled,
        active: entry?.active !== false && enabled,
        core: queryRole === "must",
        text: asString(entry?.text || base.text || featureId),
        type: normalizeFeatureType(entry?.type, base.type || (queryRole === "must" ? "anchor" : "optional")),
        weight: normalizeFeatureWeight(entry?.weight, base.weight || (queryRole === "must" ? 5 : 3)),
        queryRole,
        relationTo: uniqueStrings(entry?.relationTo || base.relationTo || []),
        negative: entry?.negative === true || base.negative === true,
        focus: entry?.focus === true || base.focus === true,
        simplified: entry?.simplified === true || base.simplified === true,
        phrase_locked_terms: uniqueStrings(entry?.phrase_locked_terms || entry?.phraseLockedTerms || base.phrase_locked_terms || [])
      };
    });
  }

  if (isPlainObject(rawTermsByFeature)) {
    Object.keys(rawTermsByFeature).forEach((featureIdRaw) => {
      const featureId = normalizeFeatureId(featureIdRaw);
      const base = out[featureId] || {};
      out[featureId] = {
        enabled: base.enabled !== false,
        active: base.active !== false && base.enabled !== false,
        core: !!base.core,
        text: asString(base.text || featureId),
        type: normalizeFeatureType(base.type, base.core ? "anchor" : "optional"),
        weight: normalizeFeatureWeight(base.weight, base.core ? 5 : 3),
        queryRole: normalizeQueryRole(base.queryRole, base.core ? "must" : "should"),
        relationTo: uniqueStrings(base.relationTo || []),
        negative: !!base.negative,
        focus: !!base.focus,
        simplified: !!base.simplified,
        phrase_locked_terms: uniqueStrings(base.phrase_locked_terms || [])
      };
    });
  }

  return out;
}

function normalizeTermsByFeatureLoose(rawTermsByFeature) {
  const out = {};
  if (!isPlainObject(rawTermsByFeature)) return out;

  Object.entries(rawTermsByFeature).forEach(([featureIdRaw, terms]) => {
    const featureId = normalizeFeatureId(featureIdRaw);
    const normalized = uniqueStrings(terms);
    if (!normalized.length) return;
    out[featureId] = normalized;
  });

  return out;
}

function normalizeSeedBucket(entry) {
  const baseTerms = uniqueStrings(entry?.base_terms || entry?.baseTerms || entry?.must_terms || entry?.mustTerms || []);
  const supportTerms = uniqueStrings(entry?.support_terms || entry?.supportTerms || entry?.should_terms || entry?.shouldTerms || []);
  const broadTerms = uniqueStrings(entry?.broad_terms || entry?.broadTerms || []);
  const narrowTerms = uniqueStrings(entry?.narrow_terms || entry?.narrowTerms || []);
  const avoidTerms = uniqueStrings(entry?.avoid_terms || entry?.avoidTerms || []);
  const entityTerms = uniqueStrings(entry?.entity_terms || entry?.entityTerms || []);
  const actionTerms = uniqueStrings(entry?.action_terms || entry?.actionTerms || []);
  const qualifierTerms = uniqueStrings(entry?.qualifier_terms || entry?.qualifierTerms || []);
  const noiseProneTerms = uniqueStrings(entry?.noise_prone_terms || entry?.noiseProneTerms || []);
  const lockedBigrams = uniqueStrings(entry?.locked_bigrams || entry?.lockedBigrams || entry?.exact_phrase_terms || entry?.exactPhraseTerms || []);
  return {
    base_terms: baseTerms,
    support_terms: supportTerms,
    broad_terms: broadTerms,
    narrow_terms: narrowTerms,
    avoid_terms: avoidTerms,
    locked_bigrams: lockedBigrams,
    entity_terms: entityTerms,
    action_terms: actionTerms,
    qualifier_terms: qualifierTerms,
    noise_prone_terms: noiseProneTerms,
    exact_phrase_terms: [],
    must_terms: uniqueStrings(entry?.must_terms || entry?.mustTerms || baseTerms),
    should_terms: uniqueStrings(entry?.should_terms || entry?.shouldTerms || supportTerms)
  };
}

function normalizeSeedByFeature(rawSeedByFeature, features = []) {
  const out = {};
  const allowed = new Set(asArray(features).map((feature) => normalizeFeatureId(feature?.id)));
  if (!isPlainObject(rawSeedByFeature)) return out;

  Object.entries(rawSeedByFeature).forEach(([featureIdRaw, entry]) => {
    const featureId = normalizeFeatureId(featureIdRaw);
    if (!featureId) return;
    if (allowed.size > 0 && !allowed.has(featureId)) return;
    out[featureId] = normalizeSeedBucket(entry);
  });
  return out;
}

function buildVersionFingerprints(versionLike = {}) {
  const queryPlan = versionLike?.queryPlan || { groups: [] };
  const termsByFeature = versionLike?.termsByFeature || {};
  const featureStateById = versionLike?.featureStateById || {};
  return {
    fingerprint: buildQueryFingerprint({ queryPlan, termsByFeature, featureStateById }),
    semanticFingerprint: buildSemanticQueryFingerprint({ queryPlan, termsByFeature, featureStateById }),
    activeTermsFingerprint: buildActiveTermsFingerprint({ queryPlan, termsByFeature, featureStateById }),
    activeTerms: collectActiveCanonicalTerms({ queryPlan, termsByFeature, featureStateById })
  };
}

function buildStoredTermCapPolicy(queryPlan, termsByFeature = {}) {
  const maxTermsPerFeatureByFeatureId = {};
  const setCap = (featureIdRaw, candidateLimit) => {
    const featureId = normalizeFeatureId(featureIdRaw);
    const limit = Math.max(1, Math.min(2, asInteger(candidateLimit, 1, 1, 2)));
    maxTermsPerFeatureByFeatureId[featureId] = Math.max(
      Number(maxTermsPerFeatureByFeatureId[featureId] || 1),
      limit
    );
  };

  asArray(queryPlan?.groups).forEach((group) => {
    const featureIds = asArray(group?.feature_ids || group?.featureIds);
    if (!featureIds.length) return;
    const termCount = uniqueStrings(group?.terms || []).length;
    if (!termCount) return;
    featureIds.forEach((featureId) => setCap(featureId, termCount));
  });

  Object.entries(termsByFeature || {}).forEach(([featureId, terms]) => {
    const termCount = uniqueStrings(terms).length;
    if (termCount >= 2) {
      setCap(featureId, 2);
    }
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

function normalizeQueryVersion(raw, index, features) {
  const base = isPlainObject(raw) ? clone(raw) : {};
  const queryVersionId = asString(base.queryVersionId, `legacy_qv_${index + 1}`);
  const feedbackActions = uniqueStrings(base.feedbackActions).slice(0, 40);
  const featureStateById = normalizeFeatureStateById(base.featureStateById, features, base.termsByFeature);
  const seedByFeature = normalizeSeedByFeature(base.seedByFeature || base.seed_by_feature, features);

  const normalizedTerms = Array.isArray(features) && features.length > 0
    ? normalizeTermsByFeature(base.termsByFeature || {}, features)
    : normalizeTermsByFeatureLoose(base.termsByFeature || {});

  const termsByFeature = { ...normalizedTerms };
  Object.entries(featureStateById).forEach(([featureId, featureState]) => {
    const seed = asString(featureState?.text || "");
    if (!seed) return;
    if (!Array.isArray(termsByFeature[featureId]) || termsByFeature[featureId].length === 0) {
      termsByFeature[featureId] = [seed];
    }
  });

  const storedTermPolicy = buildStoredTermCapPolicy(base.queryPlan || base.query_plan, termsByFeature);
  const queryPlan = normalizeQueryPlan({
    queryPlan: base.queryPlan || base.query_plan,
    features: asArray(features),
    termsByFeature,
    featureStateById,
    ...storedTermPolicy
  });
  (Array.isArray(queryPlan?.groups) ? queryPlan.groups : []).forEach((group) => {
    const groupTerms = uniqueStrings(group?.terms || []);
    if (!groupTerms.length) return;
    const featureIds = Array.isArray(group?.feature_ids || group?.featureIds)
      ? (group.feature_ids || group.featureIds)
      : [];
    featureIds.forEach((featureIdRaw) => {
      const featureId = normalizeFeatureId(featureIdRaw);
      if (!featureId) return;
      if (Array.isArray(termsByFeature[featureId]) && termsByFeature[featureId].length > 0) return;
      termsByFeature[featureId] = groupTerms.slice(0, 8);
    });
  });
  let expression = asString(base.expression);
  if (!expression) {
    expression = buildExpression({
      queryPlan,
      features: asArray(features),
      termsByFeature,
      featureStateById,
      ...storedTermPolicy
    });
  }
  const fingerprints = buildVersionFingerprints({
    queryPlan,
    termsByFeature,
    featureStateById
  });
  const feedbackBasis = isPlainObject(base.feedbackBasis) ? clone(base.feedbackBasis) : {};
  if (!isPlainObject(feedbackBasis.crossGroupDedupe)) {
    feedbackBasis.crossGroupDedupe = {
      duplicate_terms_removed: [],
      term_owner_by_group: {},
      emptied_groups: [],
      rebuild_required_due_to_cross_group_dedupe: false
    };
  }
  const targetCountRange = Array.isArray(base.targetCountRange)
    ? [asInteger(base.targetCountRange[0], 0, 0), asInteger(base.targetCountRange[1], 300, 0)]
    : [0, 300];
  const softTargetRange = Array.isArray(base.softTargetRange)
    ? [asInteger(base.softTargetRange[0], 50, 0), asInteger(base.softTargetRange[1], 180, 0)]
    : [50, 180];
  if (softTargetRange[1] < softTargetRange[0]) {
    softTargetRange[1] = softTargetRange[0];
  }
  if (targetCountRange[1] < targetCountRange[0]) {
    targetCountRange[1] = targetCountRange[0];
  }

  return {
    ...base,
    queryVersionId,
    createdAt: asString(base.createdAt),
    source: asString(base.source, "legacy"),
    historyWeight: asInteger(base.historyWeight, 1, 1, 5),
    expression,
    queryPlan,
    termsByFeature,
    seedByFeature,
    featureStateById,
    refineMode: asString(base.refineMode),
    notes: asString(base.notes),
    feedbackActions,
    feedbackBasis,
    fingerprint: asString(base.fingerprint, fingerprints.fingerprint),
    semanticFingerprint: asString(base.semanticFingerprint, fingerprints.semanticFingerprint),
    activeTermsFingerprint: asString(base.activeTermsFingerprint, fingerprints.activeTermsFingerprint),
    activeTerms: uniqueStrings(base.activeTerms || fingerprints.activeTerms),
    duplicateOfQueryVersionId: asString(base.duplicateOfQueryVersionId) || null,
    duplicateBlocked: !!base.duplicateBlocked,
    recentEscalationFamilies: uniqueStrings(base.recentEscalationFamilies).slice(-6),
    targetCountRange,
    softTargetRange,
    currentResultCount: asNumberOrNull(base.currentResultCount),
    previousResultCount: asNumberOrNull(base.previousResultCount),
    countSource: asString(base.countSource, "unknown"),
    countBucket: asString(base.countBucket, "unknown"),
    countDistanceScore: asNumberOrNull(base.countDistanceScore),
    reductionRatio: asNumberOrNull(base.reductionRatio),
    repeatReasonSignature: asString(base.repeatReasonSignature),
    repeatReasonCount: asInteger(base.repeatReasonCount, 1, 1)
  };
}

function normalizeQueryVersionList(rawQueryVersions, features) {
  return asArray(rawQueryVersions)
    .map((entry, index) => normalizeQueryVersion(entry, index, features))
    .filter((entry) => asString(entry.queryVersionId) !== "");
}

function normalizeSummary(rawSummary) {
  if (!isPlainObject(rawSummary)) return null;
  const base = clone(rawSummary);
  return {
    ...base,
    resultCount: asInteger(base.resultCount, 0, 0),
    topScore: asNumberOrNull(base.topScore),
    coverage: asNumberOrNull(base.coverage),
    singleHit: !!base.singleHit,
    pairHit: !!base.pairHit
  };
}

function normalizeIterationRecord(rawRecord, index) {
  const base = isPlainObject(rawRecord) ? clone(rawRecord) : {};
  const targetCountRange = Array.isArray(base.targetCountRange)
    ? [asInteger(base.targetCountRange[0], 0, 0), asInteger(base.targetCountRange[1], 300, 0)]
    : [0, 300];
  const softTargetRange = Array.isArray(base.softTargetRange)
    ? [asInteger(base.softTargetRange[0], 50, 0), asInteger(base.softTargetRange[1], 180, 0)]
    : [50, 180];
  if (targetCountRange[1] < targetCountRange[0]) {
    targetCountRange[1] = targetCountRange[0];
  }
  if (softTargetRange[1] < softTargetRange[0]) {
    softTargetRange[1] = softTargetRange[0];
  }
  return {
    ...base,
    iterationNo: asInteger(base.iterationNo ?? base.iteration_no, index + 1, 1),
    queryVersionId: asString(base.queryVersionId || base.query_version_id),
    runId: asString(base.runId),
    queryExpression: asString(base.queryExpression || base.query_expression),
    resultCount: asInteger(base.resultCount ?? base.result_count, 0, 0),
    topScore: asNumberOrNull(base.topScore ?? base.top_score),
    singleHit: !!base.singleHit,
    pairHit: !!base.pairHit,
    coverage: asNumberOrNull(base.coverage) ?? 0,
    targetCountRange,
    softTargetRange,
    currentResultCount: asNumberOrNull(base.currentResultCount ?? base.current_result_count),
    previousResultCount: asNumberOrNull(base.previousResultCount ?? base.previous_result_count),
    countSource: asString(base.countSource || base.count_source, "unknown"),
    countBucket: asString(base.countBucket || base.count_bucket, "unknown"),
    countDistanceScore: asNumberOrNull(base.countDistanceScore ?? base.count_distance_score),
    reductionRatio: asNumberOrNull(base.reductionRatio ?? base.reduction_ratio),
    repeatReasonSignature: asString(base.repeatReasonSignature || base.repeat_reason_signature),
    repeatReasonCount: asInteger(base.repeatReasonCount ?? base.repeat_reason_count, 1, 1),
    feedbackActions: uniqueStrings(base.feedbackActions).slice(0, 40),
    invalidOutputCount: asInteger(base.invalidOutputCount, 0, 0),
    createdAt: asString(base.createdAt)
  };
}

function normalizeEvalMap(rawMap) {
  if (!isPlainObject(rawMap)) return {};
  const out = {};
  Object.entries(rawMap).forEach(([keyRaw, valueRaw]) => {
    const key = asString(keyRaw);
    if (!key || !isPlainObject(valueRaw)) return;
    const value = clone(valueRaw);
    out[key] = {
      ...value,
      resultId: asString(value.resultId || key),
      applicationNo: asString(value.applicationNo),
      runId: asString(value.runId),
      queryVersionId: asString(value.queryVersionId),
      score: asNumberOrNull(value.score),
      reason: asString(value.reason),
      featureJudgments: normalizeFeatureJudgments(value.featureJudgments || value.feature_judgments),
      featureHits: uniqueStrings(value.featureHits || value.feature_hits).map((id) => normalizeFeatureId(id)),
      missingFeatures: uniqueStrings(value.missingFeatures || value.missing_features).map((id) => normalizeFeatureId(id)),
      noisyTerms: uniqueStrings(value.noisyTerms || value.noisy_terms),
      fieldSimilarity: normalizeUnitScore(value.fieldSimilarity ?? value.field_similarity),
      pairFillValue: normalizeUnitScore(value.pairFillValue ?? value.pair_fill_value),
      conflictFlags: uniqueStrings(value.conflictFlags || value.conflict_flags)
    };
  });
  return out;
}

function normalizeLiveEval(rawLiveEval) {
  const base = isPlainObject(rawLiveEval) ? clone(rawLiveEval) : {};
  return {
    evaluatedById: normalizeEvalMap(base.evaluatedById),
    invalidById: normalizeEvalMap(base.invalidById),
    lastFetchedCount: asInteger(base.lastFetchedCount, 0, 0),
    lastSyncedAt: asString(base.lastSyncedAt)
  };
}

function normalizePendingCapture(rawPendingCapture) {
  if (!isPlainObject(rawPendingCapture)) return null;
  const base = clone(rawPendingCapture);
  const tabIdNum = Number(base.tabId);
  const tabId = Number.isInteger(tabIdNum) ? tabIdNum : null;
  const runId = asString(base.runId);
  const queryVersionId = asString(base.queryVersionId);
  if (!tabId && !runId && !queryVersionId) return null;

  const manualDecision = asString(base.manualDecision, "pending");
  return {
    ...base,
    tabId,
    runId,
    queryVersionId,
    startedAt: asString(base.startedAt),
    manualDecision: ALLOWED_MANUAL_DECISION.has(manualDecision) ? manualDecision : "pending",
    liveEval: normalizeLiveEval(base.liveEval)
  };
}

function normalizeFeedbackLog(rawFeedbackLog) {
  return asArray(rawFeedbackLog)
    .map((entry) => {
      if (!isPlainObject(entry)) return null;
      return {
        at: asString(entry.at),
        text: asString(entry.text)
      };
    })
    .filter((entry) => entry && entry.text)
    .slice(0, 200);
}

function normalizeSession(rawSession, index) {
  const base = isPlainObject(rawSession) ? clone(rawSession) : {};
  const sessionId = asString(base.sessionId, `legacy_session_${index + 1}`);

  const preliminaryVersions = normalizeQueryVersionList(base.queryVersions, []);
  const fallbackFeatures = deriveFeaturesFromQueryVersions(preliminaryVersions);
  const features = normalizeFeatureList(base.features, fallbackFeatures);
  const queryVersions = normalizeQueryVersionList(base.queryVersions, features);

  const currentCandidate = asString(base.currentQueryVersionId);
  const currentQueryVersionId = (
    currentCandidate && queryVersions.some((entry) => entry.queryVersionId === currentCandidate)
  )
    ? currentCandidate
    : asString(queryVersions[queryVersions.length - 1]?.queryVersionId);

  const pendingCapture = normalizePendingCapture(base.pendingCapture);
  let status = asString(base.status, "idle");
  if (!ALLOWED_SESSION_STATUS.has(status)) {
    status = pendingCapture ? "capturing" : (queryVersions.length > 0 ? "ready" : "idle");
  }
  if (!pendingCapture && status === "capturing") {
    status = queryVersions.length > 0 ? "ready" : "idle";
  }

  const iterations = asArray(base.iterations)
    .map((entry, iterIndex) => normalizeIterationRecord(entry, iterIndex));
  const iterationCountDefault = iterations.length;
  const iterationCount = asInteger(base.iterationCount, iterationCountDefault, 0);

  return {
    ...base,
    sessionId,
    claimText: asString(base.claimText),
    status,
    iterationCount,
    currentQueryVersionId,
    createdAt: asString(base.createdAt),
    updatedAt: asString(base.updatedAt),
    features,
    queryVersions,
    iterations,
    pendingCapture,
    lastSummary: normalizeSummary(base.lastSummary),
    summaryReport: asString(base.summaryReport),
    feedbackLog: normalizeFeedbackLog(base.feedbackLog)
  };
}

function normalizeEvaluationRow(rawRow, index = 0) {
  const base = isPlainObject(rawRow) ? clone(rawRow) : {};
  const resultId = asString(base.resultId || base.id, `eval_${index + 1}`);
  return {
    ...base,
    resultId,
    id: asString(base.id || resultId),
    applicationNo: asString(base.applicationNo),
    runId: asString(base.runId),
    queryVersionId: asString(base.queryVersionId),
    score: asNumberOrNull(base.score),
    reason: asString(base.reason),
    featureJudgments: normalizeFeatureJudgments(base.featureJudgments || base.feature_judgments),
    featureHits: uniqueStrings(base.featureHits || base.feature_hits).map((id) => normalizeFeatureId(id)),
    missingFeatures: uniqueStrings(base.missingFeatures || base.missing_features).map((id) => normalizeFeatureId(id)),
    noisyTerms: uniqueStrings(base.noisyTerms || base.noisy_terms),
    fieldSimilarity: normalizeUnitScore(base.fieldSimilarity ?? base.field_similarity),
    pairFillValue: normalizeUnitScore(base.pairFillValue ?? base.pair_fill_value),
    conflictFlags: uniqueStrings(base.conflictFlags || base.conflict_flags),
    addTerms: asArray(base.addTerms),
    removeTerms: asArray(base.removeTerms),
    rawCitationText: asString(base.rawCitationText || base.citationText)
  };
}

function normalizeInvalidOutputRow(rawRow, index = 0) {
  const base = isPlainObject(rawRow) ? clone(rawRow) : {};
  return {
    ...base,
    type: asString(base.type, "invalid_output"),
    resultId: asString(base.resultId || base.id, `invalid_${index + 1}`),
    error: asString(base.error),
    rawText: asString(base.rawText || base.raw || "")
  };
}

function normalizeEvalHistoryEntry(rawEntry, index) {
  const base = isPlainObject(rawEntry) ? clone(rawEntry) : {};
  return {
    ...base,
    sessionId: asString(base.sessionId),
    iterationNo: asInteger(base.iterationNo, index + 1, 1),
    runId: asString(base.runId),
    queryVersionId: asString(base.queryVersionId),
    evaluations: asArray(base.evaluations).map((row, rowIndex) => normalizeEvaluationRow(row, rowIndex)),
    invalidOutputs: asArray(base.invalidOutputs).map((row, rowIndex) => normalizeInvalidOutputRow(row, rowIndex)),
    summary: normalizeSummary(base.summary) || {
      resultCount: asInteger(base.resultCount, 0, 0),
      topScore: asNumberOrNull(base.topScore),
      coverage: asNumberOrNull(base.coverage),
      singleHit: !!base.singleHit,
      pairHit: !!base.pairHit
    },
    createdAt: asString(base.createdAt)
  };
}

function normalizeSettings(rawSettings) {
  const base = isPlainObject(rawSettings) ? clone(rawSettings) : {};
  const querySeedTemperature = asNumberOrNull(base.querySeedTemperature);
  const normalizedMaxIterations = asInteger(base.maxIterations, 15, 1, 50);
  const legacyModelControlShape = {
    globalReasoningEffort: base.globalReasoningEffort,
    perPromptReasoningEffort: base.perPromptReasoningEffort,
    enablePerPromptReasoningEffort: base.enablePerPromptReasoningEffort
  };
  const modelControls = normalizeModelControls(
    isPlainObject(base.modelControls)
      ? base.modelControls
      : legacyModelControlShape
  );
  return {
    ...base,
    // Legacy default(6) is upgraded to 15 unless user later changes it again.
    maxIterations: normalizedMaxIterations === 6 ? 15 : normalizedMaxIterations,
    querySeedTemperature: querySeedTemperature === null
      ? 0
      : Math.max(0, Math.min(0.1, querySeedTemperature)),
    modelControls
  };
}

function normalizeWorkspaceData(rawData) {
  const data = isPlainObject(rawData) ? rawData : {};
  const sessions = asArray(data[STORAGE_KEYS.sessions])
    .map((session, index) => normalizeSession(session, index))
    .filter((session) => asString(session.sessionId) !== "")
    .slice(0, MAX_SESSIONS);

  const activeRaw = asString(data[STORAGE_KEYS.activeSessionId]);
  const activeExists = sessions.some((session) => session.sessionId === activeRaw);
  const activeSessionId = activeExists
    ? activeRaw
    : asString(sessions[0]?.sessionId);

  const evalHistory = asArray(data[STORAGE_KEYS.evalHistory])
    .map((entry, index) => normalizeEvalHistoryEntry(entry, index))
    .slice(0, MAX_EVAL_HISTORY);

  const settings = normalizeSettings(data[STORAGE_KEYS.settings]);

  return {
    sessions,
    activeSessionId,
    evalHistory,
    settings
  };
}

export function getStorageKeys() {
  return { ...STORAGE_KEYS };
}

export function normalizeWorkspacePayload(payload) {
  return normalizeWorkspaceData(payload);
}

export async function loadWorkspace() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.sessions,
    STORAGE_KEYS.activeSessionId,
    STORAGE_KEYS.evalHistory,
    STORAGE_KEYS.settings
  ]);

  return normalizeWorkspaceData(data);
}

export async function saveSessions(sessions, activeSessionId) {
  const normalizedSessions = asArray(sessions)
    .map((entry, index) => normalizeSession(entry, index))
    .slice(0, MAX_SESSIONS);
  const active = asString(activeSessionId);
  const activeExists = normalizedSessions.some((entry) => entry.sessionId === active);
  const normalizedActive = activeExists ? active : asString(normalizedSessions[0]?.sessionId);

  await chrome.storage.local.set({
    [STORAGE_KEYS.sessions]: normalizedSessions,
    [STORAGE_KEYS.activeSessionId]: normalizedActive
  });
}

export async function saveSettings(settings) {
  const normalized = normalizeSettings(settings);
  await chrome.storage.local.set({
    [STORAGE_KEYS.settings]: normalized
  });
}

export async function appendEvalHistory(entry) {
  const normalizedEntry = normalizeEvalHistoryEntry(entry, 0);
  const data = await chrome.storage.local.get([STORAGE_KEYS.evalHistory]);
  const prev = asArray(data[STORAGE_KEYS.evalHistory])
    .map((item, index) => normalizeEvalHistoryEntry(item, index + 1));
  const next = [normalizedEntry, ...prev].slice(0, MAX_EVAL_HISTORY);
  await chrome.storage.local.set({
    [STORAGE_KEYS.evalHistory]: next
  });
}
