const MAX_NEAR_DISTANCE = 100;
const MAX_TOKEN_PARTS = 2;

function hasBalancedParentheses(text) {
  let balance = 0;
  for (const char of text) {
    if (char === "(") balance += 1;
    if (char === ")") balance -= 1;
    if (balance < 0) return false;
  }
  return balance === 0;
}

function hasBalancedQuotes(text) {
  const quoteCount = (text.match(/"/g) || []).length;
  return quoteCount % 2 === 0;
}

function stripQuotedSegments(text) {
  return String(text || "").replace(/"[^"]*"/g, " ");
}

function inspectNearTokens(text) {
  const angleTokens = text.match(/<[^>]*>/gi) || [];
  const nearStarts = (text.match(/<near\//gi) || []).length;
  const capturedNearTokens = text.match(/<near\/[^>]*>/gi) || [];
  const malformedNearStart = nearStarts !== capturedNearTokens.length;

  let hasInvalidToken = malformedNearStart;
  let hasOutOfRange = false;

  for (const token of angleTokens) {
    if (!/^<near\/\d+>$/i.test(token)) {
      hasInvalidToken = true;
      continue;
    }
    const value = Number.parseInt(token.slice(6, -1), 10);
    if (!Number.isFinite(value) || value < 1 || value > MAX_NEAR_DISTANCE) {
      hasOutOfRange = true;
    }
  }

  return { hasInvalidToken, hasOutOfRange };
}

function tokenizeQuery(text) {
  const tokens = [];
  const tokenRegex = /<near\/\d+>|[()&|]|"[^"]*"|[^()\s&|]+/gi;
  let match = tokenRegex.exec(text);
  while (match) {
    tokens.push(match[0]);
    match = tokenRegex.exec(text);
  }
  return tokens;
}

function hasOverlongPlusTerms(text) {
  const withoutQuoted = stripQuotedSegments(text);
  const termTokens = withoutQuoted.match(/[^()\s&|]+/g) || [];
  for (const token of termTokens) {
    if (/^<near\/\d+>$/i.test(token)) continue;
    if (!token.includes("+")) continue;
    const parts = token.split("+").map((part) => part.trim()).filter(Boolean);
    if (parts.length > MAX_TOKEN_PARTS) return true;
  }
  return false;
}

function classifyToken(token) {
  if (token === "(") return "lparen";
  if (token === ")") return "rparen";
  if (token === "&" || token === "|" || /^<near\/\d+>$/i.test(token)) return "operator";
  return "term";
}

function validateTokenFlow(text) {
  const tokens = tokenizeQuery(text);
  if (tokens.length === 0) return { ok: false, reason: "empty query" };

  let expectOperand = true;
  let depth = 0;

  for (const token of tokens) {
    const type = classifyToken(token);

    if (type === "lparen") {
      if (!expectOperand) return { ok: false, reason: "missing operator before '('" };
      depth += 1;
      expectOperand = true;
      continue;
    }

    if (type === "rparen") {
      if (expectOperand) return { ok: false, reason: "empty group or dangling operator before ')'" };
      depth -= 1;
      if (depth < 0) return { ok: false, reason: "unbalanced parentheses" };
      expectOperand = false;
      continue;
    }

    if (type === "operator") {
      if (expectOperand) return { ok: false, reason: `operator '${token}' in invalid position` };
      expectOperand = true;
      continue;
    }

    if (!expectOperand) {
      return { ok: false, reason: "missing operator between terms/groups" };
    }
    expectOperand = false;
  }

  if (expectOperand) return { ok: false, reason: "query ends with operator" };
  if (depth !== 0) return { ok: false, reason: "unbalanced parentheses" };
  return { ok: true, reason: "" };
}

export function basicValidate(query) {
  const errors = [];
  const pushError = (message) => {
    if (!errors.includes(message)) errors.push(message);
  };

  if (!query || !query.trim()) {
    pushError("empty query");
    return { ok: false, errors };
  }

  const withoutQuoted = stripQuotedSegments(query);
  if (/\b(?:AND|OR|NOT)\b/i.test(withoutQuoted)) {
    pushError("forbidden boolean words");
  }

  if (!hasBalancedQuotes(query)) {
    pushError("unbalanced double quotes");
  }

  if (!hasBalancedParentheses(query)) {
    pushError("unbalanced parentheses");
  }

  if (/\(\s*\)/.test(query)) {
    pushError("empty parentheses group");
  }

  const nearInspection = inspectNearTokens(query);
  if (nearInspection.hasInvalidToken) {
    pushError("invalid <near/n> syntax");
  }
  if (nearInspection.hasOutOfRange) {
    pushError(`near distance out of range (1-${MAX_NEAR_DISTANCE})`);
  }
  if (hasOverlongPlusTerms(query)) {
    pushError(`token composition too long (max ${MAX_TOKEN_PARTS} parts)`);
  }

  const flow = validateTokenFlow(query);
  if (!flow.ok) {
    pushError(flow.reason);
  }

  return { ok: errors.length === 0, errors };
}
