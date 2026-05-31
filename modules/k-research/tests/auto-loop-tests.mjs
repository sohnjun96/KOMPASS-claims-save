import assert from "node:assert/strict";
import fs from "node:fs";

import {
  normalizeDialogKind,
  deriveDialogSignalFromMonitorState,
  deriveAutoDecisionFromDialogAndCount,
  makeCaptureStabilitySnapshot,
  updateCaptureStabilityWindow,
  classifyDerivedTabs,
  nextAutoStage
} from "../core/auto_loop.js";

function check(condition, message) {
  assert.ok(condition, message);
  process.stdout.write(`PASS  ${message}\n`);
}

function testDialogManyBranch() {
  const result = deriveAutoDecisionFromDialogAndCount({
    dialogKind: "many",
    resultCount: null,
    threshold: 300
  });
  check(result.decision === "too_many", "auto decision: confirm/many -> too_many");
}

function testDialogSignalNormalizationAliases() {
  check(normalizeDialogKind("many") === "many", "dialog normalize: many -> many");
  check(normalizeDialogKind("confirm") === "many", "dialog normalize: confirm -> many");
  check(normalizeDialogKind("too_many") === "many", "dialog normalize: too_many -> many");
  check(normalizeDialogKind("few") === "few", "dialog normalize: few -> few");
  check(normalizeDialogKind("alert") === "few", "dialog normalize: alert -> few");
  check(normalizeDialogKind("too_few") === "few", "dialog normalize: too_few -> few");
  check(normalizeDialogKind("no-dialog") === "none", "dialog normalize: no-dialog -> none");
  check(normalizeDialogKind("") === "none", "dialog normalize: empty -> none");
}

function testWaitDialogManyAliasesBranch() {
  const stageFromMany = nextAutoStage({
    currentStage: "wait_dialog",
    signal: "many",
    stopRequested: false,
    sessionStatus: "capturing"
  });
  const stageFromConfirm = nextAutoStage({
    currentStage: "wait_dialog",
    signal: "confirm",
    stopRequested: false,
    sessionStatus: "capturing"
  });
  const stageFromTooMany = nextAutoStage({
    currentStage: "wait_dialog",
    signal: "too_many",
    stopRequested: false,
    sessionStatus: "capturing"
  });
  check(stageFromMany === "handle_dialog_many", "wait_dialog: many -> HANDLE_DIALOG_MANY");
  check(stageFromConfirm === "handle_dialog_many", "wait_dialog: confirm -> HANDLE_DIALOG_MANY");
  check(stageFromTooMany === "handle_dialog_many", "wait_dialog: too_many -> HANDLE_DIALOG_MANY");
}

function testDialogMonitorHistoryRoutesMany() {
  const signal = deriveDialogSignalFromMonitorState({
    history: [{ rawType: "confirm", kind: "many" }],
    firstDialog: { rawType: "confirm", kind: "many" },
    lastDialog: { rawType: "confirm", kind: "many" }
  });
  check(signal === "many", "dialog monitor history: confirm -> many");
}

function testDialogFewBranch() {
  const result = deriveAutoDecisionFromDialogAndCount({
    dialogKind: "few",
    resultCount: null,
    threshold: 300
  });
  check(result.decision === "too_few", "auto decision: alert/few -> too_few");
}

function testDialogMonitorHistoryRoutesFew() {
  const signal = deriveDialogSignalFromMonitorState({
    history: [{ rawType: "alert", kind: "few" }],
    firstDialog: { rawType: "alert", kind: "few" },
    lastDialog: { rawType: "alert", kind: "few" }
  });
  check(signal === "few", "dialog monitor history: alert -> few");
}

function testDialogMonitorHistoryEmptyRoutesNone() {
  const signal = deriveDialogSignalFromMonitorState({
    history: [],
    firstDialog: null,
    lastDialog: null
  });
  check(signal === "none", "dialog monitor history: empty -> none");
}

function testWaitDialogFewAliasesBranch() {
  const stageFromFew = nextAutoStage({
    currentStage: "wait_dialog",
    signal: "few",
    stopRequested: false,
    sessionStatus: "capturing"
  });
  const stageFromAlert = nextAutoStage({
    currentStage: "wait_dialog",
    signal: "alert",
    stopRequested: false,
    sessionStatus: "capturing"
  });
  const stageFromTooFew = nextAutoStage({
    currentStage: "wait_dialog",
    signal: "too_few",
    stopRequested: false,
    sessionStatus: "capturing"
  });
  check(stageFromFew === "handle_dialog_few", "wait_dialog: few -> HANDLE_DIALOG_FEW");
  check(stageFromAlert === "handle_dialog_few", "wait_dialog: alert -> HANDLE_DIALOG_FEW");
  check(stageFromTooFew === "handle_dialog_few", "wait_dialog: too_few -> HANDLE_DIALOG_FEW");
}

function testCount350Branch() {
  const result = deriveAutoDecisionFromDialogAndCount({
    dialogKind: "none",
    resultCount: 350,
    threshold: 300
  });
  check(result.decision === "too_many", "auto decision: no dialog + count 350 -> too_many");
  const stage = nextAutoStage({
    currentStage: "wait_result_count",
    signal: result.decision,
    stopRequested: false,
    sessionStatus: "capturing"
  });
  check(stage === "handle_count_many", "wait_result_count: count 350 -> HANDLE_COUNT_MANY");
}

function testCount120Branch() {
  const result = deriveAutoDecisionFromDialogAndCount({
    dialogKind: "none",
    resultCount: 120,
    threshold: 300
  });
  check(result.decision === "proceed", "auto decision: no dialog + count 120 -> proceed");
  const stage = nextAutoStage({
    currentStage: "wait_result_count",
    signal: result.decision,
    stopRequested: false,
    sessionStatus: "capturing"
  });
  check(stage === "handle_count_proceed", "wait_result_count: count 120 -> HANDLE_COUNT_PROCEED");
}

function testCount12TooFewStillProceeds() {
  const stage = nextAutoStage({
    currentStage: "wait_result_count",
    signal: "too_few",
    stopRequested: false,
    sessionStatus: "capturing"
  });
  check(stage === "handle_count_proceed", "wait_result_count: too_few(1~20) -> HANDLE_COUNT_PROCEED");
}

function testCountUnreadableBranch() {
  const result = deriveAutoDecisionFromDialogAndCount({
    dialogKind: "none",
    resultCount: null,
    threshold: 300
  });
  check(result.decision === "unreadable", "auto decision: no dialog + unreadable count -> unreadable");
}

function testUnreadableStageGoesPaused() {
  const stage = nextAutoStage({
    currentStage: "wait_result_count",
    signal: "unreadable",
    stopRequested: false,
    sessionStatus: "capturing"
  });
  check(stage === "paused_manual_required", "auto stage: unreadable count -> paused_manual_required");
}

function testStopRequestPreventsTransition() {
  const stage = nextAutoStage({
    currentStage: "wait_dialog",
    signal: "many",
    stopRequested: true,
    sessionStatus: "capturing"
  });
  check(stage === "paused_manual_required", "auto stage: stop request blocks next stage transition");
}

function testDerivedTabClassification() {
  const tabIds = classifyDerivedTabs({
    rootTabId: 10,
    rootWindowId: 1,
    beforeTabIds: [10, 11, 12],
    tabs: [
      { id: 10, windowId: 1 },
      { id: 11, windowId: 1 },
      { id: 12, windowId: 1 },
      { id: 21, openerTabId: 10, windowId: 2 },
      { id: 22, windowId: 1 },
      { id: 23, windowId: 3 }
    ]
  });
  check(tabIds.includes(21) && tabIds.includes(22), "derived tabs: opener/same-window new tabs are classified");
  check(!tabIds.includes(10) && !tabIds.includes(11), "derived tabs: root/before tabs are excluded");
}

function testManualHandlersStillPresent() {
  const source = fs.readFileSync(new URL("../sidepanel.js", import.meta.url), "utf8");
  check(
    source.includes("manualTooManyBtn?.addEventListener(\"click\"")
      && source.includes("manualTooFewBtn?.addEventListener(\"click\"")
      && source.includes("manualProceedBtn?.addEventListener(\"click\""),
    "manual handlers: manual gate button listeners remain wired"
  );
}

function testAutoConfirmUsesDismiss() {
  const source = fs.readFileSync(new URL("../sidepanel.js", import.meta.url), "utf8");
  check(
    source.includes("confirmBehavior: autoMode ? \"cancel\" : \"confirm\"")
      && source.includes("autoAction: \"cancel\"")
      && source.includes("return behavior !== \"cancel\""),
    "auto search click: confirm dialog uses cancel(false) in auto mode"
  );
}

function testAlertUiNoneButSignalFew() {
  const source = fs.readFileSync(new URL("../sidepanel.js", import.meta.url), "utf8");
  check(
    source.includes("kind: \"few\"")
      && source.includes("uiKind: \"없음\""),
    "alert mapping: uiKind is 없음 while signal kind remains few"
  );
}

function testDialogMonitorUsesAllFrames() {
  const source = fs.readFileSync(new URL("../sidepanel.js", import.meta.url), "utf8");
  check(
    source.includes("target: { tabId: tab.id, allFrames: true }")
      && source.includes("runMainWorldOnTabAllFrames"),
    "dialog monitor: installed/read via MAIN world all-frames path"
  );
}

function testDialogMonitorRepatchesOnRefresh() {
  const source = fs.readFileSync(new URL("../sidepanel.js", import.meta.url), "utf8");
  check(
    source.includes("window.confirm = monitorConfirm")
      && source.includes("window.alert = monitorAlert")
      && source.includes("window.__kResearchMonitorConfirm"),
    "dialog monitor: refresh forcibly rebinds confirm/alert wrappers"
  );
}

function testWaitDialogReadsAggregatedMonitorState() {
  const source = fs.readFileSync(new URL("../sidepanel.js", import.meta.url), "utf8");
  check(
    source.includes("await readDialogMonitorStateOnTab(tab)")
      && source.includes("deriveDialogSignalFromMonitorState(lastDialogState, rawSignal)"),
    "wait_dialog: uses aggregated monitor state and monitor-history signal derivation"
  );
}

function testApplyQueryHasRetryForTextareaRace() {
  const source = fs.readFileSync(new URL("../sidepanel.js", import.meta.url), "utf8");
  check(
    source.includes("QUERY_APPLY_RETRY_MAX_ATTEMPTS_AUTO")
      && source.includes("isRetryableQueryApplyErrorMessage")
      && source.includes("[auto][apply_query] retry attempt=%s/%s delayMs=%s reason=%s")
      && source.includes("freeword_textarea"),
    "apply_query: retries when freeword_textarea is not ready yet"
  );
}

function testDialogWaitCanShortCircuitOnCount() {
  const source = fs.readFileSync(new URL("../sidepanel.js", import.meta.url), "utf8");
  check(
    source.includes("countDetected === true")
      && source.includes("result_count =>")
      && source.includes("currentStage: AUTO_STAGE.WAIT_RESULT_COUNT")
      && source.includes("[auto][wait_dialog]"),
    "auto dialog wait: exits early when result count is already detected"
  );
}

function testLiteratureCacheCleanupOnSessionBoundaries() {
  const source = fs.readFileSync(new URL("../sidepanel.js", import.meta.url), "utf8");
  check(
    source.includes("type: \"KRESEARCH_CLEAR_CAPTURE_HISTORY\"")
      && source.includes("await clearStoredLiteratureCache(\"new_session_claim_change\")")
      && source.includes("cleanupReason = \"session_end_success\"")
      && source.includes("cleanupReason = \"session_end_max_iterations\"")
      && source.includes("await clearStoredLiteratureCache(\"session_end_aborted\")")
      && source.includes("state.evalHistory = []"),
    "storage cleanup: capture/eval literature cache is cleared on new session and terminal session states"
  );
}

function testDialogPriorityWindowBeforeCountShortCircuit() {
  const source = fs.readFileSync(new URL("../sidepanel.js", import.meta.url), "utf8");
  check(
    source.includes("AUTO_DIALOG_PRIORITY_WINDOW_MS")
      && source.includes("baselineChanged || elapsedMs >= AUTO_DIALOG_PRIORITY_WINDOW_MS")
      && source.includes("preSearchResultCount"),
    "wait_dialog: count short-circuit is guarded by priority window/baseline-change"
  );
}

function testWaitResultCountDebugPrefixPresent() {
  const source = fs.readFileSync(new URL("../sidepanel.js", import.meta.url), "utf8");
  check(
    source.includes("[auto][wait_result_count]"),
    "wait_result_count: debug prefix is present"
  );
}

function testKnownDialogSignalDoesNotFallToManualTimeout() {
  const stage = nextAutoStage({
    currentStage: "wait_dialog",
    signal: "confirm",
    stopRequested: false,
    sessionStatus: "capturing"
  });
  check(stage !== "paused_manual_required", "wait_dialog: known dialog signal does not fall to manual timeout");
}

function testAdvanceIterationAfterCycle() {
  const stage = nextAutoStage({
    currentStage: "wait_cycle_result",
    signal: "advanced",
    stopRequested: false,
    sessionStatus: "ready"
  });
  check(stage === "advance_iteration", "auto stage: finish cycle + advanced queryVersion -> advance_iteration");
}

function testCompletedOnSuccessOrMaxIterations() {
  const successStage = nextAutoStage({
    currentStage: "wait_cycle_result",
    signal: "",
    stopRequested: false,
    sessionStatus: "success"
  });
  const maxStage = nextAutoStage({
    currentStage: "wait_cycle_result",
    signal: "",
    stopRequested: false,
    sessionStatus: "max_iterations"
  });
  check(successStage === "completed", "auto stage: success -> completed");
  check(maxStage === "completed", "auto stage: max_iterations -> completed");
}

function testCaptureStabilityWindow() {
  const base = makeCaptureStabilitySnapshot({
    rowsStoredCount: 10,
    evalPending: 0,
    evalRunning: 0,
    captureEvalSyncRunning: false
  });
  const step1 = updateCaptureStabilityWindow({
    previousSignature: "",
    stableSince: 0,
    snapshot: base,
    now: 1000,
    stableWindowMs: 1500
  });
  const step2 = updateCaptureStabilityWindow({
    previousSignature: step1.signature,
    stableSince: step1.stableSince,
    snapshot: base,
    now: 2800,
    stableWindowMs: 1500
  });
  check(step2.stable === true, "capture stability: unchanged snapshot over window is stable");
}

function testAutoStartRecoveryRetryPolicyPresent() {
  const source = fs.readFileSync(new URL("../sidepanel.js", import.meta.url), "utf8");
  check(
    source.includes("AUTO_START_RECOVERY_MAX_RETRIES = 2")
      && source.includes("async function runAutoLoopWithStartRecovery")
      && source.includes("isAutoRunnerTerminalError()")
      && source.includes("await runAutoLoopWithStartRecovery("),
    "auto start: error recovery retry wrapper is wired (max 2)"
  );
}

function main() {
  process.stdout.write("Running K-Research auto-loop tests...\n");
  testDialogSignalNormalizationAliases();
  testDialogManyBranch();
  testWaitDialogManyAliasesBranch();
  testDialogMonitorHistoryRoutesMany();
  testDialogFewBranch();
  testWaitDialogFewAliasesBranch();
  testDialogMonitorHistoryRoutesFew();
  testDialogMonitorHistoryEmptyRoutesNone();
  testCount350Branch();
  testCount120Branch();
  testCount12TooFewStillProceeds();
  testCountUnreadableBranch();
  testUnreadableStageGoesPaused();
  testStopRequestPreventsTransition();
  testDerivedTabClassification();
  testManualHandlersStillPresent();
  testAutoConfirmUsesDismiss();
  testAlertUiNoneButSignalFew();
  testDialogMonitorUsesAllFrames();
  testDialogMonitorRepatchesOnRefresh();
  testWaitDialogReadsAggregatedMonitorState();
  testApplyQueryHasRetryForTextareaRace();
  testDialogWaitCanShortCircuitOnCount();
  testLiteratureCacheCleanupOnSessionBoundaries();
  testDialogPriorityWindowBeforeCountShortCircuit();
  testWaitResultCountDebugPrefixPresent();
  testKnownDialogSignalDoesNotFallToManualTimeout();
  testAdvanceIterationAfterCycle();
  testCompletedOnSuccessOrMaxIterations();
  testCaptureStabilityWindow();
  testAutoStartRecoveryRetryPolicyPresent();
  process.stdout.write("All K-Research auto-loop tests passed.\n");
}

main();
