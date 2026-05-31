function renderResultClaimStepIndicator(claimId, data, progress) {
  const card = document.getElementById('result-claim-progress-card');
  const text = document.getElementById('result-claim-progress-text');
  const indicator = document.getElementById('result-claim-step-indicator');
  if (!card || !text || !indicator) return;

  const isCompleted = (progress?.status === 'done') || (!progress && data && !data.error);
  if (isCompleted) {
    indicator.innerHTML = '';
    text.textContent = '';
    card.classList.add('hidden');
    return;
  }


  // Keep step details in the empty-state area and hide top text.
  text.textContent = '';
  text.classList.add('hidden');
  indicator.innerHTML = '';

  const stepLabels = {
    A: 'A\uB2E8\uACC4: \uAD6C\uC131\uC694\uC18C',
    B: 'B\uB2E8\uACC4: \uBA40\uD2F0\uCFFC\uB9AC RAG',
    C: 'C\uB2E8\uACC4: \uBA40\uD2F0\uD310\uC815',
    D: 'D\uB2E8\uACC4: \uB9AC\uD398\uC5B4',
    E: 'E\uB2E8\uACC4: \uAC80\uC99D'
  };

  ANALYSIS_STEPS.forEach(stepId => {
    let stepState = progress?.steps?.[stepId] || 'pending';
    if (data?.error && stepState === 'pending' && progress?.currentStep === stepId) {
      stepState = 'error';
    }

    const item = document.createElement('div');
    item.className = `step-item ${stepState}`;
    item.dataset.step = stepId;

    const dot = document.createElement('span');
    dot.className = 'step-dot';
    dot.textContent = stepId;

    const label = document.createElement('span');
    label.className = 'step-label';
    label.textContent = stepLabels[stepId] || `${stepId}\uB2E8\uACC4`;

    item.appendChild(dot);
    item.appendChild(label);
    indicator.appendChild(item);
  });

  card.classList.remove('hidden');
}

function shouldRenderCompletedResult(data, progress) {
  if (!data || data.error) return false;
  if (!progress) return true;
  return progress.status === 'done';
}

function hasRelevantRows(relevant) {
  return Object.values(relevant || {}).some(items => Array.isArray(items) && items.length > 0);
}

function ensureMockRelevantRows(data) {
  const current = data?.Relevant || {};
  if (!settings?.mockMode) return current;
  if (hasRelevantRows(current)) return current;

  const features = Array.isArray(data?.ClaimFeatures) ? data.ClaimFeatures : [];
  if (features.length === 0) return current;

  const generated = mergeRelevantWithPositions({}, buildMockRelevant(features, 'UI'));
  data.Relevant = generated;
  return generated;
}

function getFeatureOrderValue(featureId) {
  const matched = String(featureId || '').match(/\d+/);
  if (!matched) return Number.MAX_SAFE_INTEGER;
  return Number.parseInt(matched[0], 10);
}

function normalizeFeatureToken(featureId) {
  return String(featureId || '').trim().toUpperCase().replace(/\s+/g, '');
}

function extractFeatureNumber(featureId) {
  const matched = String(featureId || '').match(/\d+/);
  if (!matched) return null;
  const parsed = Number.parseInt(matched[0], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveFeatureIndexForRow(featureId, claimFeatures) {
  const normalizedFeature = normalizeFeatureToken(featureId);
  if (!normalizedFeature) return -1;

  const exactIndex = (claimFeatures || []).findIndex((feature) =>
    normalizeFeatureToken(feature?.Id) === normalizedFeature
  );
  if (exactIndex !== -1) return exactIndex;

  const featureNumber = extractFeatureNumber(featureId);
  if (!Number.isFinite(featureNumber)) return -1;
  return (claimFeatures || []).findIndex((feature) =>
    extractFeatureNumber(feature?.Id) === featureNumber
  );
}

function hashTextToIndex(text, modulo) {
  if (!text || !Number.isFinite(modulo) || modulo <= 0) return 0;
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % modulo;
}

function resolveResultRowColor(featureId, claimFeatures, pastelColors) {
  if (!Array.isArray(pastelColors) || pastelColors.length === 0) return '#ffffff';
  const resolvedIndex = resolveFeatureIndexForRow(featureId, claimFeatures);
  if (resolvedIndex >= 0) {
    return pastelColors[resolvedIndex % pastelColors.length];
  }
  const normalizedFeature = normalizeFeatureToken(featureId);
  if (!normalizedFeature) return '#ffffff';
  return pastelColors[hashTextToIndex(normalizedFeature, pastelColors.length)];
}

function sortClaimFeaturesForSummary(claimFeatures) {
  return [...(claimFeatures || [])].sort((a, b) => {
    const aOrder = getFeatureOrderValue(a?.Id);
    const bOrder = getFeatureOrderValue(b?.Id);
    if (aOrder !== bOrder) return aOrder - bOrder;
    return String(a?.Id || '').localeCompare(String(b?.Id || ''), 'ko');
  });
}

function getDocLabelOrderValue(docLabel) {
  const matched = String(docLabel || '').match(/^D(\d+)$/i);
  if (!matched) return Number.MAX_SAFE_INTEGER;
  return Number.parseInt(matched[1], 10);
}

function getSummaryDocLabel(docName, fallbackIndex) {
  const raw = String(docName || '').trim();
  if (!raw) return `D${fallbackIndex + 1}`;

  const dMatch = raw.match(/^D\s*0*(\d+)$/i);
  if (dMatch) return `D${Number.parseInt(dMatch[1], 10)}`;

  const numMatch = raw.match(/(\d+)/);
  if (numMatch) return `D${Number.parseInt(numMatch[1], 10)}`;

  return `D${fallbackIndex + 1}`;
}

function sortDocNamesForSummary(docNames) {
  const mapped = (docNames || []).map((docName, index) => ({
    docName,
    fallbackIndex: index,
    label: getSummaryDocLabel(docName, index)
  }));

  mapped.sort((a, b) => {
    const aOrder = getDocLabelOrderValue(a.label);
    const bOrder = getDocLabelOrderValue(b.label);
    if (aOrder !== bOrder) return aOrder - bOrder;
    return String(a.docName || '').localeCompare(String(b.docName || ''), 'ko');
  });

  return mapped;
}

function getFeatureDocSummaryStatus(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { label: '-', className: 'is-none' };
  }

  const hasExplicit = entries.some(entry =>
    getMatchTypePresentation(entry?.MatchType).matchClass === 'match-explicit'
  );
  if (hasExplicit) {
    return { label: MATCH_LABEL_EXPLICIT, className: 'is-explicit' };
  }

  const hasEquivalent = entries.some(entry =>
    getMatchTypePresentation(entry?.MatchType).matchClass === 'match-equivalent'
  );
  if (hasEquivalent) {
    return { label: MATCH_LABEL_EQUIVALENT, className: 'is-equivalent' };
  }

  return { label: '-', className: 'is-none' };
}

function renderClaimFeatureSummaryMatrix(featureListEl, claimFeatures, relevantData) {
  if (!featureListEl) return;
  featureListEl.innerHTML = '';

  const rowPastelColors = ['#f0f9ff', '#f0fdf4', '#fefce8', '#fff7ed', '#fdf2f8', '#faf5ff', '#f5f5f4'];
  const sortedFeatures = sortClaimFeaturesForSummary(claimFeatures);
  if (sortedFeatures.length === 0) return;

  let docNames = Object.keys(relevantData || {}).filter(key => Array.isArray(relevantData?.[key]));
  if (docNames.length === 0) {
    const fallbackDocs = (citations || [])
      .filter(citation => citation?.status === 'completed')
      .map((citation, index) => String(citation?.name || citation?.title || `D${index + 1}`).trim())
      .filter(Boolean);
    docNames = fallbackDocs;
  }
  if (docNames.length === 0) {
    docNames = ['D1'];
  }

  const sortedDocs = sortDocNamesForSummary(docNames);

  const table = document.createElement('table');
  table.className = 'feature-summary-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');

  const thFeatureId = document.createElement('th');
  thFeatureId.textContent = '구성';
  headRow.appendChild(thFeatureId);

  const thFeatureSummary = document.createElement('th');
  thFeatureSummary.textContent = '\uAD6C\uC131\uC694\uC18C \uC694\uC57D';
  headRow.appendChild(thFeatureSummary);

  sortedDocs.forEach(docMeta => {
    const th = document.createElement('th');
    th.textContent = docMeta.label;
    const rawDocName = String(docMeta.docName || '').trim();
    if (rawDocName && rawDocName !== docMeta.label) {
      th.title = rawDocName;
    }
    headRow.appendChild(th);
  });

  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  sortedFeatures.forEach((feature, index) => {
    const tr = document.createElement('tr');
    const rowColor = rowPastelColors[index % rowPastelColors.length];
    tr.style.setProperty('--feature-summary-row-bg', rowColor);

    const tdId = document.createElement('td');
    tdId.textContent = feature?.Id || '-';
    tr.appendChild(tdId);

    const tdDesc = document.createElement('td');
    tdDesc.textContent = feature?.Description || '-';
    tr.appendChild(tdDesc);

    sortedDocs.forEach(docMeta => {
      const td = document.createElement('td');
      const entries = getNoticeEntriesForFeature(relevantData, docMeta.docName, feature?.Id);
      const status = getFeatureDocSummaryStatus(entries);
      td.className = `feature-summary-status ${status.className}`;
      td.textContent = status.label;
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  featureListEl.appendChild(table);
}

function renderResultTable(claimId) {
  const summaryBox = document.getElementById('claim-summary-box');
  const featureList = document.getElementById('claim-features-list');
  const summaryTitle = summaryBox?.querySelector('h4');
  const table = document.getElementById('analysis-table');
  const tbody = document.getElementById('result-tbody');
  const emptyState = document.querySelector('.result-panel .empty-state');
  if (summaryTitle) {
    summaryTitle.textContent = '\uAD6C\uC131\uC694\uC18C-\uC778\uC6A9\uBC1C\uBA85 \uC694\uC57D \uD45C';
  }

  selectedResultClaimId = Number.parseInt(claimId, 10);
  refreshOpinionNoticeCard({ preferredClaimId: selectedResultClaimId });

  tbody.innerHTML = '';
  featureList.innerHTML = '';

  const data = analysisResults[claimId];
  const progress = getClaimProgress(claimId);
  renderResultClaimStepIndicator(claimId, data, progress);

  if (!data || data.error || !shouldRenderCompletedResult(data, progress)) {
    summaryBox.classList.add('hidden');
    table.classList.add('hidden');
    emptyState.style.display = 'block';

    if (data?.error) {
      emptyState.innerHTML = `\uC774 \uCCAD\uAD6C\uD56D \uBD84\uC11D \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4.<br>${data.error}`;
      if (typeof renderDecisionWorkspace === 'function') {
        renderDecisionWorkspace(claimId);
      }
      return;
    }

    const currentStep = progress?.currentStep ? `${progress.currentStep}\uB2E8\uACC4` : '\uB300\uAE30 \uC911';
    const message = (progress?.stepMessage || '').trim() || '\uC774 \uCCAD\uAD6C\uD56D\uC740 \uB300\uAE30 \uC911\uC774\uAC70\uB098 \uBD84\uC11D\uC774 \uC9C4\uD589 \uC911\uC785\uB2C8\uB2E4.';
    emptyState.innerHTML = `${currentStep}<br>${message}`;
    if (typeof renderDecisionWorkspace === 'function') {
      renderDecisionWorkspace(claimId);
    }
    return;
  }

  emptyState.style.display = 'none';

  const rawRelevantData = ensureMockRelevantRows(data);
  if (typeof recomputeClaimWorkspace === 'function') {
    recomputeClaimWorkspace(claimId, { persist: false });
  }
  let relevantData = typeof getEffectiveRelevantForClaim === 'function'
    ? getEffectiveRelevantForClaim(claimId)
    : rawRelevantData;
  if (!hasRelevantRows(relevantData)) {
    relevantData = rawRelevantData;
  }
  const claimFeatures = data.ClaimFeatures || [];
  const pastelColors = ['#f0f9ff', '#f0fdf4', '#fefce8', '#fff7ed', '#fdf2f8', '#faf5ff', '#f5f5f4'];

  if (claimFeatures.length > 0) {
    summaryBox.classList.remove('hidden');
    renderClaimFeatureSummaryMatrix(featureList, claimFeatures, relevantData);
  } else {
    featureList.innerHTML = '';
    summaryBox.classList.add('hidden');
  }

  table.classList.remove('hidden');
  let hasRow = false;

  if (currentSortOrder === 'doc_then_feature') {
    Object.entries(relevantData).forEach(([docName, items]) => {
      if (!Array.isArray(items) || items.length === 0) return;

      items.sort((a, b) => {
        const aNum = Number((a.Feature || '').match(/\d+/)?.[0] || 0);
        const bNum = Number((b.Feature || '').match(/\d+/)?.[0] || 0);
        return aNum - bNum;
      });

      items.forEach(item => {
        hasRow = true;
        const tr = createTableRow(item, docName, claimId, claimFeatures, pastelColors, data.verifications || {});
        tbody.appendChild(tr);
      });
    });
  } else {
    const featuresMap = new Map();
    Object.entries(relevantData).forEach(([docName, items]) => {
      (items || []).forEach(item => {
        if (!featuresMap.has(item.Feature)) {
          featuresMap.set(item.Feature, []);
        }
        featuresMap.get(item.Feature).push({ ...item, docName });
      });
    });

    const sortedFeatures = [...featuresMap.keys()].sort((a, b) => {
      const aNum = Number((a || '').match(/\d+/)?.[0] || 0);
      const bNum = Number((b || '').match(/\d+/)?.[0] || 0);
      return aNum - bNum;
    });

    sortedFeatures.forEach(featureId => {
      const items = featuresMap.get(featureId);
      items.forEach(item => {
        hasRow = true;
        const tr = createTableRow(item, item.docName, claimId, claimFeatures, pastelColors, data.verifications || {});
        tbody.appendChild(tr);
      });
    });
  }

  if (!hasRow) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 20px;">\uB9E4\uCE6D\uB41C \uADFC\uAC70\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.</td></tr>';
  }

  if (typeof renderDecisionWorkspace === 'function') {
    renderDecisionWorkspace(claimId);
  }
}

function normalizeVerificationFlag(value) {
  const text = String(value || '').trim().toUpperCase();
  if (!text) return null;
  if (text === 'P' || text === 'PASS') return 'P';
  if (text === 'F' || text === 'FAIL') return 'F';
  return null;
}

function escapeHtmlText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildPositionCellHtml(position, docName, relatedContent = '') {
  const displayPosition = typeof transformPositionTextForDisplay === 'function'
    ? transformPositionTextForDisplay(position || '', docName, { includeMeta: false })
    : (position || '');
  const positionInfo = typeof extractPositionMarkerTokens === 'function'
    ? extractPositionMarkerTokens(displayPosition || '')
    : { normalized: normalizePositionText(displayPosition || ''), markers: [] };
  const normalized = positionInfo.normalized;
  if (!normalized) return '-';

  const markers = Array.isArray(positionInfo.markers) ? positionInfo.markers : [];
  if (markers.length === 0) {
    return escapeHtmlText(normalized);
  }

  let html = '';
  let lastIndex = 0;

  markers.forEach((token) => {
    html += escapeHtmlText(normalized.slice(lastIndex, token.start));
    const marker = token.marker;
    html += `<button type="button" class="position-token" data-doc-name="${escapeHtmlText(docName)}" data-paragraph-key="${escapeHtmlText(marker)}" data-related-content="${escapeHtmlText(relatedContent)}" title="${escapeHtmlText(marker)} \uC6D0\uBB38 \uBCF4\uAE30">${escapeHtmlText(marker)}</button>`;
    lastIndex = token.end;
  });

  html += escapeHtmlText(normalized.slice(lastIndex));
  return html;
}

const MATCH_LABEL_EXPLICIT = '\uB3D9\uC77C';
const MATCH_LABEL_EQUIVALENT = '\uC2E4\uC9C8\uC801 \uB3D9\uC77C';
const MATCH_LABEL_DIFFERENT = '\uCC28\uC774';

function getMatchTypePresentation(rawType) {
  const text = String(rawType || '').trim();
  const normalized = text.toLowerCase();
  const normalizedCompact = normalized.replace(/\s+/g, '');

  if (
    normalized === 'explicit'
    || normalized === 'identical'
    || text === MATCH_LABEL_EXPLICIT
  ) {
    return { matchClass: 'match-explicit', label: MATCH_LABEL_EXPLICIT };
  }
  if (
    normalized === 'equivalent'
    || normalized === 'substantially equivalent'
    || text === MATCH_LABEL_EQUIVALENT
    || normalizedCompact === '\uc2e4\uc9c8\uc801\ub3d9\uc77c'
  ) {
    return { matchClass: 'match-equivalent', label: MATCH_LABEL_EQUIVALENT };
  }

  return { matchClass: 'match-none', label: text || '-' };
}

function createTableRow(item, docName, claimId, claimFeatures, pastelColors, verifications) {
  const tr = document.createElement('tr');
  const bgColor = resolveResultRowColor(item?.Feature, claimFeatures, pastelColors);
  tr.style.setProperty('--result-row-bg', bgColor);
  tr.style.backgroundColor = bgColor;

  const match = getMatchTypePresentation(item.MatchType);
  const matchClass = match.matchClass;

  const evidenceId = typeof normalizeEvidenceId === 'function'
    ? normalizeEvidenceId(item?.EvidenceId || item?.evidenceId)
    : String(item?.EvidenceId || item?.evidenceId || '').trim();
  const verificationKey = `${item.Feature}_${docName}`;
  const verificationResult = (evidenceId && verifications?.[evidenceId])
    ? verifications[evidenceId]
    : verifications[verificationKey];
  let verificationCellHtml = '';
  if (verificationResult && typeof verificationResult === 'object') {
    const icon = verificationResult.status === 'warning' ? '!' : '?';
    const encodedReason = String(verificationResult.reason || '').replace(/"/g, '&quot;');
    verificationCellHtml = `
      <div class="verification-cell">
        <span class="verification-icon" data-status="${verificationResult.status}" data-reason="${encodedReason}">
          ${icon}
        </span>
      </div>
    `;
  } else {
    const verificationFlag = normalizeVerificationFlag(verificationResult)
      || normalizeVerificationFlag(item?.Verification || item?.verification || item?.Verify || item?.verify);
    if (verificationFlag === 'P') {
      verificationCellHtml = `
        <div class="verification-cell">
          <span class="verification-flag is-p">P</span>
        </div>
      `;
    } else if (verificationFlag === 'F') {
      const encodedReason = '\uCC3E\uC740 \uB0B4\uC6A9\uC740 \uC6D0\uBB38 \uBB38\uB2E8\uC744 \uB2E4\uC2DC \uBCF4\uACE0 \uAC80\uC99D\uD574\uBCF4\uC138\uC694.';
      verificationCellHtml = `
        <div class="verification-cell">
          <span class="verification-flag is-f" data-reason="${encodedReason}">F</span>
        </div>
      `;
    }
  }

  tr.innerHTML = `
    <td class="font-bold">${item.Feature || '-'}</td>
    <td><strong>${docName}</strong></td>
    <td>${item.Content || ''}</td>
    <td class="text-sm text-sub">${buildPositionCellHtml(item.Position || '', docName, item.Content || '')}</td>
    <td><span class="match-badge ${matchClass}">${match.label}</span></td>
    <td>${verificationCellHtml}</td>
  `;
  tr.querySelectorAll('td').forEach((cell) => {
    cell.style.backgroundColor = bgColor;
  });
  return tr;
}

function getClaimTypeByClaimId(claimId) {
  const claim = (claims || []).find((item) => String(item?.id) === String(claimId));
  return String(claim?.type || '').trim().toLowerCase() === 'dependent'
    ? 'dependent'
    : 'independent';
}

function getNoticeClaimType(claimId) {
  const parsedClaimId = Number.parseInt(claimId, 10);
  if (Number.isFinite(parsedClaimId)) {
    return getClaimTypeByClaimId(parsedClaimId);
  }
  const selectedClaimId = Number.parseInt(
    document.getElementById('notice-claim-select')?.value
      || selectedResultClaimId
      || '',
    10
  );
  return getClaimTypeByClaimId(selectedClaimId);
}

function getAnalyzedClaimsForNotice() {
  return (claims || []).filter(claim => {
    const result = analysisResults?.[claim.id];
    return !!result && !result.error && Array.isArray(result.ClaimFeatures) && result.ClaimFeatures.length > 0;
  });
}

function syncNoticeClaimSelect(preferredClaimId) {
  const select = document.getElementById('notice-claim-select');
  if (!select) return null;

  const analyzedClaims = getAnalyzedClaimsForNotice();
  const previousValue = select.value;
  const preferred = preferredClaimId !== null && preferredClaimId !== undefined
    ? String(preferredClaimId)
    : previousValue;

  select.innerHTML = '';
  if (analyzedClaims.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '(\uACB0\uACFC \uC5C6\uC74C)';
    select.appendChild(option);
    select.disabled = true;
    return null;
  }

  analyzedClaims.forEach(claim => {
    const option = document.createElement('option');
    option.value = String(claim.id);
    option.textContent = claim.name || `Claim ${claim.id}`;
    select.appendChild(option);
  });

  select.disabled = false;
  const hasPreferred = analyzedClaims.some(claim => String(claim.id) === String(preferred));
  select.value = hasPreferred ? String(preferred) : String(analyzedClaims[0].id);
  return Number.parseInt(select.value, 10);
}

function getNoticeCitationRefNumber(docLabel, fallbackIndex) {
  const matched = String(docLabel || '').trim().match(/^D(\d+)$/i);
  if (matched) {
    const number = Number.parseInt(matched[1], 10);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return fallbackIndex + 1;
}

function getNoticeCandidateDocNames(relevant) {
  const fromRelevant = Object.keys(relevant || {}).filter(key => Array.isArray(relevant?.[key]));
  const fromCitations = (citations || [])
    .filter(citation => citation?.status === 'completed')
    .map(citation => String(citation?.name || '').trim())
    .filter(Boolean);
  const merged = [...new Set([...fromRelevant, ...fromCitations])];
  return merged;
}

function buildNoticeCitationMetaList(relevant) {
  const docNames = getNoticeCandidateDocNames(relevant);
  const sortedDocs = sortDocNamesForSummary(docNames);
  return sortedDocs
    .map((docMeta, index) => {
      const rawDocName = String(docMeta?.docName || '').trim();
      if (!rawDocName) return null;

      const citation = typeof resolveCitationByDocName === 'function'
        ? resolveCitationByDocName(rawDocName)
        : null;
      const citationTitle = String(citation?.title || '').trim();
      const citationName = String(citation?.name || '').trim();
      const docLabel = String(docMeta?.label || rawDocName).trim() || rawDocName;
      const refNumber = getNoticeCitationRefNumber(docLabel, index);
      const documentName = citationTitle || citationName || rawDocName;

      return {
        docName: rawDocName,
        docLabel,
        refNumber,
        documentName
      };
    })
    .filter(Boolean);
}

function buildNoticeCitationMetaMap(relevant) {
  const map = new Map();
  buildNoticeCitationMetaList(relevant).forEach((meta) => {
    const docName = String(meta?.docName || '').trim();
    if (!docName) return;
    map.set(docName, meta);
  });
  return map;
}

function buildNoticeUsedCitationMetaList(primaryDocName, supportDocNames, relevant) {
  const primary = String(primaryDocName || '').trim();
  if (!primary) return [];

  const orderedDocNames = [primary];
  (Array.isArray(supportDocNames) ? supportDocNames : []).forEach((docName) => {
    const safeDocName = String(docName || '').trim();
    if (!safeDocName || orderedDocNames.includes(safeDocName)) return;
    orderedDocNames.push(safeDocName);
  });

  const metaMap = buildNoticeCitationMetaMap(relevant);
  return orderedDocNames.map((docName, index) => {
    const fallbackCitation = typeof resolveCitationByDocName === 'function'
      ? resolveCitationByDocName(docName)
      : null;
    const base = metaMap.get(docName) || {
      docName,
      docLabel: docName,
      documentName: String(fallbackCitation?.title || fallbackCitation?.name || docName).trim() || docName
    };
    return {
      ...base,
      refNumber: index + 1
    };
  });
}

function getNoticeDocMatchScore(relevant, docName, claimFeatures) {
  const matched = new Set();
  const hasEntries = new Set();

  (claimFeatures || []).forEach((feature) => {
    const featureId = String(feature?.Id || '').trim();
    if (!featureId) return;

    const entries = getNoticeEntriesForFeature(relevant, docName, featureId);
    if (entries.length > 0) {
      hasEntries.add(featureId);
    }

    const remark = getNoticeRemark(entries);
    if (remark === MATCH_LABEL_EXPLICIT || remark === MATCH_LABEL_EQUIVALENT) {
      matched.add(featureId);
    }
  });

  return {
    matchedCount: matched.size,
    coveredCount: hasEntries.size
  };
}

function findNoticePrimaryDocName(relevant, claimFeatures, docMetas = []) {
  const candidates = Array.isArray(docMetas) && docMetas.length > 0
    ? docMetas
    : buildNoticeCitationMetaList(relevant);
  if (candidates.length === 0) return null;

  const ranked = candidates.map((meta, index) => {
    const score = getNoticeDocMatchScore(relevant, meta.docName, claimFeatures);
    return {
      ...meta,
      ...score,
      __index: index
    };
  });

  ranked.sort((a, b) => {
    if (b.matchedCount !== a.matchedCount) return b.matchedCount - a.matchedCount;
    if (b.coveredCount !== a.coveredCount) return b.coveredCount - a.coveredCount;

    const aOrder = getDocLabelOrderValue(a.docLabel);
    const bOrder = getDocLabelOrderValue(b.docLabel);
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.__index - b.__index;
  });

  return ranked[0]?.docName || candidates[0]?.docName || null;
}

function syncNoticeCitationSelect(docMetas, preferredDocName) {
  const select = document.getElementById('notice-citation-select');
  if (!select) return null;

  const previousValue = String(select.value || '').trim();
  const preferred = String(preferredDocName ?? previousValue).trim();
  select.innerHTML = '';

  if (!Array.isArray(docMetas) || docMetas.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '(인용발명 없음)';
    select.appendChild(option);
    select.disabled = true;
    return null;
  }

  docMetas.forEach((meta) => {
    const option = document.createElement('option');
    option.value = meta.docName;
    option.textContent = `인용발명 ${meta.refNumber} : ${meta.documentName}`;
    option.title = `${meta.docLabel} / ${meta.documentName}`;
    select.appendChild(option);
  });

  select.disabled = false;
  const hasPreferred = docMetas.some(meta => meta.docName === preferred);
  select.value = hasPreferred ? preferred : docMetas[0].docName;
  return select.value;
}

function renderNoticeCitationMap(citationMapEl, docMetas) {
  if (!citationMapEl) return;
  if (!Array.isArray(docMetas) || docMetas.length === 0) {
    citationMapEl.innerHTML = '';
    citationMapEl.classList.add('hidden');
    return;
  }

  citationMapEl.innerHTML = docMetas.map(meta => {
    const name = escapeHtmlText(meta.documentName || meta.docName || '-');
    const label = escapeHtmlText(meta.docLabel || '');
    const labelSuffix = label ? ` <span class="citation-map-label">(${label})</span>` : '';
    return `<div class="citation-map-line">인용발명 ${meta.refNumber} : <strong>${name}</strong>${labelSuffix}</div>`;
  }).join('');
  citationMapEl.classList.remove('hidden');
}

function getNoticeEntriesForFeature(relevant, docName, featureId) {
  if (!docName || !relevant) return [];
  const items = Array.isArray(relevant[docName]) ? relevant[docName] : [];
  const targetFeature = String(featureId || '').trim();
  return items.filter(item => String(item?.Feature || '').trim() === targetFeature);
}

function getNoticeRemark(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return MATCH_LABEL_DIFFERENT;

  const hasExplicit = entries.some(entry => getMatchTypePresentation(entry?.MatchType).matchClass === 'match-explicit');
  if (hasExplicit) return MATCH_LABEL_EXPLICIT;

  const hasEquivalent = entries.some(entry => getMatchTypePresentation(entry?.MatchType).matchClass === 'match-equivalent');
  if (hasEquivalent) return MATCH_LABEL_EQUIVALENT;

  return MATCH_LABEL_DIFFERENT;
}

function getNoticeRemarkClass(remark) {
  if (remark === MATCH_LABEL_EXPLICIT) return 'is-explicit';
  if (remark === MATCH_LABEL_EQUIVALENT) return 'is-equivalent';
  return 'is-diff';
}

function formatNoticeEvidence(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '-';

  return entries.map(entry => {
    const content = escapeHtmlText(entry?.Content || '-');
    const docName = String(entry?.__docName || '').trim();
    const position = typeof transformPositionTextForDisplay === 'function'
      ? (transformPositionTextForDisplay(entry?.Position || '', docName, { includeMeta: true, metaOnly: true }) || '-')
      : (normalizePositionText(entry?.Position || '') || '-');
    return `${content} (${escapeHtmlText(position)})`;
  }).join('<br>');
}

function formatNoticeReasoningPositionToken(rawToken) {
  const token = String(rawToken || '').trim();
  if (!token) return '[위치 미상]';

  if (typeof parseClaimPositionToken === 'function') {
    const claimRange = parseClaimPositionToken(token);
    if (claimRange) {
      if (claimRange.start === claimRange.end) return `[청구항 ${claimRange.start}]`;
      return `[청구항 ${claimRange.start}-${claimRange.end}]`;
    }
  }

  if (typeof parseNumericPositionToken === 'function') {
    const numericRange = parseNumericPositionToken(token);
    if (numericRange) {
      const from = String(numericRange.start).padStart(4, '0');
      const to = String(numericRange.end).padStart(4, '0');
      if (numericRange.start === numericRange.end) return `[문단 ${from}]`;
      return `[문단 ${from}-${to}]`;
    }
  }

  const paragraphMatch = token.match(/\[(\d{1,6})\]/);
  if (paragraphMatch) {
    return `[문단 ${String(paragraphMatch[1]).padStart(4, '0')}]`;
  }

  const claimMatch = token.match(/청구항\s*(\d{1,6})(?:\s*[-~]\s*(\d{1,6}))?/i);
  if (claimMatch) {
    const from = Number.parseInt(claimMatch[1], 10);
    const to = Number.parseInt(claimMatch[2] || claimMatch[1], 10);
    if (Number.isFinite(from) && Number.isFinite(to)) {
      if (from === to) return `[청구항 ${from}]`;
      return `[청구항 ${Math.min(from, to)}-${Math.max(from, to)}]`;
    }
  }

  return `[${token.replace(/^\[|\]$/g, '')}]`;
}

function getNoticeReasoningPositionMarker(entry, docName) {
  const rawPosition = String(entry?.Position || '').trim();
  const displayPosition = typeof transformPositionTextForDisplay === 'function'
    ? (transformPositionTextForDisplay(rawPosition, docName, { includeMeta: false }) || '')
    : (normalizePositionText(rawPosition) || '');
  const splitter = typeof splitPositions === 'function'
    ? splitPositions(displayPosition)
    : String(displayPosition || '').split(/\s*(?:\||;|,)\s*/g).filter(Boolean);
  const token = splitter[0] || displayPosition || rawPosition;
  return formatNoticeReasoningPositionToken(token);
}

function getNoticeDiffEvidenceText(entry, docName) {
  const content = String(entry?.Content || '').trim() || '구성에 해당하는 내용';
  const position = getNoticeReasoningPositionMarker(entry, docName);
  return `${content} ${position}`;
}

function renderNoticeDiffNotes(diffNotesEl, rows, selectedDocMeta) {
  if (!diffNotesEl) return;

  const selectedRefNumber = Number.isFinite(Number(selectedDocMeta?.refNumber))
    ? Number(selectedDocMeta.refNumber)
    : 1;
  const diffRows = (rows || []).filter(row => row.remark === MATCH_LABEL_DIFFERENT);

  if (diffRows.length === 0) {
    diffNotesEl.innerHTML = '';
    diffNotesEl.classList.add('hidden');
    return;
  }

  diffNotesEl.innerHTML = diffRows.map((row) => {
    const supportEntries = Array.isArray(row.supportEntries) ? row.supportEntries : [];
    const leadEntry = supportEntries[0]
      || (Array.isArray(row.entries) && row.entries.length > 0 ? row.entries[0] : null);
    const referenceNumber = Number.isFinite(Number(row.supportRefNumber))
      ? Number(row.supportRefNumber)
      : selectedRefNumber;
    const sourceDocName = String(row.supportDocName || selectedDocMeta?.docName || '').trim();
    const sourceText = leadEntry
      ? getNoticeDiffEvidenceText(leadEntry, sourceDocName)
      : '구성에 해당하는 내용 [위치 미상]';
    return `<p>구성 ${row.index}의 차이점은 인용발명 ${referenceNumber}의 '${escapeHtmlText(sourceText)}'으로부터 용이하게 도출할 수 있는 것입니다.</p>`;
  }).join('');

  diffNotesEl.classList.remove('hidden');
}

function refreshOpinionNoticeCard(options = {}) {
  if (typeof ensureOpinionNoticeWorkspaceLayout === 'function') {
    ensureOpinionNoticeWorkspaceLayout();
  }

  const emptyState = document.getElementById('opinion-notice-empty');
  const table = document.getElementById('opinion-notice-table');
  const tbody = document.getElementById('opinion-notice-tbody');
  const claimSelect = document.getElementById('notice-claim-select');
  const citationMapEl = document.getElementById('opinion-notice-citation-map');
  const diffNotesEl = document.getElementById('opinion-notice-diff-notes');
  if (!emptyState || !table || !tbody || !claimSelect) return;

  const markNoticeDataVisibility = (hasData) => {
    [table, citationMapEl, diffNotesEl].forEach((el) => {
      if (!el) return;
      el.classList.toggle('hidden-by-data', !hasData);
      if (!hasData) {
        el.classList.add('hidden');
      }
    });
  };

  const clearNoticeSupplementaryBlocks = () => {
    renderNoticeCitationMap(citationMapEl, []);
    renderNoticeDiffNotes(diffNotesEl, [], null);
  };

  const colgroup = table.querySelector('colgroup');
  if (colgroup) {
    colgroup.innerHTML = [
      '<col style="width: 8%">',
      '<col style="width: 34%">',
      '<col style="width: 42%">',
      '<col style="width: 16%">'
    ].join('');
  }
  const theadRow = table.querySelector('thead tr');
  if (theadRow) {
    theadRow.innerHTML = [
      '<th>번호</th>',
      '<th>구성</th>',
      '<th id="opinion-notice-ref-header">인용발명 1</th>',
      '<th>비고</th>'
    ].join('');
  }

  const shouldSyncClaimSelect = options.syncClaimSelect !== false;
  const selectedClaimId = shouldSyncClaimSelect
    ? syncNoticeClaimSelect(options.preferredClaimId)
    : Number.parseInt(claimSelect.value || '', 10);
  const analyzedClaims = getAnalyzedClaimsForNotice();

  if (analyzedClaims.length === 0 || !Number.isFinite(selectedClaimId)) {
    markNoticeDataVisibility(false);
    table.classList.add('hidden');
    emptyState.classList.remove('hidden');
    emptyState.textContent = '분석 결과가 없습니다.';
    tbody.innerHTML = '';
    syncNoticeCitationSelect([], null);
    clearNoticeSupplementaryBlocks();
    if (typeof renderOpinionNoticeDraftWorkspace === 'function') {
      renderOpinionNoticeDraftWorkspace(null);
    }
    if (typeof setOpinionNoticeMode === 'function') {
      setOpinionNoticeMode(typeof getOpinionNoticeMode === 'function' ? getOpinionNoticeMode() : 'table', {
        persist: false,
        refresh: false
      });
    }
    return;
  }

  const selectedType = getNoticeClaimType(selectedClaimId);
  if (selectedType === 'dependent') {
    markNoticeDataVisibility(false);
    table.classList.add('hidden');
    emptyState.classList.remove('hidden');
    emptyState.textContent = '종속항 표 생성은 다음 단계에서 확장합니다.';
    tbody.innerHTML = '';
    clearNoticeSupplementaryBlocks();
    if (typeof renderOpinionNoticeDraftWorkspace === 'function') {
      renderOpinionNoticeDraftWorkspace(selectedClaimId);
    }
    if (typeof setOpinionNoticeMode === 'function') {
      setOpinionNoticeMode(typeof getOpinionNoticeMode === 'function' ? getOpinionNoticeMode() : 'table', {
        persist: false,
        refresh: false
      });
    }
    return;
  }

  const result = analysisResults?.[selectedClaimId];
  const claimFeatures = Array.isArray(result?.ClaimFeatures) ? result.ClaimFeatures : [];

  if (claimFeatures.length === 0) {
    markNoticeDataVisibility(false);
    table.classList.add('hidden');
    emptyState.classList.remove('hidden');
    emptyState.textContent = '선택한 청구항의 구성요소가 없습니다.';
    tbody.innerHTML = '';
    syncNoticeCitationSelect([], null);
    clearNoticeSupplementaryBlocks();
    if (typeof renderOpinionNoticeDraftWorkspace === 'function') {
      renderOpinionNoticeDraftWorkspace(selectedClaimId);
    }
    if (typeof setOpinionNoticeMode === 'function') {
      setOpinionNoticeMode(typeof getOpinionNoticeMode === 'function' ? getOpinionNoticeMode() : 'table', {
        persist: false,
        refresh: false
      });
    }
    return;
  }

  if (typeof recomputeClaimWorkspace === 'function') {
    recomputeClaimWorkspace(selectedClaimId, { persist: false });
  }
  const workspace = typeof ensureClaimWorkspace === 'function'
    ? ensureClaimWorkspace(selectedClaimId)
    : null;
  const relevant = typeof getEffectiveRelevantForClaim === 'function'
    ? getEffectiveRelevantForClaim(selectedClaimId)
    : (result?.Relevant || {});
  const docMetas = buildNoticeCitationMetaList(relevant);

  if (docMetas.length === 0) {
    markNoticeDataVisibility(false);
    table.classList.add('hidden');
    emptyState.classList.remove('hidden');
    emptyState.textContent = '비교할 인용발명 데이터가 없습니다.';
    tbody.innerHTML = '';
    syncNoticeCitationSelect([], null);
    clearNoticeSupplementaryBlocks();
    if (typeof renderOpinionNoticeDraftWorkspace === 'function') {
      renderOpinionNoticeDraftWorkspace(selectedClaimId);
    }
    if (typeof setOpinionNoticeMode === 'function') {
      setOpinionNoticeMode(typeof getOpinionNoticeMode === 'function' ? getOpinionNoticeMode() : 'table', {
        persist: false,
        refresh: false
      });
    }
    return;
  }

  let workspacePrimaryDocName = String(workspace?.selection?.primaryDocName || '').trim();
  const autoDocName = workspacePrimaryDocName || findNoticePrimaryDocName(relevant, claimFeatures, docMetas);
  const preferredDocName = options.preferredCitationDocName || workspacePrimaryDocName || autoDocName;
  const selectedDocName = syncNoticeCitationSelect(docMetas, preferredDocName) || '';

  if (workspace && selectedDocName && workspacePrimaryDocName !== selectedDocName) {
    workspace.selection.primaryDocName = selectedDocName;
    if (typeof recomputeClaimWorkspace === 'function') {
      recomputeClaimWorkspace(selectedClaimId);
    }
    workspacePrimaryDocName = selectedDocName;
  }

  let selectedDocMeta = docMetas.find(meta => meta.docName === selectedDocName) || docMetas[0];
  const effectiveDocName = String(selectedDocMeta?.docName || selectedDocName || '').trim();
  if (!effectiveDocName) {
    markNoticeDataVisibility(false);
    table.classList.add('hidden');
    emptyState.classList.remove('hidden');
    emptyState.textContent = '주인용발명을 선택할 수 없습니다.';
    tbody.innerHTML = '';
    clearNoticeSupplementaryBlocks();
    if (typeof renderOpinionNoticeDraftWorkspace === 'function') {
      renderOpinionNoticeDraftWorkspace(selectedClaimId);
    }
    if (typeof setOpinionNoticeMode === 'function') {
      setOpinionNoticeMode(typeof getOpinionNoticeMode === 'function' ? getOpinionNoticeMode() : 'table', {
        persist: false,
        refresh: false
      });
    }
    return;
  }

  const combinationRows = Array.isArray(workspace?.combinationWorkspace?.rows)
    ? workspace.combinationWorkspace.rows
    : [];
  const comboRowByFeature = new Map(
    combinationRows
      .map(row => [String(row?.featureId || ''), row])
      .filter(([featureId]) => featureId)
  );

  const supportDocNames = [];
  combinationRows.forEach((row) => {
    const supportDocName = String(row?.selectedSupportDoc || '').trim();
    if (!supportDocName || supportDocName === effectiveDocName) return;
    if (supportDocNames.includes(supportDocName)) return;
    supportDocNames.push(supportDocName);
  });

  const usedCitationMetas = buildNoticeUsedCitationMetaList(effectiveDocName, supportDocNames, relevant);
  if (usedCitationMetas.length > 0) {
    selectedDocMeta = usedCitationMetas[0];
  }
  renderNoticeCitationMap(citationMapEl, usedCitationMetas);

  const supportRefNumberByDoc = new Map(
    usedCitationMetas.map((meta) => [meta.docName, Number(meta.refNumber)])
  );

  const noticeRows = claimFeatures.map((feature, index) => {
    const featureId = String(feature?.Id || '').trim();
    const comboRow = comboRowByFeature.get(featureId) || null;

    const entries = getNoticeEntriesForFeature(relevant, effectiveDocName, featureId)
      .map((entry) => ({ ...entry, __docName: effectiveDocName }));
    const evidence = formatNoticeEvidence(entries);

    const primaryStatus = String(comboRow?.primaryStatus || '').trim().toLowerCase();
    const remark = primaryStatus === 'explicit'
      ? MATCH_LABEL_EXPLICIT
      : (primaryStatus === 'equivalent' ? MATCH_LABEL_EQUIVALENT : getNoticeRemark(entries));
    const remarkClass = getNoticeRemarkClass(remark);

    const supportDocName = String(comboRow?.selectedSupportDoc || '').trim();
    const supportEntries = supportDocName
      ? getNoticeEntriesForFeature(relevant, supportDocName, featureId).map((entry) => ({ ...entry, __docName: supportDocName }))
      : [];
    const supportRefNumber = supportDocName ? supportRefNumberByDoc.get(supportDocName) : null;

    return {
      index: index + 1,
      description: feature?.Description || '-',
      evidence,
      entries,
      remark,
      remarkClass,
      supportDocName,
      supportEntries,
      supportRefNumber
    };
  });

  tbody.innerHTML = noticeRows.map((row) => `
      <tr>
        <td>${row.index}</td>
        <td>${escapeHtmlText(row.description)}</td>
        <td>${row.evidence}</td>
        <td><span class="notice-remark ${row.remarkClass}">${row.remark}</span></td>
      </tr>
    `).join('');

  renderNoticeDiffNotes(diffNotesEl, noticeRows, selectedDocMeta);

  if (typeof renderOpinionNoticeDraftWorkspace === 'function') {
    renderOpinionNoticeDraftWorkspace(selectedClaimId);
  }

  markNoticeDataVisibility(true);
  emptyState.classList.add('hidden');
  table.classList.remove('hidden');

  if (typeof setOpinionNoticeMode === 'function') {
    const currentMode = typeof getOpinionNoticeMode === 'function'
      ? getOpinionNoticeMode()
      : 'table';
    setOpinionNoticeMode(currentMode, { persist: false, refresh: false });
  }
}

function sanitizeCellForTsv(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function extractRowCellsAsTsvLine(cells) {
  return Array.from(cells)
    .map(cell => sanitizeCellForTsv(cell?.innerText ?? cell?.textContent ?? ''))
    .join('\t');
}

function extractRowCellsAsPlainValues(cells) {
  return Array.from(cells).map(cell =>
    sanitizeCellForTsv(cell?.innerText ?? cell?.textContent ?? '')
  );
}

function escapeHtmlForClipboard(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildHtmlTableForClipboard(rows) {
  const body = rows.map(row => {
    const cells = row
      .map(cell => `<td>${escapeHtmlForClipboard(cell).replace(/\n/g, '<br>')}</td>`)
      .join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  return [
    '<table border="1" cellspacing="0" cellpadding="2">',
    '<tbody>',
    body,
    '</tbody>',
    '</table>'
  ].join('');
}

function buildOpinionNoticeTsv() {
  const table = document.getElementById('opinion-notice-table');
  const tbody = document.getElementById('opinion-notice-tbody');
  if (!table || !tbody || table.classList.contains('hidden')) return '';

  const headerCells = table.querySelectorAll('thead th');
  const bodyRows = tbody.querySelectorAll('tr');
  if (!headerCells.length || !bodyRows.length) return '';

  const lines = [];
  lines.push(extractRowCellsAsTsvLine(headerCells));
  bodyRows.forEach(row => {
    lines.push(extractRowCellsAsTsvLine(row.querySelectorAll('td')));
  });
  return lines.join('\r\n');
}

function buildOpinionNoticeClipboardPayload() {
  const table = document.getElementById('opinion-notice-table');
  const tbody = document.getElementById('opinion-notice-tbody');
  if (!table || !tbody || table.classList.contains('hidden')) return null;

  const headerCells = table.querySelectorAll('thead th');
  const bodyRows = tbody.querySelectorAll('tr');
  if (!headerCells.length || !bodyRows.length) return null;

  const rows = [];
  rows.push(extractRowCellsAsPlainValues(headerCells));
  bodyRows.forEach(row => {
    rows.push(extractRowCellsAsPlainValues(row.querySelectorAll('td')));
  });

  const tsv = rows.map(row => row.join('\t')).join('\r\n');
  const html = buildHtmlTableForClipboard(rows);
  return { tsv, html };
}

async function writePlainTextToClipboard(text) {
  if (!text) return;

  if (navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem !== 'undefined') {
    const item = new ClipboardItem({
      'text/plain': new Blob([text], { type: 'text/plain' })
    });
    await navigator.clipboard.write([item]);
    return;
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'readonly');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function writePayloadWithExecCommand(payload) {
  let copied = false;
  const listener = event => {
    if (!event?.clipboardData) return;
    event.preventDefault();
    if (payload?.html) {
      event.clipboardData.setData('text/html', payload.html);
    }
    event.clipboardData.setData('text/plain', payload?.tsv || '');
    copied = true;
  };

  document.addEventListener('copy', listener);
  try {
    document.execCommand('copy');
  } finally {
    document.removeEventListener('copy', listener);
  }

  if (!copied) {
    throw new Error('Failed to write clipboard payload with execCommand');
  }
}

async function writeTablePayloadToClipboard(payload) {
  if (!payload || !payload.tsv) return;

  if (navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem !== 'undefined') {
    const items = {
      'text/plain': new Blob([payload.tsv], { type: 'text/plain' })
    };
    if (payload.html) {
      items['text/html'] = new Blob([payload.html], { type: 'text/html' });
    }
    const item = new ClipboardItem(items);
    await navigator.clipboard.write([item]);
    return;
  }

  if (document.queryCommandSupported && document.queryCommandSupported('copy')) {
    writePayloadWithExecCommand(payload);
    return;
  }

  await writePlainTextToClipboard(payload.tsv);
}

async function copyOpinionNoticeTableAsTsv() {
  const payload = buildOpinionNoticeClipboardPayload();
  if (!payload || !payload.tsv) {
    alert('\uBCF5\uC0AC\uD560 \uD45C \uB370\uC774\uD130\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.');
    return;
  }

  try {
    await writeTablePayloadToClipboard(payload);
    alert('\uC758\uACAC\uC81C\uCD9C\uD1B5\uC9C0\uC11C \uD45C\uB97C TSV \uD615\uC2DD\uC73C\uB85C \uBCF5\uC0AC\uD588\uC2B5\uB2C8\uB2E4.');
  } catch (error) {
    console.error('Failed to copy opinion notice TSV:', error);
    alert('\uD45C \uBCF5\uC0AC\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.');
  }
}
