const HISTORY_KEY = "bp_history_v1";
const QUEUE_STATUS_KEY = "kscan_queue_status_v1";
const RESULT_UI_STATE_KEY = "kscan_result_ui_state_v1";
const KQUERY_LATEST_ARTIFACT_KEY = "kquery_latest_artifact_v1";
const KQUERY_QUERY_VERSIONS_KEY = "kquery_query_versions_v1";
const KSCAN_FEEDBACK_DRAFT_KEY = "kscan_feedback_draft_v1";
const PAGE_SIZE = 20;
const SCORE_HIGH_THRESHOLD = 60;
const SCORE_LOW_THRESHOLD = 40;

const latestMetaEl = document.getElementById("latestMeta");
const latestBoxEl = document.getElementById("latestBox");
const latestScoreEl = document.getElementById("latestScore");
const tbodyEl = document.getElementById("tbody");
const countEl = document.getElementById("count");
const filter60El = document.getElementById("filter60");
const sortModeEl = document.getElementById("sortMode");
const searchInputEl = document.getElementById("searchInput");
const paginationEl = document.getElementById("pagination");
const checkAllPageEl = document.getElementById("checkAllPage");
const extractSelectedBtn = document.getElementById("extractSelected");
const copySelectedAppNosBtn = document.getElementById("copySelectedAppNos");
const reevaluateSelectedBtn = document.getElementById("reevaluateSelected");
const clearSelectedRowsBtn = document.getElementById("clearSelectedRows");
const selectedCountEl = document.getElementById("selectedCount");
const selectedAppNosEl = document.getElementById("selectedAppNos");

const contentModalEl = document.getElementById("contentModal");
const modalTitleEl = document.getElementById("modalTitle");
const modalBodyEl = document.getElementById("modalBody");
const modalCloseEl = document.getElementById("modalClose");
const inspectorMetaEl = document.getElementById("inspectorMeta");
const inspectorBodyEl = document.getElementById("inspectorBody");

const copyBtn = document.getElementById("copyLatest");
const clearBtn = document.getElementById("clear");

let latest = null;
let filterOnly60 = false;
let sortMode = "latest";
let searchKeyword = "";
let currentPage = 1;
let lastHistory = [];
let lastQueueRaw = null;
let lastPageRowKeys = [];
let selectedOutputText = "";
const selectedRowKeys = new Set();
let activeInspectorRowKey = "";
let queueStatus = {
  queued: 0,
  running: 0,
  completed: 0,
  active: false
};

function normalizeUiState(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const state = {
    filterOnly60: !!src.filterOnly60,
    sortMode: src.sortMode === "score" ? "score" : "latest",
    currentPage: Number.isInteger(src.currentPage) && src.currentPage > 0 ? src.currentPage : 1,
    searchKeyword: typeof src.searchKeyword === "string" ? src.searchKeyword : ""
  };
  return state;
}

function getUiStateSnapshot() {
  return {
    filterOnly60,
    sortMode,
    currentPage,
    searchKeyword
  };
}

function persistUiState() {
  void chrome.storage.local.set({
    [RESULT_UI_STATE_KEY]: getUiStateSnapshot()
  }).catch(() => {});
}

async function loadUiState() {
  try {
    const data = await chrome.storage.local.get([RESULT_UI_STATE_KEY]);
    const loaded = normalizeUiState(data[RESULT_UI_STATE_KEY]);
    filterOnly60 = loaded.filterOnly60;
    sortMode = loaded.sortMode;
    currentPage = loaded.currentPage;
    searchKeyword = loaded.searchKeyword;
  } catch {
    filterOnly60 = false;
    sortMode = "latest";
    currentPage = 1;
    searchKeyword = "";
  }

  if (filter60El) filter60El.checked = filterOnly60;
  if (sortModeEl) sortModeEl.value = sortMode;
  if (searchInputEl) searchInputEl.value = searchKeyword;
}

function parseScoreAndText(response) {
  const s = (response ?? "").toString();

  // "점수 텍스트..." 형태에서 점수 숫자만 추출
  const m = s.match(/^\s*(\d{1,3})(?:\.\d+)?\b/);
  if (!m) return { score: null, text: s.trim() };

  const score = Math.max(0, Math.min(100, Number(m[1])));
  const rest = s.slice(m[0].length).trimStart();
  return { score, text: rest };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeMarkdownLinkUrl(rawUrl) {
  const url = String(rawUrl || "").trim();
  if (!/^https?:\/\//i.test(url)) return "#";
  return url.replace(/"/g, "%22");
}

function renderInlineMarkdown(rawText) {
  let html = escapeHtml(rawText);
  const codeTokens = [];

  html = html.replace(/`([^`]+)`/g, (_match, codeText) => {
    const token = `__KSCAN_CODE_${codeTokens.length}__`;
    codeTokens.push(`<code>${codeText}</code>`);
    return token;
  });

  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label, link) => {
    const safeUrl = sanitizeMarkdownLinkUrl(link);
    return `<a href="${safeUrl}" target="_blank" rel="noreferrer noopener">${label}</a>`;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");

  codeTokens.forEach((tokenHtml, index) => {
    html = html.replace(`__KSCAN_CODE_${index}__`, tokenHtml);
  });
  return html;
}

function renderMarkdownPreviewHtml(markdownText) {
  const source = String(markdownText ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!source) return "";

  let inCodeBlock = false;
  const lines = [];

  source.split("\n").forEach((rawLine) => {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      inCodeBlock = !inCodeBlock;
      return;
    }

    if (!trimmed) {
      lines.push("");
      return;
    }

    if (inCodeBlock) {
      lines.push(renderInlineMarkdown(`\`${trimmed}\``));
      return;
    }

    const heading = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      lines.push(renderInlineMarkdown(heading[1]));
      return;
    }

    const unordered = trimmed.match(/^[-*+]\s+(.+)$/);
    if (unordered) {
      lines.push(`&bull; ${renderInlineMarkdown(unordered[1])}`);
      return;
    }

    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      lines.push(`&bull; ${renderInlineMarkdown(ordered[1])}`);
      return;
    }

    const blockquote = trimmed.match(/^>\s?(.+)$/);
    if (blockquote) {
      lines.push(renderInlineMarkdown(blockquote[1]));
      return;
    }

    lines.push(renderInlineMarkdown(trimmed));
  });

  return lines.join("<br>");
}

function renderMarkdownToHtml(markdownText) {
  const source = String(markdownText ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!source) return "";

  const out = [];
  let inCodeBlock = false;
  let codeLines = [];
  let openList = null;

  const closeList = () => {
    if (openList === "ul") out.push("</ul>");
    if (openList === "ol") out.push("</ol>");
    openList = null;
  };
  const closeCodeBlock = () => {
    if (!inCodeBlock) return;
    out.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    inCodeBlock = false;
    codeLines = [];
  };

  source.split("\n").forEach((rawLine) => {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (/^```/.test(trimmed)) {
      closeList();
      if (inCodeBlock) {
        closeCodeBlock();
      } else {
        inCodeBlock = true;
        codeLines = [];
      }
      return;
    }

    if (inCodeBlock) {
      codeLines.push(rawLine);
      return;
    }

    if (!trimmed) {
      closeList();
      return;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = Math.max(1, Math.min(6, heading[1].length));
      out.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      return;
    }

    const unordered = trimmed.match(/^[-*+]\s+(.+)$/);
    if (unordered) {
      if (openList !== "ul") {
        closeList();
        openList = "ul";
        out.push("<ul>");
      }
      out.push(`<li>${renderInlineMarkdown(unordered[1])}</li>`);
      return;
    }

    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      if (openList !== "ol") {
        closeList();
        openList = "ol";
        out.push("<ol>");
      }
      out.push(`<li>${renderInlineMarkdown(ordered[1])}</li>`);
      return;
    }

    const blockquote = trimmed.match(/^>\s?(.+)$/);
    if (blockquote) {
      closeList();
      out.push(`<blockquote>${renderInlineMarkdown(blockquote[1])}</blockquote>`);
      return;
    }

    closeList();
    out.push(`<p>${renderInlineMarkdown(trimmed)}</p>`);
  });

  closeList();
  closeCodeBlock();
  return out.join("");
}

function setMarkdownContent(targetEl, markdownText, emptyText = "(내용 없음)") {
  if (!targetEl) return;
  const html = renderMarkdownToHtml(markdownText);
  if (!html) {
    targetEl.innerHTML = `<p class="markdown-empty">${escapeHtml(emptyText)}</p>`;
    return;
  }
  targetEl.innerHTML = html;
}

function classByScore(score) {
  if (typeof score !== "number") return "";
  if (score >= 60 && score <= 100) return "bg-blue";
  if (score >= 40 && score < 60) return "bg-green";
  return "";
}

function normalizeQueryVersionId(raw) {
  const value = String(raw ?? "").trim();
  return value || "";
}

function normalizeRunId(raw) {
  const value = String(raw ?? "").trim();
  return value || "";
}

function normalizeTermKey(term) {
  return String(term || "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-_]+/g, "");
}

function collectSelectedRows(history) {
  const arr = Array.isArray(history) ? history : [];
  const rows = [];
  arr.forEach((item, index) => {
    const rowKey = getRowKey(item, index);
    if (!selectedRowKeys.has(rowKey)) return;
    rows.push({ item, index, rowKey });
  });
  return rows;
}

function collectSelectedHistoryIds(history) {
  const rows = collectSelectedRows(history);
  const ids = rows
    .map((row) => String(row?.item?.id ?? "").trim())
    .filter(Boolean);
  return Array.from(new Set(ids));
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve({ ok: false, error: err.message || String(err) });
        return;
      }
      resolve(response && typeof response === "object" ? response : { ok: false, error: "No response" });
    });
  });
}

function resolveTargetQueryVersionScope(history) {
  const arr = Array.isArray(history) ? history : [];
  const selectedRows = collectSelectedRows(arr);

  if (selectedRows.length > 0) {
    const selectedVersionIds = selectedRows.map((row) => normalizeQueryVersionId(row.item?.queryVersionId));
    const hasMissingVersion = selectedVersionIds.some((value) => !value);
    if (hasMissingVersion) {
      return {
        ok: false,
        error: "선택 항목에 queryVersionId가 없는 결과가 포함되어 있어 피드백 초안을 만들 수 없습니다.",
        selectedRows
      };
    }

    const versionIds = new Set(selectedVersionIds);
    if (versionIds.size !== 1) {
      const error = "서로 다른 queryVersionId가 선택되어 피드백 초안을 만들 수 없습니다.";
      return { ok: false, error, selectedRows };
    }

    const targetQueryVersionId = Array.from(versionIds)[0];
    const scopedRows = selectedRows.filter(
      (row) => normalizeQueryVersionId(row.item?.queryVersionId) === targetQueryVersionId
    );
    return { ok: true, selectedRows, scopedRows, targetQueryVersionId, scopeType: "selected" };
  }

  const latestWithVersion = arr.find((row) => normalizeQueryVersionId(row?.queryVersionId));
  const targetQueryVersionId = normalizeQueryVersionId(latestWithVersion?.queryVersionId);
  if (!targetQueryVersionId) {
    return {
      ok: false,
      error: "queryVersionId가 있는 K-SCAN 결과가 없어 피드백 초안을 만들 수 없습니다.",
      selectedRows: [],
      scopedRows: []
    };
  }

  const scopedRows = arr
    .map((item, index) => ({ item, index, rowKey: getRowKey(item, index) }))
    .filter((row) => normalizeQueryVersionId(row.item?.queryVersionId) === targetQueryVersionId);

  return { ok: true, selectedRows: [], scopedRows, targetQueryVersionId, scopeType: "latest-version" };
}

function resolveVersionArtifact(targetQueryVersionId, data) {
  const versions = Array.isArray(data?.[KQUERY_QUERY_VERSIONS_KEY]) ? data[KQUERY_QUERY_VERSIONS_KEY] : [];
  const latest = data?.[KQUERY_LATEST_ARTIFACT_KEY] && typeof data[KQUERY_LATEST_ARTIFACT_KEY] === "object"
    ? data[KQUERY_LATEST_ARTIFACT_KEY]
    : null;

  const normalizedTarget = normalizeQueryVersionId(targetQueryVersionId);
  const fromVersions = versions
    .map((entry) => (entry?.snapshot && typeof entry.snapshot === "object" ? entry.snapshot : entry))
    .find((entry) => normalizeQueryVersionId(entry?.queryVersionId) === normalizedTarget);

  if (fromVersions) {
    return {
      artifact: fromVersions,
      source: "query-version-history",
      fallbackUsed: false
    };
  }

  if (latest && normalizeQueryVersionId(latest.queryVersionId) === normalizedTarget) {
    return {
      artifact: latest,
      source: "latest-exact",
      fallbackUsed: false
    };
  }

  if (latest) {
    return {
      artifact: latest,
      source: "latest-fallback",
      fallbackUsed: true
    };
  }

  return {
    artifact: null,
    source: "none",
    fallbackUsed: true
  };
}

function collectFeatureCatalog(artifact) {
  if (!artifact || typeof artifact !== "object") return [];
  const elements = Array.isArray(artifact.elements) ? artifact.elements : [];
  const synonymsById = artifact.synonymsById && typeof artifact.synonymsById === "object"
    ? artifact.synonymsById
    : {};

  return elements.map((element) => {
    const featureId = String(element?.id || "").trim();
    const term = String(element?.term || "").trim();
    const synonyms = Array.isArray(synonymsById[featureId]) ? synonymsById[featureId] : [];
    const terms = [term];
    synonyms.forEach((item) => {
      if (typeof item === "string" && item.trim()) {
        terms.push(item.trim());
        return;
      }
      if (item && typeof item === "object" && String(item.term || "").trim()) {
        terms.push(String(item.term).trim());
      }
    });
    const dedupedTerms = Array.from(
      new Set(terms.map((value) => value.trim()).filter(Boolean))
    );
    return {
      featureId,
      term,
      terms: dedupedTerms
    };
  }).filter((feature) => feature.featureId || feature.term);
}

function buildFeatureMapping(scopedRows, artifact) {
  const catalog = collectFeatureCatalog(artifact);
  if (catalog.length === 0) {
    return {
      featureCount: 0,
      mappedFeatureCount: 0,
      features: []
    };
  }

  const features = catalog.map((feature) => ({
    featureId: feature.featureId,
    term: feature.term,
    hitCount: 0,
    evidenceResultIds: []
  }));

  scopedRows.forEach(({ item, index }) => {
    const text = [
      String(item?.response ?? ""),
      String(item?.responseReason ?? ""),
      String(item?.citationClaimText ?? "")
    ].join(" ");
    const textKey = normalizeTermKey(text);
    if (!textKey) return;

    features.forEach((feature, featureIndex) => {
      const matched = catalog[featureIndex].terms.some((term) => {
        const key = normalizeTermKey(term);
        return !!key && textKey.includes(key);
      });
      if (!matched) return;
      features[featureIndex].hitCount += 1;
      const resultId = String(item?.id ?? getRowKey(item, index));
      if (!features[featureIndex].evidenceResultIds.includes(resultId)) {
        features[featureIndex].evidenceResultIds.push(resultId);
      }
    });
  });

  return {
    featureCount: catalog.length,
    mappedFeatureCount: features.filter((feature) => feature.hitCount > 0).length,
    features
  };
}

function buildScoreDistribution(scopedRows) {
  const distribution = {
    high: 0,
    mid: 0,
    low: 0,
    unknown: 0,
    total: scopedRows.length
  };

  scopedRows.forEach(({ item }) => {
    const { score } = parseScoreAndText(item?.response ?? "");
    if (typeof score !== "number") {
      distribution.unknown += 1;
      return;
    }
    if (score >= SCORE_HIGH_THRESHOLD) {
      distribution.high += 1;
      return;
    }
    if (score < SCORE_LOW_THRESHOLD) {
      distribution.low += 1;
      return;
    }
    distribution.mid += 1;
  });

  return distribution;
}

function buildEvidenceRows(scopedRows) {
  return scopedRows.map(({ item, index }) => {
    const { score, text } = parseScoreAndText(item?.response ?? "");
    return {
      resultId: String(item?.id ?? getRowKey(item, index)),
      applicationNo: String(item?.applicationNo ?? "").trim(),
      queryVersionId: normalizeQueryVersionId(item?.queryVersionId),
      runId: normalizeRunId(item?.runId),
      score: typeof score === "number" ? score : null,
      reason: text || String(item?.responseReason ?? "").trim(),
      time: String(item?.time ?? "").trim()
    };
  });
}

async function buildAndStoreFeedbackDraft(history, { showAlertOnError = true } = {}) {
  const scope = resolveTargetQueryVersionScope(history);
  if (!scope.ok) {
    if (showAlertOnError && scope.error) alert(scope.error);
    return { ok: false, error: scope.error || "feedback draft scope error" };
  }

  const scopedRows = Array.isArray(scope.scopedRows) ? scope.scopedRows : [];
  if (scopedRows.length === 0) {
    const error = "선택한 queryVersionId 범위에 해당하는 결과가 없어 피드백 초안을 만들 수 없습니다.";
    if (showAlertOnError) alert(error);
    return { ok: false, error };
  }

  const storageData = await chrome.storage.local.get([
    KQUERY_QUERY_VERSIONS_KEY,
    KQUERY_LATEST_ARTIFACT_KEY
  ]);
  const artifactResolution = resolveVersionArtifact(scope.targetQueryVersionId, storageData);
  const featureMapping = buildFeatureMapping(scopedRows, artifactResolution.artifact);
  const scoreDistribution = buildScoreDistribution(scopedRows);
  const evidenceRows = buildEvidenceRows(scopedRows);

  const payload = {
    createdAt: new Date().toISOString(),
    targetQueryVersionId: scope.targetQueryVersionId,
    scopeType: scope.scopeType,
    selectedRowCount: scope.selectedRows.length,
    scopedRowCount: scopedRows.length,
    thresholds: {
      scoreHigh: SCORE_HIGH_THRESHOLD,
      scoreLow: SCORE_LOW_THRESHOLD
    },
    scoreDistribution,
    evidenceRows,
    featureMapping,
    artifact: {
      source: artifactResolution.source,
      matchedQueryVersionId: normalizeQueryVersionId(artifactResolution.artifact?.queryVersionId),
      fallbackUsed: !!artifactResolution.fallbackUsed,
      fallbackReason: artifactResolution.fallbackUsed ? "no-matching-query-version-artifact" : ""
    }
  };

  await chrome.storage.local.set({
    [KSCAN_FEEDBACK_DRAFT_KEY]: payload
  });

  return { ok: true, payload };
}

function getRowKey(item, sourceIndex = -1) {
  const stableId = String(item?.id ?? "").trim();
  if (stableId) return `id:${stableId}`;

  const timeText = String(item?.time ?? "").trim();
  const appNo = String(item?.applicationNo ?? "").trim();
  const fallbackIndex = Number.isInteger(sourceIndex) ? sourceIndex : -1;
  return `fallback:${fallbackIndex}:${timeText}:${appNo}`;
}

function buildHistoryRowKeySet(history) {
  const set = new Set();
  const arr = Array.isArray(history) ? history : [];
  arr.forEach((item, index) => {
    set.add(getRowKey(item, index));
  });
  return set;
}

function pruneSelectedRows(history) {
  const validKeys = buildHistoryRowKeySet(history);
  for (const key of Array.from(selectedRowKeys)) {
    if (!validKeys.has(key)) {
      selectedRowKeys.delete(key);
    }
  }
}

function collectSelectedApplicationNos(history) {
  const arr = Array.isArray(history) ? history : [];
  const seen = new Set();
  const appNos = [];

  arr.forEach((item, index) => {
    const rowKey = getRowKey(item, index);
    if (!selectedRowKeys.has(rowKey)) return;

    const appNo = String(item?.applicationNo ?? "").trim();
    if (!appNo || seen.has(appNo)) return;
    seen.add(appNo);
    appNos.push(appNo);
  });

  return appNos;
}

function buildSelectedApplicationNoText(history) {
  return collectSelectedApplicationNos(history).join(" | ");
}

function updateSelectedOutput(history) {
  const appNos = collectSelectedApplicationNos(history);
  selectedOutputText = appNos.join(" | ");

  if (selectedCountEl) {
    selectedCountEl.textContent = `선택 ${selectedRowKeys.size}건 / 추출 가능 ${appNos.length}건`;
  }
  if (selectedAppNosEl) {
    selectedAppNosEl.textContent = selectedOutputText || "선택된 항목의 출원번호가 여기에 표시됩니다.";
  }
  if (copySelectedAppNosBtn) {
    copySelectedAppNosBtn.disabled = !selectedOutputText;
  }
}

function updateCheckAllPageState() {
  if (!checkAllPageEl) return;

  const total = Array.isArray(lastPageRowKeys) ? lastPageRowKeys.length : 0;
  if (total === 0) {
    checkAllPageEl.checked = false;
    checkAllPageEl.indeterminate = false;
    checkAllPageEl.disabled = true;
    return;
  }

  let selectedCount = 0;
  for (const key of lastPageRowKeys) {
    if (selectedRowKeys.has(key)) selectedCount += 1;
  }

  checkAllPageEl.disabled = false;
  checkAllPageEl.checked = selectedCount === total;
  checkAllPageEl.indeterminate = selectedCount > 0 && selectedCount < total;
}

function normalizeQueueStatus(raw) {
  const obj = raw && typeof raw === "object" ? raw : {};
  const toCount = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  return {
    queued: toCount(obj.queued),
    running: toCount(obj.running),
    completed: toCount(obj.completed),
    active: !!obj.active
  };
}

function setQueueScoreBox(status) {
  latestBoxEl.classList.remove("bg-green", "bg-blue");
  latestBoxEl.classList.add("queueMode");
  latestScoreEl.innerHTML = [
    '<div class="queueGrid">',
    `<div class="queueCell"><span class="queueLabel">대기</span><span class="queueValue">${status.queued}</span></div>`,
    `<div class="queueCell"><span class="queueLabel">진행</span><span class="queueValue">${status.running}</span></div>`,
    `<div class="queueCell"><span class="queueLabel">완료</span><span class="queueValue">${status.completed}</span></div>`,
    "</div>"
  ].join("");
}

function setScoreBoxByLatest(item) {
  latestBoxEl.classList.remove("queueMode", "bg-green", "bg-blue");

  if (!item) {
    latestMetaEl.textContent = "히스토리 없음";
    latestScoreEl.textContent = "";
    return;
  }

  const state =
    item.apiOk === null ? "대기" :
    item.apiOk ? "성공" : "실패";

  const appNo = item.applicationNo ?? "-";
  latestMetaEl.textContent =
`시간: ${item.time}
출원번호: ${appNo}
상태: ${state}${item.apiStatus != null ? ` (${item.apiStatus})` : ""}`;

  const { score } = parseScoreAndText(item.response ?? "");
  latestScoreEl.textContent = (typeof score === "number") ? String(score) : (item.response ?? "");

  const cls = classByScore(score);
  if (cls) latestBoxEl.classList.add(cls);
}

function buildEntrySearchSource(entry) {
  const item = entry?.item || {};
  return [
    String(item?.applicationNo ?? ""),
    String(item?.time ?? ""),
    String(entry?.text ?? ""),
    String(item?.response ?? "")
  ]
    .join(" ")
    .toLowerCase();
}

function isEntryMatchedBySearch(entry, keyword) {
  const normalized = String(keyword || "").trim().toLowerCase();
  if (!normalized) return true;
  return buildEntrySearchSource(entry).includes(normalized);
}

function renderInspector(entry) {
  if (!inspectorMetaEl || !inspectorBodyEl) return;

  if (!entry || !entry.item) {
    inspectorMetaEl.innerHTML = "<div>출원번호: -</div><div>점수: -</div><div>시간: -</div>";
    setMarkdownContent(inspectorBodyEl, "", "테이블 행을 클릭하면 상세 내용이 표시됩니다.");
    return;
  }

  const appNo = String(entry.item?.applicationNo ?? "").trim() || "-";
  const scoreText = typeof entry.score === "number" ? String(entry.score) : "-";
  const timeText = String(entry.item?.time ?? "").trim() || "-";
  inspectorMetaEl.innerHTML = `<div>출원번호: ${appNo}</div><div>점수: ${scoreText}</div><div>시간: ${timeText}</div>`;
  setMarkdownContent(inspectorBodyEl, String(entry.text || entry.item?.response || "").trim(), "(내용 없음)");
}

function openContentModal(title, text) {
  modalTitleEl.textContent = title || "상세 내용";
  setMarkdownContent(modalBodyEl, text || "", "(내용 없음)");
  contentModalEl.classList.remove("hidden");
}

function closeContentModal() {
  contentModalEl.classList.add("hidden");
}

function buildViewItems(history) {
  const arr = Array.isArray(history) ? history : [];
  return arr.map((item, index) => {
    const { score, text } = parseScoreAndText(item.response ?? "");
    return { item, score, text, sourceIndex: index };
  });
}

function sortViewItems(items) {
  const arr = [...items];
  if (sortMode === "score") {
    arr.sort((a, b) => {
      const sa = typeof a.score === "number" ? a.score : -1;
      const sb = typeof b.score === "number" ? b.score : -1;
      if (sb !== sa) return sb - sa;
      return a.sourceIndex - b.sourceIndex;
    });
    return arr;
  }

  arr.sort((a, b) => a.sourceIndex - b.sourceIndex);
  return arr;
}

function renderPagination(totalPages) {
  paginationEl.innerHTML = "";
  for (let i = 1; i <= totalPages; i++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `pageBtn${i === currentPage ? " active" : ""}`;
    btn.textContent = String(i);
    btn.addEventListener("click", () => {
      if (currentPage === i) return;
      currentPage = i;
      persistUiState();
      render(lastHistory, lastQueueRaw);
    });
    paginationEl.appendChild(btn);
  }
}

async function copyTextToClipboard(text) {
  const normalized = String(text ?? "").trim();
  if (!normalized) return false;

  try {
    await navigator.clipboard.writeText(normalized);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = normalized;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    return true;
  }
}

function render(history, queue) {
  const arr = Array.isArray(history) ? history : [];
  pruneSelectedRows(arr);
  lastHistory = arr;
  lastQueueRaw = queue;

  latest = arr[0] ?? null;
  queueStatus = normalizeQueueStatus(queue);

  if (queueStatus.active) {
    latestMetaEl.textContent =
`큐 처리 중
대기: ${queueStatus.queued}
진행: ${queueStatus.running}
완료: ${queueStatus.completed}`;
    setQueueScoreBox(queueStatus);
  } else {
    setScoreBoxByLatest(latest);
  }

  let items = buildViewItems(arr);
  if (filterOnly60) {
    items = items.filter((entry) => typeof entry.score === "number" && entry.score >= 60);
  }
  if (searchKeyword.trim()) {
    items = items.filter((entry) => isEntryMatchedBySearch(entry, searchKeyword));
  }
  items = sortViewItems(items);

  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const prevPage = currentPage;
  currentPage = Math.min(Math.max(currentPage, 1), totalPages);
  if (currentPage !== prevPage) persistUiState();
  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const pageItems = items.slice(startIdx, startIdx + PAGE_SIZE);

  const hasKeyword = !!searchKeyword.trim();
  countEl.textContent = filterOnly60
    ? `총 ${items.length}개 표시 중 (60점 이상 / 전체 ${arr.length}개) | ${currentPage}/${totalPages} 페이지${hasKeyword ? " | 검색 적용" : ""}`
    : `총 ${items.length}개 표시 중 | ${currentPage}/${totalPages} 페이지${hasKeyword ? " | 검색 적용" : ""}`;

  tbodyEl.innerHTML = "";
  lastPageRowKeys = [];
  for (const entry of pageItems) {
    const { item, score, text } = entry;
    const rowKey = getRowKey(item, entry.sourceIndex);
    lastPageRowKeys.push(rowKey);

    const tr = document.createElement("tr");
    const rowCls = classByScore(score);
    if (rowCls) tr.classList.add(rowCls);
    if (rowKey === activeInspectorRowKey) tr.classList.add("is-selected");

    const tdCheck = document.createElement("td");
    tdCheck.className = "checkCell";
    const rowCheck = document.createElement("input");
    rowCheck.type = "checkbox";
    rowCheck.className = "rowCheck";
    rowCheck.checked = selectedRowKeys.has(rowKey);
    rowCheck.setAttribute("aria-label", "행 선택");
    rowCheck.addEventListener("change", () => {
      if (rowCheck.checked) {
        selectedRowKeys.add(rowKey);
      } else {
        selectedRowKeys.delete(rowKey);
      }
      updateCheckAllPageState();
      updateSelectedOutput(lastHistory);
    });
    tdCheck.appendChild(rowCheck);

    const tdTime = document.createElement("td");
    tdTime.textContent = item.time ?? "";

    const tdAppNo = document.createElement("td");
    tdAppNo.className = "appNoCell";
    const appNo = String(item.applicationNo ?? "").trim();
    if (appNo) {
      const appNoLink = document.createElement("a");
      appNoLink.className = "appNoLink";
      appNoLink.href = `http://${encodeURI(appNo)}`;
      appNoLink.target = "_blank";
      appNoLink.rel = "noreferrer noopener";
      appNoLink.textContent = appNo;
      tdAppNo.appendChild(appNoLink);
    } else {
      tdAppNo.textContent = "-";
    }

    const tdScore = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "badge";
    const badgeCls = classByScore(score);
    if (badgeCls) badge.classList.add(badgeCls);
    badge.textContent = (typeof score === "number") ? String(score) : "-";
    tdScore.appendChild(badge);

    const tdContent = document.createElement("td");
    tdContent.className = "contentCell";

    const preview = document.createElement("div");
    preview.className = "contentPreview markdown-content";
    preview.innerHTML = renderMarkdownPreviewHtml(text || "");
    tdContent.appendChild(preview);

    tr.appendChild(tdCheck);
    tr.appendChild(tdTime);
    tr.appendChild(tdAppNo);
    tr.appendChild(tdScore);
    tr.appendChild(tdContent);
    tbodyEl.appendChild(tr);

    tr.addEventListener("click", (event) => {
      const target = event.target;
      if (target instanceof HTMLElement) {
        if (target.closest("a") || target.closest("input") || target.closest("button")) return;
      }
      activeInspectorRowKey = rowKey;
      renderInspector(entry);
      render(lastHistory, lastQueueRaw);
    });

    if (preview.scrollHeight > preview.clientHeight + 1) {
      preview.classList.add("expandable");
      preview.title = "클릭해서 전체 내용 보기";
      preview.setAttribute("role", "button");
      preview.tabIndex = 0;

      const open = () => {
        const title = `상세 내용 - ${appNo || "-"} / ${item.time || ""}`;
        openContentModal(title, text || "");
      };
      preview.addEventListener("click", open);
      preview.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        open();
      });
    }
  }

  const activeEntry = items.find((entry) => getRowKey(entry.item, entry.sourceIndex) === activeInspectorRowKey)
    || pageItems[0]
    || null;
  if (activeEntry) {
    activeInspectorRowKey = getRowKey(activeEntry.item, activeEntry.sourceIndex);
  } else {
    activeInspectorRowKey = "";
  }
  renderInspector(activeEntry);

  updateCheckAllPageState();
  updateSelectedOutput(arr);
  renderPagination(totalPages);
}

async function loadAndRender() {
  const data = await chrome.storage.local.get([HISTORY_KEY, QUEUE_STATUS_KEY]);
  render(data[HISTORY_KEY], data[QUEUE_STATUS_KEY]);
}

copyBtn.addEventListener("click", async () => {
  const { score } = parseScoreAndText(latest?.response ?? "");
  const text = (typeof score === "number") ? String(score) : "";

  if (!text) return;
  await copyTextToClipboard(text);
});

extractSelectedBtn?.addEventListener("click", () => {
  selectedOutputText = buildSelectedApplicationNoText(lastHistory);
  if (selectedAppNosEl) {
    selectedAppNosEl.textContent = selectedOutputText || "선택된 항목의 출원번호가 여기에 표시됩니다.";
  }
  const hasVersionedRows = Array.isArray(lastHistory)
    && lastHistory.some((item) => normalizeQueryVersionId(item?.queryVersionId));
  if (hasVersionedRows) {
    void buildAndStoreFeedbackDraft(lastHistory, { showAlertOnError: true }).catch(() => {});
  }

  if (!selectedOutputText) {
    alert("선택된 항목에서 추출 가능한 출원번호가 없습니다.");
    return;
  }
  updateSelectedOutput(lastHistory);
});

copySelectedAppNosBtn?.addEventListener("click", async () => {
  const text = String(selectedOutputText || "").trim();
  if (!text) {
    alert("먼저 선택 항목 출원번호를 추출해 주세요.");
    return;
  }
  await copyTextToClipboard(text);
});

reevaluateSelectedBtn?.addEventListener("click", async () => {
  const historyIds = collectSelectedHistoryIds(lastHistory);
  if (historyIds.length === 0) {
    alert("재평가할 항목을 먼저 선택해 주세요.");
    return;
  }

  reevaluateSelectedBtn.disabled = true;
  const originalLabel = reevaluateSelectedBtn.textContent;
  reevaluateSelectedBtn.textContent = "재평가 요청 중...";
  try {
    const result = await sendRuntimeMessage({
      type: "KSCAN_REEVALUATE_SELECTED",
      historyIds
    });

    if (!result?.ok) {
      alert(`선택 재평가 요청 실패: ${result?.error || "unknown error"}`);
      return;
    }

    const queued = Number(result?.queued || 0);
    const skipped = Number(result?.skipped || 0);
    const missing = Number(result?.missing || 0);
    alert(`재평가 요청 완료: ${queued}건 큐 등록${skipped > 0 ? `, ${skipped}건 제외` : ""}${missing > 0 ? `, ${missing}건 미존재` : ""}`);
  } finally {
    reevaluateSelectedBtn.disabled = false;
    reevaluateSelectedBtn.textContent = originalLabel || "선택 재평가";
  }
});

clearSelectedRowsBtn?.addEventListener("click", () => {
  if (selectedRowKeys.size === 0) return;
  selectedRowKeys.clear();
  selectedOutputText = "";
  render(lastHistory, lastQueueRaw);
});

checkAllPageEl?.addEventListener("change", () => {
  const shouldSelect = !!checkAllPageEl.checked;
  if (shouldSelect) {
    lastPageRowKeys.forEach((key) => selectedRowKeys.add(key));
  } else {
    lastPageRowKeys.forEach((key) => selectedRowKeys.delete(key));
  }
  render(lastHistory, lastQueueRaw);
});

filter60El?.addEventListener("change", () => {
  filterOnly60 = !!filter60El.checked;
  currentPage = 1;
  persistUiState();
  render(lastHistory, lastQueueRaw);
});

sortModeEl?.addEventListener("change", () => {
  sortMode = sortModeEl.value === "score" ? "score" : "latest";
  currentPage = 1;
  persistUiState();
  render(lastHistory, lastQueueRaw);
});

searchInputEl?.addEventListener("input", () => {
  searchKeyword = String(searchInputEl.value || "");
  currentPage = 1;
  persistUiState();
  render(lastHistory, lastQueueRaw);
});

clearBtn.addEventListener("click", async () => {
  currentPage = 1;
  selectedRowKeys.clear();
  selectedOutputText = "";
  activeInspectorRowKey = "";
  persistUiState();
  await chrome.storage.local.set({ [HISTORY_KEY]: [] });
  await loadAndRender();
});

modalCloseEl?.addEventListener("click", closeContentModal);
contentModalEl?.addEventListener("click", (event) => {
  if (event.target !== contentModalEl) return;
  closeContentModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (contentModalEl.classList.contains("hidden")) return;
  closeContentModal();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[HISTORY_KEY] || changes[QUEUE_STATUS_KEY]) loadAndRender().catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "KSCAN_BUILD_FEEDBACK_DRAFT") return undefined;

  (async () => {
    const result = await buildAndStoreFeedbackDraft(lastHistory, {
      showAlertOnError: msg?.showAlert !== false
    });
    sendResponse(result);
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error?.message || String(error)
    });
  });

  return true;
});

async function initialize() {
  await loadUiState();
  await loadAndRender();
}

initialize().catch(() => {});
