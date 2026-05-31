(function initKLarcPdfExtractor(globalScope) {
  const HEADING_KEYWORDS = new Set([
    "ABSTRACT",
    "INTRODUCTION",
    "BACKGROUND",
    "RELATED WORK",
    "METHOD",
    "METHODS",
    "MATERIALS AND METHODS",
    "EXPERIMENT",
    "EXPERIMENTS",
    "RESULT",
    "RESULTS",
    "DISCUSSION",
    "CONCLUSION",
    "CONCLUSIONS",
    "ACKNOWLEDGMENT",
    "ACKNOWLEDGMENTS",
    "REFERENCES",
    "APPENDIX",
    "SUMMARY"
  ]);

  let pdfjsPromise = null;

  function toPaddedNumber(value, width) {
    return String(Math.max(0, Number.parseInt(value, 10) || 0)).padStart(width, "0");
  }

  function normalizeWhitespace(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function resolveChunkSize() {
    const configured = Number(
      typeof CITATION_SENTINEL_CHUNK_SIZE !== "undefined" ? CITATION_SENTINEL_CHUNK_SIZE : 400
    );
    if (Number.isFinite(configured) && configured > 0) {
      return Math.max(60, configured);
    }
    return 400;
  }

  function resolveChunkOverflow(chunkSize) {
    const configured = Number(
      typeof CITATION_SENTINEL_CHUNK_OVERFLOW !== "undefined"
        ? CITATION_SENTINEL_CHUNK_OVERFLOW
        : Math.round(chunkSize * 0.2)
    );
    if (Number.isFinite(configured) && configured >= 0) {
      return configured;
    }
    return Math.round(chunkSize * 0.2);
  }

  function formatSentinelIdValue(value) {
    if (typeof globalScope.formatSentinelId === "function") {
      return String(globalScope.formatSentinelId(value));
    }
    return toPaddedNumber(value, 4);
  }

  function formatSentinelOpenTokenValue(id) {
    if (typeof globalScope.formatSentinelOpenToken === "function") {
      return String(globalScope.formatSentinelOpenToken(id));
    }
    return `⟪${formatSentinelIdValue(id)}⟫`;
  }

  function formatSentinelCloseTokenValue(id) {
    if (typeof globalScope.formatSentinelCloseToken === "function") {
      return String(globalScope.formatSentinelCloseToken(id));
    }
    return `⟪/${formatSentinelIdValue(id)}⟫`;
  }

  function wrapWithSentinelToken(id, text) {
    if (typeof globalScope.wrapWithSentinel === "function") {
      return String(globalScope.wrapWithSentinel(id, text));
    }
    const body = normalizeWhitespace(text);
    return `${formatSentinelOpenTokenValue(id)} ${body} ${formatSentinelCloseTokenValue(id)}`.trim();
  }

  function splitTextIntoSentencesFallback(rawText) {
    const normalized = String(rawText || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\u00A0/g, " ");

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

  function splitLongTextForChunkFallback(text, chunkSize) {
    const clean = String(text || "").trim();
    if (!clean) return [];
    if (clean.length <= chunkSize) return [clean];

    const pieces = [];
    let cursor = 0;

    while (cursor < clean.length) {
      let end = Math.min(clean.length, cursor + chunkSize);
      if (end < clean.length) {
        const candidate = clean.slice(cursor, Math.min(clean.length, cursor + chunkSize + 40));
        const splitAt = Math.max(
          candidate.lastIndexOf(". "),
          candidate.lastIndexOf("? "),
          candidate.lastIndexOf("! "),
          candidate.lastIndexOf("。"),
          candidate.lastIndexOf("！"),
          candidate.lastIndexOf("？"),
          candidate.lastIndexOf(" ")
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

  function chunkTextBySentenceForPdf(rawText, chunkSize, overflow) {
    if (typeof globalScope.chunkTextBySentence === "function") {
      const result = globalScope.chunkTextBySentence(rawText, chunkSize, overflow);
      return Array.isArray(result)
        ? result.map((item) => normalizeWhitespace(item)).filter(Boolean)
        : [];
    }

    const size = Number.isFinite(Number(chunkSize)) ? Math.max(60, Number(chunkSize)) : 400;
    const extra = Number.isFinite(Number(overflow)) ? Math.max(0, Number(overflow)) : Math.round(size * 0.2);
    const hardMax = size + extra;
    const sentences = splitTextIntoSentencesFallback(rawText);

    const chunks = [];
    let current = "";

    const flush = () => {
      const normalized = normalizeWhitespace(current);
      if (normalized) chunks.push(normalized);
      current = "";
    };

    sentences.forEach((sentence) => {
      const text = normalizeWhitespace(sentence);
      if (!text) return;

      if (text.length > hardMax) {
        flush();
        splitLongTextForChunkFallback(text, size).forEach((part) => chunks.push(part));
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

  function median(values) {
    const list = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (list.length === 0) return 0;
    const mid = Math.floor(list.length / 2);
    if (list.length % 2 === 1) return list[mid];
    return (list[mid - 1] + list[mid]) / 2;
  }

  function average(values) {
    const list = values.filter((value) => Number.isFinite(value));
    if (list.length === 0) return 0;
    return list.reduce((sum, value) => sum + value, 0) / list.length;
  }

  async function loadPdfJs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(chrome.runtime.getURL("modules/k-larc/lib/pdf.mjs"))
        .then((module) => {
          const pdfjsLib = module || {};
          if (typeof pdfjsLib.getDocument !== "function") {
            throw new Error("pdf.js failed to initialize.");
          }
          if (pdfjsLib.GlobalWorkerOptions) {
            pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
              "modules/k-larc/lib/pdf.worker.mjs"
            );
          }
          return pdfjsLib;
        });
    }
    return pdfjsPromise;
  }

  function buildLineText(tokens) {
    let output = "";
    let previous = null;

    tokens.forEach((token) => {
      const raw = String(token?.text || "");
      const piece = raw.replace(/\s+/g, " ").trim();
      if (!piece) return;

      if (!previous) {
        output = piece;
        previous = token;
        return;
      }

      const previousRight = previous.x + previous.width;
      const gap = token.x - previousRight;
      const minSize = Math.min(previous.size || 10, token.size || 10);
      const gapThreshold = Math.max(0.6, minSize * 0.08);
      const leadingPunctuation = /^[,.;:!?%)\]\}]/.test(piece);
      const trailingConnector = /[([{/\-]$/.test(output);

      if (gap > gapThreshold && !leadingPunctuation && !trailingConnector && !output.endsWith(" ")) {
        output += " ";
      }

      output += piece;
      previous = token;
    });

    return normalizeWhitespace(output);
  }

  function isLikelyLineNoise(text) {
    const normalized = normalizeWhitespace(text);
    if (!normalized) return true;
    if (/^[\[\](){}.,;:|/\\+\-*=]+$/.test(normalized)) return true;
    if (/^(page\s*)?\d{1,4}$/i.test(normalized)) return true;
    if (/^\d{1,4}\s*\/\s*\d{1,4}$/.test(normalized)) return true;
    if (/^(?:copyright|all rights reserved)/i.test(normalized)) return true;
    return false;
  }

  function buildLinesFromTextContent(textContent) {
    const items = Array.isArray(textContent?.items) ? textContent.items : [];
    const styles = textContent?.styles || {};
    const tokens = [];

    items.forEach((item) => {
      if (typeof item?.str !== "string") return;
      const text = item.str;
      if (!normalizeWhitespace(text)) return;

      const transform = Array.isArray(item.transform) ? item.transform : [1, 0, 0, 1, 0, 0];
      const x = Number(transform[4]) || 0;
      const y = Number(transform[5]) || 0;
      const scaleY = Math.hypot(Number(transform[2]) || 0, Number(transform[3]) || 0);
      const size = Number(item.height) || scaleY || 10;
      const width = Number(item.width) || Math.max(1, text.length * (size * 0.45));
      const style = styles[item.fontName] || {};
      const styleKey = `${item.fontName || ""} ${style.fontFamily || ""}`.toLowerCase();

      tokens.push({
        text,
        x,
        y,
        width,
        size,
        bold: /(bold|black|heavy|demi|semi)/.test(styleKey),
        italic: /(italic|oblique)/.test(styleKey)
      });
    });

    if (tokens.length === 0) return [];

    tokens.sort((a, b) => {
      const yDiff = b.y - a.y;
      if (Math.abs(yDiff) > 0.0001) return yDiff;
      return a.x - b.x;
    });

    const yTolerance = Math.max(1.5, median(tokens.map((token) => token.size)) * 0.45);
    const groups = [];

    tokens.forEach((token) => {
      const current = groups[groups.length - 1];
      if (!current || Math.abs(token.y - current.baselineY) > yTolerance) {
        groups.push({
          baselineY: token.y,
          tokens: [token]
        });
        return;
      }

      current.tokens.push(token);
      current.baselineY = average(current.tokens.map((entry) => entry.y));
    });

    const lines = groups
      .map((group) => {
        const lineTokens = group.tokens.slice().sort((a, b) => a.x - b.x);
        const text = buildLineText(lineTokens);
        if (isLikelyLineNoise(text)) return null;

        const boldRatio = lineTokens.length
          ? lineTokens.filter((token) => token.bold).length / lineTokens.length
          : 0;
        const italicRatio = lineTokens.length
          ? lineTokens.filter((token) => token.italic).length / lineTokens.length
          : 0;

        return {
          text,
          tokens: lineTokens,
          baselineY: group.baselineY,
          xMin: Math.min(...lineTokens.map((token) => token.x)),
          xMax: Math.max(...lineTokens.map((token) => token.x + token.width)),
          boldRatio,
          italicRatio,
          breakBefore: false,
          pageNumber: 0,
          localIndex: -1,
          globalIndex: -1,
          isHeading: false,
          sectionId: "",
          sectionTitle: ""
        };
      })
      .filter(Boolean);

    lines.sort((a, b) => {
      const yDiff = b.baselineY - a.baselineY;
      if (Math.abs(yDiff) > 0.0001) return yDiff;
      return a.xMin - b.xMin;
    });

    const verticalGaps = [];
    for (let index = 1; index < lines.length; index += 1) {
      const gap = lines[index - 1].baselineY - lines[index].baselineY;
      if (gap > 0.5 && gap < 180) {
        verticalGaps.push(gap);
      }
    }
    const baseGap = Math.max(8, median(verticalGaps));

    lines.forEach((line, index) => {
      if (index === 0) {
        line.breakBefore = true;
        return;
      }
      const gap = lines[index - 1].baselineY - line.baselineY;
      line.breakBefore = gap > Math.max(12, baseGap * 1.55);
    });

    return lines;
  }

  function canonicalHeading(text) {
    let normalized = normalizeWhitespace(text).toUpperCase();
    normalized = normalized.replace(/^((\d+(\.\d+)*)|([IVXLCM]+))\.?\s+/, "");
    normalized = normalized.replace(/[.:\-]+$/, "").trim();

    if (normalized.startsWith("ABSTRACT")) return "ABSTRACT";
    if (normalized.startsWith("INTRODUCTION")) return "INTRODUCTION";
    if (normalized.startsWith("BACKGROUND")) return "BACKGROUND";
    if (normalized.startsWith("RELATED WORK")) return "RELATED WORK";
    if (normalized.startsWith("MATERIALS AND METHODS")) return "MATERIALS AND METHODS";
    if (normalized.startsWith("METHOD")) return "METHODS";
    if (normalized.startsWith("EXPERIMENT")) return "EXPERIMENTS";
    if (normalized.startsWith("RESULT")) return "RESULTS";
    if (normalized.startsWith("DISCUSSION")) return "DISCUSSION";
    if (normalized.startsWith("CONCLUSION")) return "CONCLUSIONS";
    if (normalized.startsWith("ACKNOWLEDG")) return "ACKNOWLEDGMENTS";
    if (normalized.startsWith("REFERENCE")) return "REFERENCES";
    if (normalized.startsWith("APPENDIX")) return "APPENDIX";
    if (normalized.startsWith("SUMMARY")) return "SUMMARY";
    return normalized;
  }

  function isLikelyHeadingNoise(text) {
    const normalized = normalizeWhitespace(text);
    if (!normalized) return true;
    if (/[,;]$/.test(normalized)) return true;
    if (/^https?:\/\//i.test(normalized) || /www\./i.test(normalized)) return true;
    if (/\b(doi|issn|copyright|license|vol\.?|no\.?|pp\.?|received|accepted)\b/i.test(normalized)) {
      return true;
    }
    if (/@/.test(normalized)) return true;
    if (/^(page\s*)?\d{1,4}$/i.test(normalized)) return true;
    if (/^[\[\](){}.,;:|/\\+\-*=]+$/.test(normalized)) return true;

    const words = normalized.split(/\s+/).filter(Boolean);
    if (words.length > 14) return true;
    return false;
  }

  function isLikelyGenericHeading(line, text) {
    const normalized = normalizeWhitespace(text);
    if (!normalized) return false;
    if (normalized.length < 2 || normalized.length > 90) return false;
    if (/[.;]$/.test(normalized)) return false;
    if (isLikelyHeadingNoise(normalized)) return false;

    const words = normalized.split(/\s+/).filter(Boolean);
    if (words.length > 12) return false;

    const numbered = /^((\d+(\.\d+)*)|([IVXLCM]+))\.?\s+/.test(normalized);
    if (numbered) return true;

    const hasKorean = /[\uAC00-\uD7A3]/.test(normalized);
    const letters = normalized.match(/[A-Za-z]/g) || [];
    const uppers = normalized.match(/[A-Z]/g) || [];
    const upperRatio = letters.length ? uppers.length / letters.length : 0;

    const strongBold = Number(line?.boldRatio || 0) >= 0.75 && words.length <= 9;
    const upperHeading = !hasKorean && letters.length >= 4 && upperRatio >= 0.9 && words.length <= 8;
    const koreanHeading = hasKorean && Number(line?.boldRatio || 0) >= 0.65 && words.length <= 10;

    return strongBold || upperHeading || koreanHeading;
  }

  function detectHeadingTitle(line) {
    const rawText = normalizeWhitespace(line?.text || "");
    if (!rawText) return null;
    if (Number(line?.italicRatio || 0) >= 0.55) return null;

    const trimmed = rawText.replace(/[.:\-]+$/, "").trim();
    if (!trimmed) return null;

    if (isLikelyHeadingNoise(trimmed)) return null;

    const inlineMatch = trimmed.match(
      /^(abstract|introduction|background|related work|methods?|materials(?:\s+and)?\s+methods?|experiments?|results?|discussion|conclusions?|references|appendix|summary)\s*[:-]\s*(.+)$/i
    );
    if (inlineMatch) {
      return canonicalHeading(inlineMatch[1]);
    }

    const canonical = canonicalHeading(trimmed);
    if (HEADING_KEYWORDS.has(canonical)) {
      return canonical;
    }

    if (isLikelyGenericHeading(line, trimmed)) {
      return trimmed;
    }

    return null;
  }

  function formatSectionId(index) {
    return `S${toPaddedNumber(index, 3)}`;
  }

  function assignSections(lines) {
    const sections = [];
    let currentSection = null;

    lines.forEach((line) => {
      const headingTitle = detectHeadingTitle(line);
      if (headingTitle) {
        const previous = sections[sections.length - 1];
        if (
          previous &&
          previous.title === headingTitle &&
          line.globalIndex - previous.startGlobalIndex < 5
        ) {
          currentSection = previous;
        } else {
          const section = {
            id: formatSectionId(sections.length + 1),
            title: headingTitle,
            pageNumber: line.pageNumber,
            startGlobalIndex: line.globalIndex
          };
          sections.push(section);
          currentSection = section;
        }

        line.isHeading = true;
        line.sectionId = currentSection.id;
        line.sectionTitle = currentSection.title;
        return;
      }

      if (!currentSection) {
        currentSection = {
          id: formatSectionId(1),
          title: "UNSPECIFIED",
          pageNumber: line.pageNumber,
          startGlobalIndex: line.globalIndex
        };
        sections.push(currentSection);
      }

      line.sectionId = currentSection.id;
      line.sectionTitle = currentSection.title;
    });

    return sections;
  }

  function stitchParagraphLines(lines) {
    let combined = "";

    lines.forEach((lineText) => {
      const text = normalizeWhitespace(lineText);
      if (!text) return;

      if (!combined) {
        combined = text;
        return;
      }

      if (combined.endsWith("-") && /^[a-z]/.test(text)) {
        combined = `${combined.slice(0, -1)}${text}`;
        return;
      }

      if (/^[,.;:!?%)\]\}]/.test(text)) {
        combined += text;
        return;
      }

      combined += ` ${text}`;
    });

    return normalizeWhitespace(combined);
  }

  function buildParagraphEntries(lines) {
    const entries = [];
    let buffer = [];
    let pageNumber = null;
    let sectionId = "";
    let sectionTitle = "";

    function flush() {
      if (buffer.length === 0) return;
      const text = stitchParagraphLines(buffer);
      buffer = [];
      if (!text || text.length < 5) return;
      entries.push({
        pageNumber,
        sectionId,
        sectionTitle,
        text
      });
    }

    lines.forEach((line) => {
      const text = normalizeWhitespace(line?.text || "");
      if (!text) return;

      if (line.isHeading) {
        flush();
        return;
      }

      const nextPageNumber = Number(line.pageNumber) || 1;
      const nextSectionId = String(line.sectionId || "S001");
      const nextSectionTitle = String(line.sectionTitle || "UNSPECIFIED");
      const shouldBreak =
        buffer.length > 0 &&
        (
          nextPageNumber !== pageNumber ||
          nextSectionId !== sectionId ||
          Boolean(line.breakBefore)
        );

      if (shouldBreak) {
        flush();
      }

      if (buffer.length === 0) {
        pageNumber = nextPageNumber;
        sectionId = nextSectionId;
        sectionTitle = nextSectionTitle;
      }

      buffer.push(text);
    });

    flush();
    return entries;
  }

  function expandParagraphEntriesByChunk(paragraphEntries, chunkSize, overflow) {
    const expanded = [];

    paragraphEntries.forEach((entry, entryIndex) => {
      const chunks = chunkTextBySentenceForPdf(entry?.text || "", chunkSize, overflow)
        .map((item) => normalizeWhitespace(item))
        .filter(Boolean);
      if (chunks.length === 0) return;

      chunks.forEach((chunkText, chunkIndex) => {
        expanded.push({
          pageNumber: Number(entry?.pageNumber) || 1,
          sectionId: String(entry?.sectionId || "S001"),
          sectionTitle: String(entry?.sectionTitle || "UNSPECIFIED"),
          text: chunkText,
          sourceParagraphIndex: entryIndex + 1,
          chunkIndex: chunkIndex + 1,
          chunkCount: chunks.length
        });
      });
    });

    return expanded;
  }

  function buildCitationPayload(fileName, pageCount, sections, paragraphEntries) {
    const paragraphs = {};
    const sentinelMap = {};
    const firstParagraphBySection = new Map();
    const chunkSize = resolveChunkSize();
    const chunkOverflow = resolveChunkOverflow(chunkSize);
    const chunkedEntries = expandParagraphEntriesByChunk(paragraphEntries, chunkSize, chunkOverflow);

    chunkedEntries.forEach((entry, index) => {
      const sentinelId = formatSentinelIdValue(index + 1);
      const paragraphKey = `[${toPaddedNumber(index + 1, 4)}]`;
      if (!firstParagraphBySection.has(entry.sectionId)) {
        firstParagraphBySection.set(entry.sectionId, paragraphKey);
      }

      paragraphs[paragraphKey] = wrapWithSentinelToken(sentinelId, entry.text);
      sentinelMap[sentinelId] = {
        id: sentinelId,
        order: index + 1,
        source: "pdf",
        targetType: "paragraph",
        sourceKey: paragraphKey,
        displayKey: formatSentinelOpenTokenValue(sentinelId),
        pageNumber: Number(entry.pageNumber) || 1,
        sectionId: String(entry.sectionId || "S001"),
        sectionTitle: String(entry.sectionTitle || "UNSPECIFIED"),
        sourceParagraphIndex: Number(entry.sourceParagraphIndex) || null,
        chunkIndex: Number(entry.chunkIndex) || null,
        chunkCount: Number(entry.chunkCount) || null
      };
    });

    const sectionMeta = sections.map((section) => ({
      id: section.id,
      title: section.title,
      pageNumber: section.pageNumber,
      startParagraph: firstParagraphBySection.get(section.id) || null
    }));

    return {
      paragraphs,
      claims: {},
      sentinelMap,
      meta: {
        source: "pdf",
        fileName: String(fileName || "citation.pdf"),
        pageCount: Number(pageCount) || 0,
        sectionCount: sectionMeta.length,
        sections: sectionMeta,
        paragraphCount: chunkedEntries.length,
        claimCount: 0,
        sentinelCount: Object.keys(sentinelMap).length,
        chunkSize
      }
    };
  }

  async function parsePdfDocument(file) {
    const pdfjsLib = await loadPdfJs();
    const loadingTask = pdfjsLib.getDocument({
      data: await file.arrayBuffer(),
      useWorkerFetch: false,
      isEvalSupported: false,
      disableFontFace: false
    });

    const documentProxy = await loadingTask.promise;
    const lines = [];
    let globalIndex = 0;

    try {
      for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
        const page = await documentProxy.getPage(pageNumber);
        const textContent = await page.getTextContent({
          includeMarkedContent: true,
          disableCombineTextItems: false
        });

        const pageLines = buildLinesFromTextContent(textContent).map((line, localIndex) => ({
          ...line,
          pageNumber,
          localIndex,
          globalIndex: globalIndex++
        }));

        lines.push(...pageLines);
      }
    } finally {
      try {
        documentProxy.cleanup();
      } catch (_error) {
        // Ignore cleanup errors.
      }
      try {
        await documentProxy.destroy();
      } catch (_error) {
        // Ignore destroy errors.
      }
    }

    return {
      pageCount: documentProxy.numPages,
      lines
    };
  }

  async function extractPdfCitationPayload(file) {
    if (!file) {
      throw new Error("No file provided.");
    }

    const fileName = String(file.name || "");
    const isPdf =
      file.type === "application/pdf" ||
      fileName.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      throw new Error("Only PDF files are supported.");
    }

    const parsed = await parsePdfDocument(file);
    if (!Array.isArray(parsed.lines) || parsed.lines.length === 0) {
      throw new Error("No readable text lines were found in this PDF.");
    }

    const sections = assignSections(parsed.lines);
    const paragraphEntries = buildParagraphEntries(parsed.lines);
    if (paragraphEntries.length === 0) {
      throw new Error("No readable paragraphs were found in this PDF.");
    }

    return buildCitationPayload(fileName, parsed.pageCount, sections, paragraphEntries);
  }

  globalScope.KLarcPdfExtractor = Object.freeze({
    extractPdfCitationPayload
  });
})(typeof globalThis !== "undefined" ? globalThis : self);
