const MAX_TOKEN_PARTS = 2;

function sanitizeTerm(term) {
  return String(term || "").replace(/\"/g, "").replace(/\s+/g, " ").trim();
}

function normalizeMatch(raw) {
  if (!raw) return null;
  const value = String(raw).trim().toLowerCase();
  if (!value) return null;
  if (value === "phrase" || value === "exact" || value === "quoted") return "phrase";
  if (value === "token" || value === "near" || value === "and") return "token";
  return null;
}

function normalizeParts(parts) {
  if (!Array.isArray(parts)) return [];
  return parts.map((part) => sanitizeTerm(part)).filter(Boolean);
}

function countTermTokens(term) {
  return String(term || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .length;
}

function isBaseElementTerm(term, element) {
  const baseTerm = sanitizeTerm(element?.term || "");
  return !!baseTerm && baseTerm === term;
}

export function formatSynonymForQuery(item, element) {
  const resolved = typeof item === "string" ? { term: item } : item || {};
  const term = sanitizeTerm(resolved.term || "");
  if (!term) return null;
  const match = normalizeMatch(resolved.match);
  const parts = normalizeParts(resolved.parts);
  const isBaseTerm = isBaseElementTerm(term, element);

  if (match === "phrase") {
    return `"${term}"`;
  }

  if (parts.length > MAX_TOKEN_PARTS) {
    return `"${term}"`;
  }

  if (match === "token" && !isBaseTerm && parts.length > 0) {
    return parts.join("+");
  }

  if (countTermTokens(term) > 1) {
    // Policy: no whitespace-based '+' inference; default to phrase for raw multi-word terms.
    return `"${term}"`;
  }

  if (match === "token") {
    return term;
  }

  if (!isBaseTerm && match !== "token" && parts.length > 0) {
    // Keep validation-compatible handling, but only explicit token+parts produces '+'.
    return term;
  }

  return term;
}

function formatSynonym(item, element) {
  const formatted = formatSynonymForQuery(item, element);
  if (!formatted) return null;
  return formatted;
}

function buildGroup(element, synonyms) {
  const formatted = [];
  const seen = new Set();

  for (const item of synonyms) {
    const value = formatSynonym(item, element);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    formatted.push(value);
  }

  if (formatted.length === 0) return "";
  if (formatted.length === 1) return `(${formatted[0]})`;
  return `(${formatted.join(" | ")})`;
}

export function buildQuery({ elements, relations, synonymsById, nearDistance = 3 }) {
  // NOTE:
  // We keep `relations` and `nearDistance` in signature for compatibility,
  // but inter-element composition is now AND-only by product policy.
  void relations;
  void nearDistance;

  const groupById = {};
  for (const element of elements) {
    const synonyms = synonymsById[element.id] || [];
    const group = buildGroup(element, synonyms);
    if (group) groupById[element.id] = group;
  }

  const expressionParts = [];

  for (const element of elements) {
    const group = groupById[element.id];
    if (group) expressionParts.push(group);
  }

  if (expressionParts.length === 0) return "";
  if (expressionParts.length === 1) return expressionParts[0];
  return expressionParts.join(" & ");
}
