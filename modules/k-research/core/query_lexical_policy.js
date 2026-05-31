function extractTermText(value) {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (value && typeof value === "object") {
    return String(value.text ?? value.term ?? value.value ?? "");
  }
  return "";
}

function asString(value) {
  return extractTermText(value).trim();
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

function hasOperatorOrQuote(text) {
  return /[&|()+"]/.test(String(text || ""));
}

function sanitizeLexicalText(text) {
  return String(text || "")
    .replace(/[&|()+"]/g, " ")
    .replace(/[^\p{L}\p{N}\s_\-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTokens(text) {
  return sanitizeLexicalText(text)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

const KNOWN_KOREAN_ATOM_PARTS = [
  "이벤트",
  "임베딩",
  "검색",
  "특허",
  "심사",
  "지원",
  "보정",
  "피드백",
  "분석",
  "쿼리",
  "문헌",
  "청구항",
  "구성",
  "판단",
  "평가",
  "추천",
  "분류",
  "탐지",
  "인식",
  "생성",
  "요약",
  "유사도",
  "벡터",
  "모델",
  "학습",
  "추론",
  "자동",
  "반복",
  "관계",
  "판정",
  "결과",
  "기술",
  "용어",
  "핵심",
  "누락",
  "차이",
  "근거",
  "증거",
  "진보성",
  "거절",
  "인용",
  "발명",
  "문서",
  "초록",
  "설명",
  "항목",
  "기능",
  "구조",
  "제어",
  "신호",
  "센서",
  "회로",
  "장치",
  "시스템",
  "데이터",
  "패턴",
  "클러스터",
  "노이즈",
  "정밀",
  "확장",
  "축소",
  "가중치",
  "필터",
  "정렬",
  "요소"
];

const KNOWN_KOREAN_ATOM_SET = new Set(KNOWN_KOREAN_ATOM_PARTS);
const KNOWN_KOREAN_ATOM_PARTS_DESC = [...KNOWN_KOREAN_ATOM_PARTS]
  .sort((left, right) => right.length - left.length);

function isHangulOnlyToken(token) {
  return /^[가-힣]+$/u.test(String(token || "").trim());
}

function segmentWithKnownKoreanParts(token) {
  const src = String(token || "").trim();
  if (!src || !isHangulOnlyToken(src) || KNOWN_KOREAN_ATOM_SET.has(src)) {
    return [src].filter(Boolean);
  }

  const parts = [];
  let cursor = 0;
  while (cursor < src.length) {
    let matched = "";
    for (const candidate of KNOWN_KOREAN_ATOM_PARTS_DESC) {
      if (!candidate) continue;
      if (src.startsWith(candidate, cursor)) {
        matched = candidate;
        break;
      }
    }
    if (!matched) return [src];
    parts.push(matched);
    cursor += matched.length;
  }

  return parts.length >= 2 ? parts : [src];
}

function splitKoreanCompoundToken(token) {
  const src = String(token || "").trim();
  if (!src || src.length < 4 || !isHangulOnlyToken(src)) {
    return [src].filter(Boolean);
  }

  const segmented = segmentWithKnownKoreanParts(src);
  if (segmented.length >= 2) return segmented;

  // Conservative boundary fallback:
  // only split when both sides are reasonably long and at least one side is known.
  for (let index = 2; index <= src.length - 2; index += 1) {
    const left = src.slice(0, index);
    const right = src.slice(index);
    if (!left || !right) continue;
    if (left.length < 2 || right.length < 2) continue;
    const leftKnown = KNOWN_KOREAN_ATOM_SET.has(left);
    const rightKnown = KNOWN_KOREAN_ATOM_SET.has(right);
    if (!(leftKnown || rightKnown)) continue;
    return [left, right];
  }
  return [src];
}

function isSearchableToken(token) {
  const value = asString(token);
  if (!value) return false;
  if (!/[\p{L}\p{N}]/u.test(value)) return false;
  if (value.length >= 2) return true;
  return /^[A-Za-z0-9]$/u.test(value);
}

function normalizeBigramText(term) {
  return splitTokens(term).slice(0, 2).join(" ").trim();
}

function buildLockedBigramSet(lockedBigrams = []) {
  return new Set(
    uniqueStrings(lockedBigrams)
      .map((term) => normalizeBigramText(term))
      .filter((term) => term.split(/\s+/).length === 2)
      .map((term) => term.toLowerCase())
  );
}

export function isSingleWordTerm(term) {
  const tokens = splitTokens(term);
  return tokens.length === 1 && isSearchableToken(tokens[0]);
}

export function normalizeAtomicTerm(term) {
  const tokens = splitTokens(term);
  if (tokens.length !== 1) return "";
  const token = tokens[0];
  if (!isSearchableToken(token)) return "";
  return token;
}

export function validateAtomicTerm(term, { lockedBigrams = [] } = {}) {
  const source = asString(term);
  if (!source) {
    return { valid: false, normalized: "", reason: "empty", isLockedBigram: false };
  }

  if (hasOperatorOrQuote(source)) {
    return { valid: false, normalized: "", reason: "contains_operator_or_quote", isLockedBigram: false };
  }

  if (isSingleWordTerm(source)) {
    return { valid: true, normalized: normalizeAtomicTerm(source), reason: "", isLockedBigram: false };
  }

  const tokens = splitTokens(source);
  if (tokens.length === 2) {
    const normalizedBigram = tokens.join(" ");
    const lockedSet = buildLockedBigramSet(lockedBigrams);
    const isLocked = lockedSet.has(normalizedBigram.toLowerCase());
    if (isLocked) {
      return { valid: true, normalized: normalizedBigram, reason: "", isLockedBigram: true };
    }
    return { valid: false, normalized: "", reason: "unlocked_bigram", isLockedBigram: false };
  }

  return {
    valid: false,
    normalized: "",
    reason: tokens.length >= 3 ? "too_many_words" : "invalid_token",
    isLockedBigram: false
  };
}

export function normalizeAtomicTermList(terms, { allowLockedBigrams = false, lockedBigrams = [] } = {}) {
  const out = [];
  const lockedSet = buildLockedBigramSet(lockedBigrams);
  (Array.isArray(terms) ? terms : []).forEach((entry) => {
    const source = asString(entry);
    if (!source) return;
    if (hasOperatorOrQuote(source)) {
      splitTokens(source).forEach((token) => out.push(token));
      return;
    }

    const tokens = splitTokens(source);
    if (!tokens.length) return;

    if (tokens.length === 1) {
      const normalizedToken = tokens[0];
      const decomposed = splitKoreanCompoundToken(normalizedToken);
      if (decomposed.length >= 2) {
        decomposed.forEach((token) => out.push(token));
      } else {
        out.push(normalizedToken);
      }
      return;
    }

    if (tokens.length === 2) {
      const joined = tokens.join(" ");
      if (allowLockedBigrams && lockedSet.has(joined.toLowerCase())) {
        out.push(joined);
        return;
      }
    }

    tokens.forEach((token) => out.push(token));
  });

  return uniqueStrings(out.filter(isSearchableToken));
}

export function enforceAtomicTermsByFeature(termsByFeature, lockedBigramsByFeature = {}, options = {}) {
  const next = {};
  const violations = [];
  const allowLocked = options.allowLockedBigrams !== false;

  Object.entries(termsByFeature || {}).forEach(([featureIdRaw, terms]) => {
    const featureId = asString(featureIdRaw).toUpperCase();
    if (!featureId) return;
    const lockedBigrams = Array.isArray(lockedBigramsByFeature?.[featureId])
      ? lockedBigramsByFeature[featureId]
      : [];

    const normalizedTerms = normalizeAtomicTermList(terms, {
      allowLockedBigrams: allowLocked,
      lockedBigrams
    });

    const sourceList = Array.isArray(terms) ? terms : [];
    sourceList.forEach((term) => {
      const result = validateAtomicTerm(term, { lockedBigrams });
      if (result.valid) return;
      violations.push({
        featureId,
        term: asString(term),
        reason: result.reason
      });
    });

    next[featureId] = normalizedTerms;
  });

  return {
    termsByFeature: next,
    violations
  };
}

export function summarizeLexicalViolations(violations) {
  const items = Array.isArray(violations) ? violations : [];
  if (!items.length) return "no lexical violations";
  const top = items.slice(0, 8).map((entry) => `${entry.featureId}:${entry.term}(${entry.reason})`);
  return top.join(", ");
}
