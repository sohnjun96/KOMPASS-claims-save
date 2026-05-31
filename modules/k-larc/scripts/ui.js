function setSortOrder(order) {
  currentSortOrder = order;
  document.getElementById('btn-sort-by-doc').classList.toggle('active', order === 'doc_then_feature');
  document.getElementById('btn-sort-by-feature').classList.toggle('active', order === 'feature_then_doc');
  const dockValue = Number.parseInt(document.getElementById('dock-claim-select')?.value || '', 10);
  const resultValue = Number.parseInt(document.getElementById('result-claim-select')?.value || '', 10);
  const claimId = Number.isFinite(selectedResultClaimId)
    ? selectedResultClaimId
    : (Number.isFinite(dockValue) ? dockValue : resultValue);
  if (Number.isFinite(claimId)) {
    renderResultTable(claimId);
  }
}

let modalFocusRestoreElement = null;
const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const ANALYSIS_MODE_STORAGE_KEY = 'analysisModeActive';
const ANALYSIS_EXECUTION_MODE_STORAGE_KEY = 'analysisExecutionMode';
const WORKSPACE_VIEW_STORAGE_KEY = 'kLarcWorkspaceView';
const WORKSPACE_VIEW_ORDER = Object.freeze(['result', 'notice', 'chat', 'debug']);
const ANALYSIS_STEP_PILL_LABELS = Object.freeze({
  A: '구성요소',
  B: 'RAG',
  C: '판정',
  D: '보정',
  E: '검증'
});
const WORKSPACE_VIEW_DEBUG_TAB_MAP = Object.freeze({
  A: 'stepA',
  B: 'stepB',
  C: 'stepC',
  D: 'stepD',
  E: 'verification'
});

function normalizeWorkspaceView(view) {
  const normalized = String(view || '').trim().toLowerCase();
  if (WORKSPACE_VIEW_ORDER.includes(normalized)) return normalized;
  return 'result';
}

function isWorkspaceViewAvailable(view) {
  const normalized = normalizeWorkspaceView(view);
  if (normalized === 'debug') {
    if (!DEV_FLAGS.SHOW_DEBUG_PANEL) return false;
    const panel = document.querySelector('[data-workspace-section="debug"]');
    if (!panel) return false;
    if (panel.classList.contains('hidden')) return false;
  }
  return WORKSPACE_VIEW_ORDER.includes(normalized);
}

function setWorkspaceView(view, options = {}) {
  const normalized = normalizeWorkspaceView(view);
  const nextView = isWorkspaceViewAvailable(normalized) ? normalized : 'result';

  document.querySelectorAll('[data-workspace-section]').forEach((section) => {
    const sectionView = normalizeWorkspaceView(section.dataset.workspaceSection);
    const isActive = sectionView === nextView;
    section.classList.toggle('is-active', isActive);
    section.setAttribute('aria-hidden', isActive ? 'false' : 'true');
  });

  document.querySelectorAll('[data-workspace-view-btn]').forEach((button) => {
    const buttonView = normalizeWorkspaceView(button.dataset.workspaceViewBtn);
    const isAvailable = isWorkspaceViewAvailable(buttonView);
    const isActive = buttonView === nextView;
    button.classList.toggle('hidden', !isAvailable);
    button.disabled = !isAvailable;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  if (options.persist === false) return;
  try {
    localStorage.setItem(WORKSPACE_VIEW_STORAGE_KEY, nextView);
  } catch (error) {
    console.warn('Failed to persist workspace view:', error);
  }
}

function restoreWorkspaceView() {
  let saved = null;
  try {
    saved = localStorage.getItem(WORKSPACE_VIEW_STORAGE_KEY);
  } catch (error) {
    console.warn('Failed to read workspace view:', error);
  }
  setWorkspaceView(saved || 'result', { persist: false });
}

function bindWorkspaceSwitchButtons() {
  document.querySelectorAll('[data-workspace-view-btn]').forEach((button) => {
    if (button.dataset.boundWorkspaceSwitch === 'true') return;
    button.dataset.boundWorkspaceSwitch = 'true';
    button.addEventListener('click', () => {
      const targetView = button.dataset.workspaceViewBtn;
      setWorkspaceView(targetView);
    });
  });
}

function getTrackedClaimsForDock() {
  return (claims || []).filter(claim => String(claim?.text || '').trim());
}

function normalizeStepStateForDock(rawState) {
  if (rawState === 'done') return 'done';
  if (rawState === 'error') return 'error';
  if (rawState === 'active' || rawState === 'running') return 'running';
  return 'pending';
}

function resolveClaimStepStateForDock(claimId, stepId) {
  const progress = getClaimProgress(claimId);
  const rawState = progress?.steps?.[stepId];
  if (rawState) return normalizeStepStateForDock(rawState);
  if (progress?.status === 'done') return 'done';
  if (progress?.status === 'error') return stepId === progress?.currentStep ? 'error' : 'pending';
  return 'pending';
}

function getDockAggregateStepState(stepId, trackedClaims) {
  if (!Array.isArray(trackedClaims) || trackedClaims.length === 0) {
    return 'pending';
  }

  let hasRunning = false;
  let hasError = false;
  let allDone = true;
  trackedClaims.forEach((claim) => {
    const state = resolveClaimStepStateForDock(claim.id, stepId);
    if (state === 'error') hasError = true;
    if (state === 'running') hasRunning = true;
    if (state !== 'done') allDone = false;
  });

  if (hasError) return 'error';
  if (hasRunning) return 'running';
  if (allDone) return 'done';
  return 'pending';
}

function handleDockStepPillClick(stepId) {
  if (!DEV_FLAGS.SHOW_DEBUG_PANEL || !isWorkspaceViewAvailable('debug')) return;
  const debugTab = WORKSPACE_VIEW_DEBUG_TAB_MAP[stepId];
  if (!debugTab) return;
  setWorkspaceView('debug');
  debugState.tab = debugTab;
  renderDebugContent();
}

function updateAnalysisCommandDock() {
  const claimsMetric = document.getElementById('dock-metric-claims');
  const citationsMetric = document.getElementById('dock-metric-citations');
  const progressMetric = document.getElementById('dock-metric-progress');
  const modeMetric = document.getElementById('dock-metric-mode');
  const stepPills = document.getElementById('analysis-step-pills');
  if (!claimsMetric || !citationsMetric || !progressMetric || !modeMetric || !stepPills) return;

  const trackedClaims = getTrackedClaimsForDock();
  const totalClaims = trackedClaims.length;
  const totalCitations = Array.isArray(citations) ? citations.length : 0;
  const completedCitations = (citations || []).filter(citation => citation?.status === 'completed').length;
  const completedClaims = trackedClaims.filter((claim) => {
    const progress = getClaimProgress(claim.id);
    if (progress?.status === 'done') return true;
    const result = analysisResults?.[claim.id];
    return !!result && !result.error;
  }).length;
  const runningClaims = trackedClaims.filter((claim) => getClaimProgress(claim.id)?.status === 'running').length;

  claimsMetric.textContent = `청구항 ${totalClaims}`;
  citationsMetric.textContent = `인용발명 ${completedCitations}/${totalCitations}`;
  progressMetric.textContent = runningClaims > 0
    ? `진행 ${runningClaims} · 완료 ${completedClaims}/${totalClaims}`
    : `완료 ${completedClaims}/${totalClaims}`;
  modeMetric.textContent = `Mode ${getAnalysisExecutionMode() === 'quick' ? 'Quick' : 'Deep'}${isAnalysisRunning ? ' · Running' : ''}`;

  stepPills.innerHTML = '';
  ANALYSIS_STEPS.forEach((stepId) => {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = `analysis-step-pill state-${getDockAggregateStepState(stepId, trackedClaims)}`;
    pill.dataset.stepId = stepId;
    pill.innerHTML = `<span class="pill-step">${stepId}</span><span class="pill-label">${ANALYSIS_STEP_PILL_LABELS[stepId] || stepId}</span>`;
    pill.title = `단계 ${stepId} 상태 보기`;
    pill.addEventListener('click', () => handleDockStepPillClick(stepId));
    stepPills.appendChild(pill);
  });
}

function getSavedAnalysisMode() {
  try {
    const saved = localStorage.getItem(ANALYSIS_MODE_STORAGE_KEY);
    if (saved === 'true') return true;
    if (saved === 'false') return false;
  } catch (error) {
    console.warn('Failed to read analysis mode:', error);
  }
  return null;
}

function normalizeAnalysisExecutionMode(mode) {
  return String(mode || '').toLowerCase() === 'quick' ? 'quick' : 'deep';
}

function getSavedAnalysisExecutionMode() {
  try {
    const saved = localStorage.getItem(ANALYSIS_EXECUTION_MODE_STORAGE_KEY);
    if (saved === 'quick' || saved === 'deep') return saved;
  } catch (error) {
    console.warn('Failed to read analysis execution mode:', error);
  }
  return null;
}

function syncAnalysisExecutionModeToggle() {
  const normalized = normalizeAnalysisExecutionMode(analysisExecutionMode);
  const toggle = document.querySelector('.analysis-mode-toggle');
  const deepRadio = document.getElementById('analysis-mode-deep');
  const quickRadio = document.getElementById('analysis-mode-quick');

  if (toggle) {
    toggle.dataset.mode = normalized;
  }
  if (deepRadio) deepRadio.checked = normalized === 'deep';
  if (quickRadio) quickRadio.checked = normalized === 'quick';
}

function setAnalysisExecutionMode(mode, options = {}) {
  const normalized = normalizeAnalysisExecutionMode(mode);
  analysisExecutionMode = normalized;
  syncAnalysisExecutionModeToggle();
  updateAnalysisCommandDock();

  if (options.persist === false) return;
  try {
    localStorage.setItem(ANALYSIS_EXECUTION_MODE_STORAGE_KEY, normalized);
  } catch (error) {
    console.warn('Failed to persist analysis execution mode:', error);
  }
}

function getAnalysisExecutionMode() {
  return normalizeAnalysisExecutionMode(analysisExecutionMode);
}

function restoreAnalysisExecutionMode() {
  const saved = getSavedAnalysisExecutionMode();
  setAnalysisExecutionMode(saved || 'deep', { persist: false });
}

function formatAnalysisElapsedText(elapsedMs) {
  const totalSeconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = value => String(value).padStart(2, '0');
  if (hours > 0) {
    return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${pad(seconds)}s`;
  }
  return `${seconds}s`;
}

function renderAnalysisElapsedTime() {
  const button = document.getElementById('btn-analyze');
  if (!button || !analysisStartedAt) return;

  const elapsedText = formatAnalysisElapsedText(Date.now() - analysisStartedAt);
  button.innerHTML = `Running analysis... (${elapsedText})`;

}

function setAnalyzeButtonState(isRunning) {
  const button = document.getElementById('btn-analyze');
  if (!button) return;

  if (!button.dataset.defaultHtml) {
    button.dataset.defaultHtml = button.innerHTML;
  }

  button.disabled = !!isRunning;
  button.classList.toggle('is-loading', !!isRunning);

  if (isRunning) {
    analysisStartedAt = Date.now();
    if (analysisElapsedTimerId) {
      clearInterval(analysisElapsedTimerId);
    }
    renderAnalysisElapsedTime();
    analysisElapsedTimerId = window.setInterval(renderAnalysisElapsedTime, 1000);
    button.setAttribute('aria-busy', 'true');
  } else {
    if (analysisElapsedTimerId) {
      clearInterval(analysisElapsedTimerId);
      analysisElapsedTimerId = null;
    }
    analysisStartedAt = null;
    button.innerHTML = button.dataset.defaultHtml;
    button.removeAttribute('aria-busy');

  }

  const editButton = document.getElementById('btn-edit-mode');
  if (editButton) {
    editButton.disabled = !!isRunning;
  }

  document.querySelectorAll('input[name="analysis-execution-mode"]').forEach(input => {
    input.disabled = !!isRunning;
  });

  updateAnalysisCommandDock();
}

function getFocusableElements(container) {
  if (!container) return [];
  return [...container.querySelectorAll(FOCUSABLE_SELECTOR)]
    .filter(el => el.getClientRects().length > 0 || el === document.activeElement);
}

function openDialogModal(modalId, focusSelector) {
  const modal = document.getElementById(modalId);
  if (!modal) return;

  modalFocusRestoreElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');

  const preferred = focusSelector ? modal.querySelector(focusSelector) : null;
  const focusables = getFocusableElements(modal);
  const target = preferred || focusables[0] || modal;
  if (target && typeof target.focus === 'function') {
    target.focus();
  }
}

function closeDialogModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;

  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');

  if (modalFocusRestoreElement && document.contains(modalFocusRestoreElement)) {
    modalFocusRestoreElement.focus();
  }
  modalFocusRestoreElement = null;
}

function getOpenModalElement() {
  return document.querySelector('.modal-overlay:not(.hidden)');
}

function trapFocusInOpenModal(event) {
  const modal = getOpenModalElement();
  if (!modal || event.key !== 'Tab') return;

  const focusables = getFocusableElements(modal);
  if (focusables.length === 0) return;

  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;

  if (event.shiftKey) {
    if (active === first || !modal.contains(active)) {
      event.preventDefault();
      last.focus();
    }
    return;
  }

  if (active === last || !modal.contains(active)) {
    event.preventDefault();
    first.focus();
  }
}

function closeTopModal() {
  if (typeof closeActiveWorkspaceModal === 'function' && closeActiveWorkspaceModal()) {
    return true;
  }

  const llmSettingsModal = document.getElementById('llm-settings-modal');
  if (llmSettingsModal && !llmSettingsModal.classList.contains('hidden')) {
    if (typeof closeOpenWebUiSettingsModal === 'function') {
      closeOpenWebUiSettingsModal();
    } else {
      closeDialogModal('llm-settings-modal');
    }
    return true;
  }

  const positionModal = document.getElementById('position-modal');
  if (positionModal && !positionModal.classList.contains('hidden')) {
    closePositionModal();
    return true;
  }

  const verificationModal = document.getElementById('verification-modal');
  if (verificationModal && !verificationModal.classList.contains('hidden')) {
    closeVerificationModal();
    return true;
  }

  const directAddModal = document.getElementById('direct-add-modal');
  if (directAddModal && !directAddModal.classList.contains('hidden')) {
    closeDirectAddModal();
    return true;
  }

  const previewModal = document.getElementById('preview-modal');
  if (previewModal && !previewModal.classList.contains('hidden')) {
    closeModal();
    return true;
  }

  return false;
}

function handleGlobalEscapeKey() {
  if (closeTopModal()) return true;

  if (document.body.classList.contains('settings-open')) {
    document.body.classList.remove('settings-open');
    return true;
  }

  return false;
}

function normalizeSummaryText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function truncateSummaryText(text, maxLength = 36) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 3))}...`;
}

function buildClaimHeaderSummary() {
  const total = claims.length;
  const filled = claims.filter(c => normalizeSummaryText(c.text)).length;
  if (total === 0) return 'No claims added';

  const previews = claims.map(claim => {
    const text = normalizeSummaryText(claim.text) || '(No content)';
    return `${claim.name}: ${truncateSummaryText(text, 28)}`;
  });

  return `${filled}/${total} filled | ${previews.join(' | ')}`;
}

function buildCitationHeaderSummary() {
  const total = citations.length;
  const completed = citations.filter(c => c.status === 'completed').length;
  if (total === 0) return 'No references added';

  const titles = citations
    .map(c => truncateSummaryText(normalizeSummaryText(c.title || c.name || c.url || ''), 28))
    .filter(Boolean);
  const titleSummary = titles.length > 0 ? titles.join(' | ') : 'No title/url';

  return `${completed}/${total} completed | ${titleSummary}`;
}

function updateInputPanelHeaders() {
  const claimsTitle = document.getElementById('claims-panel-title');
  if (claimsTitle) {
    claimsTitle.textContent = `청구항 (${claims.length})`;
  }

  const citationsTitle = document.getElementById('citations-panel-title');
  if (citationsTitle) {
    citationsTitle.textContent = `인용발명 (${citations.length})`;
  }

  const claimMeta = document.getElementById('claims-panel-meta');
  if (claimMeta) {
    const summary = buildClaimHeaderSummary();
    claimMeta.textContent = summary;
    claimMeta.title = summary;
  }

  const citationMeta = document.getElementById('citations-panel-meta');
  if (citationMeta) {
    const summary = buildCitationHeaderSummary();
    citationMeta.textContent = summary;
    citationMeta.title = summary;
  }

  updateAnalysisCommandDock();
}

function getInputPanelElement(panelType) {
  const panelId = panelType === 'claims' ? 'claims-panel' : 'citations-panel';
  return document.getElementById(panelId);
}

function getInputPanelToggleButton(panelType) {
  const buttonId = panelType === 'claims' ? 'btn-toggle-claims-panel' : 'btn-toggle-citations-panel';
  return document.getElementById(buttonId);
}

function setInputPanelCollapsed(panelType, collapsed) {
  const panel = getInputPanelElement(panelType);
  if (!panel) return;

  panel.classList.toggle('panel-collapsed', !!collapsed);

  const toggleButton = getInputPanelToggleButton(panelType);
  if (toggleButton) {
    toggleButton.setAttribute('aria-expanded', String(!collapsed));
    toggleButton.setAttribute('title', collapsed ? 'Expand panel' : 'Collapse panel');
  }
}

function toggleInputPanelCollapse(panelType) {
  if (!document.body.classList.contains('analysis-active')) return;

  const panel = getInputPanelElement(panelType);
  if (!panel) return;

  const collapsed = panel.classList.contains('panel-collapsed');
  setInputPanelCollapsed(panelType, !collapsed);
}

function setResultPanelCollapsed(collapsed) {
  const panel = document.getElementById('analysis-result-panel') || document.querySelector('.result-panel');
  if (!panel) return;

  panel.classList.toggle('panel-collapsed', !!collapsed);

  const toggleButton = document.getElementById('btn-toggle-result-panel');
  if (toggleButton) {
    toggleButton.setAttribute('aria-expanded', String(!collapsed));
    toggleButton.setAttribute('title', collapsed ? 'Expand panel' : 'Collapse panel');
  }
}

function toggleResultPanelCollapse() {
  const panel = document.getElementById('analysis-result-panel') || document.querySelector('.result-panel');
  if (!panel) return;

  const collapsed = panel.classList.contains('panel-collapsed');
  setResultPanelCollapsed(!collapsed);
}

function syncInputPanelLayoutForMode(active) {
  setInputPanelCollapsed('claims', !!active);
  setInputPanelCollapsed('citations', !!active);
}

function getDefaultClaimStepMap() {
  return ANALYSIS_STEPS.reduce((acc, step) => {
    acc[step] = 'pending';
    return acc;
  }, {});
}

function getClaimProgress(claimId) {
  if (claimId === null || claimId === undefined) return null;
  return claimProgressById[String(claimId)] || null;
}

function ensureClaimProgressEntry(claimId, claimName = '') {
  const key = String(claimId);
  if (!claimProgressById[key]) {
    claimProgressById[key] = {
      claimId,
      claimName,
      status: 'pending',
      currentStep: null,
      stepMessage: '',
      steps: getDefaultClaimStepMap(),
      updatedAt: Date.now()
    };
  }

  if (claimName && !claimProgressById[key].claimName) {
    claimProgressById[key].claimName = claimName;
  }
  return claimProgressById[key];
}

function initializeClaimProgress(claimList) {
  claimProgressById = {};
  (claimList || []).forEach((claim, index) => {
    const entry = ensureClaimProgressEntry(claim.id, claim.name || `Claim ${index + 1}`);
    entry.order = index + 1;
  });
  refreshResultClaimSelect(claimList);
  updateAnalysisCommandDock();
}

function initializeClaimProgressFromSavedResults(claimList) {
  claimProgressById = {};
  (claimList || []).forEach((claim, index) => {
    const entry = ensureClaimProgressEntry(claim.id, claim.name || `Claim ${index + 1}`);
    entry.order = index + 1;
    const result = analysisResults?.[claim.id];
    if (!result) return;

    if (result.error) {
      entry.status = 'error';
      entry.currentStep = 'E';
      entry.stepMessage = result.error;
      entry.steps.E = 'error';
      return;
    }

    entry.status = 'done';
    entry.currentStep = 'E';
    entry.stepMessage = 'Completed';
    ANALYSIS_STEPS.forEach(step => {
      entry.steps[step] = 'done';
    });
  });
  refreshResultClaimSelect(claimList);
  updateAnalysisCommandDock();
}

function renderSelectedClaimResultIfVisible(claimId) {
  const dockValue = Number.parseInt(document.getElementById('dock-claim-select')?.value || '', 10);
  const selectedValue = Number.parseInt(document.getElementById('result-claim-select')?.value || '', 10);
  const selectedId = Number.isFinite(selectedResultClaimId)
    ? selectedResultClaimId
    : (Number.isFinite(dockValue) ? dockValue : selectedValue);
  if (!Number.isFinite(selectedId)) return;
  if (String(selectedId) !== String(claimId)) return;
  renderResultTable(selectedId);
}

function setClaimStepState(claimId, stepId, state, stepMessage = '') {
  const claim = claims.find(c => String(c.id) === String(claimId));
  const progress = ensureClaimProgressEntry(claimId, claim?.name || '');
  progress.steps[stepId] = state;

  if (state === 'active') {
    progress.status = 'running';
    progress.currentStep = stepId;
  } else if (state === 'error') {
    progress.status = 'error';
    progress.currentStep = stepId;
  } else if (state === 'done') {
    const hasAnyActive = ANALYSIS_STEPS.some(step => progress.steps[step] === 'active');
    if (!hasAnyActive) {
      const nextPending = ANALYSIS_STEPS.find(step => progress.steps[step] === 'pending');
      progress.currentStep = nextPending || stepId;
    }
    if (progress.status === 'pending') {
      progress.status = 'running';
    }
  }

  if (stepMessage) {
    progress.stepMessage = stepMessage;
  }

  progress.updatedAt = Date.now();
  refreshResultClaimSelect();
  renderSelectedClaimResultIfVisible(claimId);
  updateAnalysisCommandDock();
}

function setClaimProgressStatus(claimId, status, stepMessage = '') {
  const claim = claims.find(c => String(c.id) === String(claimId));
  const progress = ensureClaimProgressEntry(claimId, claim?.name || '');
  progress.status = status;

  if (status === 'done') {
    ANALYSIS_STEPS.forEach(step => {
      if (progress.steps[step] !== 'error') {
        progress.steps[step] = 'done';
      }
    });
    progress.currentStep = 'E';
  }

  if (stepMessage) {
    progress.stepMessage = stepMessage;
  }

  progress.updatedAt = Date.now();
  refreshResultClaimSelect();
  renderSelectedClaimResultIfVisible(claimId);
  updateAnalysisCommandDock();
}

function setClaimProgressMessage(claimId, message) {
  const claim = claims.find(c => String(c.id) === String(claimId));
  const progress = ensureClaimProgressEntry(claimId, claim?.name || '');
  progress.stepMessage = message || '';
  progress.updatedAt = Date.now();
  renderSelectedClaimResultIfVisible(claimId);
  updateAnalysisCommandDock();
}

function getClaimProgressTag(progress) {
  if (!progress) return 'Pending';
  if (progress.status === 'done') return 'Completed';
  if (progress.status === 'error') return 'Error';
  if (progress.status === 'running') return `Running ${progress.currentStep || '-'}`;
  return 'Pending';
}

function selectResultClaim(claimId, options = {}) {
  const parsedClaimId = Number.parseInt(claimId, 10);
  if (!Number.isFinite(parsedClaimId)) return;

  selectedResultClaimId = parsedClaimId;
  const nextValue = String(parsedClaimId);

  ['dock-claim-select', 'result-claim-select', 'notice-claim-select', 'debug-claim-select'].forEach((selectId) => {
    const select = document.getElementById(selectId);
    if (!select || !select.options || select.options.length === 0) return;
    const hasValue = Array.from(select.options).some(option => String(option.value) === nextValue);
    if (!hasValue) return;
    select.value = nextValue;
  });

  if (DEV_FLAGS.SHOW_DEBUG_PANEL && debugState && options.syncDebugState !== false) {
    debugState.claimId = parsedClaimId;
  }

  if (options.render === false) return;
  renderResultTable(parsedClaimId);
}
function refreshResultClaimSelect(claimList = claims.filter(c => (c.text || '').trim())) {
  const claimSelect = document.getElementById('result-claim-select');
  const dockClaimSelect = document.getElementById('dock-claim-select');
  if (!claimSelect && !dockClaimSelect) return;

  const selectList = [claimSelect, dockClaimSelect].filter(Boolean);

  const previous = Number.isFinite(selectedResultClaimId)
    ? selectedResultClaimId
    : Number.parseInt(dockClaimSelect?.value || claimSelect?.value || '', 10);

  selectList.forEach((select) => {
    select.innerHTML = '';
    (claimList || []).forEach(claim => {
      const option = document.createElement('option');
      const progress = getClaimProgress(claim.id);
      option.value = String(claim.id);
      option.textContent = `${claim.name} [${getClaimProgressTag(progress)}]`;
      select.appendChild(option);
    });
  });

  if (!claimList || claimList.length === 0) {
    selectedResultClaimId = null;
    return;
  }

  const existsPrevious = Number.isFinite(previous)
    && (claimList || []).some(claim => String(claim.id) === String(previous));
  const nextId = existsPrevious
    ? previous
    : Number.parseInt(claimList[0]?.id, 10);
  if (Number.isFinite(nextId)) {
    selectResultClaim(nextId, { render: false });
  }
}

function showProgress(stepLabel, index, total, claimName) {
  const emptyState = document.querySelector('.result-panel .empty-state');
  if (!emptyState) return;
  const countText = total ? `(${index}/${total})` : '';
  const nameText = claimName ? ` ${claimName}` : '';
  const detail = `${countText}${nameText}`.trim();
  emptyState.style.display = 'block';
  emptyState.innerHTML = detail
    ? `${stepLabel} in progress...<br>${detail}`
    : `${stepLabel} in progress...`;
}

function showParallelProgress(stepLabel, meta, featureId, done, total) {
  const emptyState = document.querySelector('.result-panel .empty-state');
  if (!emptyState) return;
  const countText = meta?.totalClaims ? `(${meta.claimIndex}/${meta.totalClaims})` : '';
  const nameText = meta?.claimName ? ` ${meta.claimName}` : '';
  const featureLabel = featureId && String(featureId).startsWith('Q') ? 'Primary claim' : 'Element';
  const featureText = featureId ? ` ${featureLabel} ${featureId}` : '';
  const progressText = total ? ` ${done}/${total}` : '';
  const detail = `${countText}${nameText}${featureText}${progressText}`.trim();
  emptyState.style.display = 'block';
  emptyState.innerHTML = detail
    ? `${stepLabel} in progress...<br>${detail}`
    : `${stepLabel} in progress...`;
}

const DEBUG_TREE_OPEN_MODE = {
  AUTO: 'auto',
  ALL: 'all',
  NONE: 'none'
};

const DEBUG_TAB_SEQUENCE = ['stepA', 'stepB', 'stepC', 'stepD', 'quick', 'verification', 'final'];
const DEBUG_STEP_SEQUENCE = ['A', 'B', 'C', 'D', 'E'];

const debugUiState = {
  searchTerm: '',
  treeOpenMode: DEBUG_TREE_OPEN_MODE.AUTO,
  stepBSelectionByClaim: {}
};

function hasDownloadableAnalysisSnapshot() {
  return Object.keys(analysisResults || {}).length > 0;
}

function updateDebugExportButtonVisibility() {
  const downloadButton = document.getElementById('btn-download-analysis-json');
  if (!downloadButton) return;

  const shouldShow = !!DEV_FLAGS.SHOW_DEBUG_PANEL
    && !isAnalysisRunning
    && hasDownloadableAnalysisSnapshot();

  downloadButton.classList.toggle('hidden', !shouldShow);
  downloadButton.disabled = !shouldShow;
}

function initDebugPanel() {
  const claimSelect = document.getElementById('debug-claim-select');
  if (claimSelect) {
    claimSelect.addEventListener('change', (e) => {
      selectResultClaim(parseInt(e.target.value, 10), { syncDebugState: true });
    });
  }

  document.querySelectorAll('.debug-tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      const tabId = e.currentTarget.dataset.tab;
      setActiveDebugTab(tabId);
      renderDebugContent();
    });
  });

  const searchInput = document.getElementById('debug-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      debugUiState.searchTerm = normalizeDebugSearchTerm(e.target.value);
      renderDebugContent();
    });
  }

  const expandAllButton = document.getElementById('btn-debug-expand-all');
  if (expandAllButton) {
    expandAllButton.addEventListener('click', () => {
      debugUiState.treeOpenMode = DEBUG_TREE_OPEN_MODE.ALL;
      renderDebugContent();
    });
  }

  const collapseAllButton = document.getElementById('btn-debug-collapse-all');
  if (collapseAllButton) {
    collapseAllButton.addEventListener('click', () => {
      debugUiState.treeOpenMode = DEBUG_TREE_OPEN_MODE.NONE;
      renderDebugContent();
    });
  }

  ensureDebugTabStructure();
  updateDebugClaimSelect();
  updateDebugExportButtonVisibility();
  renderDebugContent();
}

function setActiveDebugTab(tabId) {
  const normalizedTabId = DEBUG_TAB_SEQUENCE.includes(tabId) ? tabId : 'stepA';
  debugState.tab = normalizedTabId;

  document.querySelectorAll('.debug-tab').forEach(tab => {
    const isActive = tab.dataset.tab === normalizedTabId;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

function ensureDebugTabStructure() {
  document.querySelectorAll('.debug-tab').forEach(tab => {
    if (tab.dataset.structured === 'true') return;

    const baseLabel = tab.textContent.trim();
    tab.dataset.baseLabel = baseLabel;
    tab.textContent = '';

    const label = document.createElement('span');
    label.className = 'debug-tab-label';
    label.textContent = baseLabel;

    const badge = document.createElement('span');
    badge.className = 'debug-tab-badge none';
    badge.textContent = 'NONE';

    tab.appendChild(label);
    tab.appendChild(badge);
    tab.dataset.structured = 'true';
  });
}

function updateDebugClaimSelect() {
  const claimSelect = document.getElementById('debug-claim-select');
  if (!claimSelect) return;

  const claimIds = Object.keys(analysisResults || {});
  claimSelect.innerHTML = '';

  if (claimIds.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '(디버그 데이터 없음)';
    claimSelect.appendChild(option);
    debugState.claimId = null;
    updateDebugLastUpdatedText(null);
    updateDebugExportButtonVisibility();
    return;
  }

  const claimMap = new Map(claims.map(c => [String(c.id), c]));
  claimIds.forEach(id => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = claimMap.get(String(id))?.name || `청구항${id}`;
    claimSelect.appendChild(option);
  });

  if (!debugState.claimId || !claimIds.includes(String(debugState.claimId))) {
    debugState.claimId = parseInt(claimIds[0], 10);
  }

  claimSelect.value = String(debugState.claimId);
  updateDebugExportButtonVisibility();
}

function renderDebugContent() {
  const content = document.getElementById('debug-content');
  const queryList = document.getElementById('debug-query-list');
  const debugMain = document.getElementById('debug-main');

  if (!content) return;

  const claimId = debugState.claimId;
  const result = claimId === null || claimId === undefined
    ? null
    : (analysisResults?.[claimId] || analysisResults?.[String(claimId)] || null);

  if (!result) {
    if (debugMain) debugMain.classList.remove('debug-stepb-active');
    if (queryList) {
      queryList.classList.add('hidden');
      queryList.innerHTML = '';
    }
    hideDebugDetailHeader();
    updateDebugTabBadges(null);
    renderDebugClaimSummary(null, null);
    renderDebugEmptyState('No debug data available.');
    return;
  }

  updateDebugTabBadges(result);
  renderDebugClaimSummary(claimId, result);

  if (debugState.tab === 'stepB') {
    renderStepBView(result, claimId);
    return;
  }

  if (debugMain) debugMain.classList.remove('debug-stepb-active');
  if (queryList) {
    queryList.classList.add('hidden');
    queryList.innerHTML = '';
  }
  hideDebugDetailHeader();

  let payload = null;
  switch (debugState.tab) {
    case 'stepA':
      payload = result.debug?.stepA || { ClaimFeatures: result.ClaimFeatures || [] };
      break;
    case 'stepC':
      payload = result.debug?.stepC || null;
      break;
    case 'stepD':
      payload = result.debug?.stepD || null;
      break;
    case 'quick':
      payload = result.debug?.quick || (result.debug?.quickError ? { quickError: result.debug.quickError } : null);
      break;
    case 'verification':
      payload = {
        verifications: result.verifications || {},
        stepEInput: result.debug?.stepEInput || null,
        stepE: result.debug?.stepE || null
      };
      break;
    case 'final':
      payload = {
        ClaimFeatures: result.ClaimFeatures || [],
        Relevant: result.Relevant || {},
        FeatureStatus: result.FeatureStatus || {}
      };
      break;
    default:
      payload = null;
  }

  renderDebugPayload(payload, { emptyMessage: '선택한 탭의 디버그 데이터가 없습니다.' });
}

function renderStepBView(result, claimId) {
  const debugMain = document.getElementById('debug-main');
  const queryList = document.getElementById('debug-query-list');
  if (!queryList) return;

  if (debugMain) debugMain.classList.add('debug-stepb-active');
  queryList.classList.remove('hidden');
  queryList.innerHTML = '';

  const allEntries = buildStepBEntries(result?.debug?.stepB);
  if (allEntries.length === 0) {
    hideDebugDetailHeader();
    renderDebugEmptyState('B 단계의 디버그 데이터가 없습니다.');
    const empty = document.createElement('div');
    empty.className = 'debug-empty-state';
    empty.textContent = '분석된 쿼리 항목이 없습니다.';
    queryList.appendChild(empty);
    return;
  }

  const filteredEntries = allEntries.filter(entry => isStepBEntryMatchedBySearch(entry, debugUiState.searchTerm));
  if (filteredEntries.length === 0) {
    hideDebugDetailHeader();
    renderDebugPayload(null, { emptyMessage: '검색 조건에 맞는 B 단계 항목이 없습니다.' });
    const noMatch = document.createElement('div');
    noMatch.className = 'debug-empty-state';
    noMatch.textContent = '검색 조건에 맞는 B 단계 항목이 없습니다.';
    queryList.appendChild(noMatch);
    return;
  }

  const claimKey = String(claimId);
  let selectedKey = debugUiState.stepBSelectionByClaim[claimKey];
  if (!filteredEntries.some(entry => entry.key === selectedKey)) {
    selectedKey = filteredEntries[0].key;
  }
  debugUiState.stepBSelectionByClaim[claimKey] = selectedKey;

  filteredEntries.forEach(entry => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `debug-query-row ${entry.key === selectedKey ? 'active' : ''}`;

    const title = document.createElement('div');
    title.className = 'debug-query-row-title';

    const titleText = document.createElement('span');
    titleText.textContent = entry.label;

    const status = document.createElement('span');
    status.className = `debug-query-status ${entry.ok ? 'ok' : 'err'}`;
    status.textContent = entry.ok ? 'OK' : 'ERR';

    title.appendChild(titleText);
    title.appendChild(status);
    row.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'debug-query-row-meta';
    meta.textContent = entry.summary || '(요약 정보 없음)';
    row.appendChild(meta);

    row.addEventListener('click', () => {
      debugUiState.stepBSelectionByClaim[claimKey] = entry.key;
      renderDebugContent();
    });

    queryList.appendChild(row);
  });

  const selectedEntry = filteredEntries.find(entry => entry.key === selectedKey) || filteredEntries[0];
  showDebugDetailHeader(selectedEntry.label, selectedEntry.summary || '-');
  renderDebugPayload(selectedEntry.payload, { emptyMessage: '선택된 B 단계 항목에 payload가 없습니다.' });
}

function buildStepBEntries(stepB) {
  if (!stepB || !stepB.responses) return [];

  const entries = [];

  if (stepB.merge) {
    entries.push({
      key: 'merge',
      kind: 'merge',
      label: 'B-3 Merge',
      summary: 'Merged output across all query bundles.',
      ok: true,
      payload: stepB.merge
    });
  }

  const responses = stepB.responses || {};
  if (Array.isArray(responses)) {
    const queriesByIndex = Array.isArray(stepB.queriesByIndex) ? stepB.queriesByIndex : [];

    responses.forEach((entry, idx) => {
      const queryIndex = Number.isFinite(entry?.queryIndex) ? entry.queryIndex : (idx + 1);
      const bundle = queriesByIndex[idx] || entry?.queries || [];
      const summary = formatStepBBundleSummary(bundle);

      entries.push({
        key: `bundle-${queryIndex}`,
        kind: 'bundle',
        label: `쿼리세트${queryIndex}`,
        summary: summary || '(요약 정보 없음)',
        ok: !!entry?.ok,
        payload: entry?.ok
          ? (entry.result || null)
          : {
            queryIndex,
            error: entry?.error || '요청 처리 중 오류',
            queries: bundle
          }
      });
    });

    return entries;
  }

  const queriesByFeature = stepB.queries || {};

  Object.entries(responses || {}).forEach(([featureId, featureResponses]) => {
    const responseList = Array.isArray(featureResponses) ? featureResponses : [];
    const featureQueries = Array.isArray(queriesByFeature[featureId]) ? queriesByFeature[featureId] : [];

    responseList.forEach((entry, idx) => {
      const queryText = featureQueries[idx] || entry?.query || '';
      entries.push({
        key: `feature-${featureId}-${idx + 1}`,
        kind: 'feature',
        label: `${featureId} / Query ${idx + 1}`,
        summary: queryText || '(요약 정보 없음)',
        ok: !!entry?.ok,
        payload: entry?.ok
          ? (entry.result || null)
          : {
            featureId,
            queryIndex: idx + 1,
            error: entry?.error || '요청 처리 중 오류',
            query: queryText
          }
      });
    });
  });

  return entries;
}

function formatStepBBundleSummary(bundle) {
  if (!Array.isArray(bundle) || bundle.length === 0) return '';

  return bundle
    .map(item => {
      const featureId = String(item?.Feature || item?.Id || '').trim();
      const queryText = String(item?.Query || item?.query || '').trim();
      if (!featureId && !queryText) return '';
      return featureId ? `${featureId}: ${queryText}` : queryText;
    })
    .filter(Boolean)
    .join(' | ');
}

function isStepBEntryMatchedBySearch(entry, searchTerm) {
  if (!searchTerm) return true;

  const preview = buildDebugSearchPreview(entry.payload, 1200);
  const source = `${entry.label} ${entry.summary || ''} ${preview}`.toLowerCase();
  return source.includes(searchTerm);
}

function buildDebugSearchPreview(value, maxLength = 1200) {
  try {
    const raw = JSON.stringify(value);
    if (!raw) return '';
    return raw.length > maxLength ? raw.slice(0, maxLength) : raw;
  } catch (_error) {
    return String(value || '');
  }
}

function updateDebugTabBadges(result) {
  ensureDebugTabStructure();
  const claimId = debugState.claimId;
  const progress = claimId === null || claimId === undefined
    ? null
    : claimProgressById?.[String(claimId)] || null;
  const updatedText = formatDebugTimestamp(progress?.updatedAt || null);

  document.querySelectorAll('.debug-tab').forEach(tab => {
    const tabId = tab.dataset.tab;
    const badge = tab.querySelector('.debug-tab-badge');
    if (!badge) return;

    const metrics = getDebugTabMetrics(tabId, result);
    badge.className = `debug-tab-badge ${metrics.badgeClass}`;
    badge.textContent = metrics.badgeText;
    tab.classList.toggle('has-error', metrics.errorCount > 0);
    tab.title = `${metrics.title} / 최종 업데이트: ${updatedText}`;
  });
}

function getDebugTabMetrics(tabId, result) {
  if (!result) {
    return {
      hasData: false,
      errorCount: 0,
      badgeClass: 'none',
      badgeText: 'NONE',
      title: '디버그 데이터 없음'
    };
  }

  const debug = result.debug || {};
  let hasData = false;
  let errorCount = 0;

  switch (tabId) {
    case 'stepA':
      hasData = !!debug.stepA || Array.isArray(result.ClaimFeatures) && result.ClaimFeatures.length > 0;
      errorCount = debug.stepAError ? 1 : 0;
      break;
    case 'stepB': {
      const stepBEntries = buildStepBEntries(debug.stepB).filter(entry => entry.kind !== 'merge');
      hasData = stepBEntries.length > 0;
      const responseErrorCount = stepBEntries.filter(entry => !entry.ok).length;
      errorCount = (debug.stepBError ? 1 : 0) + responseErrorCount;
      break;
    }
    case 'stepC':
      hasData = !!debug.stepC;
      errorCount = debug.stepCError ? 1 : 0;
      break;
    case 'stepD':
      hasData = !!debug.stepD;
      errorCount = debug.stepDError ? 1 : 0;
      break;
    case 'quick':
      hasData = !!debug.quick || !!debug.quickError;
      errorCount = debug.quickError ? 1 : 0;
      break;
    case 'verification':
      hasData = Object.keys(result.verifications || {}).length > 0
        || !!debug.stepEInput
        || !!debug.stepE;
      errorCount = (debug.stepEError ? 1 : 0) + (debug.stepE?.error ? 1 : 0);
      break;
    case 'final':
      hasData = (result.ClaimFeatures || []).length > 0
        || Object.keys(result.Relevant || {}).length > 0
        || Object.keys(result.FeatureStatus || {}).length > 0;
      errorCount = result.error ? 1 : 0;
      break;
    default:
      hasData = false;
      errorCount = 0;
  }

  let badgeClass = 'none';
  let badgeText = 'NONE';
  if (errorCount > 0) {
    badgeClass = 'err';
    badgeText = `ERR ${errorCount}`;
  } else if (hasData) {
    badgeClass = 'ok';
    badgeText = 'OK';
  }

  const title = errorCount > 0
    ? `디버그 데이터 ${hasData ? '존재' : '없음'} / 오류 수: ${errorCount}`
    : `디버그 데이터 ${hasData ? '존재' : '없음'}`;

  return {
    hasData,
    errorCount,
    badgeClass,
    badgeText,
    title
  };
}

function renderDebugClaimSummary(claimId, result) {
  const summaryBox = document.getElementById('debug-claim-summary');
  if (!summaryBox) return;

  if (claimId === null || claimId === undefined || !result) {
    summaryBox.classList.add('hidden');
    summaryBox.innerHTML = '';
    updateDebugLastUpdatedText(null);
    return;
  }

  const claim = claims.find(item => String(item.id) === String(claimId));
  const claimName = claim?.name || `Claim ${claimId}`;
  const modeLabel = isQuickDebugResult(result) ? 'Quick' : 'Deep';
  const progress = claimProgressById?.[String(claimId)] || null;
  const updatedText = formatDebugTimestamp(progress?.updatedAt || null);

  summaryBox.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'debug-claim-summary-head';

  const title = document.createElement('div');
  title.className = 'debug-claim-summary-title';
  title.textContent = `${claimName} | ${modeLabel} mode`;

  const meta = document.createElement('div');
  meta.className = 'debug-claim-summary-meta';
  meta.textContent = `Updated ${updatedText}`;

  head.appendChild(title);
  head.appendChild(meta);

  const steps = document.createElement('div');
  steps.className = 'debug-claim-step-row';

  DEBUG_STEP_SEQUENCE.forEach(stepId => {
    const state = getDebugStepState(claimId, result, stepId);
    const durationMs = getDebugStepDurationMs(result, stepId);
    const durationText = formatDebugStepDuration(durationMs);
    const chip = document.createElement('span');
    chip.className = `debug-claim-step-chip ${state}`;
    chip.textContent = durationText
      ? `${stepId}: ${formatDebugStepStateLabel(state)} | ${durationText}`
      : `${stepId}: ${formatDebugStepStateLabel(state)}`;
    steps.appendChild(chip);
  });

  summaryBox.appendChild(head);
  summaryBox.appendChild(steps);
  summaryBox.classList.remove('hidden');

  updateDebugLastUpdatedText(claimId);
}

function isQuickDebugResult(result) {
  return !!(result?.debug?.quick || result?.debug?.quickError);
}

function getDebugStepTiming(result, stepId) {
  const timings = result?.debug?.stepTimings;
  if (!timings || typeof timings !== 'object' || Array.isArray(timings)) return null;

  const timing = timings[stepId];
  if (!timing || typeof timing !== 'object' || Array.isArray(timing)) return null;

  return timing;
}

function normalizeDebugStepTimingStatus(result, stepId) {
  const status = String(getDebugStepTiming(result, stepId)?.status || '').trim().toLowerCase();
  if (
    status === 'active'
    || status === 'done'
    || status === 'error'
    || status === 'pending'
    || status === 'skipped'
  ) {
    return status;
  }
  return null;
}

function getDebugStepDurationMs(result, stepId) {
  const timing = getDebugStepTiming(result, stepId);
  if (!timing) return null;

  if (Number.isFinite(timing.durationMs) && timing.durationMs >= 0) {
    return timing.durationMs;
  }

  if (timing.status === 'active' && Number.isFinite(timing.startedAt)) {
    return Math.max(0, Date.now() - timing.startedAt);
  }

  return null;
}

function formatDebugStepDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;

  const seconds = durationMs / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;

  const roundedSeconds = Math.round(seconds);
  const minutes = Math.floor(roundedSeconds / 60);
  const remainSeconds = roundedSeconds % 60;
  return `${minutes}m ${String(remainSeconds).padStart(2, '0')}s`;
}

function getDebugStepState(claimId, result, stepId) {
  const progress = claimProgressById?.[String(claimId)] || null;
  const progressState = progress?.steps?.[stepId];
  const timingStatus = normalizeDebugStepTimingStatus(result, stepId);

  if (stepId === 'D' && (result?.debug?.stepD?.skipped || timingStatus === 'skipped')) {
    return 'skipped';
  }

  if (progressState === 'active' || progressState === 'done' || progressState === 'error' || progressState === 'pending') {
    return progressState;
  }

  if (timingStatus) {
    return timingStatus;
  }

  const debug = result?.debug || {};
  const isQuick = isQuickDebugResult(result);

  switch (stepId) {
    case 'A':
      if (debug.stepAError || debug.quickError) return 'error';
      if (debug.stepA || isQuick) return 'done';
      return 'pending';
    case 'B':
      if (debug.stepBError) return 'error';
      if (debug.stepB || isQuick) return 'done';
      return 'pending';
    case 'C':
      if (debug.stepCError) return 'error';
      if (debug.stepC || isQuick) return 'done';
      return 'pending';
    case 'D':
      if (debug.stepDError) return 'error';
      if (debug.stepD?.skipped) return 'skipped';
      if (debug.stepD || isQuick) return 'done';
      return 'pending';
    case 'E':
      if (debug.stepEError) return 'error';
      if (Object.keys(result?.verifications || {}).length > 0 || isQuick) return 'done';
      return 'pending';
    default:
      return 'pending';
  }
}

function formatDebugStepStateLabel(state) {
  switch (state) {
    case 'done':
      return 'Completed';
    case 'active':
      return 'Running';
    case 'error':
      return 'Error';
    case 'skipped':
      return 'Skipped';
    default:
      return 'Pending';
  }
}

function updateDebugLastUpdatedText(claimId) {
  const target = document.getElementById('debug-last-updated');
  if (!target) return;

  if (claimId === null || claimId === undefined) {
    target.textContent = 'Last updated: -';
    return;
  }

  const progress = claimProgressById?.[String(claimId)] || null;
  const updatedText = formatDebugTimestamp(progress?.updatedAt || null);
  target.textContent = `Last updated: ${updatedText}`;
}

function formatDebugTimestamp(timestamp) {
  if (!timestamp) return '-';

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '-';

  return date.toLocaleString();
}

function showDebugDetailHeader(titleText, metaText) {
  const header = document.getElementById('debug-detail-header');
  const title = document.getElementById('debug-detail-title');
  const meta = document.getElementById('debug-detail-meta');

  if (!header || !title || !meta) return;

  title.textContent = titleText || '';
  meta.textContent = metaText || '';
  header.classList.remove('hidden');
}

function hideDebugDetailHeader() {
  const header = document.getElementById('debug-detail-header');
  const title = document.getElementById('debug-detail-title');
  const meta = document.getElementById('debug-detail-meta');

  if (title) title.textContent = '';
  if (meta) meta.textContent = '';
  if (header) header.classList.add('hidden');
}

function renderDebugPayload(payload, options = {}) {
  const content = document.getElementById('debug-content');
  if (!content) return;

  content.innerHTML = '';

  if (payload === null || payload === undefined) {
    renderDebugEmptyState(options.emptyMessage || '표시할 payload가 없습니다.');
    return;
  }

  const searchTerm = debugUiState.searchTerm;
  const tree = document.createElement('div');
  tree.className = 'debug-tree';

  let matchedCount = 0;

  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      if (appendDebugTreeLeaf(tree, '(array)', [], '$', searchTerm)) {
        matchedCount += 1;
      }
    } else {
      payload.forEach((item, idx) => {
        const path = buildDebugPath('$', String(idx), true);
        if (appendDebugTreeNode(tree, `[${idx}]`, item, path, 0, searchTerm)) {
          matchedCount += 1;
        }
      });
    }
  } else if (payload && typeof payload === 'object') {
    const entries = Object.entries(payload);
    if (entries.length === 0) {
      if (appendDebugTreeLeaf(tree, '(object)', {}, '$', searchTerm)) {
        matchedCount += 1;
      }
    } else {
      entries.forEach(([key, value]) => {
        const path = buildDebugPath('$', key, false);
        if (appendDebugTreeNode(tree, key, value, path, 0, searchTerm)) {
          matchedCount += 1;
        }
      });
    }
  } else {
    if (appendDebugTreeLeaf(tree, '(value)', payload, '$', searchTerm)) {
      matchedCount += 1;
    }
  }

  if (matchedCount === 0) {
    const noMatch = document.createElement('div');
    noMatch.className = 'debug-tree-no-match';
    noMatch.textContent = searchTerm
      ? '검색 조건에 일치하는 key/path/value가 없습니다.'
      : (options.emptyMessage || '표시할 payload가 없습니다.');
    content.appendChild(noMatch);
    return;
  }

  content.appendChild(tree);
}

function renderDebugEmptyState(message) {
  const content = document.getElementById('debug-content');
  if (!content) return;

  content.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'debug-empty-state';
  empty.textContent = message;
  content.appendChild(empty);
}

function appendDebugTreeNode(container, key, value, path, depth, searchTerm) {
  const type = getDebugValueType(value);

  if (type !== 'object' && type !== 'array') {
    return appendDebugTreeLeaf(container, key, value, path, searchTerm);
  }

  const entries = type === 'array'
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value || {});

  const childContainer = document.createElement('div');
  childContainer.className = 'debug-tree-children';

  let childMatchCount = 0;
  entries.forEach(([childKey, childValue]) => {
    const childPath = buildDebugPath(path, childKey, type === 'array');
    const childLabel = type === 'array' ? `[${childKey}]` : childKey;
    if (appendDebugTreeNode(childContainer, childLabel, childValue, childPath, depth + 1, searchTerm)) {
      childMatchCount += 1;
    }
  });

  const selfSource = `${String(key)} ${path} ${type}`.toLowerCase();
  const selfMatch = !searchTerm || selfSource.includes(searchTerm);
  if (searchTerm && !selfMatch && childMatchCount === 0) {
    return false;
  }

  if (entries.length === 0) {
    appendDebugTreeLeaf(
      childContainer,
      '(empty)',
      type === 'array' ? [] : {},
      path,
      searchTerm,
      { force: true }
    );
  }

  const branch = document.createElement('details');
  branch.className = 'debug-tree-branch';
  branch.open = shouldOpenDebugBranch(depth, searchTerm);

  const summary = document.createElement('summary');
  summary.className = 'debug-tree-summary';

  const summaryMain = document.createElement('div');
  summaryMain.className = 'debug-tree-summary-main';

  const keyEl = document.createElement('span');
  keyEl.className = 'debug-tree-key';
  keyEl.textContent = key;

  const pathEl = document.createElement('span');
  pathEl.className = 'debug-tree-path';
  pathEl.textContent = path;

  const typeEl = document.createElement('span');
  typeEl.className = 'debug-tree-type';
  typeEl.textContent = type === 'array' ? `arr(${entries.length})` : `obj(${entries.length})`;

  summaryMain.appendChild(keyEl);
  summaryMain.appendChild(pathEl);
  summaryMain.appendChild(typeEl);

  const copyButton = createDebugCopyButton(path);

  summary.appendChild(summaryMain);
  summary.appendChild(copyButton);

  branch.appendChild(summary);
  branch.appendChild(childContainer);

  container.appendChild(branch);
  return true;
}

function appendDebugTreeLeaf(container, key, value, path, searchTerm, options = {}) {
  const type = getDebugValueType(value);
  const valueText = formatDebugLeafValue(value);
  const source = `${String(key)} ${path} ${valueText}`.toLowerCase();

  if (!options.force && searchTerm && !source.includes(searchTerm)) {
    return false;
  }

  const leaf = document.createElement('div');
  leaf.className = 'debug-tree-leaf';

  const main = document.createElement('div');
  main.className = 'debug-tree-leaf-main';

  const keyLine = document.createElement('div');
  keyLine.className = 'debug-tree-summary-main';

  const keyEl = document.createElement('span');
  keyEl.className = 'debug-tree-key';
  keyEl.textContent = key;

  const pathEl = document.createElement('span');
  pathEl.className = 'debug-tree-path';
  pathEl.textContent = path;

  keyLine.appendChild(keyEl);
  keyLine.appendChild(pathEl);

  const valueEl = document.createElement('div');
  valueEl.className = `debug-tree-value type-${type}`;
  valueEl.textContent = valueText;

  main.appendChild(keyLine);
  main.appendChild(valueEl);

  const copyButton = createDebugCopyButton(path);

  leaf.appendChild(main);
  leaf.appendChild(copyButton);

  container.appendChild(leaf);
  return true;
}

function createDebugCopyButton(path) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'debug-tree-copy';
  button.textContent = 'Copy path';

  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    copyDebugPath(path, button);
  });

  return button;
}

function copyDebugPath(path, button) {
  if (!path || !navigator?.clipboard?.writeText) return;

  navigator.clipboard.writeText(path)
    .then(() => {
      if (!button) return;
      const previous = button.textContent;
      button.textContent = 'Copied';
      window.setTimeout(() => {
        button.textContent = previous;
      }, 900);
    })
    .catch(error => {
      console.warn('Failed to copy debug path:', error);
    });
}

function shouldOpenDebugBranch(depth, searchTerm) {
  if (searchTerm) return true;

  if (debugUiState.treeOpenMode === DEBUG_TREE_OPEN_MODE.ALL) return true;
  if (debugUiState.treeOpenMode === DEBUG_TREE_OPEN_MODE.NONE) return false;

  return depth <= 0;
}

function normalizeDebugSearchTerm(value) {
  return String(value || '').trim().toLowerCase();
}

function buildDebugPath(parentPath, key, parentIsArray) {
  const normalizedParent = parentPath || '$';
  const normalizedKey = String(key);

  if (parentIsArray) {
    return `${normalizedParent}[${normalizedKey}]`;
  }

  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(normalizedKey)) {
    return `${normalizedParent}.${normalizedKey}`;
  }

  return `${normalizedParent}[${JSON.stringify(normalizedKey)}]`;
}

function getDebugValueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function formatDebugLeafValue(value) {
  const type = getDebugValueType(value);

  switch (type) {
    case 'string':
      return `"${value}"`;
    case 'number':
    case 'boolean':
      return String(value);
    case 'null':
      return 'null';
    case 'array':
      return `Array(${value.length})`;
    case 'object':
      return `Object(${Object.keys(value || {}).length})`;
    case 'undefined':
      return 'undefined';
    default:
      return String(value);
  }
}



function setAnalysisMode(active) {
  const isActive = !!active;
  try {
    localStorage.setItem(ANALYSIS_MODE_STORAGE_KEY, String(isActive));
  } catch (error) {
    console.warn('Failed to persist analysis mode:', error);
  }
  document.body.classList.toggle('analysis-active', isActive);
  if (isActive) {
    document.body.classList.remove('settings-open');
    const settingsToggle = document.getElementById('btn-settings-toggle');
    if (settingsToggle) settingsToggle.setAttribute('aria-expanded', 'false');
  }

  syncInputPanelLayoutForMode(isActive);

  const editButton = document.getElementById('btn-edit-mode');
  if (editButton) {
    editButton.classList.toggle('hidden', !isActive);
  }

  if (typeof renderClaims === 'function') {
    renderClaims();
  }
  if (typeof renderCitations === 'function') {
    renderCitations();
  }

  updateInputSummary();
}

function updateInputSummary() {
  const meta = getAnalysisMeta();
  const claimSummary = document.getElementById('claim-summary-compact');
  if (claimSummary) {
    const totalClaims = claims.length;
    const filledClaims = claims.filter(c => c.text && c.text.trim()).length;
    claimSummary.innerHTML = `
      <div class="summary-title">Claims Summary</div>
      <div class="summary-row">
        <span>Filled claims</span>
        <strong>${filledClaims}/${totalClaims}</strong>
      </div>
      <div class="summary-meta">Last run: ${meta.lastRunText}</div>
      <div class="summary-chips">
        <span class="summary-chip">Total ${totalClaims}</span>
        <span class="summary-chip">Filled ${filledClaims}</span>
      </div>
    `;
  }

  const citationSummary = document.getElementById('citation-summary-compact');
  if (citationSummary) {
    const total = citations.length;
    const completed = citations.filter(c => c.status === 'completed').length;
    const processing = citations.filter(c => c.status === 'processing' || c.status === 'uploading').length;
    const failed = citations.filter(c => c.status === 'failed').length;

    citationSummary.innerHTML = `
      <div class="summary-title">References Summary</div>
      <div class="summary-row">
        <span>Completed references</span>
        <strong>${completed}/${total}</strong>
      </div>
      <div class="summary-meta">Last step: ${meta.stepText}</div>
      <div class="summary-chips">
        <span class="summary-chip">Total ${total}</span>
        <span class="summary-chip">Completed ${completed}</span>
        <span class="summary-chip">In progress ${processing}</span>
        <span class="summary-chip">Failed ${failed}</span>
      </div>
    `;
  }

  updateInputPanelHeaders();
}

function getAnalysisMeta() {
  const lastRun = localStorage.getItem('analysisLastRunAt');
  const lastStep = localStorage.getItem('analysisLastStep');
  const lastRunText = lastRun ? new Date(lastRun).toLocaleString() : 'No run';
  const stepText = lastStep || 'No step';
  return { lastRunText, stepText };
}

function findParagraphEntriesInRange(paragraphs, start, end) {
  if (!paragraphs || typeof paragraphs !== 'object') return [];
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];

  const byNumber = new Map();
  Object.entries(paragraphs).forEach(([rawKey, rawValue]) => {
    const number = parseParagraphNumberFromKey(rawKey);
    if (!Number.isFinite(number)) return;
    if (number < start || number > end) return;
    const text = String(rawValue || '').trim();
    if (!text) return;
    if (!byNumber.has(number)) {
      byNumber.set(number, {
        key: formatParagraphNumberKey(number) || normalizeParagraphLookupKey(rawKey) || String(rawKey || '').trim(),
        text
      });
    }
  });

  const rows = [];
  for (let number = start; number <= end; number += 1) {
    const hit = byNumber.get(number);
    if (hit) rows.push(hit);
  }
  return rows;
}

function buildParagraphRangeContent(entries, rangeInfo) {
  if (!Array.isArray(entries) || entries.length === 0) return '';

  const lines = entries.map((entry) => `${entry.key}\n${entry.text}`);
  if (!rangeInfo || !rangeInfo.isRange) {
    return lines.join('\n\n');
  }

  const missing = [];
  for (let number = rangeInfo.start; number <= rangeInfo.end; number += 1) {
    const exists = entries.some((entry) => parseParagraphNumberFromKey(entry.key) === number);
    if (!exists) {
      const key = formatParagraphNumberKey(number);
      if (key) missing.push(key);
    }
  }

  if (missing.length > 0) {
    lines.push(`[Missing]\n${missing.join(', ')}`);
  }
  return lines.join('\n\n');
}

function formatClaimNumberLabel(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return '';
  return `청구항 ${number}`;
}

function parseClaimNumberFromKey(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  if (typeof parseClaimPositionToken === 'function') {
    const parsed = parseClaimPositionToken(text);
    if (parsed && parsed.start === parsed.end) {
      return parsed.start;
    }
  }

  const withKeyword = text.match(/(?:청구항|claim)\s*#?\s*(\d{1,6})/i);
  if (withKeyword) {
    const number = Number.parseInt(withKeyword[1], 10);
    return Number.isFinite(number) ? number : null;
  }

  const koreanStyle = text.match(/제\s*(\d{1,6})\s*항/i);
  if (koreanStyle) {
    const number = Number.parseInt(koreanStyle[1], 10);
    return Number.isFinite(number) ? number : null;
  }

  return null;
}

function findClaimEntriesInRange(claims, start, end) {
  if (!claims || typeof claims !== 'object') return [];
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];

  const from = Math.min(start, end);
  const to = Math.max(start, end);
  const byNumber = new Map();

  Object.entries(claims).forEach(([rawKey, rawValue]) => {
    const number = parseClaimNumberFromKey(rawKey);
    if (!Number.isFinite(number)) return;
    if (number < from || number > to) return;
    const text = String(rawValue || '').trim();
    if (!text) return;
    if (!byNumber.has(number)) {
      byNumber.set(number, {
        number,
        key: String(rawKey || '').trim() || formatClaimNumberLabel(number),
        text
      });
    }
  });

  const rows = [];
  for (let number = from; number <= to; number += 1) {
    const hit = byNumber.get(number);
    if (hit) rows.push(hit);
  }
  return rows;
}

function buildClaimRangeContent(entries, rangeInfo) {
  if (!Array.isArray(entries) || entries.length === 0) return '';

  const lines = entries.map((entry) => `${entry.key}\n${entry.text}`);
  if (!rangeInfo || !rangeInfo.isRange) {
    return lines.join('\n\n');
  }

  const missing = [];
  for (let number = rangeInfo.startClaim; number <= rangeInfo.endClaim; number += 1) {
    const exists = entries.some((entry) => Number(entry.number) === number);
    if (!exists) {
      missing.push(formatClaimNumberLabel(number));
    }
  }

  if (missing.length > 0) {
    lines.push(`[Missing]\n${missing.join(', ')}`);
  }
  return lines.join('\n\n');
}

function findClaimTextByKey(claims, claimKey) {
  if (!claims || typeof claims !== 'object') return null;
  const directKey = String(claimKey || '').trim();
  if (directKey && typeof claims[directKey] === 'string' && claims[directKey].trim()) {
    return { key: directKey, text: claims[directKey].trim(), number: parseClaimNumberFromKey(directKey) };
  }

  const number = parseClaimNumberFromKey(claimKey);
  if (!Number.isFinite(number)) return null;

  const matchedKey = Object.keys(claims).find(key => parseClaimNumberFromKey(key) === number);
  if (!matchedKey) return null;

  const text = String(claims[matchedKey] || '').trim();
  if (!text) return null;
  return {
    key: matchedKey,
    text,
    number
  };
}

function findCitationByDocName(docName) {
  const target = String(docName || '').trim();
  if (!target) return null;

  const matchedByName = citations.find(c => String(c.name || '').trim() === target);
  if (matchedByName) return matchedByName;

  const matchedByTitle = citations.find(c => String(c.title || '').trim() === target);
  if (matchedByTitle) return matchedByTitle;

  const docAlias = target.match(/^D\s*(\d{1,3})$/i);
  if (docAlias) {
    const index = Number.parseInt(docAlias[1], 10) - 1;
    if (Number.isFinite(index) && index >= 0 && index < citations.length) {
      return citations[index];
    }
  }

  return null;
}

function parseCitationPayloadForPositionModal(citation) {
  if (!citation || typeof citation !== 'object') return null;
  if (typeof parseCitationPayload === 'function') {
    return parseCitationPayload(citation);
  }

  try {
    const payloadText = typeof citation.payloadText === 'string'
      ? citation.payloadText
      : citation.text;
    if (typeof payloadText !== 'string') return null;
    return safeJsonParse(payloadText);
  } catch (_error) {
    return null;
  }
}

function parseCitationParagraphs(citationOrPayload) {
  const payload = citationOrPayload?.paragraphs
    ? citationOrPayload
    : parseCitationPayloadForPositionModal(citationOrPayload);
  if (!payload || typeof payload !== 'object') return null;

  const paragraphs = payload.paragraphs;
  if (!paragraphs || typeof paragraphs !== 'object' || Array.isArray(paragraphs)) {
    return null;
  }
  return paragraphs;
}

function parseCitationClaims(citationOrPayload) {
  const payload = citationOrPayload?.claims
    ? citationOrPayload
    : parseCitationPayloadForPositionModal(citationOrPayload);
  if (!payload || typeof payload !== 'object') return {};
  const claims = payload.claims;
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    return {};
  }
  return claims;
}

function parseCitationSentinelMap(citationOrPayload) {
  const payload = citationOrPayload?.sentinelMap
    ? citationOrPayload
    : parseCitationPayloadForPositionModal(citationOrPayload);
  if (!payload || typeof payload !== 'object') return {};

  const sentinelMap = payload.sentinelMap;
  if (!sentinelMap || typeof sentinelMap !== 'object' || Array.isArray(sentinelMap)) {
    return {};
  }
  return sentinelMap;
}

function stripSentinelTokens(text) {
  return String(text || '')
    .replace(/⟪\s*\/?\s*\d{1,8}\s*⟫/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findParagraphTextByKey(paragraphs, paragraphKey) {
  const normalizedKey = normalizeParagraphLookupKey(paragraphKey);
  if (!normalizedKey || !paragraphs) return null;

  if (typeof paragraphs[normalizedKey] === 'string' && paragraphs[normalizedKey].trim()) {
    return { key: normalizedKey, text: paragraphs[normalizedKey].trim() };
  }

  const matchedKey = Object.keys(paragraphs).find(key => normalizeParagraphLookupKey(key) === normalizedKey);
  if (!matchedKey) return null;

  const text = String(paragraphs[matchedKey] || '').trim();
  if (!text) return null;
  return { key: matchedKey, text };
}

function getSentinelEntrySourceText(payload, entry) {
  if (!payload || !entry) return '';
  const sourceKey = String(entry.sourceKey || '').trim();
  if (!sourceKey) return '';

  const paragraphs = parseCitationParagraphs(payload) || {};
  const claims = parseCitationClaims(payload) || {};
  const sourceCollection = entry.targetType === 'claim' ? claims : paragraphs;
  const sourceText = sourceCollection[sourceKey];
  return typeof sourceText === 'string' ? sourceText.trim() : '';
}

function buildSentinelMetaLine(entry) {
  if (!entry || typeof entry !== 'object') return '';

  const pageNumber = Number(entry.pageNumber);
  const pageLabel = Number.isFinite(pageNumber) && pageNumber > 0
    ? `P${String(pageNumber).padStart(3, '0')}`
    : '';
  const sectionId = String(entry.sectionId || '').trim();
  const sectionTitle = String(entry.sectionTitle || '').trim();

  const tags = [];
  if (pageLabel && sectionId) tags.push(`${pageLabel}/${sectionId}`);
  else if (pageLabel) tags.push(pageLabel);
  else if (sectionId) tags.push(sectionId);

  if (sectionTitle) {
    tags.push(sectionTitle);
  }
  return tags.join(' | ');
}

function findSentinelEntriesInRange(payload, startSentinel, endSentinel) {
  const map = parseCitationSentinelMap(payload);
  const start = Number.parseInt(startSentinel, 10);
  const end = Number.parseInt(endSentinel, 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];

  const from = Math.min(start, end);
  const to = Math.max(start, end);
  const entries = [];

  for (let number = from; number <= to; number += 1) {
    const id = typeof formatSentinelId === 'function'
      ? formatSentinelId(number)
      : String(number).padStart(4, '0');
    const entry = map[id];
    if (!entry || typeof entry !== 'object') continue;
    entries.push({ ...entry, id });
  }

  return entries;
}

function buildSentinelRangeContent(payload, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';

  const lines = [];
  entries.forEach((entry) => {
    const sentinelToken = typeof formatSentinelOpenToken === 'function'
      ? formatSentinelOpenToken(entry.id)
      : `⟪${entry.id}⟫`;
    const displayKey = String(entry.displayKey || entry.sourceKey || sentinelToken).trim() || sentinelToken;
    const metaLine = buildSentinelMetaLine(entry);
    const sourceText = stripSentinelTokens(getSentinelEntrySourceText(payload, entry));

    lines.push(`${sentinelToken} ${displayKey}`.trim());
    if (metaLine) {
      lines.push(`[Meta] ${metaLine}`);
    }
    lines.push(sourceText || '(원문 내용이 없습니다.)');
    lines.push('');
  });

  return lines.join('\n').trim();
}

function getPositionModalSummaryText(relatedContent) {
  const text = String(relatedContent || '').trim();
  return text || '\uAD00\uB828 \uB0B4\uC6A9\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.';
}

function ensurePositionModalExpandControls() {
  const sourceEl = document.getElementById('position-modal-source');
  if (!sourceEl || !sourceEl.parentElement) return;

  let prevButton = document.getElementById('btn-position-modal-expand-prev');
  if (!prevButton) {
    prevButton = document.createElement('button');
    prevButton.id = 'btn-position-modal-expand-prev';
    prevButton.type = 'button';
    prevButton.className = 'btn-secondary-sm position-modal-expand-btn hidden';
    prevButton.textContent = '▲ 이전 센티넬 추가';
    sourceEl.parentElement.insertBefore(prevButton, sourceEl);
  }

  let nextButton = document.getElementById('btn-position-modal-expand-next');
  if (!nextButton) {
    nextButton = document.createElement('button');
    nextButton.id = 'btn-position-modal-expand-next';
    nextButton.type = 'button';
    nextButton.className = 'btn-secondary-sm position-modal-expand-btn hidden';
    nextButton.textContent = '▼ 다음 센티넬 추가';
    if (sourceEl.nextSibling) {
      sourceEl.parentElement.insertBefore(nextButton, sourceEl.nextSibling);
    } else {
      sourceEl.parentElement.appendChild(nextButton);
    }
  }
}

function getPositionModalExpandButtons() {
  ensurePositionModalExpandControls();
  return {
    prev: document.getElementById('btn-position-modal-expand-prev'),
    next: document.getElementById('btn-position-modal-expand-next')
  };
}

function setPositionModalExpandButtonsState(options = {}) {
  const { prev, next } = getPositionModalExpandButtons();
  if (!prev || !next) return;

  const visible = !!options.visible;
  prev.classList.toggle('hidden', !visible);
  next.classList.toggle('hidden', !visible);

  prev.disabled = !visible || !options.canExpandPrev;
  next.disabled = !visible || !options.canExpandNext;
}

function resetPositionModalContextState() {
  positionModalState.context = null;
  setPositionModalExpandButtonsState({ visible: false });
}

function buildPositionModalSentinelContext(options = {}) {
  const payload = options.payload;
  const sentinelMap = parseCitationSentinelMap(payload);
  if (!sentinelMap || typeof sentinelMap !== 'object' || Object.keys(sentinelMap).length === 0) {
    return null;
  }

  const orderedIds = Object.keys(sentinelMap)
    .map((rawId) => Number.parseInt(rawId, 10))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (orderedIds.length === 0) return null;

  const start = Number.parseInt(options.startSentinel, 10);
  const end = Number.parseInt(options.endSentinel, 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const from = Math.min(start, end);
  const to = Math.max(start, end);

  let startIndex = orderedIds.findIndex((id) => id >= from);
  if (startIndex < 0) startIndex = 0;

  let endIndex = orderedIds.length - 1;
  for (let index = orderedIds.length - 1; index >= 0; index -= 1) {
    if (orderedIds[index] <= to) {
      endIndex = index;
      break;
    }
  }
  if (endIndex < startIndex) {
    endIndex = startIndex;
  }

  return {
    kind: 'sentinel',
    payload,
    orderedIds,
    startIndex,
    endIndex,
    titlePrefix: String(options.titlePrefix || '').trim(),
    titleSuffix: String(options.titleSuffix || '').trim()
  };
}

function normalizePositionModalContextTargetType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'claim') return 'claim';
  return 'paragraph';
}

function collectSentinelIdsForSourceRange(payload, options = {}) {
  const sentinelMap = parseCitationSentinelMap(payload);
  if (!sentinelMap || typeof sentinelMap !== 'object' || Object.keys(sentinelMap).length === 0) {
    return [];
  }

  const targetType = normalizePositionModalContextTargetType(options.targetType);
  const start = Number.parseInt(options.start, 10);
  const end = Number.parseInt(options.end, 10);
  const hasNumericRange = Number.isFinite(start) && Number.isFinite(end);
  const from = hasNumericRange ? Math.min(start, end) : null;
  const to = hasNumericRange ? Math.max(start, end) : null;

  const exactParagraphKey = normalizeParagraphLookupKey(options.exactParagraphKey);
  const exactClaimNumber = Number.parseInt(options.exactClaimNumber, 10);
  const hasExactClaimNumber = Number.isFinite(exactClaimNumber);

  const ids = [];
  Object.entries(sentinelMap).forEach(([rawId, rawEntry]) => {
    if (!rawEntry || typeof rawEntry !== 'object') return;
    const idNumber = Number.parseInt(rawId, 10);
    if (!Number.isFinite(idNumber)) return;

    const entryTargetType = normalizePositionModalContextTargetType(rawEntry.targetType);
    if (entryTargetType !== targetType) return;

    const sourceKey = String(rawEntry.sourceKey || rawEntry.displayKey || '').trim();
    let include = false;

    if (targetType === 'claim') {
      const claimNumber = parseClaimNumberFromKey(sourceKey);
      if (hasNumericRange && Number.isFinite(claimNumber) && claimNumber >= from && claimNumber <= to) {
        include = true;
      }
      if (!include && hasExactClaimNumber && Number.isFinite(claimNumber) && claimNumber === exactClaimNumber) {
        include = true;
      }
    } else {
      const paragraphNumber = parseParagraphNumberFromKey(sourceKey);
      if (hasNumericRange && Number.isFinite(paragraphNumber) && paragraphNumber >= from && paragraphNumber <= to) {
        include = true;
      }
      if (!include && exactParagraphKey && normalizeParagraphLookupKey(sourceKey) === exactParagraphKey) {
        include = true;
      }
    }

    if (include) ids.push(idNumber);
  });

  if (ids.length === 0) return [];
  return [...new Set(ids)].sort((a, b) => a - b);
}

function buildPositionModalSentinelContextFromSourceRange(options = {}) {
  const sentinelIds = collectSentinelIdsForSourceRange(options.payload, options);
  if (sentinelIds.length === 0) return null;

  return buildPositionModalSentinelContext({
    payload: options.payload,
    startSentinel: sentinelIds[0],
    endSentinel: sentinelIds[sentinelIds.length - 1],
    titlePrefix: options.titlePrefix,
    titleSuffix: options.titleSuffix
  });
}

function getPositionModalSentinelContextLabel(context) {
  if (!context || context.kind !== 'sentinel') return '';
  const start = context.orderedIds[context.startIndex];
  const end = context.orderedIds[context.endIndex];
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
  if (typeof formatSentinelRange === 'function') {
    return formatSentinelRange(start, end);
  }
  if (start === end) {
    return typeof formatSentinelOpenToken === 'function'
      ? formatSentinelOpenToken(start)
      : `S${String(start).padStart(4, '0')}`;
  }
  return `S${String(start).padStart(4, '0')}-S${String(end).padStart(4, '0')}`;
}

function getPositionModalSentinelContextEntries(context) {
  if (!context || context.kind !== 'sentinel') return [];
  const entries = [];
  for (let index = context.startIndex; index <= context.endIndex; index += 1) {
    const idNumber = context.orderedIds[index];
    if (!Number.isFinite(idNumber)) continue;
    const id = typeof formatSentinelId === 'function'
      ? formatSentinelId(idNumber)
      : String(idNumber).padStart(4, '0');
    const entry = context.payload?.sentinelMap?.[id];
    if (!entry || typeof entry !== 'object') continue;
    entries.push({ ...entry, id });
  }
  return entries;
}

function getPositionModalSentinelContextSourceText(context) {
  const entries = getPositionModalSentinelContextEntries(context);
  return buildSentinelRangeContent(context?.payload, entries);
}

function updatePositionModalTitleForContext(context) {
  if (!context || context.kind !== 'sentinel') return;
  const titleEl = document.getElementById('position-modal-title');
  if (!titleEl) return;
  const label = getPositionModalSentinelContextLabel(context);
  const parts = [context.titlePrefix, label, context.titleSuffix].filter(Boolean);
  if (parts.length > 0) {
    titleEl.textContent = parts.join(' ');
  }
}

function syncPositionModalExpandButtonsForContext(context) {
  if (!context || context.kind !== 'sentinel') {
    setPositionModalExpandButtonsState({ visible: false });
    return;
  }
  setPositionModalExpandButtonsState({
    visible: true,
    canExpandPrev: context.startIndex > 0,
    canExpandNext: context.endIndex < context.orderedIds.length - 1
  });
}

function renderPositionModalContextSource() {
  const context = positionModalState.context;
  if (!context || context.kind !== 'sentinel') return;

  const sourceText = getPositionModalSentinelContextSourceText(context);
  const paragraphLabel = getPositionModalSentinelContextLabel(context) || positionModalState.paragraphKey;
  const fallbackContentEl = document.getElementById('position-modal-content');
  setPositionModalBody(positionModalState.summaryText, sourceText, fallbackContentEl);
  syncPositionModalTranslationState(positionModalState.docName, paragraphLabel, sourceText, {
    canTranslate: !!String(sourceText || '').trim()
  });
  updatePositionModalTitleForContext(context);
  syncPositionModalExpandButtonsForContext(context);
}

function expandPositionModalSentinelContext(direction) {
  const context = positionModalState.context;
  if (!context || context.kind !== 'sentinel') return;

  if (direction === 'prev') {
    if (context.startIndex <= 0) return;
    context.startIndex -= 1;
  } else if (direction === 'next') {
    if (context.endIndex >= context.orderedIds.length - 1) return;
    context.endIndex += 1;
  } else {
    return;
  }
  renderPositionModalContextSource();
}

function handlePositionModalExpandPrevClick() {
  expandPositionModalSentinelContext('prev');
}

function handlePositionModalExpandNextClick() {
  expandPositionModalSentinelContext('next');
}

function getPositionModalTranslationPlaceholder(canTranslate = true) {
  if (!canTranslate) {
    return '\uBC88\uC5ED\uD560 \uC6D0\uBB38\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.';
  }
  return '\uBC88\uC5ED \uBC84\uD2BC\uC744 \uB204\uB974\uBA74 \uC6D0\uBB38 \uC544\uB798\uC5D0 \uD55C\uAD6D\uC5B4 \uBC88\uC5ED\uBCF8\uC774 \uD45C\uC2DC\uB429\uB2C8\uB2E4.';
}

function buildPositionModalTranslationCacheKey(docName, paragraphKey, sourceText) {
  return JSON.stringify([
    String(docName || '').trim(),
    String(paragraphKey || '').trim(),
    String(sourceText || '').trim()
  ]);
}

function setPositionModalTranslateButtonState(options = {}) {
  const button = document.getElementById('btn-position-modal-translate');
  if (!button) return;

  const disabled = !!options.disabled;
  const loading = !!options.loading;
  const translated = !!options.translated;
  const defaultLabel = button.dataset.defaultLabel || button.textContent.trim() || '\uBC88\uC5ED';
  button.dataset.defaultLabel = defaultLabel;

  let nextLabel = defaultLabel;
  if (loading) {
    nextLabel = '\uBC88\uC5ED \uC911...';
  } else if (translated) {
    nextLabel = '\uB2E4\uC2DC \uBC88\uC5ED';
  }

  button.textContent = nextLabel;
  button.disabled = disabled || loading;
  button.classList.toggle('is-loading', loading);
  button.setAttribute('aria-busy', loading ? 'true' : 'false');
}

function renderPositionModalTranslation(text, options = {}) {
  const translationEl = document.getElementById('position-modal-translation');
  if (!translationEl) return;

  const placeholder = !!options.placeholder;
  const error = !!options.error;
  const fallbackText = placeholder
    ? getPositionModalTranslationPlaceholder(options.canTranslate !== false)
    : '\uBC88\uC5ED \uACB0\uACFC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.';

  translationEl.textContent = String(text || '').trim() || fallbackText;
  translationEl.classList.toggle('is-placeholder', placeholder);
  translationEl.classList.toggle('is-error', error);
}

function renderPositionModalBody(summaryText, sourceText) {
  const summaryEl = document.getElementById('position-modal-summary');
  const sourceEl = document.getElementById('position-modal-source');
  if (!summaryEl || !sourceEl) return false;

  summaryEl.textContent = String(summaryText || '').trim() || '\uAD00\uB828 \uB0B4\uC6A9\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.';
  sourceEl.textContent = String(sourceText || '').trim() || '\uC6D0\uBB38 \uB0B4\uC6A9\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.';
  return true;
}

function setPositionModalBody(summaryText, sourceText, fallbackContentEl) {
  const hasStructuredBody = renderPositionModalBody(summaryText, sourceText);
  if (hasStructuredBody) return;

  if (!fallbackContentEl) return;
  const safeSummary = String(summaryText || '').trim() || '\uAD00\uB828 \uB0B4\uC6A9\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.';
  const safeSource = String(sourceText || '').trim() || '\uC6D0\uBB38 \uB0B4\uC6A9\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.';
  fallbackContentEl.textContent = `\uC694\uC57D\uB0B4\uC6A9\n${safeSummary}\n\n\uC6D0\uBB38\n${safeSource}`;
}

function syncPositionModalTranslationState(docName, paragraphKey, sourceText, options = {}) {
  const normalizedDocName = String(docName || '').trim();
  const normalizedParagraphKey = String(paragraphKey || '').trim();
  const normalizedSourceText = String(sourceText || '').trim();
  const canTranslate = !!options.canTranslate && !!normalizedSourceText;

  positionModalState.requestSeq += 1;
  positionModalState.docName = normalizedDocName;
  positionModalState.paragraphKey = normalizedParagraphKey;
  positionModalState.sourceText = normalizedSourceText;
  positionModalState.canTranslate = canTranslate;
  positionModalState.cacheKey = canTranslate
    ? buildPositionModalTranslationCacheKey(normalizedDocName, normalizedParagraphKey, normalizedSourceText)
    : '';

  if (!canTranslate) {
    renderPositionModalTranslation('', {
      placeholder: true,
      canTranslate: false
    });
    setPositionModalTranslateButtonState({ disabled: true });
    return;
  }

  const cachedTranslation = positionModalState.cache[positionModalState.cacheKey];
  if (cachedTranslation) {
    renderPositionModalTranslation(cachedTranslation);
    setPositionModalTranslateButtonState({ translated: true });
    return;
  }

  renderPositionModalTranslation('', {
    placeholder: true,
    canTranslate: true
  });
  setPositionModalTranslateButtonState({ translated: false });
}

function showPositionModal(docName, paragraphKey, summaryText, sourceText, fallbackContentEl, options = {}) {
  const titleEl = document.getElementById('position-modal-title');
  const normalizedSummary = String(summaryText || '').trim() || getPositionModalSummaryText('');
  const normalizedSource = String(sourceText || '').trim();
  if (titleEl) {
    titleEl.textContent = options.titleText || titleEl.textContent;
  }

  positionModalState.summaryText = normalizedSummary;
  let renderParagraphKey = paragraphKey;
  let renderSourceText = normalizedSource;

  const sentinelContext = options.context?.kind === 'sentinel'
    ? buildPositionModalSentinelContext(options.context)
    : null;
  if (sentinelContext) {
    positionModalState.context = sentinelContext;
    renderParagraphKey = getPositionModalSentinelContextLabel(sentinelContext) || paragraphKey;
    renderSourceText = getPositionModalSentinelContextSourceText(sentinelContext) || normalizedSource;
    updatePositionModalTitleForContext(sentinelContext);
    syncPositionModalExpandButtonsForContext(sentinelContext);
  } else {
    resetPositionModalContextState();
  }

  setPositionModalBody(normalizedSummary, renderSourceText, fallbackContentEl);
  syncPositionModalTranslationState(docName, renderParagraphKey, renderSourceText, {
    canTranslate: options.canTranslate === true && !!String(renderSourceText || '').trim()
  });
  openDialogModal('position-modal', '#btn-close-position-modal');
}

async function handlePositionModalTranslateClick() {
  if (!positionModalState.canTranslate || !positionModalState.sourceText) {
    renderPositionModalTranslation('', {
      placeholder: true,
      canTranslate: false
    });
    setPositionModalTranslateButtonState({ disabled: true });
    return;
  }

  if (!settings.mockMode && !settings.key) {
    renderPositionModalTranslation('\uBC88\uC5ED\uC744 \uC704\uD55C API Key\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4.', {
      error: true
    });
    setPositionModalTranslateButtonState({ translated: false });
    return;
  }

  const requestSeq = positionModalState.requestSeq + 1;
  positionModalState.requestSeq = requestSeq;
  setPositionModalTranslateButtonState({ loading: true });
  renderPositionModalTranslation('\uBC88\uC5ED \uC911...', {
    placeholder: true,
    canTranslate: true
  });

  try {
    const translatedText = await translateSourceTextToKorean(positionModalState.sourceText);
    if (positionModalState.requestSeq !== requestSeq) return;

    const normalizedTranslation = String(translatedText || '').trim();
    if (!normalizedTranslation) {
      throw new Error('\uBC88\uC5ED \uACB0\uACFC\uAC00 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4.');
    }

    positionModalState.cache[positionModalState.cacheKey] = normalizedTranslation;
    renderPositionModalTranslation(normalizedTranslation);
    setPositionModalTranslateButtonState({ translated: true });
  } catch (error) {
    if (positionModalState.requestSeq !== requestSeq) return;
    renderPositionModalTranslation(
      `\uBC88\uC5ED \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4.\n${error?.message || error}`,
      { error: true }
    );
    setPositionModalTranslateButtonState({ translated: false });
  }
}

function openPositionModal(docName, paragraphKey, relatedContent = '') {
  const titleEl = document.getElementById('position-modal-title');
  const contentEl = document.getElementById('position-modal-content');
  if (!titleEl || !contentEl) return;

  const summaryText = getPositionModalSummaryText(relatedContent);
  const rangeInfo = parseParagraphKeyRange(paragraphKey);
  const normalizedKey = rangeInfo?.label || normalizeParagraphLookupKey(paragraphKey) || String(paragraphKey || '').trim();
  const citation = findCitationByDocName(docName);
  const defaultTitle = `${docName || 'Document'} ${normalizedKey || ''} position`;
  titleEl.textContent = defaultTitle;

  if (!citation) {
    showPositionModal(docName, normalizedKey, summaryText, 'Citation document not found.', contentEl, {
      titleText: defaultTitle,
      canTranslate: false
    });
    return;
  }

  const payload = parseCitationPayloadForPositionModal(citation);
  if (!payload || typeof payload !== 'object') {
    showPositionModal(docName, normalizedKey, summaryText, 'This citation does not contain structured citation JSON data.', contentEl, {
      titleText: defaultTitle,
      canTranslate: false
    });
    return;
  }

  if (rangeInfo?.kind === 'claim') {
    const claimsCollection = parseCitationClaims(payload);
    if (!claimsCollection || Object.keys(claimsCollection).length === 0) {
      showPositionModal(docName, rangeInfo.label || normalizedKey, summaryText, 'This citation does not contain claim JSON data.', contentEl, {
        titleText: defaultTitle,
        canTranslate: false
      });
      return;
    }

    if (rangeInfo.isRange) {
      const entries = findClaimEntriesInRange(claimsCollection, rangeInfo.startClaim, rangeInfo.endClaim);
      if (entries.length === 0) {
        showPositionModal(docName, rangeInfo.label, summaryText, `Range ${rangeInfo.label} was not found in source claims.`, contentEl, {
          titleText: defaultTitle,
          canTranslate: false
        });
        return;
      }

      showPositionModal(
        docName,
        rangeInfo.label,
        summaryText,
        buildClaimRangeContent(entries, rangeInfo),
        contentEl,
        {
          titleText: `${docName || citation.name || 'Document'} ${rangeInfo.label} claim range`,
          canTranslate: true,
          context: buildPositionModalSentinelContextFromSourceRange({
            payload,
            targetType: 'claim',
            start: rangeInfo.startClaim,
            end: rangeInfo.endClaim,
            titlePrefix: docName || citation.name || 'Document',
            titleSuffix: 'sentinel'
          })
        }
      );
      return;
    }

    const foundClaim = findClaimTextByKey(claimsCollection, rangeInfo.label || paragraphKey);
    if (!foundClaim) {
      showPositionModal(docName, rangeInfo.label || normalizedKey, summaryText, `${rangeInfo.label || paragraphKey} claim was not found in source claims.`, contentEl, {
        titleText: defaultTitle,
        canTranslate: false
      });
      return;
    }

    showPositionModal(docName, foundClaim.key, summaryText, foundClaim.text, contentEl, {
      titleText: `${docName || citation.name || 'Document'} ${foundClaim.key} claim`,
      canTranslate: true,
      context: buildPositionModalSentinelContextFromSourceRange({
        payload,
        targetType: 'claim',
        start: foundClaim.number,
        end: foundClaim.number,
        exactClaimNumber: foundClaim.number,
        titlePrefix: docName || citation.name || 'Document',
        titleSuffix: 'sentinel'
      })
    });
    return;
  }

  if (rangeInfo?.kind === 'sentinel') {
    const entries = findSentinelEntriesInRange(payload, rangeInfo.startSentinel, rangeInfo.endSentinel);
    if (entries.length === 0) {
      showPositionModal(docName, rangeInfo.label, summaryText, `${rangeInfo.label} sentinel was not found in source data.`, contentEl, {
        titleText: defaultTitle,
        canTranslate: false
      });
      return;
    }

    showPositionModal(docName, rangeInfo.label, summaryText, buildSentinelRangeContent(payload, entries), contentEl, {
      titleText: `${docName || citation.name || 'Document'} ${rangeInfo.label} sentinel`,
      canTranslate: true,
      context: {
        kind: 'sentinel',
        payload,
        startSentinel: rangeInfo.startSentinel,
        endSentinel: rangeInfo.endSentinel,
        titlePrefix: docName || citation.name || 'Document',
        titleSuffix: 'sentinel'
      }
    });
    return;
  }

  const paragraphs = parseCitationParagraphs(payload);
  if (!paragraphs) {
    showPositionModal(docName, normalizedKey, summaryText, 'This citation does not contain paragraph JSON data.', contentEl, {
      titleText: defaultTitle,
      canTranslate: false
    });
    return;
  }

  if (rangeInfo?.isRange) {
    const entries = findParagraphEntriesInRange(paragraphs, rangeInfo.start, rangeInfo.end);
    if (entries.length === 0) {
      showPositionModal(docName, rangeInfo.label, summaryText, `Range ${rangeInfo.label} was not found in source paragraphs.`, contentEl, {
        titleText: defaultTitle,
        canTranslate: false
      });
      return;
    }

    showPositionModal(docName, rangeInfo.label, summaryText, buildParagraphRangeContent(entries, rangeInfo), contentEl, {
      titleText: `${docName || citation.name || 'Document'} ${rangeInfo.label} paragraph range`,
      canTranslate: true,
      context: buildPositionModalSentinelContextFromSourceRange({
        payload,
        targetType: 'paragraph',
        start: rangeInfo.start,
        end: rangeInfo.end,
        titlePrefix: docName || citation.name || 'Document',
        titleSuffix: 'sentinel'
      })
    });
    return;
  }

  const found = findParagraphTextByKey(paragraphs, normalizedKey);
  if (!found) {
    showPositionModal(docName, normalizedKey, summaryText, `${normalizedKey || paragraphKey} paragraph was not found in source paragraphs.`, contentEl, {
      titleText: defaultTitle,
      canTranslate: false
    });
    return;
  }

  showPositionModal(docName, found.key, summaryText, found.text, contentEl, {
    titleText: `${docName || citation.name || 'Document'} ${found.key} paragraph`,
    canTranslate: true,
    context: buildPositionModalSentinelContextFromSourceRange({
      payload,
      targetType: 'paragraph',
      start: parseParagraphNumberFromKey(found.key),
      end: parseParagraphNumberFromKey(found.key),
      exactParagraphKey: found.key,
      titlePrefix: docName || citation.name || 'Document',
      titleSuffix: 'sentinel'
    })
  });
}
function closePositionModal() {
  positionModalState.requestSeq += 1;
  positionModalState.summaryText = '';
  resetPositionModalContextState();
  closeDialogModal('position-modal');
}

function openVerificationModal(reason) {
  const content = document.getElementById('verification-modal-content');
  
  content.textContent = reason;
  openDialogModal('verification-modal', '#btn-copy-verification-content');
}

function closeVerificationModal() {
  closeDialogModal('verification-modal');
}
