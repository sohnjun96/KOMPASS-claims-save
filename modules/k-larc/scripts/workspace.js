
const WORKSPACE_REVIEW_FILTERS = Object.freeze(['review_queue', 'accepted', 'confirmed', 'all']);
const WORKSPACE_REVIEW_FILTER_LABELS = Object.freeze({
  review_queue: '검토 필요',
  accepted: '채택 증거',
  confirmed: '확정 증거',
  all: '전체',
});
const WORKSPACE_REVIEW_GROUP_MODES = Object.freeze(['feature', 'doc']);
const WORKSPACE_COMBINATION_TAGS = Object.freeze([
  'same_field',
  'same_problem',
  'functional_complement',
  'general_design_choice',
  'weak_link'
]);
const OPINION_NOTICE_MODE_STORAGE_KEY = 'kLarcOpinionNoticeMode';
const DECISION_WORKSPACE_VIEW_STORAGE_KEY = 'kLarcDecisionWorkspaceView';
const DECISION_WORKSPACE_VIEWS = Object.freeze(['combination', 'review', 'llmcheck']);
const OPINION_NOTICE_REVIEW_CITATION_MAX_CHARS = 24000;
const OPINION_NOTICE_REVIEW_CLAIMS_MAX_CHARS = 60000;

let opinionNoticeMode = 'table';
let decisionWorkspaceUiBound = false;
let decisionWorkspaceView = 'combination';

function normalizeWorkspaceClaimId(claimId) {
  const parsed = Number.parseInt(claimId, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function getClaimResultForWorkspace(claimId) {
  const id = normalizeWorkspaceClaimId(claimId);
  if (id === null) return null;
  return analysisResults?.[id] || analysisResults?.[String(id)] || null;
}

function normalizeWorkspaceDecision(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'accept') return 'accept';
  if (normalized === 'hold') return 'hold';
  if (normalized === 'reject') return 'reject';
  return 'system';
}

function normalizeWorkspaceFilter(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'warning' || normalized === 'caution' || normalized === 'equivalent' || normalized === 'unreviewed') {
    return 'review_queue';
  }
  if (normalized === 'explicit') {
    return 'confirmed';
  }
  if (WORKSPACE_REVIEW_FILTERS.includes(normalized)) return normalized;
  return 'review_queue';
}

function normalizeWorkspaceGroupBy(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (WORKSPACE_REVIEW_GROUP_MODES.includes(normalized)) return normalized;
  return 'feature';
}

function normalizeDecisionWorkspaceView(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'recommendation') return 'combination';
  if (DECISION_WORKSPACE_VIEWS.includes(normalized)) return normalized;
  return 'combination';
}

function setDecisionWorkspaceView(view, options = {}) {
  decisionWorkspaceView = normalizeDecisionWorkspaceView(view);
  document.querySelectorAll('[data-workspace-view]').forEach((button) => {
    const isActive = normalizeDecisionWorkspaceView(button.dataset.workspaceView) === decisionWorkspaceView;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  document.querySelectorAll('[data-workspace-panel]').forEach((panel) => {
    const isActive = normalizeDecisionWorkspaceView(panel.dataset.workspacePanel) === decisionWorkspaceView;
    panel.classList.toggle('hidden', !isActive);
    panel.classList.toggle('is-active', isActive);
  });

  if (options.persist !== false) {
    try {
      localStorage.setItem(DECISION_WORKSPACE_VIEW_STORAGE_KEY, decisionWorkspaceView);
    } catch (error) {
      console.warn('Failed to persist decision workspace view:', error);
    }
  }
}

function restoreDecisionWorkspaceView() {
  let saved = 'combination';
  try {
    saved = localStorage.getItem(DECISION_WORKSPACE_VIEW_STORAGE_KEY) || 'combination';
  } catch (error) {
    console.warn('Failed to restore decision workspace view:', error);
  }
  setDecisionWorkspaceView(saved, { persist: false });
}

function normalizeWorkspaceStringMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const next = {};
  Object.entries(raw).forEach(([key, value]) => {
    const safeKey = String(key || '').trim();
    if (!safeKey) return;
    next[safeKey] = String(value || '').trim();
  });
  return next;
}

function normalizeWorkspaceStringArrayMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const next = {};
  Object.entries(raw).forEach(([key, value]) => {
    const safeKey = String(key || '').trim();
    if (!safeKey) return;
    const list = Array.isArray(value) ? value : [];
    const normalizedList = list.map((item) => String(item || '').trim()).filter(Boolean);
    if (normalizedList.length > 0) {
      next[safeKey] = [...new Set(normalizedList)];
    }
  });
  return next;
}

function normalizeWorkspaceEvidenceContextMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const normalized = {};
  Object.entries(raw).forEach(([rawEvidenceId, rawValue]) => {
    const evidenceId = normalizeEvidenceId(rawEvidenceId);
    if (!evidenceId) return;
    const prev = Math.max(0, Number.parseInt(rawValue?.prev, 10) || 0);
    const next = Math.max(0, Number.parseInt(rawValue?.next, 10) || 0);
    if (prev > 0 || next > 0) {
      normalized[evidenceId] = { prev, next };
    }
  });
  return normalized;
}

function normalizeWorkspaceEvidenceExpandedMap(raw) {
  const normalized = {};

  if (Array.isArray(raw)) {
    raw.forEach((rawEvidenceId) => {
      const evidenceId = normalizeEvidenceId(rawEvidenceId);
      if (evidenceId) {
        normalized[evidenceId] = true;
      }
    });
    return normalized;
  }

  if (!raw || typeof raw !== 'object') return normalized;

  Object.entries(raw).forEach(([rawEvidenceId, rawValue]) => {
    const evidenceId = normalizeEvidenceId(rawEvidenceId);
    if (!evidenceId) return;
    if (rawValue) {
      normalized[evidenceId] = true;
    }
  });
  return normalized;
}

function ensureClaimWorkspace(claimId) {
  const result = getClaimResultForWorkspace(claimId);
  if (!result || typeof result !== 'object') return null;

  if (!result.workspace || typeof result.workspace !== 'object' || Array.isArray(result.workspace)) {
    result.workspace = {};
  }
  const workspace = result.workspace;

  if (!workspace.selection || typeof workspace.selection !== 'object' || Array.isArray(workspace.selection)) {
    workspace.selection = {};
  }
  workspace.selection.primaryDocName = String(workspace.selection.primaryDocName || '').trim();
  workspace.selection.supportDocsByFeature = normalizeWorkspaceStringMap(workspace.selection.supportDocsByFeature);
  workspace.selection.combinationTagsByFeature = normalizeWorkspaceStringArrayMap(workspace.selection.combinationTagsByFeature);
  workspace.selection.combinationNotesByFeature = normalizeWorkspaceStringMap(workspace.selection.combinationNotesByFeature);

  if (!workspace.manualReview || typeof workspace.manualReview !== 'object' || Array.isArray(workspace.manualReview)) {
    workspace.manualReview = {};
  }
  if (!workspace.manualReview.filters || typeof workspace.manualReview.filters !== 'object' || Array.isArray(workspace.manualReview.filters)) {
    workspace.manualReview.filters = {};
  }
  workspace.manualReview.filters.active = normalizeWorkspaceFilter(workspace.manualReview.filters.active);
  workspace.manualReview.groupBy = normalizeWorkspaceGroupBy(workspace.manualReview.groupBy);

  if (!workspace.manualReview.decisionsByEvidenceId
      || typeof workspace.manualReview.decisionsByEvidenceId !== 'object'
      || Array.isArray(workspace.manualReview.decisionsByEvidenceId)) {
    workspace.manualReview.decisionsByEvidenceId = {};
  }
  workspace.manualReview.contextWindowByEvidenceId = normalizeWorkspaceEvidenceContextMap(
    workspace.manualReview.contextWindowByEvidenceId
  );
  workspace.manualReview.expandedEvidenceIds = normalizeWorkspaceEvidenceExpandedMap(
    workspace.manualReview.expandedEvidenceIds
  );

  const normalizedDecisions = {};
  Object.entries(workspace.manualReview.decisionsByEvidenceId).forEach(([rawEvidenceId, rawDecision]) => {
    const evidenceId = normalizeEvidenceId(rawEvidenceId);
    if (!evidenceId) return;

    if (rawDecision && typeof rawDecision === 'object' && !Array.isArray(rawDecision)) {
      normalizedDecisions[evidenceId] = {
        decision: normalizeWorkspaceDecision(rawDecision.decision),
        note: String(rawDecision.note || '').trim(),
        updatedAt: String(rawDecision.updatedAt || '').trim()
      };
      return;
    }

    normalizedDecisions[evidenceId] = {
      decision: normalizeWorkspaceDecision(rawDecision),
      note: '',
      updatedAt: ''
    };
  });
  workspace.manualReview.decisionsByEvidenceId = normalizedDecisions;

  if (!workspace.docRoleRecommendation || typeof workspace.docRoleRecommendation !== 'object' || Array.isArray(workspace.docRoleRecommendation)) {
    workspace.docRoleRecommendation = {
      primaryCandidates: [],
      supportCandidatesByFeature: {}
    };
  }

  if (!workspace.combinationWorkspace || typeof workspace.combinationWorkspace !== 'object' || Array.isArray(workspace.combinationWorkspace)) {
    workspace.combinationWorkspace = {
      primaryDocName: '',
      rows: []
    };
  }

  if (!workspace.llmCheck || typeof workspace.llmCheck !== 'object' || Array.isArray(workspace.llmCheck)) {
    workspace.llmCheck = {};
  }
  workspace.llmCheck.prompt = String(workspace.llmCheck.prompt || '').trim();
  workspace.llmCheck.systemPrompt = String(workspace.llmCheck.systemPrompt || '').trim();
  workspace.llmCheck.score = String(workspace.llmCheck.score || '').trim();
  workspace.llmCheck.reason = String(workspace.llmCheck.reason || '').trim();
  workspace.llmCheck.error = String(workspace.llmCheck.error || '').trim();
  workspace.llmCheck.running = !!workspace.llmCheck.running;
  workspace.llmCheck.lastRequestedAt = String(workspace.llmCheck.lastRequestedAt || '').trim();
  workspace.llmCheck.lastCompletedAt = String(workspace.llmCheck.lastCompletedAt || '').trim();
  workspace.llmCheck.lastRawResponse = String(workspace.llmCheck.lastRawResponse || '').trim();

  if (!workspace.opinionNoticeDraft || typeof workspace.opinionNoticeDraft !== 'object' || Array.isArray(workspace.opinionNoticeDraft)) {
    workspace.opinionNoticeDraft = {
      claimId: normalizeWorkspaceClaimId(claimId),
      claimType: 'independent',
      primaryDocName: '',
      supportDocsByFeature: {},
      rows: [],
      sentenceLinks: {
        intro: [],
        comparison: [],
        difference: [],
        inventiveStep: [],
        conclusion: []
      },
      sections: {
        intro: '',
        comparison: '',
        difference: '',
        inventiveStep: '',
        conclusion: ''
      }
    };
  }

  return workspace;
}

function allocateMissingEvidenceIds(claimId) {
  const result = getClaimResultForWorkspace(claimId);
  if (!result || typeof result !== 'object') return false;
  if (!result.Relevant || typeof result.Relevant !== 'object' || Array.isArray(result.Relevant)) return false;

  const used = new Set();
  let maxSeq = 0;

  Object.values(result.Relevant).forEach((items) => {
    if (!Array.isArray(items)) return;
    items.forEach((rawItem) => {
      const evidenceId = normalizeEvidenceId(rawItem?.EvidenceId || rawItem?.evidenceId);
      if (!evidenceId) return;
      used.add(evidenceId);
      const numeric = Number.parseInt(String(evidenceId).replace(/\D/g, ''), 10);
      if (Number.isFinite(numeric) && numeric > maxSeq) {
        maxSeq = numeric;
      }
    });
  });

  let changed = false;
  let seq = Math.max(1, maxSeq + 1);
  const duplicated = new Set();

  Object.values(result.Relevant).forEach((items) => {
    if (!Array.isArray(items)) return;
    items.forEach((rawItem) => {
      if (!rawItem || typeof rawItem !== 'object') return;
      const current = normalizeEvidenceId(rawItem.EvidenceId || rawItem.evidenceId);
      if (current && !duplicated.has(current)) {
        duplicated.add(current);
        rawItem.EvidenceId = current;
        delete rawItem.evidenceId;
        return;
      }

      while (true) {
        const candidate = `R${String(seq).padStart(4, '0')}`;
        seq += 1;
        if (used.has(candidate)) continue;
        used.add(candidate);
        duplicated.add(candidate);
        rawItem.EvidenceId = candidate;
        delete rawItem.evidenceId;
        changed = true;
        break;
      }
    });
  });

  return changed;
}

function normalizeWorkspaceVerificationValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      status: String(value.status || '').trim().toLowerCase(),
      reason: String(value.reason || '').trim()
    };
  }

  const text = String(value || '').trim().toUpperCase();
  if (text === 'F' || text === 'FAIL') {
    return {
      status: 'warning',
      reason: '검증 실패로 분류되었습니다.'
    };
  }
  if (text === 'P' || text === 'PASS') {
    return {
      status: 'pass',
      reason: ''
    };
  }
  return {
    status: '',
    reason: ''
  };
}

function getWorkspaceVerificationSeverity(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'warning') return 3;
  if (normalized === 'caution') return 2;
  if (normalized === 'pass') return 1;
  return 0;
}

function pickHigherWorkspaceVerification(currentValue, nextValue) {
  const current = normalizeWorkspaceVerificationValue(currentValue);
  const next = normalizeWorkspaceVerificationValue(nextValue);
  const currentRank = getWorkspaceVerificationSeverity(current.status);
  const nextRank = getWorkspaceVerificationSeverity(next.status);
  if (nextRank > currentRank) return next;
  if (nextRank < currentRank) return current;
  if (!current.reason && next.reason) return next;
  return current;
}

function normalizeWorkspaceVerification(result, featureId, docName, evidenceId = '') {
  const safeEvidenceId = normalizeEvidenceId(evidenceId);
  if (safeEvidenceId) {
    const evidenceValue = result?.verifications?.[safeEvidenceId];
    if (evidenceValue !== undefined) {
      return normalizeWorkspaceVerificationValue(evidenceValue);
    }
  }

  const key = `${featureId}_${docName}`;
  const groupedValue = result?.verifications?.[key];
  if (groupedValue !== undefined) {
    return normalizeWorkspaceVerificationValue(groupedValue);
  }

  const items = Array.isArray(result?.Relevant?.[docName]) ? result.Relevant[docName] : [];
  let aggregated = null;
  items.forEach((item) => {
    if (String(item?.Feature || '').trim() !== String(featureId || '').trim()) return;
    const itemEvidenceId = normalizeEvidenceId(item?.EvidenceId || item?.evidenceId);
    if (!itemEvidenceId) return;
    const value = result?.verifications?.[itemEvidenceId];
    if (value === undefined) return;
    aggregated = pickHigherWorkspaceVerification(aggregated, value);
  });
  if (aggregated) return aggregated;

  return {
    status: '',
    reason: ''
  };
}

function resolveWorkspaceMatchClass(rawMatchType) {
  const normalized = String(rawMatchType || '').trim().toLowerCase();
  if (normalized === 'explicit' || normalized === 'identical' || normalized === '동일') {
    return 'explicit';
  }
  if (normalized === 'equivalent' || normalized === 'substantially equivalent' || normalized.replace(/\s+/g, '') === '실질적동일') {
    return 'equivalent';
  }
  return 'none';
}

function getClaimFeatureDescriptionMap(claimId) {
  const result = getClaimResultForWorkspace(claimId);
  const map = new Map();
  (result?.ClaimFeatures || []).forEach((feature) => {
    const featureId = String(feature?.Id || '').trim();
    if (!featureId) return;
    map.set(featureId, String(feature?.Description || '').trim());
  });
  return map;
}

function getClaimFeatureOrderMap(claimId) {
  const result = getClaimResultForWorkspace(claimId);
  const map = new Map();
  (result?.ClaimFeatures || []).forEach((feature, index) => {
    const featureId = String(feature?.Id || '').trim();
    if (!featureId) return;
    map.set(featureId, index);
  });
  return map;
}

function getFeatureNumericOrder(featureId) {
  const match = String(featureId || '').match(/\d+/);
  return match ? Number(match[0]) : Number.MAX_SAFE_INTEGER;
}

function compareEvidenceByFeatureOrder(a, b, featureOrderMap) {
  const aFeatureId = String(a?.featureId || '').trim();
  const bFeatureId = String(b?.featureId || '').trim();
  const aClaimOrder = featureOrderMap?.has(aFeatureId) ? featureOrderMap.get(aFeatureId) : Number.MAX_SAFE_INTEGER;
  const bClaimOrder = featureOrderMap?.has(bFeatureId) ? featureOrderMap.get(bFeatureId) : Number.MAX_SAFE_INTEGER;
  if (aClaimOrder !== bClaimOrder) return aClaimOrder - bClaimOrder;

  const aNumericOrder = getFeatureNumericOrder(aFeatureId);
  const bNumericOrder = getFeatureNumericOrder(bFeatureId);
  if (aNumericOrder !== bNumericOrder) return aNumericOrder - bNumericOrder;

  return aFeatureId.localeCompare(bFeatureId, 'ko');
}

function getStepCEvidenceScoreMap(result) {
  const scoreMap = result?.debug?.stepC?.aggregate?.evidenceScore;
  if (scoreMap && typeof scoreMap === 'object' && !Array.isArray(scoreMap)) {
    return scoreMap;
  }
  return {};
}

function getStepCEvidenceDecisionMap(result) {
  const rawMap = result?.debug?.stepC?.EvidenceDecision;
  if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) return {};
  const normalized = {};
  Object.entries(rawMap).forEach(([evidenceId, flag]) => {
    const safeEvidenceId = normalizeEvidenceId(evidenceId);
    if (!safeEvidenceId) return;
    const normalizedFlag = String(flag || '').trim().toUpperCase();
    normalized[safeEvidenceId] = normalizedFlag === 'P' ? 'P' : 'F';
  });
  return normalized;
}

function isVerificationAlertStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  return normalized === 'warning' || normalized === 'error' || normalized === 'fail' || normalized === 'caution';
}

function getEvidenceReviewPriority(entry) {
  if (String(entry?.sourceStage || '').trim() === 'stepC_discarded') return 2;
  if (isVerificationAlertStatus(entry?.verificationStatus)) return 1;
  return 3;
}

function getEvidenceSourceLabel(entry) {
  if (String(entry?.sourceStage || '').trim() === 'stepC_discarded') return 'C단계 폐기';
  if (isVerificationAlertStatus(entry?.verificationStatus)) return 'E단계 경고/오류';
  return '확정 증거';
}

function compareEvidenceEntries(a, b) {
  const aPriority = getEvidenceReviewPriority(a);
  const bPriority = getEvidenceReviewPriority(b);
  if (aPriority !== bPriority) return aPriority - bPriority;

  const aOrder = Number((String(a.featureId || '').match(/\d+/) || ['9999'])[0]);
  const bOrder = Number((String(b.featureId || '').match(/\d+/) || ['9999'])[0]);
  if (aOrder !== bOrder) return aOrder - bOrder;

  const docCompare = String(a.docName || '').localeCompare(String(b.docName || ''), 'ko');
  if (docCompare !== 0) return docCompare;

  return String(a.evidenceId || '').localeCompare(String(b.evidenceId || ''), 'ko');
}

function toWorkspaceEvidenceEntry({
  claimId,
  result,
  workspace,
  scoreMap,
  featureDescriptionMap,
  evidenceId,
  docName,
  featureId,
  featureDescription,
  matchType,
  content,
  sourceExcerpt,
  position,
  sourceStage
}) {
  const safeEvidenceId = normalizeEvidenceId(evidenceId)
    || `AUTO-${normalizeWorkspaceClaimId(claimId) || 0}-${docName}-${featureId}`;
  const decisionRecord = workspace.manualReview.decisionsByEvidenceId[safeEvidenceId] || null;
  const decision = normalizeWorkspaceDecision(decisionRecord?.decision);
  const note = String(decisionRecord?.note || '').trim();
  const defaultInclude = String(sourceStage || '').trim() !== 'stepC_discarded';
  const includeInEffective = decision === 'accept'
    || (decision === 'system' && defaultInclude);

  const verification = normalizeWorkspaceVerification(result, featureId, docName, safeEvidenceId);
  const aggregate = scoreMap?.[safeEvidenceId];
  const aggregateScore = Number.isFinite(Number(aggregate?.normalizedScore))
    ? Number(aggregate.normalizedScore)
    : null;
  const judgeVotes = aggregate && typeof aggregate.judges === 'object' ? aggregate.judges : null;

  const entry = {
    evidenceId: safeEvidenceId,
    docName: String(docName || '').trim(),
    featureId: String(featureId || '').trim(),
    featureDescription: String(featureDescription || featureDescriptionMap.get(featureId) || '').trim(),
    matchType,
    matchClass: resolveWorkspaceMatchClass(matchType),
    content: String(content || '').trim(),
    sourceExcerpt: String(sourceExcerpt || '').trim(),
    position: String(position || '').trim(),
    sourceStage: String(sourceStage || '').trim(),
    sourceLabel: '',
    reviewPriority: 3,
    decision,
    note,
    includeInEffective,
    verificationStatus: verification.status,
    verificationReason: verification.reason,
    judgeVotes,
    aggregateScore
  };
  entry.reviewPriority = getEvidenceReviewPriority(entry);
  entry.sourceLabel = getEvidenceSourceLabel(entry);
  return entry;
}

function buildStepCDiscardedEvidenceEntries({
  claimId,
  result,
  workspace,
  scoreMap,
  featureDescriptionMap,
  existingEvidenceIds
}) {
  if (!result || typeof result !== 'object') return [];
  const stepBRelevant = result.stepBRelevant && typeof result.stepBRelevant === 'object'
    ? result.stepBRelevant
    : {};
  const decisionMap = getStepCEvidenceDecisionMap(result);
  if (Object.keys(decisionMap).length === 0) return [];

  if (typeof buildStepCEvidenceBundle !== 'function') return [];
  const bundle = buildStepCEvidenceBundle(stepBRelevant);
  const evidenceById = bundle?.evidenceById && typeof bundle.evidenceById === 'object'
    ? bundle.evidenceById
    : {};
  const rows = [];

  Object.entries(decisionMap).forEach(([evidenceId, flag]) => {
    if (flag !== 'F') return;
    if (existingEvidenceIds.has(evidenceId)) return;
    const matched = evidenceById[evidenceId];
    if (!matched || typeof matched !== 'object') return;
    const docName = String(matched.doc || '').trim();
    const item = normalizeRelevantItemRecord(matched.item || {});
    if (!docName || !item.Feature || !item.MatchType || !item.Content) return;

    rows.push(
      toWorkspaceEvidenceEntry({
        claimId,
        result,
        workspace,
        scoreMap,
        featureDescriptionMap,
        evidenceId,
        docName,
        featureId: item.Feature,
        matchType: item.MatchType,
        content: item.Content,
        sourceExcerpt: item.SourceExcerpt || '',
        position: item.Position || '',
        sourceStage: 'stepC_discarded'
      })
    );
  });

  return rows;
}

function getAllEvidenceEntriesForClaim(claimId) {
  const result = getClaimResultForWorkspace(claimId);
  if (!result || typeof result !== 'object') return [];

  ensureClaimWorkspace(claimId);
  allocateMissingEvidenceIds(claimId);

  const workspace = result.workspace;
  const featureDescriptionMap = getClaimFeatureDescriptionMap(claimId);
  const scoreMap = getStepCEvidenceScoreMap(result);
  const rows = [];
  const existingEvidenceIds = new Set();
  Object.entries(result.Relevant || {}).forEach(([docName, items]) => {
    if (!Array.isArray(items)) return;
    items.forEach((rawItem, index) => {
      const item = normalizeRelevantItemRecord(rawItem);
      if (!item.Feature || !item.MatchType || !item.Content) return;

      const evidenceId = normalizeEvidenceId(item.EvidenceId)
        || `AUTO-${normalizeWorkspaceClaimId(claimId) || 0}-${docName}-${item.Feature}-${index + 1}`;
      existingEvidenceIds.add(evidenceId);
      rows.push(
        toWorkspaceEvidenceEntry({
          claimId,
          result,
          workspace,
          scoreMap,
          featureDescriptionMap,
          evidenceId,
          docName,
          featureId: item.Feature,
          matchType: item.MatchType,
          content: item.Content,
          sourceExcerpt: item.SourceExcerpt || '',
          position: item.Position || '',
          sourceStage: 'final'
        })
      );
    });
  });

  const stepCDiscardedRows = buildStepCDiscardedEvidenceEntries({
    claimId,
    result,
    workspace,
    scoreMap,
    featureDescriptionMap,
    existingEvidenceIds
  });
  rows.push(...stepCDiscardedRows);

  rows.sort(compareEvidenceEntries);

  return rows;
}

function getEffectiveEvidenceEntriesForClaim(claimId) {
  return getAllEvidenceEntriesForClaim(claimId).filter((entry) => entry.includeInEffective);
}

function getEffectiveRelevantForClaim(claimId) {
  const effectiveEntries = getEffectiveEvidenceEntriesForClaim(claimId);
  let relevant = {};

  effectiveEntries.forEach((entry) => {
    relevant = mergeRelevantWithPositions(relevant, {
      [entry.docName]: [{
        EvidenceId: entry.evidenceId,
        Feature: entry.featureId,
        MatchType: entry.matchType,
        Content: entry.content,
        SourceExcerpt: entry.sourceExcerpt,
        Position: entry.position
      }]
    });
  });

  return mergeRelevantBySnippet(relevant, { dropSourceExcerpt: false });
}

function getCoverageStatusForEntries(entries) {
  const hasExplicit = entries.some((entry) => resolveWorkspaceMatchClass(entry.matchType || entry.MatchType) === 'explicit');
  if (hasExplicit) return 'explicit';
  const hasEquivalent = entries.some((entry) => resolveWorkspaceMatchClass(entry.matchType || entry.MatchType) === 'equivalent');
  if (hasEquivalent) return 'equivalent';
  return 'missing';
}

function getEntriesForDocFeature(relevant, docName, featureId) {
  const docItems = Array.isArray(relevant?.[docName]) ? relevant[docName] : [];
  return docItems
    .map((item) => normalizeRelevantItemRecord(item, featureId))
    .filter((item) => String(item.Feature || '').trim() === String(featureId || '').trim());
}

function getVerificationPenaltyForDoc(result, docName, featureIds) {
  let warningCount = 0;
  let cautionCount = 0;

  (featureIds || []).forEach((featureId) => {
    const verification = normalizeWorkspaceVerification(result, featureId, docName);
    if (verification.status === 'warning') warningCount += 1;
    if (verification.status === 'caution') cautionCount += 1;
  });

  return { warningCount, cautionCount };
}

function buildSupportCandidateRowsForFeature(claimId, primaryDocName, featureId, effectiveRelevant) {
  const result = getClaimResultForWorkspace(claimId);
  const rows = [];

  Object.entries(effectiveRelevant || {}).forEach(([docName, items]) => {
    if (!Array.isArray(items) || String(docName || '').trim() === String(primaryDocName || '').trim()) return;

    const entries = items
      .map((rawItem) => normalizeRelevantItemRecord(rawItem, featureId))
      .filter((item) => item.Feature === featureId);

    if (entries.length === 0) return;

    const hasExplicit = entries.some((entry) => resolveWorkspaceMatchClass(entry.MatchType) === 'explicit');
    const hasEquivalent = entries.some((entry) => resolveWorkspaceMatchClass(entry.MatchType) === 'equivalent');
    const matchType = hasExplicit ? 'Explicit' : (hasEquivalent ? 'Equivalent' : 'Unknown');
    const evidenceIds = entries.map((entry) => normalizeEvidenceId(entry.EvidenceId)).filter(Boolean);

    const verification = normalizeWorkspaceVerification(result, featureId, docName);
    const riskFlags = [];
    if (!hasExplicit && hasEquivalent) riskFlags.push('weak_link');
    if (verification.status === 'warning') riskFlags.push('verification_warning');
    if (entries.length === 1) riskFlags.push('single_evidence_only');

    let score = hasExplicit ? 0.9 : 0.65;
    if (verification.status === 'warning') score -= 0.2;
    if (verification.status === 'caution') score -= 0.1;
    if (entries.length === 1) score -= 0.05;

    rows.push({
      docName,
      score: Math.max(0, Number(score.toFixed(3))),
      matchType,
      evidenceIds,
      riskFlags
    });
  });

  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.docName || '').localeCompare(String(b.docName || ''), 'ko');
  });

  return rows;
}

function buildDocRoleRecommendation(claimId) {
  const result = getClaimResultForWorkspace(claimId);
  const workspace = ensureClaimWorkspace(claimId);
  if (!result || !workspace) {
    return {
      primaryCandidates: [],
      supportCandidatesByFeature: {}
    };
  }

  const claimFeatures = Array.isArray(result.ClaimFeatures) ? result.ClaimFeatures : [];
  const effectiveRelevant = getEffectiveRelevantForClaim(claimId);
  const docs = Object.keys(effectiveRelevant || {}).filter((docName) => Array.isArray(effectiveRelevant?.[docName]));

  const primaryCandidates = docs.map((docName) => {
    const explicitFeatures = [];
    const equivalentFeatures = [];
    const missingFeatures = [];

    claimFeatures.forEach((feature) => {
      const featureId = String(feature?.Id || '').trim();
      if (!featureId) return;
      const entries = getEntriesForDocFeature(effectiveRelevant, docName, featureId);
      const status = getCoverageStatusForEntries(entries.map((entry) => ({ matchType: entry.MatchType })));
      if (status === 'explicit') {
        explicitFeatures.push(featureId);
      } else if (status === 'equivalent') {
        equivalentFeatures.push(featureId);
      } else {
        missingFeatures.push(featureId);
      }
    });

    const featureIdsForPenalty = [...new Set([...explicitFeatures, ...equivalentFeatures])];
    const penalty = getVerificationPenaltyForDoc(result, docName, featureIdsForPenalty);
    const score = (
      (explicitFeatures.length * 5)
      + (equivalentFeatures.length * 3)
      - (missingFeatures.length * 4)
      - (penalty.warningCount * 2)
      - penalty.cautionCount
    );

    const reasons = [];
    if (explicitFeatures.length > 0) reasons.push(`동일 대응 ${explicitFeatures.length}개`);
    if (equivalentFeatures.length > 0) reasons.push(`실질적 동일 ${equivalentFeatures.length}개`);
    if (missingFeatures.length > 0) reasons.push(`미충족 ${missingFeatures.length}개`);
    if (penalty.warningCount > 0) reasons.push(`경고 ${penalty.warningCount}개`);
    if (penalty.cautionCount > 0) reasons.push(`주의 ${penalty.cautionCount}개`);

    return {
      docName,
      score,
      matchedFeatures: [...explicitFeatures, ...equivalentFeatures],
      missingFeatures,
      explicitCount: explicitFeatures.length,
      equivalentCount: equivalentFeatures.length,
      warningCount: penalty.warningCount,
      cautionCount: penalty.cautionCount,
      shortReasons: reasons
    };
  });

  primaryCandidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.explicitCount !== a.explicitCount) return b.explicitCount - a.explicitCount;
    return String(a.docName || '').localeCompare(String(b.docName || ''), 'ko');
  });

  const topPrimaryCandidates = primaryCandidates.slice(0, 3);
  const selectedPrimaryDocName = (() => {
    const current = String(workspace.selection.primaryDocName || '').trim();
    if (current && docs.includes(current)) return current;
    return topPrimaryCandidates[0]?.docName || docs[0] || '';
  })();
  workspace.selection.primaryDocName = selectedPrimaryDocName;

  const selectedPrimaryCandidate = primaryCandidates.find((candidate) => candidate.docName === selectedPrimaryDocName) || null;
  const missingFeatureIds = Array.isArray(selectedPrimaryCandidate?.missingFeatures)
    ? selectedPrimaryCandidate.missingFeatures
    : [];

  const supportCandidatesByFeature = {};
  missingFeatureIds.forEach((featureId) => {
    const rows = buildSupportCandidateRowsForFeature(claimId, selectedPrimaryDocName, featureId, effectiveRelevant);
    if (rows.length > 0) {
      supportCandidatesByFeature[featureId] = rows.slice(0, 3);
    }
  });

  Object.entries(supportCandidatesByFeature).forEach(([featureId, rows]) => {
    const selected = String(workspace.selection.supportDocsByFeature?.[featureId] || '').trim();
    if (selected && rows.some((row) => row.docName === selected)) return;
    workspace.selection.supportDocsByFeature[featureId] = rows[0]?.docName || '';
  });

  workspace.docRoleRecommendation = {
    primaryCandidates: topPrimaryCandidates,
    supportCandidatesByFeature
  };

  return workspace.docRoleRecommendation;
}

function getDefaultCombinationTagsForCandidate(candidate) {
  if (!candidate) return [];
  if (String(candidate.matchType || '').toLowerCase() === 'explicit') {
    return ['functional_complement'];
  }
  if (String(candidate.matchType || '').toLowerCase() === 'equivalent') {
    return ['weak_link'];
  }
  return [];
}

function buildCombinationWorkspace(claimId) {
  const result = getClaimResultForWorkspace(claimId);
  const workspace = ensureClaimWorkspace(claimId);
  if (!result || !workspace) {
    return { primaryDocName: '', rows: [] };
  }

  const recommendation = buildDocRoleRecommendation(claimId);
  const effectiveRelevant = getEffectiveRelevantForClaim(claimId);
  const claimFeatures = Array.isArray(result.ClaimFeatures) ? result.ClaimFeatures : [];

  const primaryDocName = String(workspace.selection.primaryDocName || recommendation.primaryCandidates?.[0]?.docName || '').trim();
  workspace.selection.primaryDocName = primaryDocName;

  const nextSupportDocsByFeature = { ...workspace.selection.supportDocsByFeature };
  const nextTagsByFeature = { ...workspace.selection.combinationTagsByFeature };
  const nextNotesByFeature = { ...workspace.selection.combinationNotesByFeature };

  const rows = claimFeatures.map((feature) => {
    const featureId = String(feature?.Id || '').trim();
    const featureDescription = String(feature?.Description || '').trim();

    const primaryEntries = featureId && primaryDocName
      ? getEntriesForDocFeature(effectiveRelevant, primaryDocName, featureId)
      : [];

    const primaryStatus = getCoverageStatusForEntries(primaryEntries.map((entry) => ({ matchType: entry.MatchType })));
    const primaryEvidence = primaryEntries.map((entry) => ({
      evidenceId: normalizeEvidenceId(entry.EvidenceId),
      content: entry.Content,
      position: entry.Position,
      matchType: entry.MatchType
    }));

    let candidateDocs = [];
    if (primaryStatus === 'missing') {
      candidateDocs = recommendation.supportCandidatesByFeature?.[featureId]
        || buildSupportCandidateRowsForFeature(claimId, primaryDocName, featureId, effectiveRelevant);
    }

    const selectedCandidate = String(nextSupportDocsByFeature[featureId] || '').trim();
    let selectedSupportDoc = selectedCandidate;
    if (!selectedSupportDoc || !candidateDocs.some((candidate) => candidate.docName === selectedSupportDoc)) {
      selectedSupportDoc = candidateDocs[0]?.docName || '';
    }
    nextSupportDocsByFeature[featureId] = selectedSupportDoc;

    const pickedCandidate = candidateDocs.find((candidate) => candidate.docName === selectedSupportDoc) || null;

    let combinationTags = Array.isArray(nextTagsByFeature[featureId])
      ? nextTagsByFeature[featureId].map((tag) => String(tag || '').trim()).filter(Boolean)
      : [];
    if (combinationTags.length === 0) {
      combinationTags = getDefaultCombinationTagsForCandidate(pickedCandidate);
    }
    combinationTags = combinationTags.filter((tag) => WORKSPACE_COMBINATION_TAGS.includes(tag));
    nextTagsByFeature[featureId] = [...new Set(combinationTags)];

    const combinationNote = String(nextNotesByFeature[featureId] || '').trim();
    nextNotesByFeature[featureId] = combinationNote;

    return {
      featureId,
      featureDescription,
      primaryStatus,
      primaryEvidence,
      candidateDocs,
      selectedSupportDoc,
      combinationTags: nextTagsByFeature[featureId],
      combinationNote
    };
  });

  workspace.selection.supportDocsByFeature = nextSupportDocsByFeature;
  workspace.selection.combinationTagsByFeature = nextTagsByFeature;
  workspace.selection.combinationNotesByFeature = nextNotesByFeature;

  workspace.combinationWorkspace = {
    primaryDocName,
    rows
  };

  return workspace.combinationWorkspace;
}

function resolveNoticeDocLabelByName(docName) {
  const citation = typeof resolveCitationByDocName === 'function'
    ? resolveCitationByDocName(docName)
    : null;
  const title = String(citation?.title || '').trim();
  if (title) return title;
  return String(docName || '').trim();
}

function buildOpinionNoticeDocRefMap(primaryDocName, supportDocNames) {
  const map = new Map();
  if (primaryDocName) {
    map.set(primaryDocName, 1);
  }
  (supportDocNames || []).forEach((docName) => {
    const safeDocName = String(docName || '').trim();
    if (!safeDocName || map.has(safeDocName)) return;
    map.set(safeDocName, map.size + 1);
  });
  return map;
}

function toEvidenceSentenceText(entry, docName) {
  if (!entry) return '구성에 해당하는 내용';
  const content = String(entry.content || entry.Content || '').trim() || '구성에 해당하는 내용';
  const position = typeof transformPositionTextForDisplay === 'function'
    ? (transformPositionTextForDisplay(entry.position || entry.Position || '', docName, { includeMeta: true, metaOnly: true }) || 'pos')
    : (normalizePositionText(entry.position || entry.Position || '') || 'pos');
  return `${content}[위치(${position})]`;
}

function buildOpinionNoticeDraft(claimId) {
  const result = getClaimResultForWorkspace(claimId);
  const workspace = ensureClaimWorkspace(claimId);
  if (!result || !workspace) {
    return {
      claimId: normalizeWorkspaceClaimId(claimId),
      claimType: 'independent',
      primaryDocName: '',
      supportDocsByFeature: {},
      rows: [],
      sentenceLinks: {
        intro: [],
        comparison: [],
        difference: [],
        inventiveStep: [],
        conclusion: []
      },
      sections: {
        intro: '',
        comparison: '',
        difference: '',
        inventiveStep: '',
        conclusion: ''
      }
    };
  }
  const combinationWorkspace = buildCombinationWorkspace(claimId);
  const effectiveRelevant = getEffectiveRelevantForClaim(claimId);
  const primaryDocName = String(combinationWorkspace.primaryDocName || '').trim();
  const claimModel = (claims || []).find((item) => String(item?.id) === String(claimId));
  const claimType = String(claimModel?.type || '').trim().toLowerCase() === 'dependent'
    ? 'dependent'
    : 'independent';

  const supportDocNames = combinationWorkspace.rows
    .map((row) => String(row.selectedSupportDoc || '').trim())
    .filter((docName) => docName && docName !== primaryDocName);
  const uniqueSupportDocNames = [...new Set(supportDocNames)];

  const docRefMap = buildOpinionNoticeDocRefMap(primaryDocName, uniqueSupportDocNames);

  const rows = combinationWorkspace.rows.map((row, index) => {
    const featureId = String(row.featureId || '').trim();
    const primaryEntries = featureId && primaryDocName
      ? getEntriesForDocFeature(effectiveRelevant, primaryDocName, featureId)
      : [];
    const primaryEvidenceIds = primaryEntries
      .map((entry) => normalizeEvidenceId(entry.EvidenceId))
      .filter(Boolean);

    const remark = row.primaryStatus === 'explicit'
      ? '동일'
      : (row.primaryStatus === 'equivalent' ? '실질적 동일' : '차이');

    const supportDocName = String(row.selectedSupportDoc || '').trim();
    const supportEntries = supportDocName
      ? getEntriesForDocFeature(effectiveRelevant, supportDocName, featureId)
      : [];
    const supportEvidenceIds = supportEntries
      .map((entry) => normalizeEvidenceId(entry.EvidenceId))
      .filter(Boolean);

    return {
      index: index + 1,
      featureId,
      featureDescription: String(row.featureDescription || '').trim(),
      primaryEvidenceIds,
      remark,
      supportDocName,
      supportEvidenceIds,
      combinationTags: Array.isArray(row.combinationTags) ? row.combinationTags : []
    };
  });

  const introLineItems = [];
  if (primaryDocName) {
    introLineItems.push({
      text: `인용발명 1 : ${resolveNoticeDocLabelByName(primaryDocName)}`,
      evidenceId: '',
      featureId: '',
      docName: primaryDocName
    });
  }
  uniqueSupportDocNames.forEach((docName) => {
    const ref = docRefMap.get(docName);
    introLineItems.push({
      text: `인용발명 ${ref} : ${resolveNoticeDocLabelByName(docName)}`,
      evidenceId: '',
      featureId: '',
      docName
    });
  });
  const intro = introLineItems.map((item) => item.text).join('\n');

  const allEntries = getAllEvidenceEntriesForClaim(claimId);
  const comparisonLineItems = [];
  const differenceLineItems = [];
  const inventiveLineItems = [];

  rows.forEach((row) => {
    const featureNo = row.index;
    const leadPrimaryEntry = row.primaryEvidenceIds
      .map((evidenceId) => allEntries.find((entry) => entry.evidenceId === evidenceId))
      .filter(Boolean)[0] || null;
    const primaryEvidenceId = normalizeEvidenceId(leadPrimaryEntry?.evidenceId || '') || '';
    const primaryEvidenceText = leadPrimaryEntry
      ? toEvidenceSentenceText(leadPrimaryEntry, primaryDocName)
      : '구성에 해당하는 내용';

    if (row.remark === '동일') {
      comparisonLineItems.push({
        text: `구성 ${featureNo}은 인용발명 1의 ${primaryEvidenceText}에 의해 개시된다.`,
        evidenceId: primaryEvidenceId,
        featureId: row.featureId,
        docName: primaryDocName
      });
    } else if (row.remark === '실질적 동일') {
      comparisonLineItems.push({
        text: `구성 ${featureNo}은 표현은 상이하나, 인용발명 1의 ${primaryEvidenceText}와 실질적으로 동일한 기술적 의미를 가진다.`,
        evidenceId: primaryEvidenceId,
        featureId: row.featureId,
        docName: primaryDocName
      });
    } else {
      comparisonLineItems.push({
        text: `구성 ${featureNo}은 인용발명 1에 명시적으로 개시되어 있지 않다.`,
        evidenceId: '',
        featureId: row.featureId,
        docName: primaryDocName
      });
    }

    if (row.remark === '차이') {
      const supportRef = docRefMap.get(row.supportDocName);
      const supportEntry = row.supportEvidenceIds
        .map((evidenceId) => allEntries.find((entry) => entry.evidenceId === evidenceId))
        .filter(Boolean)[0] || null;
      const supportEvidenceId = normalizeEvidenceId(supportEntry?.evidenceId || '') || '';
      if (supportRef) {
        const supportEvidenceText = supportEntry
          ? toEvidenceSentenceText(supportEntry, row.supportDocName)
          : '구성에 해당하는 내용[위치(pos)]';
        differenceLineItems.push({
          text: `다만, 구성 ${featureNo}은 인용발명 ${supportRef}의 ${supportEvidenceText}에 의해 보완될 수 있다.`,
          evidenceId: supportEvidenceId,
          featureId: row.featureId,
          docName: row.supportDocName
        });
        inventiveLineItems.push({
          text: `구성 ${featureNo}의 보완은 ${row.combinationTags.join(', ') || 'functional_complement'} 관점에서 결합 동기가 인정될 수 있다.`,
          evidenceId: supportEvidenceId,
          featureId: row.featureId,
          docName: row.supportDocName
        });
      } else {
        differenceLineItems.push({
          text: `구성 ${featureNo}에 대한 보완 문헌은 추가 검토가 필요하다.`,
          evidenceId: '',
          featureId: row.featureId,
          docName: ''
        });
        inventiveLineItems.push({
          text: `구성 ${featureNo}은 결합 근거가 약하므로 추가 증거 확보가 요구된다.`,
          evidenceId: '',
          featureId: row.featureId,
          docName: ''
        });
      }
    }
  });

  const comparison = comparisonLineItems.map((item) => item.text).join('\n');
  const difference = differenceLineItems.map((item) => item.text).join('\n');
  const inventiveStep = inventiveLineItems.map((item) => item.text).join('\n');

  const firstSupportRef = uniqueSupportDocNames.length > 0
    ? docRefMap.get(uniqueSupportDocNames[0])
    : null;
  const conclusion = firstSupportRef
    ? `따라서 청구항 ${normalizeWorkspaceClaimId(claimId)}는 인용발명 1 및 인용발명 ${firstSupportRef}에 의하여 통상의 기술자가 용이하게 발명할 수 있다.`
    : `따라서 청구항 ${normalizeWorkspaceClaimId(claimId)}는 인용발명 1에 의해 통상의 기술자가 용이하게 발명할 수 있는지 추가 검토가 필요하다.`;
  const conclusionLineItems = [{
    text: conclusion,
    evidenceId: '',
    featureId: '',
    docName: ''
  }];

  const draft = {
    claimId: normalizeWorkspaceClaimId(claimId),
    claimType,
    primaryDocName,
    supportDocsByFeature: { ...workspace.selection.supportDocsByFeature },
    rows,
    sentenceLinks: {
      intro: introLineItems,
      comparison: comparisonLineItems,
      difference: differenceLineItems,
      inventiveStep: inventiveLineItems,
      conclusion: conclusionLineItems
    },
    sections: {
      intro,
      comparison,
      difference,
      inventiveStep,
      conclusion
    }
  };

  workspace.opinionNoticeDraft = draft;
  return draft;
}

function recomputeClaimWorkspace(claimId, options = {}) {
  const result = getClaimResultForWorkspace(claimId);
  const workspace = ensureClaimWorkspace(claimId);
  if (!result || !workspace) return null;

  const idChanged = allocateMissingEvidenceIds(claimId);
  buildDocRoleRecommendation(claimId);
  buildCombinationWorkspace(claimId);
  buildOpinionNoticeDraft(claimId);

  workspace.lastUpdatedAt = new Date().toISOString();

  if ((options.persist !== false || idChanged) && typeof saveAnalysisResultsToStorage === 'function') {
    saveAnalysisResultsToStorage();
  }

  return workspace;
}

function escapeWorkspaceHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getWorkspaceClaimIdFromUi(target) {
  const fromDataset = normalizeWorkspaceClaimId(target?.dataset?.claimId);
  if (fromDataset !== null) return fromDataset;
  const fromNoticeSelect = normalizeWorkspaceClaimId(document.getElementById('notice-claim-select')?.value || '');
  if (fromNoticeSelect !== null) return fromNoticeSelect;
  const fromSelected = normalizeWorkspaceClaimId(selectedResultClaimId);
  if (fromSelected !== null) return fromSelected;
  const fromDockSelect = normalizeWorkspaceClaimId(document.getElementById('dock-claim-select')?.value || '');
  if (fromDockSelect !== null) return fromDockSelect;
  const fromSelect = normalizeWorkspaceClaimId(document.getElementById('result-claim-select')?.value || '');
  return fromSelect;
}

function ensureDecisionWorkspaceLayout() {
  const resultArea = document.getElementById('result-area');
  if (!resultArea) return null;

  let root = document.getElementById('decision-workspace-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'decision-workspace-root';
    root.className = 'decision-workspace-root hidden';
    root.innerHTML = `
      <div class="decision-workspace-toolbar">
        <div class="decision-toolbar-left">
          <div class="decision-workspace-eyebrow">분석 결과 보조 도구</div>
          <div class="result-workspace-action-row">
            <button type="button" class="decision-workspace-view-btn decision-workspace-cta-btn active" data-ws-action="open-evidence-review-modal">
              증거 리뷰
            </button>
          </div>
        </div>
        <div class="decision-toolbar-right">
          <div id="decision-workspace-meta" class="decision-workspace-meta"></div>
        </div>
      </div>
    `;

    const summaryBox = document.getElementById('claim-summary-box');
    if (summaryBox && summaryBox.parentElement === resultArea) {
      resultArea.insertBefore(root, summaryBox);
    } else {
      resultArea.prepend(root);
    }
  }

  return root;
}

function ensureWorkspaceModalLayouts() {
  let evidenceModal = document.getElementById('workspace-evidence-review-modal');
  if (!evidenceModal) {
    evidenceModal = document.createElement('div');
    evidenceModal.id = 'workspace-evidence-review-modal';
    evidenceModal.className = 'modal-overlay hidden workspace-modal';
    evidenceModal.setAttribute('role', 'dialog');
    evidenceModal.setAttribute('aria-modal', 'true');
    evidenceModal.setAttribute('aria-hidden', 'true');
    evidenceModal.setAttribute('aria-labelledby', 'workspace-evidence-modal-title');
    evidenceModal.innerHTML = `
      <div class="modal-content workspace-modal-content workspace-modal-evidence">
        <div class="modal-header">
          <h3 id="workspace-evidence-modal-title">증거 리뷰</h3>
          <button type="button" class="btn-icon" data-ws-action="close-workspace-modal" data-modal-id="workspace-evidence-review-modal" title="닫기">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <div class="modal-body workspace-modal-body">
          <p class="workspace-modal-intro">경고/오류, C단계 폐기, 확정 증거를 통합 검토하고 활용 여부를 조정합니다.</p>
          <div class="evidence-review-toolbar">
            <div class="evidence-review-toolbar-left">
              <div id="evidence-review-filters" class="evidence-review-filters"></div>
            </div>
            <div class="evidence-review-toolbar-right">
              <div id="evidence-review-group-toggle" class="evidence-review-group-toggle" role="group" aria-label="증거 리뷰 그룹 기준"></div>
              <div id="evidence-review-summary" class="evidence-review-summary"></div>
            </div>
          </div>
          <section id="evidence-inline-position-viewer" class="evidence-inline-position-viewer hidden" aria-live="polite">
            <div class="evidence-inline-position-head">
              <strong id="evidence-inline-position-title">원문 미리보기</strong>
              <button type="button" class="btn-secondary-sm" data-ws-action="review-close-inline-position">닫기</button>
            </div>
            <div id="evidence-inline-position-meta" class="evidence-inline-position-meta"></div>
            <div class="evidence-inline-position-body">
              <section class="evidence-inline-position-section">
                <h5>요약</h5>
                <pre id="evidence-inline-position-summary"></pre>
              </section>
              <section class="evidence-inline-position-section">
                <h5>원문</h5>
                <pre id="evidence-inline-position-source"></pre>
              </section>
            </div>
          </section>
          <div id="evidence-review-list" class="evidence-review-list"></div>
        </div>
      </div>
    `;
    document.body.appendChild(evidenceModal);
  }

  let combinationModal = document.getElementById('workspace-combination-modal');
  if (!combinationModal) {
    combinationModal = document.createElement('div');
    combinationModal.id = 'workspace-combination-modal';
    combinationModal.className = 'modal-overlay hidden workspace-modal';
    combinationModal.setAttribute('role', 'dialog');
    combinationModal.setAttribute('aria-modal', 'true');
    combinationModal.setAttribute('aria-hidden', 'true');
    combinationModal.setAttribute('aria-labelledby', 'workspace-combination-modal-title');
    combinationModal.innerHTML = `
      <div class="modal-content workspace-modal-content workspace-modal-combination">
        <div class="modal-header">
          <h3 id="workspace-combination-modal-title">인용발명 조합 선택</h3>
          <button type="button" class="btn-icon" data-ws-action="close-workspace-modal" data-modal-id="workspace-combination-modal" title="닫기">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <div class="modal-body workspace-modal-body">
          <section class="decision-workspace-panel">
            <div class="decision-workspace-head">
              <div>
                <h4>인용발명 조합 선택</h4>
                <p class="decision-workspace-head-note">주인용/부인용 문헌을 선택하고 누락 구성을 조합 논리로 보완합니다.</p>
              </div>
            </div>
            <div class="decision-recommend-grid">
              <section class="decision-recommend-block">
                <div class="decision-subhead">주인용발명 추천</div>
                <div id="doc-role-primary-list" class="doc-role-primary-list"></div>
              </section>
              <section class="decision-recommend-block">
                <div class="decision-subhead">부인용발명 추천 조합</div>
                <div id="doc-role-support-list" class="doc-role-support-list"></div>
              </section>
            </div>
            <section class="decision-recommend-block decision-combination-block">
              <div class="decision-subhead">누락 구성 조합 워크스페이스</div>
              <div id="combination-workspace-rows"></div>
            </section>
          </section>
        </div>
      </div>
    `;
    document.body.appendChild(combinationModal);
  }

  let llmModal = document.getElementById('workspace-llmcheck-modal');
  if (!llmModal) {
    llmModal = document.createElement('div');
    llmModal.id = 'workspace-llmcheck-modal';
    llmModal.className = 'modal-overlay hidden workspace-modal';
    llmModal.setAttribute('role', 'dialog');
    llmModal.setAttribute('aria-modal', 'true');
    llmModal.setAttribute('aria-hidden', 'true');
    llmModal.setAttribute('aria-labelledby', 'workspace-llmcheck-modal-title');
    llmModal.innerHTML = `
      <div class="modal-content workspace-modal-content workspace-modal-llmcheck">
        <div class="modal-header">
          <h3 id="workspace-llmcheck-modal-title">진보성 검토</h3>
          <button type="button" class="btn-icon" data-ws-action="close-workspace-modal" data-modal-id="workspace-llmcheck-modal" title="닫기">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <div class="modal-body workspace-modal-body">
          <section class="decision-workspace-panel">
            <div class="decision-workspace-head">
              <div>
                <h4>인용발명 조합 기반 진보성 검토</h4>
                <p class="decision-workspace-head-note">의견제출통지서 최종본(표/문구)과 인용발명 원문을 함께 검토합니다.</p>
              </div>
            </div>
            <div class="llm-check-input-wrap">
              <label for="llm-check-prompt" class="llm-check-label">프롬프트</label>
              <textarea id="llm-check-prompt" rows="8" data-ws-action="llmcheck-prompt"></textarea>
              <div class="llm-check-actions">
                <button type="button" id="btn-run-llm-check" class="btn-secondary-sm" data-ws-action="run-llm-check">다시 검토</button>
              </div>
              <div id="llm-check-status" class="llm-check-status">대기 중</div>
            </div>
            <div class="llm-check-output">
              <div class="llm-check-output-card">
                <strong>점수</strong>
                <div id="llm-check-score">-</div>
              </div>
              <div class="llm-check-output-card">
                <strong>이유</strong>
                <div id="llm-check-reason">실행 후 표시됩니다.</div>
              </div>
            </div>
          </section>
        </div>
      </div>
    `;
    document.body.appendChild(llmModal);
  }
}

function openWorkspaceModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  if (typeof openDialogModal === 'function') {
    openDialogModal(modalId, `[data-ws-action="close-workspace-modal"][data-modal-id="${modalId}"]`);
    return;
  }
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function closeWorkspaceModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  if (modalId === 'workspace-evidence-review-modal') {
    closeEvidenceInlinePositionViewer();
  }
  if (typeof closeDialogModal === 'function') {
    closeDialogModal(modalId);
    return;
  }
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

function closeActiveWorkspaceModal() {
  const activeModal = document.querySelector('.workspace-modal:not(.hidden)');
  if (!activeModal || !activeModal.id) return false;
  closeWorkspaceModal(activeModal.id);
  return true;
}

function getWorkspacePrimaryStatusLabel(primaryStatus) {
  const normalized = String(primaryStatus || '').trim().toLowerCase();
  if (normalized === 'explicit') return '동일';
  if (normalized === 'equivalent') return '실질적 동일';
  return '차이';
}

function getWorkspaceMatchTypeLabel(matchType) {
  const normalized = String(matchType || '').trim().toLowerCase();
  if (!normalized) return '-';
  if (normalized === 'explicit' || normalized === 'identical' || normalized === '동일') return '동일';
  if (
    normalized === 'equivalent'
    || normalized === 'substantially equivalent'
    || normalized.replace(/\s+/g, '') === '실질적동일'
  ) {
    return '실질적 동일';
  }
  return String(matchType || '').trim();
}

function getWorkspaceVerificationLabel(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (!normalized) return '-';
  if (normalized === 'warning') return '경고';
  if (normalized === 'error' || normalized === 'fail') return '오류';
  if (normalized === 'caution') return '주의';
  if (normalized === 'pass') return '통과';
  return String(status || '').trim();
}

function formatWorkspaceEvidenceLine(evidence, docName) {
  if (!evidence || typeof evidence !== 'object') return '-';
  const content = String(evidence.content || evidence.Content || '').trim() || '-';
  const rawPosition = String(evidence.position || evidence.Position || '').trim();
  const position = typeof transformPositionTextForDisplay === 'function'
    ? (transformPositionTextForDisplay(rawPosition, docName, { includeMeta: true, metaOnly: true }) || '-')
    : (normalizePositionText(rawPosition) || '-');
  return `${content} (${position})`;
}

function renderCombinationSummaryTop(claimId, workspace) {
  const container = document.getElementById('combination-summary-top');
  if (!container) return;
  const rows = Array.isArray(workspace?.combinationWorkspace?.rows)
    ? workspace.combinationWorkspace.rows
    : [];
  const primaryDocName = String(workspace?.selection?.primaryDocName || workspace?.combinationWorkspace?.primaryDocName || '').trim();
  if (rows.length === 0) {
    container.innerHTML = '<div class="workspace-empty">구성대비표를 표시할 데이터가 없습니다.</div>';
    return;
  }

  container.innerHTML = `
    <div class="combination-summary-head">
      <span>주인용발명 1: <strong>${escapeWorkspaceHtml(primaryDocName || '-')}</strong></span>
    </div>
    <table class="combination-summary-table">
      <thead>
        <tr>
          <th>번호</th>
          <th>구성</th>
          <th>인용발명 1</th>
          <th>비고</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row, index) => {
          const leadEvidence = Array.isArray(row.primaryEvidence) ? row.primaryEvidence[0] : null;
          const evidenceText = leadEvidence ? formatWorkspaceEvidenceLine(leadEvidence, primaryDocName) : '-';
          const remark = getWorkspacePrimaryStatusLabel(row.primaryStatus);
          return `
            <tr>
              <td>${index + 1}</td>
              <td>${escapeWorkspaceHtml(row.featureDescription || row.featureId || '-')}</td>
              <td>${escapeWorkspaceHtml(evidenceText)}</td>
              <td>${escapeWorkspaceHtml(remark)}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function renderDocRoleRecommendationPanel(claimId, workspace, claimFeatures) {
  const primaryList = document.getElementById('doc-role-primary-list');
  const supportList = document.getElementById('doc-role-support-list');
  if (!primaryList || !supportList) return;

  const primaryCandidates = Array.isArray(workspace?.docRoleRecommendation?.primaryCandidates)
    ? workspace.docRoleRecommendation.primaryCandidates
    : [];

  if (primaryCandidates.length === 0) {
    primaryList.innerHTML = '<div class="workspace-empty">주인용발명 후보가 없습니다.</div>';
  } else {
    primaryList.innerHTML = primaryCandidates.map((candidate) => {
      const docName = String(candidate.docName || '').trim();
      const isSelected = docName && docName === String(workspace.selection.primaryDocName || '').trim();
      return `
        <article class="doc-role-card ${isSelected ? 'is-selected' : ''}">
          <div class="doc-role-card-head">
            <strong>${escapeWorkspaceHtml(docName || '-')}</strong>
            <span class="doc-role-score">점수 ${Number(candidate.score || 0).toFixed(1)}</span>
          </div>
          <div class="doc-role-metrics">
            <span>매칭 구성: ${escapeWorkspaceHtml((candidate.matchedFeatures || []).join(', ') || '-')}</span>
            <span>누락 구성: ${escapeWorkspaceHtml((candidate.missingFeatures || []).join(', ') || '-')}</span>
            <span>동일 ${Number(candidate.explicitCount || 0)} / 실질적 동일 ${Number(candidate.equivalentCount || 0)}</span>
            <span>경고 ${Number(candidate.warningCount || 0)} / 주의 ${Number(candidate.cautionCount || 0)}</span>
          </div>
          <div class="doc-role-reasons">${escapeWorkspaceHtml((candidate.shortReasons || []).join(' · ') || '-')}</div>
          <div class="doc-role-actions">
            <button type="button" class="btn-secondary-sm" data-ws-action="confirm-primary" data-claim-id="${claimId}" data-doc-name="${escapeWorkspaceHtml(docName)}">주인용발명 확정</button>
          </div>
        </article>
      `;
    }).join('');
  }

  const supportCandidatesByFeature = workspace?.docRoleRecommendation?.supportCandidatesByFeature || {};
  const featureDescriptionMap = new Map((claimFeatures || []).map((feature) => [String(feature?.Id || ''), String(feature?.Description || '')]));
  const featureIds = Object.keys(supportCandidatesByFeature);

  if (featureIds.length === 0) {
    supportList.innerHTML = '<div class="workspace-empty">누락 구성에 대한 보조 문헌 후보가 없습니다.</div>';
    return;
  }

  supportList.innerHTML = featureIds.map((featureId) => {
    const candidates = Array.isArray(supportCandidatesByFeature[featureId]) ? supportCandidatesByFeature[featureId] : [];
    const selectedDocName = String(workspace.selection.supportDocsByFeature?.[featureId] || '').trim();
    return `
      <section class="support-feature-block">
        <h5>${escapeWorkspaceHtml(featureId)} · ${escapeWorkspaceHtml(featureDescriptionMap.get(featureId) || '')}</h5>
        <div class="support-feature-candidates">
          ${candidates.map((candidate) => {
            const docName = String(candidate.docName || '').trim();
            const selectedClass = docName === selectedDocName ? 'is-selected' : '';
            return `
              <div class="support-candidate ${selectedClass}">
                <div>
                  <strong>${escapeWorkspaceHtml(docName || '-')}</strong>
                  <span class="support-candidate-meta">${escapeWorkspaceHtml(getWorkspaceMatchTypeLabel(candidate.matchType || ''))} · 점수 ${Number(candidate.score || 0).toFixed(2)}</span>
                  <span class="support-candidate-meta">${escapeWorkspaceHtml((candidate.riskFlags || []).join(', ') || '리스크 없음')}</span>
                </div>
                <button type="button" class="btn-secondary-sm" data-ws-action="select-support-candidate" data-claim-id="${claimId}" data-feature-id="${escapeWorkspaceHtml(featureId)}" data-doc-name="${escapeWorkspaceHtml(docName)}">선택</button>
              </div>
            `;
          }).join('')}
        </div>
      </section>
    `;
  }).join('');
}

function renderCombinationWorkspacePanel(claimId, workspace) {
  const container = document.getElementById('combination-workspace-rows');
  if (!container) return;

  const allRows = Array.isArray(workspace?.combinationWorkspace?.rows)
    ? workspace.combinationWorkspace.rows
    : [];
  const rows = allRows.filter((row) => String(row?.primaryStatus || '').trim().toLowerCase() === 'missing');

  if (rows.length === 0) {
    container.innerHTML = '<div class="workspace-empty">누락된 구성이 없습니다.</div>';
    return;
  }

  container.innerHTML = `
    <table class="combination-workspace-table">
      <thead>
        <tr>
          <th>구성</th>
          <th>청구항 구성요소</th>
          <th>주인용발명 상태</th>
          <th>주인용발명 근거</th>
          <th>보조 문헌</th>
          <th>조합 태그</th>
          <th>메모</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => {
          const featureId = String(row.featureId || '').trim();
          const candidateDocs = Array.isArray(row.candidateDocs) ? row.candidateDocs : [];
          const selectedSupportDoc = String(row.selectedSupportDoc || '').trim();
          const tags = Array.isArray(row.combinationTags) ? row.combinationTags : [];
          const evidenceText = Array.isArray(row.primaryEvidence) && row.primaryEvidence.length > 0
            ? row.primaryEvidence.map((evidence) => `${escapeWorkspaceHtml(evidence.content || '-')} (${escapeWorkspaceHtml(evidence.position || '-')})`).join('<br>')
            : '-';

          return `
            <tr>
              <td>${escapeWorkspaceHtml(featureId)}</td>
              <td>${escapeWorkspaceHtml(row.featureDescription || '-')}</td>
              <td><span class="status-chip is-${escapeWorkspaceHtml(row.primaryStatus || 'missing')}">${escapeWorkspaceHtml(getWorkspacePrimaryStatusLabel(row.primaryStatus || 'missing'))}</span></td>
              <td>${evidenceText}</td>
              <td>
                <select data-ws-action="support-select" data-claim-id="${claimId}" data-feature-id="${escapeWorkspaceHtml(featureId)}">
                  <option value="">(선택 없음)</option>
                  ${candidateDocs.map((candidate) => {
                    const docName = String(candidate.docName || '').trim();
                    const selectedAttr = docName === selectedSupportDoc ? 'selected' : '';
                    return `<option value="${escapeWorkspaceHtml(docName)}" ${selectedAttr}>${escapeWorkspaceHtml(docName)} · ${escapeWorkspaceHtml(getWorkspaceMatchTypeLabel(candidate.matchType || ''))} · ${Number(candidate.score || 0).toFixed(2)}</option>`;
                  }).join('')}
                </select>
              </td>
              <td>
                <div class="combination-tag-list">
                  ${WORKSPACE_COMBINATION_TAGS.map((tag) => {
                    const checked = tags.includes(tag) ? 'checked' : '';
                    return `
                      <label>
                        <input type="checkbox" data-ws-action="tag-toggle" data-claim-id="${claimId}" data-feature-id="${escapeWorkspaceHtml(featureId)}" data-tag="${escapeWorkspaceHtml(tag)}" ${checked}>
                        ${escapeWorkspaceHtml(tag)}
                      </label>
                    `;
                  }).join('')}
                </div>
              </td>
              <td>
                <textarea rows="2" data-ws-action="combination-note" data-claim-id="${claimId}" data-feature-id="${escapeWorkspaceHtml(featureId)}">${escapeWorkspaceHtml(row.combinationNote || '')}</textarea>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function matchesEvidenceFilter(entry, filterId) {
  const filter = normalizeWorkspaceFilter(filterId);
  const sourceStage = String(entry?.sourceStage || '').trim();
  const matchClass = String(entry?.matchClass || '').trim().toLowerCase();
  const verificationStatus = String(entry?.verificationStatus || '').trim();
  const decision = getEffectiveEvidenceDecision(entry);
  const reviewCandidate = isVerificationAlertStatus(verificationStatus)
    || sourceStage === 'stepC_discarded'
    || matchClass === 'equivalent';

  const confirmedCandidate = isConfirmedEvidenceCandidate(entry);

  if (filter === 'review_queue') {
    return decision === 'system' && reviewCandidate;
  }
  if (filter === 'accepted') {
    return decision === 'accept';
  }
  if (filter === 'confirmed') {
    return confirmedCandidate;
  }
  if (filter === 'all') return true;
  return true;
}

function isConfirmedEvidenceCandidate(entry) {
  const sourceStage = String(entry?.sourceStage || '').trim();
  const matchClass = String(entry?.matchClass || '').trim().toLowerCase();
  const verificationStatus = String(entry?.verificationStatus || '').trim();
  return sourceStage === 'final'
    && !isVerificationAlertStatus(verificationStatus)
    && matchClass !== 'equivalent';
}

function getEffectiveEvidenceDecision(entry) {
  const decision = normalizeWorkspaceDecision(entry?.decision);
  if (decision === 'system' && isConfirmedEvidenceCandidate(entry)) {
    return 'accept';
  }
  return decision;
}

function getEvidenceCardDecisionState(entry) {
  const decision = getEffectiveEvidenceDecision(entry);
  if (decision === 'accept') return 'accept';
  if (decision === 'hold') return 'hold';
  if (decision === 'reject') return 'reject';
  return 'unreviewed';
}

function getReviewQueueCategory(entry) {
  if (isVerificationAlertStatus(entry?.verificationStatus)) return 'warning';
  if (String(entry?.sourceStage || '').trim() === 'stepC_discarded') return 'discarded';
  if (String(entry?.matchClass || '').trim().toLowerCase() === 'equivalent') return 'equivalent';
  return 'other';
}

function getReviewQueueCategoryOrder(entry) {
  const category = getReviewQueueCategory(entry);
  if (category === 'warning') return 1;
  if (category === 'discarded') return 2;
  if (category === 'equivalent') return 3;
  return 9;
}

function sortReviewQueueEntries(entries) {
  return [...entries].sort((a, b) => {
    const aOrder = getReviewQueueCategoryOrder(a);
    const bOrder = getReviewQueueCategoryOrder(b);
    if (aOrder !== bOrder) return aOrder - bOrder;
    return compareEvidenceEntries(a, b);
  });
}

function getEvidenceGroupLabel(entry, groupBy) {
  if (groupBy === 'doc') {
    return String(entry?.docName || '').trim() || '(문헌 없음)';
  }
  const featureId = String(entry?.featureId || '').trim() || '-';
  const featureDescription = String(entry?.featureDescription || '').trim();
  return featureDescription ? `${featureId} · ${featureDescription}` : featureId;
}

function buildEvidenceReasonTags(entry) {
  const tags = [];
  const sourceStage = String(entry?.sourceStage || '').trim();
  const verificationStatus = String(entry?.verificationStatus || '').trim().toLowerCase();
  const matchClass = String(entry?.matchClass || '').trim().toLowerCase();

  if (sourceStage === 'stepC_discarded') {
    tags.push({ key: 'discarded', label: 'C단계 제외' });
  }

  if (verificationStatus === 'caution') {
    tags.push({ key: 'caution', label: '주의' });
  } else if (verificationStatus === 'warning' || verificationStatus === 'error' || verificationStatus === 'fail') {
    tags.push({ key: 'warning', label: '경고' });
  }

  if (matchClass === 'equivalent') {
    tags.push({ key: 'equivalent', label: '실질적 동일' });
  }

  return tags;
}

function getEvidenceContextWindowState(workspace, evidenceId) {
  const safeEvidenceId = normalizeEvidenceId(evidenceId);
  if (!workspace || !safeEvidenceId) return { prev: 0, next: 0 };
  const raw = workspace?.manualReview?.contextWindowByEvidenceId?.[safeEvidenceId];
  return {
    prev: Math.max(0, Number.parseInt(raw?.prev, 10) || 0),
    next: Math.max(0, Number.parseInt(raw?.next, 10) || 0)
  };
}

function updateEvidenceContextWindowState(workspace, evidenceId, direction) {
  const safeEvidenceId = normalizeEvidenceId(evidenceId);
  if (!workspace || !safeEvidenceId) return false;
  if (!workspace.manualReview || typeof workspace.manualReview !== 'object') {
    workspace.manualReview = {};
  }
  if (!workspace.manualReview.contextWindowByEvidenceId
      || typeof workspace.manualReview.contextWindowByEvidenceId !== 'object'
      || Array.isArray(workspace.manualReview.contextWindowByEvidenceId)) {
    workspace.manualReview.contextWindowByEvidenceId = {};
  }
  const current = getEvidenceContextWindowState(workspace, safeEvidenceId);
  const nextState = { ...current };
  if (direction === 'prev') {
    nextState.prev = Math.min(current.prev + 1, 50);
  } else if (direction === 'next') {
    nextState.next = Math.min(current.next + 1, 50);
  } else {
    return false;
  }
  workspace.manualReview.contextWindowByEvidenceId[safeEvidenceId] = nextState;
  return true;
}

function isEvidenceCardExpanded(workspace, evidenceId) {
  const safeEvidenceId = normalizeEvidenceId(evidenceId);
  if (!workspace || !safeEvidenceId) return false;
  return !!workspace?.manualReview?.expandedEvidenceIds?.[safeEvidenceId];
}

function toggleEvidenceCardExpandedState(workspace, evidenceId) {
  const safeEvidenceId = normalizeEvidenceId(evidenceId);
  if (!workspace || !safeEvidenceId) return false;

  if (!workspace.manualReview || typeof workspace.manualReview !== 'object') {
    workspace.manualReview = {};
  }
  if (!workspace.manualReview.expandedEvidenceIds
      || typeof workspace.manualReview.expandedEvidenceIds !== 'object'
      || Array.isArray(workspace.manualReview.expandedEvidenceIds)) {
    workspace.manualReview.expandedEvidenceIds = {};
  }

  workspace.manualReview.expandedEvidenceIds = normalizeWorkspaceEvidenceExpandedMap(
    workspace.manualReview.expandedEvidenceIds
  );
  const expandedMap = workspace.manualReview.expandedEvidenceIds;
  const currentExpandedId = Object.keys(expandedMap).find((key) => !!expandedMap[key]) || '';
  if (currentExpandedId && currentExpandedId === safeEvidenceId) {
    workspace.manualReview.expandedEvidenceIds = {};
    return true;
  }

  workspace.manualReview.expandedEvidenceIds = {
    [safeEvidenceId]: true
  };
  return true;
}

function getEvidencePositionLabel(entry) {
  const rawPosition = String(entry?.position || '').trim();
  if (!rawPosition) return '-';
  if (typeof parseParagraphKeyRange === 'function') {
    const rangeInfo = parseParagraphKeyRange(rawPosition);
    if (rangeInfo?.label) return String(rangeInfo.label).trim();
  }
  if (typeof normalizePositionText === 'function') {
    const normalized = normalizePositionText(rawPosition);
    if (normalized) return normalized;
  }
  return rawPosition;
}

function createEvidenceSourceBlock({ key, text, meta = '' }) {
  return {
    key: String(key || '-').trim() || '-',
    meta: String(meta || '').trim(),
    text: String(text || '').trim() || '-'
  };
}

function buildEvidenceFallbackSourceContext(entry, positionLabel) {
  const primaryText = String(entry?.sourceExcerpt || '').trim()
    || String(entry?.content || '').trim()
    || '원문을 찾을 수 없습니다.';
  return {
    positionLabel: String(positionLabel || '-').trim() || '-',
    blocks: [createEvidenceSourceBlock({ key: positionLabel || '-', text: primaryText })],
    canExpandPrev: false,
    canExpandNext: false,
    expandable: false
  };
}

function buildEvidenceNumericSourceContext(paragraphs, anchorNumber, windowState, positionLabel, fallbackExcerpt = '') {
  if (!paragraphs || typeof paragraphs !== 'object') return null;

  const numberMap = new Map();
  Object.entries(paragraphs).forEach(([rawKey, rawText]) => {
    const number = typeof parseParagraphNumberFromKey === 'function'
      ? parseParagraphNumberFromKey(rawKey)
      : null;
    if (!Number.isFinite(number)) return;
    const text = String(rawText || '').trim();
    if (!text) return;
    if (numberMap.has(number)) return;
    const key = typeof formatParagraphNumberKey === 'function'
      ? (formatParagraphNumberKey(number) || String(rawKey || '').trim() || `[${number}]`)
      : (String(rawKey || '').trim() || `[${number}]`);
    numberMap.set(number, { number, key, text });
  });

  const ordered = Array.from(numberMap.values()).sort((a, b) => a.number - b.number);
  if (ordered.length === 0) return null;

  let anchorIndex = ordered.findIndex((item) => item.number === anchorNumber);
  if (anchorIndex < 0) {
    anchorIndex = ordered.findIndex((item) => item.number > anchorNumber);
    if (anchorIndex < 0) anchorIndex = ordered.length - 1;
  }

  const prevCount = Math.max(0, Number.parseInt(windowState?.prev, 10) || 0);
  const nextCount = Math.max(0, Number.parseInt(windowState?.next, 10) || 0);
  const startIndex = Math.max(0, anchorIndex - prevCount);
  const endIndex = Math.min(ordered.length - 1, anchorIndex + nextCount);
  const visible = ordered.slice(startIndex, endIndex + 1);

  const blocks = visible.map((item, index) => {
    const isAnchor = index === anchorIndex - startIndex;
    const text = isAnchor && String(fallbackExcerpt || '').trim()
      ? String(fallbackExcerpt).trim()
      : item.text;
    return createEvidenceSourceBlock({
      key: item.key,
      text
    });
  });

  return {
    positionLabel: positionLabel || visible[anchorIndex - startIndex]?.key || '-',
    blocks,
    canExpandPrev: startIndex > 0,
    canExpandNext: endIndex < ordered.length - 1,
    expandable: true
  };
}

function buildEvidenceSentinelSourceContext(payload, anchorSentinel, windowState, positionLabel, fallbackExcerpt = '') {
  if (typeof parseCitationSentinelMap !== 'function') return null;
  const sentinelMap = parseCitationSentinelMap(payload);
  if (!sentinelMap || typeof sentinelMap !== 'object') return null;

  const ordered = Object.entries(sentinelMap)
    .map(([rawId, rawEntry]) => {
      const number = Number.parseInt(rawId, 10);
      if (!Number.isFinite(number)) return null;
      const entry = rawEntry && typeof rawEntry === 'object' ? rawEntry : {};
      const sourceText = typeof getSentinelEntrySourceText === 'function'
        ? getSentinelEntrySourceText(payload, entry)
        : '';
      const text = (typeof stripSentinelTokens === 'function' ? stripSentinelTokens(sourceText) : sourceText).trim();
      const key = String(entry.displayKey || entry.sourceKey || (
        typeof formatSentinelOpenToken === 'function'
          ? formatSentinelOpenToken(number)
          : `S${String(number).padStart(4, '0')}`
      )).trim();
      const meta = typeof buildSentinelMetaLine === 'function' ? buildSentinelMetaLine(entry) : '';
      return { number, key, text, meta };
    })
    .filter(Boolean)
    .sort((a, b) => a.number - b.number);
  if (ordered.length === 0) return null;

  let anchorIndex = ordered.findIndex((item) => item.number === anchorSentinel);
  if (anchorIndex < 0) {
    anchorIndex = ordered.findIndex((item) => item.number > anchorSentinel);
    if (anchorIndex < 0) anchorIndex = ordered.length - 1;
  }

  const prevCount = Math.max(0, Number.parseInt(windowState?.prev, 10) || 0);
  const nextCount = Math.max(0, Number.parseInt(windowState?.next, 10) || 0);
  const startIndex = Math.max(0, anchorIndex - prevCount);
  const endIndex = Math.min(ordered.length - 1, anchorIndex + nextCount);
  const visible = ordered.slice(startIndex, endIndex + 1);

  const blocks = visible.map((item, index) => {
    const isAnchor = index === anchorIndex - startIndex;
    const fallbackText = isAnchor ? fallbackExcerpt : '';
    return createEvidenceSourceBlock({
      key: item.key,
      meta: item.meta,
      text: fallbackText || item.text || '해당 센티넬의 원문을 찾지 못했습니다.'
    });
  });

  const anchorBlock = visible[anchorIndex - startIndex] || null;
  const normalizedPositionLabel = String(positionLabel || '').trim();
  const keepOriginalLabel = /^\[\d{1,6}\](?:\s*-\s*\[\d{1,6}\])?$/.test(normalizedPositionLabel)
    || /^청구항\s*\d+/i.test(normalizedPositionLabel);
  const resolvedPositionLabel = keepOriginalLabel
    ? normalizedPositionLabel
    : String(anchorBlock?.key || normalizedPositionLabel || '-').trim();

  return {
    positionLabel: resolvedPositionLabel || '-',
    blocks,
    canExpandPrev: startIndex > 0,
    canExpandNext: endIndex < ordered.length - 1,
    expandable: true
  };
}

function buildEvidenceSourceContext(claimId, entry) {
  const positionLabel = getEvidencePositionLabel(entry);
  const workspace = ensureClaimWorkspace(claimId);
  const contextWindow = getEvidenceContextWindowState(workspace, entry?.evidenceId);
  const rawPosition = String(entry?.position || '').trim();
  const rangeInfo = typeof parseParagraphKeyRange === 'function'
    ? parseParagraphKeyRange(rawPosition)
    : null;

  if (typeof findCitationByDocName !== 'function' || typeof parseCitationPayloadForPositionModal !== 'function') {
    return buildEvidenceFallbackSourceContext(entry, positionLabel);
  }
  const citation = findCitationByDocName(entry?.docName || '');
  if (!citation) {
    return buildEvidenceFallbackSourceContext(entry, positionLabel);
  }
  const payload = parseCitationPayloadForPositionModal(citation);
  if (!payload || typeof payload !== 'object') {
    return buildEvidenceFallbackSourceContext(entry, positionLabel);
  }

  if (rangeInfo?.kind === 'numeric' && typeof parseCitationParagraphs === 'function') {
    const paragraphs = parseCitationParagraphs(payload);
    const numericContext = buildEvidenceNumericSourceContext(
      paragraphs,
      Number(rangeInfo.start),
      contextWindow,
      positionLabel,
      entry?.sourceExcerpt || ''
    );
    if (numericContext) return numericContext;
  }

  if (rangeInfo?.kind === 'sentinel') {
    const sentinelContext = buildEvidenceSentinelSourceContext(
      payload,
      Number(rangeInfo.startSentinel),
      contextWindow,
      positionLabel,
      entry?.sourceExcerpt || ''
    );
    if (sentinelContext) return sentinelContext;
  }

  return buildEvidenceFallbackSourceContext(entry, positionLabel);
}

function renderEvidenceSourceBlocksHtml(sourceContext) {
  const blocks = Array.isArray(sourceContext?.blocks) ? sourceContext.blocks : [];
  if (blocks.length === 0) {
    return '<div class="evidence-source-empty">표시할 원문이 없습니다.</div>';
  }
  return blocks.map((block) => `
    <article class="evidence-source-block">
      <div class="evidence-source-block-head">
        <span class="evidence-source-block-key">${escapeWorkspaceHtml(block.key || '-')}</span>
        ${block.meta ? `<span class="evidence-source-block-meta">${escapeWorkspaceHtml(block.meta)}</span>` : ''}
      </div>
      <pre>${escapeWorkspaceHtml(block.text || '-')}</pre>
    </article>
  `).join('');
}

function getEvidenceInlineViewerElements() {
  return {
    panel: document.getElementById('evidence-inline-position-viewer'),
    title: document.getElementById('evidence-inline-position-title'),
    meta: document.getElementById('evidence-inline-position-meta'),
    summary: document.getElementById('evidence-inline-position-summary'),
    source: document.getElementById('evidence-inline-position-source')
  };
}

function setActiveEvidencePositionTrigger(activeButton) {
  const all = document.querySelectorAll('.evidence-position-link');
  all.forEach((button) => button.classList.remove('is-active'));
  if (activeButton && activeButton.classList) {
    activeButton.classList.add('is-active');
  }
}

function closeEvidenceInlinePositionViewer(options = {}) {
  const { keepActiveTrigger = false } = options;
  const { panel, title, meta, summary, source } = getEvidenceInlineViewerElements();
  if (panel) {
    panel.classList.add('hidden');
    panel.dataset.claimId = '';
    panel.dataset.evidenceId = '';
  }
  if (title) title.textContent = '원문 미리보기';
  if (meta) meta.textContent = '';
  if (summary) summary.textContent = '';
  if (source) source.textContent = '';
  if (!keepActiveTrigger) {
    setActiveEvidencePositionTrigger(null);
  }
}

function buildEvidenceInlinePositionFallback({
  title,
  positionLabel,
  summaryText,
  sourceText
}) {
  return {
    title: String(title || '').trim() || '원문 미리보기',
    positionLabel: String(positionLabel || '').trim(),
    summaryText: String(summaryText || '').trim() || '관련 내용이 없습니다.',
    sourceText: String(sourceText || '').trim() || '원문을 찾을 수 없습니다.'
  };
}

function resolveEvidenceInlinePositionPayload(entry) {
  const docName = String(entry?.docName || '').trim();
  const paragraphKey = String(entry?.position || '').trim();
  const relatedContent = String(entry?.content || '').trim();
  const fallbackSummary = typeof getPositionModalSummaryText === 'function'
    ? getPositionModalSummaryText(relatedContent)
    : relatedContent;
  const fallbackPosition = typeof transformPositionTextForDisplay === 'function'
    ? (transformPositionTextForDisplay(paragraphKey, docName, { includeMeta: true, metaOnly: false }) || paragraphKey)
    : paragraphKey;
  const fallbackTitle = `${docName || '문헌'} ${fallbackPosition || ''}`.trim();

  if (typeof parseParagraphKeyRange !== 'function'
      || typeof normalizeParagraphLookupKey !== 'function'
      || typeof findCitationByDocName !== 'function'
      || typeof parseCitationPayloadForPositionModal !== 'function') {
    return buildEvidenceInlinePositionFallback({
      title: fallbackTitle,
      positionLabel: fallbackPosition,
      summaryText: fallbackSummary,
      sourceText: entry?.sourceExcerpt || '원문 조회 헬퍼를 찾을 수 없습니다.'
    });
  }

  const rangeInfo = parseParagraphKeyRange(paragraphKey);
  const normalizedKey = rangeInfo?.label
    || normalizeParagraphLookupKey(paragraphKey)
    || paragraphKey;
  const citation = findCitationByDocName(docName);
  if (!citation) {
    return buildEvidenceInlinePositionFallback({
      title: fallbackTitle,
      positionLabel: normalizedKey || fallbackPosition,
      summaryText: fallbackSummary,
      sourceText: '인용발명 문서를 찾을 수 없습니다.'
    });
  }

  const payload = parseCitationPayloadForPositionModal(citation);
  if (!payload || typeof payload !== 'object') {
    return buildEvidenceInlinePositionFallback({
      title: fallbackTitle,
      positionLabel: normalizedKey || fallbackPosition,
      summaryText: fallbackSummary,
      sourceText: '원문 JSON 데이터가 없어 위치 원문을 열 수 없습니다.'
    });
  }

  if (rangeInfo?.kind === 'claim') {
    if (typeof parseCitationClaims !== 'function') {
      return buildEvidenceInlinePositionFallback({
        title: fallbackTitle,
        positionLabel: normalizedKey || fallbackPosition,
        summaryText: fallbackSummary,
        sourceText: '청구항 원문 헬퍼를 찾을 수 없습니다.'
      });
    }
    const claims = parseCitationClaims(payload);
    if (!claims || Object.keys(claims).length === 0) {
      return buildEvidenceInlinePositionFallback({
        title: fallbackTitle,
        positionLabel: normalizedKey || fallbackPosition,
        summaryText: fallbackSummary,
        sourceText: '해당 인용발명에 청구항 원문 데이터가 없습니다.'
      });
    }

    if (rangeInfo.isRange && typeof findClaimEntriesInRange === 'function' && typeof buildClaimRangeContent === 'function') {
      const entries = findClaimEntriesInRange(claims, rangeInfo.startClaim, rangeInfo.endClaim);
      if (entries.length > 0) {
        return buildEvidenceInlinePositionFallback({
          title: `${docName || citation.name || '문헌'} ${rangeInfo.label} 청구항`,
          positionLabel: rangeInfo.label,
          summaryText: fallbackSummary,
          sourceText: buildClaimRangeContent(entries, rangeInfo)
        });
      }
      return buildEvidenceInlinePositionFallback({
        title: fallbackTitle,
        positionLabel: rangeInfo.label,
        summaryText: fallbackSummary,
        sourceText: `${rangeInfo.label} 범위를 청구항 데이터에서 찾지 못했습니다.`
      });
    }

    if (typeof findClaimTextByKey === 'function') {
      const foundClaim = findClaimTextByKey(claims, rangeInfo?.label || paragraphKey);
      if (foundClaim) {
        return buildEvidenceInlinePositionFallback({
          title: `${docName || citation.name || '문헌'} ${foundClaim.key} 청구항`,
          positionLabel: foundClaim.key,
          summaryText: fallbackSummary,
          sourceText: foundClaim.text
        });
      }
      return buildEvidenceInlinePositionFallback({
        title: fallbackTitle,
        positionLabel: rangeInfo?.label || normalizedKey || fallbackPosition,
        summaryText: fallbackSummary,
        sourceText: `${rangeInfo?.label || paragraphKey} 청구항을 찾지 못했습니다.`
      });
    }
  }

  if (rangeInfo?.kind === 'sentinel') {
    if (typeof findSentinelEntriesInRange === 'function' && typeof buildSentinelRangeContent === 'function') {
      const entries = findSentinelEntriesInRange(payload, rangeInfo.startSentinel, rangeInfo.endSentinel);
      if (entries.length > 0) {
        return buildEvidenceInlinePositionFallback({
          title: `${docName || citation.name || '문헌'} ${rangeInfo.label} 센티넬`,
          positionLabel: rangeInfo.label,
          summaryText: fallbackSummary,
          sourceText: buildSentinelRangeContent(payload, entries)
        });
      }
      return buildEvidenceInlinePositionFallback({
        title: fallbackTitle,
        positionLabel: rangeInfo.label,
        summaryText: fallbackSummary,
        sourceText: `${rangeInfo.label} 센티넬을 찾지 못했습니다.`
      });
    }
  }

  if (typeof parseCitationParagraphs !== 'function') {
    return buildEvidenceInlinePositionFallback({
      title: fallbackTitle,
      positionLabel: normalizedKey || fallbackPosition,
      summaryText: fallbackSummary,
      sourceText: '문단 원문 헬퍼를 찾을 수 없습니다.'
    });
  }
  const paragraphs = parseCitationParagraphs(payload);
  if (!paragraphs) {
    return buildEvidenceInlinePositionFallback({
      title: fallbackTitle,
      positionLabel: normalizedKey || fallbackPosition,
      summaryText: fallbackSummary,
      sourceText: '해당 인용발명에 문단 원문 데이터가 없습니다.'
    });
  }

  if (rangeInfo?.isRange && typeof findParagraphEntriesInRange === 'function' && typeof buildParagraphRangeContent === 'function') {
    const entries = findParagraphEntriesInRange(paragraphs, rangeInfo.start, rangeInfo.end);
    if (entries.length > 0) {
      return buildEvidenceInlinePositionFallback({
        title: `${docName || citation.name || '문헌'} ${rangeInfo.label} 문단`,
        positionLabel: rangeInfo.label,
        summaryText: fallbackSummary,
        sourceText: buildParagraphRangeContent(entries, rangeInfo)
      });
    }
    return buildEvidenceInlinePositionFallback({
      title: fallbackTitle,
      positionLabel: rangeInfo.label,
      summaryText: fallbackSummary,
      sourceText: `${rangeInfo.label} 문단 범위를 찾지 못했습니다.`
    });
  }

  if (typeof findParagraphTextByKey === 'function') {
    const found = findParagraphTextByKey(paragraphs, normalizedKey);
    if (found) {
      return buildEvidenceInlinePositionFallback({
        title: `${docName || citation.name || '문헌'} ${found.key} 문단`,
        positionLabel: found.key,
        summaryText: fallbackSummary,
        sourceText: found.text
      });
    }
  }

  return buildEvidenceInlinePositionFallback({
    title: fallbackTitle,
    positionLabel: normalizedKey || fallbackPosition,
    summaryText: fallbackSummary,
    sourceText: `${normalizedKey || paragraphKey || '-'} 위치 원문을 찾지 못했습니다.`
  });
}

function openEvidenceInlinePositionViewer(claimId, evidenceId, triggerButton = null) {
  const { panel, title, meta, summary, source } = getEvidenceInlineViewerElements();
  if (!panel || !title || !meta || !summary || !source) return false;

  const safeEvidenceId = normalizeEvidenceId(evidenceId);
  if (!safeEvidenceId) return false;

  const targetEntry = getAllEvidenceEntriesForClaim(claimId).find((entry) => entry.evidenceId === safeEvidenceId);
  if (!targetEntry) return false;

  const payload = resolveEvidenceInlinePositionPayload(targetEntry);
  title.textContent = payload.title || '원문 미리보기';
  meta.textContent = payload.positionLabel ? `위치: ${payload.positionLabel}` : '';
  summary.textContent = payload.summaryText || '-';
  source.textContent = payload.sourceText || '-';
  panel.dataset.claimId = String(claimId || '');
  panel.dataset.evidenceId = safeEvidenceId;
  panel.classList.remove('hidden');
  setActiveEvidencePositionTrigger(triggerButton);
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return true;
}

function syncEvidenceInlinePositionViewer(claimId, visibleEntries) {
  const { panel } = getEvidenceInlineViewerElements();
  if (!panel || panel.classList.contains('hidden')) return;

  const activeEvidenceId = normalizeEvidenceId(panel.dataset.evidenceId || '');
  if (!activeEvidenceId) {
    closeEvidenceInlinePositionViewer();
    return;
  }

  const belongsToClaim = String(panel.dataset.claimId || '') === String(claimId || '');
  const isStillVisible = Array.isArray(visibleEntries)
    && visibleEntries.some((entry) => normalizeEvidenceId(entry?.evidenceId) === activeEvidenceId);
  if (!belongsToClaim || !isStillVisible) {
    closeEvidenceInlinePositionViewer();
  }
}

function focusEvidenceCardInReviewModal(evidenceId) {
  const safeEvidenceId = normalizeEvidenceId(evidenceId);
  if (!safeEvidenceId) return false;

  const cards = document.querySelectorAll('#workspace-evidence-review-modal .evidence-card[data-evidence-id]');
  const targetCard = Array.from(cards).find((card) => {
    if (!(card instanceof HTMLElement)) return false;
    return normalizeEvidenceId(card.dataset.evidenceId || '') === safeEvidenceId;
  });
  if (!targetCard) return false;

  targetCard.classList.add('jump-focus');
  window.requestAnimationFrame(() => {
    targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  window.setTimeout(() => {
    targetCard.classList.remove('jump-focus');
  }, 1600);
  return true;
}

function openEvidenceReviewModalForEvidenceJump(claimId, evidenceId) {
  const numericClaimId = normalizeWorkspaceClaimId(claimId);
  const safeEvidenceId = normalizeEvidenceId(evidenceId);
  if (numericClaimId === null || !safeEvidenceId) return false;

  const workspace = recomputeClaimWorkspace(numericClaimId, { persist: false }) || ensureClaimWorkspace(numericClaimId);
  if (!workspace) return false;

  if (!workspace.manualReview || typeof workspace.manualReview !== 'object') {
    workspace.manualReview = {};
  }
  if (!workspace.manualReview.filters || typeof workspace.manualReview.filters !== 'object' || Array.isArray(workspace.manualReview.filters)) {
    workspace.manualReview.filters = {};
  }
  workspace.manualReview.filters.active = 'all';
  workspace.manualReview.expandedEvidenceIds = {
    [safeEvidenceId]: true
  };

  renderEvidenceReviewPanel(numericClaimId, workspace);
  renderDecisionWorkspaceMeta(numericClaimId, workspace);
  closeEvidenceInlinePositionViewer();
  openWorkspaceModal('workspace-evidence-review-modal');
  openEvidenceInlinePositionViewer(numericClaimId, safeEvidenceId, null);
  return focusEvidenceCardInReviewModal(safeEvidenceId);
}

function renderEvidenceReviewCard(claimId, entry, workspace) {
  const decision = getEffectiveEvidenceDecision(entry);
  const decisionState = getEvidenceCardDecisionState(entry);
  const displayMatch = getWorkspaceMatchTypeLabel(entry.matchType || '');
  const verificationStatusLabel = getWorkspaceVerificationLabel(entry.verificationStatus);
  const verificationText = verificationStatusLabel !== '-'
    ? `${verificationStatusLabel}${entry.verificationReason ? ` (${entry.verificationReason})` : ''}`
    : '-';
  const reasonTags = buildEvidenceReasonTags(entry);
  const hasDiagnosisReason = reasonTags.length > 0;
  const sourceContext = buildEvidenceSourceContext(claimId, entry);
  const sourceBlocksHtml = renderEvidenceSourceBlocksHtml(sourceContext);
  const sourceHeaderText = sourceContext?.positionLabel && sourceContext.positionLabel !== '-'
    ? `원문 (${sourceContext.positionLabel})`
    : '원문';
  const reasonTagsHtml = reasonTags.length > 0
    ? reasonTags
      .map((tag) => `<span class="evidence-reason-chip is-${escapeWorkspaceHtml(tag.key)}">${escapeWorkspaceHtml(tag.label)}</span>`)
      .join('')
    : '';
  const safeEvidenceId = escapeWorkspaceHtml(entry.evidenceId);
  const isExpanded = isEvidenceCardExpanded(workspace, entry.evidenceId);
  const decisionSwitchHtml = `
    <div class="evidence-decision-switch evidence-decision-switch-head" role="group" aria-label="증거 판정 토글">
      <button type="button" class="decision-switch-btn ${decision === 'accept' ? 'active is-accept' : ''}" data-ws-action="review-decision" data-claim-id="${claimId}" data-evidence-id="${safeEvidenceId}" data-decision="accept" data-current-decision="${escapeWorkspaceHtml(decision)}">채택</button>
      <button type="button" class="decision-switch-btn ${decision === 'hold' ? 'active is-hold' : ''}" data-ws-action="review-decision" data-claim-id="${claimId}" data-evidence-id="${safeEvidenceId}" data-decision="hold" data-current-decision="${escapeWorkspaceHtml(decision)}">보류</button>
      <button type="button" class="decision-switch-btn ${decision === 'reject' ? 'active is-reject' : ''}" data-ws-action="review-decision" data-claim-id="${claimId}" data-evidence-id="${safeEvidenceId}" data-decision="reject" data-current-decision="${escapeWorkspaceHtml(decision)}">제외</button>
    </div>
  `;

  if (!isExpanded) {
    return `
      <article
        class="evidence-card ${entry.includeInEffective ? 'is-effective' : 'is-excluded'} ${hasDiagnosisReason ? 'has-diagnosis' : 'no-diagnosis'} decision-${decisionState} is-compact"
        data-ws-action="review-toggle-expand"
        data-claim-id="${claimId}"
        data-evidence-id="${safeEvidenceId}"
      >
        <div class="evidence-card-compact-grid">
          <div class="evidence-card-compact-item">
            <span>구성번호</span>
            <strong>${escapeWorkspaceHtml(entry.featureId || '-')}</strong>
          </div>
          <div class="evidence-card-compact-item">
            <span>인용발명 번호</span>
            <strong>${escapeWorkspaceHtml(entry.docName || '-')}</strong>
          </div>
          <div class="evidence-card-compact-item">
            <span>출처 단계</span>
            <strong>${escapeWorkspaceHtml(entry.sourceLabel || '-')}</strong>
          </div>
          <div class="evidence-card-compact-item">
            <span>일치 유형</span>
            <strong>${escapeWorkspaceHtml(displayMatch)}</strong>
          </div>
        </div>
        ${decisionSwitchHtml}
      </article>
    `;
  }

  return `
    <article class="evidence-card ${entry.includeInEffective ? 'is-effective' : 'is-excluded'} ${hasDiagnosisReason ? 'has-diagnosis' : 'no-diagnosis'} decision-${decisionState} is-expanded" data-ws-action="review-toggle-expand" data-claim-id="${claimId}" data-evidence-id="${safeEvidenceId}">
      <div class="evidence-card-head">
        <div class="evidence-card-head-top">
          <div class="evidence-card-head-main">
            <button type="button" class="evidence-card-collapse-btn" data-ws-action="review-toggle-expand" data-claim-id="${claimId}" data-evidence-id="${safeEvidenceId}">요약</button>
            <span class="evidence-card-title">${escapeWorkspaceHtml(entry.featureId)} · ${escapeWorkspaceHtml(entry.docName)}</span>
          </div>
          ${decisionSwitchHtml}
        </div>
        ${reasonTagsHtml ? `<div class="evidence-reason-tags">${reasonTagsHtml}</div>` : ''}
      </div>
      <div class="evidence-card-body">
        <div class="evidence-card-table-wrap">
          <table class="evidence-content-table">
            <thead>
              <tr>
                <th>구성</th>
                <th>대응 내용</th>
                <th>${escapeWorkspaceHtml(sourceHeaderText)}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>${escapeWorkspaceHtml(entry.featureDescription || entry.featureId || '-')}</td>
                <td>${escapeWorkspaceHtml(entry.content || '-')}</td>
                <td class="evidence-source-cell">
                  <div class="evidence-source-cell-inner">
                    <button
                      type="button"
                      class="evidence-context-expand-btn"
                      data-ws-action="review-expand-context"
                      data-direction="prev"
                      data-claim-id="${claimId}"
                      data-evidence-id="${safeEvidenceId}"
                      ${sourceContext?.canExpandPrev ? '' : 'disabled'}
                    >▲ 위 센티넬 추가</button>
                    <div class="evidence-source-scroll">${sourceBlocksHtml}</div>
                    <button
                      type="button"
                      class="evidence-context-expand-btn"
                      data-ws-action="review-expand-context"
                      data-direction="next"
                      data-claim-id="${claimId}"
                      data-evidence-id="${safeEvidenceId}"
                      ${sourceContext?.canExpandNext ? '' : 'disabled'}
                    >▼ 아래 센티넬 추가</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="evidence-card-meta-line"><strong>일치 유형:</strong> ${escapeWorkspaceHtml(displayMatch)}</div>
        <div class="evidence-card-meta-line"><strong>출처 단계:</strong> ${escapeWorkspaceHtml(entry.sourceLabel || '-')}</div>
        <div class="evidence-card-meta-line"><strong>검증 상태:</strong> ${escapeWorkspaceHtml(verificationText)}</div>
      </div>
      <div class="evidence-card-note">
        <textarea rows="2" placeholder="검토 메모를 입력하세요." data-ws-action="review-note" data-claim-id="${claimId}" data-evidence-id="${safeEvidenceId}">${escapeWorkspaceHtml(entry.note || '')}</textarea>
      </div>
    </article>
  `;
}

function renderEvidenceReviewPanel(claimId, workspace) {
  const filtersEl = document.getElementById('evidence-review-filters');
  const groupToggleEl = document.getElementById('evidence-review-group-toggle');
  const summaryEl = document.getElementById('evidence-review-summary');
  const listEl = document.getElementById('evidence-review-list');
  if (!filtersEl || !listEl || !groupToggleEl) return;

  const activeFilter = normalizeWorkspaceFilter(workspace?.manualReview?.filters?.active);
  const groupBy = normalizeWorkspaceGroupBy(workspace?.manualReview?.groupBy);
  filtersEl.innerHTML = WORKSPACE_REVIEW_FILTERS.map((filterId) => {
    const isActive = filterId === activeFilter;
    const label = WORKSPACE_REVIEW_FILTER_LABELS[filterId] || filterId;
    return `<button type="button" class="review-filter-btn ${isActive ? 'active' : ''}" data-ws-action="review-filter" data-claim-id="${claimId}" data-filter="${filterId}">${escapeWorkspaceHtml(label)}</button>`;
  }).join('');

  const allEntries = getAllEvidenceEntriesForClaim(claimId).sort(compareEvidenceEntries);
  const reviewQueueCount = allEntries.filter(entry => matchesEvidenceFilter(entry, 'review_queue')).length;
  const acceptedCount = allEntries.filter(entry => matchesEvidenceFilter(entry, 'accepted')).length;
  const confirmedCount = allEntries.filter(entry => matchesEvidenceFilter(entry, 'confirmed')).length;
  const showGroupToggle = activeFilter !== 'review_queue';

  groupToggleEl.classList.toggle('hidden', !showGroupToggle);
  if (showGroupToggle) {
    groupToggleEl.innerHTML = `
      <button type="button" class="review-group-btn ${groupBy === 'feature' ? 'active' : ''}" data-ws-action="review-group" data-claim-id="${claimId}" data-group-by="feature">구성별</button>
      <button type="button" class="review-group-btn ${groupBy === 'doc' ? 'active' : ''}" data-ws-action="review-group" data-claim-id="${claimId}" data-group-by="doc">인용발명별</button>
    `;
  } else {
    groupToggleEl.innerHTML = '';
  }

  let entries = allEntries.filter((entry) => matchesEvidenceFilter(entry, activeFilter));
  if (activeFilter !== 'review_queue' && groupBy === 'feature') {
    const featureOrderMap = getClaimFeatureOrderMap(claimId);
    entries = [...entries].sort((a, b) => {
      const order = compareEvidenceByFeatureOrder(a, b, featureOrderMap);
      if (order !== 0) return order;
      return compareEvidenceEntries(a, b);
    });
  }
  const effectiveCount = allEntries.filter((entry) => entry.includeInEffective).length;
  const excludedCount = Math.max(0, allEntries.length - effectiveCount);
  if (summaryEl) {
    summaryEl.innerHTML = `
      <span class="review-summary-chip">전체 ${allEntries.length}</span>
      <span class="review-summary-chip">검토 필요 ${reviewQueueCount}</span>
      <span class="review-summary-chip">채택 ${acceptedCount}</span>
      <span class="review-summary-chip">확정 ${confirmedCount}</span>
      <span class="review-summary-chip">필터 ${entries.length}</span>
      <span class="review-summary-chip">활용 ${effectiveCount}</span>
      <span class="review-summary-chip">제외 ${excludedCount}</span>
    `;
  }

  if (entries.length === 0) {
    listEl.innerHTML = '<div class="workspace-empty">필터 조건에 해당하는 증거가 없습니다.</div>';
    syncEvidenceInlinePositionViewer(claimId, []);
    return;
  }

  if (activeFilter === 'review_queue') {
    const sortedQueue = sortReviewQueueEntries(entries);
    const warningEntries = sortedQueue.filter((entry) => getReviewQueueCategory(entry) === 'warning');
    const discardedEntries = sortedQueue.filter((entry) => getReviewQueueCategory(entry) === 'discarded');
    const equivalentEntries = sortedQueue.filter((entry) => getReviewQueueCategory(entry) === 'equivalent');

    const sections = [
      { id: 'warning', title: 'E단계 경고/주의', items: warningEntries },
      { id: 'discarded', title: 'C단계 제외', items: discardedEntries },
      { id: 'equivalent', title: '실질적 동일', items: equivalentEntries }
    ].filter((section) => section.items.length > 0);

    if (sections.length === 0) {
      listEl.innerHTML = '<div class="workspace-empty">검토가 필요한 증거가 없습니다.</div>';
      syncEvidenceInlinePositionViewer(claimId, []);
      return;
    }

    listEl.innerHTML = sections.map((section) => {
      const cardsHtml = section.items.map((entry) => renderEvidenceReviewCard(claimId, entry, workspace)).join('');
      return `
        <section class="evidence-review-group evidence-review-priority-group" data-priority-group="${section.id}">
          <div class="evidence-review-group-head">
            <strong>${escapeWorkspaceHtml(section.title)}</strong>
            <span>${section.items.length}건</span>
          </div>
          <div class="evidence-review-group-list">${cardsHtml}</div>
        </section>
      `;
    }).join('');
    syncEvidenceInlinePositionViewer(claimId, entries);
    return;
  }

  const grouped = new Map();
  entries.forEach((entry) => {
    const key = getEvidenceGroupLabel(entry, groupBy);
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(entry);
  });

  listEl.innerHTML = Array.from(grouped.entries()).map(([groupLabel, groupEntries]) => {
    const cardsHtml = groupEntries.map((entry) => renderEvidenceReviewCard(claimId, entry, workspace)).join('');
    return `
      <section class="evidence-review-group">
        <div class="evidence-review-group-head">
          <strong>${escapeWorkspaceHtml(groupLabel)}</strong>
          <span>${groupEntries.length}건</span>
        </div>
        <div class="evidence-review-group-list">${cardsHtml}</div>
      </section>
    `;
  }).join('');
  syncEvidenceInlinePositionViewer(claimId, entries);
}

function truncateWorkspaceText(value, maxLength) {
  const normalized = String(value || '').trim();
  const safeMax = Number.isFinite(Number(maxLength)) ? Math.max(256, Number(maxLength)) : 8192;
  if (normalized.length <= safeMax) return normalized;
  const omitted = normalized.length - safeMax;
  return `${normalized.slice(0, safeMax)}\n...(truncated ${omitted} chars)`;
}

function stripWorkspaceHtmlToText(html) {
  const source = String(html || '').trim();
  if (!source) return '';
  const temp = document.createElement('div');
  temp.innerHTML = source;
  return String(temp.textContent || temp.innerText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildOpinionNoticeClaimsFullText() {
  const rows = (claims || [])
    .filter((claim) => String(claim?.text || '').trim())
    .map((claim, index) => {
      const claimId = normalizeWorkspaceClaimId(claim?.id) ?? index + 1;
      const claimName = String(claim?.name || `Claim ${claimId}`).trim();
      const claimText = String(claim?.text || '').trim();
      return `[Claim ${claimId}] ${claimName}\n${claimText}`;
    });
  if (rows.length === 0) return '-';
  return truncateWorkspaceText(rows.join('\n\n'), OPINION_NOTICE_REVIEW_CLAIMS_MAX_CHARS);
}

function getOpinionNoticeOrderedDocNames(draft) {
  const ordered = [];
  const primaryDocName = String(draft?.primaryDocName || '').trim();
  if (primaryDocName) ordered.push(primaryDocName);

  const rows = Array.isArray(draft?.rows) ? draft.rows : [];
  rows.forEach((row) => {
    const supportDocName = String(row?.supportDocName || '').trim();
    if (!supportDocName || ordered.includes(supportDocName)) return;
    ordered.push(supportDocName);
  });

  return ordered;
}

function buildOpinionNoticeCitationAttachments(draft) {
  const orderedDocNames = getOpinionNoticeOrderedDocNames(draft);
  return orderedDocNames.map((docName, index) => {
    const citation = typeof resolveCitationByDocName === 'function'
      ? resolveCitationByDocName(docName)
      : null;
    const payloadText = String(citation?.payloadText || '').trim();
    const plainText = String(citation?.text || '').trim();
    const rawContent = payloadText || plainText || '';
    const clippedContent = truncateWorkspaceText(rawContent, OPINION_NOTICE_REVIEW_CITATION_MAX_CHARS);
    return {
      ref_no: index + 1,
      doc_name: docName,
      document_name: resolveNoticeDocLabelByName(docName),
      source: payloadText ? 'payloadText' : (plainText ? 'text' : 'none'),
      content: clippedContent || '[citation content unavailable]',
      content_truncated: rawContent.length > clippedContent.length
    };
  });
}

function buildFallbackOpinionNoticeTableTsv(draft) {
  const rows = Array.isArray(draft?.rows) ? draft.rows : [];
  const header = ['번호', '구성', '인용발명 1', '비고'].join('\t');
  const body = rows.map((row, index) => {
    const featureDescription = String(row?.featureDescription || '').trim() || '-';
    const primaryEvidence = Array.isArray(row?.primaryEvidenceIds) && row.primaryEvidenceIds.length > 0
      ? row.primaryEvidenceIds.join(', ')
      : '-';
    const remark = String(row?.remark || '').trim() || '-';
    return [String(index + 1), featureDescription, primaryEvidence, remark].join('\t');
  });
  return [header, ...body].join('\n').trim();
}

function buildOpinionNoticeDiffNotesText(draft) {
  const diffNotesEl = document.getElementById('opinion-notice-diff-notes');
  const domText = stripWorkspaceHtmlToText(diffNotesEl?.innerHTML || '');
  if (domText) return domText;
  const draftText = String(draft?.sections?.difference || '').trim();
  return draftText || '-';
}

function buildOpinionNoticeReviewPromptVariables(claimId) {
  const draft = buildOpinionNoticeDraft(claimId);
  const tableTsv = typeof buildOpinionNoticeTsv === 'function'
    ? String(buildOpinionNoticeTsv() || '').trim()
    : '';
  const fallbackTableTsv = buildFallbackOpinionNoticeTableTsv(draft);
  const promptTsv = tableTsv || fallbackTableTsv || '-';
  const diffNotes = buildOpinionNoticeDiffNotesText(draft);
  const orderedCitations = buildOpinionNoticeCitationAttachments(draft);

  return {
    claims_full_text: buildOpinionNoticeClaimsFullText(),
    ordered_citations_json: orderedCitations,
    opinion_notice_table_tsv: promptTsv,
    opinion_notice_diff_notes: diffNotes
  };
}

function buildLlmCheckPromptTemplate(claimId, workspace) {
  const draft = buildOpinionNoticeDraft(claimId);
  const orderedDocs = getOpinionNoticeOrderedDocNames(draft);
  return [
    `Template Key: prompts/opinion_notice_review`,
    `Claim ID: ${normalizeWorkspaceClaimId(claimId) || '-'}`,
    `Primary Citation: ${String(draft?.primaryDocName || '').trim() || '-'}`,
    `Citation Count: ${orderedDocs.length}`,
    '실행 시 템플릿 기반 프롬프트가 자동 생성되어 발송됩니다.'
  ].join('\n');
}

function setLlmCheckRunningUi(isRunning) {
  const running = !!isRunning;
  const buttons = document.querySelectorAll('[data-ws-action="run-llm-check"]');
  buttons.forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) return;
    if (!button.dataset.defaultLabel) {
      button.dataset.defaultLabel = String(button.textContent || '').trim();
    }
    button.disabled = running;
    button.textContent = running ? '진보성 검토 중...' : (button.dataset.defaultLabel || '진보성 검토');
  });
}

function parseOpinionNoticeReviewOutput(rawContent) {
  const content = String(rawContent || '').trim();
  let parsed = null;

  if (content) {
    try {
      parsed = safeJsonParse(content);
    } catch (_error) {
      parsed = null;
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      score: '-',
      reason: content || '응답이 비어 있습니다.',
      parsed: null
    };
  }

  const numericScore = Number(parsed.score);
  const score = Number.isFinite(numericScore) ? String(Math.max(0, Math.min(100, Math.round(numericScore)))) : '-';
  const lines = [];
  const summary = String(parsed.summary || '').trim();
  if (summary) lines.push(summary);

  if (Array.isArray(parsed.checks)) {
    parsed.checks.forEach((check, index) => {
      if (!check || typeof check !== 'object') return;
      const id = String(check.id || index + 1).trim();
      const status = String(check.status || '').trim().toLowerCase() || 'n/a';
      const title = String(check.title || '').trim();
      const reason = String(check.reason || '').trim();
      const evidence = String(check.evidence || '').trim();
      const head = title ? `${id}. [${status}] ${title}` : `${id}. [${status}]`;
      const body = [reason, evidence ? `근거: ${evidence}` : ''].filter(Boolean).join(' | ');
      lines.push(body ? `${head} - ${body}` : head);
    });
  }

  const finalRecommendation = String(parsed.final_recommendation || '').trim();
  if (finalRecommendation) {
    lines.push(`최종 권고: ${finalRecommendation}`);
  }

  return {
    score,
    reason: lines.join('\n').trim() || content || '-',
    parsed
  };
}

async function runOpinionNoticeLlmCheck(claimId) {
  const numericClaimId = normalizeWorkspaceClaimId(claimId);
  if (numericClaimId === null) {
    throw new Error('진보성 검토를 실행할 청구항이 없습니다.');
  }

  const workspace = recomputeClaimWorkspace(numericClaimId, { persist: false }) || ensureClaimWorkspace(numericClaimId);
  if (!workspace) {
    throw new Error('진보성 검토용 워크스페이스를 구성할 수 없습니다.');
  }

  if (typeof refreshOpinionNoticeCard === 'function') {
    refreshOpinionNoticeCard({ syncClaimSelect: false });
  }

  const previousScore = String(workspace.llmCheck.score || '').trim();
  const previousReason = String(workspace.llmCheck.reason || '').trim();

  workspace.llmCheck.running = true;
  workspace.llmCheck.error = '';
  workspace.llmCheck.lastRequestedAt = new Date().toISOString();
  setLlmCheckRunningUi(true);
  saveAnalysisResultsToStorage();
  renderLlmCheckPanel(numericClaimId, workspace);

  try {
    const promptVariables = buildOpinionNoticeReviewPromptVariables(numericClaimId);
    const promptPair = await renderLarcPromptPair('opinionNoticeReview', promptVariables);
    workspace.llmCheck.systemPrompt = String(promptPair.system || '').trim();
    workspace.llmCheck.prompt = String(promptPair.user || '').trim();
    saveAnalysisResultsToStorage();
    renderLlmCheckPanel(numericClaimId, workspace);

    const payload = applyStepApiOptions({
      model: resolveLarcModelName(),
      messages: promptPair.messages
    }, 'opinionNoticeReview');

    const response = await sendLLMRequest(payload, {
      stepKey: 'opinionNoticeReview',
      promptKey: 'opinionNoticeReview',
      label: `claim_${numericClaimId}`
    });
    if (!response?.ok || !Array.isArray(response?.data?.choices) || response.data.choices.length === 0) {
      throw new Error(response?.error || '진보성 검토 응답이 비어 있습니다.');
    }

    const content = String(response.data.choices[0]?.message?.content || '').trim();
    workspace.llmCheck.lastRawResponse = content;
    workspace.llmCheck.lastCompletedAt = new Date().toISOString();

    const normalizedOutput = parseOpinionNoticeReviewOutput(content);
    workspace.llmCheck.score = normalizedOutput.score;
    workspace.llmCheck.reason = normalizedOutput.reason;
    workspace.llmCheck.error = '';
    workspace.llmCheck.running = false;
    saveAnalysisResultsToStorage();
    renderLlmCheckPanel(numericClaimId, workspace);
    return normalizedOutput;
  } catch (error) {
    const message = error?.message || String(error) || '진보성 검토 실행에 실패했습니다.';
    workspace.llmCheck.error = message;
    workspace.llmCheck.reason = previousReason || `실패: ${message}`;
    workspace.llmCheck.score = previousScore || '-';
    workspace.llmCheck.running = false;
    saveAnalysisResultsToStorage();
    renderLlmCheckPanel(numericClaimId, workspace);
    throw error;
  } finally {
    setLlmCheckRunningUi(false);
  }
}

function renderLlmCheckPanel(claimId, workspace) {
  const promptEl = document.getElementById('llm-check-prompt');
  const scoreEl = document.getElementById('llm-check-score');
  const reasonEl = document.getElementById('llm-check-reason');
  const statusEl = document.getElementById('llm-check-status');
  if (!promptEl || !scoreEl || !reasonEl) return;

  const configuredPrompt = String(workspace?.llmCheck?.prompt || '').trim();
  if (!configuredPrompt) {
    workspace.llmCheck.prompt = buildLlmCheckPromptTemplate(claimId, workspace);
  }
  promptEl.value = workspace.llmCheck.prompt || '';
  scoreEl.textContent = String(workspace?.llmCheck?.score || '').trim() || '-';
  const errorText = String(workspace?.llmCheck?.error || '').trim();
  reasonEl.textContent = String(workspace?.llmCheck?.reason || '').trim() || '실행 후 표시됩니다.';
  if (statusEl) {
    if (workspace?.llmCheck?.running) {
      statusEl.textContent = '요청 중';
      statusEl.dataset.state = 'running';
    } else if (errorText) {
      statusEl.textContent = `오류: ${errorText}`;
      statusEl.dataset.state = 'error';
    } else if (String(workspace?.llmCheck?.lastCompletedAt || '').trim()) {
      const completedAtRaw = String(workspace?.llmCheck?.lastCompletedAt || '').trim();
      const completedAt = new Date(completedAtRaw);
      const completedLabel = Number.isNaN(completedAt.getTime())
        ? completedAtRaw
        : completedAt.toLocaleString();
      statusEl.textContent = `완료: ${completedLabel}`;
      statusEl.dataset.state = 'done';
    } else {
      statusEl.textContent = '대기 중';
      statusEl.dataset.state = 'idle';
    }
  }
}

function renderDecisionWorkspaceMeta(claimId, workspace) {
  const metaEl = document.getElementById('decision-workspace-meta');
  if (!metaEl) return;

  const primaryDocName = String(workspace?.selection?.primaryDocName || '').trim() || '-';
  const allCount = getAllEvidenceEntriesForClaim(claimId).length;
  const effectiveCount = getEffectiveEvidenceEntriesForClaim(claimId).length;

  metaEl.innerHTML = `
    <span class="decision-meta-chip">청구항 ${escapeWorkspaceHtml(claimId)}</span>
    <span class="decision-meta-chip">주인용 ${escapeWorkspaceHtml(primaryDocName)}</span>
    <span class="decision-meta-chip">활용 증거 ${effectiveCount}/${allCount}</span>
  `;
}

function renderDecisionWorkspace(claimId) {
  const root = ensureDecisionWorkspaceLayout();
  if (!root) return;
  ensureWorkspaceModalLayouts();

  const result = getClaimResultForWorkspace(claimId);
  const progress = typeof getClaimProgress === 'function' ? getClaimProgress(claimId) : null;
  const canRender = !!result && !result.error && (!progress || progress.status === 'done');
  if (!canRender) {
    root.classList.add('hidden');
    return;
  }

  const workspace = recomputeClaimWorkspace(claimId, { persist: false });
  if (!workspace) {
    root.classList.add('hidden');
    return;
  }

  root.classList.remove('hidden');
  renderDocRoleRecommendationPanel(claimId, workspace, result.ClaimFeatures || []);
  renderCombinationWorkspacePanel(claimId, workspace);
  renderEvidenceReviewPanel(claimId, workspace);
  renderLlmCheckPanel(claimId, workspace);
  renderDecisionWorkspaceMeta(claimId, workspace);
}
function ensureOpinionNoticeWorkspaceLayout() {
  const body = document.querySelector('.opinion-notice-body');
  if (!body) return null;
  ensureWorkspaceModalLayouts();

  let actionRow = document.getElementById('opinion-workspace-action-row');
  if (!actionRow) {
    actionRow = document.createElement('div');
    actionRow.id = 'opinion-workspace-action-row';
    actionRow.className = 'opinion-workspace-action-row';
    const controls = body.querySelector('.opinion-notice-controls');
    if (controls && controls.parentElement === body) {
      controls.insertAdjacentElement('afterend', actionRow);
    } else {
      body.prepend(actionRow);
    }
  }
  actionRow.innerHTML = `
    <button type="button" class="btn-secondary-sm opinion-combination-cta" data-ws-action="open-combination-modal">
      인용발명 조합 선택
    </button>
  `;

  let tabs = document.getElementById('opinion-notice-mode-tabs');
  if (!tabs) {
    tabs = document.createElement('div');
    tabs.id = 'opinion-notice-mode-tabs';
    tabs.className = 'opinion-notice-mode-tabs';
    tabs.innerHTML = `
      <button type="button" data-ws-action="set-notice-mode" data-mode="table" class="notice-mode-btn">표</button>
      <button type="button" data-ws-action="set-notice-mode" data-mode="draft" class="notice-mode-btn">문안</button>
      <button type="button" data-ws-action="set-notice-mode" data-mode="export" class="notice-mode-btn">내보내기</button>
    `;

    const controls = body.querySelector('.opinion-notice-controls');
    if (controls && controls.parentElement === body) {
      controls.insertAdjacentElement('afterend', tabs);
    } else {
      body.prepend(tabs);
    }
  }

  let draftPanel = document.getElementById('opinion-notice-draft-panel');
  if (!draftPanel) {
    draftPanel = document.createElement('div');
    draftPanel.id = 'opinion-notice-draft-panel';
    draftPanel.className = 'opinion-notice-draft-panel hidden';
    body.appendChild(draftPanel);
  }

  let exportPanel = document.getElementById('opinion-notice-export-panel');
  if (!exportPanel) {
    exportPanel = document.createElement('div');
    exportPanel.id = 'opinion-notice-export-panel';
    exportPanel.className = 'opinion-notice-export-panel hidden';
    body.appendChild(exportPanel);
  }

  let llmBottomRow = document.getElementById('opinion-llmcheck-bottom-row');
  if (!llmBottomRow) {
    llmBottomRow = document.createElement('div');
    llmBottomRow.id = 'opinion-llmcheck-bottom-row';
    llmBottomRow.className = 'opinion-llmcheck-bottom-row';
    body.appendChild(llmBottomRow);
  } else if (llmBottomRow.parentElement !== body) {
    body.appendChild(llmBottomRow);
  }
  llmBottomRow.innerHTML = `
    <button type="button" id="btn-opinion-llmcheck-bottom" class="btn-secondary-sm" data-ws-action="open-llmcheck-modal">
      진보성 검토
    </button>
  `;

  return { tabs, draftPanel, exportPanel, llmBottomRow };
}

function normalizeOpinionNoticeMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  if (normalized === 'draft' || normalized === 'export') return normalized;
  return 'table';
}

function getOpinionNoticeMode() {
  return normalizeOpinionNoticeMode(opinionNoticeMode);
}

function setOpinionNoticeMode(mode, options = {}) {
  opinionNoticeMode = normalizeOpinionNoticeMode(mode);
  ensureOpinionNoticeWorkspaceLayout();

  const table = document.getElementById('opinion-notice-table');
  const emptyState = document.getElementById('opinion-notice-empty');
  const citationMapEl = document.getElementById('opinion-notice-citation-map');
  const diffNotesEl = document.getElementById('opinion-notice-diff-notes');
  const draftPanel = document.getElementById('opinion-notice-draft-panel');
  const exportPanel = document.getElementById('opinion-notice-export-panel');

  document.querySelectorAll('#opinion-notice-mode-tabs .notice-mode-btn').forEach((button) => {
    const targetMode = normalizeOpinionNoticeMode(button.dataset.mode);
    const isActive = targetMode === opinionNoticeMode;
    button.classList.toggle('active', isActive);
  });

  if (table) table.classList.toggle('hidden', opinionNoticeMode !== 'table' || table.classList.contains('hidden-by-data'));
  if (citationMapEl) citationMapEl.classList.toggle('hidden', opinionNoticeMode !== 'table' || citationMapEl.classList.contains('hidden-by-data'));
  if (diffNotesEl) diffNotesEl.classList.toggle('hidden', opinionNoticeMode !== 'table' || diffNotesEl.classList.contains('hidden-by-data'));
  if (draftPanel) draftPanel.classList.toggle('hidden', opinionNoticeMode !== 'draft');
  if (exportPanel) exportPanel.classList.toggle('hidden', opinionNoticeMode !== 'export');
  if (emptyState) emptyState.classList.toggle('hidden', opinionNoticeMode !== 'table');

  if (options.persist !== false) {
    try {
      localStorage.setItem(OPINION_NOTICE_MODE_STORAGE_KEY, opinionNoticeMode);
    } catch (error) {
      console.warn('Failed to persist opinion notice mode:', error);
    }
  }

  if (options.refresh) {
    refreshOpinionNoticeCard({ syncClaimSelect: false });
  }
}

function copyWorkspaceTextToClipboard(text) {
  const safeText = String(text || '').trim();
  if (!safeText) return Promise.resolve(false);

  if (typeof writePlainTextToClipboard === 'function') {
    return writePlainTextToClipboard(safeText).then(() => true).catch(() => false);
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(safeText).then(() => true).catch(() => false);
  }

  return Promise.resolve(false);
}

function normalizeDraftSentenceItems(rawItems, fallbackContent = '') {
  const rawList = Array.isArray(rawItems) ? rawItems : [];
  const normalized = rawList.map((item) => {
    if (typeof item === 'string') {
      return {
        text: String(item || '').trim(),
        evidenceId: '',
        featureId: '',
        docName: ''
      };
    }
    if (!item || typeof item !== 'object') return null;
    return {
      text: String(item.text || '').trim(),
      evidenceId: normalizeEvidenceId(item.evidenceId || '') || '',
      featureId: String(item.featureId || '').trim(),
      docName: String(item.docName || '').trim()
    };
  }).filter((item) => item?.text);

  if (normalized.length > 0) return normalized;

  return String(fallbackContent || '')
    .split('\n')
    .map((line) => String(line || '').trim())
    .filter(Boolean)
    .map((text) => ({
      text,
      evidenceId: '',
      featureId: '',
      docName: ''
    }));
}

function renderDraftSentenceItemsHtml(section, claimId) {
  const items = Array.isArray(section?.sentenceItems) ? section.sentenceItems : [];
  if (items.length === 0) {
    return '<div class="notice-draft-line">-</div>';
  }

  return items.map((item) => {
    const text = escapeWorkspaceHtml(item.text || '-');
    const evidenceId = normalizeEvidenceId(item.evidenceId || '');
    if (!evidenceId) {
      return `<div class="notice-draft-line">${text}</div>`;
    }
    return `
      <button
        type="button"
        class="notice-draft-line is-linked"
        data-ws-action="jump-draft-evidence"
        data-claim-id="${claimId}"
        data-evidence-id="${escapeWorkspaceHtml(evidenceId)}"
        title="해당 증거 카드로 이동"
      >${text}</button>
    `;
  }).join('');
}

function buildDraftSectionDefs(draft) {
  const sections = draft?.sections || {};
  const sentenceLinks = draft?.sentenceLinks && typeof draft.sentenceLinks === 'object'
    ? draft.sentenceLinks
    : {};
  const sectionDefs = [
    { key: 'intro', title: '1. 인용발명 소개', content: String(sections.intro || '').trim() },
    { key: 'comparison', title: '2. 구성 대비 판단', content: String(sections.comparison || '').trim() },
    { key: 'difference', title: '3. 차이구성 판단', content: String(sections.difference || '').trim() },
    { key: 'inventiveStep', title: '4. 진보성 판단', content: String(sections.inventiveStep || '').trim() },
    { key: 'conclusion', title: '5. 결론', content: String(sections.conclusion || '').trim() }
  ];
  return sectionDefs.map((section) => ({
    ...section,
    sentenceItems: normalizeDraftSentenceItems(sentenceLinks?.[section.key], section.content)
  }));
}

function buildFullDraftText(draft) {
  const sectionDefs = buildDraftSectionDefs(draft);
  return sectionDefs
    .map((section) => `${section.title}\n${section.content || '-'}`)
    .join('\n\n');
}

function renderOpinionNoticeDraftWorkspace(claimId) {
  ensureOpinionNoticeWorkspaceLayout();
  const draftPanel = document.getElementById('opinion-notice-draft-panel');
  const exportPanel = document.getElementById('opinion-notice-export-panel');
  if (!draftPanel || !exportPanel) return;

  const numericClaimId = normalizeWorkspaceClaimId(claimId);
  if (numericClaimId === null) {
    draftPanel.innerHTML = '<div class="workspace-empty">문안을 생성할 청구항이 없습니다.</div>';
    exportPanel.innerHTML = '<div class="workspace-empty">내보낼 문안이 없습니다.</div>';
    return;
  }

  const workspace = ensureClaimWorkspace(numericClaimId);
  if (!workspace) {
    draftPanel.innerHTML = '<div class="workspace-empty">문안을 생성할 수 없습니다.</div>';
    exportPanel.innerHTML = '<div class="workspace-empty">내보낼 문안이 없습니다.</div>';
    return;
  }

  const draft = buildOpinionNoticeDraft(numericClaimId);
  const sections = buildDraftSectionDefs(draft);
  const fullText = buildFullDraftText(draft);

  draftPanel.innerHTML = `
    <div class="notice-draft-toolbar">
      <button type="button" class="btn-secondary-sm" data-ws-action="copy-draft-full" data-claim-id="${numericClaimId}">전체 복사</button>
    </div>
    ${sections.map((section) => `
      <section class="notice-draft-block">
        <div class="notice-draft-block-head">
          <h4>${escapeWorkspaceHtml(section.title)}</h4>
          <button type="button" class="btn-secondary-sm" data-ws-action="copy-draft-block" data-claim-id="${numericClaimId}" data-section-key="${escapeWorkspaceHtml(section.key)}">블록별 복사</button>
        </div>
        <div class="notice-draft-lines">
          ${renderDraftSentenceItemsHtml(section, numericClaimId)}
        </div>
      </section>
    `).join('')}
  `;

  const tsv = typeof buildOpinionNoticeTsv === 'function' ? buildOpinionNoticeTsv() : '';
  exportPanel.innerHTML = `
    <div class="notice-draft-toolbar">
      <button type="button" class="btn-secondary-sm" data-ws-action="copy-draft-full" data-claim-id="${numericClaimId}">전체 복사</button>
      <button type="button" class="btn-secondary-sm" data-ws-action="copy-export-tsv">표 TSV 복사</button>
    </div>
    <section class="notice-export-block">
      <h4>문안</h4>
      <textarea readonly rows="14">${escapeWorkspaceHtml(fullText)}</textarea>
    </section>
    <section class="notice-export-block">
      <h4>표 TSV</h4>
      <textarea readonly rows="8">${escapeWorkspaceHtml(tsv || '')}</textarea>
    </section>
  `;
}

function applyWorkspaceDecision(claimId, evidenceId, decision) {
  const workspace = ensureClaimWorkspace(claimId);
  if (!workspace) return;

  const safeEvidenceId = normalizeEvidenceId(evidenceId);
  if (!safeEvidenceId) return;

  const normalizedDecision = normalizeWorkspaceDecision(decision);
  const previous = workspace.manualReview.decisionsByEvidenceId[safeEvidenceId] || {
    decision: 'system',
    note: '',
    updatedAt: ''
  };

  workspace.manualReview.decisionsByEvidenceId[safeEvidenceId] = {
    ...previous,
    decision: normalizedDecision,
    updatedAt: new Date().toISOString()
  };
}

function applyWorkspaceEvidenceNote(claimId, evidenceId, note) {
  const workspace = ensureClaimWorkspace(claimId);
  if (!workspace) return;

  const safeEvidenceId = normalizeEvidenceId(evidenceId);
  if (!safeEvidenceId) return;

  const previous = workspace.manualReview.decisionsByEvidenceId[safeEvidenceId] || {
    decision: 'system',
    note: '',
    updatedAt: ''
  };

  workspace.manualReview.decisionsByEvidenceId[safeEvidenceId] = {
    ...previous,
    note: String(note || '').trim(),
    updatedAt: new Date().toISOString()
  };
}

function handleWorkspaceClick(event) {
  const backdrop = event.target?.classList?.contains('workspace-modal') ? event.target : null;
  if (backdrop?.id) {
    closeWorkspaceModal(backdrop.id);
    return;
  }

  const actionEl = event.target.closest('[data-ws-action]');
  if (!actionEl) return;

  const action = String(actionEl.dataset.wsAction || '').trim();
  if (!action) return;

  if (action === 'set-notice-mode') {
    setOpinionNoticeMode(actionEl.dataset.mode || 'table', { refresh: false });
    return;
  }

  if (action === 'set-workspace-view') {
    setDecisionWorkspaceView(actionEl.dataset.workspaceView || 'combination');
    return;
  }

  if (action === 'close-workspace-modal') {
    closeWorkspaceModal(actionEl.dataset.modalId || '');
    return;
  }

  if (action === 'review-close-inline-position') {
    closeEvidenceInlinePositionViewer();
    return;
  }

  if (action === 'copy-export-tsv') {
    const tsv = typeof buildOpinionNoticeTsv === 'function' ? buildOpinionNoticeTsv() : '';
    copyWorkspaceTextToClipboard(tsv).then((ok) => {
      if (!ok) {
        alert('표 TSV 복사에 실패했습니다.');
      }
    });
    return;
  }

  if (action === 'open-evidence-review-modal') {
    const claimIdForModal = getWorkspaceClaimIdFromUi(actionEl);
    if (claimIdForModal === null) {
      alert('증거 리뷰를 열 청구항이 없습니다.');
      return;
    }
    const workspaceForModal = recomputeClaimWorkspace(claimIdForModal, { persist: false });
    if (!workspaceForModal) return;
    if (!workspaceForModal.manualReview || typeof workspaceForModal.manualReview !== 'object') {
      workspaceForModal.manualReview = {};
    }
    if (!workspaceForModal.manualReview.filters || typeof workspaceForModal.manualReview.filters !== 'object') {
      workspaceForModal.manualReview.filters = {};
    }
    workspaceForModal.manualReview.filters.active = 'review_queue';
    renderEvidenceReviewPanel(claimIdForModal, workspaceForModal);
    renderDecisionWorkspaceMeta(claimIdForModal, workspaceForModal);
    closeEvidenceInlinePositionViewer();
    openWorkspaceModal('workspace-evidence-review-modal');
    return;
  }

  if (action === 'open-combination-modal') {
    const claimIdForModal = getWorkspaceClaimIdFromUi(actionEl);
    if (claimIdForModal === null) {
      alert('인용발명 조합을 열 청구항이 없습니다.');
      return;
    }
    const resultForModal = getClaimResultForWorkspace(claimIdForModal);
    const workspaceForModal = recomputeClaimWorkspace(claimIdForModal, { persist: false });
    if (!workspaceForModal) return;
    renderDocRoleRecommendationPanel(claimIdForModal, workspaceForModal, resultForModal?.ClaimFeatures || []);
    renderCombinationWorkspacePanel(claimIdForModal, workspaceForModal);
    openWorkspaceModal('workspace-combination-modal');
    return;
  }

  if (action === 'open-llmcheck-modal') {
    const claimIdForModal = getWorkspaceClaimIdFromUi(actionEl);
    if (claimIdForModal === null) {
      alert('진보성 검토를 열 청구항이 없습니다.');
      return;
    }
    const workspaceForModal = recomputeClaimWorkspace(claimIdForModal, { persist: false });
    if (!workspaceForModal) return;
    renderLlmCheckPanel(claimIdForModal, workspaceForModal);
    openWorkspaceModal('workspace-llmcheck-modal');
    return;
  }

  if (action === 'run-opinion-llmcheck') {
    const claimIdForModal = getWorkspaceClaimIdFromUi(actionEl);
    if (claimIdForModal === null) {
      alert('진보성 검토를 열 청구항이 없습니다.');
      return;
    }
    const workspaceForModal = recomputeClaimWorkspace(claimIdForModal, { persist: false });
    if (!workspaceForModal) return;
    renderLlmCheckPanel(claimIdForModal, workspaceForModal);
    openWorkspaceModal('workspace-llmcheck-modal');
    return;
  }

  const claimId = getWorkspaceClaimIdFromUi(actionEl);
  if (claimId === null) return;

  const workspace = ensureClaimWorkspace(claimId);
  if (!workspace) return;

  switch (action) {
    case 'confirm-primary': {
      const docName = String(actionEl.dataset.docName || '').trim();
      workspace.selection.primaryDocName = docName;
      recomputeClaimWorkspace(claimId);
      renderResultTable(claimId);
      refreshOpinionNoticeCard({ syncClaimSelect: false });
      break;
    }

    case 'select-support-candidate': {
      const featureId = String(actionEl.dataset.featureId || '').trim();
      const docName = String(actionEl.dataset.docName || '').trim();
      if (!featureId) return;
      workspace.selection.supportDocsByFeature[featureId] = docName;
      recomputeClaimWorkspace(claimId);
      renderResultTable(claimId);
      refreshOpinionNoticeCard({ syncClaimSelect: false });
      break;
    }

    case 'review-filter': {
      const filter = normalizeWorkspaceFilter(actionEl.dataset.filter || 'all');
      workspace.manualReview.filters.active = filter;
      saveAnalysisResultsToStorage();
      renderDecisionWorkspace(claimId);
      break;
    }

    case 'review-group': {
      const groupBy = normalizeWorkspaceGroupBy(actionEl.dataset.groupBy || 'feature');
      workspace.manualReview.groupBy = groupBy;
      saveAnalysisResultsToStorage();
      renderDecisionWorkspace(claimId);
      break;
    }

    case 'review-toggle-expand': {
      const evidenceId = normalizeEvidenceId(actionEl.dataset.evidenceId || '');
      if (!evidenceId) return;
      const updated = toggleEvidenceCardExpandedState(workspace, evidenceId);
      if (!updated) return;
      saveAnalysisResultsToStorage();
      renderEvidenceReviewPanel(claimId, workspace);
      break;
    }

    case 'review-expand-context': {
      const evidenceId = normalizeEvidenceId(actionEl.dataset.evidenceId || '');
      const direction = String(actionEl.dataset.direction || '').trim().toLowerCase();
      if (!evidenceId || (direction !== 'prev' && direction !== 'next')) return;
      const updated = updateEvidenceContextWindowState(workspace, evidenceId, direction);
      if (!updated) return;
      saveAnalysisResultsToStorage();
      renderEvidenceReviewPanel(claimId, workspace);
      break;
    }

    case 'review-open-position': {
      const evidenceId = normalizeEvidenceId(actionEl.dataset.evidenceId || '');
      if (!evidenceId) return;
      const inlineOpened = openEvidenceInlinePositionViewer(claimId, evidenceId, actionEl);
      if (inlineOpened) break;
      const targetEntry = getAllEvidenceEntriesForClaim(claimId).find((entry) => entry.evidenceId === evidenceId);
      if (!targetEntry) return;
      if (typeof openPositionModal === 'function') {
        openPositionModal(targetEntry.docName, targetEntry.position, targetEntry.content || '');
      }
      break;
    }

    case 'review-decision': {
      const evidenceId = actionEl.dataset.evidenceId || '';
      const decision = normalizeWorkspaceDecision(actionEl.dataset.decision || 'system');
      const currentDecision = normalizeWorkspaceDecision(actionEl.dataset.currentDecision || '');
      const nextDecision = decision === currentDecision ? 'system' : decision;
      applyWorkspaceDecision(claimId, evidenceId, nextDecision);
      recomputeClaimWorkspace(claimId);
      renderResultTable(claimId);
      refreshOpinionNoticeCard({ syncClaimSelect: false });
      break;
    }

    case 'jump-draft-evidence': {
      const evidenceId = normalizeEvidenceId(actionEl.dataset.evidenceId || '');
      if (!evidenceId) {
        alert('해당 문장에 연결된 증거가 없습니다.');
        break;
      }
      const opened = openEvidenceReviewModalForEvidenceJump(claimId, evidenceId);
      if (!opened) {
        alert('연결된 증거 카드를 찾지 못했습니다.');
      }
      break;
    }

    case 'copy-draft-full': {
      const draft = buildOpinionNoticeDraft(claimId);
      const fullText = buildFullDraftText(draft);
      copyWorkspaceTextToClipboard(fullText).then((ok) => {
        if (!ok) {
          alert('문안 복사에 실패했습니다.');
        }
      });
      break;
    }

    case 'copy-draft-block': {
      const sectionKey = String(actionEl.dataset.sectionKey || '').trim();
      const draft = buildOpinionNoticeDraft(claimId);
      const section = buildDraftSectionDefs(draft).find((item) => item.key === sectionKey);
      const text = section ? `${section.title}\n${section.content || '-'}` : '';
      copyWorkspaceTextToClipboard(text).then((ok) => {
        if (!ok) {
          alert('문안 블록 복사에 실패했습니다.');
        }
      });
      break;
    }

    case 'run-llm-check': {
      runOpinionNoticeLlmCheck(claimId).catch((error) => {
        alert(error?.message || String(error) || '진보성 검토 실행에 실패했습니다.');
      });
      break;
    }

    default:
      break;
  }
}

function handleWorkspaceChange(event) {
  const actionEl = event.target.closest('[data-ws-action]');
  if (!actionEl) return;

  const action = String(actionEl.dataset.wsAction || '').trim();
  if (!action) return;

  const claimId = getWorkspaceClaimIdFromUi(actionEl);
  if (claimId === null) return;

  const workspace = ensureClaimWorkspace(claimId);
  if (!workspace) return;

  if (action === 'support-select') {
    const featureId = String(actionEl.dataset.featureId || '').trim();
    const docName = String(actionEl.value || '').trim();
    if (!featureId) return;
    workspace.selection.supportDocsByFeature[featureId] = docName;
    recomputeClaimWorkspace(claimId);
    renderResultTable(claimId);
    refreshOpinionNoticeCard({ syncClaimSelect: false });
    return;
  }

  if (action === 'tag-toggle') {
    const featureId = String(actionEl.dataset.featureId || '').trim();
    const tag = String(actionEl.dataset.tag || '').trim();
    if (!featureId || !tag || !WORKSPACE_COMBINATION_TAGS.includes(tag)) return;

    const currentTags = Array.isArray(workspace.selection.combinationTagsByFeature[featureId])
      ? workspace.selection.combinationTagsByFeature[featureId]
      : [];

    const nextTags = new Set(currentTags);
    if (actionEl.checked) {
      nextTags.add(tag);
    } else {
      nextTags.delete(tag);
    }

    workspace.selection.combinationTagsByFeature[featureId] = [...nextTags];
    recomputeClaimWorkspace(claimId);
    renderDecisionWorkspace(claimId);
    refreshOpinionNoticeCard({ syncClaimSelect: false });
    return;
  }

  if (action === 'combination-note') {
    const featureId = String(actionEl.dataset.featureId || '').trim();
    if (!featureId) return;
    workspace.selection.combinationNotesByFeature[featureId] = String(actionEl.value || '').trim();
    recomputeClaimWorkspace(claimId);
    renderOpinionNoticeDraftWorkspace(claimId);
    if (getOpinionNoticeMode() !== 'table') {
      setOpinionNoticeMode(getOpinionNoticeMode(), { persist: false, refresh: false });
    }
    return;
  }

  if (action === 'review-note') {
    const evidenceId = String(actionEl.dataset.evidenceId || '').trim();
    applyWorkspaceEvidenceNote(claimId, evidenceId, actionEl.value || '');
    saveAnalysisResultsToStorage();
    return;
  }

  if (action === 'llmcheck-prompt') {
    workspace.llmCheck.prompt = String(actionEl.value || '');
    saveAnalysisResultsToStorage();
  }
}

function restoreOpinionNoticeMode() {
  let saved = 'table';
  try {
    saved = localStorage.getItem(OPINION_NOTICE_MODE_STORAGE_KEY) || 'table';
  } catch (error) {
    console.warn('Failed to restore opinion notice mode:', error);
  }
  setOpinionNoticeMode(saved, { persist: false, refresh: false });
}

function initializeDecisionWorkspaceUI() {
  ensureDecisionWorkspaceLayout();
  ensureWorkspaceModalLayouts();
  ensureOpinionNoticeWorkspaceLayout();
  restoreDecisionWorkspaceView();
  restoreOpinionNoticeMode();

  if (decisionWorkspaceUiBound) return;
  decisionWorkspaceUiBound = true;

  document.addEventListener('click', handleWorkspaceClick);
  document.addEventListener('change', handleWorkspaceChange);
}
