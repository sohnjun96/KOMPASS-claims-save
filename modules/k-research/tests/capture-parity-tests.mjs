import assert from "node:assert/strict";

await import("../background-capture.js");

const api = globalThis.__KRESEARCH_CAPTURE_TEST_API__;
if (!api) {
  throw new Error("capture test api is not available");
}

function check(condition, message) {
  assert.ok(condition, message);
  process.stdout.write(`PASS  ${message}\n`);
}

function testDerivedTargetFalseStored() {
  const result = api.buildCaptureRowFromPair({
    citationText: "derived citation content",
    targetMatched: false,
    tabId: 902,
    captureMeta: {
      rootTabId: 900,
      tabId: 902,
      captureScope: api.constants.CAPTURE_SCOPE_DERIVED,
      attachedVia: api.constants.ATTACHED_VIA_AUTO
    }
  }, {
    runId: "krun_case1",
    queryVersionId: "krqv_case1"
  });

  check(!!result.row, "derived row: targetMatched=false row is still built");
  check(result.row.targetMatched === false, "derived row: targetMatched is stored as false");
  check(result.row.captureScope === api.constants.CAPTURE_SCOPE_DERIVED, "derived row: captureScope is derived");
  check(result.row.priorityHint === api.constants.PRIORITY_HINT_SECONDARY, "derived row: priorityHint is secondary for targetMatched=false");
}

function testCitationTextPreventsDiscardOnTargetFalse() {
  const result = api.buildCaptureRowFromPair({
    citationText: "citation exists",
    targetMatched: false,
    tabId: 101
  }, {
    runId: "krun_case2",
    queryVersionId: "krqv_case2"
  });

  check(!!result.row, "citation exists: row is built");
  check(result.discardReason === null, "citation exists: targetMatched=false is not a discard reason");
}

function testAutoAttachDerivedKeepsRootRunContext() {
  const result = api.buildCaptureRowFromPair({
    citationText: "auto attach derived",
    targetMatched: true,
    tabId: 220,
    captureMeta: {
      rootTabId: 200,
      tabId: 220,
      captureScope: api.constants.CAPTURE_SCOPE_DERIVED,
      attachedVia: api.constants.ATTACHED_VIA_AUTO
    }
  }, {
    runId: "krun_auto",
    queryVersionId: "krqv_auto"
  });

  check(result.row.runId === "krun_auto", "auto attach: row uses root runId context");
  check(result.row.queryVersionId === "krqv_auto", "auto attach: row uses root queryVersionId context");
  check(result.row.rootTabId === 200 && result.row.tabId === 220, "auto attach: root/derived tab ids are preserved");
}

function testManualAttachStoresSameWay() {
  const result = api.buildCaptureRowFromPair({
    citationText: "manual attach derived",
    targetMatched: true,
    tabId: 320,
    captureMeta: {
      rootTabId: 300,
      tabId: 320,
      captureScope: api.constants.CAPTURE_SCOPE_DERIVED,
      attachedVia: api.constants.ATTACHED_VIA_MANUAL
    }
  }, {
    runId: "krun_manual",
    queryVersionId: "krqv_manual"
  });

  check(!!result.row, "manual attach: row is stored");
  check(result.row.attachedVia === api.constants.ATTACHED_VIA_MANUAL, "manual attach: attachedVia is manual");
  check(result.row.captureScope === api.constants.CAPTURE_SCOPE_DERIVED, "manual attach: derived scope is preserved");
}

function testDiagnosticsState() {
  api.__testResetDiagnostics();
  api.__testClearAttachedTabs();

  api.__testSetAttachedTabMeta(10, {
    rootTabId: 10,
    attachedVia: api.constants.ATTACHED_VIA_MANUAL,
    derived: false
  });
  api.__testSetAttachedTabMeta(11, {
    rootTabId: 10,
    attachedVia: api.constants.ATTACHED_VIA_AUTO,
    derived: true
  });

  api.__testRecordStoredRow({ tabId: 11, targetMatched: false });
  api.__testRecordDiscard("no_citation_text");

  const snapshot = api.getCaptureDiagnosticsSnapshot();
  check(snapshot.attachedTabsCount === 2, "diagnostics: attached tab count is tracked");
  check(snapshot.derivedTabsAttachedCount === 1, "diagnostics: derived attached tab count is tracked");
  check(snapshot.rowsStoredCount === 1, "diagnostics: stored row count is tracked");
  check(snapshot.rowsDiscardedCount === 1, "diagnostics: discarded row count is tracked");
  check(Number(snapshot.discardReasons.no_citation_text || 0) === 1, "diagnostics: discard reason map is tracked");
}

function testPriorityHintForMatchedVsUnmatched() {
  const matched = api.buildCaptureRowFromPair({
    citationText: "matched content",
    targetMatched: true,
    tabId: 1
  }, {
    runId: "krun_p1",
    queryVersionId: "krqv_p1"
  }).row;

  const unmatched = api.buildCaptureRowFromPair({
    citationText: "unmatched content",
    targetMatched: false,
    tabId: 1
  }, {
    runId: "krun_p2",
    queryVersionId: "krqv_p2"
  }).row;

  check(matched.priorityHint === api.constants.PRIORITY_HINT_PRIMARY, "priority: matched row is primary");
  check(unmatched.priorityHint === api.constants.PRIORITY_HINT_SECONDARY, "priority: unmatched row is secondary");
}

function testBpRequestTrackingKeepsSkgmConstraint() {
  const nonTarget = api.getTrackedRequestKind("https://example.com/bpService.do?id=/SKGM000001", "");
  const target10500 = api.getTrackedRequestKind("https://example.com/bpService.do?id=/SKGM10500", "");
  const targetLegacy010500 = api.getTrackedRequestKind("https://example.com/bpService.do?id=/SKGM010500", "");
  const targetDeferred = api.getTrackedRequestKind("https://example.com/bpService.do", "");

  check(nonTarget === null, "tracking: non-target bpService request is not tracked");
  check(target10500 === "bp", "tracking: target bpService SKGM10500 is tracked");
  check(targetLegacy010500 === "bp", "tracking: target bpService SKGM010500 is tracked");
  check(targetDeferred === null, "tracking: bpService without target id is not tracked");
}

function testDerivedTabSkipsDwpiTracking() {
  api.__testClearAttachedTabs();
  api.__testSetAttachedTabMeta(500, {
    rootTabId: 500,
    attachedVia: api.constants.ATTACHED_VIA_MANUAL,
    derived: false
  });
  api.__testSetAttachedTabMeta(501, {
    rootTabId: 500,
    attachedVia: api.constants.ATTACHED_VIA_AUTO,
    derived: true
  });

  check(api.shouldTrackRequestKindForTab(500, "dwpi") === true, "scope: root tab tracks dwpi");
  check(api.shouldTrackRequestKindForTab(501, "dwpi") === false, "scope: derived tab skips dwpi");
  check(api.shouldTrackRequestKindForTab(501, "bp") === true, "scope: derived tab still tracks bp");
}

function testBpCaptureFallbackForDerivedBurst() {
  const shouldCaptureDerivedFallback = api.shouldCaptureBpPair({
    targetMatched: false,
    citationText: "derived burst citation payload with enough text length for safe fallback capture",
    captureMeta: {
      captureScope: api.constants.CAPTURE_SCOPE_DERIVED,
      derived: true
    }
  });
  const shouldSkipRootNonTarget = api.shouldCaptureBpPair({
    targetMatched: false,
    citationText: "root non-target should not be captured without explicit target hit",
    captureMeta: {
      captureScope: api.constants.CAPTURE_SCOPE_ROOT,
      derived: false
    }
  });
  const shouldCaptureTargetAnyScope = api.shouldCaptureBpPair({
    targetMatched: true,
    citationText: "target matched always capture",
    captureMeta: {
      captureScope: api.constants.CAPTURE_SCOPE_ROOT,
      derived: false
    }
  });

  check(shouldCaptureDerivedFallback === true, "bp fallback: derived tab row with citation text is capturable");
  check(shouldSkipRootNonTarget === true, "bp fallback: root tab row with citation text is capturable");
  check(shouldCaptureTargetAnyScope === true, "bp fallback: explicit target hit is captured");
}

function testPayloadFallbackCitationRecovery() {
  const payloadRaw = [
    "meta",
    "short",
    "This is a long fallback citation text extracted from payload block for capture recovery."
  ].join("\u001F");

  const resolved = api.resolveCitationTextForCapture("", payloadRaw);
  check(resolved.source === "payload_fallback", "payload fallback: source is payload_fallback when response body is empty");
  check(
    resolved.citationText.includes("fallback citation text extracted from payload"),
    "payload fallback: citation text is recovered from payload"
  );
}

function testPayloadFallbackExtractorChoosesLongestSegment() {
  const payloadRaw = ["A", "Longest candidate segment from payload", "B"].join("\u001F");
  const extracted = api.extractFallbackCitationTextFromPayload(payloadRaw);
  check(
    extracted.includes("Longest candidate segment from payload"),
    "payload fallback extractor: longest sanitized segment is selected"
  );
}

function testSkgmServiceIdIsNotApplicationNo() {
  check(api.looksLikeApplicationNo("SKGM010500") === false, "applicationNo: SKGM010500 is not treated as application number");
  check(api.looksLikeApplicationNo("/SKGM10500") === false, "applicationNo: /SKGM10500 is not treated as application number");

  const fromUrlOnly = api.resolveCapturedApplicationNo({
    payloadRaw: "",
    requestUrl: "https://example.com/bpService.do?id=/SKGM010500",
    responseText: ""
  });
  check(fromUrlOnly === "", "applicationNo: service id in URL id param is not extracted as application number");

  const fromPayloadOnly = api.resolveCapturedApplicationNo({
    payloadRaw: "A\u001FSKGM010500\u001FB",
    requestUrl: "https://example.com/bpService.do",
    responseText: ""
  });
  check(fromPayloadOnly === "", "applicationNo: service id in payload is not extracted as application number");
}

function main() {
  process.stdout.write("Running K-Research capture parity tests...\n");
  testDerivedTargetFalseStored();
  testCitationTextPreventsDiscardOnTargetFalse();
  testAutoAttachDerivedKeepsRootRunContext();
  testManualAttachStoresSameWay();
  testDiagnosticsState();
  testPriorityHintForMatchedVsUnmatched();
  testBpRequestTrackingKeepsSkgmConstraint();
  testDerivedTabSkipsDwpiTracking();
  testBpCaptureFallbackForDerivedBurst();
  testPayloadFallbackCitationRecovery();
  testPayloadFallbackExtractorChoosesLongestSegment();
  testSkgmServiceIdIsNotApplicationNo();
  process.stdout.write("All K-Research capture parity tests passed.\n");
}

main();
