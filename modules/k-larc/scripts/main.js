let larcSettingsToggleButton = null;

function getOpenWebUiStepLabel(stepKey) {
  if (K_LARC_OPENWEBUI_STEP_LABELS && K_LARC_OPENWEBUI_STEP_LABELS[stepKey]) {
    return K_LARC_OPENWEBUI_STEP_LABELS[stepKey];
  }
  return stepKey;
}

function formatOpenWebUiFieldInputValue(field, value) {
  if (field?.type === 'select') {
    if (value === null || value === undefined) return '';
    return String(value);
  }
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '';
  return String(value);
}

function createOpenWebUiFieldElement(field, inputId, options = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'llm-settings-field';

  const label = document.createElement('label');
  label.setAttribute('for', inputId);
  label.textContent = field.label;
  wrapper.appendChild(label);

  let control = null;
  if (field?.type === 'select') {
    const select = document.createElement('select');
    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = '(기본값 사용)';
    select.appendChild(emptyOption);

    const optionsList = Array.isArray(field?.options) ? field.options : [];
    optionsList.forEach((entry) => {
      const option = document.createElement('option');
      option.value = String(entry?.value || '').trim();
      option.textContent = String(entry?.label || entry?.value || '').trim();
      if (!option.value || !option.textContent) return;
      select.appendChild(option);
    });
    control = select;
  } else {
    const input = document.createElement('input');
    input.type = 'number';
    input.inputMode = 'decimal';
    if (field.placeholder) input.placeholder = field.placeholder;
    if (field.min !== undefined) input.min = field.min;
    if (field.max !== undefined) input.max = field.max;
    if (field.step !== undefined) input.step = field.step;
    control = input;
  }

  control.id = inputId;
  control.dataset.scope = options.scope || 'global';
  control.dataset.fieldKey = field.key;
  if (options.stepKey) {
    control.dataset.stepKey = options.stepKey;
  }
  wrapper.appendChild(control);

  return wrapper;
}

function ensureOpenWebUiSettingsModalStructure(modal) {
  if (!modal || modal.dataset.initialized === 'true') return;

  const globalFieldsWrap = modal.querySelector('#llm-settings-global-fields');
  const stepListWrap = modal.querySelector('#llm-settings-step-list');
  const modalBody = modal.querySelector('.llm-settings-modal-body');
  if (!globalFieldsWrap || !stepListWrap) return;

  if (!modal.querySelector('#llm-settings-b2-skill-section')) {
    const skillSection = document.createElement('section');
    skillSection.className = 'llm-settings-section';
    skillSection.id = 'llm-settings-b2-skill-section';

    const skillTitle = document.createElement('h4');
    skillTitle.className = 'llm-settings-section-title';
    skillTitle.textContent = 'B-2 추가 옵션';
    skillSection.appendChild(skillTitle);

    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'llm-settings-override-toggle llm-settings-extra-toggle';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.id = 'llm-settings-use-b2-skill-md';
    toggleLabel.appendChild(toggle);
    toggleLabel.append('B-2에서 SKILL.md 가이드 사용');
    skillSection.appendChild(toggleLabel);

    const help = document.createElement('p');
    help.className = 'llm-settings-extra-help';
    help.textContent = '켜면 Step B-2 프롬프트에 skills/k-larc-rag-ops/SKILL.md 내용이 추가됩니다.';
    skillSection.appendChild(help);

    const stepSection = stepListWrap.closest('.llm-settings-section');
    if (stepSection && stepSection.parentElement) {
      stepSection.parentElement.insertBefore(skillSection, stepSection);
    } else if (modalBody) {
      modalBody.appendChild(skillSection);
    }
  }

  K_LARC_OPENWEBUI_API_FIELDS.forEach((field) => {
    const inputId = `llm-settings-global-${field.key}`;
    globalFieldsWrap.appendChild(createOpenWebUiFieldElement(field, inputId, { scope: 'global' }));
  });

  K_LARC_OPENWEBUI_STEP_ORDER.forEach((stepKey) => {
    const card = document.createElement('section');
    card.className = 'llm-settings-step-card';
    card.dataset.stepKey = stepKey;

    const head = document.createElement('div');
    head.className = 'llm-settings-step-head';

    const name = document.createElement('strong');
    name.className = 'llm-settings-step-name';
    name.textContent = getOpenWebUiStepLabel(stepKey);
    head.appendChild(name);

    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'llm-settings-override-toggle';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'llm-settings-step-enable';
    toggle.id = `llm-settings-step-enable-${stepKey}`;
    toggle.dataset.stepKey = stepKey;
    toggleLabel.appendChild(toggle);
    toggleLabel.append('오버라이드 사용');
    head.appendChild(toggleLabel);

    card.appendChild(head);

    const fieldsGrid = document.createElement('div');
    fieldsGrid.className = 'llm-settings-fields-grid';
    K_LARC_OPENWEBUI_API_FIELDS.forEach((field) => {
      const inputId = `llm-settings-step-${stepKey}-${field.key}`;
      fieldsGrid.appendChild(createOpenWebUiFieldElement(field, inputId, {
        scope: 'step',
        stepKey
      }));
    });

    card.appendChild(fieldsGrid);
    stepListWrap.appendChild(card);
  });

  stepListWrap.querySelectorAll('.llm-settings-step-enable').forEach((toggle) => {
    toggle.addEventListener('change', () => {
      syncOpenWebUiSettingsStepStates(modal);
    });
  });

  modal.dataset.initialized = 'true';
}

function syncOpenWebUiSettingsStepStates(modal) {
  if (!modal) return;

  modal.querySelectorAll('.llm-settings-step-card').forEach((card) => {
    const stepKey = card.dataset.stepKey;
    const toggle = card.querySelector(`#llm-settings-step-enable-${stepKey}`);
    const enabled = !!toggle?.checked;
    card.classList.toggle('is-disabled', !enabled);
    card.querySelectorAll('input[data-scope="step"], select[data-scope="step"]').forEach((control) => {
      control.disabled = !enabled;
    });
  });
}

function fillOpenWebUiSettingsForm(modal, sourceSettings, sourceOptions = {}) {
  if (!modal) return;
  ensureOpenWebUiSettingsModalStructure(modal);

  const normalized = normalizeOpenWebUiApiSettings(sourceSettings);
  const useB2SkillMd = !!sourceOptions.useB2SkillMd;

  const b2SkillToggle = modal.querySelector('#llm-settings-use-b2-skill-md');
  if (b2SkillToggle) {
    b2SkillToggle.checked = useB2SkillMd;
  }

  K_LARC_OPENWEBUI_API_FIELDS.forEach((field) => {
    const input = modal.querySelector(`#llm-settings-global-${field.key}`);
    if (!input) return;
    input.value = formatOpenWebUiFieldInputValue(field, normalized.global[field.key]);
  });

  K_LARC_OPENWEBUI_STEP_ORDER.forEach((stepKey) => {
    const stepConfig = normalized?.perStep?.[stepKey] || {};
    const toggle = modal.querySelector(`#llm-settings-step-enable-${stepKey}`);
    if (toggle) {
      toggle.checked = !!stepConfig.enabled;
    }

    K_LARC_OPENWEBUI_API_FIELDS.forEach((field) => {
      const input = modal.querySelector(`#llm-settings-step-${stepKey}-${field.key}`);
      if (!input) return;
      input.value = formatOpenWebUiFieldInputValue(field, stepConfig[field.key]);
    });
  });

  syncOpenWebUiSettingsStepStates(modal);
}

function collectOpenWebUiSettingsFromForm(modal) {
  const next = createDefaultOpenWebUiApiSettings();

  K_LARC_OPENWEBUI_API_FIELDS.forEach((field) => {
    const input = modal.querySelector(`#llm-settings-global-${field.key}`);
    next.global[field.key] = input ? input.value : '';
  });

  K_LARC_OPENWEBUI_STEP_ORDER.forEach((stepKey) => {
    const toggle = modal.querySelector(`#llm-settings-step-enable-${stepKey}`);
    next.perStep[stepKey].enabled = !!toggle?.checked;
    K_LARC_OPENWEBUI_API_FIELDS.forEach((field) => {
      const input = modal.querySelector(`#llm-settings-step-${stepKey}-${field.key}`);
      next.perStep[stepKey][field.key] = input ? input.value : '';
    });
  });

  const b2SkillToggle = modal.querySelector('#llm-settings-use-b2-skill-md');
  return {
    openwebuiApiSettings: normalizeOpenWebUiApiSettings(next),
    useB2SkillMd: !!b2SkillToggle?.checked
  };
}

function openOpenWebUiSettingsModal() {
  const modal = document.getElementById('llm-settings-modal');
  if (!modal) return;
  ensureOpenWebUiSettingsModalStructure(modal);
  fillOpenWebUiSettingsForm(modal, settings.openwebuiApiSettings, {
    useB2SkillMd: settings.useB2SkillMd
  });
  openDialogModal('llm-settings-modal', '#llm-settings-global-temperature');
  if (larcSettingsToggleButton) {
    larcSettingsToggleButton.setAttribute('aria-expanded', 'true');
  }
}

function closeOpenWebUiSettingsModal() {
  const modal = document.getElementById('llm-settings-modal');
  if (!modal) return;
  closeDialogModal('llm-settings-modal');
  if (larcSettingsToggleButton) {
    larcSettingsToggleButton.setAttribute('aria-expanded', 'false');
  }
}

function initializeOpenWebUiSettingsModal(toggleButton) {
  larcSettingsToggleButton = toggleButton || null;
  if (larcSettingsToggleButton) {
    larcSettingsToggleButton.setAttribute('aria-expanded', 'false');
    larcSettingsToggleButton.addEventListener('click', () => {
      openOpenWebUiSettingsModal();
    });
  }

  const modal = document.getElementById('llm-settings-modal');
  const closeButton = document.getElementById('btn-close-llm-settings');
  const cancelButton = document.getElementById('btn-cancel-llm-settings');
  const resetButton = document.getElementById('btn-reset-llm-settings');
  const saveButton = document.getElementById('btn-save-llm-settings');
  if (!modal) return;

  ensureOpenWebUiSettingsModalStructure(modal);

  if (closeButton) {
    closeButton.addEventListener('click', closeOpenWebUiSettingsModal);
  }
  if (cancelButton) {
    cancelButton.addEventListener('click', closeOpenWebUiSettingsModal);
  }
  if (resetButton) {
    resetButton.addEventListener('click', () => {
      fillOpenWebUiSettingsForm(modal, createDefaultOpenWebUiApiSettings(), {
        useB2SkillMd: false
      });
    });
  }
  if (saveButton) {
    saveButton.addEventListener('click', () => {
      const nextSettings = collectOpenWebUiSettingsFromForm(modal);
      applyOpenWebUiApiSettings(nextSettings.openwebuiApiSettings);
      if (typeof applyStepB2SkillSetting === 'function') {
        applyStepB2SkillSetting(nextSettings.useB2SkillMd);
      }
      closeOpenWebUiSettingsModal();
    });
  }

  modal.addEventListener('click', (event) => {
    if (event.target === modal) {
      closeOpenWebUiSettingsModal();
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  loadTabs();

  if (typeof initializeDecisionWorkspaceUI === 'function') {
    initializeDecisionWorkspaceUI();
  }

  const settingsToggle = document.getElementById('btn-settings-toggle');
  initializeOpenWebUiSettingsModal(settingsToggle);

  const tabSelect = document.getElementById('tab-select');
  if (tabSelect) {
    let tabRefreshTimer = null;
    const scheduleLoadTabs = () => {
      if (tabRefreshTimer) {
        clearTimeout(tabRefreshTimer);
      }
      tabRefreshTimer = setTimeout(() => {
        tabRefreshTimer = null;
        loadTabs();
      }, 120);
    };

    tabSelect.addEventListener('focus', scheduleLoadTabs);
    tabSelect.addEventListener('mousedown', scheduleLoadTabs);
    tabSelect.addEventListener('keydown', (event) => {
      if (event.key === ' ' || event.key === 'Enter' || event.key === 'ArrowDown') {
        scheduleLoadTabs();
      }
    });
  }

  document.getElementById('btn-add-claim').addEventListener('click', addClaimInput);
  const importClaimFromKScanButton = document.getElementById('btn-import-claim-from-kscan');
  if (importClaimFromKScanButton) {
    importClaimFromKScanButton.addEventListener('click', () => {
      void importClaimFromKScan();
    });
  }
  document.getElementById('btn-add-citation').addEventListener('click', addCitationFromTab);

  const addPdfButton = document.getElementById('btn-add-pdf');
  if (addPdfButton) {
    addPdfButton.addEventListener('click', openPdfAddDialog);
  }
  const pdfCitationInput = document.getElementById('pdf-citation-input');
  if (pdfCitationInput) {
    pdfCitationInput.addEventListener('change', handlePdfFileSelected);
  }

  document.getElementById('btn-analyze').addEventListener('click', runAnalysis);
  document.getElementById('btn-edit-mode').addEventListener('click', () => setAnalysisMode(false));
  document.querySelectorAll('input[name="analysis-execution-mode"]').forEach((input) => {
    input.addEventListener('change', (event) => {
      if (!event.target.checked) return;
      setAnalysisExecutionMode(event.target.value);
    });
  });
  if (typeof syncAnalysisExecutionModeToggle === 'function') {
    syncAnalysisExecutionModeToggle();
  }

  const toggleClaimsButton = document.getElementById('btn-toggle-claims-panel');
  if (toggleClaimsButton) {
    toggleClaimsButton.addEventListener('click', () => toggleInputPanelCollapse('claims'));
  }
  const toggleCitationsButton = document.getElementById('btn-toggle-citations-panel');
  if (toggleCitationsButton) {
    toggleCitationsButton.addEventListener('click', () => toggleInputPanelCollapse('citations'));
  }
  const toggleResultButton = document.getElementById('btn-toggle-result-panel');
  if (toggleResultButton) {
    toggleResultButton.addEventListener('click', () => toggleResultPanelCollapse());
    setResultPanelCollapsed(false);
  }

  document.getElementById('btn-add-direct').addEventListener('click', openDirectAddModal);

  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  document.getElementById('preview-modal').addEventListener('click', (event) => {
    if (event.target === document.getElementById('preview-modal')) closeModal();
  });

  document.getElementById('btn-close-direct-modal').addEventListener('click', closeDirectAddModal);
  document.getElementById('btn-cancel-direct-add').addEventListener('click', closeDirectAddModal);
  document.getElementById('btn-save-direct-add').addEventListener('click', handleDirectAdd);
  document.getElementById('direct-add-modal').addEventListener('click', (event) => {
    if (event.target === document.getElementById('direct-add-modal')) closeDirectAddModal();
  });

  const resultClaimSelect = document.getElementById('result-claim-select');
  if (resultClaimSelect) {
    resultClaimSelect.addEventListener('change', (event) => {
      selectResultClaim(Number.parseInt(event.target.value, 10));
    });
  }
  const dockClaimSelect = document.getElementById('dock-claim-select');
  if (dockClaimSelect) {
    dockClaimSelect.addEventListener('change', (event) => {
      selectResultClaim(Number.parseInt(event.target.value, 10));
    });
  }

  document.getElementById('btn-sort-by-doc').addEventListener('click', () => setSortOrder('doc_then_feature'));
  document.getElementById('btn-sort-by-feature').addEventListener('click', () => setSortOrder('feature_then_doc'));

  const copyNoticeTsvButton = document.getElementById('btn-copy-opinion-notice-tsv');
  if (copyNoticeTsvButton) {
    copyNoticeTsvButton.addEventListener('click', () => {
      copyOpinionNoticeTableAsTsv();
    });
  }

  document.getElementById('btn-send-chat').addEventListener('click', sendUserChat);
  document.getElementById('chat-input').addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendUserChat();
    }
  });

  document.getElementById('result-tbody').addEventListener('click', (event) => {
    const positionToken = event.target.closest('.position-token');
    if (positionToken) {
      openPositionModal(
        positionToken.dataset.docName,
        positionToken.dataset.paragraphKey,
        positionToken.dataset.relatedContent || ''
      );
      return;
    }

    const icon = event.target.closest('.verification-icon, .verification-flag[data-reason]');
    if (icon) {
      const reason = icon.dataset.reason;
      if (reason) {
        openVerificationModal(reason);
      }
    }
  });

  document.getElementById('btn-close-verification-modal').addEventListener('click', closeVerificationModal);
  document.getElementById('btn-close-verification-modal-footer').addEventListener('click', closeVerificationModal);
  document.getElementById('verification-modal').addEventListener('click', (event) => {
    if (event.target === document.getElementById('verification-modal')) closeVerificationModal();
  });

  document.getElementById('btn-close-position-modal').addEventListener('click', closePositionModal);
  document.getElementById('btn-close-position-modal-footer').addEventListener('click', closePositionModal);
  document.getElementById('btn-position-modal-translate').addEventListener('click', handlePositionModalTranslateClick);
  if (typeof ensurePositionModalExpandControls === 'function') {
    ensurePositionModalExpandControls();
  }
  const expandPrevButton = document.getElementById('btn-position-modal-expand-prev');
  const expandNextButton = document.getElementById('btn-position-modal-expand-next');
  if (expandPrevButton) {
    expandPrevButton.addEventListener('click', handlePositionModalExpandPrevClick);
  }
  if (expandNextButton) {
    expandNextButton.addEventListener('click', handlePositionModalExpandNextClick);
  }
  document.getElementById('position-modal').addEventListener('click', (event) => {
    if (event.target === document.getElementById('position-modal')) closePositionModal();
  });

  document.getElementById('btn-copy-verification-content').addEventListener('click', () => {
    const content = document.getElementById('verification-modal-content').textContent;
    navigator.clipboard.writeText(content).then(() => {
      alert('내용이 클립보드에 복사되었습니다.');
    }).catch((error) => {
      console.error('클립보드 복사 실패:', error);
      alert('내용 복사에 실패했습니다.');
    });
  });

  const downloadAnalysisButton = document.getElementById('btn-download-analysis-json');
  if (downloadAnalysisButton) {
    downloadAnalysisButton.addEventListener('click', () => {
      const ok = downloadAnalysisSnapshot();
      if (!ok) return;
      alert('분석 데이터 JSON 다운로드를 시작했습니다.');
    });
  }

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      if (!isAnalysisRunning) {
        event.preventDefault();
        runAnalysis();
      }
      return;
    }

    if (event.altKey && !event.ctrlKey && !event.metaKey) {
      const viewMap = {
        '1': 'result',
        '2': 'notice',
        '3': 'chat',
        '4': 'debug'
      };
      const targetView = viewMap[event.key];
      if (targetView) {
        event.preventDefault();
        setWorkspaceView(targetView);
        return;
      }
    }

    if (event.key === 'Escape' && handleGlobalEscapeKey()) {
      event.preventDefault();
      if (settingsToggle) settingsToggle.setAttribute('aria-expanded', 'false');
      return;
    }

    if (event.key === 'Tab') {
      trapFocusInOpenModal(event);
    }
  });

  const debugPanel = document.querySelector('.debug-panel');
  if (debugPanel) {
    debugPanel.classList.toggle('hidden', !DEV_FLAGS.SHOW_DEBUG_PANEL);
  }

  bindWorkspaceSwitchButtons();
  restoreWorkspaceView();

  if (DEV_FLAGS.SHOW_DEBUG_PANEL) {
    initDebugPanel();
    updateDebugExportButtonVisibility();
  }

  updateAnalysisCommandDock();
  refreshOpinionNoticeCard();
});
