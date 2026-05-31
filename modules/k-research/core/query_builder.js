import {
  normalizeAtomicTermList,
  enforceAtomicTermsByFeature
} from "./query_lexical_policy.js";

import {
  canonicalizeGroupTerms,
  findDuplicateTermsAcrossActiveGroups
} from "./query_fingerprint.js";

function extractTermText(term) {
  if (typeof term === "string" || typeof term === "number") {
    return String(term);
  }
  if (term && typeof term === "object") {
    return String(term.text ?? term.term ?? term.value ?? "");
  }
  return "";
}

function sanitizeTerm(term) {
  return extractTermText(term).replace(/"/g, "").replace(/\s+/g, " ").trim();
}

function isPhraseLockedTermEntry(term) {
  if (!term || typeof term !== "object") return false;
  return term.phrase_locked === true || term.phraseLocked === true;
}

function uniqueTerms(items) {
  const seen = new Set();
  const out = [];
  (Array.isArray(items) ? items : []).forEach((item) => {
    const normalized = sanitizeTerm(item);
    if (!normalized || seen.has(normalized.toLowerCase())) return;
    seen.add(normalized.toLowerCase());
    out.push(normalized);
  });
  return out;
}

function normalizeFeatureId(value) {
  return String(value || "").trim().toUpperCase();
}

function cloneDeep(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function normalizeMode(value, fallback = "anchor") {
  const raw = String(value || "").trim().toLowerCase();
  if (
    raw === "anchor"
    || raw === "gap"
    || raw === "support"
    || raw === "micro_entity"
    || raw === "micro_action"
    || raw === "micro_qualifier"
    || raw === "noise_cut"
  ) {
    return raw;
  }
  return fallback;
}

function normalizeGroupRole(value, fallback = "must_and") {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "must_and" || raw === "optional_or" || raw === "qualifier_and") return raw;
  return fallback;
}

function normalizePhraseLockedTerms(items) {
  return uniqueTerms(items);
}

function buildLockedBigramsByFeature(featureStateById = {}) {
  const out = {};
  Object.entries(featureStateById || {}).forEach(([featureIdRaw, state]) => {
    const featureId = normalizeFeatureId(featureIdRaw);
    if (!featureId) return;
    out[featureId] = normalizePhraseLockedTerms(state?.phrase_locked_terms || []);
  });
  return out;
}

function isQuotedPhraseTermEntry(term) {
  if (!term || typeof term !== "object") return false;
  return term.quoted_phrase === true || term.quotedPhrase === true;
}

function renderTerm(term, phraseLockedSet) {
  const normalized = sanitizeTerm(term);
  if (!normalized) return "";
  if (isQuotedPhraseTermEntry(term)) {
    return `"${normalized}"`;
  }
  return normalized;
}

function collectPhraseLockedTermsFromEntries(items) {
  const out = [];
  (Array.isArray(items) ? items : []).forEach((entry) => {
    if (!isPhraseLockedTermEntry(entry)) return;
    const term = sanitizeTerm(entry);
    if (!term) return;
    out.push(term);
  });
  return uniqueTerms(out);
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
  const phraseLockedTerms = [];
  const terms = uniqueTerms(
    splitTopLevelExpression(body, "|").map((raw) => {
      const trimmed = String(raw || "").trim();
      const quoted = /^"(.*)"$/u.exec(trimmed);
      if (quoted) {
        const text = sanitizeTerm(quoted[1]);
        if (text) phraseLockedTerms.push(text);
        return text;
      }
      return sanitizeTerm(trimmed);
    })
  );
  return {
    terms,
    phrase_locked_terms: normalizePhraseLockedTerms(phraseLockedTerms)
  };
}

function tokenizeTerm(term) {
  const normalized = sanitizeTerm(term).toLowerCase();
  if (!normalized) return [];
  const compact = normalized.replace(/\+/g, " ");
  return compact
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function jaccardSimilarity(leftItems, rightItems) {
  const left = new Set(Array.isArray(leftItems) ? leftItems : []);
  const right = new Set(Array.isArray(rightItems) ? rightItems : []);
  if (!left.size && !right.size) return 1;
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  left.forEach((item) => {
    if (right.has(item)) intersection += 1;
  });
  const union = left.size + right.size - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}

function inferRequired(feature, state) {
  if (state?.core === true) return true;
  if (state?.queryRole === "must") return true;
  if (feature?.query_role === "must") return true;
  return false;
}

function inferMode(feature, state, fallback = "anchor") {
  if (state?.negative === true || feature?.negative === true) return "noise_cut";
  if (inferRequired(feature, state)) return "anchor";
  return normalizeMode(state?.mode || feature?.mode, fallback === "noise_cut" ? "noise_cut" : "gap");
}

function inferActive(feature, state, required) {
  if (state?.enabled === false) return false;
  if (typeof state?.active === "boolean") return state.active;
  if (required) return true;
  return true;
}

function resolveFeatureTermLimit({
  featureId,
  maxTermsPerFeature,
  maxTermsPerFeatureByFeatureId,
  allowTwoTermsFeatureIds
} = {}) {
  let limit = Number.isFinite(Number(maxTermsPerFeature)) && Number(maxTermsPerFeature) > 0
    ? Math.round(Number(maxTermsPerFeature))
    : 1;
  const normalizedFeatureId = normalizeFeatureId(featureId);
  const byFeature = maxTermsPerFeatureByFeatureId && typeof maxTermsPerFeatureByFeatureId === "object"
    ? maxTermsPerFeatureByFeatureId
    : {};
  const override = Number(byFeature?.[normalizedFeatureId]);
  if (Number.isFinite(override) && override > 0) {
    limit = Math.round(override);
  }

  const allowTwoSet = new Set(
    (Array.isArray(allowTwoTermsFeatureIds) ? allowTwoTermsFeatureIds : [])
      .map((id) => normalizeFeatureId(id))
      .filter(Boolean)
  );
  if (normalizedFeatureId && allowTwoSet.has(normalizedFeatureId)) {
    limit = Math.max(limit, 2);
  }
  return Math.max(1, limit);
}

function normalizeGroupTerms(
  group,
  firstFeatureId,
  feature,
  state,
  termsByFeature,
  maxTermsPerFeature,
  maxTermsPerFeatureByFeatureId,
  allowTwoTermsFeatureIds
) {
  const lockedBigrams = normalizePhraseLockedTerms([
    ...(group?.phrase_locked_terms || group?.phraseLockedTerms || []),
    ...(state?.phrase_locked_terms || [])
  ]);
  const termLimit = resolveFeatureTermLimit({
    featureId: firstFeatureId,
    maxTermsPerFeature,
    maxTermsPerFeatureByFeatureId,
    allowTwoTermsFeatureIds
  });
  const sourceTerms = normalizeAtomicTermList(group?.terms || [], {
    allowLockedBigrams: true,
    lockedBigrams
  }).slice(0, termLimit);
  if (sourceTerms.length > 0) return sourceTerms;

  if (firstFeatureId) {
    const fallback = normalizeAtomicTermList(termsByFeature?.[firstFeatureId] || [], {
      allowLockedBigrams: true,
      lockedBigrams: normalizePhraseLockedTerms(state?.phrase_locked_terms || [])
    }).slice(0, termLimit);
    if (fallback.length > 0) return fallback;
  }

  return [];
}

export function normalizeQueryPlan({
  queryPlan,
  features,
  termsByFeature,
  featureStateById,
  maxTermsPerFeature = 1,
  maxTermsPerFeatureByFeatureId,
  allowTwoTermsFeatureIds,
  modeByFeatureId,
  reasonByFeatureId
} = {}) {
  const hasInputGroups = Array.isArray(queryPlan?.groups) && queryPlan.groups.length > 0;
  const featureList = Array.isArray(features) ? features : [];
  const featureMap = new Map();
  const stateMap = featureStateById && typeof featureStateById === "object"
    ? featureStateById
    : {};
  const modeHints = modeByFeatureId && typeof modeByFeatureId === "object"
    ? modeByFeatureId
    : {};
  const reasonHints = reasonByFeatureId && typeof reasonByFeatureId === "object"
    ? reasonByFeatureId
    : {};

  featureList.forEach((feature, index) => {
    const featureId = normalizeFeatureId(feature?.id || `F${index + 1}`);
    if (!featureId) return;
    featureMap.set(featureId, feature);
  });

  const normalizedGroups = [];
  const seenGroupIds = new Set();
  const usedFeatureIds = new Set();

  const pushGroup = (group, indexHint = 0) => {
    if (!group || typeof group !== "object") return;

    let groupId = String(group.group_id || group.groupId || "").trim();
    if (!groupId) {
      groupId = `G${normalizedGroups.length + 1}`;
    }
    if (seenGroupIds.has(groupId)) {
      groupId = `${groupId}_${normalizedGroups.length + 1}`;
    }
    seenGroupIds.add(groupId);

    const featureIds = Array.isArray(group.feature_ids || group.featureIds)
      ? (group.feature_ids || group.featureIds)
      : [];
    const normalizedFeatureIds = featureIds
      .map((id) => normalizeFeatureId(id))
      .filter(Boolean);

    const firstFeatureId = normalizedFeatureIds[0] || "";
    const feature = featureMap.get(firstFeatureId) || null;
    const state = stateMap[firstFeatureId] || {};
    const required = group.required === true || (group.required !== false && !!firstFeatureId && inferRequired(feature, state));
    const modeHint = normalizeMode(modeHints[firstFeatureId] || "", "");
    const mode = modeHint || normalizeMode(group.mode, inferMode(feature, state, firstFeatureId ? "anchor" : "gap"));

    const terms = normalizeGroupTerms(
      group,
      firstFeatureId,
      feature,
      state,
      termsByFeature,
      maxTermsPerFeature,
      maxTermsPerFeatureByFeatureId,
      allowTwoTermsFeatureIds
    );
    if (!terms.length) return;

    const phraseLockedTerms = normalizePhraseLockedTerms([
      ...(group.phrase_locked_terms || group.phraseLockedTerms || []),
      ...collectPhraseLockedTermsFromEntries(group?.terms || []),
      ...(state?.phrase_locked_terms || [])
    ]).filter((term) => terms.some((entry) => entry.toLowerCase() === term.toLowerCase()));

    const explicitActive = typeof group.active === "boolean" ? group.active : undefined;
    const active = explicitActive !== undefined
      ? explicitActive
      : inferActive(feature, state, required);

    const focus = group.focus === true || state?.focus === true;
    const simplified = group.simplified === true || state?.simplified === true;

    normalizedFeatureIds.forEach((featureId) => usedFeatureIds.add(featureId));
    const sourceFeatureIds = Array.isArray(group.sourceFeatureIds || group.source_feature_ids)
      ? (group.sourceFeatureIds || group.source_feature_ids)
      : normalizedFeatureIds;
    const normalizedSourceFeatureIds = sourceFeatureIds
      .map((id) => normalizeFeatureId(id))
      .filter(Boolean);
    const normalizedGroupRole = normalizeGroupRole(
      group.groupRole || group.group_role,
      mode === "micro_qualifier" ? "qualifier_and" : "must_and"
    );
    normalizedGroups.push({
      group_id: groupId,
      feature_ids: normalizedFeatureIds,
      sourceFeatureIds: normalizedSourceFeatureIds,
      groupRole: normalizedGroupRole,
      splitFromFeatureId: normalizeFeatureId(group.splitFromFeatureId || group.split_from_feature_id || firstFeatureId || ""),
      required,
      active,
      focus,
      simplified,
      terms,
      phrase_locked_terms: phraseLockedTerms,
      reason: String(group.reason || "").trim() || String(reasonHints[firstFeatureId] || "").trim() || `Group ${groupId}`,
      mode
    });
  };

  const inputGroups = Array.isArray(queryPlan?.groups) ? queryPlan.groups : [];
  inputGroups.forEach((group, index) => pushGroup(group, index));

  const appendFeatureGroup = (feature, index, suffix = "") => {
    const featureId = normalizeFeatureId(feature?.id || `F${index + 1}`);
    if (!featureId) return;
    const state = stateMap[featureId] || {};
    const termLimit = resolveFeatureTermLimit({
      featureId,
      maxTermsPerFeature,
      maxTermsPerFeatureByFeatureId,
      allowTwoTermsFeatureIds
    });

    const terms = normalizeAtomicTermList(termsByFeature?.[featureId] || [], {
      allowLockedBigrams: true,
      lockedBigrams: normalizePhraseLockedTerms(state?.phrase_locked_terms || [])
    }).slice(0, termLimit);
    if (!terms.length) return;

    const modeHint = normalizeMode(modeHints[featureId] || "", "");
    const mode = modeHint || inferMode(feature, state);
    normalizedGroups.push({
      group_id: `G${normalizedGroups.length + 1}${suffix}`,
      feature_ids: [featureId],
      sourceFeatureIds: [featureId],
      groupRole: inferRequired(feature, state) ? "must_and" : "optional_or",
      splitFromFeatureId: "",
      required: inferRequired(feature, state),
      active: state.enabled !== false && state.active !== false,
      focus: state.focus === true,
      simplified: state.simplified === true,
      terms,
      phrase_locked_terms: normalizePhraseLockedTerms([
        ...(state?.phrase_locked_terms || []),
        ...collectPhraseLockedTermsFromEntries(termsByFeature?.[featureId] || [])
      ]).filter((term) => terms.some((entry) => entry.toLowerCase() === term.toLowerCase())),
      reason: String(reasonHints[featureId] || "").trim() || `${featureId} representative group`,
      mode
    });
    usedFeatureIds.add(featureId);
  };

  if (normalizedGroups.length === 0) {
    featureList.forEach((feature, index) => appendFeatureGroup(feature, index));
  } else if (!hasInputGroups) {
    featureList.forEach((feature, index) => {
      const featureId = normalizeFeatureId(feature?.id || `F${index + 1}`);
      if (!featureId || usedFeatureIds.has(featureId)) return;
      appendFeatureGroup(feature, index, "_AUTO");
    });
  } else {
    featureList.forEach((feature, index) => {
      const featureId = normalizeFeatureId(feature?.id || `F${index + 1}`);
      if (!featureId || usedFeatureIds.has(featureId)) return;
      appendFeatureGroup(feature, index, "_MISSING");
    });
  }

  return {
    groups: normalizedGroups
  };
}

function getGroupPrimaryFeatureId(group) {
  const featureIds = Array.isArray(group?.feature_ids || group?.featureIds)
    ? (group.feature_ids || group.featureIds)
    : [];
  return normalizeFeatureId(featureIds[0] || "");
}

function getGroupFeatureIds(group) {
  return (Array.isArray(group?.feature_ids || group?.featureIds)
    ? (group.feature_ids || group.featureIds)
    : [])
    .map((featureId) => normalizeFeatureId(featureId))
    .filter(Boolean);
}

function chooseOwnerFromCandidates(candidates = []) {
  const sorted = [...candidates].sort((left, right) => {
    if (Number(right.required === true) !== Number(left.required === true)) {
      return Number(right.required === true) - Number(left.required === true);
    }
    if (Number(right.focus === true) !== Number(left.focus === true)) {
      return Number(right.focus === true) - Number(left.focus === true);
    }
    if (Number(right.core === true) !== Number(left.core === true)) {
      return Number(right.core === true) - Number(left.core === true);
    }
    if (Number(right.weight || 0) !== Number(left.weight || 0)) {
      return Number(right.weight || 0) - Number(left.weight || 0);
    }
    if (Number(left.termCount || 0) !== Number(right.termCount || 0)) {
      return Number(left.termCount || 0) - Number(right.termCount || 0);
    }
    return String(left.groupId || "").localeCompare(String(right.groupId || ""));
  });
  return sorted[0] || null;
}

function removeCanonicalTermFromGroup(group, canonicalTerm) {
  const lockedTerms = normalizePhraseLockedTerms(group?.phrase_locked_terms || group?.phraseLockedTerms || []);
  const out = [];
  uniqueTerms(group?.terms || []).forEach((term) => {
    const canonical = canonicalizeGroupTerms([term], lockedTerms);
    if (canonical.some((entry) => entry === canonicalTerm)) return;
    out.push(term);
  });
  return out;
}

function collectOccupiedCanonicalTerms(groups) {
  const out = new Set();
  (Array.isArray(groups) ? groups : []).forEach((group) => {
    if (!group || group.active === false) return;
    const lockedTerms = normalizePhraseLockedTerms(group?.phrase_locked_terms || group?.phraseLockedTerms || []);
    const canonical = canonicalizeGroupTerms(group?.terms || [], lockedTerms);
    canonical.forEach((entry) => out.add(entry));
  });
  return out;
}

function pickNonCollidingReplacementTerm({
  group,
  featureId,
  termsByFeature,
  featureStateById,
  occupiedCanonicalTerms
}) {
  if (!featureId) return "";
  const lockedTerms = normalizePhraseLockedTerms([
    ...(group?.phrase_locked_terms || group?.phraseLockedTerms || []),
    ...(featureStateById?.[featureId]?.phrase_locked_terms || [])
  ]);
  const candidates = normalizeAtomicTermList(termsByFeature?.[featureId] || [], {
    allowLockedBigrams: true,
    lockedBigrams: lockedTerms
  });
  const occupied = occupiedCanonicalTerms instanceof Set ? occupiedCanonicalTerms : new Set();
  for (const candidate of candidates) {
    const canonical = canonicalizeGroupTerms([candidate], lockedTerms);
    if (!canonical.length) continue;
    const collides = canonical.some((entry) => occupied.has(entry));
    if (!collides) return candidate;
  }
  return "";
}

export function dedupeTermsAcrossActiveGroups({
  queryPlan,
  termsByFeature,
  featureStateById
} = {}) {
  const clonedPlan = cloneDeep(queryPlan) || { groups: [] };
  if (!Array.isArray(clonedPlan.groups)) clonedPlan.groups = [];
  const groups = clonedPlan.groups;
  const groupIndexById = new Map();
  groups.forEach((group, index) => {
    const groupId = String(group?.group_id || group?.groupId || `G${index + 1}`).trim() || `G${index + 1}`;
    group.group_id = groupId;
    groupIndexById.set(groupId, index);
  });

  const debugMeta = {
    duplicate_terms_removed: [],
    term_owner_by_group: {},
    emptied_groups: [],
    rebuild_required_due_to_cross_group_dedupe: false
  };

  let guard = 0;
  while (guard < 4) {
    guard += 1;
    const duplicates = findDuplicateTermsAcrossActiveGroups({
      queryPlan: { groups },
      termsByFeature,
      featureStateById
    });
    if (!duplicates.length) break;

    duplicates.forEach((entry) => {
      const owners = Array.isArray(entry?.owners) ? entry.owners : [];
      if (owners.length < 2) return;
      const owner = chooseOwnerFromCandidates(owners);
      if (!owner?.groupId) return;
      const ownerGroupId = String(owner.groupId || "");
      if (!debugMeta.term_owner_by_group[ownerGroupId]) {
        debugMeta.term_owner_by_group[ownerGroupId] = [];
      }
      debugMeta.term_owner_by_group[ownerGroupId].push(entry.term);

      owners.forEach((candidate) => {
        const groupId = String(candidate?.groupId || "");
        if (!groupId || groupId === ownerGroupId) return;
        const groupIndex = groupIndexById.get(groupId);
        if (groupIndex === undefined) return;
        const group = groups[groupIndex];
        if (!group || group.active === false) return;
        const before = uniqueTerms(group?.terms || []);
        const after = removeCanonicalTermFromGroup(group, entry.term);
        if (after.length === before.length) return;
        group.terms = after;
        debugMeta.duplicate_terms_removed.push(`${entry.term}@${groupId}->${ownerGroupId}`);
      });
    });

    const occupiedCanonical = collectOccupiedCanonicalTerms(groups);
    groups.forEach((group) => {
      if (!group || group.active === false) return;
      const terms = uniqueTerms(group?.terms || []);
      if (terms.length > 0) return;

      const featureId = getGroupPrimaryFeatureId(group);
      const replacement = pickNonCollidingReplacementTerm({
        group,
        featureId,
        termsByFeature,
        featureStateById,
        occupiedCanonicalTerms: occupiedCanonical
      });
      if (replacement) {
        group.terms = [replacement];
        const lockedTerms = normalizePhraseLockedTerms(group?.phrase_locked_terms || group?.phraseLockedTerms || []);
        canonicalizeGroupTerms([replacement], lockedTerms).forEach((entry) => occupiedCanonical.add(entry));
        return;
      }

      const state = featureStateById?.[featureId] || {};
      const groupId = String(group.group_id || group.groupId || "");
      debugMeta.emptied_groups.push(groupId);
      if (group.required === true || state.core === true || state.queryRole === "must") {
        debugMeta.rebuild_required_due_to_cross_group_dedupe = true;
        return;
      }
      group.active = false;
    });
  }

  debugMeta.duplicate_terms_removed = uniqueTerms(debugMeta.duplicate_terms_removed);
  debugMeta.emptied_groups = uniqueTerms(debugMeta.emptied_groups);
  Object.keys(debugMeta.term_owner_by_group).forEach((groupId) => {
    debugMeta.term_owner_by_group[groupId] = uniqueTerms(debugMeta.term_owner_by_group[groupId]);
  });

  return {
    queryPlan: { groups },
    debugMeta
  };
}

function isGroupRenderable(group, featureStateById = {}) {
  if (!group || typeof group !== "object") return false;
  if (group.active === false) return false;

  const featureIds = Array.isArray(group?.feature_ids || group?.featureIds)
    ? (group.feature_ids || group.featureIds).map((featureId) => normalizeFeatureId(featureId)).filter(Boolean)
    : [];

  if (!featureIds.length) {
    return group.active !== false;
  }

  return featureIds.some((featureId) => {
    const state = featureStateById?.[featureId] || {};
    if (state.enabled === false) return false;
    if (state.active === false) return false;
    return true;
  });
}

export function buildExpression({
  queryPlan,
  features,
  termsByFeature,
  featureStateById,
  maxTermsPerFeature = 1,
  maxTermsPerFeatureByFeatureId,
  allowTwoTermsFeatureIds,
  modeByFeatureId,
  reasonByFeatureId,
  maxActiveGroups = null,
  debugMetaOut = null
}) {
  const lockedBigramsByFeature = buildLockedBigramsByFeature(featureStateById);
  const lexicalTerms = enforceAtomicTermsByFeature(termsByFeature || {}, lockedBigramsByFeature, {
    allowLockedBigrams: true
  }).termsByFeature;

  const normalizedPlan = normalizeQueryPlan({
    queryPlan,
    features,
    termsByFeature: lexicalTerms,
    featureStateById,
    maxTermsPerFeature,
    maxTermsPerFeatureByFeatureId,
    allowTwoTermsFeatureIds,
    modeByFeatureId,
    reasonByFeatureId
  });

  let groupsToRender = (Array.isArray(normalizedPlan?.groups) ? normalizedPlan.groups : [])
    .filter((group) => isGroupRenderable(group, featureStateById));

  if (Number.isFinite(Number(maxActiveGroups)) && Number(maxActiveGroups) > 0 && groupsToRender.length > Number(maxActiveGroups)) {
    groupsToRender = [...groupsToRender]
      .sort((left, right) => {
        if (Number(right.required) !== Number(left.required)) {
          return Number(right.required) - Number(left.required);
        }
        if (Number(right.focus) !== Number(left.focus)) {
          return Number(right.focus) - Number(left.focus);
        }
        const leftFeature = getGroupPrimaryFeatureId(left);
        const rightFeature = getGroupPrimaryFeatureId(right);
        const leftWeight = Number(featureStateById?.[leftFeature]?.weight || 0);
        const rightWeight = Number(featureStateById?.[rightFeature]?.weight || 0);
        if (rightWeight !== leftWeight) return rightWeight - leftWeight;
        return String(left.group_id || "").localeCompare(String(right.group_id || ""));
      })
      .slice(0, Number(maxActiveGroups));
  }

  const deduped = dedupeTermsAcrossActiveGroups({
    queryPlan: { groups: groupsToRender },
    termsByFeature: lexicalTerms,
    featureStateById
  });
  const groupsAfterDedupe = (Array.isArray(deduped?.queryPlan?.groups) ? deduped.queryPlan.groups : [])
    .filter((group) => isGroupRenderable(group, featureStateById));

  if (debugMetaOut && typeof debugMetaOut === "object") {
    debugMetaOut.duplicate_terms_removed = deduped?.debugMeta?.duplicate_terms_removed || [];
    debugMetaOut.term_owner_by_group = deduped?.debugMeta?.term_owner_by_group || {};
    debugMetaOut.emptied_groups = deduped?.debugMeta?.emptied_groups || [];
    debugMetaOut.rebuild_required_due_to_cross_group_dedupe = deduped?.debugMeta?.rebuild_required_due_to_cross_group_dedupe === true;
  }

  const renderedGroups = [];
  groupsAfterDedupe.forEach((group) => {
    const phraseLockedSet = new Set(
      normalizePhraseLockedTerms(group?.phrase_locked_terms || []).map((term) => term.toLowerCase())
    );
    const rendered = uniqueTerms(group?.terms || []).map((term) => renderTerm(term, phraseLockedSet)).filter(Boolean);
    if (!rendered.length) return;

    if (rendered.length === 1) {
      renderedGroups.push(`(${rendered[0]})`);
      return;
    }
    renderedGroups.push(`(${rendered.join(" | ")})`);
  });

  if (!renderedGroups.length) return "";
  if (renderedGroups.length === 1) return renderedGroups[0];
  return renderedGroups.join(" & ");
}

function buildFeatureLookup(features, termsByFeature, featureStateById) {
  const lookup = new Map();
  (Array.isArray(features) ? features : []).forEach((feature, index) => {
    const featureId = normalizeFeatureId(feature?.id || `F${index + 1}`);
    if (!featureId) return;
    const hintToken = normalizeAtomicTermList([
      String(feature?.search_hint || feature?.searchHint || feature?.text || "").trim()
    ], { allowLockedBigrams: false })[0] || "";
    const featureTerms = uniqueTerms([
      ...(Array.isArray(termsByFeature?.[featureId]) ? termsByFeature[featureId] : []),
      ...(hintToken ? [hintToken] : [])
    ]);
    lookup.set(featureId, {
      id: featureId,
      text: String(feature?.text || "").trim(),
      terms: featureTerms
    });
  });
  return lookup;
}

function scoreGroupSimilarity(parsedTerms, existingGroup, featureLookup) {
  const existingTerms = uniqueTerms(existingGroup?.terms || []);
  const featureIds = Array.isArray(existingGroup?.feature_ids || existingGroup?.featureIds)
    ? (existingGroup.feature_ids || existingGroup.featureIds)
    : [];

  const featureSeedTerms = [];
  featureIds.forEach((featureIdRaw) => {
    const featureId = normalizeFeatureId(featureIdRaw);
    const feature = featureLookup.get(featureId);
    if (!feature) return;
    featureSeedTerms.push(...feature.terms);
  });
  const baselineTerms = uniqueTerms([...existingTerms, ...featureSeedTerms]).map((term) => term.toLowerCase());
  const candidateTerms = uniqueTerms(parsedTerms).map((term) => term.toLowerCase());

  const termScore = jaccardSimilarity(candidateTerms, baselineTerms);
  const candidateTokens = uniqueTerms(candidateTerms.flatMap((term) => tokenizeTerm(term)));
  const baselineTokens = uniqueTerms(baselineTerms.flatMap((term) => tokenizeTerm(term)));
  const tokenScore = jaccardSimilarity(candidateTokens, baselineTokens);
  const exactPrefixMatch = candidateTerms.some((term) => baselineTerms.includes(term)) ? 1 : 0;

  return (termScore * 0.6) + (tokenScore * 0.3) + (exactPrefixMatch * 0.1);
}

function applyTermsByMappedPlan(baseTermsByFeature, mappedGroups) {
  const next = { ...(baseTermsByFeature || {}) };
  (Array.isArray(mappedGroups) ? mappedGroups : []).forEach((group) => {
    const terms = uniqueTerms(group?.terms || []);
    if (!terms.length) return;
    const featureIds = Array.isArray(group?.feature_ids || group?.featureIds)
      ? (group.feature_ids || group.featureIds)
      : [];
    featureIds.forEach((featureIdRaw) => {
      const featureId = normalizeFeatureId(featureIdRaw);
      if (!featureId) return;
      next[featureId] = terms.slice(0, 10);
    });
  });
  return next;
}

export function deriveQueryPlanFromExpression({
  expression,
  features,
  featureStateById,
  fallbackTermsByFeature,
  baseQueryPlan
} = {}) {
  const groupsText = splitTopLevelExpression(String(expression || "").trim(), "&");
  const baseTerms = normalizeTermsByFeature(fallbackTermsByFeature || {}, features);
  const normalizedBasePlan = normalizeQueryPlan({
    queryPlan: baseQueryPlan || null,
    features,
    termsByFeature: baseTerms,
    featureStateById
  });

  if (!groupsText.length) {
    return {
      queryPlan: normalizedBasePlan,
      termsByFeature: baseTerms,
      mapping: {
        mappedGroups: [],
        unmappedGroups: []
      }
    };
  }

  const existingGroups = Array.isArray(normalizedBasePlan?.groups) ? normalizedBasePlan.groups : [];
  const featureLookup = buildFeatureLookup(features, baseTerms, featureStateById);
  const usedExistingGroupIds = new Set();
  const mappedGroups = [];
  let unmappedIndex = 0;

  groupsText.forEach((groupText, index) => {
    const parsed = extractTermsFromExpressionGroup(groupText);
    const parsedTerms = parsed.terms;
    if (!parsedTerms.length) return;

    let bestGroup = null;
    let bestScore = -1;
    let secondScore = -1;
    existingGroups.forEach((group) => {
      const groupId = String(group?.group_id || group?.groupId || "").trim();
      if (!groupId || usedExistingGroupIds.has(groupId)) return;
      const score = scoreGroupSimilarity(parsedTerms, group, featureLookup);
      if (score > bestScore) {
        secondScore = bestScore;
        bestScore = score;
        bestGroup = group;
      } else if (score > secondScore) {
        secondScore = score;
      }
    });

    const confident = !!bestGroup && bestScore >= 0.34 && (bestScore - secondScore >= 0.08 || bestScore >= 0.55);
    if (confident) {
      const groupId = String(bestGroup.group_id || bestGroup.groupId || `G${index + 1}`).trim();
      usedExistingGroupIds.add(groupId);
      mappedGroups.push({
        group_id: groupId,
        feature_ids: Array.isArray(bestGroup.feature_ids || bestGroup.featureIds)
          ? (bestGroup.feature_ids || bestGroup.featureIds).map((id) => normalizeFeatureId(id)).filter(Boolean)
          : [],
        required: bestGroup.required === true,
        active: bestGroup.active !== false,
        focus: bestGroup.focus === true,
        simplified: bestGroup.simplified === true,
        terms: parsedTerms.slice(0, 10),
        phrase_locked_terms: parsed.phrase_locked_terms,
        reason: `${String(bestGroup.reason || "").trim() || `Remapped from ${groupId}`} [sim=${bestScore.toFixed(2)}]`,
        mode: normalizeMode(bestGroup.mode, "anchor")
      });
      return;
    }

    unmappedIndex += 1;
    mappedGroups.push({
      group_id: `UNMAPPED_${unmappedIndex}`,
      feature_ids: [],
      required: false,
      active: true,
      focus: false,
      simplified: false,
      terms: parsedTerms.slice(0, 10),
      phrase_locked_terms: parsed.phrase_locked_terms,
      reason: "Manual edit group mapping uncertain; pending LLM remap",
      mode: "gap"
    });
  });

  const queryPlan = normalizeQueryPlan({
    queryPlan: { groups: mappedGroups },
    features,
    termsByFeature: baseTerms,
    featureStateById
  });
  const termsByFeature = applyTermsByMappedPlan(baseTerms, queryPlan.groups);

  return {
    queryPlan,
    termsByFeature,
    mapping: {
      mappedGroups: queryPlan.groups.filter((group) => Array.isArray(group.feature_ids) && group.feature_ids.length > 0),
      unmappedGroups: queryPlan.groups.filter((group) => !Array.isArray(group.feature_ids) || group.feature_ids.length === 0)
    }
  };
}

export function normalizeTermsByFeature(termsByFeature, features) {
  const out = {};
  const featureIds = new Set((Array.isArray(features) ? features : []).map((feature) => String(feature?.id || "").toUpperCase()));

  Object.entries(termsByFeature || {}).forEach(([featureIdRaw, terms]) => {
    const featureId = String(featureIdRaw || "").toUpperCase();
    if (!featureId || (featureIds.size && !featureIds.has(featureId))) return;

    const normalized = normalizeAtomicTermList(terms, { allowLockedBigrams: false });
    if (!normalized.length) return;
    out[featureId] = uniqueTerms(normalized);
  });

  return out;
}

