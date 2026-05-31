function ensureAnalysisDebugContainer(result) {
  if (!result || typeof result !== 'object') return {};
  if (!result.debug || typeof result.debug !== 'object' || Array.isArray(result.debug)) {
    result.debug = {};
  }
  return result.debug;
}

function ensureStepTimingsContainer(result) {
  const debug = ensureAnalysisDebugContainer(result);
  if (!debug.stepTimings || typeof debug.stepTimings !== 'object' || Array.isArray(debug.stepTimings)) {
    debug.stepTimings = {};
  }
  return debug.stepTimings;
}

function ensureClaimAnalysisResult(claimId) {
  const current = analysisResults?.[claimId];
  if (!current || typeof current !== 'object') {
    analysisResults[claimId] = {
      ClaimFeatures: [],
      Relevant: {},
      FeatureStatus: {},
      verifications: {},
      debug: {}
    };
  } else {
    current.ClaimFeatures = Array.isArray(current.ClaimFeatures) ? current.ClaimFeatures : [];
    current.Relevant = current.Relevant && typeof current.Relevant === 'object' ? current.Relevant : {};
    current.FeatureStatus = current.FeatureStatus && typeof current.FeatureStatus === 'object' ? current.FeatureStatus : {};
    current.verifications = current.verifications && typeof current.verifications === 'object' ? current.verifications : {};
    ensureAnalysisDebugContainer(current);
  }
  if (typeof ensureClaimWorkspace === 'function') {
    ensureClaimWorkspace(claimId);
  }
  return analysisResults[claimId];
}

function startStepTiming(result, stepId) {
  const timings = ensureStepTimingsContainer(result);
  const now = Date.now();
  const previous = timings[stepId] && typeof timings[stepId] === 'object' ? timings[stepId] : {};
  timings[stepId] = {
    ...previous,
    stepId,
    startedAt: now,
    endedAt: null,
    durationMs: null,
    status: 'active'
  };
}

function finishStepTiming(result, stepId, status = 'done') {
  const timings = ensureStepTimingsContainer(result);
  const now = Date.now();
  const current = timings[stepId] && typeof timings[stepId] === 'object' ? timings[stepId] : {};
  const startedAt = Number.isFinite(current.startedAt) ? current.startedAt : now;
  timings[stepId] = {
    ...current,
    stepId,
    startedAt,
    endedAt: now,
    durationMs: Math.max(0, now - startedAt),
    status
  };
}

function markStepTimingSkipped(result, stepId) {
  const timings = ensureStepTimingsContainer(result);
  const now = Date.now();
  timings[stepId] = {
    stepId,
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    status: 'skipped'
  };
}

function getLlmTraceFromResponse(response) {
  if (!response || typeof response !== 'object') return null;
  return response._llmTrace || null;
}

async function runAnalysis() {
  const resultControls = document.getElementById('result-controls');
  const claimSelect = document.getElementById('result-claim-select');
  const summaryBox = document.getElementById('claim-summary-box');
  const table = document.getElementById('analysis-table');
  const emptyState = document.querySelector('.result-panel .empty-state');

  if (isAnalysisRunning) return;

  if (settings.mockMode && typeof ensureMockDemoDataset === 'function') {
    ensureMockDemoDataset();
  }

  const completedCitations = citations
    .filter(citation => citation.status === 'completed' && citation.fileId);
  const validFiles = completedCitations.map(citation => citation.fileId);
  const nonEmptyClaims = claims.filter(c => c.text.trim());
  if (nonEmptyClaims.length === 0) return alert('분석할 청구항이 없습니다.');
  if (validFiles.length === 0) return alert('업로드 완료된 인용발명이 없습니다.');
  if (!settings.mockMode && !settings.key) return alert('API Key가 필요합니다.');

  isAnalysisRunning = true;
  setAnalyzeButtonState(true);
  if (typeof updateDebugExportButtonVisibility === 'function') {
    updateDebugExportButtonVisibility();
  }

  try {
    const executionMode = typeof getAnalysisExecutionMode === 'function'
      ? getAnalysisExecutionMode()
      : (analysisExecutionMode || 'deep');
    const modeLabel = executionMode === 'quick' ? 'Quick Analysis' : 'Deep Analysis';

    localStorage.setItem('analysisLastRunAt', new Date().toISOString());
    localStorage.setItem('analysisLastStep', `${modeLabel} start`);
    setAnalysisMode(true);

    analysisResults = {};
    claimSelect.innerHTML = '';
    summaryBox.classList.add('hidden');
    table.classList.add('hidden');
    emptyState.style.display = 'block';
    emptyState.innerHTML = '분석을 시작합니다...<br>잠시만 기다려주세요.';
    resultControls.classList.remove('hidden');

    initializeClaimProgress(nonEmptyClaims);
    refreshResultClaimSelect(nonEmptyClaims);
    if (claimSelect.options.length > 0) {
      selectResultClaim(claimSelect.options[0].value);
    }

    const mapInfo = completedCitations
      .map(c => String(c?.name || '').trim())
      .filter(Boolean)
      .join('\n');
    const totalClaims = nonEmptyClaims.length;

    for (const [index, claim] of nonEmptyClaims.entries()) {
      const claimLabel = `(${index + 1}/${totalClaims}) ${claim.name}`;
      localStorage.setItem('analysisLastStep', `${modeLabel} running ${claimLabel}`);
      setClaimProgressStatus(claim.id, 'running', `대기열 등록 ${claimLabel}`);

      if (executionMode === 'quick') {
        const quickTarget = ensureClaimAnalysisResult(claim.id);
        startStepTiming(quickTarget, 'A');
        setClaimStepState(claim.id, 'A', 'active', `Quick analysis running ${claimLabel}`);
        try {
          const quick = await runQuickAnalysisForClaim(claim, mapInfo, validFiles);
          quickTarget.ClaimFeatures = quick.claimFeatures || [];
          quickTarget.Relevant = quick.relevant || {};
          quickTarget.FeatureStatus = quick.featureStatus || {};
          quickTarget.verifications = quick.verifications || {};
          quickTarget.debug = quickTarget.debug || {};
          quickTarget.debug.quick = quick.debug || null;
          if (typeof recomputeClaimWorkspace === 'function') {
            recomputeClaimWorkspace(claim.id, { persist: false });
          }
          finishStepTiming(quickTarget, 'A', 'done');
          ['B', 'C', 'D', 'E'].forEach(stepId => markStepTimingSkipped(quickTarget, stepId));
          setClaimStepState(claim.id, 'A', 'done', `Quick analysis done ${claimLabel}`);
          ['B', 'C', 'D', 'E'].forEach(stepId => setClaimStepState(claim.id, stepId, 'done'));
          setClaimProgressStatus(claim.id, 'done', `Done ${claimLabel}`);
        } catch (e) {
          quickTarget.error = e.message;
          quickTarget.debug = quickTarget.debug || {};
          quickTarget.debug.quickError = e.message;
          finishStepTiming(quickTarget, 'A', 'error');
          setClaimStepState(claim.id, 'A', 'error', `Quick analysis failed: ${e.message}`);
          setClaimProgressStatus(claim.id, 'error', `Analysis stopped: ${e.message}`);
          saveAnalysisResultsToStorage();
          continue;
        }

        if (DEV_FLAGS.SHOW_DEBUG_PANEL) {
          updateDebugClaimSelect();
          renderDebugContent();
        }
        saveAnalysisResultsToStorage();
        continue;
      }

      const target = ensureClaimAnalysisResult(claim.id);
      // Step A
      startStepTiming(target, 'A');
      setClaimStepState(claim.id, 'A', 'active', `A단계 진행 중 ${claimLabel}`);
      try {
        const stepA = await runStepAForClaim(claim);
        target.ClaimFeatures = stepA?.ClaimFeatures || [];
        target.Relevant = {};
        target.FeatureStatus = {};
        target.verifications = {};
        target.error = null;
        target.debug = target.debug || {};
        target.debug.stepA = stepA;
        finishStepTiming(target, 'A', 'done');
        setClaimStepState(claim.id, 'A', 'done', `A단계 완료 ${claimLabel}`);
      } catch (e) {
        target.error = e.message;
        target.debug = target.debug || {};
        target.debug.stepAError = e.message;
        finishStepTiming(target, 'A', 'error');
        setClaimStepState(claim.id, 'A', 'error', `A단계 실패: ${e.message}`);
        setClaimProgressStatus(claim.id, 'error', `Analysis stopped: ${e.message}`);
        saveAnalysisResultsToStorage();
        continue;
      }

      if (!target || target.error) {
        setClaimProgressStatus(claim.id, 'error', target?.error || 'Unknown error');
        saveAnalysisResultsToStorage();
        continue;
      }

      // Step B
      startStepTiming(target, 'B');
      setClaimStepState(claim.id, 'B', 'active', `B단계 진행 중 ${claimLabel}`);
      try {
        setClaimProgressMessage(claim.id, `B-1 쿼리 생성 중 ${claimLabel}`);
        const stepB1 = await runStepBQueryGeneration(target.ClaimFeatures);
        const stepBQueries = stepB1.queriesByFeature || {};
        const plannedBundles = getStepBQueryBundleCount(target.ClaimFeatures, stepBQueries);
        const plannedExtraBundles = getStepBAdditionalRandomBundleCount(plannedBundles);
        const plannedDispatches = plannedBundles + plannedExtraBundles;

        setClaimProgressMessage(
          claim.id,
          `B-1 완료 | B-2 멀티쿼리 RAG 시작 (총 ${plannedDispatches}건 전송 예정)`
        );

        const stepB2Initial = await runStepBParallelRag(
          target.ClaimFeatures,
          stepBQueries,
          mapInfo,
          validFiles,
          {
            claimName: claim.name,
            claimIndex: index + 1,
            totalClaims,
            useLegacyProgress: false,
            onBundleProgress: ({ sent, total, returned, succeeded, failed }) => {
              setClaimProgressMessage(
                claim.id,
                `B-2 멀티쿼리 RAG 진행 중 | 전송 ${sent}/${total}, 응답 ${returned}/${total}, 성공 ${succeeded}, 실패 ${failed}`
              );
            }
          }
        );

        const initialReceivedCount = stepB2Initial.responses?.length || 0;
        const initialSuccessCount = (stepB2Initial.responses || []).filter(entry => entry?.ok).length;
        const initialFailedCount = initialReceivedCount - initialSuccessCount;
        const initialTotalBundles = Number.isFinite(stepB2Initial.totalBundles)
          ? stepB2Initial.totalBundles
          : plannedDispatches;

        setClaimProgressMessage(
          claim.id,
          `B-2 완료 | B-3 병합 진행 중 (응답 ${initialReceivedCount}/${initialTotalBundles}, 성공 ${initialSuccessCount}, 실패 ${initialFailedCount})`
        );
        const stepB3Initial = await runStepBMergeRag(stepB2Initial.responses || []);
        const initialCoverage = buildStepBCitationCoverage(stepB3Initial.relevant || {}, completedCitations);

        let mergedStepBRelevant = stepB3Initial.relevant || {};
        let stepBResponsesForDebug = stepB2Initial.responses || [];
        let finalCoverage = initialCoverage;
        let retryDebug = null;

        if (initialCoverage.missingCount > 0) {
          const missingLabel = formatStepBCitationMissingLabel(initialCoverage.missing);
          setClaimProgressMessage(
            claim.id,
            `B-2 재시도 시작 | 증거 미탐지 문헌: ${missingLabel} | reasoning=medium`
          );

          const stepB2Retry = await runStepBParallelRag(
            target.ClaimFeatures,
            stepBQueries,
            mapInfo,
            validFiles,
            {
              claimName: claim.name,
              claimIndex: index + 1,
              totalClaims,
              useLegacyProgress: false,
              onBundleProgress: ({ sent, total, returned, succeeded, failed }) => {
                setClaimProgressMessage(
                  claim.id,
                  `B-2 재시도 진행 중 | 전송 ${sent}/${total}, 응답 ${returned}/${total}, 성공 ${succeeded}, 실패 ${failed}`
                );
              }
            },
            {
              stepApiOverrides: {
                stepBRag: { reasoning_effort: 'medium' },
                stepBRagRepair: { reasoning_effort: 'medium' }
              }
            }
          );

          const retryReceivedCount = stepB2Retry.responses?.length || 0;
          const retrySuccessCount = (stepB2Retry.responses || []).filter(entry => entry?.ok).length;
          const retryFailedCount = retryReceivedCount - retrySuccessCount;
          const retryTotalBundles = Number.isFinite(stepB2Retry.totalBundles)
            ? stepB2Retry.totalBundles
            : plannedDispatches;
          setClaimProgressMessage(
            claim.id,
            `B-2 재시도 완료 | B-3 재병합 진행 중 (응답 ${retryReceivedCount}/${retryTotalBundles}, 성공 ${retrySuccessCount}, 실패 ${retryFailedCount})`
          );

          const stepB3Retry = await runStepBMergeRag(stepB2Retry.responses || []);
          mergedStepBRelevant = mergeRelevantBySnippet(
            mergeRelevantWithPositions(mergedStepBRelevant, stepB3Retry.relevant || {}),
            { dropSourceExcerpt: false }
          );
          stepBResponsesForDebug = [
            ...(stepB2Initial.responses || []),
            ...(stepB2Retry.responses || [])
          ];
          finalCoverage = buildStepBCitationCoverage(mergedStepBRelevant, completedCitations);

          retryDebug = {
            attempted: true,
            reason: 'missing_citation_evidence',
            reasoningEffort: 'medium',
            missingBeforeRetry: initialCoverage.missing,
            responses: stepB2Retry.responses || [],
            merge: stepB3Retry.debug || null,
            randomExtra: stepB2Retry.randomExtra || null,
            coverageAfterRetry: finalCoverage
          };

          if (finalCoverage.missingCount > 0) {
            setClaimProgressMessage(
              claim.id,
              `B-2 재시도 완료 | 일부 문헌 증거 미탐지 지속 (${formatStepBCitationMissingLabel(finalCoverage.missing)})`
            );
          } else {
            setClaimProgressMessage(claim.id, 'B-2 재시도 완료 | 모든 문헌에서 최소 1건 이상 증거 확보');
          }
        }

        target.debug = target.debug || {};
        target.debug.stepB = {
          stepB1: stepB1.debug || null,
          queries: stepBQueries,
          queriesByIndex: stepB2Initial.queriesByIndex,
          randomExtra: stepB2Initial.randomExtra || null,
          responses: stepBResponsesForDebug,
          merge: {
            mode: 'deterministic',
            initial: stepB3Initial.debug || null,
            retry: retryDebug?.merge || null,
            coverageInitial: initialCoverage,
            coverageFinal: finalCoverage
          },
          retry: retryDebug
        };
        target.stepBRelevant = mergedStepBRelevant;
        finishStepTiming(target, 'B', 'done');
        setClaimStepState(claim.id, 'B', 'done', `B단계 완료 ${claimLabel}`);
      } catch (e) {
        target.error = e.message;
        target.debug = target.debug || {};
        target.debug.stepBError = e.message;
        finishStepTiming(target, 'B', 'error');
        setClaimStepState(claim.id, 'B', 'error', `B단계 실패: ${e.message}`);
        setClaimProgressStatus(claim.id, 'error', `Analysis stopped: ${e.message}`);
        saveAnalysisResultsToStorage();
        continue;
      }

      // Step C
      startStepTiming(target, 'C');
      setClaimStepState(claim.id, 'C', 'active', `C단계 진행 중 ${claimLabel}`);
      try {
        const stepBMergedRelevant = target.stepBRelevant || {};
        const stepC = await runStepCForClaim(claim, target.ClaimFeatures, stepBMergedRelevant, {
          onJudgeProgress: ({ completed, total, succeeded, failed, judgeId }) => {
            const judgeTag = judgeId ? ` | ${judgeId}` : '';
            setClaimProgressMessage(
              claim.id,
              `C-judge 판정 진행 중${judgeTag} | 완료 ${completed}/${total}, 성공 ${succeeded}, 실패 ${failed}`
            );
          }
        });
        target.Relevant = mergeRelevantBySnippet(stepC.relevant || {}, { dropSourceExcerpt: false });
        target.FeatureStatus = stepC.featureStatus || {};
        target.debug = target.debug || {};
        target.debug.stepC = stepC.debug;
        if (typeof recomputeClaimWorkspace === 'function') {
          recomputeClaimWorkspace(claim.id, { persist: false });
        }
        finishStepTiming(target, 'C', 'done');
        setClaimStepState(claim.id, 'C', 'done', `C단계 완료 ${claimLabel}`);
      } catch (e) {
        target.error = e.message;
        target.debug = target.debug || {};
        target.debug.stepCError = e.message;
        finishStepTiming(target, 'C', 'error');
        setClaimStepState(claim.id, 'C', 'error', `C단계 실패: ${e.message}`);
        setClaimProgressStatus(claim.id, 'error', `Analysis stopped: ${e.message}`);
        saveAnalysisResultsToStorage();
        continue;
      }

      // Step D
      startStepTiming(target, 'D');
      setClaimStepState(claim.id, 'D', 'active', `D단계 진행 중 ${claimLabel}`);
      const missing = getMissingFeatures(target.ClaimFeatures, target.FeatureStatus, target.Relevant);
      if (missing.length === 0) {
        target.debug = target.debug || {};
        target.debug.stepD = { skipped: true };
        markStepTimingSkipped(target, 'D');
        setClaimStepState(claim.id, 'D', 'done', 'D단계 건너뜀 (누락 구성요소 없음)');
      } else {
        try {
          const stepD = await runStepDForClaim(claim, missing, mapInfo, validFiles, target);
          const missingFeatureIds = missing.map(feature => feature.Id);
          const stepDCandidates = filterRelevantByFeatureIds(stepD.relevant || {}, missingFeatureIds);

          let stepDReview = null;
          if (hasAnyRelevantEntry(stepDCandidates)) {
            stepDReview = await runStepCForClaim(claim, missing, stepDCandidates);
            const mergedAfterRepair = mergeRelevant(target.Relevant, stepDReview.relevant || {});
            target.Relevant = mergeRelevantBySnippet(mergedAfterRepair, { dropSourceExcerpt: false });
          }

          missing.forEach(feature => {
            const reviewedStatus = stepDReview?.featureStatus?.[feature.Id];
            if (reviewedStatus) {
              target.FeatureStatus[feature.Id] = reviewedStatus;
            }
          });

          target.debug = target.debug || {};
          target.debug.stepD = {
            repair: stepD.debug || null,
            reviewByStepC: stepDReview?.debug || null,
            acceptedRelevant: stepDReview?.relevant || {}
          };
          if (typeof recomputeClaimWorkspace === 'function') {
            recomputeClaimWorkspace(claim.id, { persist: false });
          }
          finishStepTiming(target, 'D', 'done');
          setClaimStepState(claim.id, 'D', 'done', `D단계 완료 ${claimLabel}`);
        } catch (e) {
          target.debug = target.debug || {};
          target.debug.stepDError = e.message;
          finishStepTiming(target, 'D', 'error');
          setClaimStepState(claim.id, 'D', 'error', `D단계 실패: ${e.message}`);
        }
      }

      // Step E
      startStepTiming(target, 'E');
      setClaimStepState(claim.id, 'E', 'active', `E단계 진행 중 ${claimLabel}`);
      try {
        await runVerificationStage([claim], mapInfo);
        if (typeof recomputeClaimWorkspace === 'function') {
          recomputeClaimWorkspace(claim.id, { persist: false });
        }
        finishStepTiming(target, 'E', 'done');
      } catch (e) {
        target.error = e.message;
        target.debug = target.debug || {};
        target.debug.stepEError = e.message;
        finishStepTiming(target, 'E', 'error');
        throw e;
      }
      setClaimStepState(claim.id, 'E', 'done', `E단계 완료 ${claimLabel}`);
      setClaimProgressStatus(claim.id, 'done', `완료 ${claimLabel}`);

      if (DEV_FLAGS.SHOW_DEBUG_PANEL) {
        updateDebugClaimSelect();
        renderDebugContent();
      }
      saveAnalysisResultsToStorage();
    }

    localStorage.setItem('analysisLastStep', `${modeLabel} done`);
    if (claimSelect.options.length > 0) {
      if (!claimSelect.value) {
        claimSelect.selectedIndex = 0;
      }
      selectResultClaim(claimSelect.value);
    }

    if (DEV_FLAGS.SHOW_DEBUG_PANEL) {
      updateDebugClaimSelect();
      renderDebugContent();
    }

    saveAnalysisResultsToStorage();
  } catch (error) {
    console.error('분석 실행 중 오류:', error);
    alert(`분석 중 오류가 발생했습니다: ${error?.message || error}`);
  } finally {
    isAnalysisRunning = false;
    setAnalyzeButtonState(false);
    if (typeof updateDebugExportButtonVisibility === 'function') {
      updateDebugExportButtonVisibility();
    }
  }
}

async function runStepAForClaim(claim) {
  const promptPair = await renderLarcPromptPair('stepAFeatures', {
    claim_id: claim.id,
    claim_text: claim.text
  });
  const payload = applyStepApiOptions({
    model: resolveLarcModelName(),
    messages: promptPair.messages
  }, 'stepAFeatures');

  const response = await sendLLMRequest(payload, {
    stepKey: 'stepAFeatures',
    promptKey: 'stepAFeatures',
    label: `claim_${claim.id}`
  });
  if (response.ok && response.data && response.data.choices) {
    const content = response.data.choices[0].message.content;
    const parsed = safeJsonParse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        ...parsed,
        llm: getLlmTraceFromResponse(response)
      };
    }
    return {
      ClaimFeatures: Array.isArray(parsed) ? parsed : [],
      rawParsed: parsed,
      llm: getLlmTraceFromResponse(response)
    };
  }
  throw new Error(response.error || 'A단계 실패');
}

function normalizeQuickVerificationFlag(value) {
  const text = String(value || '').trim().toUpperCase();
  if (!text) return null;
  if (text === 'P' || text === 'PASS' || text === 'TRUE') return 'P';
  if (text === 'F' || text === 'FAIL' || text === 'FALSE') return 'F';
  return null;
}

function buildQuickVerificationFlags(rawVerification, rawRelevant, normalizedRelevant) {
  const flags = {};

  Object.entries(rawVerification || {}).forEach(([key, rawValue]) => {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) return;
    const value = rawValue && typeof rawValue === 'object'
      ? (rawValue.flag || rawValue.status || rawValue.label || rawValue.result || rawValue.verification)
      : rawValue;
    const flag = normalizeQuickVerificationFlag(value);
    if (!flag) return;
    flags[normalizedKey] = flag;
  });

  Object.entries(rawRelevant || {}).forEach(([docName, items]) => {
    if (!Array.isArray(items)) return;
    items.forEach(item => {
      const featureId = String(item?.Feature || '').trim();
      if (!featureId) return;
      const flag = normalizeQuickVerificationFlag(
        item?.Verification || item?.verification || item?.Verify || item?.verify
      );
      if (!flag) return;
      flags[`${featureId}_${docName}`] = flag;
    });
  });

  if (Object.keys(flags).length === 0) {
    Object.entries(normalizedRelevant || {}).forEach(([docName, items]) => {
      if (!Array.isArray(items)) return;
      items.forEach(item => {
        const featureId = String(item?.Feature || '').trim();
        if (!featureId) return;
        flags[`${featureId}_${docName}`] = 'F';
      });
    });
  }

  return flags;
}

async function runQuickAnalysisForClaim(claim, mapInfo, fileIds) {
  const quickInput = {
    claimId: claim.id,
    claimName: claim.name,
    claimText: claim.text
  };
  const promptPair = await renderLarcPromptPair('stepQuickAnalysis', {
    mapInfo,
    quick_input_json: quickInput,
    claim_id: claim.id,
    claim_name: claim.name,
    claim_text: claim.text
  });
  const payload = applyStepApiOptions({
    model: resolveLarcModelName(),
    messages: promptPair.messages,
    files: buildFileRefs(fileIds)
  }, 'stepQuickAnalysis');

  const response = await sendLLMRequest(payload, {
    stepKey: 'stepQuickAnalysis',
    promptKey: 'stepQuickAnalysis',
    label: `claim_${claim.id}`
  });
  if (response.ok && response.data && response.data.choices) {
    const content = response.data.choices[0].message.content;
    const parsed = safeJsonParse(content) || {};
    const claimFeatures = Array.isArray(parsed.ClaimFeatures) ? parsed.ClaimFeatures : [];
    const rawRelevant = parsed.Relevant || parsed.relevant || {};
    const relevant = mergeRelevantWithPositions({}, rawRelevant);
    const featureStatus = parsed.FeatureStatus || parsed.featureStatus || {};
    const verifications = buildQuickVerificationFlags(
      parsed.Verification || parsed.Verifications || {},
      rawRelevant,
      relevant
    );

    return {
      claimFeatures,
      relevant,
      featureStatus,
      verifications,
      debug: {
        ClaimFeatures: claimFeatures,
        FeatureStatus: featureStatus,
        Verification: verifications,
        llm: getLlmTraceFromResponse(response)
      }
    };
  }
  throw new Error(response.error || 'Quick analysis failed');
}

async function runStepBQueryGeneration(claimFeatures) {
  const promptPair = await renderLarcPromptPair('stepBQuery', {
    claim_features_json: claimFeatures
  });
  const payload = applyStepApiOptions({
    model: resolveLarcModelName(),
    messages: promptPair.messages
  }, 'stepBQuery');

  const response = await sendLLMRequest(payload, {
    stepKey: 'stepBQuery',
    promptKey: 'stepBQuery'
  });
  if (response.ok && response.data && response.data.choices) {
    const content = response.data.choices[0].message.content;
    const parsed = safeJsonParse(content);
    const queries = parsed.Queries || parsed;

    const rawByFeature = {};
    let bundleCount = 0;
    (claimFeatures || []).forEach(feature => {
      const list = Array.isArray(queries?.[feature.Id])
        ? queries[feature.Id].filter(q => typeof q === 'string').map(q => q.trim()).filter(Boolean)
        : [];
      rawByFeature[feature.Id] = list;
      bundleCount = Math.max(bundleCount, list.length);
    });

    if (bundleCount < 1) bundleCount = 1;
    bundleCount = Math.min(4, bundleCount);

    const normalized = {};
    (claimFeatures || []).forEach(feature => {
      normalized[feature.Id] = ensureQueryCount(feature, rawByFeature[feature.Id] || [], bundleCount);
    });
    return {
      queriesByFeature: normalized,
      debug: {
        parsed,
        llm: getLlmTraceFromResponse(response)
      }
    };
  }
  throw new Error(response.error || 'B-1 실패');
}

function getStepBQueryBundleCount(claimFeatures, queriesByFeature) {
  let bundleCount = 0;
  (claimFeatures || []).forEach(feature => {
    const count = Array.isArray(queriesByFeature?.[feature.Id]) ? queriesByFeature[feature.Id].length : 0;
    bundleCount = Math.max(bundleCount, count);
  });
  return Math.min(4, Math.max(1, bundleCount));
}

const STEP_B_RANDOM_EXTRA_QUERY_COUNT = 2;
const STEP_B_RANDOM_EXTRA_REASONING_EFFORT = 'medium';

function getStepBAdditionalRandomBundleCount(bundleCount, runtimeOptions = {}) {
  const totalBundles = Number.isFinite(bundleCount) ? Math.max(0, Math.floor(bundleCount)) : 0;
  if (totalBundles < 1) return 0;
  const rawCount = runtimeOptions && typeof runtimeOptions === 'object'
    ? runtimeOptions.additionalRandomBundleCount
    : undefined;
  if (rawCount === undefined || rawCount === null || rawCount === '') {
    return STEP_B_RANDOM_EXTRA_QUERY_COUNT;
  }
  const parsed = Number.parseInt(rawCount, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

function pickStepBRandomBundleIndexes(totalBundles, pickCount) {
  const total = Number.isFinite(totalBundles) ? Math.max(0, Math.floor(totalBundles)) : 0;
  const count = Number.isFinite(pickCount) ? Math.max(0, Math.floor(pickCount)) : 0;
  if (total < 1 || count < 1) return [];
  if (total === 1) return Array.from({ length: count }, () => 0);

  const pool = Array.from({ length: total }, (_, index) => index);
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const current = pool[index];
    pool[index] = pool[swapIndex];
    pool[swapIndex] = current;
  }

  if (count <= total) return pool.slice(0, count);

  const selected = [...pool];
  for (let index = total; index < count; index += 1) {
    selected.push(pool[index % total]);
  }
  return selected;
}

function buildStepBMediumReasoningRuntimeOptions(runtimeOptions = {}) {
  const source = runtimeOptions && typeof runtimeOptions === 'object' ? runtimeOptions : {};
  const sourceOverrides = source.stepApiOverrides && typeof source.stepApiOverrides === 'object' && !Array.isArray(source.stepApiOverrides)
    ? source.stepApiOverrides
    : {};
  const stepBRagOverride = sourceOverrides.stepBRag && typeof sourceOverrides.stepBRag === 'object' && !Array.isArray(sourceOverrides.stepBRag)
    ? sourceOverrides.stepBRag
    : {};
  const stepBRagRepairOverride = sourceOverrides.stepBRagRepair && typeof sourceOverrides.stepBRagRepair === 'object' && !Array.isArray(sourceOverrides.stepBRagRepair)
    ? sourceOverrides.stepBRagRepair
    : {};

  return {
    ...source,
    stepApiOverrides: {
      ...sourceOverrides,
      stepBRag: {
        ...stepBRagOverride,
        reasoning_effort: STEP_B_RANDOM_EXTRA_REASONING_EFFORT
      },
      stepBRagRepair: {
        ...stepBRagRepairOverride,
        reasoning_effort: STEP_B_RANDOM_EXTRA_REASONING_EFFORT
      }
    }
  };
}

function normalizeRuntimeReasoningEffort(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['low', 'medium', 'high'].includes(normalized) ? normalized : '';
}

function getStepBStepApiOverrides(runtimeOptions, stepKey) {
  const source = runtimeOptions && typeof runtimeOptions === 'object'
    ? runtimeOptions.stepApiOverrides
    : null;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const raw = source[stepKey];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw;
}

function applyStepBStepApiOptions(payload, stepKey, runtimeOptions = {}) {
  const basePayload = applyStepApiOptions(payload, stepKey);
  const overrides = getStepBStepApiOverrides(runtimeOptions, stepKey);
  if (!overrides) return basePayload;

  const next = {
    ...basePayload,
    ...overrides
  };
  const overrideReasoningEffort = normalizeRuntimeReasoningEffort(overrides.reasoning_effort);
  if (overrideReasoningEffort) {
    next.reasoning_effort = overrideReasoningEffort;
  }
  return next;
}

function buildStepBCitationCoverage(relevant, expectedCitations) {
  const expected = Array.isArray(expectedCitations) ? expectedCitations : [];
  const expectedById = expected.map((citation, index) => {
    const citationId = String(citation?.id ?? `citation_${index + 1}`);
    const citationName = String(citation?.name || '').trim() || `D${index + 1}`;
    const citationTitle = String(citation?.title || '').trim();
    const aliases = new Set([
      citationName.toUpperCase(),
      citationTitle.toUpperCase(),
      `D${index + 1}`
    ].filter(Boolean));
    return {
      citationId,
      citationName,
      citationTitle,
      citation,
      aliases
    };
  });

  const evidenceByCitationId = new Map(
    expectedById.map((entry) => [
      entry.citationId,
      {
        count: 0,
        docs: new Set()
      }
    ])
  );

  Object.entries(relevant || {}).forEach(([docName, items]) => {
    if (!Array.isArray(items) || items.length === 0) return;
    const safeDocName = String(docName || '').trim();
    if (!safeDocName) return;

    let matchedCitationId = null;
    if (typeof resolveCitationByDocName === 'function') {
      const resolved = resolveCitationByDocName(safeDocName);
      if (resolved) {
        const resolvedId = String(resolved?.id ?? '').trim();
        const resolvedById = expectedById.find((entry) => String(entry?.citation?.id ?? '').trim() === resolvedId);
        if (resolvedById) matchedCitationId = resolvedById.citationId;
      }
    }

    if (!matchedCitationId) {
      const upperDocName = safeDocName.toUpperCase();
      const matched = expectedById.find((entry) => entry.aliases.has(upperDocName));
      if (matched) matchedCitationId = matched.citationId;
    }

    if (!matchedCitationId) return;
    const bucket = evidenceByCitationId.get(matchedCitationId);
    if (!bucket) return;
    bucket.count += items.length;
    bucket.docs.add(safeDocName);
  });

  const coverage = expectedById.map((entry) => {
    const bucket = evidenceByCitationId.get(entry.citationId) || { count: 0, docs: new Set() };
    const docs = Array.from(bucket.docs);
    return {
      citationId: entry.citationId,
      citationName: entry.citationName,
      citationTitle: entry.citationTitle,
      evidenceCount: bucket.count,
      docs,
      hasEvidence: bucket.count > 0
    };
  });

  const missing = coverage.filter((entry) => !entry.hasEvidence);
  return {
    total: coverage.length,
    covered: coverage.length - missing.length,
    missingCount: missing.length,
    coverage,
    missing
  };
}

function formatStepBCitationMissingLabel(missingCoverageList) {
  const list = Array.isArray(missingCoverageList) ? missingCoverageList : [];
  if (list.length === 0) return '-';
  return list
    .map((entry) => {
      const name = String(entry?.citationName || '').trim() || 'Unknown';
      const title = String(entry?.citationTitle || '').trim();
      return title && title !== name ? `${name}(${title})` : name;
    })
    .join(', ');
}

function buildStepBRepairTargetSets(repairRequestJson) {
  const targetFeatureKeys = new Set();
  const targetDocFeatureKeys = new Set();

  (repairRequestJson?.invalid_items || []).forEach((entry) => {
    const featureId = String(entry?.item?.Feature || '').trim();
    const docName = String(entry?.docName || '').trim();
    if (featureId && docName) {
      targetDocFeatureKeys.add(`${docName}||${featureId}`);
    }
  });

  if (String(repairRequestJson?.mode || '').trim() === 'json_repair') {
    (repairRequestJson?.target_features || []).forEach((entry) => {
      const featureId = String(entry?.Feature || entry?.Id || '').trim();
      if (featureId) {
        targetFeatureKeys.add(featureId);
      }
    });
  }

  return { targetFeatureKeys, targetDocFeatureKeys };
}

function filterRelevantForRepairTargets(relevant, repairRequestJson) {
  const { targetFeatureKeys, targetDocFeatureKeys } = buildStepBRepairTargetSets(repairRequestJson);
  if (targetFeatureKeys.size === 0 && targetDocFeatureKeys.size === 0) {
    return relevant && typeof relevant === 'object' ? relevant : {};
  }

  const filtered = {};
  Object.entries(relevant || {}).forEach(([docName, items]) => {
    if (!Array.isArray(items)) return;
    const kept = items.filter((rawItem) => {
      const featureId = String(rawItem?.Feature || '').trim();
      if (!featureId) return false;
      if (targetDocFeatureKeys.has(`${docName}||${featureId}`)) return true;
      return targetFeatureKeys.has(featureId);
    });
    if (kept.length > 0) {
      filtered[docName] = kept;
    }
  });
  return filtered;
}

function buildStepBRepairRequestJson(queryIndex, featuresWithQueries, invalidItems, options = {}) {
  const invalid = (invalidItems || []).map((entry, index) => ({
    order: index + 1,
    docName: String(entry?.docName || '').trim(),
    validationError: String(entry?.validationError || '').trim(),
    validationMessage: String(entry?.validationMessage || '').trim(),
    candidatePositions: Array.isArray(entry?.candidatePositions) ? entry.candidatePositions : [],
    item: {
      Feature: String(entry?.item?.Feature || '').trim(),
      MatchType: String(entry?.item?.MatchType || '').trim(),
      Content: String(entry?.item?.Content || '').trim(),
      SourceExcerpt: String(entry?.item?.SourceExcerpt || '').trim(),
      Position: String(entry?.item?.Position || '').trim()
    }
  }));

  return {
    query_index: queryIndex,
    mode: String(options.mode || 'grounding_repair').trim() || 'grounding_repair',
    note: String(options.note || '').trim(),
    target_features: (featuresWithQueries || []).map((entry) => ({
      Feature: String(entry?.Id || '').trim(),
      Description: String(entry?.Description || '').trim(),
      Query: String(entry?.Query || '').trim()
    })),
    invalid_items: invalid
  };
}

async function runStepBRagRepairBundle(queryIndex, fileIds, promptPair, priorMessages, repairRequestJson, runtimeOptions = {}) {
  const repairPrompt = await renderLarcPromptPair('stepBRagRepair', {
    query_index: queryIndex,
    repair_request_json: repairRequestJson
  });
  const conversationHistory = Array.isArray(priorMessages)
    ? priorMessages.filter((message) => (
      message
      && (message.role === 'assistant' || message.role === 'user')
      && typeof message.content === 'string'
      && message.content.trim()
    ))
    : [];
  const repairUserMessage = { role: 'user', content: repairPrompt.user };

  const payload = applyStepBStepApiOptions({
    model: resolveLarcModelName(),
    messages: [
      ...promptPair.messages,
      ...conversationHistory,
      repairUserMessage
    ],
    files: buildFileRefs(fileIds)
  }, 'stepBRagRepair', runtimeOptions);

  const response = await sendLLMRequest(payload, {
    stepKey: 'stepBRagRepair',
    promptKey: 'stepBRagRepair',
    label: `bundle_${queryIndex}`
  });
  if (!response.ok || !response.data?.choices?.length) {
    throw new Error(response?.error || 'B-2 repair failed');
  }

  const repairContent = response.data.choices[0].message.content;
  let repairParsed = {};
  try {
    repairParsed = safeJsonParse(repairContent) || {};
  } catch (error) {
    throw new Error(`B-2 repair parse failed: ${error?.message || error}`);
  }
  const filteredRelevant = filterRelevantForRepairTargets(repairParsed.Relevant || {}, repairRequestJson);
  const repairValidation = validateAndRepairRelevantEntries(filteredRelevant);

  return {
    repairUserMessage,
    rawContent: repairContent,
    parsed: repairParsed,
    validation: repairValidation,
    llm: getLlmTraceFromResponse(response)
  };
}

function normalizeStepB2SkillPromptContext(rawContext) {
  const source = (rawContext && typeof rawContext === 'object') ? rawContext : {};
  const sourceMeta = (source.meta && typeof source.meta === 'object') ? source.meta : {};
  return {
    promptText: String(source.promptText || '').trim(),
    meta: {
      enabled: !!sourceMeta.enabled,
      loaded: !!sourceMeta.loaded,
      path: String(sourceMeta.path || K_LARC_B2_SKILL_FILE_PATH || '').trim(),
      error: sourceMeta.error ? String(sourceMeta.error) : null
    }
  };
}

async function resolveStepB2SkillPromptContext() {
  const enabled = !!settings?.useB2SkillMd;
  const baseMeta = {
    enabled,
    loaded: false,
    path: String(K_LARC_B2_SKILL_FILE_PATH || '').trim(),
    error: null
  };

  if (!enabled) {
    return { promptText: '', meta: baseMeta };
  }

  try {
    const skillMarkdown = await loadLarcSkillMarkdown(K_LARC_B2_SKILL_FILE_PATH);
    const normalizedSkill = String(skillMarkdown || '').trim();
    if (!normalizedSkill) {
      return {
        promptText: '',
        meta: {
          ...baseMeta,
          error: 'SKILL.md is empty.'
        }
      };
    }

    return {
      promptText: [
        '[B-2 Skill Guidance]',
        'Use the following guidance from SKILL.md as additional guardrails for Step B-2.',
        normalizedSkill
      ].join('\n\n'),
      meta: {
        ...baseMeta,
        loaded: true
      }
    };
  } catch (error) {
    console.warn('Failed to load Step B-2 SKILL.md:', error);
    return {
      promptText: '',
      meta: {
        ...baseMeta,
        error: error?.message || String(error)
      }
    };
  }
}

async function runStepBParallelRag(claimFeatures, queriesByFeature, mapInfo, fileIds, progressMeta, runtimeOptions = {}) {
  if (!claimFeatures || claimFeatures.length === 0) {
    return { relevant: {}, responses: [], queriesByIndex: [] };
  }

  const bundleCount = getStepBQueryBundleCount(claimFeatures, queriesByFeature);

  const normalizedByFeature = {};
  (claimFeatures || []).forEach(feature => {
    normalizedByFeature[feature.Id] = ensureQueryCount(feature, queriesByFeature?.[feature.Id] || [], bundleCount);
  });

  const queriesByIndex = [];
  for (let i = 0; i < bundleCount; i += 1) {
    const bundle = (claimFeatures || []).map(feature => ({
      Id: feature.Id,
      Description: feature.Description,
      Query: normalizedByFeature[feature.Id]?.[i] || ''
    }));
    queriesByIndex.push(bundle);
  }

  const randomExtraCount = getStepBAdditionalRandomBundleCount(bundleCount, runtimeOptions);
  const randomSourceIndexes = pickStepBRandomBundleIndexes(queriesByIndex.length, randomExtraCount);
  const mediumRuntimeOptions = buildStepBMediumReasoningRuntimeOptions(runtimeOptions);

  const dispatchPlans = queriesByIndex.map((bundle, idx) => ({
    queryIndex: idx + 1,
    sourceQueryIndex: idx + 1,
    isRandomExtra: false,
    reasoningEffort: normalizeRuntimeReasoningEffort(
      getStepBStepApiOverrides(runtimeOptions, 'stepBRag')?.reasoning_effort
    ) || null,
    bundle,
    runtimeOptions
  }));

  randomSourceIndexes.forEach((sourceIndex, order) => {
    const sourceBundle = queriesByIndex[sourceIndex] || [];
    dispatchPlans.push({
      queryIndex: bundleCount + order + 1,
      sourceQueryIndex: sourceIndex + 1,
      isRandomExtra: true,
      reasoningEffort: STEP_B_RANDOM_EXTRA_REASONING_EFFORT,
      bundle: sourceBundle,
      runtimeOptions: mediumRuntimeOptions
    });
  });

  const dispatchTotal = dispatchPlans.length;
  const stepB2SkillContext = await resolveStepB2SkillPromptContext();

  const useLegacyProgress = progressMeta?.useLegacyProgress !== false;
  const onBundleProgress = typeof progressMeta?.onBundleProgress === 'function'
    ? progressMeta.onBundleProgress
    : null;

  let completed = 0;
  let succeeded = 0;
  let failed = 0;
  const emitBundleProgress = () => {
    if (!onBundleProgress) return;
    try {
      onBundleProgress({
        sent: dispatchTotal,
        total: dispatchTotal,
        returned: completed,
        succeeded,
        failed
      });
    } catch (callbackError) {
      console.warn('B-2 progress callback failed:', callbackError);
    }
  };
  if (useLegacyProgress) {
    showParallelProgress('B-2 단계: 멀티쿼리 RAG', progressMeta, 'Q1', completed, dispatchTotal);
  }
  emitBundleProgress();

  const dispatchQueryBundle = async (plan) => {
    try {
      const result = await runStepBQueryBundle(
        plan.bundle,
        mapInfo,
        fileIds,
        plan.queryIndex,
        stepB2SkillContext,
        plan.runtimeOptions
      );
      succeeded += 1;
      return { ...plan, ok: true, result };
    } catch (error) {
      failed += 1;
      return { ...plan, ok: false, error: error?.message || String(error) };
    } finally {
      completed += 1;
      if (useLegacyProgress) {
        const progressLabel = plan.isRandomExtra
          ? `Q${plan.queryIndex}(추가)`
          : `Q${plan.queryIndex}`;
        showParallelProgress('B-2 단계: 멀티쿼리 RAG', progressMeta, progressLabel, completed, dispatchTotal);
      }
      emitBundleProgress();
    }
  };

  const settled = await Promise.all(dispatchPlans.map((plan) => dispatchQueryBundle(plan)));
  const resolvedQueriesByIndex = settled.map((entry) => entry.bundle || []);

  const responses = settled.map((entry) => {
    const bundle = entry.bundle || [];
    const bundleQueries = bundle.map(item => ({
      Feature: item.Id,
      Query: item.Query
    }));
    if (entry.ok) {
      return {
        queryIndex: entry.queryIndex,
        sourceQueryIndex: entry.sourceQueryIndex,
        isRandomExtra: entry.isRandomExtra,
        reasoningEffort: entry.reasoningEffort,
        ok: true,
        result: entry.result,
        queries: bundleQueries
      };
    }
    return {
      queryIndex: entry.queryIndex,
      sourceQueryIndex: entry.sourceQueryIndex,
      isRandomExtra: entry.isRandomExtra,
      reasoningEffort: entry.reasoningEffort,
      ok: false,
      error: entry.error,
      queries: bundleQueries
    };
  });

  let mergedRelevant = {};
  responses.forEach(entry => {
    if (!entry.ok) return;
    mergedRelevant = mergeRelevantWithPositions(mergedRelevant, entry.result?.Relevant || {});
  });
  mergedRelevant = mergeRelevantBySnippet(mergedRelevant, { dropSourceExcerpt: false });

  return {
    relevant: mergedRelevant,
    responses,
    queriesByIndex: resolvedQueriesByIndex,
    totalBundles: dispatchTotal,
    randomExtra: {
      count: randomSourceIndexes.length,
      sourceQueryIndexes: randomSourceIndexes.map((index) => index + 1),
      reasoningEffort: STEP_B_RANDOM_EXTRA_REASONING_EFFORT
    }
  };
}

async function runStepBMergeRag(stepBResponses) {
  const filtered = (stepBResponses || [])
    .filter(entry => entry && entry.ok && entry.result)
    .map(entry => ({
      queryIndex: entry.queryIndex,
      queries: entry.queries || [],
      Relevant: mergeRelevantBySnippet(entry.result?.Relevant || {}, { dropSourceExcerpt: false })
    }));

  if (filtered.length === 0) {
    return { relevant: {}, debug: { skipped: true, mode: 'deterministic' } };
  }

  let mergedRelevant = {};
  filtered.forEach((entry) => {
    mergedRelevant = mergeRelevantWithPositions(mergedRelevant, entry.Relevant || {});
  });
  const mergeNormalized = mergeRelevantBySnippet(mergedRelevant, { dropSourceExcerpt: false });
  const docStats = Object.fromEntries(
    Object.entries(mergeNormalized).map(([docName, items]) => [
      docName,
      Array.isArray(items) ? items.length : 0
    ])
  );

  return {
    relevant: mergeNormalized,
    debug: {
      mode: 'deterministic',
      responseCount: filtered.length,
      queryIndexes: filtered.map(entry => entry.queryIndex),
      docStats
    }
  };
}

async function runStepBQueryBundle(featuresWithQueries, mapInfo, fileIds, queryIndex, stepB2SkillContext, runtimeOptions = {}) {
  const combinedQuery = (featuresWithQueries || [])
    .map(item => item.Query)
    .filter(Boolean)
    .join(' | ');
  const normalizedSkillContext = normalizeStepB2SkillPromptContext(stepB2SkillContext);
  const promptPair = await renderLarcPromptPair('stepBRag', {
    mapInfo,
    query_index: queryIndex,
    combined_query: combinedQuery,
    features_json: featuresWithQueries,
    b2_skill_guidance: normalizedSkillContext.promptText
  });
  const payload = applyStepBStepApiOptions({
    model: resolveLarcModelName(),
    messages: promptPair.messages,
    files: buildFileRefs(fileIds)
  }, 'stepBRag', runtimeOptions);

  const response = await sendLLMRequest(payload, {
    stepKey: 'stepBRag',
    promptKey: 'stepBRag',
    label: `bundle_${queryIndex}`
  });
  if (response.ok && response.data && response.data.choices) {
    const assistantContent = response.data.choices[0].message.content;
    const debug = {
      llm: getLlmTraceFromResponse(response),
      b2Skill: normalizedSkillContext.meta,
      initialAssistantContent: assistantContent,
      initialParsed: null,
      initialJsonParseError: null,
      initialValidation: null,
      repairs: []
    };
    let parsed = null;
    let conversationHistory = [
      { role: 'assistant', content: assistantContent }
    ];

    try {
      parsed = safeJsonParse(assistantContent) || {};
      debug.initialParsed = parsed;
    } catch (error) {
      debug.initialJsonParseError = error?.message || String(error);

      const jsonRepairRequest = buildStepBRepairRequestJson(
        queryIndex,
        featuresWithQueries,
        [],
        {
          mode: 'json_repair',
          note: `The previous assistant answer could not be parsed as JSON. Rewrite it as valid JSON for the requested features. Parse error: ${debug.initialJsonParseError}`
        }
      );
      const jsonRepair = await runStepBRagRepairBundle(
        queryIndex,
        fileIds,
        promptPair,
        conversationHistory,
        jsonRepairRequest,
        runtimeOptions
      );

      debug.repairs.push({
        mode: 'json_repair',
        request: jsonRepairRequest,
        response: jsonRepair.parsed,
        validation: jsonRepair.validation,
        llm: jsonRepair.llm || null
      });

      conversationHistory = [
        ...conversationHistory,
        jsonRepair.repairUserMessage,
        { role: 'assistant', content: jsonRepair.rawContent }
      ];
      parsed = jsonRepair.parsed || {};
      debug.initialParsed = parsed;
    }

    const initialValidation = validateAndRepairRelevantEntries(parsed?.Relevant || {});
    debug.initialValidation = initialValidation;

    let finalRelevant = initialValidation.relevant || {};
    if (initialValidation.invalidItems.length > 0) {
      const groundingRepairRequest = buildStepBRepairRequestJson(
        queryIndex,
        featuresWithQueries,
        initialValidation.invalidItems,
        {
          mode: 'grounding_repair',
          note: 'Repair only the invalid items. Keep prior reasoning context, but return only items whose SourceExcerpt can be grounded to a single sentinel position or contiguous sentinel range.'
        }
      );
      const groundingRepair = await runStepBRagRepairBundle(
        queryIndex,
        fileIds,
        promptPair,
        conversationHistory,
        groundingRepairRequest,
        runtimeOptions
      );

      debug.repairs.push({
        mode: 'grounding_repair',
        request: groundingRepairRequest,
        response: groundingRepair.parsed,
        validation: groundingRepair.validation,
        llm: groundingRepair.llm || null
      });

      finalRelevant = mergeRelevantWithPositions(
        finalRelevant,
        groundingRepair.validation.relevant || {}
      );
    }
    finalRelevant = mergeRelevantBySnippet(finalRelevant, { dropSourceExcerpt: false });

    return {
      Relevant: finalRelevant,
      debug
    };
  }
  throw new Error(response.error || 'B-2 실패');
}

function buildStepCEvidenceBundle(relevant) {
  const relevantWithEvidenceIds = {};
  const evidenceById = {};
  let seq = 1;
  const usedEvidenceIds = new Set();
  const allocateEvidenceId = (preferredId = '') => {
    const normalizedPreferred = normalizeEvidenceId(preferredId);
    if (normalizedPreferred && !usedEvidenceIds.has(normalizedPreferred)) {
      usedEvidenceIds.add(normalizedPreferred);
      return normalizedPreferred;
    }

    while (true) {
      const candidate = `R${String(seq).padStart(4, '0')}`;
      seq += 1;
      if (usedEvidenceIds.has(candidate)) continue;
      usedEvidenceIds.add(candidate);
      return candidate;
    }
  };

  Object.entries(relevant || {}).forEach(([doc, items]) => {
    if (!Array.isArray(items)) return;
    relevantWithEvidenceIds[doc] = [];

    items.forEach(raw => {
      const item = normalizeRelevantItemRecord(raw);
      if (!item.Feature || !item.MatchType || !item.Content) return;

      const evidenceId = allocateEvidenceId(item.EvidenceId);

      relevantWithEvidenceIds[doc].push({
        EvidenceId: evidenceId,
        Feature: item.Feature,
        MatchType: item.MatchType,
        Content: item.Content,
        SourceExcerpt: item.SourceExcerpt || '',
        Position: item.Position
      });
      evidenceById[evidenceId] = {
        doc,
        item: {
          ...item,
          EvidenceId: evidenceId
        }
      };
    });
  });

  return { relevantWithEvidenceIds, evidenceById };
}

function normalizeEvidenceDecisionFlag(value) {
  const text = String(value || '').trim().toUpperCase();
  if (!text) return null;
  if (text === 'P' || text === 'PASS') return 'P';
  if (text === 'F' || text === 'FAIL') return 'F';
  return null;
}

function normalizeEvidenceDecisionMap(raw) {
  const normalized = {};
  Object.entries(raw || {}).forEach(([evidenceId, value]) => {
    const id = String(evidenceId || '').trim();
    if (!id) return;
    const flag = normalizeEvidenceDecisionFlag(value);
    if (!flag) return;
    normalized[id] = flag;
  });
  return normalized;
}

function normalizeFeatureStatusFlag(value) {
  const text = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (!text) return null;
  if (text === 'ENTAIL' || text === 'ENTAILED') return 'ENTAIL';
  if (text === 'PARTIAL' || text === 'EQUIVALENT') return 'PARTIAL';
  if (text === 'NOT_FOUND' || text === 'NOTFOUND' || text === 'MISSING' || text === 'NONE') return 'NOT_FOUND';
  return null;
}

function normalizeFeatureStatusMap(raw, claimFeatures) {
  const featureIds = new Set((claimFeatures || []).map(feature => String(feature?.Id || '').trim()).filter(Boolean));
  const normalized = {};
  Object.entries(raw || {}).forEach(([featureId, value]) => {
    const id = String(featureId || '').trim();
    if (!id || !featureIds.has(id)) return;
    const status = normalizeFeatureStatusFlag(value);
    if (!status) return;
    normalized[id] = status;
  });
  return normalized;
}

function rebuildRelevantFromEvidenceDecision(evidenceById, evidenceDecision) {
  let relevant = {};
  Object.entries(evidenceDecision || {}).forEach(([evidenceId, flag]) => {
    if (flag !== 'P') return;
    const match = evidenceById?.[evidenceId];
    if (!match) return;
    relevant = mergeRelevantWithPositions(relevant, {
      [match.doc]: [match.item]
    });
  });
  return relevant;
}

const STEP_C_JUDGE_PROFILES = Object.freeze([
  Object.freeze({
    id: 'J_STRICT',
    label: 'Literal Strict Judge',
    weight: 0.5,
    guidance: [
      'Prefer literal and explicit correspondence.',
      'When evidence is ambiguous, return F.',
      'Do not infer unstated elements.'
    ].join(' ')
  }),
  Object.freeze({
    id: 'J_EQUIV',
    label: 'Functional Equivalence Judge',
    weight: 0.3,
    guidance: [
      'Accept substantial equivalence when functional role and technical contribution are aligned.',
      'Still require direct grounding to the given evidence.'
    ].join(' ')
  }),
  Object.freeze({
    id: 'J_SKEPTIC',
    label: 'Skeptical Counter Judge',
    weight: 0.2,
    guidance: [
      'Act as a skeptical reviewer.',
      'Reject weak, over-generalized, or over-abstracted mapping.'
    ].join(' ')
  })
]);

const STEP_C_MIN_SUCCESSFUL_JUDGES = 2;
const STEP_C_EVIDENCE_PASS_THRESHOLD = 0.2;

function buildStepCJudgeProfilePayload(profile) {
  return {
    judge_id: String(profile?.id || '').trim(),
    judge_label: String(profile?.label || '').trim(),
    judge_weight: Number.isFinite(Number(profile?.weight)) ? Number(profile.weight) : 0,
    guidance: String(profile?.guidance || '').trim()
  };
}

function parseStepCJudgeResult(parsed, claimFeatures, evidenceBundle) {
  const featureStatusRaw = parsed?.FeatureStatus || parsed?.featureStatus || {};
  const featureStatus = normalizeFeatureStatusMap(featureStatusRaw, claimFeatures);
  const evidenceDecision = normalizeEvidenceDecisionMap(
    parsed?.EvidenceDecision || parsed?.evidenceDecision || {}
  );
  const allEvidenceDecision = {};
  Object.keys(evidenceBundle?.evidenceById || {}).forEach((evidenceId) => {
    allEvidenceDecision[evidenceId] = evidenceDecision[evidenceId] || 'F';
  });
  return {
    featureStatus,
    evidenceDecision,
    allEvidenceDecision,
    hasEvidenceDecision: Object.keys(evidenceDecision).length > 0
  };
}

function buildFeatureStatusFromRelevant(claimFeatures, relevant) {
  const maxRankByFeature = {};
  Object.entries(relevant || {}).forEach(([_docName, items]) => {
    if (!Array.isArray(items)) return;
    items.forEach((item) => {
      const featureId = String(item?.Feature || '').trim();
      if (!featureId) return;
      const rank = typeof getRelevantMatchTypeRank === 'function'
        ? getRelevantMatchTypeRank(item?.MatchType)
        : 0;
      const previous = Number.isFinite(maxRankByFeature[featureId]) ? maxRankByFeature[featureId] : -1;
      if (rank > previous) {
        maxRankByFeature[featureId] = rank;
      }
    });
  });

  const status = {};
  (claimFeatures || []).forEach((feature) => {
    const featureId = String(feature?.Id || '').trim();
    if (!featureId) return;
    const rank = Number.isFinite(maxRankByFeature[featureId]) ? maxRankByFeature[featureId] : -1;
    if (rank >= 2) {
      status[featureId] = 'ENTAIL';
    } else if (rank >= 1) {
      status[featureId] = 'PARTIAL';
    } else {
      status[featureId] = 'NOT_FOUND';
    }
  });
  return status;
}

function aggregateStepCJudges(evidenceBundle, claimFeatures, judgeRuns) {
  const successfulRuns = (judgeRuns || []).filter(run => run?.success);
  const evidenceIds = Object.keys(evidenceBundle?.evidenceById || {});
  const aggregateEvidenceDecision = {};
  const aggregateEvidenceScore = {};

  evidenceIds.forEach((evidenceId) => {
    let weightedScore = 0;
    let totalWeight = 0;
    const perJudge = {};

    successfulRuns.forEach((run) => {
      const weight = Number.isFinite(Number(run?.weight)) ? Number(run.weight) : 0;
      if (weight <= 0) return;
      const flag = run?.allEvidenceDecision?.[evidenceId] === 'P' ? 'P' : 'F';
      perJudge[run.judgeId] = flag;
      weightedScore += flag === 'P' ? weight : -weight;
      totalWeight += weight;
    });

    const normalizedScore = totalWeight > 0 ? (weightedScore / totalWeight) : -1;
    aggregateEvidenceDecision[evidenceId] = normalizedScore >= STEP_C_EVIDENCE_PASS_THRESHOLD ? 'P' : 'F';
    aggregateEvidenceScore[evidenceId] = {
      normalizedScore,
      totalWeight,
      judges: perJudge
    };
  });

  const relevant = rebuildRelevantFromEvidenceDecision(
    evidenceBundle?.evidenceById || {},
    aggregateEvidenceDecision
  );
  const featureStatus = buildFeatureStatusFromRelevant(claimFeatures, relevant);

  return {
    relevant,
    featureStatus,
    aggregateEvidenceDecision,
    aggregateEvidenceScore
  };
}

async function runStepCSingleJudgeQuery(claim, claimFeatures, evidenceBundle, judgeProfile, options = {}) {
  const promptPair = await renderLarcPromptPair('stepCMultiJudge', {
    judge_profile_json: buildStepCJudgeProfilePayload(judgeProfile),
    claim_id: claim.id,
    claim_name: claim.name,
    claim_text: claim.text,
    claim_features_json: claimFeatures,
    stepb_merged_relevant_json: evidenceBundle.relevantWithEvidenceIds
  });
  const payload = applyStepApiOptions({
    model: resolveLarcModelName(),
    messages: promptPair.messages
  }, 'stepCMultiJudge');

  const response = await sendLLMRequest(payload, {
    stepKey: 'stepCMultiJudge',
    promptKey: 'stepCMultiJudge',
    label: `claim_${claim.id}_${judgeProfile?.id || 'judge'}`,
    collector: options.traceCollector
  });
  if (!response.ok || !response.data?.choices?.length) {
    throw new Error(response?.error || `C judge failed: ${judgeProfile?.id || 'unknown'}`);
  }

  const content = response.data.choices[0].message.content;
  const parsed = safeJsonParse(content) || {};
  const normalized = parseStepCJudgeResult(parsed, claimFeatures, evidenceBundle);

  return {
    judgeId: String(judgeProfile?.id || '').trim(),
    judgeLabel: String(judgeProfile?.label || '').trim(),
    weight: Number.isFinite(Number(judgeProfile?.weight)) ? Number(judgeProfile.weight) : 0,
    guidance: String(judgeProfile?.guidance || '').trim(),
    success: true,
    rawOutput: content,
    parsed,
    featureStatus: normalized.featureStatus,
    evidenceDecision: normalized.evidenceDecision,
    allEvidenceDecision: normalized.allEvidenceDecision,
    hasEvidenceDecision: normalized.hasEvidenceDecision,
    llm: getLlmTraceFromResponse(response)
  };
}

async function runStepCForClaim(claim, claimFeatures, stepBMergedRelevant, options = {}) {
  const evidenceBundle = buildStepCEvidenceBundle(stepBMergedRelevant || {});
  const evidenceCount = Object.keys(evidenceBundle.evidenceById || {}).length;
  if (evidenceCount === 0) {
    return {
      relevant: {},
      featureStatus: buildFeatureStatusFromRelevant(claimFeatures, {}),
      debug: {
        mode: 'multi_query_judges',
        skipped: true,
        reason: 'no_evidence',
        legacyRelevantFallback: false
      }
    };
  }

  const onJudgeProgress = typeof options?.onJudgeProgress === 'function'
    ? options.onJudgeProgress
    : null;
  const traceCollector = Array.isArray(options?.traceCollector) ? options.traceCollector : null;
  const judges = [...STEP_C_JUDGE_PROFILES];
  const totalJudges = judges.length;
  let completed = 0;
  let succeeded = 0;
  let failed = 0;

  const emitProgress = (judgeId) => {
    if (!onJudgeProgress) return;
    try {
      onJudgeProgress({
        judgeId,
        completed,
        total: totalJudges,
        succeeded,
        failed
      });
    } catch (error) {
      console.warn('Step C judge progress callback failed:', error);
    }
  };

  const runJudge = async (judgeProfile) => {
    try {
      const run = await runStepCSingleJudgeQuery(
        claim,
        claimFeatures,
        evidenceBundle,
        judgeProfile,
        { traceCollector }
      );
      succeeded += 1;
      return run;
    } catch (error) {
      failed += 1;
      return {
        judgeId: String(judgeProfile?.id || '').trim(),
        judgeLabel: String(judgeProfile?.label || '').trim(),
        weight: Number.isFinite(Number(judgeProfile?.weight)) ? Number(judgeProfile.weight) : 0,
        guidance: String(judgeProfile?.guidance || '').trim(),
        success: false,
        error: error?.message || String(error)
      };
    } finally {
      completed += 1;
      emitProgress(String(judgeProfile?.id || '').trim());
    }
  };

  emitProgress('');
  const judgeRuns = await Promise.all(judges.map(judge => runJudge(judge)));
  const successfulRuns = judgeRuns.filter(run => run?.success);

  if (successfulRuns.length < STEP_C_MIN_SUCCESSFUL_JUDGES) {
    const fallbackProfile = {
      id: 'J_LEGACY',
      label: 'Legacy Single Judge Fallback',
      weight: 1,
      guidance: 'Fallback mode. Apply balanced evidence judgement.'
    };
    const fallbackRun = await runStepCSingleJudgeQuery(
      claim,
      claimFeatures,
      evidenceBundle,
      fallbackProfile,
      { traceCollector }
    );
    const relevant = fallbackRun.hasEvidenceDecision
      ? rebuildRelevantFromEvidenceDecision(evidenceBundle.evidenceById, fallbackRun.allEvidenceDecision)
      : (fallbackRun.parsed?.Relevant || fallbackRun.parsed?.relevant || {});
    const featureStatus = Object.keys(fallbackRun.featureStatus || {}).length > 0
      ? fallbackRun.featureStatus
      : buildFeatureStatusFromRelevant(claimFeatures, relevant);
    return {
      relevant,
      featureStatus,
      debug: {
        mode: 'multi_query_judges',
        fallback: true,
        fallbackReason: 'insufficient_successful_judges',
        successfulJudgeCount: successfulRuns.length,
        judgeCount: totalJudges,
        judgeRuns,
        fallbackRun,
        FeatureStatus: featureStatus,
        EvidenceDecision: fallbackRun.allEvidenceDecision,
        legacyRelevantFallback: !fallbackRun.hasEvidenceDecision,
        llm: fallbackRun.llm || null
      }
    };
  }

  const aggregated = aggregateStepCJudges(evidenceBundle, claimFeatures, successfulRuns);
  return {
    relevant: aggregated.relevant,
    featureStatus: aggregated.featureStatus,
    debug: {
      mode: 'multi_query_judges',
      fallback: false,
      successfulJudgeCount: successfulRuns.length,
      judgeCount: totalJudges,
      judgeRuns,
      aggregate: {
        threshold: STEP_C_EVIDENCE_PASS_THRESHOLD,
        evidenceScore: aggregated.aggregateEvidenceScore
      },
      FeatureStatus: aggregated.featureStatus,
      EvidenceDecision: aggregated.aggregateEvidenceDecision,
      legacyRelevantFallback: false,
      llm: successfulRuns.map(run => run.llm).filter(Boolean)
    }
  };
}

function filterRelevantByFeatureIds(relevant, featureIds) {
  const idSet = new Set((featureIds || []).map(String));
  const filtered = {};

  Object.entries(relevant || {}).forEach(([doc, items]) => {
    if (!Array.isArray(items)) return;
    const kept = items.filter(item => idSet.has(String(item?.Feature || '')));
    if (kept.length > 0) {
      filtered[doc] = kept;
    }
  });

  return filtered;
}

function hasAnyRelevantEntry(relevant) {
  return Object.values(relevant || {}).some(items => Array.isArray(items) && items.length > 0);
}

async function runStepDForClaim(claim, missingFeatures, mapInfo, fileIds, target) {
  const promptPair = await renderLarcPromptPair('stepDRepair', {
    mapInfo,
    claim_id: claim.id,
    claim_name: claim.name,
    claim_text: claim.text,
    missing_features_json: missingFeatures,
    current_relevant_json: target.Relevant || {}
  });
  const payload = applyStepApiOptions({
    model: resolveLarcModelName(),
    messages: promptPair.messages,
    files: buildFileRefs(fileIds)
  }, 'stepDRepair');

  const response = await sendLLMRequest(payload, {
    stepKey: 'stepDRepair',
    promptKey: 'stepDRepair',
    label: `claim_${claim.id}`
  });
  if (response.ok && response.data && response.data.choices) {
    const content = response.data.choices[0].message.content;
    const parsed = safeJsonParse(content) || {};
    const validation = validateAndRepairRelevantEntries(parsed.Relevant || {});
    const normalizeValidationRecord = (entry) => ({
      docName: String(entry?.docName || '').trim(),
      feature: String(entry?.item?.Feature || '').trim(),
      matchType: String(entry?.item?.MatchType || '').trim(),
      position: String(entry?.item?.Position || '').trim(),
      validationError: String(entry?.validationError || '').trim(),
      validationMessage: String(entry?.validationMessage || '').trim(),
      candidatePositions: Array.isArray(entry?.candidatePositions) ? entry.candidatePositions : []
    });

    return {
      relevant: validation.relevant || {},
      debug: {
        ...parsed,
        llm: getLlmTraceFromResponse(response),
        validation: {
          invalidCount: validation.invalidItems.length,
          autoCorrectedCount: validation.autoCorrectedItems.length,
          invalidItems: validation.invalidItems.map(normalizeValidationRecord),
          autoCorrectedItems: validation.autoCorrectedItems.map(normalizeValidationRecord)
        }
      }
    };
  }
  throw new Error(response.error || 'D단계 실패');
}

function normalizeStepEVerificationStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'warning') return 'warning';
  if (normalized === 'caution') return 'caution';
  if (normalized === 'pass') return 'pass';
  if (normalized === 'fail' || normalized === 'f') return 'warning';
  if (normalized === 'p') return 'pass';
  return '';
}

function normalizeStepEVerificationValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const status = normalizeStepEVerificationStatus(value.status || value.flag || value.result || value.verification);
    if (!status) return null;
    return {
      status,
      reason: String(value.reason || '').trim()
    };
  }

  const status = normalizeStepEVerificationStatus(value);
  if (!status) return null;
  return {
    status,
    reason: status === 'warning' ? '검증 실패로 분류되었습니다.' : ''
  };
}

function getStepEVerificationSeverity(status) {
  const normalized = normalizeStepEVerificationStatus(status);
  if (normalized === 'warning') return 3;
  if (normalized === 'caution') return 2;
  if (normalized === 'pass') return 1;
  return 0;
}

function mergeStepEVerificationBySeverity(currentValue, nextValue) {
  const current = normalizeStepEVerificationValue(currentValue);
  const next = normalizeStepEVerificationValue(nextValue);
  if (!next) return current;
  if (!current) return next;

  const currentRank = getStepEVerificationSeverity(current.status);
  const nextRank = getStepEVerificationSeverity(next.status);
  if (nextRank > currentRank) return next;
  if (nextRank < currentRank) return current;
  if (!current.reason && next.reason) return next;
  return current;
}

function buildStepEEvidenceMetaByClaim(summaryResults) {
  const byClaim = {};
  Object.entries(summaryResults || {}).forEach(([claimId, claimSummary]) => {
    const safeClaimId = String(claimId || '').trim();
    if (!safeClaimId) return;
    byClaim[safeClaimId] = byClaim[safeClaimId] || {};
    Object.entries(claimSummary?.Relevant || {}).forEach(([docName, items]) => {
      if (!Array.isArray(items)) return;
      const safeDocName = String(docName || '').trim();
      items.forEach((item) => {
        const evidenceId = normalizeEvidenceId(item?.EvidenceId || item?.evidenceId);
        const featureId = String(item?.Feature || '').trim();
        if (!evidenceId || !featureId || !safeDocName) return;
        byClaim[safeClaimId][evidenceId] = {
          featureId,
          docName: safeDocName
        };
      });
    });
  });
  return byClaim;
}

function parseStepEVerificationKey(rawKey, validClaimIds) {
  const safeKey = String(rawKey || '').trim();
  if (!safeKey) return null;

  const parts = safeKey.split('_');
  if (parts.length >= 3) {
    const claimId = String(parts[0] || '').trim();
    const featureId = String(parts[1] || '').trim();
    const docName = String(parts.slice(2).join('_') || '').trim();
    if (validClaimIds.has(claimId) && featureId && docName) {
      return {
        claimId,
        evidenceId: '',
        featureId,
        docName
      };
    }
  }

  const separatorIndex = safeKey.indexOf('_');
  if (separatorIndex > 0) {
    const claimId = safeKey.slice(0, separatorIndex);
    const tail = safeKey.slice(separatorIndex + 1);
    if (validClaimIds.has(claimId) && tail) {
      const evidenceId = normalizeEvidenceId(tail);
      if (evidenceId) {
        return {
          claimId,
          evidenceId,
          featureId: '',
          docName: ''
        };
      }
    }
  }

  return null;
}

async function runVerificationStage(claimsToVerify, citationMap) {
  const summaryResults = {};
  claimsToVerify.forEach(claim => {
    const result = analysisResults[claim.id];
    if (!result || result.error) return;
    summaryResults[claim.id] = {
      ClaimFeatures: result.ClaimFeatures || [],
      Relevant: result.Relevant || {}
    };
  });

  const allClaimsText = claimsToVerify.map(c => `[청구항 ID: ${c.id}] ${c.name}\n${c.text}`).join('\n\n');
  const validClaimIds = new Set(Object.keys(summaryResults).map((claimId) => String(claimId || '').trim()).filter(Boolean));
  const evidenceMetaByClaim = buildStepEEvidenceMetaByClaim(summaryResults);
  const groundedEvidence = typeof buildVerificationGroundedEvidence === 'function'
    ? buildVerificationGroundedEvidence(summaryResults)
    : { entries: [], stats: {}, error: 'buildVerificationGroundedEvidence is not available.' };

  claimsToVerify.forEach((claim) => {
    const result = analysisResults?.[claim.id];
    if (!result || result.error) return;
    result.debug = result.debug || {};
    result.debug.stepEInput = {
      summary: summaryResults[claim.id] || {},
      groundedEvidenceStats: groundedEvidence.stats || {},
      groundedEvidence: (groundedEvidence.entries || []).filter(entry => String(entry.claim_id) === String(claim.id))
    };
  });

  const promptPair = await renderLarcPromptPair('verification', {
    all_claims_text: allClaimsText,
    citation_map: citationMap,
    summary_results_json: summaryResults,
    grounded_evidence_json: groundedEvidence
  });

  const payload = applyStepApiOptions({
    model: resolveLarcModelName(),
    messages: promptPair.messages
  }, 'verification');

  const updateStepEDebugForClaims = (entry) => {
    claimsToVerify.forEach((claim) => {
      const result = analysisResults?.[claim.id];
      if (!result || result.error) return;
      result.debug = result.debug || {};
      result.debug.stepE = {
        ...(result.debug.stepE || {}),
        ...entry
      };
    });
  };

  try {
    const response = await sendLLMRequest(payload, {
      stepKey: 'verification',
      promptKey: 'verification',
      label: `claims_${claimsToVerify.length}`
    });
    const llmTrace = getLlmTraceFromResponse(response);

    if (response.ok && response.data && response.data.choices) {
      const content = response.data.choices[0].message.content;
      const verificationResult = safeJsonParse(content);
      updateStepEDebugForClaims({
        llm: llmTrace,
        rawOutput: content,
        parsed: verificationResult
      });

      if (verificationResult.verifications) {
        for (const [key, value] of Object.entries(verificationResult.verifications)) {
          const parsedKey = parseStepEVerificationKey(key, validClaimIds);
          if (!parsedKey) continue;

          const normalizedValue = normalizeStepEVerificationValue(value);
          if (!normalizedValue) continue;

          const claimId = parsedKey.claimId;
          const claimResult = analysisResults[claimId];
          if (!claimResult) continue;
          if (!claimResult.verifications || typeof claimResult.verifications !== 'object' || Array.isArray(claimResult.verifications)) {
            claimResult.verifications = {};
          }

          if (parsedKey.evidenceId) {
            claimResult.verifications[parsedKey.evidenceId] = normalizedValue;
            const evidenceMeta = evidenceMetaByClaim?.[claimId]?.[parsedKey.evidenceId];
            const featureId = String(evidenceMeta?.featureId || '').trim();
            const docName = String(evidenceMeta?.docName || '').trim();
            if (featureId && docName) {
              const groupedKey = `${featureId}_${docName}`;
              claimResult.verifications[groupedKey] = mergeStepEVerificationBySeverity(
                claimResult.verifications[groupedKey],
                normalizedValue
              );
            }
            continue;
          }

          if (parsedKey.featureId && parsedKey.docName) {
            const groupedKey = `${parsedKey.featureId}_${parsedKey.docName}`;
            claimResult.verifications[groupedKey] = mergeStepEVerificationBySeverity(
              claimResult.verifications[groupedKey],
              normalizedValue
            );
          }
        }
      }
    } else {
      updateStepEDebugForClaims({
        llm: llmTrace,
        error: response?.error || 'Verification response is invalid.'
      });
    }
  } catch (e) {
    updateStepEDebugForClaims({
      error: e?.message || String(e)
    });
    console.error('검증 단계에서 오류 발생:', e);
  }
}
