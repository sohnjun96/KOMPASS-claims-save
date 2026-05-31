import { normalizeAtomicTermList } from "./query_lexical_policy.js";

function asString(value) {
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }
  if (value && typeof value === "object") {
    return String(value.text ?? value.term ?? value.value ?? "").trim();
  }
  return "";
}

function normalizeFeatureId(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeGroupId(value, fallbackIndex = 0) {
  const out = String(value || "").trim();
  return out || `G${fallbackIndex + 1}`;
}

function uniqueStrings(items) {
  const out = [];
  const seen = new Set();
  (Array.isArray(items) ? items : []).forEach((item) => {
    const value = asString(item);
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(value);
  });
  return out;
}

function uniqueLower(items) {
  return uniqueStrings(items).map((item) => item.toLowerCase());
}

function splitWords(text) {
  return String(text || "")
    .replace(/"/g, " ")
    .replace(/[&|()+]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

function normalizeLockedBigramSet(phraseLockedTerms = []) {
  return new Set(
    uniqueStrings(phraseLockedTerms)
      .map((term) => splitWords(term).slice(0, 2).join(" ").trim().toLowerCase())
      .filter((term) => splitWords(term).length === 2)
  );
}

function getGroupFeatureIds(group) {
  const featureIds = Array.isArray(group?.feature_ids || group?.featureIds)
    ? (group.feature_ids || group.featureIds)
    : [];
  return featureIds.map((id) => normalizeFeatureId(id)).filter(Boolean);
}

function getGroupPrimaryFeatureId(group) {
  return getGroupFeatureIds(group)[0] || "";
}

function isGroupRenderable(group, featureStateById = {}) {
  if (!group || typeof group !== "object") return false;
  if (group.active === false) return false;

  const featureIds = getGroupFeatureIds(group);
  if (!featureIds.length) return group.active !== false;

  return featureIds.some((featureId) => {
    const state = featureStateById?.[featureId] || {};
    if (state.enabled === false) return false;
    if (state.active === false) return false;
    return true;
  });
}

function collectGroupTerms(group, termsByFeature = {}) {
  const directTerms = uniqueStrings(group?.terms || []);
  if (directTerms.length > 0) return directTerms;
  const primaryFeatureId = getGroupPrimaryFeatureId(group);
  if (!primaryFeatureId) return [];
  return uniqueStrings(termsByFeature?.[primaryFeatureId] || []);
}

function collectActiveGroups({ queryPlan, termsByFeature, featureStateById, maxActiveGroups }) {
  let groups = (Array.isArray(queryPlan?.groups) ? queryPlan.groups : [])
    .map((group, index) => ({
      ...group,
      group_id: normalizeGroupId(group?.group_id || group?.groupId, index),
      feature_ids: getGroupFeatureIds(group),
      terms: collectGroupTerms(group, termsByFeature)
    }))
    .filter((group) => group.terms.length > 0)
    .filter((group) => isGroupRenderable(group, featureStateById));

  const limit = Number(maxActiveGroups);
  if (Number.isFinite(limit) && limit > 0 && groups.length > limit) {
    groups = [...groups]
      .sort((left, right) => {
        if (Number(right.required === true) !== Number(left.required === true)) {
          return Number(right.required === true) - Number(left.required === true);
        }
        if (Number(right.focus === true) !== Number(left.focus === true)) {
          return Number(right.focus === true) - Number(left.focus === true);
        }
        const leftFeatureId = getGroupPrimaryFeatureId(left);
        const rightFeatureId = getGroupPrimaryFeatureId(right);
        const leftWeight = Number(featureStateById?.[leftFeatureId]?.weight || 0);
        const rightWeight = Number(featureStateById?.[rightFeatureId]?.weight || 0);
        if (rightWeight !== leftWeight) return rightWeight - leftWeight;
        return String(left.group_id || "").localeCompare(String(right.group_id || ""));
      })
      .slice(0, limit);
  }
  return groups;
}

function termToCanonicalAtoms(term, { phraseLockedTerms = [] } = {}) {
  const raw = asString(term);
  if (!raw) return [];

  const lockedSet = normalizeLockedBigramSet(phraseLockedTerms);
  const words = splitWords(raw);
  if (words.length === 2) {
    const joined = words.join(" ").toLowerCase();
    if (lockedSet.has(joined)) return [joined];
  }

  return uniqueLower(normalizeAtomicTermList([raw], { allowLockedBigrams: false }));
}

export function canonicalizeAtomicTerm(term, options = {}) {
  const out = termToCanonicalAtoms(term, options);
  if (!out.length) return "";
  return out.join(" ");
}

export function canonicalizeGroupTerms(terms, phraseLockedTerms = []) {
  const out = [];
  (Array.isArray(terms) ? terms : []).forEach((term) => {
    const atoms = termToCanonicalAtoms(term, { phraseLockedTerms });
    atoms.forEach((entry) => out.push(entry));
  });
  return uniqueLower(out).sort((left, right) => left.localeCompare(right));
}

export function buildGroupFingerprint(group, options = {}) {
  const phraseLockedTerms = uniqueStrings([
    ...(group?.phrase_locked_terms || group?.phraseLockedTerms || []),
    ...(options.phraseLockedTerms || [])
  ]);
  const terms = canonicalizeGroupTerms(group?.terms || [], phraseLockedTerms);
  if (!terms.length) return "";
  return terms.join("|");
}

function buildActiveGroupFingerprints(input = {}) {
  const activeGroups = collectActiveGroups(input);
  const groupFingerprints = activeGroups
    .map((group) => ({
      groupId: normalizeGroupId(group?.group_id || group?.groupId),
      fingerprint: buildGroupFingerprint(group, {
        phraseLockedTerms: group?.phrase_locked_terms || []
      }),
      terms: canonicalizeGroupTerms(group?.terms || [], group?.phrase_locked_terms || [])
    }))
    .filter((entry) => !!entry.fingerprint);

  return {
    activeGroups,
    groupFingerprints
  };
}

export function buildQueryFingerprint({ queryPlan, termsByFeature, featureStateById, maxActiveGroups } = {}) {
  const { groupFingerprints } = buildActiveGroupFingerprints({
    queryPlan,
    termsByFeature,
    featureStateById,
    maxActiveGroups
  });
  if (!groupFingerprints.length) return "";
  return groupFingerprints
    .map((entry) => entry.fingerprint)
    .sort((left, right) => left.localeCompare(right))
    .join(" & ");
}

export function buildSemanticQueryFingerprint({ queryPlan, termsByFeature, featureStateById, maxActiveGroups } = {}) {
  const { groupFingerprints } = buildActiveGroupFingerprints({
    queryPlan,
    termsByFeature,
    featureStateById,
    maxActiveGroups
  });
  if (!groupFingerprints.length) return "";
  const flattened = [];
  groupFingerprints.forEach((entry) => {
    (entry.terms || []).forEach((term) => flattened.push(term));
  });
  return uniqueLower(flattened)
    .sort((left, right) => left.localeCompare(right))
    .join(" | ");
}

export function buildActiveTermOwnershipMap({ queryPlan, termsByFeature, featureStateById, maxActiveGroups } = {}) {
  const { activeGroups } = buildActiveGroupFingerprints({
    queryPlan,
    termsByFeature,
    featureStateById,
    maxActiveGroups
  });
  const ownership = {};

  activeGroups.forEach((group, groupIndex) => {
    const groupId = normalizeGroupId(group?.group_id || group?.groupId, groupIndex);
    const primaryFeatureId = getGroupPrimaryFeatureId(group);
    const state = featureStateById?.[primaryFeatureId] || {};
    const phraseLockedTerms = uniqueStrings([
      ...(group?.phrase_locked_terms || group?.phraseLockedTerms || []),
      ...(state?.phrase_locked_terms || [])
    ]);
    const canonicalTerms = canonicalizeGroupTerms(group?.terms || [], phraseLockedTerms);
    const termCount = canonicalTerms.length;
    canonicalTerms.forEach((term) => {
      if (!ownership[term]) ownership[term] = [];
      ownership[term].push({
        groupId,
        featureId: primaryFeatureId,
        required: group?.required === true,
        focus: group?.focus === true || state?.focus === true,
        core: state?.core === true || state?.queryRole === "must",
        weight: Number(state?.weight || 0),
        termCount
      });
    });
  });

  return ownership;
}

export function findDuplicateTermsAcrossActiveGroups({ queryPlan, termsByFeature, featureStateById, maxActiveGroups } = {}) {
  const ownership = buildActiveTermOwnershipMap({
    queryPlan,
    termsByFeature,
    featureStateById,
    maxActiveGroups
  });
  return Object.entries(ownership)
    .filter(([, owners]) => Array.isArray(owners) && owners.length >= 2)
    .map(([term, owners]) => ({
      term,
      owners: owners.slice().sort((left, right) => String(left.groupId || "").localeCompare(String(right.groupId || "")))
    }))
    .sort((left, right) => left.term.localeCompare(right.term));
}

export function buildActiveTermsFingerprint({ queryPlan, termsByFeature, featureStateById, maxActiveGroups } = {}) {
  const ownership = buildActiveTermOwnershipMap({
    queryPlan,
    termsByFeature,
    featureStateById,
    maxActiveGroups
  });
  return Object.entries(ownership)
    .map(([term, owners]) => `${term}:${Array.isArray(owners) ? owners.length : 0}`)
    .sort((left, right) => left.localeCompare(right))
    .join("|");
}

export function collectActiveCanonicalTerms({ queryPlan, termsByFeature, featureStateById, maxActiveGroups } = {}) {
  const ownership = buildActiveTermOwnershipMap({
    queryPlan,
    termsByFeature,
    featureStateById,
    maxActiveGroups
  });
  return Object.keys(ownership).sort((left, right) => left.localeCompare(right));
}

