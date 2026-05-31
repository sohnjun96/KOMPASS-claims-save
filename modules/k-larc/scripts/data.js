const K_LARC_SHARED_STORAGE_KEYS = (typeof globalThis !== 'undefined' && globalThis.KSUITE_STORAGE_KEYS) || {};
const K_LARC_CLAIM_SHARE_KEYS = Object.freeze({
  fromKScan: K_LARC_SHARED_STORAGE_KEYS.KSCAN_CLAIM_TEXT || 'ksuiteClaimKScan'
});

function getDefaultClaimTypeByIndex(index) {
  return Number(index) <= 0 ? 'independent' : 'dependent';
}

function normalizeClaimType(type, index = 0) {
  const normalized = String(type || '').trim().toLowerCase();
  if (normalized === 'independent' || normalized === 'dependent') {
    return normalized;
  }
  return getDefaultClaimTypeByIndex(index);
}

function ensureMockDemoDataset() {
  if (!settings.mockMode) return;

  let claimsUpdated = false;
  let citationsUpdated = false;

  const nonEmptyClaims = claims.filter(c => String(c?.text || '').trim());
  const sampleClaims = typeof getMockClaimFixtures === 'function'
    ? getMockClaimFixtures()
    : [
      typeof getMockDefaultClaimText === 'function'
        ? getMockDefaultClaimText()
        : 'Mock claim text'
    ];
  const firstSample = String(sampleClaims[0] || '').trim();
  const hasOnlyLegacySingleMockClaim = nonEmptyClaims.length === 1
    && claims.length <= 1
    && String(nonEmptyClaims[0]?.text || '').trim() === firstSample;

  if (nonEmptyClaims.length === 0 || hasOnlyLegacySingleMockClaim) {
    const fallbackClaim = firstSample || 'Mock claim text';
    const seedClaims = sampleClaims
      .map(text => String(text || '').trim())
      .filter(Boolean);
    const normalizedSeedClaims = seedClaims.length > 0 ? seedClaims : [fallbackClaim];

    if (!Array.isArray(claims)) {
      claims = [];
    }

    normalizedSeedClaims.forEach((text, idx) => {
      const existing = claims[idx];
      if (existing && typeof existing === 'object') {
        existing.id = existing.id || (Date.now() + idx);
        existing.name = existing.name || `Claim ${idx + 1}`;
        existing.type = normalizeClaimType(existing.type, idx);
        existing.text = text;
        return;
      }

      claims[idx] = {
        id: Date.now() + idx,
        name: `Claim ${idx + 1}`,
        type: getDefaultClaimTypeByIndex(idx),
        text
      };
    });
    claimsUpdated = true;
  }

  if (typeof buildMockCitationFixtures === 'function') {
    const fixtures = buildMockCitationFixtures();
    const byName = new Map(
      (citations || []).map(c => [String(c?.name || '').trim().toUpperCase(), c])
    );

    fixtures.forEach((fixture, idx) => {
      const key = String(fixture.name || '').trim().toUpperCase();
      const existing = byName.get(key);

      if (!existing) {
        citations.push({
          id: Date.now() + idx + 1,
          tabId: null,
          name: fixture.name,
          status: 'completed',
          fileId: fixture.fileId,
          title: fixture.title,
          text: fixture.text,
          payloadText: fixture.payloadText || ''
        });
        citationsUpdated = true;
        return;
      }

      let changed = false;
      if (!existing.fileId) {
        existing.fileId = fixture.fileId;
        changed = true;
      }
      if (existing.status !== 'completed') {
        existing.status = 'completed';
        changed = true;
      }
      if (!existing.title) {
        existing.title = fixture.title;
        changed = true;
      }

      const currentPayloadText = String(existing.payloadText || existing.text || '').trim();
      const currentUploadText = String(existing.text || '').trim();
      const hasJsonLikeText = currentPayloadText.startsWith('{') && currentPayloadText.includes('"paragraphs"');
      const hasSentinelUploadText = currentUploadText.includes('⟪') && currentUploadText.includes('⟪/');
      if (!hasSentinelUploadText) {
        existing.text = fixture.text;
        changed = true;
      }
      if (!hasJsonLikeText && fixture.payloadText) {
        existing.payloadText = fixture.payloadText;
        changed = true;
      }

      if (changed) citationsUpdated = true;
    });
  }

  if (claimsUpdated) {
    saveClaimsToStorage();
    renderClaims();
  }

  if (citationsUpdated) {
    saveCitationsToStorage();
    renderCitations();
  }
}

function buildMockVerificationMapFromRelevant(relevant) {
  const verifications = {};
  let seq = 0;

  Object.entries(relevant || {}).forEach(([docName, items]) => {
    if (!Array.isArray(items)) return;
    items.forEach(item => {
      const featureId = String(item?.Feature || '').trim();
      if (!featureId) return;
      seq += 1;
      const key = `${featureId}_${docName}`;
      if (!verifications[key]) {
        verifications[key] = seq % 4 === 0 ? 'F' : 'P';
      }
    });
  });

  return verifications;
}

function buildMockStepTimingsSeed(claimIndex = 0) {
  const stepIds = ['A', 'B', 'C', 'D', 'E'];
  const baseDurations = [950, 2800, 1300, 900, 700];
  const offset = Math.max(0, Number(claimIndex) || 0) * 120;
  let cursor = Date.now() - 60000 - offset;
  const timings = {};

  stepIds.forEach((stepId, idx) => {
    const durationMs = baseDurations[idx] + offset;
    timings[stepId] = {
      stepId,
      startedAt: cursor,
      endedAt: cursor + durationMs,
      durationMs,
      status: 'done'
    };
    cursor += durationMs + 180;
  });

  return timings;
}

function buildMockDemoAnalysisResult(claim, claimIndex = 0) {
  const claimText = String(claim?.text || '').trim();
  const claimFeatures = typeof buildMockClaimFeatures === 'function'
    ? buildMockClaimFeatures(claimText)
    : [];
  const baseRelevant = typeof buildMockRelevant === 'function'
    ? buildMockRelevant(claimFeatures, `Seed-${claimIndex + 1}`)
    : {};
  const relevant = typeof mergeRelevantWithPositions === 'function'
    ? mergeRelevantWithPositions({}, baseRelevant)
    : (baseRelevant || {});

  const featureStatus = {};
  (claimFeatures || []).forEach(feature => {
    if (!feature?.Id) return;
    featureStatus[feature.Id] = 'ENTAIL';
  });

  return {
    ClaimFeatures: claimFeatures,
    Relevant: relevant,
    FeatureStatus: featureStatus,
    verifications: buildMockVerificationMapFromRelevant(relevant),
    debug: {
      stepA: { ClaimFeatures: claimFeatures },
      stepB: { seeded: true },
      stepC: { seeded: true, FeatureStatus: featureStatus },
      stepD: { seeded: true },
      stepTimings: buildMockStepTimingsSeed(claimIndex)
    }
  };
}

function ensureMockDemoAnalysisResults() {
  if (!settings.mockMode) return false;

  if (!analysisResults || typeof analysisResults !== 'object' || Array.isArray(analysisResults)) {
    analysisResults = {};
  }

  const nonEmptyClaims = claims.filter(c => String(c?.text || '').trim());
  let changed = false;

  nonEmptyClaims.forEach((claim, index) => {
    const key = claim?.id;
    if (key === null || key === undefined) return;
    const current = analysisResults[key];
    const hasUsableData = !!(
      current
      && typeof current === 'object'
      && !current.error
      && Array.isArray(current.ClaimFeatures)
      && current.ClaimFeatures.length > 0
      && current.Relevant
      && typeof current.Relevant === 'object'
      && Object.keys(current.Relevant).length > 0
    );
    if (hasUsableData) return;

    analysisResults[key] = buildMockDemoAnalysisResult(claim, index);
    changed = true;
  });

  return changed;
}

function buildCitationDocName(index) {
  const safeIndex = Number.isFinite(Number(index)) ? Math.max(1, Math.round(Number(index))) : 1;
  return `D${safeIndex}`;
}

function isCitationDocName(value) {
  return /^D\d+$/i.test(String(value || '').trim());
}

function isLegacyGeneratedCitationLabel(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return /^mock\s*citation\s*\d+$/i.test(text) || /^citation\s*\d+$/i.test(text);
}

function normalizeCitationNamesInPlace(list, options = {}) {
  const preserveLegacyNameAsTitle = options.preserveLegacyNameAsTitle !== false;
  const nameMap = {};
  let changed = false;

  (Array.isArray(list) ? list : []).forEach((citation, index) => {
    if (!citation || typeof citation !== 'object') return;

    const nextName = buildCitationDocName(index + 1);
    const currentName = String(citation.name || '').trim();
    const currentTitle = String(citation.title || '').trim();

    if (preserveLegacyNameAsTitle && !currentTitle && currentName && !isCitationDocName(currentName)) {
      citation.title = isLegacyGeneratedCitationLabel(currentName) ? nextName : currentName;
      changed = true;
    }

    if (currentName && currentName !== nextName) {
      nameMap[currentName] = nextName;
    }

    if (currentName !== nextName) {
      citation.name = nextName;
      changed = true;
    }

    const normalizedTitle = String(citation.title || '').trim();
    if (!normalizedTitle || isLegacyGeneratedCitationLabel(normalizedTitle)) {
      if (normalizedTitle !== nextName) {
        citation.title = nextName;
        changed = true;
      }
    }
  });

  return { changed, nameMap };
}

function remapRelevantDocNames(relevant, nameMap) {
  if (!relevant || typeof relevant !== 'object' || Array.isArray(relevant)) {
    return { changed: false, value: relevant };
  }

  const mapEntries = Object.entries(nameMap || {}).filter(([from, to]) => from && to && from !== to);
  if (mapEntries.length === 0) {
    return { changed: false, value: relevant };
  }

  let changed = false;
  let nextRelevant = {};

  Object.entries(relevant).forEach(([docName, items]) => {
    const nextDocName = nameMap[docName] || docName;
    if (nextDocName !== docName) {
      changed = true;
    }

    if (typeof mergeRelevantWithPositions === 'function') {
      nextRelevant = mergeRelevantWithPositions(nextRelevant, {
        [nextDocName]: Array.isArray(items) ? items : []
      });
      return;
    }

    if (!nextRelevant[nextDocName]) {
      nextRelevant[nextDocName] = [];
    }
    if (Array.isArray(items)) {
      nextRelevant[nextDocName].push(...items);
    }
  });

  return {
    changed,
    value: changed ? nextRelevant : relevant
  };
}

function remapVerificationDocNames(verifications, nameMap) {
  if (!verifications || typeof verifications !== 'object' || Array.isArray(verifications)) {
    return { changed: false, value: verifications };
  }

  const mapEntries = Object.entries(nameMap || {}).filter(([from, to]) => from && to && from !== to);
  if (mapEntries.length === 0) {
    return { changed: false, value: verifications };
  }

  let changed = false;
  const nextVerifications = {};

  Object.entries(verifications).forEach(([key, value]) => {
    let nextKey = key;
    for (const [fromName, toName] of mapEntries) {
      const suffix = `_${fromName}`;
      if (!nextKey.endsWith(suffix)) continue;
      nextKey = `${nextKey.slice(0, nextKey.length - fromName.length)}${toName}`;
      changed = true;
      break;
    }
    nextVerifications[nextKey] = value;
  });

  return {
    changed,
    value: changed ? nextVerifications : verifications
  };
}

function migrateAnalysisResultsCitationNames(nameMap) {
  const mapEntries = Object.entries(nameMap || {}).filter(([from, to]) => from && to && from !== to);
  if (mapEntries.length === 0 || !analysisResults || typeof analysisResults !== 'object') {
    return false;
  }

  const remapDocName = (rawName) => {
    const safeName = String(rawName || '').trim();
    if (!safeName) return safeName;
    return nameMap[safeName] || safeName;
  };
  const remapStringMap = (rawMap) => {
    if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) return rawMap;
    let changedMap = false;
    const next = {};
    Object.entries(rawMap).forEach(([key, value]) => {
      const nextValue = remapDocName(value);
      if (String(value || '').trim() !== nextValue) {
        changedMap = true;
      }
      next[key] = nextValue;
    });
    return { changed: changedMap, value: changedMap ? next : rawMap };
  };

  let changed = false;

  Object.values(analysisResults).forEach((result) => {
    if (!result || typeof result !== 'object') return;

    ['Relevant', 'stepBRelevant'].forEach((fieldName) => {
      const remapped = remapRelevantDocNames(result[fieldName], nameMap);
      if (!remapped.changed) return;
      result[fieldName] = remapped.value;
      changed = true;
    });

    const remappedVerifications = remapVerificationDocNames(result.verifications, nameMap);
    if (remappedVerifications.changed) {
      result.verifications = remappedVerifications.value;
      changed = true;
    }

    const workspace = result.workspace;
    if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) return;

    const selection = workspace.selection;
    if (selection && typeof selection === 'object' && !Array.isArray(selection)) {
      const nextPrimaryDocName = remapDocName(selection.primaryDocName);
      if (String(selection.primaryDocName || '').trim() !== nextPrimaryDocName) {
        selection.primaryDocName = nextPrimaryDocName;
        changed = true;
      }

      const remappedSupport = remapStringMap(selection.supportDocsByFeature);
      if (remappedSupport?.changed) {
        selection.supportDocsByFeature = remappedSupport.value;
        changed = true;
      }
    }

    const recommendation = workspace.docRoleRecommendation;
    if (recommendation && typeof recommendation === 'object' && !Array.isArray(recommendation)) {
      if (Array.isArray(recommendation.primaryCandidates)) {
        recommendation.primaryCandidates.forEach((candidate) => {
          if (!candidate || typeof candidate !== 'object') return;
          const nextDocName = remapDocName(candidate.docName);
          if (String(candidate.docName || '').trim() !== nextDocName) {
            candidate.docName = nextDocName;
            changed = true;
          }
        });
      }

      const supportByFeature = recommendation.supportCandidatesByFeature;
      if (supportByFeature && typeof supportByFeature === 'object' && !Array.isArray(supportByFeature)) {
        Object.values(supportByFeature).forEach((rows) => {
          if (!Array.isArray(rows)) return;
          rows.forEach((row) => {
            if (!row || typeof row !== 'object') return;
            const nextDocName = remapDocName(row.docName);
            if (String(row.docName || '').trim() !== nextDocName) {
              row.docName = nextDocName;
              changed = true;
            }
          });
        });
      }
    }

    const combinationWorkspace = workspace.combinationWorkspace;
    if (combinationWorkspace && typeof combinationWorkspace === 'object' && !Array.isArray(combinationWorkspace)) {
      const nextPrimaryDocName = remapDocName(combinationWorkspace.primaryDocName);
      if (String(combinationWorkspace.primaryDocName || '').trim() !== nextPrimaryDocName) {
        combinationWorkspace.primaryDocName = nextPrimaryDocName;
        changed = true;
      }

      if (Array.isArray(combinationWorkspace.rows)) {
        combinationWorkspace.rows.forEach((row) => {
          if (!row || typeof row !== 'object') return;
          const nextSupportDoc = remapDocName(row.selectedSupportDoc);
          if (String(row.selectedSupportDoc || '').trim() !== nextSupportDoc) {
            row.selectedSupportDoc = nextSupportDoc;
            changed = true;
          }

          if (Array.isArray(row.candidateDocs)) {
            row.candidateDocs.forEach((candidate) => {
              if (!candidate || typeof candidate !== 'object') return;
              const nextDocName = remapDocName(candidate.docName);
              if (String(candidate.docName || '').trim() !== nextDocName) {
                candidate.docName = nextDocName;
                changed = true;
              }
            });
          }
        });
      }
    }

    const draft = workspace.opinionNoticeDraft;
    if (draft && typeof draft === 'object' && !Array.isArray(draft)) {
      const nextPrimaryDocName = remapDocName(draft.primaryDocName);
      if (String(draft.primaryDocName || '').trim() !== nextPrimaryDocName) {
        draft.primaryDocName = nextPrimaryDocName;
        changed = true;
      }

      const remappedSupportDocs = remapStringMap(draft.supportDocsByFeature);
      if (remappedSupportDocs?.changed) {
        draft.supportDocsByFeature = remappedSupportDocs.value;
        changed = true;
      }

      if (Array.isArray(draft.rows)) {
        draft.rows.forEach((row) => {
          if (!row || typeof row !== 'object') return;
          const nextSupportDoc = remapDocName(row.supportDocName);
          if (String(row.supportDocName || '').trim() !== nextSupportDoc) {
            row.supportDocName = nextSupportDoc;
            changed = true;
          }
        });
      }
    }
  });

  return changed;
}

function saveOpenWebUiApiSettingsToStorage() {
  chrome.storage.local.set({
    [K_LARC_OPENWEBUI_API_STORAGE_KEY]: settings.openwebuiApiSettings
  });
}

function saveStepB2SkillSettingToStorage() {
  chrome.storage.local.set({
    [K_LARC_B2_SKILL_TOGGLE_STORAGE_KEY]: !!settings.useB2SkillMd
  });
}

function applyOpenWebUiApiSettings(nextSettings, options = {}) {
  settings.openwebuiApiSettings = normalizeOpenWebUiApiSettings(nextSettings);
  if (options.persist !== false) {
    saveOpenWebUiApiSettingsToStorage();
  }
  return settings.openwebuiApiSettings;
}

function applyStepB2SkillSetting(useB2SkillMd, options = {}) {
  settings.useB2SkillMd = !!useB2SkillMd;
  if (options.persist !== false) {
    saveStepB2SkillSettingToStorage();
  }
  return settings.useB2SkillMd;
}

async function loadSettings() {
  // savedCitations 포함
  const data = await chrome.storage.local.get([
    'webuiBaseUrl',
    'ksuiteSharedApiKey',
    'ksuiteDefaultModel',
    'savedClaims',
    'savedCitations',
    'savedAnalysisResults',
    K_LARC_OPENWEBUI_API_STORAGE_KEY,
    K_LARC_B2_SKILL_TOGGLE_STORAGE_KEY
  ]);

  if (data.webuiBaseUrl) {
    settings.url = data.webuiBaseUrl;
    const apiUrlInput = document.getElementById('api-url');
    if (apiUrlInput) {
      apiUrlInput.value = data.webuiBaseUrl;
    }
  }

  const sharedKey = String(
    data.ksuiteSharedApiKey ||
    ''
  ).trim();

  if (sharedKey) {
    const apiKeyInput = document.getElementById('api-key');
    if (apiKeyInput) {
      apiKeyInput.value = sharedKey;
    }
    settings.key = sharedKey;
  }
  settings.model = String(data.ksuiteDefaultModel || settings.model || DEFAULT_LARC_MODEL).trim() || DEFAULT_LARC_MODEL;
  settings.mockMode = !!DEV_FLAGS.ENABLE_MOCK_MODE;
  applyOpenWebUiApiSettings(data[K_LARC_OPENWEBUI_API_STORAGE_KEY], { persist: false });
  applyStepB2SkillSetting(data[K_LARC_B2_SKILL_TOGGLE_STORAGE_KEY], { persist: false });
  const apiKeyInput = document.getElementById('api-key');
  if (apiKeyInput) {
    apiKeyInput.disabled = settings.mockMode;
  }

  // A. 청구항 불러오기
  if (data.savedClaims && Array.isArray(data.savedClaims) && data.savedClaims.length > 0) {
    // [수정] 기존 데이터 호환성을 위해 name 속성 추가
    claims = data.savedClaims.map((claim, index) => ({
      ...claim,
      name: claim.name || ('\uCCAD\uAD6C\uD56D ' + (index + 1)),
      type: normalizeClaimType(claim.type, index)
    }));
  } else {
    claims = [{ id: Date.now(), name: '\uCCAD\uAD6C\uD56D 1', type: 'independent', text: '' }];
  }
  renderClaims();

  // B. 인용발명 불러오기 및 상태 복구
  let citationNameMigration = { changed: false, nameMap: {} };
  if (data.savedCitations && Array.isArray(data.savedCitations)) {
    citations = data.savedCitations;
    citationNameMigration = normalizeCitationNamesInPlace(citations);
    renderCitations();

    // *중요*: 대시보드를 닫았을 때 'processing' 상태였던 항목들은
    // 다시 열었을 때도 폴링(상태확인)을 재개해야 함
    citations.forEach(c => {
      if (c.status === 'processing' || c.status === 'uploading') {
        pollStatus(c);
      }
    });
  }

  // Seed mock dataset when mock mode is enabled.
  if (settings.mockMode) {
    ensureMockDemoDataset();
  }

  analysisResults = (data.savedAnalysisResults && typeof data.savedAnalysisResults === 'object')
    ? data.savedAnalysisResults
    : {};

  const migratedAnalysisResults = migrateAnalysisResultsCitationNames(citationNameMigration.nameMap);
  if (citationNameMigration.changed) {
    saveCitationsToStorage();
  }
  if (migratedAnalysisResults) {
    saveAnalysisResultsToStorage();
  }

  if (settings.mockMode) {
    const mockResultsSeeded = ensureMockDemoAnalysisResults();
    if (mockResultsSeeded) {
      saveAnalysisResultsToStorage();
    }
  }

  const resultControls = document.getElementById('result-controls');
  const claimSelect = document.getElementById('result-claim-select');
  const nonEmptyClaims = claims.filter(c => c.text.trim());

  if (Object.keys(analysisResults).length > 0 && nonEmptyClaims.length > 0) {
    resultControls.classList.remove('hidden');
    initializeClaimProgressFromSavedResults(nonEmptyClaims);
    refreshResultClaimSelect(nonEmptyClaims);
    if (claimSelect.options.length > 0) {
      selectResultClaim(claimSelect.options[0].value);
    }
  } else {
    claimProgressById = {};
  }
  if (DEV_FLAGS.SHOW_DEBUG_PANEL) {
    updateDebugClaimSelect();
    renderDebugContent();
  }
  if (typeof updateDebugExportButtonVisibility === 'function') {
    updateDebugExportButtonVisibility();
  }
  if (typeof restoreAnalysisExecutionMode === 'function') {
    restoreAnalysisExecutionMode();
  } else if (typeof setAnalysisExecutionMode === 'function') {
    setAnalysisExecutionMode('deep', { persist: false });
  }
  const hasSavedAnalysisResults = Object.keys(analysisResults || {}).length > 0;
  const savedMode = typeof getSavedAnalysisMode === 'function' ? getSavedAnalysisMode() : null;
  if (hasSavedAnalysisResults) {
    setAnalysisMode(savedMode === null ? true : savedMode);
  } else {
    setAnalysisMode(false);
  }
}

function saveAnalysisResultsToStorage() {
  chrome.storage.local.set({ savedAnalysisResults: analysisResults });
}

function addClaimInput() {
  const id = Date.now();
  const claimIndex = claims.length;
  const newName = `\uCCAD\uAD6C\uD56D ${claimIndex + 1}`;
  claims.push({
    id,
    name: newName,
    type: getDefaultClaimTypeByIndex(claimIndex),
    text: ''
  });
  renderClaims();
  saveClaimsToStorage();
}
async function importClaimFromKScan() {
  if (document.body.classList.contains('analysis-active')) {
    alert('Switch to input mode before importing a claim.');
    return false;
  }

  try {
    const data = await chrome.storage.local.get(K_LARC_CLAIM_SHARE_KEYS.fromKScan);
    const importedText = String(data[K_LARC_CLAIM_SHARE_KEYS.fromKScan] || '');
    if (!importedText.trim()) {
      alert('No shared claim found in K-SCAN.');
      return false;
    }

    let targetClaim = claims.find((claim) => !String(claim?.text || '').trim());
    if (!targetClaim) {
      addClaimInput();
      targetClaim = claims[claims.length - 1] || null;
    }

    if (!targetClaim) {
      alert('Could not import claim from K-SCAN.');
      return false;
    }

    targetClaim.text = importedText;
    renderClaims();
    saveClaimsToStorage();
    refreshResultClaimSelect();
    return true;
  } catch (error) {
    console.error('Failed to import claim from K-SCAN:', error);
    alert('Failed to import claim from K-SCAN.');
    return false;
  }
}

function removeClaim(id) {
  if (claims.length <= 1) return; 
  claims = claims.filter(c => c.id !== id);
  renderClaims();
  saveClaimsToStorage();
}

function updateClaimName(id, name) {
  const claim = claims.find(c => c.id === id);
  if (claim) {
    claim.name = name;
    saveClaimsToStorage();
    refreshResultClaimSelect();
  }
}

function updateClaimType(id, type) {
  const claimIndex = claims.findIndex(c => c.id === id);
  if (claimIndex < 0) return;

  claims[claimIndex].type = normalizeClaimType(type, claimIndex);
  saveClaimsToStorage();
  refreshResultClaimSelect();

  if (String(selectedResultClaimId) === String(id) && typeof refreshOpinionNoticeCard === 'function') {
    refreshOpinionNoticeCard({ syncClaimSelect: false });
  }
}

function updateClaimText(id, text) {
  const claim = claims.find(c => c.id === id);
  if (claim) {
    claim.text = text;
    saveClaimsToStorage();
  }
}

function saveClaimsToStorage() {
  chrome.storage.local.set({ savedClaims: claims });
}

function _renderClaimsLegacy() {
  const container = document.getElementById('claim-list');
  container.innerHTML = '';
  const readOnly = document.body.classList.contains('analysis-active');

  claims.forEach((claim) => {
    const div = document.createElement('div');
    div.className = 'claim-card';
    div.innerHTML = `
      <div class="claim-header">
        <input type="text" class="claim-name-input" value="${claim.name}" data-id="${claim.id}" ${readOnly ? 'readonly tabindex="-1"' : ''}>
        <button class="btn-remove-claim ${readOnly ? 'hidden' : ''}" data-id="${claim.id}">삭제</button>
      </div>
      <textarea rows="1" placeholder="청구항 내용을 입력해 주세요.." data-id="${claim.id}" ${readOnly ? 'readonly tabindex="-1"' : ''}>${claim.text}</textarea>
    `;
    container.appendChild(div);

    const textarea = div.querySelector('textarea');
    // 초기 로드 시 높이 조절
    autoResizeTextarea(textarea);
  });

  if (!readOnly) {
    container.querySelectorAll('.claim-name-input').forEach(el => {
      el.addEventListener('input', (e) => updateClaimName(parseInt(e.target.dataset.id), e.target.value));
    });

    container.querySelectorAll('textarea').forEach(el => {
      el.addEventListener('input', (e) => {
        // 높이 자동 조절 및 텍스트 업데이트
        autoResizeTextarea(e.target);
        updateClaimText(parseInt(e.target.dataset.id), e.target.value);
      });
    });

    container.querySelectorAll('.btn-remove-claim').forEach(el => {
      el.addEventListener('click', (e) => removeClaim(parseInt(e.target.dataset.id)));
    });
  }

  if (DEV_FLAGS.SHOW_DEBUG_PANEL) {
    updateDebugClaimSelect();
  }
  updateInputSummary();
}

function buildClaimCardElement(claim, readOnly) {
  if (readOnly) {
    const content = document.createElement('div');
    content.className = 'claim-readonly-content';
    const text = (claim.text || '').trim();
    content.textContent = text || '(청구항 내용이 없습니다.)';
    return content;
  }

  const div = document.createElement('div');
  div.className = 'claim-card';
  const claimIndex = claims.findIndex((item) => item.id === claim.id);
  const claimType = normalizeClaimType(claim.type, claimIndex);
  div.innerHTML = `
    <div class="claim-header">
      <div class="claim-header-main">
        <input type="text" class="claim-name-input" value="${claim.name}" data-id="${claim.id}" ${readOnly ? 'readonly tabindex="-1"' : ''}>
        <select class="claim-type-select" data-id="${claim.id}" ${readOnly ? 'disabled tabindex="-1"' : ''}>
          <option value="independent" ${claimType === 'independent' ? 'selected' : ''}>독립항</option>
          <option value="dependent" ${claimType === 'dependent' ? 'selected' : ''}>종속항</option>
        </select>
      </div>
      <button class="btn-remove-claim ${readOnly ? 'hidden' : ''}" data-id="${claim.id}">삭제</button>
    </div>
    <textarea rows="1" placeholder="청구항 내용을 입력해 주세요.." data-id="${claim.id}" ${readOnly ? 'readonly tabindex="-1"' : ''}>${claim.text}</textarea>
  `;

  const textarea = div.querySelector('textarea');
  autoResizeTextarea(textarea);
  return div;
}

function renderClaims() {
  const container = document.getElementById('claim-list');
  container.innerHTML = '';
  const readOnly = document.body.classList.contains('analysis-active');
  const headerSelect = document.getElementById('claim-view-select-header');

  let claimsToRender = claims;
  if (readOnly) {
    if (!selectedClaimPreviewId || !claims.some(c => c.id === selectedClaimPreviewId)) {
      selectedClaimPreviewId = claims[0]?.id || null;
    }

    if (headerSelect) {
      headerSelect.innerHTML = '';
      claims.forEach(claim => {
        const option = document.createElement('option');
        option.value = String(claim.id);
        option.textContent = claim.name;
        headerSelect.appendChild(option);
      });

      if (selectedClaimPreviewId) {
        headerSelect.value = String(selectedClaimPreviewId);
      }

      if (!headerSelect.dataset.bound) {
        headerSelect.addEventListener('change', (e) => {
          selectedClaimPreviewId = parseInt(e.target.value, 10);
          renderClaims();
        });
        headerSelect.dataset.bound = 'true';
      }
    }

    const selectedClaim = claims.find(c => c.id === selectedClaimPreviewId);
    claimsToRender = selectedClaim ? [selectedClaim] : [];
  } else {
    selectedClaimPreviewId = null;
    if (headerSelect) {
      headerSelect.innerHTML = '';
    }
  }

  claimsToRender.forEach(claim => {
    container.appendChild(buildClaimCardElement(claim, readOnly));
  });

  if (!readOnly) {
    container.querySelectorAll('.claim-name-input').forEach(el => {
      el.addEventListener('input', (e) => updateClaimName(parseInt(e.target.dataset.id, 10), e.target.value));
    });

    container.querySelectorAll('.claim-type-select').forEach(el => {
      el.addEventListener('change', (e) => updateClaimType(parseInt(e.target.dataset.id, 10), e.target.value));
    });

    container.querySelectorAll('textarea').forEach(el => {
      el.addEventListener('input', (e) => {
        autoResizeTextarea(e.target);
        updateClaimText(parseInt(e.target.dataset.id, 10), e.target.value);
      });
    });

    container.querySelectorAll('.btn-remove-claim').forEach(el => {
      el.addEventListener('click', (e) => removeClaim(parseInt(e.target.dataset.id, 10)));
    });
  }

  if (DEV_FLAGS.SHOW_DEBUG_PANEL) {
    updateDebugClaimSelect();
  }
  updateInputSummary();
}

function saveCitationsToStorage() {
  chrome.storage.local.set({ savedCitations: citations });
}

function buildTabSelectPlaceholderOption() {
  const option = document.createElement('option');
  option.value = '';
  option.textContent = '-- Select a tab --';
  return option;
}

function buildMockTabDescriptors() {
  const fixtures = typeof buildMockCitationFixtures === 'function'
    ? buildMockCitationFixtures()
    : [];

  if (fixtures.length > 0) {
    return fixtures.map((fixture, index) => {
      const fallbackDocName = typeof getMockDocNameByIndex === 'function'
        ? getMockDocNameByIndex(index)
        : `D${index + 1}`;
      const docName = String(fixture?.name || fallbackDocName || `D${index + 1}`).trim();
      const rawTitle = String(fixture?.title || '').trim();
      const title = (!rawTitle || isLegacyGeneratedCitationLabel(rawTitle)) ? docName : rawTitle;
      return {
        value: String(-(index + 1)),
        docName,
        title,
        label: `[MOCK] ${docName}`
      };
    });
  }

  const descriptors = [];
  for (let i = 0; i < 5; i += 1) {
    const docName = typeof getMockDocNameByIndex === 'function'
      ? getMockDocNameByIndex(i)
      : `D${i + 1}`;
    descriptors.push({
      value: String(-(i + 1)),
      docName,
      title: docName,
      label: `[MOCK] ${docName}`
    });
  }
  return descriptors;
}

function appendMockTabs(select) {
  if (!settings.mockMode) return 0;

  const mockTabs = buildMockTabDescriptors();
  mockTabs.forEach((mockTab) => {
    const option = document.createElement('option');
    option.value = mockTab.value;
    option.textContent = mockTab.label;
    option.dataset.mock = 'true';
    option.dataset.mockDocName = mockTab.docName;
    option.dataset.mockTitle = mockTab.title;
    select.appendChild(option);
  });

  return mockTabs.length;
}

function appendBrowserTabs(select, tabs) {
  const validTabs = (tabs || []).filter((tab) =>
    tab?.id
    && typeof tab.url === 'string'
    && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))
  );

  validTabs.forEach((tab) => {
    const option = document.createElement('option');
    option.value = String(tab.id);
    const title = String(tab.title || tab.url || '').trim();
    option.textContent = title.length > 80 ? `${title.substring(0, 80)}...` : title;
    select.appendChild(option);
  });

  return validTabs.length;
}

function restoreTabSelection(select, previousValue) {
  if (!previousValue) return;
  const exists = Array.from(select.options).some((option) => option.value === previousValue);
  if (exists) {
    select.value = previousValue;
  }
}

function loadTabs() {
  const select = document.getElementById('tab-select');
  if (!select) return;

  const previousValue = select.value;
  select.innerHTML = '';
  select.appendChild(buildTabSelectPlaceholderOption());

  const mockCount = appendMockTabs(select);

  if (!chrome?.tabs?.query) {
    if (mockCount === 0) {
      const unavailable = document.createElement('option');
      unavailable.value = '';
      unavailable.disabled = true;
      unavailable.textContent = '(Browser tabs unavailable)';
      select.appendChild(unavailable);
    }
    restoreTabSelection(select, previousValue);
    return;
  }

  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError) {
      console.warn('Tab query failed:', chrome.runtime.lastError.message);
      if (mockCount === 0) {
        const failed = document.createElement('option');
        failed.value = '';
        failed.disabled = true;
        failed.textContent = '(Unable to load tabs)';
        select.appendChild(failed);
      }
      restoreTabSelection(select, previousValue);
      return;
    }

    const browserTabCount = appendBrowserTabs(select, tabs);
    if (browserTabCount === 0 && mockCount === 0) {
      const empty = document.createElement('option');
      empty.value = '';
      empty.disabled = true;
      empty.textContent = '(No HTTP(S) tabs found)';
      select.appendChild(empty);
    }

    restoreTabSelection(select, previousValue);
  });
}
async function addCitationFromTab() {
  const select = document.getElementById('tab-select');
  const selectedOption = select?.options?.[select.selectedIndex];
  const tabId = Number.parseInt(select?.value || '', 10);
  if (!Number.isFinite(tabId)) {
    alert('Please select a tab first.');
    return;
  }

  const isMockSelection = selectedOption?.dataset?.mock === 'true';

  const existing = citations.find(c => c.tabId === tabId);
  if (existing) {
    if (!confirm(`'${existing.name}' already exists. Add it again?`)) return;
  }

  const citationId = Date.now();
  const citationObj = {
    id: citationId,
    tabId,
    name: buildCitationDocName(citations.length + 1),
    status: 'uploading',
    fileId: null,
    title: 'Loading...',
    text: ''
  };

  citations.push(citationObj);
  renderCitations();
  saveCitationsToStorage();

  if (settings.mockMode) {
    setTimeout(() => {
      const target = citations.find(c => c.id === citationId);
      if (!target) return;

      const selectedTitle = selectedOption?.dataset?.mockTitle
        || selectedOption?.textContent
        || `Tab ID: ${tabId}`;
      const mockDocName = selectedOption?.dataset?.mockDocName
        || (typeof getMockDocNameByIndex === 'function'
          ? getMockDocNameByIndex(citations.length - 1)
          : `D${(citations.length % 3) + 1}`);
      const normalizedMockTitle = isLegacyGeneratedCitationLabel(selectedTitle) ? mockDocName : selectedTitle;
      const mockPayload = typeof buildMockCitationPayload === 'function'
        ? buildMockCitationPayload(mockDocName, normalizedMockTitle)
        : { paragraphs: {}, claims: {} };
      const mockUploadText = typeof buildUploadTextFromCitationPayload === 'function'
        ? buildUploadTextFromCitationPayload(mockPayload)
        : '';

      target.name = buildCitationDocName(citations.findIndex(c => c.id === citationId) + 1);
      target.fileId = `mock-file-${mockDocName.toLowerCase()}-${citationId}`;
      target.title = normalizedMockTitle;
      target.status = 'completed';
      target.text = mockUploadText || '';
      target.payloadText = JSON.stringify(mockPayload, null, 2);

      renderCitations();
      saveCitationsToStorage();
    }, 450);
    return;
  }

  chrome.runtime.sendMessage({
    type: 'EXTRACT_AND_UPLOAD',
    tabId,
    chunkSize: CITATION_SENTINEL_CHUNK_SIZE,
    chunkOverflow: CITATION_SENTINEL_CHUNK_OVERFLOW,
    baseUrl: settings.url,
    apiKey: settings.key
  }, (response) => {
    const target = citations.find(c => c.id === citationId);
    if (!target) return;

    if (response.ok) {
      target.fileId = response.fileId;
      target.title = response.title;
      target.text = String(response.text || '').trim();
      target.payloadText = String(response.payloadText || '').trim();
      if (
        response.extractionMode
        || response.scriptArtifactsDetected !== undefined
        || response.scriptArtifactsRemoved !== undefined
        || response.xmlQualityScore !== undefined
        || response.xmlFallbackReason !== undefined
      ) {
        target.extractionMeta = {
          extractionMode: String(response.extractionMode || '').trim() || null,
          scriptArtifactsDetected: response.scriptArtifactsDetected === true,
          scriptArtifactsRemoved: response.scriptArtifactsRemoved === true,
          xmlQualityScore: Number.isFinite(Number(response.xmlQualityScore))
            ? Number(response.xmlQualityScore)
            : null,
          xmlFallbackReason: String(response.xmlFallbackReason || '').trim() || null
        };
      } else {
        delete target.extractionMeta;
      }
      target.status = 'processing';

      renderCitations();
      saveCitationsToStorage();
      pollStatus(target);
    } else {
      target.status = 'failed';
      target.error = response.error;
      renderCitations();
      saveCitationsToStorage();
      alert(`Upload failed: ${response.error}`);
    }
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || 'Runtime message failed.'));
        return;
      }
      resolve(response || {});
    });
  });
}

function buildCitationNameFromFileName(fileName, fallbackIndex) {
  return buildCitationDocName(fallbackIndex);
}

function buildSentinelPayloadFromPlainText(rawText, options = {}) {
  const source = String(options.source || 'direct').trim() || 'direct';
  const sectionId = String(options.sectionId || '').trim();
  const sectionTitle = String(options.sectionTitle || '').trim();
  const pageNumber = Number(options.pageNumber);
  const safePageNumber = Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : null;
  const chunkSize = Number.isFinite(Number(CITATION_SENTINEL_CHUNK_SIZE))
    ? Math.max(60, Number(CITATION_SENTINEL_CHUNK_SIZE))
    : 400;
  const overflow = Number.isFinite(Number(CITATION_SENTINEL_CHUNK_OVERFLOW))
    ? Math.max(0, Number(CITATION_SENTINEL_CHUNK_OVERFLOW))
    : 80;

  const fallbackText = String(rawText || '').trim();
  const chunks = typeof chunkTextBySentence === 'function'
    ? chunkTextBySentence(fallbackText, chunkSize, overflow)
    : [fallbackText];
  const normalizedChunks = chunks.map(v => String(v || '').trim()).filter(Boolean);

  const paragraphs = {};
  const sentinelMap = {};

  normalizedChunks.forEach((chunkText, index) => {
    const order = index + 1;
    const sentinelId = formatSentinelId(order);
    const paragraphKey = `[${formatSentinelId(order)}]`;
    const wrappedText = wrapWithSentinel(sentinelId, chunkText);

    paragraphs[paragraphKey] = wrappedText;
    sentinelMap[sentinelId] = {
      id: sentinelId,
      order,
      source,
      targetType: 'paragraph',
      sourceKey: paragraphKey,
      displayKey: paragraphKey,
      pageNumber: safePageNumber || null,
      sectionId: sectionId || null,
      sectionTitle: sectionTitle || null
    };
  });

  const firstParagraphKey = Object.keys(paragraphs)[0] || null;
  const hasSectionMeta = Boolean(sectionId || sectionTitle || safePageNumber);
  return {
    paragraphs,
    claims: {},
    sentinelMap,
    meta: {
      source,
      pageCount: safePageNumber ? 1 : 0,
      sectionCount: hasSectionMeta ? 1 : 0,
      sections: hasSectionMeta
        ? [
          {
            id: sectionId || null,
            title: sectionTitle || null,
            pageNumber: safePageNumber || null,
            startParagraph: firstParagraphKey
          }
        ]
        : [],
      paragraphCount: Object.keys(paragraphs).length,
      claimCount: 0,
      sentinelCount: Object.keys(sentinelMap).length,
      chunkSize
    }
  };
}

function openPdfAddDialog() {
  const input = document.getElementById('pdf-citation-input');
  if (!input) {
    alert('PDF input control is not available.');
    return;
  }

  input.value = '';
  input.click();
}

async function handlePdfFileSelected(event) {
  const input = event?.target || document.getElementById('pdf-citation-input');
  const file = input?.files?.[0];
  if (!file) return;

  const isPdf = file.type === 'application/pdf' || String(file.name || '').toLowerCase().endsWith('.pdf');
  if (!isPdf) {
    alert('Only PDF files are supported.');
    input.value = '';
    return;
  }

  const citationId = Date.now();
  const citationName = buildCitationNameFromFileName(file.name, citations.length + 1);
  const citationObj = {
    id: citationId,
    tabId: null,
    name: citationName,
    status: 'uploading',
    fileId: null,
    title: file.name,
    text: ''
  };

  citations.push(citationObj);
  renderCitations();
  saveCitationsToStorage();

  try {
    const extractor = globalThis.KLarcPdfExtractor;
    if (!extractor || typeof extractor.extractPdfCitationPayload !== 'function') {
      throw new Error('PDF parser is not initialized.');
    }

    const payload = await extractor.extractPdfCitationPayload(file);
    const payloadText = JSON.stringify(payload, null, 2);
    const uploadText = typeof buildUploadTextFromCitationPayload === 'function'
      ? buildUploadTextFromCitationPayload(payload)
      : '';
    if (!uploadText) {
      throw new Error('Failed to build sentinel text for PDF upload.');
    }
    const target = citations.find(c => c.id === citationId);
    if (!target) return;

    target.text = uploadText;
    target.payloadText = payloadText;
    const pageCount = Number(payload?.meta?.pageCount) || 0;
    const sectionCount = Number(payload?.meta?.sectionCount) || 0;
    target.title = `${file.name} (${pageCount}p/${sectionCount}s)`;

    if (settings.mockMode) {
      target.fileId = `mock-pdf-${citationId}`;
      target.status = 'completed';
      renderCitations();
      saveCitationsToStorage();
      return;
    }

    target.status = 'processing';
    renderCitations();
    saveCitationsToStorage();

    const safeName = citationName.replace(/[^a-zA-Z0-9_-]/g, '_') || `citation_${citationId}`;
    const response = await sendRuntimeMessage({
      type: 'DIRECT_UPLOAD',
      text: uploadText,
      filename: `${safeName}.txt`,
      baseUrl: settings.url,
      apiKey: settings.key
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'PDF upload failed.');
    }

    target.fileId = response.fileId;
    target.status = 'processing';
    renderCitations();
    saveCitationsToStorage();
    pollStatus(target);
  } catch (error) {
    const target = citations.find(c => c.id === citationId);
    if (target) {
      target.status = 'failed';
      target.error = error?.message || String(error);
      renderCitations();
      saveCitationsToStorage();
    }
    alert(`PDF add failed: ${error?.message || error}`);
  } finally {
    input.value = '';
  }
}

function pollStatus(citation) {
  // 이미 완료됐거나 실패한 상태면 재시도하지 않음
  if (citation.status === 'completed' || citation.status === 'failed') return;

  if (settings.mockMode) {
    setTimeout(() => {
      const currentCitation = citations.find(c => c.id === citation.id);
      if (!currentCitation) return;
      currentCitation.status = 'completed';
      if (!currentCitation.fileId) {
        currentCitation.fileId = `mock-file-${currentCitation.id}`;
      }
      saveCitationsToStorage();
      renderCitations();
    }, 400);
    return;
  }

  const interval = setInterval(() => {
    // 1. 사용자가 목록에서 삭제했으면 폴링 중단
    const currentCitation = citations.find(c => c.id === citation.id);
    if (!currentCitation) {
      clearInterval(interval);
      return;
    }

    // 2. 상태 확인 요청
    chrome.runtime.sendMessage({ 
      type: 'CHECK_STATUS', 
      fileId: citation.fileId,
      baseUrl: settings.url,
      apiKey: settings.key
    }, (res) => {
      
      // 3. 응답 처리
      if (res.ok) {
        console.log(`[Polling] ${citation.name}:`, res.status); // 콘솔에서 상태 확인 가능
        if (res.status === 'completed') {
          // 성공 처리
          currentCitation.status = 'completed';
          saveCitationsToStorage();
          renderCitations();
          clearInterval(interval); // 중요: 루프 종료
        } 
        else if (res.status === 'failed') {
          // 실패 처리
          currentCitation.status = 'failed';
          saveCitationsToStorage();
          renderCitations();
          clearInterval(interval); // 중요: 루프 종료
        }
        // processing 인 경우 아무것도 하지 않고 다음 틱 대기
      } else {
        // 네트워크 에러 등이 발생했을 때
        console.warn('Polling error response:', res.error);
        
        // (선택사항) 연속 에러 시 중단 로직을 넣을 수도 있으나,
        // 일시적 네트워크 오류일 수 있으므로 보통은 유지합니다.
      }
    });
  }, 3000); // 3초 간격
}

function removeCitation(id) {
  // 1. 삭제 대상 찾기
  const targetIndex = citations.findIndex(c => c.id === id);
  if (targetIndex === -1) return;
  
  const target = citations[targetIndex];

  if (!confirm(`'${target.name}'을(를) 삭제하시겠습니까?\n(서버에 업로드된 파일도 함께 삭제됩니다)`)) return;
  
  // 2. 서버 파일 삭제 요청 (fileId가 있는 경우)
  if (target.fileId && settings.key) {
    console.log(`Deleting file from server: ${target.fileId}`);
    
    chrome.runtime.sendMessage({
      type: 'DELETE_FILE',
      fileId: target.fileId,
      baseUrl: settings.url,
      apiKey: settings.key
    }, (response) => {
      if (response && response.ok) {
        console.log(`File deleted successfully: ${target.fileId}`);
      } else {
        console.warn(`Failed to delete file on server: ${response?.error}`);
        // 서버 삭제 실패여도 UI에서는 제거하는 편이 UX상 자연스럽다.
      }
    });
  }

  // 3. UI 및 로컬 데이터에서 제거
  citations.splice(targetIndex, 1);

  const citationNameMigration = normalizeCitationNamesInPlace(citations, {
    preserveLegacyNameAsTitle: false
  });
  if (migrateAnalysisResultsCitationNames(citationNameMigration.nameMap)) {
    saveAnalysisResultsToStorage();
  }
  
  renderCitations();
  saveCitationsToStorage();
}

function renderCitations() {
  const list = document.getElementById('citation-list');
  list.innerHTML = '';
  const readOnly = document.body.classList.contains('analysis-active');
  
  if (citations.length === 0) {
    list.innerHTML = '<li class="empty-placeholder" style="list-style:none; padding:20px; text-align:center; color:#888;">분석할 탭을 선택하고 추가해 주세요.</li>';
    return;
  }

  citations.forEach(c => {
    const li = document.createElement('li');
    li.className = 'citation-item';
    li.setAttribute('role', 'button');
    li.setAttribute('tabindex', '0');
    li.setAttribute('aria-label', `${c.name} 미리보기 열기`);
    
    const badgeClass = c.status; 
    
    li.innerHTML = `
      <div class="citation-info">
        <span class="citation-name">${c.name}</span>
        <span class="citation-url" title="${c.title}">${c.title || ('Tab ID: ' + c.tabId)}</span>
      </div>
      <div class="citation-actions">
        <span class="status-badge ${badgeClass}">${c.status}</span>
        ${readOnly ? '' : `
        <button class="btn-delete-citation" title="삭제">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>`}
      </div>
    `;

    li.addEventListener('click', (e) => {
      if (e.target.closest('.btn-delete-citation')) return;
      openModal(c);
    });
    li.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target.closest('.btn-delete-citation')) return;
      e.preventDefault();
      openModal(c);
    });

    if (!readOnly) {
      const delBtn = li.querySelector('.btn-delete-citation');
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeCitation(c.id);
      });
    }

    list.appendChild(li);
  });
  updateInputSummary();
}

function openModal(citation) {
  const title = document.getElementById('modal-title');
  const content = document.getElementById('modal-text-content');
  
  title.textContent = `${citation.name} 내용 미리보기`;
  
  if (citation.status === 'uploading' || citation.status === 'processing') {
    content.textContent = '현재 파일을 처리 중입니다. 잠시 후 다시 시도해 주세요.';
  } else if (citation.text) {
    const MAX_LENGTH = 20000;
    const displayUserInfo = citation.text.length > MAX_LENGTH 
      ? citation.text.substring(0, MAX_LENGTH) + '\n\n... (텍스트가 너무 길어 생략됨)'
      : citation.text;
    content.textContent = displayUserInfo;
  } else {
    content.textContent = '(추출된 텍스트가 없습니다)';
  }
  
  openDialogModal('preview-modal', '#btn-close-modal');
}

function closeModal() {
  closeDialogModal('preview-modal');
}

function openDirectAddModal() {
  document.getElementById('direct-citation-name').value = buildCitationDocName(citations.length + 1);
  document.getElementById('direct-citation-content').value = '';
  openDialogModal('direct-add-modal', '#direct-citation-name');
}

function closeDirectAddModal() {
  closeDialogModal('direct-add-modal');
}

function handleDirectAdd() {
  const requestedName = document.getElementById('direct-citation-name').value.trim();
  const text = document.getElementById('direct-citation-content').value.trim();

  if (!requestedName || !text) {
    alert('문서 이름과 내용을 모두 입력해 주세요.');
    return;
  }
  
  const citationId = Date.now();
  const payload = buildSentinelPayloadFromPlainText(text, {
    source: 'direct_input'
  });
  const payloadText = JSON.stringify(payload, null, 2);
  const uploadText = typeof buildUploadTextFromCitationPayload === 'function'
    ? buildUploadTextFromCitationPayload(payload)
    : '';
  if (!uploadText) {
    alert('센티넬 텍스트 생성에 실패하여 업로드를 중단했습니다.');
    return;
  }
  const citationObj = { 
    id: citationId,
    tabId: null, // 직접 추가는 tabId가 없음
    name: buildCitationDocName(citations.length + 1),
    status: 'uploading', 
    fileId: null,
    title: requestedName, // 제목은 사용자가 입력한 이름을 유지
    text: uploadText,
    payloadText
  };
  
  citations.push(citationObj);
  renderCitations();
  saveCitationsToStorage();
  closeDirectAddModal();

  if (settings.mockMode) {
    setTimeout(() => {
      const target = citations.find(c => c.id === citationId);
      if (!target) return;
      target.fileId = `mock-file-${citationId}`;
      target.status = 'completed';
      renderCitations();
      saveCitationsToStorage();
    }, 350);
    return;
  }

  chrome.runtime.sendMessage({ 
    type: 'DIRECT_UPLOAD', 
    text: uploadText,
    filename: `${requestedName.replace(/[^a-zA-Z0-9]/g, "_")}.txt`,
    baseUrl: settings.url, 
    apiKey: settings.key 
  }, (response) => {
    const target = citations.find(c => c.id === citationId);
    if (!target) return; 

    if (response.ok) {
      target.fileId = response.fileId;
      target.status = 'processing';
      renderCitations();
      saveCitationsToStorage();
      pollStatus(target);
    } else {
      target.status = 'failed';
      target.error = response.error;
      renderCitations();
      saveCitationsToStorage();
      alert(`업로드 실패: ${response.error}`);
    }
  });
}
