const HISTORY_KEY = "bp_history_v1";
const MAX_CAPTURE_ROWS = 3000;

const statusEl = document.getElementById("status");
const captureCountEl = document.getElementById("captureCount");
const captureMetaEl = document.getElementById("captureMeta");
const captureListEl = document.getElementById("captureList");
const startBtn = document.getElementById("start");
const stopBtn = document.getElementById("stop");
const refreshBtn = document.getElementById("refresh");
const exportBtn = document.getElementById("exportXlsx");
const clearBtn = document.getElementById("clear");

let currentRows = [];
let currentLoadTs = 0;

function setStatus(text, state = "idle") {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeRow(item, index) {
  const citationText = String(
    item?.citationText
    ?? item?.citation
    ?? item?.claimText
    ?? item?.payloadText
    ?? ""
  ).trim();

  return {
    id: String(item?.id ?? `row_${index}`).trim() || `row_${index}`,
    applicationNo: String(item?.applicationNo ?? "").trim(),
    citationText,
    time: String(item?.time ?? "").trim(),
    runId: String(item?.runId ?? "").trim(),
    queryVersionId: String(item?.queryVersionId ?? "").trim(),
    source: String(item?.source ?? "").trim(),
    url: String(item?.url ?? "").trim()
  };
}

function normalizeRowDedupeKey(row) {
  const appNo = String(row?.applicationNo ?? "").replace(/\s+/g, "").toUpperCase();
  if (appNo && /\d/.test(appNo)) return `app:${appNo}`;

  const citationText = String(row?.citationText ?? "").trim().replace(/\s+/g, " ");
  if (!citationText) return "";
  return `claim:${citationText.toLowerCase().slice(0, 700)}`;
}

function getSortedRows(rawRows) {
  const rows = Array.isArray(rawRows) ? rawRows : [];
  const seen = new Set();
  const out = [];

  rows.map(normalizeRow).forEach((row) => {
    if (!row.citationText && !row.applicationNo) return;
    const key = normalizeRowDedupeKey(row);
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    out.push(row);
  });

  return out;
}

function formatDateTime(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(parsed));
}

function formatTimestampForFile(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "_",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

function truncateText(text, maxLength = 220) {
  const value = String(text ?? "").trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

function renderCaptureList(rows) {
  if (!captureListEl) return;

  const total = Array.isArray(rows) ? rows.length : 0;
  if (captureCountEl) {
    captureCountEl.textContent = `${total.toLocaleString("ko-KR")}건`;
  }

  if (captureMetaEl) {
    captureMetaEl.textContent = total > 0
      ? `최근 수집: ${formatDateTime(rows[0]?.time || new Date().toISOString())}`
      : "수집된 항목이 없습니다.";
  }

  if (total === 0) {
    captureListEl.innerHTML = `
      <div class="empty-state">
        캡처된 청구항이 없습니다.
        <span>KOMPASS 탭에서 캡처를 시작하면 출원번호와 청구항이 여기에 쌓입니다.</span>
      </div>
    `;
    return;
  }

  captureListEl.innerHTML = rows.map((row, index) => {
    const rank = total - index;
    const appNo = row.applicationNo || "-";
    const claim = row.citationText || "";
    const claimPreview = truncateText(claim, 320) || "(내용 없음)";
    const timeText = formatDateTime(row.time);

    return `
      <article class="capture-item">
        <div class="capture-item-head">
          <div class="capture-item-left">
            <span class="capture-rank">#${rank}</span>
            <span class="capture-appno">${escapeHtml(appNo)}</span>
          </div>
          <div class="capture-item-time">${escapeHtml(timeText || "-")}</div>
        </div>
        <div class="capture-claim" title="${escapeHtml(claim)}">${escapeHtml(claimPreview)}</div>
      </article>
    `;
  }).join("");
}

async function loadRows() {
  const data = await chrome.storage.local.get([HISTORY_KEY]);
  const rows = getSortedRows(data[HISTORY_KEY]);
  currentRows = rows;
  currentLoadTs = Date.now();
  renderCaptureList(currentRows);
}

function isCapturableTab(tab) {
  if (!tab?.id) return false;
  const url = String(tab?.url || "");
  return url.startsWith("http://") || url.startsWith("https://");
}

async function getActiveTab() {
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs || tabs.length === 0 || !tabs[0]?.id) {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  }

  const active = tabs?.[0] || null;
  if (isCapturableTab(active)) return active;

  if (Number.isInteger(active?.windowId)) {
    const sameWindowTabs = await chrome.tabs.query({ windowId: active.windowId });
    const fallback = sameWindowTabs.find(isCapturableTab);
    if (fallback) return fallback;
  }

  return active;
}

async function sendRuntimeMessageWithTimeout(payload, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error("Background response timed out."));
    }, timeoutMs);

    try {
      chrome.runtime.sendMessage(payload, (resp) => {
        if (done) return;
        done = true;
        clearTimeout(timer);

        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || "Runtime message failed."));
          return;
        }

        resolve(resp);
      });
    } catch (error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function startCapture() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    setStatus("활성 탭을 찾지 못했습니다.", "error");
    return;
  }

  setStatus("캡처 시작 중...", "running");

  try {
    const resp = await sendRuntimeMessageWithTimeout({
      type: "START_CAPTURE",
      tabId: tab.id
    });

    if (resp?.ok) {
      setStatus("캡처가 시작되었습니다. 수집된 항목이 아래에 표시됩니다.", "success");
      await loadRows();
      return;
    }

    setStatus(`실패: ${resp?.error ?? "알 수 없는 오류"}`, "error");
  } catch (error) {
    setStatus(`실패: ${error?.message || String(error)}`, "error");
  }
}

async function stopCapture() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    setStatus("활성 탭을 찾지 못했습니다.", "error");
    return;
  }

  setStatus("캡처 중지 요청 중...", "running");

  try {
    const resp = await sendRuntimeMessageWithTimeout({
      type: "STOP_CAPTURE",
      tabId: tab.id
    });

    if (resp?.ok) {
      setStatus("캡처를 중지했습니다.", "success");
      await loadRows();
      return;
    }

    setStatus(`실패: ${resp?.error ?? "알 수 없는 오류"}`, "error");
  } catch (error) {
    setStatus(`실패: ${error?.message || String(error)}`, "error");
  }
}

function normalizeExportValue(value) {
  const text = String(value ?? "");
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnName(index) {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function createCrc32Table() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
}

const CRC32_TABLE = createCrc32Table();

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) {
    const index = (crc ^ bytes[i]) & 0xFF;
    crc = CRC32_TABLE[index] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function encodeUtf8(text) {
  return new TextEncoder().encode(String(text ?? ""));
}

function getDosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosDate =
    ((year - 1980) << 9)
    | ((date.getMonth() + 1) << 5)
    | date.getDate();
  const dosTime =
    (date.getHours() << 11)
    | (date.getMinutes() << 5)
    | Math.floor(date.getSeconds() / 2);
  return {
    dosDate: dosDate & 0xFFFF,
    dosTime: dosTime & 0xFFFF
  };
}

function writeUint16(view, offset, value) {
  view.setUint16(offset, value & 0xFFFF, true);
}

function writeUint32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  parts.forEach((part) => {
    out.set(part, offset);
    offset += part.length;
  });
  return out;
}

function buildStoredZip(entries) {
  const now = new Date();
  const { dosDate, dosTime } = getDosDateTime(now);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  entries.forEach((entry) => {
    const nameBytes = encodeUtf8(entry.name);
    const dataBytes = encodeUtf8(entry.content);
    const crc = crc32(dataBytes);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);

    writeUint32(localView, 0, 0x04034b50);
    writeUint16(localView, 4, 20);
    writeUint16(localView, 6, 0);
    writeUint16(localView, 8, 0);
    writeUint16(localView, 10, dosTime);
    writeUint16(localView, 12, dosDate);
    writeUint32(localView, 14, crc);
    writeUint32(localView, 18, dataBytes.length);
    writeUint32(localView, 22, dataBytes.length);
    writeUint16(localView, 26, nameBytes.length);
    writeUint16(localView, 28, 0);
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, dataBytes);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    writeUint32(centralView, 0, 0x02014b50);
    writeUint16(centralView, 4, 20);
    writeUint16(centralView, 6, 20);
    writeUint16(centralView, 8, 0);
    writeUint16(centralView, 10, 0);
    writeUint16(centralView, 12, dosTime);
    writeUint16(centralView, 14, dosDate);
    writeUint32(centralView, 16, crc);
    writeUint32(centralView, 20, dataBytes.length);
    writeUint32(centralView, 24, dataBytes.length);
    writeUint16(centralView, 28, nameBytes.length);
    writeUint16(centralView, 30, 0);
    writeUint16(centralView, 32, 0);
    writeUint16(centralView, 34, 0);
    writeUint16(centralView, 36, 0);
    writeUint32(centralView, 38, 0);
    writeUint32(centralView, 42, offset);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);

    offset += localHeader.length + dataBytes.length;
  });

  const centralDirectory = concatBytes(centralParts);
  const localSection = concatBytes(localParts);
  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  writeUint32(endView, 0, 0x06054b50);
  writeUint16(endView, 4, 0);
  writeUint16(endView, 6, 0);
  writeUint16(endView, 8, entries.length);
  writeUint16(endView, 10, entries.length);
  writeUint32(endView, 12, centralDirectory.length);
  writeUint32(endView, 16, localSection.length);
  writeUint16(endView, 20, 0);

  return concatBytes([localSection, centralDirectory, endRecord]);
}

function buildWorkbookXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="K-SCAN" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;
}

function buildWorkbookRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function buildRootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function buildContentTypesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/_rels/.rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;
}

function buildAppXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>K-SCAN</Application>
  <DocSecurity>0</DocSecurity>
  <ScaleCrop>false</ScaleCrop>
  <HeadingPairs>
    <vt:vector size="2" baseType="variant">
      <vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant>
      <vt:variant><vt:i4>1</vt:i4></vt:variant>
    </vt:vector>
  </HeadingPairs>
  <TitlesOfParts>
    <vt:vector size="1" baseType="lpstr">
      <vt:lpstr>K-SCAN</vt:lpstr>
    </vt:vector>
  </TitlesOfParts>
  <Company></Company>
  <LinksUpToDate>false</LinksUpToDate>
  <SharedDoc>false</SharedDoc>
  <HyperlinksChanged>false</HyperlinksChanged>
  <AppVersion>16.0000</AppVersion>
</Properties>`;
}

function buildCoreXml() {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>K-SCAN</dc:creator>
  <cp:lastModifiedBy>K-SCAN</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

function buildStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1">
    <font>
      <sz val="11"/>
      <color theme="1"/>
      <name val="Calibri"/>
      <family val="2"/>
    </font>
  </fonts>
  <fills count="1">
    <fill>
      <patternFill patternType="none"/>
    </fill>
  </fills>
  <borders count="1">
    <border>
      <left/><right/><top/><bottom/><diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1">
      <alignment vertical="top" wrapText="1"/>
    </xf>
  </cellXfs>
  <cellStyles count="1">
    <cellStyle name="Normal" xfId="0" builtinId="0"/>
  </cellStyles>
</styleSheet>`;
}

function buildSheetXml(rows) {
  const header = ["시간", "출원번호", "내용"];
  const sheetRows = [header, ...rows.map((row) => [row.time || "", row.applicationNo || "", row.citationText || ""])];

  const rowsXml = sheetRows.map((cells, rowIndex) => {
    const xmlCells = cells.map((value, colIndex) => {
      const ref = `${columnName(colIndex)}${rowIndex + 1}`;
      const text = escapeXml(normalizeExportValue(value));
      return `<c r="${ref}" t="inlineStr" s="0"><is><t xml:space="preserve">${text}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${xmlCells}</row>`;
  }).join("");

  const lastRow = sheetRows.length;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:C${lastRow}"/>
  <sheetViews>
    <sheetView workbookViewId="0"/>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <sheetData>${rowsXml}</sheetData>
  <pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>`;
}

async function exportRowsAsXlsx() {
  if (!currentRows.length) {
    setStatus("내보낼 항목이 없습니다.", "error");
    return;
  }

  const exportRows = currentRows.slice(0, MAX_CAPTURE_ROWS);
  const files = [
    { name: "[Content_Types].xml", content: buildContentTypesXml() },
    { name: "_rels/.rels", content: buildRootRelsXml() },
    { name: "docProps/app.xml", content: buildAppXml() },
    { name: "docProps/core.xml", content: buildCoreXml() },
    { name: "xl/workbook.xml", content: buildWorkbookXml() },
    { name: "xl/_rels/workbook.xml.rels", content: buildWorkbookRelsXml() },
    { name: "xl/styles.xml", content: buildStylesXml() },
    { name: "xl/worksheets/sheet1.xml", content: buildSheetXml(exportRows) }
  ];

  const zipBytes = buildStoredZip(files);
  const blob = new Blob([zipBytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });

  const fileName = `k-scan-captured-pairs_${formatTimestampForFile()}.xlsx`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noreferrer noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(`엑셀로 저장했습니다. (${exportRows.length.toLocaleString("ko-KR")}건)`, "success");
}

async function clearRows() {
  if (!currentRows.length) {
    setStatus("이미 비어 있습니다.", "idle");
    return;
  }

  const confirmed = window.confirm("캡처된 청구항 목록을 모두 삭제할까요?");
  if (!confirmed) return;

  await chrome.storage.local.set({ [HISTORY_KEY]: [] });
  currentRows = [];
  renderCaptureList(currentRows);
  setStatus("캡처 목록을 삭제했습니다.", "success");
}

async function refreshRows() {
  await loadRows();
  setStatus("목록을 새로고침했습니다.", "success");
}

document.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.key !== "Enter") return;
  event.preventDefault();
  startBtn?.click();
});

startBtn?.addEventListener("click", async () => {
  await startCapture();
});

stopBtn?.addEventListener("click", async () => {
  await stopCapture();
});

refreshBtn?.addEventListener("click", async () => {
  try {
    await refreshRows();
  } catch (error) {
    setStatus(`새로고침 실패: ${error?.message || String(error)}`, "error");
  }
});

exportBtn?.addEventListener("click", async () => {
  try {
    await exportRowsAsXlsx();
  } catch (error) {
    setStatus(`엑셀 저장 실패: ${error?.message || String(error)}`, "error");
  }
});

clearBtn?.addEventListener("click", async () => {
  try {
    await clearRows();
  } catch (error) {
    setStatus(`삭제 실패: ${error?.message || String(error)}`, "error");
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!changes[HISTORY_KEY]) return;
  void loadRows();
});

loadRows().then(() => {
  if (!currentRows.length) {
    setStatus("대기 중. KOMPASS 탭에서 캡처를 시작하세요.", "idle");
    return;
  }
  setStatus("캡처된 항목을 불러왔습니다.", "success");
}).catch((error) => {
  setStatus(`초기화 실패: ${error?.message || String(error)}`, "error");
});
