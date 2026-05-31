// background.js

const SENTINEL_DIGITS = 4;
const DEFAULT_SENTINEL_CHUNK_SIZE = 400;
const DEFAULT_SENTINEL_CHUNK_OVERFLOW = Math.round(DEFAULT_SENTINEL_CHUNK_SIZE * 0.2);
const MIN_CONTENT_LENGTH = 50;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'OPEN_DASHBOARD') {
    chrome.tabs.create({ url: 'modules/k-larc/dashboard.html' });
  } else if (request.type === 'GET_TABS') {
    getTabs(sendResponse);
    return true;
  } else if (request.type === 'EXTRACT_AND_UPLOAD') {
    handleExtractAndUpload(
      request.tabId,
      request.baseUrl,
      request.apiKey,
      sendResponse,
      {
        chunkSize: request.chunkSize,
        chunkOverflow: request.chunkOverflow
      }
    );
    return true;
  } else if (request.type === 'CHECK_STATUS') {
    checkFileStatus(request.fileId, request.baseUrl, request.apiKey, sendResponse);
    return true;
  } else if (request.type === 'ANALYZE_CLAIM') {
    analyzeClaim(request.payload, request.baseUrl, request.apiKey, sendResponse);
    return true;
  } else if (request.type === 'DELETE_FILE') {
    deleteFile(request.fileId, request.baseUrl, request.apiKey, sendResponse);
    return true;
  } else if (request.type === 'DIRECT_UPLOAD') {
    handleDirectUpload(request.text, request.filename, request.baseUrl, request.apiKey, sendResponse);
    return true;
  }

  return undefined;
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: 'modules/k-larc/dashboard.html' });
});

function getTabs(sendResponse) {
  chrome.tabs.query({}, (tabs) => {
    const validTabs = (tabs || []).filter((tab) =>
      tab?.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))
    );
    sendResponse(validTabs);
  });
}

function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function toHalfWidthDigits(value) {
  return String(value || '').replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0));
}

function decodeHtmlEntities(value) {
  const source = String(value || '');
  if (!source) return '';

  return source
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => {
      const parsed = Number.parseInt(hex, 16);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : '';
    })
    .replace(/&#([0-9]+);?/g, (_, dec) => {
      const parsed = Number.parseInt(dec, 10);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : '';
    });
}

function decodeHtmlEntitiesDeep(value, maxRound = 3) {
  let current = String(value || '');

  for (let index = 0; index < maxRound; index += 1) {
    const next = decodeHtmlEntities(current);
    if (next === current) break;
    current = next;
  }

  return current;
}

function decodeJsStringLiteral(rawLiteral, quote = "'") {
  const source = String(rawLiteral || '');
  if (!source) return '';

  let result = '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char !== '\\') {
      result += char;
      continue;
    }

    const next = source[index + 1];
    if (next === undefined) break;

    if (next === 'n') {
      result += '\n';
      index += 1;
      continue;
    }
    if (next === 'r') {
      result += '\r';
      index += 1;
      continue;
    }
    if (next === 't') {
      result += '\t';
      index += 1;
      continue;
    }
    if (next === '\\' || next === "'" || next === '"') {
      result += next;
      index += 1;
      continue;
    }
    if (next === 'x') {
      const hex = source.slice(index + 2, index + 4);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        result += String.fromCharCode(Number.parseInt(hex, 16));
        index += 3;
        continue;
      }
    }
    if (next === 'u') {
      const unicode = source.slice(index + 2, index + 6);
      if (/^[0-9a-fA-F]{4}$/.test(unicode)) {
        result += String.fromCharCode(Number.parseInt(unicode, 16));
        index += 5;
        continue;
      }
    }

    result += next;
    index += 1;
  }

  if (quote === '"' || quote === "'") {
    return result.replace(new RegExp(`\\\\${quote}`, 'g'), quote);
  }
  return result;
}

function decodeJsStringExpression(expression) {
  const source = String(expression || '').trim();
  if (!source) return '';

  const literalRegex = /(['"])((?:\\.|(?!\1)[\s\S])*)\1/g;
  const parts = [];
  let match;

  while ((match = literalRegex.exec(source)) !== null) {
    const quote = match[1];
    const inner = match[2];
    parts.push(decodeJsStringLiteral(inner, quote));
  }

  return parts.join('');
}

function getEvalConvDocumentWriteRegex() {
  return /document\.write\s*\(\s*eval_convHalfCharToFullChar\s*\(\s*((?:(?:'[^'\\]*(?:\\.[^'\\]*)*')|(?:"[^"\\]*(?:\\.[^"\\]*)*"))(?:\s*\+\s*(?:(?:'[^'\\]*(?:\\.[^'\\]*)*')|(?:"[^"\\]*(?:\\.[^"\\]*)*")))*)\s*\)\s*\)\s*;?/gi;
}

function decodeEvalConvHalfCharScript(scriptBody) {
  const source = decodeHtmlEntitiesDeep(scriptBody);
  if (!source) return '';

  const results = [];
  const callRegex = getEvalConvDocumentWriteRegex();

  let match;
  while ((match = callRegex.exec(source)) !== null) {
    const rawArg = String(match[1] || '').trim();
    const decodedLiteral = decodeJsStringExpression(rawArg);
    const decodedEntity = decodeHtmlEntitiesDeep(decodedLiteral);

    if (decodedEntity) {
      results.push(decodedEntity);
    }
  }

  return normalizeWhitespace(results.join(' '));
}

function decodeKnownPatentScripts(value) {
  let source = decodeHtmlEntitiesDeep(value);
  if (!source) return '';

  source = source.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (_, body) => {
      const decoded = decodeEvalConvHalfCharScript(body);
      if (decoded) return ` ${decoded} `;
      return ' ';
    });

  source = source.replace(getEvalConvDocumentWriteRegex(), (_, rawArg) => {
    const decoded = decodeHtmlEntitiesDeep(decodeJsStringExpression(rawArg));
    return decoded ? ` ${decoded} ` : ' ';
  });

  return source
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ');
}

function removeResidualScriptArtifacts(value) {
  return String(value || '')
    .replace(/document\.write\s*\([\s\S]*?\)\s*;?/gi, ' ')
    .replace(/eval_convHalfCharToFullChar\s*\([\s\S]*?\)\s*;?/gi, ' ')
    .replace(/<\/?script\b[^>]*>/gi, ' ');
}

function stripMarkupText(value, options = {}) {
  const removeStructuralBlocks = options.removeStructuralBlocks !== false;
  let working = decodeHtmlEntitiesDeep(value);
  working = decodeKnownPatentScripts(working);
  working = String(working || '').replace(/<!--[\s\S]*?-->/g, ' ');
  working = working.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  working = removeResidualScriptArtifacts(working);
  working = working.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  working = working.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ');
  if (removeStructuralBlocks) {
    working = working.replace(/<(nav|header|footer|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  }
  working = working.replace(/<[^>]*>/g, ' ');
  working = decodeHtmlEntitiesDeep(working);
  working = removeResidualScriptArtifacts(working);
  return normalizeWhitespace(working);
}

function looksLikeScriptArtifact(text) {
  const source = normalizeWhitespace(text);
  if (!source) return false;
  if (/document\.write\s*\(/i.test(source)) return true;
  if (/eval_convHalfCharToFullChar/i.test(source)) return true;

  const words = source.match(/[A-Za-z0-9가-힣]+/g) || [];
  const wordCount = words.length;
  const scriptKeywordCount = (source.match(/\b(function|var|return|document|write|eval|script)\b/gi) || []).length;
  const punctuationCount = (source.match(/[;{}()]/g) || []).length;

  if (scriptKeywordCount >= 6 && punctuationCount >= 4) return true;
  if (wordCount >= 15 && scriptKeywordCount / Math.max(1, wordCount) > 0.22) return true;
  if (punctuationCount >= 14 && scriptKeywordCount >= 3) return true;
  return false;
}

function scoreTextQuality(text) {
  const source = normalizeWhitespace(text);
  if (!source) return 0;

  const len = source.length;
  const readableChars = (source.match(/[A-Za-z0-9가-힣]/g) || []).length;
  const sentenceLikeCount = (source.match(/[.!?。！？]/g) || []).length;
  const scriptKeywordCount = (source.match(/\b(function|var|return|document|write|eval|script)\b/gi) || []).length;
  const symbolCount = (source.match(/[;{}()]/g) || []).length;

  let score = 0;
  score += Math.min(50, len / 40);
  score += Math.min(20, (readableChars / Math.max(1, len)) * 24);
  score += Math.min(10, sentenceLikeCount * 1.5);
  score -= Math.min(30, scriptKeywordCount * 3);
  score -= Math.min(20, symbolCount / 3);
  if (looksLikeScriptArtifact(source)) score -= 35;

  return Math.max(0, Math.round(score));
}

function hasPatentTextSignals(text) {
  const source = normalizeWhitespace(text);
  if (!source) return false;

  return /\[\d{4,}\]|<\d{4,}>|【\d{4,}】/.test(source)
    || /(claim|claims|청구항|請求項|특허|발명|문헌|실시예|도면|발명의)/i.test(source);
}

function selectBestXmlExtractionCandidate(candidates) {
  const source = Array.isArray(candidates) ? candidates : [];
  const orderedModes = ['xml_structured', 'xml_rendered_text', 'main_world_rendered_text', 'xml_raw_fallback'];
  const modePriority = {
    xml_structured: 4,
    xml_rendered_text: 3,
    main_world_rendered_text: 2,
    xml_raw_fallback: 1
  };

  const normalized = source
    .map((candidate, index) => {
      const mode = String(candidate?.mode || '').trim() || `candidate_${index}`;
      const text = normalizeWhitespace(candidate?.text || '');
      const qualityScore = Number.isFinite(Number(candidate?.qualityScore))
        ? Number(candidate.qualityScore)
        : scoreTextQuality(text);
      const scriptArtifact = candidate?.scriptArtifact === true || looksLikeScriptArtifact(text);
      const signalBonus = hasPatentTextSignals(text) ? 12 : 0;
      const artifactPenalty = scriptArtifact ? 60 : 0;
      const rawPenalty = mode === 'xml_raw_fallback' ? 18 : 0;
      return {
        ...candidate,
        mode,
        text,
        qualityScore,
        selectionScore: qualityScore + signalBonus - artifactPenalty - rawPenalty,
        scriptArtifact
      };
    })
    .filter((candidate) => candidate.text);

  if (!normalized.length) return null;

  const pickBest = (mode, predicate = () => true) => normalized
    .filter((candidate) => candidate.mode === mode && predicate(candidate))
    .sort((left, right) => {
      if (right.selectionScore !== left.selectionScore) return right.selectionScore - left.selectionScore;
      if (right.qualityScore !== left.qualityScore) return right.qualityScore - left.qualityScore;
      return (modePriority[right.mode] || 0) - (modePriority[left.mode] || 0);
    })[0] || null;

  for (const mode of orderedModes) {
    const best = pickBest(mode, (candidate) =>
      candidate.text.length >= MIN_CONTENT_LENGTH && candidate.scriptArtifact !== true
    );
    if (best) return best;
  }

  for (const mode of orderedModes) {
    const best = pickBest(mode, (candidate) => candidate.scriptArtifact !== true);
    if (best) return best;
  }

  return [...normalized].sort((left, right) => {
    if (right.selectionScore !== left.selectionScore) return right.selectionScore - left.selectionScore;
    if (right.qualityScore !== left.qualityScore) return right.qualityScore - left.qualityScore;
    return (modePriority[right.mode] || 0) - (modePriority[left.mode] || 0);
  })[0];
}

function stripTags(value) {
  return stripMarkupText(value);
}

function shouldKeepExtractedText(value) {
  const text = stripMarkupText(value);
  if (!text || text.length < 3) return false;
  if (looksLikeScriptArtifact(text)) return false;
  return true;
}

function cleanExtractedMap(data) {
  const out = {};
  Object.entries(data || {}).forEach(([key, value]) => {
    const cleanValue = stripMarkupText(value);
    if (!shouldKeepExtractedText(cleanValue)) return;
    out[String(key || '').trim()] = cleanValue;
  });
  return out;
}

function getSentinelDigits() {
  const parsed = Number.parseInt(SENTINEL_DIGITS, 10);
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

function wrapWithSentinel(id, text) {
  const body = normalizeWhitespace(text);
  return `${formatSentinelOpenToken(id)} ${body} ${formatSentinelCloseToken(id)}`.trim();
}

function splitTextIntoSentences(rawText) {
  const normalized = String(rawText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u00A0/g, ' ');

  const lines = normalized
    .split(/\n+/g)
    .map((line) => line.trim())
    .filter(Boolean);

  const sentences = [];
  lines.forEach((line) => {
    const parts = line
      .split(/(?<=[.!?。！？])\s+/g)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 0) {
      sentences.push(line);
      return;
    }
    parts.forEach((part) => sentences.push(part));
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

function chunkTextBySentence(rawText, chunkSize = DEFAULT_SENTINEL_CHUNK_SIZE, overflow = DEFAULT_SENTINEL_CHUNK_OVERFLOW) {
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
    const text = normalizeWhitespace(sentence);
    if (!text) return;

    if (text.length > hardMax) {
      flush();
      splitLongTextForChunk(text, size).forEach((part) => chunks.push(part));
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

function extractNumericOrder(keyText) {
  const match = String(keyText || '').match(/\d+/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const parsed = Number.parseInt(match[0], 10);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function buildSentinelPayloadFromStructured(structured, options = {}) {
  const source = String(options.source || 'xml').trim() || 'xml';
  const chunkSize = Number.isFinite(Number(options.chunkSize))
    ? Math.max(60, Number(options.chunkSize))
    : DEFAULT_SENTINEL_CHUNK_SIZE;
  const paragraphsRaw = structured?.paragraphs && typeof structured.paragraphs === 'object'
    ? structured.paragraphs
    : {};
  const claimsRaw = structured?.claims && typeof structured.claims === 'object'
    ? structured.claims
    : {};

  const paragraphEntries = Object.entries(paragraphsRaw)
    .map(([key, value]) => ({
      key: String(key || '').trim(),
      text: normalizeWhitespace(value)
    }))
    .filter((entry) => entry.key && entry.text)
    .sort((a, b) => {
      const aOrder = extractNumericOrder(a.key);
      const bOrder = extractNumericOrder(b.key);
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.key.localeCompare(b.key, 'ko');
    });

  const claimEntries = Object.entries(claimsRaw)
    .map(([key, value]) => ({
      key: String(key || '').trim(),
      text: normalizeWhitespace(value)
    }))
    .filter((entry) => entry.key && entry.text)
    .sort((a, b) => {
      const aOrder = extractNumericOrder(a.key);
      const bOrder = extractNumericOrder(b.key);
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.key.localeCompare(b.key, 'ko');
    });

  const payload = {
    paragraphs: {},
    claims: {},
    sentinelMap: {},
    meta: {
      source,
      title: String(options.title || '').trim(),
      url: String(options.url || '').trim(),
      pageCount: 0,
      sectionCount: 0,
      sections: []
    }
  };

  let sentinelOrder = 0;

  paragraphEntries.forEach((entry) => {
    sentinelOrder += 1;
    const sentinelId = formatSentinelId(sentinelOrder);
    payload.paragraphs[entry.key] = wrapWithSentinel(sentinelId, entry.text);
    payload.sentinelMap[sentinelId] = {
      id: sentinelId,
      order: sentinelOrder,
      source,
      targetType: 'paragraph',
      sourceKey: entry.key,
      displayKey: entry.key,
      originalKey: entry.key
    };
  });

  claimEntries.forEach((entry) => {
    sentinelOrder += 1;
    const sentinelId = formatSentinelId(sentinelOrder);
    payload.claims[entry.key] = wrapWithSentinel(sentinelId, entry.text);
    payload.sentinelMap[sentinelId] = {
      id: sentinelId,
      order: sentinelOrder,
      source,
      targetType: 'claim',
      sourceKey: entry.key,
      displayKey: entry.key,
      originalKey: entry.key
    };
  });

  payload.meta.paragraphCount = paragraphEntries.length;
  payload.meta.claimCount = claimEntries.length;
  payload.meta.sentinelCount = Object.keys(payload.sentinelMap).length;
  payload.meta.chunkSize = chunkSize;

  return payload;
}

function buildSentinelPayloadFromPlainText(rawText, options = {}) {
  const source = String(options.source || 'tab_text').trim() || 'tab_text';
  const title = String(options.title || '').trim();
  const url = String(options.url || '').trim();
  const sectionId = String(options.sectionId || '').trim();
  const sectionTitle = String(options.sectionTitle || '').trim();
  const chunkSize = Number.isFinite(Number(options.chunkSize))
    ? Math.max(60, Number(options.chunkSize))
    : DEFAULT_SENTINEL_CHUNK_SIZE;
  const chunkOverflow = Number.isFinite(Number(options.chunkOverflow))
    ? Math.max(0, Number(options.chunkOverflow))
    : DEFAULT_SENTINEL_CHUNK_OVERFLOW;

  const chunks = chunkTextBySentence(rawText, chunkSize, chunkOverflow)
    .map((item) => normalizeWhitespace(item))
    .filter(Boolean);

  const payload = {
    paragraphs: {},
    claims: {},
    sentinelMap: {},
    meta: {
      source,
      title,
      url,
      pageCount: 0,
      sectionCount: 0,
      sections: []
    }
  };

  chunks.forEach((chunkText, index) => {
    const order = index + 1;
    const sentinelId = formatSentinelId(order);
    const paragraphKey = `[${formatSentinelId(order)}]`;
    payload.paragraphs[paragraphKey] = wrapWithSentinel(sentinelId, chunkText);
    payload.sentinelMap[sentinelId] = {
      id: sentinelId,
      order,
      source,
      targetType: 'paragraph',
      sourceKey: paragraphKey,
      displayKey: paragraphKey,
      sectionId: sectionId || null,
      sectionTitle: sectionTitle || null
    };
    if (payload.meta.sections.length > 0 && !payload.meta.sections[0].startParagraph) {
      payload.meta.sections[0].startParagraph = paragraphKey;
    }
  });

  if (sectionId || sectionTitle) {
    payload.meta.sectionCount = 1;
    payload.meta.sections = [
      {
        id: sectionId || null,
        title: sectionTitle || null,
        pageNumber: null,
        startParagraph: Object.keys(payload.paragraphs)[0] || null
      }
    ];
  }

  payload.meta.paragraphCount = chunks.length;
  payload.meta.claimCount = 0;
  payload.meta.sentinelCount = Object.keys(payload.sentinelMap).length;
  payload.meta.chunkSize = chunkSize;

  return payload;
}

function buildUploadTextFromCitationPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';

  const paragraphs = payload.paragraphs && typeof payload.paragraphs === 'object' ? payload.paragraphs : {};
  const claims = payload.claims && typeof payload.claims === 'object' ? payload.claims : {};
  const map = payload.sentinelMap && typeof payload.sentinelMap === 'object' ? payload.sentinelMap : {};
  const sortedIds = Object.keys(map).sort((a, b) => Number(a) - Number(b));

  const rows = [];
  sortedIds.forEach((id) => {
    const entry = map[id];
    if (!entry || typeof entry !== 'object') return;
    const sourceKey = String(entry.sourceKey || '').trim();
    if (!sourceKey) return;

    const sourceText = entry.targetType === 'claim'
      ? claims[sourceKey]
      : paragraphs[sourceKey];

    if (typeof sourceText === 'string' && sourceText.trim()) {
      rows.push(sourceText.trim());
    }
  });

  return rows.join('\n').trim();
}

function extractPatentData(html) {
  const sourceHtml = decodeKnownPatentScripts(decodeHtmlEntitiesDeep(html));
  const paragraphs = {};
  const claims = {};

  const krParagraphRegex =
    /<td[^>]*>\s*<small>\s*(?:&lt;|<)\s*([0-9０-９]{4,})\s*(?:&gt;|>)\s*<\/small>\s*<\/td>\s*<td[^>]*\bword-break\s*:\s*break-all[^>]*>([\s\S]*?)<\/td>/gi;
  let match;
  while ((match = krParagraphRegex.exec(sourceHtml)) !== null) {
    const key = `[${toHalfWidthDigits(match[1])}]`;
    const text = stripMarkupText(match[2]);
    if (shouldKeepExtractedText(text)) paragraphs[key] = text;
  }

  const divRegex = /<div[^>]*>([\s\S]*?)<\/div>/gi;
  const divs = [];
  while ((match = divRegex.exec(sourceHtml)) !== null) {
    divs.push(match[1]);
  }

  for (let index = 0; index < divs.length - 1; index += 1) {
    const current = divs[index];

    if (/(청구항|請求項)/.test(current)) {
      const claimNumberMatch = current.match(/([0-9０-９]{1,4})/);
      if (claimNumberMatch) {
        const claimNo = toHalfWidthDigits(claimNumberMatch[1]);
        const body = stripMarkupText(divs[index + 1]);
        if (shouldKeepExtractedText(body)) {
          claims[`청구항 ${claimNo}`] = body;
        }
      }
      continue;
    }

    const paragraphNumberMatch = current.match(/([0-9０-９]{4,})/);
    if (!paragraphNumberMatch) continue;

    const number = toHalfWidthDigits(paragraphNumberMatch[1]);
    const paragraphKey = `[${number}]`;
    if (paragraphs[paragraphKey]) continue;

    const text = stripMarkupText(divs[index + 1]);
    if (shouldKeepExtractedText(text)) {
      paragraphs[paragraphKey] = text;
    }
  }

  return {
    paragraphs: cleanExtractedMap(paragraphs),
    claims: cleanExtractedMap(claims)
  };
}

async function getMainWorldRenderedText(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: () => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const renderedText = normalize(
          document.body?.innerText
          || document.documentElement?.innerText
          || document.body?.textContent
          || document.documentElement?.textContent
          || ''
        );

        return {
          url: String(location.href || ''),
          title: String(document.title || ''),
          renderedText,
          length: renderedText.length,
          hasConverter: typeof window.eval_convHalfCharToFullChar === 'function'
        };
      }
    });

    return (results || [])
      .map((item) => item?.result)
      .filter((item) => item && item.renderedText)
      .sort((a, b) => b.renderedText.length - a.renderedText.length)[0] || null;
  } catch (error) {
    console.warn('[K-LARC] MAIN world extraction failed:', error);
    return null;
  }
}

async function handleExtractAndUpload(tabId, baseUrl, apiKey, sendResponse, chunkingOptions = {}) {
  try {
    const configuredChunkSize = Number.isFinite(Number(chunkingOptions?.chunkSize))
      ? Math.max(60, Number(chunkingOptions.chunkSize))
      : DEFAULT_SENTINEL_CHUNK_SIZE;
    const configuredChunkOverflow = Number.isFinite(Number(chunkingOptions?.chunkOverflow))
      ? Math.max(0, Number(chunkingOptions.chunkOverflow))
      : DEFAULT_SENTINEL_CHUNK_OVERFLOW;

    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const url = String(location.href || '');
        const contentType = String(document.contentType || '');
        const isXml = url.toLowerCase().endsWith('.xml')
          || /xml/i.test(contentType)
          || /xml/i.test(String(document.documentElement?.nodeName || ''));

        const sourceNode = document.body || document.documentElement;
        const clone = sourceNode ? sourceNode.cloneNode(true) : null;
        if (clone && typeof clone.querySelectorAll === 'function') {
          clone.querySelectorAll('script,style,noscript,nav,header,footer,iframe').forEach((el) => el.remove());
        }

        const renderedText = normalize(clone ? (clone.innerText || clone.textContent || '') : '');
        const cleanedRenderedText = renderedText;
        const rawXml = isXml ? new XMLSerializer().serializeToString(document) : null;

        return {
          url,
          isXml,
          frameTitle: String(document.title || '').trim(),
          rawXml: isXml ? String(rawXml || '') : null,
          text: isXml ? String(rawXml || '') : renderedText,
          renderedText,
          cleanedRenderedText,
          length: isXml ? String(rawXml || '').length : renderedText.length,
          rawXmlLength: isXml ? String(rawXml || '').length : 0,
          renderedTextLength: renderedText.length
        };
      }
    });

    if (!Array.isArray(injectionResults) || injectionResults.length === 0) {
      throw new Error('페이지 내용을 읽을 수 없습니다.');
    }

    const mainWorldRendered = await getMainWorldRenderedText(tabId);

    const frames = injectionResults
      .map((item) => item?.result)
      .filter((item) => item && typeof item === 'object')
      .map((frame) => {
        const cleanedRenderedText = stripMarkupText(frame.cleanedRenderedText || frame.renderedText || '');
        const cleanedRawXmlText = frame.isXml ? stripMarkupText(frame.rawXml || '') : '';
        const cleanedText = stripMarkupText(frame.text || '');
        const scriptArtifactsDetected = looksLikeScriptArtifact(frame.text || '')
          || looksLikeScriptArtifact(frame.rawXml || '')
          || looksLikeScriptArtifact(cleanedRenderedText)
          || looksLikeScriptArtifact(cleanedRawXmlText);
        const xmlQualityScore = frame.isXml
          ? Math.max(scoreTextQuality(cleanedRenderedText), scoreTextQuality(cleanedRawXmlText))
          : null;
        const frameScore = frame.isXml
          ? (xmlQualityScore || 0)
            + (cleanedRenderedText.length >= MIN_CONTENT_LENGTH ? 12 : 0)
            + (Number(frame.rawXmlLength || 0) > MIN_CONTENT_LENGTH ? 4 : 0)
            - (scriptArtifactsDetected ? 25 : 0)
          : scoreTextQuality(cleanedText) - (scriptArtifactsDetected ? 20 : 0);

        return {
          ...frame,
          cleanedText,
          cleanedRenderedText,
          cleanedRawXmlText,
          scriptArtifactsDetected,
          xmlQualityScore,
          frameScore
        };
      });

    const xmlFrames = frames.filter((frame) => frame.isXml === true);
    let targetFrame = null;
    if (xmlFrames.length > 0) {
      targetFrame = [...xmlFrames].sort((left, right) => {
        if (Number(right.frameScore || 0) !== Number(left.frameScore || 0)) {
          return Number(right.frameScore || 0) - Number(left.frameScore || 0);
        }
        if (Number(right.renderedTextLength || 0) !== Number(left.renderedTextLength || 0)) {
          return Number(right.renderedTextLength || 0) - Number(left.renderedTextLength || 0);
        }
        return Number(right.rawXmlLength || 0) - Number(left.rawXmlLength || 0);
      })[0];

      console.debug('[K-LARC XML] XML detected', {
        frameCount: xmlFrames.length,
        selectedScore: targetFrame?.frameScore || 0,
        selectedRenderedLength: targetFrame?.cleanedRenderedText?.length || 0,
        selectedRawLength: targetFrame?.rawXmlLength || 0
      });
    }

    if (!targetFrame) {
      targetFrame = [...frames]
        .sort((left, right) => Number(right.frameScore || 0) - Number(left.frameScore || 0))
        .find((frame) => Number(frame?.cleanedText?.length || 0) > MIN_CONTENT_LENGTH)
        || [...frames].sort((left, right) => Number(right.frameScore || 0) - Number(left.frameScore || 0))[0];
    }

    if (!targetFrame) {
      throw new Error('유효한 텍스트 내용을 찾지 못했습니다 (빈 문서).');
    }

    const tab = await chrome.tabs.get(tabId);
    const safeTitle = String(tab?.title || `tab_${tabId}`).replace(/[^a-zA-Z0-9가-힣\s_-]/g, '').trim();
    const baseFileName = safeTitle || `tab_${tabId}`;
    const filename = `ref_${tabId}_${baseFileName.slice(0, 32)}_${Date.now()}.txt`;

    let payload = null;
    let uploadText = '';
    let extractionMode = targetFrame.isXml ? 'xml_structured' : 'html_plain_text';
    let scriptArtifactsDetected = targetFrame.scriptArtifactsDetected === true;
    let scriptArtifactsRemoved = false;
    let xmlQualityScore = targetFrame.isXml ? Number(targetFrame.xmlQualityScore || 0) : null;
    let xmlFallbackReason = null;

    if (targetFrame.isXml) {
      const structured = extractPatentData(targetFrame.rawXml || '');
      const structuredPayload = buildSentinelPayloadFromStructured(structured, {
        source: 'xml_structured',
        title: String(tab?.title || '').trim(),
        url: targetFrame.url,
        chunkSize: configuredChunkSize
      });
      const structuredText = buildUploadTextFromCitationPayload(structuredPayload);
      const structuredScriptArtifact = looksLikeScriptArtifact(structuredText);
      const structuredQuality = scoreTextQuality(structuredText);
      console.debug('[K-LARC XML] structured candidate', {
        textLength: structuredText.length,
        quality: structuredQuality,
        scriptArtifact: structuredScriptArtifact
      });

      const renderedCleanText = normalizeWhitespace(stripMarkupText(
        targetFrame.cleanedRenderedText || targetFrame.renderedText || ''
      ));
      const renderedPayload = buildSentinelPayloadFromPlainText(renderedCleanText, {
        source: 'xml_rendered_text',
        title: String(tab?.title || '').trim(),
        url: targetFrame.url,
        chunkSize: configuredChunkSize,
        chunkOverflow: configuredChunkOverflow
      });
      const renderedText = buildUploadTextFromCitationPayload(renderedPayload);
      const renderedScriptArtifact = looksLikeScriptArtifact(renderedText);
      const renderedQuality = scoreTextQuality(renderedText);

      const rawCleanText = normalizeWhitespace(stripMarkupText(targetFrame.rawXml || ''));
      const rawPayload = buildSentinelPayloadFromPlainText(rawCleanText, {
        source: 'xml_raw_fallback',
        title: String(tab?.title || '').trim(),
        url: targetFrame.url,
        chunkSize: configuredChunkSize,
        chunkOverflow: configuredChunkOverflow
      });
      const rawText = buildUploadTextFromCitationPayload(rawPayload);
      const rawScriptArtifact = looksLikeScriptArtifact(rawText);
      const rawQuality = scoreTextQuality(rawText);
      const mainWorldCleanText = normalizeWhitespace(stripMarkupText(
        mainWorldRendered?.renderedText || ''
      ));
      const mainWorldPayload = buildSentinelPayloadFromPlainText(mainWorldCleanText, {
        source: 'main_world_rendered_text',
        title: String(mainWorldRendered?.title || tab?.title || '').trim(),
        url: String(mainWorldRendered?.url || targetFrame.url || '').trim(),
        chunkSize: configuredChunkSize,
        chunkOverflow: configuredChunkOverflow
      });
      const mainWorldText = buildUploadTextFromCitationPayload(mainWorldPayload);
      const mainWorldScriptArtifact = looksLikeScriptArtifact(mainWorldText);
      const mainWorldQuality = scoreTextQuality(mainWorldText);

      const candidates = [
        {
          mode: 'xml_structured',
          text: structuredText,
          payload: structuredPayload,
          scriptArtifact: structuredScriptArtifact,
          qualityScore: structuredQuality
        },
        {
          mode: 'xml_rendered_text',
          text: renderedText,
          payload: renderedPayload,
          scriptArtifact: renderedScriptArtifact,
          qualityScore: renderedQuality
        },
        {
          mode: 'main_world_rendered_text',
          text: mainWorldText,
          payload: mainWorldPayload,
          scriptArtifact: mainWorldScriptArtifact,
          qualityScore: mainWorldQuality
        },
        {
          mode: 'xml_raw_fallback',
          text: rawText,
          payload: rawPayload,
          scriptArtifact: rawScriptArtifact,
          qualityScore: rawQuality
        }
      ];

      const selected = selectBestXmlExtractionCandidate(candidates);
      if (!selected) {
        throw new Error('업로드할 추출 텍스트가 없습니다.');
      }

      payload = selected.payload;
      uploadText = selected.text;
      extractionMode = selected.mode;
      const selectedHadScriptArtifact = selected.scriptArtifact === true || looksLikeScriptArtifact(uploadText);
      if (looksLikeScriptArtifact(uploadText)) {
        const cleanedSelectedText = normalizeWhitespace(stripMarkupText(uploadText));
        if (cleanedSelectedText && !looksLikeScriptArtifact(cleanedSelectedText)) {
          payload = buildSentinelPayloadFromPlainText(cleanedSelectedText, {
            source: `${selected.mode}_script_cleaned`,
            title: String(tab?.title || '').trim(),
            url: targetFrame.url,
            chunkSize: configuredChunkSize,
            chunkOverflow: configuredChunkOverflow
          });
          uploadText = buildUploadTextFromCitationPayload(payload);
        }
      }
      xmlQualityScore = Number.isFinite(Number(selected.qualityScore))
        ? Number(selected.qualityScore)
        : scoreTextQuality(uploadText);
      scriptArtifactsDetected = candidates.some((candidate) => candidate.scriptArtifact === true);
      scriptArtifactsRemoved = scriptArtifactsDetected && !looksLikeScriptArtifact(uploadText);
      if (selectedHadScriptArtifact && !looksLikeScriptArtifact(uploadText)) {
        scriptArtifactsRemoved = true;
      }

      if (extractionMode !== 'xml_structured') {
        if (!structuredText) {
          xmlFallbackReason = 'structured_empty';
        } else if (structuredScriptArtifact) {
          xmlFallbackReason = 'structured_script_artifact';
        } else if (structuredQuality < MIN_CONTENT_LENGTH) {
          xmlFallbackReason = 'structured_low_quality';
        } else {
          xmlFallbackReason = 'structured_not_selected';
        }
      }

      if (extractionMode === 'xml_rendered_text') {
        console.debug('[K-LARC XML] rendered text fallback used', {
          fallbackReason: xmlFallbackReason,
          renderedLength: renderedText.length,
          renderedQuality
        });
      } else if (extractionMode === 'main_world_rendered_text') {
        console.debug('[K-LARC XML] MAIN world rendered text fallback used', {
          fallbackReason: xmlFallbackReason,
          mainWorldLength: mainWorldText.length,
          mainWorldQuality,
          hasConverter: mainWorldRendered?.hasConverter === true
        });
      } else if (extractionMode === 'xml_raw_fallback') {
        console.debug('[K-LARC XML] raw xml fallback used', {
          fallbackReason: xmlFallbackReason,
          rawLength: rawText.length,
          rawQuality
        });
      }
    } else {
      const cleanPlainText = normalizeWhitespace(stripMarkupText(
        targetFrame.cleanedRenderedText || targetFrame.text || ''
      ));
      payload = buildSentinelPayloadFromPlainText(cleanPlainText, {
        source: 'tab_text',
        title: String(tab?.title || '').trim(),
        url: targetFrame.url,
        chunkSize: configuredChunkSize,
        chunkOverflow: configuredChunkOverflow
      });
      uploadText = buildUploadTextFromCitationPayload(payload);
      extractionMode = 'html_plain_text';
      scriptArtifactsDetected = looksLikeScriptArtifact(targetFrame.text || '');
      if (looksLikeScriptArtifact(uploadText)) {
        const cleanedUploadText = normalizeWhitespace(stripMarkupText(uploadText));
        if (cleanedUploadText && !looksLikeScriptArtifact(cleanedUploadText)) {
          payload = buildSentinelPayloadFromPlainText(cleanedUploadText, {
            source: 'tab_text_script_cleaned',
            title: String(tab?.title || '').trim(),
            url: targetFrame.url,
            chunkSize: configuredChunkSize,
            chunkOverflow: configuredChunkOverflow
          });
          uploadText = buildUploadTextFromCitationPayload(payload);
        }
      }
      scriptArtifactsRemoved = scriptArtifactsDetected && !looksLikeScriptArtifact(uploadText);
    }

    if (!uploadText) {
      throw new Error('업로드할 추출 텍스트가 없습니다.');
    }

    if (payload && payload.meta && typeof payload.meta === 'object') {
      payload.meta.extraction = {
        extractionMode,
        scriptArtifactsDetected: scriptArtifactsDetected === true,
        scriptArtifactsRemoved: scriptArtifactsRemoved === true,
        xmlQualityScore: Number.isFinite(Number(xmlQualityScore)) ? Number(xmlQualityScore) : null,
        xmlFallbackReason: xmlFallbackReason || null
      };
    }

    const blob = new Blob([uploadText], { type: 'text/plain; charset=utf-8' });
    const formData = new FormData();
    formData.append('file', blob, filename);

    const uploadUrl = `${baseUrl.replace(/\/$/, '')}/api/v1/files/?process=true&process_in_background=true`;
    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: formData
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Upload Failed (${response.status}): ${errText}`);
    }

    const data = await response.json();
    const fileId = data.id || data?.data?.id;
    if (!fileId) {
      throw new Error('서버 응답에 File ID가 없습니다.');
    }

    const titlePrefix = targetFrame.isXml ? '[XML] ' : '';
    sendResponse({
      ok: true,
      fileId,
      title: `${titlePrefix}${tab.title}`,
      text: uploadText,
      payloadText: JSON.stringify(payload, null, 2),
      extractionMode,
      scriptArtifactsDetected: scriptArtifactsDetected === true,
      scriptArtifactsRemoved: scriptArtifactsRemoved === true,
      xmlQualityScore: Number.isFinite(Number(xmlQualityScore)) ? Number(xmlQualityScore) : null,
      xmlFallbackReason: xmlFallbackReason || null
    });
  } catch (error) {
    console.error('Extract/Upload Error:', error);
    sendResponse({ ok: false, error: error.message || String(error) });
  }
}

async function checkFileStatus(fileId, baseUrl, apiKey, sendResponse) {
  try {
    const statusUrl = `${baseUrl.replace(/\/$/, '')}/api/v1/files/${fileId}`;
    const response = await fetch(statusUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` }
    });

    if (!response.ok) {
      throw new Error('Status check failed');
    }

    const json = await response.json();

    let isCompleted = false;
    let isFailed = false;

    if (json.data && json.data.status) {
      if (json.data.status === true || json.data.status === 'processed' || json.data.status === 'completed') {
        isCompleted = true;
      } else if (json.data.status === 'failed' || json.data.status === 'error') {
        isFailed = true;
      }
    } else if (json.data && json.data.content) {
      isCompleted = true;
    } else if (json.meta && json.meta.processed) {
      isCompleted = true;
    }

    let finalStatus = 'processing';
    if (isCompleted) finalStatus = 'completed';
    if (isFailed) finalStatus = 'failed';

    sendResponse({ ok: true, status: finalStatus });
  } catch (error) {
    sendResponse({ ok: false, error: error.message || String(error) });
  }
}

async function analyzeClaim(payload, baseUrl, apiKey, sendResponse) {
  try {
    const chatUrl = `${baseUrl.replace(/\/$/, '')}/api/chat/completions`;

    const response = await fetch(chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Analysis Failed (${response.status}): ${errText}`);
    }

    const data = await response.json();
    sendResponse({ ok: true, data });
  } catch (error) {
    sendResponse({ ok: false, error: error.message || String(error) });
  }
}

async function deleteFile(fileId, baseUrl, apiKey, sendResponse) {
  try {
    const deleteUrl = `${baseUrl.replace(/\/$/, '')}/api/v1/files/${fileId}`;

    const response = await fetch(deleteUrl, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Delete Failed (${response.status}): ${errText}`);
    }

    const data = await response.json();
    sendResponse({ ok: true, data });
  } catch (error) {
    console.error('File Delete Error:', error);
    sendResponse({ ok: false, error: error.message || String(error) });
  }
}

async function handleDirectUpload(text, filename, baseUrl, apiKey, sendResponse) {
  try {
    const blob = new Blob([text], { type: 'text/plain; charset=utf-8' });
    const formData = new FormData();
    formData.append('file', blob, filename);

    const uploadUrl = `${baseUrl.replace(/\/$/, '')}/api/v1/files/?process=true&process_in_background=true`;
    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Upload Failed (${response.status}): ${errText}`);
    }

    const data = await response.json();
    const fileId = data.id || data?.data?.id;
    if (!fileId) {
      throw new Error('서버 응답에 File ID가 없습니다.');
    }

    sendResponse({ ok: true, fileId });
  } catch (error) {
    console.error('Direct Upload Error:', error);
    sendResponse({ ok: false, error: error.message || String(error) });
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.__K_LARC_XML_TEST_API__ = {
    decodeHtmlEntitiesDeep,
    decodeJsStringExpression,
    decodeEvalConvHalfCharScript,
    decodeKnownPatentScripts,
    stripMarkupText,
    looksLikeScriptArtifact,
    scoreTextQuality,
    selectBestXmlExtractionCandidate,
    extractPatentData,
    handleExtractAndUpload
  };
}
