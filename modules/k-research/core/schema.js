import {
  normalizeAtomicTermList,
  enforceAtomicTermsByFeature
} from "./query_lexical_policy.js";

import { canonicalizeAtomicTerm } from "./query_fingerprint.js";

function asString(value) {
  return String(value || "").trim();
}

function asNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
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

export function buildTermToFeatureMap(termsByFeature = {}, featureStateById = {}) {
  const out = {};
  Object.entries(termsByFeature || {}).forEach(([featureIdRaw, terms]) => {
    const featureId = asString(featureIdRaw).toUpperCase();
    if (!featureId) return;
    const state = featureStateById?.[featureId] || {};
    if (state.enabled === false || state.active === false) return;
    uniqueStrings(terms).forEach((term) => {
      const canonical = canonicalizeAtomicTerm(term);
      if (!canonical) return;
      const key = canonical.toLowerCase();
      if (!out[key]) out[key] = [];
      if (out[key].includes(featureId)) return;
      out[key].push(featureId);
    });
  });
  return out;
}

export function findCrossFeatureTermCollisions(termsByFeature = {}, featureStateById = {}) {
  const termToFeatureMap = buildTermToFeatureMap(termsByFeature, featureStateById);
  return Object.entries(termToFeatureMap)
    .filter(([, featureIds]) => Array.isArray(featureIds) && featureIds.length >= 2)
    .map(([term, featureIds]) => ({
      term,
      featureIds: featureIds.slice().sort((left, right) => left.localeCompare(right))
    }))
    .sort((left, right) => left.term.localeCompare(right.term));
}

function dedupeCrossFeatureTerms(termsByFeature = {}, featureStateById = {}) {
  const next = {};
  Object.entries(termsByFeature || {}).forEach(([featureId, terms]) => {
    next[asString(featureId).toUpperCase()] = uniqueStrings(terms);
  });

  const collisions = findCrossFeatureTermCollisions(next, featureStateById);
  if (!collisions.length) {
    return {
      termsByFeature: next,
      collisions: []
    };
  }

  const scoreFeature = (featureIdRaw) => {
    const featureId = asString(featureIdRaw).toUpperCase();
    const state = featureStateById?.[featureId] || {};
    const required = state.core === true || state.queryRole === "must";
    const focus = state.focus === true;
    const weight = Number(state.weight || 0);
    return {
      featureId,
      required,
      focus,
      weight
    };
  };

  collisions.forEach((collision) => {
    const owners = (collision.featureIds || []).map((featureId) => scoreFeature(featureId));
    const owner = owners.sort((left, right) => {
      if (Number(right.required) !== Number(left.required)) {
        return Number(right.required) - Number(left.required);
      }
      if (Number(right.focus) !== Number(left.focus)) {
        return Number(right.focus) - Number(left.focus);
      }
      if (right.weight !== left.weight) return right.weight - left.weight;
      return left.featureId.localeCompare(right.featureId);
    })[0];

    owners.forEach((candidate) => {
      if (!owner || candidate.featureId === owner.featureId) return;
      const list = uniqueStrings(next[candidate.featureId] || []);
      next[candidate.featureId] = list.filter((term) => canonicalizeAtomicTerm(term).toLowerCase() !== collision.term);
    });
  });

  return {
    termsByFeature: next,
    collisions
  };
}

function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
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

function deriveRoleFromLegacy(entry) {
  const explicit = normalizeQueryRole(entry?.query_role || entry?.queryRole, "");
  if (explicit) return explicit;
  if (entry?.core === true) return "must";
  if (entry?.negative === true) return "can_drop";
  return "should";
}

function deriveTypeFromLegacy(entry, queryRole) {
  const explicit = normalizeFeatureType(entry?.type, "");
  if (explicit) return explicit;
  if (queryRole === "must") return "anchor";
  if (queryRole === "can_drop") return "optional";
  if (entry?.relation_to || entry?.relationTo) return "relation";
  return "discriminator";
}

function deriveWeight(entry, queryRole) {
  const fallback = queryRole === "must" ? 5 : (queryRole === "can_drop" ? 2 : 3);
  return clampInt(entry?.weight, 1, 5, fallback);
}

function splitWords(text) {
  return asString(text)
    .replace(/[()\[\],.;:]/g, " ")
    .split(/[\s/|+\-]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function atomizeSearchTerm(term) {
  const source = asString(term).replace(/^"|"$/g, "").trim();
  if (!source) return [];
  const words = splitWords(source);
  if (words.length <= 1) return words;

  const atoms = [];
  words.forEach((word) => {
    if (word.length >= 2) {
      atoms.push(word);
      return;
    }
    if (/^[A-Za-z0-9]$/u.test(word)) {
      atoms.push(word);
    }
  });

  return uniqueStrings(atoms);
}

export function dephraseTermList(terms, lockedTerms = []) {
  const lockedSet = new Set(uniqueStrings(lockedTerms).map((term) => term.toLowerCase()));
  const out = [];
  (Array.isArray(terms) ? terms : []).forEach((entry) => {
    const term = asString(entry);
    if (!term) return;
    const key = term.toLowerCase();
    if (lockedSet.has(key)) {
      out.push(term);
      return;
    }

    const atoms = atomizeSearchTerm(term);
    if (atoms.length >= 2) {
      atoms.forEach((atom) => out.push(atom));
      return;
    }
    out.push(term);
  });
  return uniqueStrings(out);
}

function findBalancedJsonSlice(text) {
  const source = String(text || "");
  const startCandidates = [];
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{" || ch === "[") {
      startCandidates.push(i);
    }
  }

  for (const start of startCandidates) {
    const stack = [];
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === "{" || ch === "[") {
        stack.push(ch);
      } else if (ch === "}" || ch === "]") {
        const open = stack.pop();
        if (!open) break;
        if ((open === "{" && ch !== "}") || (open === "[" && ch !== "]")) {
          break;
        }
        if (stack.length === 0) {
          return source.slice(start, i + 1);
        }
      }
    }
  }

  return "";
}

export function parseJsonFromText(rawText) {
  const source = String(rawText || "").trim();
  if (!source) {
    throw new Error("empty-output");
  }

  const direct = source
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(direct);
  } catch {
    const slice = findBalancedJsonSlice(source);
    if (!slice) {
      throw new Error("json-not-found");
    }
    return JSON.parse(slice);
  }
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isTypeMatch(value, type) {
  if (!type) return true;
  if (Array.isArray(type)) {
    return type.some((entry) => isTypeMatch(value, entry));
  }
  if (type === "object") return isPlainObject(value);
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "integer") return Number.isInteger(value);
  if (type === "null") return value === null;
  return true;
}

function validateNode(value, schema, path, errors) {
  if (!schema || typeof schema !== "object") return;

  if (!isTypeMatch(value, schema.type)) {
    errors.push(`${path || "$"}:expected_${schema.type}`);
    return;
  }

  if (schema.type === "object" && isPlainObject(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    required.forEach((key) => {
      if (!(key in value)) {
        errors.push(`${path || "$"}:missing_${key}`);
      }
    });

    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    Object.entries(properties).forEach(([key, childSchema]) => {
      if (!(key in value)) return;
      const childPath = path ? `${path}.${key}` : key;
      validateNode(value[key], childSchema, childPath, errors);
    });
  }

  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      validateNode(item, schema.items, `${path || "$"}[${index}]`, errors);
    });
  }
}

export function validateAgainstSchema(value, schema) {
  const errors = [];
  validateNode(value, schema, "", errors);
  return {
    valid: errors.length === 0,
    errors
  };
}

export function normalizeFeatureExtract(raw) {
  const featuresRaw = Array.isArray(raw?.features) ? raw.features : [];
  const features = [];
  const usedIds = new Set();

  featuresRaw.forEach((entry, index) => {
    const idSeed = asString(entry?.id || `F${index + 1}`).toUpperCase();
    const id = idSeed.startsWith("F") ? idSeed : `F${index + 1}`;
    if (usedIds.has(id)) return;

    const text = asString(entry?.text || entry?.description || entry?.feature);
    if (!text) return;

    const queryRole = deriveRoleFromLegacy(entry);
    const type = deriveTypeFromLegacy(entry, queryRole);
    const weight = deriveWeight(entry, queryRole);
    const relationTo = uniqueStrings(entry?.relation_to || entry?.relationTo)
      .map((featureId) => featureId.toUpperCase())
      .filter((featureId) => featureId && featureId !== id);
    const negative = !!entry?.negative;

    usedIds.add(id);
    features.push({
      id,
      text,
      type,
      weight,
      query_role: queryRole,
      relation_to: relationTo,
      negative,
      search_hint: asString(entry?.search_hint || entry?.searchHint)
    });
  });

  return {
    features,
    summary: asString(raw?.summary)
  };
}

function getFeatureMetaMap(featureSpec = []) {
  const featureMetaById = new Map();

  (Array.isArray(featureSpec) ? featureSpec : []).forEach((item) => {
    if (typeof item === "string") {
      const id = asString(item).toUpperCase();
      if (!id) return;
      featureMetaById.set(id, {
        id,
        text: id,
        type: "optional",
        queryRole: "should",
        weight: 3,
        negative: false
      });
      return;
    }

    const id = asString(item?.id).toUpperCase();
    if (!id) return;
    const queryRole = normalizeQueryRole(item?.query_role || item?.queryRole, "should");
    featureMetaById.set(id, {
      id,
      text: asString(item?.text || item?.description || id),
      type: normalizeFeatureType(item?.type, queryRole === "must" ? "anchor" : "optional"),
      queryRole,
      weight: clampInt(item?.weight, 1, 5, queryRole === "must" ? 5 : 3),
      negative: !!item?.negative,
      searchHint: asString(item?.search_hint || item?.searchHint)
    });
  });

  return featureMetaById;
}

function normalizeLockedBigrams(items) {
  const candidates = normalizeAtomicTermList(items, {
    allowLockedBigrams: true,
    lockedBigrams: items
  });
  return uniqueStrings(candidates.filter((term) => splitWords(term).length === 2));
}

function splitPrimaryAndSpillTerms(items, { allowLockedBigrams = false, lockedBigrams = [] } = {}) {
  const primary = [];
  const spill = [];
  (Array.isArray(items) ? items : []).forEach((entry) => {
    const normalized = normalizeAtomicTermList([entry], {
      allowLockedBigrams,
      lockedBigrams
    });
    if (!normalized.length) return;
    primary.push(normalized[0]);
    if (normalized.length >= 2) {
      normalized.slice(1).forEach((term) => spill.push(term));
    }
  });
  return {
    primary: uniqueStrings(primary),
    spill: uniqueStrings(spill)
  };
}

function normalizeSeedBuckets(entry) {
  const legacyExactPhraseTerms = uniqueStrings(entry?.exact_phrase_terms || entry?.exactPhraseTerms);
  const lockedBigrams = normalizeLockedBigrams([
    ...(entry?.locked_bigrams || entry?.lockedBigrams || []),
    ...legacyExactPhraseTerms
  ]);

  const baseSplit = splitPrimaryAndSpillTerms(entry?.base_terms || entry?.baseTerms, {
    allowLockedBigrams: false
  });
  const supportSplit = splitPrimaryAndSpillTerms(entry?.support_terms || entry?.supportTerms, {
    allowLockedBigrams: false
  });
  const broadSplit = splitPrimaryAndSpillTerms(entry?.broad_terms || entry?.broadTerms, {
    allowLockedBigrams: false
  });
  const narrowSplit = splitPrimaryAndSpillTerms(entry?.narrow_terms || entry?.narrowTerms, {
    allowLockedBigrams: false
  });
  const avoidSplit = splitPrimaryAndSpillTerms(entry?.avoid_terms || entry?.avoidTerms, {
    allowLockedBigrams: false
  });
  const entitySplit = splitPrimaryAndSpillTerms(entry?.entity_terms || entry?.entityTerms, {
    allowLockedBigrams: false
  });
  const actionSplit = splitPrimaryAndSpillTerms(entry?.action_terms || entry?.actionTerms, {
    allowLockedBigrams: false
  });
  const qualifierSplit = splitPrimaryAndSpillTerms(entry?.qualifier_terms || entry?.qualifierTerms, {
    allowLockedBigrams: false
  });
  const noiseSplit = splitPrimaryAndSpillTerms(entry?.noise_prone_terms || entry?.noiseProneTerms, {
    allowLockedBigrams: false
  });

  const baseTerms = uniqueStrings(baseSplit.primary);
  const supportTerms = uniqueStrings([
    ...baseSplit.spill,
    ...supportSplit.primary,
    ...supportSplit.spill
  ]);
  const broadTerms = uniqueStrings([...broadSplit.primary, ...broadSplit.spill]);
  const narrowTerms = uniqueStrings([...narrowSplit.primary, ...narrowSplit.spill]);
  const avoidTerms = uniqueStrings([...avoidSplit.primary, ...avoidSplit.spill]);
  const entityTerms = uniqueStrings([...entitySplit.primary, ...entitySplit.spill]);
  const actionTerms = uniqueStrings([...actionSplit.primary, ...actionSplit.spill]);
  const qualifierTerms = uniqueStrings([...qualifierSplit.primary, ...qualifierSplit.spill]);
  const noiseProneTerms = uniqueStrings([...noiseSplit.primary, ...noiseSplit.spill]);

  const mustTerms = normalizeAtomicTermList(entry?.must_terms || entry?.mustTerms, {
    allowLockedBigrams: false
  });
  const shouldTerms = normalizeAtomicTermList(entry?.should_terms || entry?.shouldTerms, {
    allowLockedBigrams: false
  });
  const legacyTerms = normalizeAtomicTermList(entry?.terms, {
    allowLockedBigrams: false
  });

  const normalizedBase = baseTerms.length
    ? baseTerms
    : uniqueStrings([...mustTerms, ...legacyTerms]).slice(0, 3);
  const normalizedSupport = supportTerms.length
    ? supportTerms
    : uniqueStrings([...shouldTerms, ...legacyTerms]).slice(0, 3);

  const avoidSet = new Set(uniqueStrings(avoidTerms).map((term) => term.toLowerCase()));
  const withoutAvoid = (items) => uniqueStrings(items).filter((term) => !avoidSet.has(term.toLowerCase()));

  return {
    base_terms: withoutAvoid(normalizedBase).slice(0, 3),
    support_terms: withoutAvoid(normalizedSupport).slice(0, 3),
    broad_terms: withoutAvoid(broadTerms).slice(0, 3),
    narrow_terms: withoutAvoid(narrowTerms).slice(0, 3),
    avoid_terms: uniqueStrings(avoidTerms).slice(0, 6),
    locked_bigrams: lockedBigrams.slice(0, 4),
    entity_terms: withoutAvoid(entityTerms).slice(0, 4),
    action_terms: withoutAvoid(actionTerms).slice(0, 4),
    qualifier_terms: withoutAvoid(qualifierTerms).slice(0, 4),
    noise_prone_terms: uniqueStrings(noiseProneTerms).slice(0, 6),
    exact_phrase_terms: [],
    must_terms: uniqueStrings(mustTerms).slice(0, 3),
    should_terms: uniqueStrings(shouldTerms).slice(0, 3),
    legacy_terms: uniqueStrings(legacyTerms).slice(0, 4)
  };
}

function pickFallbackAtomicTerm(...candidates) {
  for (const candidate of candidates) {
    const atoms = normalizeAtomicTermList([candidate], {
      allowLockedBigrams: false
    });
    if (atoms.length > 0) {
      return atoms[0];
    }
  }
  return "";
}

function countSearchableAtoms(text) {
  const words = splitWords(text);
  return words.filter((token) => token.length >= 2).length;
}

function featureActivationScore(meta) {
  let score = 0;
  if (meta.queryRole === "must") score += 150;
  if (meta.type === "anchor") score += 80;
  if (meta.type === "discriminator") score += 35;
  if (meta.type === "relation") score += 22;
  if (meta.type === "optional") score -= 20;
  if (meta.queryRole === "can_drop") score -= 28;
  score += (Number(meta.weight) || 0) * 12;

  const atomCount = countSearchableAtoms(meta.text);
  if (atomCount >= 1 && atomCount <= 4) score += 8;
  if (atomCount > 5) score -= 6;

  const len = asString(meta.text).length;
  if (len > 40) score -= 8;
  return score;
}

export function selectInitialActiveFeatureIds(featureSpec = [], options = {}) {
  const metaMap = getFeatureMetaMap(featureSpec);
  const all = Array.from(metaMap.values());
  const candidates = all.filter((meta) => meta.queryRole !== "can_drop" && meta.type !== "optional");
  const source = candidates.length ? candidates : all.filter((meta) => meta.queryRole !== "can_drop");
  if (!source.length) return [];

  const maxActive = clampInt(options.maxActive, 1, 5, 3);
  const minActive = clampInt(options.minActive, 1, maxActive, 2);
  const defaultTarget = source.length >= 3 ? 3 : Math.max(1, source.length);
  const target = Math.min(maxActive, Math.max(minActive, defaultTarget));

  const ordered = [...source].sort((a, b) => {
    const diff = featureActivationScore(b) - featureActivationScore(a);
    if (diff !== 0) return diff;
    return a.id.localeCompare(b.id);
  });

  return ordered.slice(0, target).map((meta) => meta.id);
}

function isLikelyOverSpecific(term) {
  const normalized = asString(term);
  if (!normalized) return false;
  const words = splitWords(normalized);
  if (words.length >= 4) return true;
  return normalized.length >= 30;
}

function selectFeatureTermsByPriority({
  mode,
  maxTerms = 1,
  baseTerms = [],
  supportTerms = [],
  broadTerms = [],
  narrowTerms = []
} = {}) {
  const out = [];
  const push = (items, limit = 1) => {
    if (!Array.isArray(items) || !items.length) return;
    let added = 0;
    for (const raw of items) {
      if (out.length >= maxTerms || added >= limit) break;
      const term = asString(raw);
      if (!term) continue;
      if (out.some((entry) => entry.toLowerCase() === term.toLowerCase())) continue;
      out.push(term);
      added += 1;
    }
  };

  const normalizedMode = asString(mode).toLowerCase();
  if (normalizedMode === "widen") {
    push(baseTerms, 1);
    push(broadTerms, 1);
    return uniqueStrings(out).slice(0, Math.max(1, maxTerms));
  }

  if (normalizedMode === "narrow") {
    push(baseTerms, 1);
    push(narrowTerms, 1);
    return uniqueStrings(out).slice(0, Math.max(1, maxTerms));
  }

  // initial / balanced default priority
  push(baseTerms, 1);
  push(supportTerms, 1);
  return uniqueStrings(out).slice(0, Math.max(1, maxTerms));
}

export function selectTermsForMode(featureMeta = {}, seedBuckets = {}, mode = "initial", options = {}) {
  const normalizedMode = String(mode || "initial").trim().toLowerCase();
  const buckets = normalizeSeedBuckets(seedBuckets || {});

  const lockedBigrams = uniqueStrings([
    ...(buckets.locked_bigrams || []),
    ...(options.phraseLockedTerms || [])
  ]);
  const avoidSet = new Set(uniqueStrings(buckets.avoid_terms).map((term) => term.toLowerCase()));

  const normalizeBucket = (items, { allowLockedBigrams = false } = {}) => {
    return normalizeAtomicTermList(items, {
      allowLockedBigrams,
      lockedBigrams
    }).filter((term) => !avoidSet.has(term.toLowerCase()));
  };

  const baseTerms = normalizeBucket(buckets.base_terms, { allowLockedBigrams: false });
  const supportTerms = normalizeBucket(buckets.support_terms, { allowLockedBigrams: false });
  const broadTerms = normalizeBucket(buckets.broad_terms, { allowLockedBigrams: false });
  const narrowTerms = normalizeBucket(buckets.narrow_terms, { allowLockedBigrams: false });
  const lockedTerms = normalizeBucket(lockedBigrams, { allowLockedBigrams: true });

  const isOptional = featureMeta.queryRole === "can_drop" || featureMeta.type === "optional";
  const isAnchorLike = featureMeta.queryRole === "must" || featureMeta.type === "anchor";
  const isFocus = options.isFocusFeature === true;
  const isBroadenTarget = options.includeBroad === true || options.isBroadenTarget === true;
  const isBalancedSupportFeature = options.includeSupport === true
    || options.isBalancedSupportFeature === true
    || options.includeBalancedSupport === true;

  if (options.active === false) {
    return {
      terms: [],
      phraseLockedTerms: lockedBigrams,
      simplificationApplied: false,
      dephrasedTerms: []
    };
  }

  if (normalizedMode === "initial" && isOptional) {
    return {
      terms: [],
      phraseLockedTerms: lockedBigrams,
      simplificationApplied: false,
      dephrasedTerms: []
    };
  }

  let maxPerFeature = 1;
  if (normalizedMode === "initial" && isAnchorLike) {
    maxPerFeature = 2;
  } else if (normalizedMode === "widen" && isBroadenTarget) {
    maxPerFeature = 2;
  } else if (normalizedMode === "narrow" && isFocus) {
    maxPerFeature = 2;
  } else if (normalizedMode === "balanced" && isBalancedSupportFeature) {
    maxPerFeature = 2;
  }

  let selected = [];
  if (normalizedMode === "widen") {
    selected = selectFeatureTermsByPriority({
      mode: "widen",
      maxTerms: maxPerFeature,
      baseTerms,
      broadTerms
    });
  } else if (normalizedMode === "narrow") {
    selected = selectFeatureTermsByPriority({
      mode: "narrow",
      maxTerms: maxPerFeature,
      baseTerms,
      narrowTerms
    });
    if (options.allowLockedBigrams === true && isFocus && selected.length < maxPerFeature) {
      selected = uniqueStrings([...selected, ...lockedTerms]).slice(0, maxPerFeature);
    }
  } else if (normalizedMode === "balanced") {
    selected = selectFeatureTermsByPriority({
      mode: "balanced",
      maxTerms: maxPerFeature,
      baseTerms,
      supportTerms
    });
  } else {
    selected = selectFeatureTermsByPriority({
      mode: "initial",
      maxTerms: maxPerFeature,
      baseTerms,
      supportTerms
    });
  }

  return {
    terms: uniqueStrings(selected).slice(0, maxPerFeature),
    phraseLockedTerms: uniqueStrings(lockedBigrams),
    simplificationApplied: false,
    dephrasedTerms: []
  };
}

export function normalizeQuerySeed(raw, featureSpec = [], options = {}) {
  const entries = Array.isArray(raw?.terms_by_feature) ? raw.terms_by_feature : [];
  const featureMetaById = getFeatureMetaMap(featureSpec);
  const featureIds = Array.from(featureMetaById.keys());

  const broadenSet = new Set(
    uniqueStrings(Array.isArray(options.broadenFeatureIds) ? options.broadenFeatureIds : [])
      .map((id) => id.toUpperCase())
  );
  const balancedSupportSet = new Set(
    uniqueStrings(Array.isArray(options.balancedSupportFeatureIds) ? options.balancedSupportFeatureIds : [])
      .map((id) => id.toUpperCase())
  );

  const activeInitialIds = new Set(
    Array.isArray(options.activeFeatureIds) && options.activeFeatureIds.length
      ? uniqueStrings(options.activeFeatureIds).map((id) => id.toUpperCase())
      : selectInitialActiveFeatureIds(featureSpec)
  );

  const seedByFeature = {};
  entries.forEach((entry) => {
    const featureId = asString(entry?.feature_id || entry?.featureId).toUpperCase();
    if (!featureId) return;
    if (featureIds.length > 0 && !featureMetaById.has(featureId)) return;
    seedByFeature[featureId] = normalizeSeedBuckets(entry);
  });

  featureIds.forEach((featureId) => {
    if (seedByFeature[featureId]) return;
    const meta = featureMetaById.get(featureId) || {};
    const fallbackAtom = pickFallbackAtomicTerm(
      meta.searchHint || meta.search_hint,
      meta.text,
      featureId
    ) || featureId;

    seedByFeature[featureId] = normalizeSeedBuckets({
      feature_id: featureId,
      base_terms: [fallbackAtom],
      support_terms: [],
      broad_terms: [],
      narrow_terms: [],
      avoid_terms: [],
      locked_bigrams: []
    });
  });

  const normalizedMode = String(options.mode || "initial").trim().toLowerCase();
  const phraseLockedTermsByFeature = {};
  const termsByFeature = {};
  const featureStateById = {};

  featureIds.forEach((featureId) => {
    const meta = featureMetaById.get(featureId) || {
      id: featureId,
      text: featureId,
      type: "optional",
      queryRole: "should",
      weight: 3,
      negative: false,
      searchHint: featureId
    };

    const buckets = seedByFeature[featureId] || normalizeSeedBuckets({ feature_id: featureId });
    const baseState = (options.featureStateById && options.featureStateById[featureId]) || {};
    const enabledDefault = meta.queryRole !== "can_drop";

    const activeDefault = normalizedMode === "initial"
      ? (activeInitialIds.has(featureId) && enabledDefault)
      : (baseState.active !== false && (baseState.enabled !== false));

    const selected = selectTermsForMode(meta, buckets, normalizedMode, {
      active: activeDefault,
      includeBroad: broadenSet.has(featureId),
      isBroadenTarget: broadenSet.has(featureId),
      includeSupport: balancedSupportSet.has(featureId),
      isBalancedSupportFeature: balancedSupportSet.has(featureId),
      isFocusFeature: asString(options.focusFeatureId).toUpperCase() === featureId,
      phraseLockedTerms: buckets.locked_bigrams,
      allowLockedBigrams: options.allowLockedBigrams === true
    });

    phraseLockedTermsByFeature[featureId] = uniqueStrings(selected.phraseLockedTerms || buckets.locked_bigrams || []);
    termsByFeature[featureId] = uniqueStrings(selected.terms);

    featureStateById[featureId] = {
      enabled: baseState.enabled !== false && enabledDefault,
      active: baseState.active === false ? false : activeDefault,
      core: meta.queryRole === "must",
      // text is kept for evaluation/debug context, not query rendering fallback.
      text: asString(baseState.text || meta.text || featureId),
      type: normalizeFeatureType(baseState.type || meta.type, meta.queryRole === "must" ? "anchor" : "optional"),
      weight: clampInt(baseState.weight ?? meta.weight, 1, 5, meta.queryRole === "must" ? 5 : 3),
      queryRole: normalizeQueryRole(baseState.queryRole || meta.queryRole, meta.queryRole || "should"),
      relationTo: uniqueStrings(baseState.relationTo || []),
      negative: baseState.negative === true || meta.negative === true,
      focus: baseState.focus === true,
      simplified: baseState.simplified === true || selected.simplificationApplied === true,
      phrase_locked_terms: uniqueStrings(baseState.phrase_locked_terms || selected.phraseLockedTerms || buckets.locked_bigrams || [])
    };
  });

  const lexical = enforceAtomicTermsByFeature(termsByFeature, phraseLockedTermsByFeature, {
    allowLockedBigrams: false
  });
  const collisionResolved = dedupeCrossFeatureTerms(lexical.termsByFeature, featureStateById);
  const canonicalTermsByFeature = {};
  Object.entries(collisionResolved.termsByFeature).forEach(([featureId, terms]) => {
    canonicalTermsByFeature[featureId] = uniqueStrings(terms.map((term) => canonicalizeAtomicTerm(term)).filter(Boolean));
  });

  return {
    termsByFeature: collisionResolved.termsByFeature,
    seedByFeature,
    phraseLockedTermsByFeature,
    featureStateById,
    termCollisions: collisionResolved.collisions,
    canonicalTermsByFeature,
    activeFeatureIds: uniqueStrings(Array.from(activeInitialIds)),
    notes: asString(raw?.notes)
  };
}

export function normalizeCitationEval(raw, featureIds = []) {
  const normalizedFeatureIds = uniqueStrings(featureIds).map((id) => id.toUpperCase());
  const featureSet = new Set(normalizedFeatureIds);
  const scoreRaw = asNumber(raw?.score);
  const score = scoreRaw === null ? null : Math.max(0, Math.min(100, Math.round(scoreRaw)));

  const clamp01 = (value) => {
    const parsed = asNumber(value);
    if (parsed === null) return null;
    if (parsed > 1 && parsed <= 100) {
      return Math.max(0, Math.min(1, parsed / 100));
    }
    return Math.max(0, Math.min(1, parsed));
  };

  const normalizeStatus = (value) => {
    const status = asString(value).toLowerCase();
    if (status === "exact" || status === "equivalent" || status === "partial" || status === "absent" || status === "conflict") {
      return status;
    }
    return "absent";
  };

  const normalizeEvidenceSource = (value) => {
    const source = asString(value).toLowerCase();
    if (source === "claim" || source === "description" || source === "title" || source === "unknown") {
      return source;
    }
    return "unknown";
  };

  const explicitFeatureHits = uniqueStrings(raw?.feature_hits || raw?.featureHits)
    .map((id) => id.toUpperCase())
    .filter((id) => !featureSet.size || featureSet.has(id));
  const explicitMissingFeatures = uniqueStrings(raw?.missing_features || raw?.missingFeatures)
    .map((id) => id.toUpperCase())
    .filter((id) => !featureSet.size || featureSet.has(id));

  const normalizeTermActions = (items) => {
    const out = [];
    (Array.isArray(items) ? items : []).forEach((entry) => {
      if (typeof entry === "string") {
        const term = asString(entry);
        if (!term) return;
        out.push({ featureId: "", term });
        return;
      }
      const featureId = asString(entry?.feature_id || entry?.featureId).toUpperCase();
      const term = asString(entry?.term || entry?.value);
      if (!term) return;
      if (featureSet.size && featureId && !featureSet.has(featureId)) return;
      out.push({ featureId, term });
    });
    return out;
  };

  const judgmentsRaw = Array.isArray(raw?.feature_judgments || raw?.featureJudgments)
    ? (raw.feature_judgments || raw.featureJudgments)
    : [];
  const featureJudgments = [];
  const seenJudgmentKeys = new Set();
  judgmentsRaw.forEach((entry) => {
    const featureId = asString(entry?.feature_id || entry?.featureId).toUpperCase();
    if (!featureId) return;
    if (featureSet.size && !featureSet.has(featureId)) return;

    const status = normalizeStatus(entry?.status);
    const evidenceText = asString(entry?.evidence_text || entry?.evidenceText);
    const evidenceSource = normalizeEvidenceSource(entry?.evidence_source || entry?.evidenceSource);
    const confidenceRaw = clamp01(entry?.confidence);
    const confidence = confidenceRaw === null
      ? (status === "exact" ? 0.85 : (status === "equivalent" ? 0.72 : (status === "partial" ? 0.55 : 0.5)))
      : confidenceRaw;

    const dedupeKey = `${featureId}::${status}::${evidenceText}`;
    if (seenJudgmentKeys.has(dedupeKey)) return;
    seenJudgmentKeys.add(dedupeKey);

    featureJudgments.push({
      featureId,
      status,
      evidenceText,
      evidenceSource,
      confidence
    });
  });

  if (!featureJudgments.length) {
    explicitFeatureHits.forEach((featureId) => {
      featureJudgments.push({
        featureId,
        status: "exact",
        evidenceText: "",
        evidenceSource: "unknown",
        confidence: 0.6
      });
    });
    explicitMissingFeatures.forEach((featureId) => {
      featureJudgments.push({
        featureId,
        status: "absent",
        evidenceText: "",
        evidenceSource: "unknown",
        confidence: 0.6
      });
    });
  }

  const derivedHitSet = new Set();
  const derivedMissingSet = new Set();
  featureJudgments.forEach((entry) => {
    if (entry.status === "exact" || entry.status === "equivalent" || entry.status === "partial") {
      derivedHitSet.add(entry.featureId);
      return;
    }
    if (entry.status === "absent" || entry.status === "conflict") {
      derivedMissingSet.add(entry.featureId);
    }
  });

  let featureHits = featureJudgments.length
    ? uniqueStrings(Array.from(derivedHitSet))
    : explicitFeatureHits;
  if (!featureHits.length) {
    featureHits = explicitFeatureHits;
  }

  let missingFeatures = featureJudgments.length
    ? uniqueStrings(Array.from(derivedMissingSet))
    : explicitMissingFeatures;
  if (!missingFeatures.length) {
    missingFeatures = explicitMissingFeatures;
  }

  if (featureSet.size && !missingFeatures.length) {
    const hitSet = new Set(featureHits);
    missingFeatures = normalizedFeatureIds.filter((featureId) => !hitSet.has(featureId));
  }
  const hitSet = new Set(featureHits);
  missingFeatures = missingFeatures.filter((featureId) => !hitSet.has(featureId));

  const addTerms = normalizeTermActions(raw?.add_terms || raw?.addTerms);
  const removeTerms = normalizeTermActions(raw?.remove_terms || raw?.removeTerms);

  const noisyTerms = uniqueStrings([
    ...(raw?.noisy_terms || raw?.noisyTerms || []),
    ...removeTerms.map((entry) => entry.term)
  ]);
  const fieldSimilarity = clamp01(raw?.field_similarity || raw?.fieldSimilarity);
  const pairFillValue = clamp01(raw?.pair_fill_value || raw?.pairFillValue);
  const conflictFlags = uniqueStrings(raw?.conflict_flags || raw?.conflictFlags);

  let reason = asString(raw?.reason);
  if (!reason) {
    const counts = {
      exact: 0,
      equivalent: 0,
      partial: 0,
      absent: 0,
      conflict: 0
    };
    featureJudgments.forEach((entry) => {
      if (counts[entry.status] !== undefined) counts[entry.status] += 1;
    });
    reason = `exact ${counts.exact}, equivalent ${counts.equivalent}, partial ${counts.partial}, absent ${counts.absent}, conflict ${counts.conflict}`;
  }

  return {
    score,
    reason,
    featureJudgments,
    featureHits,
    missingFeatures,
    noisyTerms,
    fieldSimilarity,
    pairFillValue,
    conflictFlags,
    addTerms,
    removeTerms
  };
}

export function normalizeQueryRefine(raw, featureIds = []) {
  const featureSet = new Set(featureIds.map((id) => asString(id).toUpperCase()));
  const modeRaw = asString(raw?.mode || raw?.strategy).toLowerCase();
  const mode = modeRaw === "widen" || modeRaw === "narrow" || modeRaw === "rebuild"
    ? modeRaw
    : "balanced";
  const queryExpression = asString(raw?.query_expression || raw?.queryExpression);

  const coerceTermList = (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === "string" || typeof value === "number") return [value];
    if (value && typeof value === "object") {
      if (Array.isArray(value.terms)) return value.terms;
      if (Array.isArray(value.list)) return value.list;
      if (Array.isArray(value.values)) return value.values;
      if (typeof value.term === "string" || typeof value.term === "number") return [value.term];
      if (typeof value.text === "string" || typeof value.text === "number") return [value.text];
      if (typeof value.value === "string" || typeof value.value === "number") return [value.value];
    }
    return [];
  };

  const coerceFeatureActions = () => {
    if (Array.isArray(raw?.feature_actions)) return raw.feature_actions;
    if (Array.isArray(raw?.featureActions)) return raw.featureActions;
    const source = raw?.feature_actions && typeof raw.feature_actions === "object"
      ? raw.feature_actions
      : (raw?.featureActions && typeof raw.featureActions === "object" ? raw.featureActions : null);
    if (!source) return [];
    return Object.entries(source).map(([featureId, entry]) => ({
      feature_id: featureId,
      ...(entry && typeof entry === "object" ? entry : { replace_terms: coerceTermList(entry) })
    }));
  };

  const featureActions = [];
  coerceFeatureActions().forEach((entry) => {
    const featureId = asString(entry?.feature_id || entry?.featureId).toUpperCase();
    if (!featureId || (featureSet.size && !featureSet.has(featureId))) return;

    let replaceTerms = normalizeAtomicTermList(coerceTermList(entry?.replace_terms || entry?.replaceTerms), {
      allowLockedBigrams: false
    });
    let addTerms = normalizeAtomicTermList(coerceTermList(entry?.add_terms || entry?.addTerms), {
      allowLockedBigrams: false
    });
    let removeTerms = normalizeAtomicTermList(coerceTermList(entry?.remove_terms || entry?.removeTerms), {
      allowLockedBigrams: false
    });
    let disableFeature = !!(entry?.disable_feature ?? entry?.disableFeature);
    let enableFeature = !!(entry?.enable_feature ?? entry?.enableFeature);
    const actionType = asString(entry?.type || entry?.action_type || entry?.actionType).toLowerCase();
    const actionTerms = normalizeAtomicTermList(
      coerceTermList(entry?.terms || entry?.term || entry?.values || entry?.list),
      { allowLockedBigrams: false }
    );

    if (actionType === "remove_all" || actionType === "drop" || actionType === "disable") {
      disableFeature = true;
      enableFeature = false;
      replaceTerms = [];
      addTerms = [];
      removeTerms = [];
    } else if (actionType === "keep") {
      replaceTerms = [];
      addTerms = [];
      removeTerms = [];
      disableFeature = false;
      enableFeature = false;
    } else if ((actionType === "replace" || actionType === "swap") && replaceTerms.length === 0 && actionTerms.length > 0) {
      replaceTerms = actionTerms.slice(0, 2);
    } else if (actionType === "add" && addTerms.length === 0 && actionTerms.length > 0) {
      addTerms = actionTerms.slice(0, 2);
    } else if (actionType === "remove" && removeTerms.length === 0 && actionTerms.length > 0) {
      removeTerms = actionTerms.slice(0, 2);
    }

    featureActions.push({
      featureId,
      replaceTerms,
      addTerms,
      removeTerms,
      disableFeature,
      enableFeature,
      promoteToRequired: !!(entry?.promote_to_required ?? entry?.promoteToRequired),
      simplifyFirst: !!(entry?.simplify_first ?? entry?.simplifyFirst)
    });
  });

  const finalTermsByFeatureRaw = raw?.final_terms_by_feature && typeof raw.final_terms_by_feature === "object"
    ? raw.final_terms_by_feature
    : (raw?.finalTermsByFeature && typeof raw.finalTermsByFeature === "object" ? raw.finalTermsByFeature : {});

  const finalTermsByFeature = {};
  Object.entries(finalTermsByFeatureRaw).forEach(([featureIdRaw, terms]) => {
    const featureId = asString(featureIdRaw).toUpperCase();
    if (!featureId || (featureSet.size && !featureSet.has(featureId))) return;
    const normalizedTerms = normalizeAtomicTermList(coerceTermList(terms), {
      allowLockedBigrams: false
    }).slice(0, 2);
    if (!normalizedTerms.length) return;
    finalTermsByFeature[featureId] = normalizedTerms;
  });

  const lexical = enforceAtomicTermsByFeature(finalTermsByFeature, {}, {
    allowLockedBigrams: false
  });
  const collisionResolved = dedupeCrossFeatureTerms(lexical.termsByFeature, {});
  const canonicalTermsByFeature = {};
  Object.entries(collisionResolved.termsByFeature).forEach(([featureId, terms]) => {
    canonicalTermsByFeature[featureId] = uniqueStrings(terms.map((term) => canonicalizeAtomicTerm(term)).filter(Boolean));
  });

  const splitFeaturePlans = [];
  (Array.isArray(raw?.split_feature_plans) ? raw.split_feature_plans : (Array.isArray(raw?.splitFeaturePlans) ? raw.splitFeaturePlans : []))
    .forEach((entry) => {
      if (!entry || typeof entry !== "object") return;
      const featureId = asString(entry?.feature_id || entry?.featureId).toUpperCase();
      if (!featureId || (featureSet.size && !featureSet.has(featureId))) return;
      const groups = (Array.isArray(entry?.groups) ? entry.groups : [])
        .map((group) => {
          if (!group || typeof group !== "object") return null;
          const groupRole = asString(group?.group_role || group?.groupRole).toLowerCase();
          const terms = normalizeAtomicTermList(group?.terms, {
            allowLockedBigrams: false
          }).slice(0, 2);
          if (!terms.length) return null;
          return {
            groupRole: groupRole || "micro_entity",
            terms
          };
        })
        .filter(Boolean);
      if (!groups.length) return;
      splitFeaturePlans.push({
        featureId,
        groups
      });
    });

  const antiNoiseTerms = normalizeAtomicTermList(raw?.anti_noise_terms || raw?.antiNoiseTerms || [], {
    allowLockedBigrams: false
  }).slice(0, 8);

  return {
    mode,
    queryExpression,
    featureActions,
    finalTermsByFeature: collisionResolved.termsByFeature,
    finalCanonicalTermsByFeature: canonicalTermsByFeature,
    termCollisions: collisionResolved.collisions,
    promoteFeatureIds: uniqueStrings(raw?.promote_feature_ids || raw?.promoteFeatureIds)
      .map((id) => id.toUpperCase())
      .filter((id) => !featureSet.size || featureSet.has(id)),
    dropFeatureIds: uniqueStrings(raw?.drop_feature_ids || raw?.dropFeatureIds)
      .map((id) => id.toUpperCase())
      .filter((id) => !featureSet.size || featureSet.has(id)),
    dephraseTerms: normalizeAtomicTermList(raw?.dephrase_terms || raw?.dephraseTerms, {
      allowLockedBigrams: false
    }),
    dropGroupIds: uniqueStrings(raw?.drop_group_ids || raw?.dropGroupIds),
    splitFeaturePlans,
    antiNoiseTerms,
    countStrategyNote: asString(raw?.count_strategy_note || raw?.countStrategyNote),
    rebuildRequired: !!raw?.rebuild_required,
    notes: asString(raw?.notes)
  };
}


