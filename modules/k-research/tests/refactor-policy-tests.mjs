import assert from "node:assert/strict";

import fs from "node:fs";

import {
  normalizeQuerySeed,
  selectInitialActiveFeatureIds,
  normalizeQueryRefine,
  selectTermsForMode
} from "../core/schema.js";
import { buildExpression, normalizeQueryPlan, dedupeTermsAcrossActiveGroups } from "../core/query_builder.js";
import {
  planQueryAdjustment,
  manualGateRefineQuery,
  autoRepairDuplicateQuery,
  pickRecentQuerySummariesForPrompt,
  buildCompactRefineContext,
  shouldRetryDuplicateRefine,
  resolvePromptCallOptions
} from "../core/engine.js";
import { normalizeWorkspacePayload, getStorageKeys } from "../core/storage.js";
import {
  buildQueryFingerprint,
  buildSemanticQueryFingerprint
} from "../core/query_fingerprint.js";
import { normalizeAtomicTermList } from "../core/query_lexical_policy.js";

function check(condition, message) {
  assert.ok(condition, message);
  process.stdout.write(`PASS  ${message}\n`);
}

function countGroups(expression) {
  return String(expression || "")
    .split("&")
    .map((x) => x.trim())
    .filter(Boolean).length;
}

function hasWhitespaceTerm(terms = []) {
  return (Array.isArray(terms) ? terms : []).some((term) => String(term || "").trim().includes(" "));
}

function buildSampleFeatures() {
  return [
    { id: "F1", text: "특허 심사 지원", type: "anchor", weight: 5, query_role: "must", relation_to: [], negative: false, search_hint: "특허 심사" },
    { id: "F2", text: "검색식 자동 보정", type: "anchor", weight: 4, query_role: "must", relation_to: [], negative: false, search_hint: "검색식 보정" },
    { id: "F3", text: "피드백 기반 반복", type: "discriminator", weight: 4, query_role: "should", relation_to: [], negative: false, search_hint: "피드백" },
    { id: "F4", text: "도메인 필터 옵션", type: "optional", weight: 2, query_role: "can_drop", relation_to: [], negative: false, search_hint: "도메인" }
  ];
}

function buildSeedPayload(features) {
  return {
    terms_by_feature: features.map((feature) => ({
      feature_id: feature.id,
      base_terms: feature.id === "F1"
        ? ["특허 심사 지원", "patent"]
        : (feature.id === "F2"
          ? ["검색식 자동 보정", "refine"]
          : (feature.id === "F3" ? ["피드백 반복"] : ["도메인 옵션"])),
      support_terms: feature.id === "F1"
        ? ["patent"]
        : (feature.id === "F2"
          ? ["correction"]
          : (feature.id === "F3" ? ["결과 분석"] : [])),
      broad_terms: feature.id === "F3" ? ["분석"] : [],
      narrow_terms: feature.id === "F3" ? ["정밀"] : [],
      avoid_terms: feature.id === "F1" ? ["지원센터"] : [],
      locked_bigrams: feature.id === "F1" ? ["machine learning"] : []
    }))
  };
}

function testRefineHistoryPromptLimitIsFour() {
  const rows = Array.from({ length: 9 }).map((_, index) => ({
    queryVersionId: `krqv_${index + 1}`,
    refineMode: index % 2 === 0 ? "narrow" : "widen",
    resultCount: 100 + index,
    topScore: 50 + index,
    coverage: 0.2 + index * 0.01,
    fingerprint: `fp_${index + 1}`,
    semanticFingerprint: `sfp_${index + 1}`,
    expression: `(term${index + 1})`
  }));
  const picked = pickRecentQuerySummariesForPrompt(rows, 4);
  check(Array.isArray(picked) && picked.length === 4, "compact history: only recent 4 summaries are selected");
  check(picked[0].queryVersionId === "krqv_6" && picked[3].queryVersionId === "krqv_9", "compact history: keeps latest 4 order");
}

function testBuildCompactRefineContextKeepsCoreSignals() {
  const features = buildSampleFeatures();
  const featureStateById = {
    F1: { enabled: true, active: true, core: true, focus: false, type: "anchor", weight: 5, queryRole: "must" },
    F2: { enabled: true, active: true, core: true, focus: true, type: "anchor", weight: 4, queryRole: "must" },
    F3: { enabled: true, active: true, core: false, focus: false, type: "discriminator", weight: 3, queryRole: "should" },
    F4: { enabled: true, active: false, core: false, focus: false, type: "optional", weight: 2, queryRole: "can_drop" }
  };
  const context = buildCompactRefineContext({
    features,
    currentVersion: {
      queryVersionId: "krqv_current",
      expression: "(특허) & (심사)"
    },
    workingQueryPlan: {
      groups: [
        { group_id: "G1", feature_ids: ["F1"], required: true, active: true, terms: ["특허"] },
        { group_id: "G2", feature_ids: ["F2"], required: true, active: true, terms: ["심사"] }
      ]
    },
    workingTermsByFeature: {
      F1: ["특허", "patent"],
      F2: ["심사", "examination"],
      F3: ["피드백"]
    },
    featureStateById,
    summary: { resultCount: 120, topScore: 72, coverage: 0.64 },
    signals: {
      addCandidates: [{ featureId: "F3", term: "분석", count: 3 }],
      removeCandidates: [{ featureId: "F1", term: "지원", count: 2 }]
    },
    corpusSummary: {
      scoreDistribution: { high: 2, support: 5, mid: 4, low: 1 },
      topScore: 72,
      coverage: 0.64,
      reinforceFeatures: ["F3"],
      alreadyCoveredFeatures: ["F1", "F2"]
    },
    normalizedCountContext: {
      targetCountRange: [0, 300],
      currentResultCount: 120,
      previousResultCount: 480,
      countBucket: "101_300",
      countSource: "page_count",
      reductionRatio: 0.75,
      repeatReasonSignature: "too_many|101_300|improved",
      repeatReasonCount: 2
    },
    historyContext: {
      recentQueries: Array.from({ length: 6 }).map((_, index) => ({
        queryVersionId: `krqv_${index + 1}`,
        refineMode: "narrow",
        resultCount: 100 + index,
        topScore: 60 + index,
        coverage: 0.5,
        fingerprint: `fp_${index + 1}`,
        semanticFingerprint: `sfp_${index + 1}`,
        expression: `(t${index + 1})`
      }))
    }
  });

  check(Array.isArray(context.history_recent) && context.history_recent.length === 4, "compact context: history_recent is capped to 4");
  check(context.current_query?.queryVersionId === "krqv_current", "compact context: current query id is preserved");
  check(context.count_control?.current === 120, "compact context: count control current value is preserved");
  check(Array.isArray(context.features) && context.features.length >= 2, "compact context: minimal feature meta exists");
}

function testDuplicateRetryPolicyOneExtraAttempt() {
  check(
    shouldRetryDuplicateRefine({ stillDuplicate: true, skipLlm: false, retryAttempt: 1, maxAttempts: 2 }) === true,
    "duplicate retry: first duplicate allows exactly one extra refine attempt"
  );
  check(
    shouldRetryDuplicateRefine({ stillDuplicate: true, skipLlm: false, retryAttempt: 2, maxAttempts: 2 }) === false,
    "duplicate retry: second duplicate does not allow infinite retry"
  );
  check(
    shouldRetryDuplicateRefine({ stillDuplicate: true, skipLlm: true, retryAttempt: 1, maxAttempts: 2 }) === false,
    "duplicate retry: skipLlm path does not trigger extra LLM refine"
  );
}

function testRefinePromptPayloadUsesCompactContextVariable() {
  const source = fs.readFileSync(new URL("../core/engine.js", import.meta.url), "utf8");
  check(source.includes("refine_context_json"), "query_refine payload: uses refine_context_json");
  check(!source.includes("recent_query_summaries_json"), "query_refine payload: legacy recent_query_summaries_json removed");
  check(!source.includes("query_history_json"), "query_refine payload: legacy query_history_json removed");
}

function testStructuredCallsUsePromptSchemaGuard() {
  const source = fs.readFileSync(new URL("../core/engine.js", import.meta.url), "utf8");
  check(source.includes("composeSchemaBoundSystemPrompt"), "structured call: schema guard is injected into system prompt");
  check(!source.includes("responseFormat: schemaResponseFormat"), "structured call: response_format transport is disabled");
  check(!source.includes("LLM schema-format fallback"), "structured call: schema-format fallback transport path is removed");
}

function testPromptSchemasDefineExplicitEnums() {
  const refineSchema = JSON.parse(fs.readFileSync(new URL("../prompts/query_refine/schema.json", import.meta.url), "utf8"));
  const repairSchema = JSON.parse(fs.readFileSync(new URL("../prompts/query_duplicate_repair/schema.json", import.meta.url), "utf8"));
  const featureSchema = JSON.parse(fs.readFileSync(new URL("../prompts/feature_extract/schema.json", import.meta.url), "utf8"));
  const citationSchema = JSON.parse(fs.readFileSync(new URL("../prompts/citation_eval_json/schema.json", import.meta.url), "utf8"));

  check(
    JSON.stringify(refineSchema?.properties?.mode?.enum || []) === JSON.stringify(["widen", "narrow", "balanced", "rebuild"]),
    "schema clarity: query_refine mode enum is explicit"
  );
  check(
    JSON.stringify(repairSchema?.properties?.mode?.enum || []) === JSON.stringify(["balanced", "rebuild"]),
    "schema clarity: query_duplicate_repair mode enum is explicit"
  );
  check(
    Array.isArray(featureSchema?.properties?.features?.items?.properties?.type?.enum)
      && featureSchema.properties.features.items.properties.type.enum.includes("anchor"),
    "schema clarity: feature_extract type enum is explicit"
  );
  check(
    Array.isArray(citationSchema?.properties?.feature_judgments?.items?.properties?.status?.enum)
      && citationSchema.properties.feature_judgments.items.properties.status.enum.includes("exact"),
    "schema clarity: citation_eval_json status enum is explicit"
  );
}

function testApiDisablesResponseFormatTransport() {
  const source = fs.readFileSync(new URL("../core/api.js", import.meta.url), "utf8");
  check(source.includes("response_format transport is disabled"), "api policy: response_format transport disabled comment exists");
  check(!source.includes("requestPayload.response_format ="), "api policy: requestPayload.response_format assignment removed");
}

function testSettingsModelControlsNormalizeAndLoad() {
  const storageKeys = getStorageKeys();
  const workspace = normalizeWorkspacePayload({
    [storageKeys.settings]: {
      maxIterations: 15,
      modelControls: {
        globalReasoningEffort: "medium",
        enablePerPromptReasoningEffort: true,
        perPromptReasoningEffort: {
          query_refine: "high",
          query_seed: "medium"
        }
      }
    }
  });
  check(
    workspace?.settings?.modelControls?.globalReasoningEffort === "medium",
    "settings normalize: global reasoning effort persists"
  );
  check(
    workspace?.settings?.modelControls?.enablePerPromptReasoningEffort === true,
    "settings normalize: per-prompt override toggle persists"
  );
  check(
    workspace?.settings?.modelControls?.perPromptReasoningEffort?.query_refine === "high",
    "settings normalize: per-prompt reasoning effort persists"
  );
}

function testResolvePromptCallOptionsReasoningOverrides() {
  const globalOnly = resolvePromptCallOptions("query_refine", {
    modelControls: {
      globalReasoningEffort: "high",
      enablePerPromptReasoningEffort: false,
      perPromptReasoningEffort: {
        query_refine: "low"
      }
    }
  });
  check(
    globalOnly.reasoningEffort === "high",
    "reasoning resolve: global setting is used when per-prompt override is disabled"
  );

  const perPrompt = resolvePromptCallOptions("query_refine", {
    modelControls: {
      globalReasoningEffort: "low",
      enablePerPromptReasoningEffort: true,
      perPromptReasoningEffort: {
        query_refine: "medium"
      }
    }
  });
  check(
    perPrompt.reasoningEffort === "medium",
    "reasoning resolve: per-prompt override is applied when enabled"
  );

  const fallback = resolvePromptCallOptions("query_refine", {
    modelControls: {
      globalReasoningEffort: "ultra",
      enablePerPromptReasoningEffort: true,
      perPromptReasoningEffort: {
        query_refine: "invalid"
      }
    }
  });
  check(
    fallback.reasoningEffort === "low",
    "reasoning resolve: invalid reasoning effort falls back to low"
  );
}

function testSettingsInvalidReasoningFallbackLow() {
  const storageKeys = getStorageKeys();
  const workspace = normalizeWorkspacePayload({
    [storageKeys.settings]: {
      modelControls: {
        globalReasoningEffort: "ultra",
        enablePerPromptReasoningEffort: true,
        perPromptReasoningEffort: {
          query_refine: "extreme"
        }
      }
    }
  });
  check(
    workspace?.settings?.modelControls?.globalReasoningEffort === "low",
    "settings normalize: invalid global reasoning effort falls back to low"
  );
  check(
    workspace?.settings?.modelControls?.perPromptReasoningEffort?.query_refine === "low",
    "settings normalize: invalid per-prompt reasoning effort falls back to low"
  );
}

function testNormalizeQueryRefineActionTypeFallback() {
  const normalized = normalizeQueryRefine({
    mode: "balanced",
    feature_actions: [
      { feature_id: "F1", type: "remove_all" },
      { feature_id: "F2", type: "add", terms: ["보정"] },
      { feature_id: "F3", type: "replace", terms: ["개선"] },
      { feature_id: "F4", type: "keep" }
    ],
    final_terms_by_feature: {
      F2: ["보정"]
    }
  }, ["F1", "F2", "F3", "F4"]);

  const byId = new Map((normalized.featureActions || []).map((row) => [row.featureId, row]));
  check(byId.get("F1")?.disableFeature === true, "normalizeQueryRefine: type=remove_all maps to disableFeature");
  check((byId.get("F2")?.addTerms || [])[0] === "보정", "normalizeQueryRefine: type=add maps terms to addTerms");
  check((byId.get("F3")?.replaceTerms || [])[0] === "개선", "normalizeQueryRefine: type=replace maps terms to replaceTerms");
  check((byId.get("F4")?.addTerms || []).length === 0, "normalizeQueryRefine: type=keep keeps action neutral");
}

function testPromptLoaderIncludesDuplicateRepairBundle() {
  const source = fs.readFileSync(new URL("../core/prompt_loader.js", import.meta.url), "utf8");
  check(source.includes("query_duplicate_repair"), "prompt loader: query_duplicate_repair bundle is registered");
}

function testPromptIncludesCompoundSplitRule() {
  const querySeedPrompt = fs.readFileSync(new URL("../prompts/query_seed/system.txt", import.meta.url), "utf8");
  const queryRefinePrompt = fs.readFileSync(new URL("../prompts/query_refine/system.txt", import.meta.url), "utf8");
  check(
    querySeedPrompt.includes("합성어 분해") && querySeedPrompt.includes("이벤트임베딩"),
    "prompt policy: query_seed system prompt includes no-space compound split rule"
  );
  check(
    queryRefinePrompt.includes("합성어 분해") && queryRefinePrompt.includes("이벤트임베딩"),
    "prompt policy: query_refine system prompt includes no-space compound split rule"
  );
}

function testSeedNormalizeSplitsMultiword() {
  const features = buildSampleFeatures();
  const seed = normalizeQuerySeed(buildSeedPayload(features), features, { mode: "initial" });
  const f1Seed = seed.seedByFeature.F1;
  check(Array.isArray(f1Seed.base_terms) && f1Seed.base_terms.length >= 1, "seed normalize: base_terms exists");
  check(!f1Seed.base_terms.includes("특허 심사 지원"), "seed normalize: multiword base term is decomposed");
  check(!hasWhitespaceTerm(f1Seed.base_terms), "seed normalize: base_terms are atomic one-word tokens");
}

function testFallbackBaseTermSingleAtom() {
  const features = [{ id: "F1", text: "영상 기반 이상 행동 탐지 장치", type: "anchor", weight: 5, query_role: "must", relation_to: [], negative: false, search_hint: "영상 탐지" }];
  const normalized = normalizeQuerySeed({ terms_by_feature: [] }, features, { mode: "initial" });
  const baseTerms = normalized.seedByFeature.F1.base_terms;
  check(Array.isArray(baseTerms) && baseTerms.length === 1, "fallback base term: exactly one atom is selected");
  check(!String(baseTerms[0] || "").includes(" "), "fallback base term: selected term is one word");
}

function testNoSpaceCompoundIsDecomposedToAtoms() {
  const normalized = normalizeAtomicTermList(["이벤트임베딩", "검색이벤트"], {
    allowLockedBigrams: false
  });
  check(
    normalized.includes("이벤트") && normalized.includes("임베딩"),
    "compound normalize: 이벤트임베딩 is decomposed into 이벤트/임베딩"
  );
  check(
    normalized.includes("검색") && normalized.includes("이벤트"),
    "compound normalize: 검색이벤트 is decomposed into 검색/이벤트"
  );
  check(
    !normalized.includes("이벤트임베딩") && !normalized.includes("검색이벤트"),
    "compound normalize: joined compounds are removed after decomposition"
  );
}

function testSeedNormalizationSpillsCompoundTailToSupport() {
  const features = [
    { id: "F1", text: "이벤트 임베딩", type: "anchor", weight: 5, query_role: "must", relation_to: [], negative: false }
  ];
  const payload = {
    terms_by_feature: [
      {
        feature_id: "F1",
        base_terms: ["이벤트임베딩"],
        support_terms: [],
        broad_terms: [],
        narrow_terms: [],
        avoid_terms: [],
        locked_bigrams: []
      }
    ]
  };
  const seed = normalizeQuerySeed(payload, features, {
    mode: "initial",
    activeFeatureIds: ["F1"]
  });
  const terms = Array.isArray(seed?.termsByFeature?.F1) ? seed.termsByFeature.F1 : [];
  check(
    terms.includes("이벤트") && terms.includes("임베딩"),
    "seed normalize: compound base term is surfaced as base/support atoms"
  );
}

function testBuilderNoStateFeatureTextInjection() {
  const features = [{ id: "F1", text: "feature text long phrase", type: "anchor", weight: 5, query_role: "must", relation_to: [], negative: false }];
  const featureStateById = {
    F1: {
      enabled: true,
      active: true,
      core: true,
      text: "state text long phrase",
      type: "anchor",
      weight: 5,
      queryRole: "must",
      relationTo: [],
      negative: false,
      focus: false,
      simplified: false,
      phrase_locked_terms: []
    }
  };

  const queryPlan = normalizeQueryPlan({
    queryPlan: { groups: [{ group_id: "G1", feature_ids: ["F1"], required: true, active: true, terms: [] }] },
    features,
    termsByFeature: { F1: [] },
    featureStateById
  });

  const expression = buildExpression({
    queryPlan,
    features,
    termsByFeature: { F1: [] },
    featureStateById
  });

  check(String(expression || "").trim() === "", "query builder: state.text/feature.text are not auto-injected into expression");
}

function testInitialUsesTopAnchorsOnly() {
  const features = buildSampleFeatures();
  const activeIds = selectInitialActiveFeatureIds(features, { minActive: 2, maxActive: 3 });
  check(activeIds.length >= 2 && activeIds.length <= 3, "initial: active feature count is 2~3");
  check(!activeIds.includes("F4"), "initial: optional feature is not active by default");

  const seed = normalizeQuerySeed(buildSeedPayload(features), features, {
    mode: "initial",
    activeFeatureIds: activeIds
  });
  const maxTermsPerFeatureByFeatureId = {};
  features.forEach((feature) => {
    const featureId = String(feature.id || "").toUpperCase();
    const state = seed.featureStateById?.[featureId] || {};
    const anchorLike = state.core === true || state.queryRole === "must" || state.type === "anchor";
    maxTermsPerFeatureByFeatureId[featureId] = state.active === true && anchorLike ? 2 : 1;
  });

  const queryPlan = normalizeQueryPlan({
    features,
    termsByFeature: seed.termsByFeature,
    featureStateById: seed.featureStateById,
    maxTermsPerFeature: 1,
    maxTermsPerFeatureByFeatureId
  });

  const expression = buildExpression({
    queryPlan,
    features,
    termsByFeature: seed.termsByFeature,
    featureStateById: seed.featureStateById,
    maxActiveGroups: 3,
    maxTermsPerFeature: 1,
    maxTermsPerFeatureByFeatureId
  });

  const groups = countGroups(expression);
  check(groups >= 2 && groups <= 3, "initial: expression renders only 2~3 active groups");
  const activeAnchorGroups = (queryPlan.groups || []).filter((group) => {
    const featureId = String((group.feature_ids || [])[0] || "").toUpperCase();
    const state = seed.featureStateById?.[featureId] || {};
    return group.active !== false && (state.core === true || state.queryRole === "must" || state.type === "anchor");
  });
  const nonAnchorGroups = (queryPlan.groups || []).filter((group) => {
    const featureId = String((group.feature_ids || [])[0] || "").toUpperCase();
    const state = seed.featureStateById?.[featureId] || {};
    return !(state.core === true || state.queryRole === "must" || state.type === "anchor");
  });
  check(activeAnchorGroups.some((group) => (group.terms || []).length === 2), "initial: active anchor/must feature can keep 2 terms");
  check(nonAnchorGroups.every((group) => (group.terms || []).length <= 1), "initial: non-core/non-anchor features keep 1 term");
}

function testWidenModeKeepsBaseAndBroadOnTarget() {
  const selected = selectTermsForMode(
    { id: "F3", text: "피드백", type: "discriminator", queryRole: "should", weight: 4 },
    {
      base_terms: ["피드백"],
      support_terms: ["반복"],
      broad_terms: ["분석"],
      narrow_terms: ["정밀"],
      avoid_terms: [],
      locked_bigrams: []
    },
    "widen",
    {
      active: true,
      includeBroad: true,
      isBroadenTarget: true
    }
  );
  check((selected.terms || []).length === 2, "widen: broaden target keeps base + broad (2 terms)");
}

function testNarrowModeKeepsBaseAndNarrowOnFocus() {
  const selected = selectTermsForMode(
    { id: "F2", text: "보정", type: "anchor", queryRole: "must", weight: 5 },
    {
      base_terms: ["보정"],
      support_terms: ["수정"],
      broad_terms: ["개선"],
      narrow_terms: ["미세"],
      avoid_terms: [],
      locked_bigrams: []
    },
    "narrow",
    {
      active: true,
      isFocusFeature: true
    }
  );
  check((selected.terms || []).length === 2, "narrow: focus feature keeps base + narrow (2 terms)");
}

function testBalancedModeKeepsBaseAndSupportOnSelectedFeatures() {
  const selected = selectTermsForMode(
    { id: "F1", text: "특허", type: "anchor", queryRole: "must", weight: 5 },
    {
      base_terms: ["특허"],
      support_terms: ["patent"],
      broad_terms: [],
      narrow_terms: [],
      avoid_terms: [],
      locked_bigrams: []
    },
    "balanced",
    {
      active: true,
      includeSupport: true,
      isBalancedSupportFeature: true
    }
  );
  check((selected.terms || []).length === 2, "balanced: selected core feature keeps base + support (2 terms)");
}

function testBuilderFeatureOverrideRendersTwoTerms() {
  const features = [{ id: "F1", text: "특허", type: "anchor", weight: 5, query_role: "must", relation_to: [], negative: false }];
  const queryPlan = normalizeQueryPlan({
    queryPlan: {
      groups: [
        { group_id: "G1", feature_ids: ["F1"], required: true, active: true, terms: ["특허", "patent"] }
      ]
    },
    features,
    termsByFeature: { F1: ["특허", "patent"] },
    featureStateById: {
      F1: { enabled: true, active: true, core: true, queryRole: "must", type: "anchor", weight: 5 }
    },
    maxTermsPerFeature: 1,
    maxTermsPerFeatureByFeatureId: { F1: 2 }
  });
  const expression = buildExpression({
    queryPlan,
    features,
    termsByFeature: { F1: ["특허", "patent"] },
    featureStateById: {
      F1: { enabled: true, active: true, core: true, queryRole: "must", type: "anchor", weight: 5 }
    },
    maxTermsPerFeature: 1,
    maxTermsPerFeatureByFeatureId: { F1: 2 }
  });
  check(expression.includes("특허 | patent"), "query builder: feature override keeps 2 terms in expression");
}

function testTooFewSimplifiesAndMayDropWeakGroup() {
  const features = buildSampleFeatures();
  const planned = planQueryAdjustment("too_few", {
    decision: "gap_feature_missing_everywhere",
    saturatedFeatureIds: [],
    gapFeatureIds: ["F3"],
    noisyTermsByFeature: {}
  }, 2, {
    features,
    currentExpression: '("특허 심사 지원") & ("검색식 자동 보정") & ("피드백 반복")',
    expression: '("특허 심사 지원") & ("검색식 자동 보정") & ("피드백 반복")',
    termsByFeature: { F1: ["특허 심사 지원"], F2: ["검색식 자동 보정"], F3: ["피드백 반복"], F4: ["도메인 옵션"] },
    seedByFeature: normalizeQuerySeed(buildSeedPayload(features), features).seedByFeature,
    featureStateById: {
      F1: { enabled: true, active: true, core: true, text: "특허 심사", type: "anchor", weight: 5, queryRole: "must", relationTo: [], negative: false, focus: false, simplified: false, phrase_locked_terms: [] },
      F2: { enabled: true, active: true, core: true, text: "검색식 보정", type: "anchor", weight: 4, queryRole: "must", relationTo: [], negative: false, focus: false, simplified: false, phrase_locked_terms: [] },
      F3: { enabled: true, active: true, core: false, text: "피드백", type: "discriminator", weight: 3, queryRole: "should", relationTo: [], negative: false, focus: false, simplified: false, phrase_locked_terms: [] },
      F4: { enabled: true, active: true, core: false, text: "도메인", type: "optional", weight: 1, queryRole: "can_drop", relationTo: [], negative: false, focus: false, simplified: false, phrase_locked_terms: [] }
    },
    queryPlan: null,
    modeHint: "widen",
    featureActions: [],
    signals: { addCandidates: [], removeCandidates: [] }
  });

  check(planned.expression !== '("특허 심사 지원") & ("검색식 자동 보정") & ("피드백 반복")', "too_few: expression changes after simplify-first planning");
  const allTerms = Object.values(planned.termsByFeature || {}).flat();
  check(!hasWhitespaceTerm(allTerms), "too_few: multiword terms are dephrased to atomic terms");
  check((planned.plannerMeta?.inactiveGroupIds || []).length >= 1, "too_few: weak restrictive group can be dropped");
}

function testTooManyPromotesFocusAndTrimsNoise() {
  const features = buildSampleFeatures();
  const planned = planQueryAdjustment("too_many", {
    decision: "noise_cluster_dominant",
    saturatedFeatureIds: ["F1", "F2"],
    gapFeatureIds: [],
    noisyTermsByFeature: { F1: ["지원센터"] }
  }, 1, {
    features,
    currentExpression: "(특허 | 지원센터) & (심사)",
    expression: "(특허 | 지원센터) & (심사)",
    termsByFeature: { F1: ["특허", "지원센터"], F2: ["심사"], F3: ["피드백"], F4: ["옵션"] },
    seedByFeature: normalizeQuerySeed(buildSeedPayload(features), features).seedByFeature,
    featureStateById: {
      F1: { enabled: true, active: true, core: true, text: "특허", type: "anchor", weight: 5, queryRole: "must", relationTo: [], negative: false, focus: false, simplified: false, phrase_locked_terms: [] },
      F2: { enabled: true, active: true, core: true, text: "심사", type: "anchor", weight: 4, queryRole: "must", relationTo: [], negative: false, focus: false, simplified: false, phrase_locked_terms: [] },
      F3: { enabled: true, active: false, core: false, text: "피드백", type: "discriminator", weight: 4, queryRole: "should", relationTo: [], negative: false, focus: false, simplified: false, phrase_locked_terms: [] },
      F4: { enabled: false, active: false, core: false, text: "옵션", type: "optional", weight: 1, queryRole: "can_drop", relationTo: [], negative: false, focus: false, simplified: false, phrase_locked_terms: [] }
    },
    queryPlan: null,
    modeHint: "narrow",
    featureActions: [],
    signals: { addCandidates: [], removeCandidates: [] }
  });

  check(!!planned.plannerMeta?.promotedFeatureId, "too_many: one focus feature is promoted first");
  check(!(planned.termsByFeature.F1 || []).includes("지원센터"), "too_many: noisy term is trimmed after promotion");
}

function testRefineStructuredOutputWithoutQueryExpression() {
  const normalized = normalizeQueryRefine({
    mode: "narrow",
    feature_actions: [
      {
        feature_id: "F1",
        replace_terms: ["특허 심사"],
        add_terms: ["patent"],
        remove_terms: ["지원"],
        disable_feature: false,
        enable_feature: true,
        promote_to_required: true,
        simplify_first: true
      }
    ],
    final_terms_by_feature: {
      F1: ["특허 심사", "patent"],
      F2: ["심사"]
    },
    notes: "deterministic"
  }, ["F1", "F2"]);

  check(normalized.mode === "narrow", "normalizeQueryRefine: mode parsed without query_expression");
  check((normalized.finalTermsByFeature.F1 || [])[0] === "특허", "normalizeQueryRefine: final_terms_by_feature is atomized");
  check((normalized.featureActions[0]?.replaceTerms || [])[0] === "특허", "normalizeQueryRefine: feature action terms are atomized");
}

async function testNoOpRefineSkipsVersion() {
  const features = [{ id: "F1", text: "특허", type: "anchor", weight: 5, query_role: "must", relation_to: [], negative: false }];
  const currentVersion = {
    queryVersionId: "krqv_test",
    expression: "(특허)",
    termsByFeature: { F1: ["특허"] },
    seedByFeature: {
      F1: {
        base_terms: ["특허"],
        support_terms: [],
        broad_terms: [],
        narrow_terms: [],
        avoid_terms: [],
        locked_bigrams: []
      }
    },
    featureStateById: {
      F1: {
        enabled: true,
        active: true,
        core: true,
        text: "특허",
        type: "anchor",
        weight: 5,
        queryRole: "must",
        relationTo: [],
        negative: false,
        focus: false,
        simplified: false,
        phrase_locked_terms: []
      }
    },
    queryPlan: {
      groups: [
        { group_id: "G1", feature_ids: ["F1"], required: true, active: true, terms: ["특허"] }
      ]
    }
  };

  const result = await manualGateRefineQuery({
    claimText: "특허",
    features,
    currentVersion,
    queryVersions: [currentVersion],
    iterations: [],
    feedbackLog: [],
    decision: "too_many",
    repeatCount: 1,
    skipLlm: true,
    modelName: "gemma-26b-moe"
  });

  check(result?.noChange === true, "no-op guard: same-expression refine returns noChange");
  check(!result?.queryVersionId, "no-op guard: no new queryVersionId is created on noChange");
}

function testLockedBigramException() {
  const selected = selectTermsForMode(
    { id: "F1", text: "feature", type: "anchor", queryRole: "must", weight: 5 },
    {
      base_terms: ["특허"],
      narrow_terms: [],
      locked_bigrams: ["machine learning"]
    },
    "narrow",
    {
      active: true,
      isFocusFeature: true,
      allowLockedBigrams: true,
      phraseLockedTerms: ["machine learning"]
    }
  );

  check((selected.terms || []).some((term) => term === "machine learning"), "locked bigram: allowed as two-word exception when explicitly locked");

  const features = [{ id: "F1", text: "x", type: "anchor", weight: 5, query_role: "must", relation_to: [], negative: false }];
  const expression = buildExpression({
    queryPlan: {
      groups: [
        { group_id: "G1", feature_ids: ["F1"], required: true, active: true, terms: ["machine learning"], phrase_locked_terms: ["machine learning"] }
      ]
    },
    features,
    termsByFeature: { F1: ["machine learning"] },
    featureStateById: {
      F1: {
        enabled: true,
        active: true,
        core: true,
        text: "x",
        type: "anchor",
        weight: 5,
        queryRole: "must",
        relationTo: [],
        negative: false,
        focus: false,
        simplified: false,
        phrase_locked_terms: ["machine learning"]
      }
    }
  });

  check(expression.includes("machine learning"), "locked bigram: preserved in final expression");
  check(!expression.includes('"machine learning"'), "locked bigram: not auto-quoted by default policy");
}

function testLegacyExactPhraseNotAutoQuoted() {
  const features = [{ id: "F1", text: "특허 심사", type: "anchor", weight: 5, query_role: "must", relation_to: [], negative: false }];
  const seed = normalizeQuerySeed({
    terms_by_feature: [
      {
        feature_id: "F1",
        base_terms: ["특허 심사"],
        exact_phrase_terms: ["특허 심사"]
      }
    ]
  }, features, { mode: "initial", activeFeatureIds: ["F1"] });

  const queryPlan = normalizeQueryPlan({
    queryPlan: null,
    features,
    termsByFeature: seed.termsByFeature,
    featureStateById: seed.featureStateById,
    maxTermsPerFeature: 1
  });
  const expression = buildExpression({
    queryPlan,
    features,
    termsByFeature: seed.termsByFeature,
    featureStateById: seed.featureStateById,
    maxTermsPerFeature: 1
  });

  check(!expression.includes('"특허 심사"'), "legacy exact_phrase_terms: no automatic quoted phrase rendering");
}

function testLegacyCompatibilityLoad() {
  const payload = {
    kresearch_sessions_v1: [
      {
        sessionId: "legacy_1",
        claimText: "legacy claim",
        status: "ready",
        currentQueryVersionId: "legacy_qv_1",
        queryVersions: [
          {
            queryVersionId: "legacy_qv_1",
            expression: "(특허 심사 지원)",
            termsByFeature: {
              F1: ["특허 심사 지원", "심사"]
            },
            seedByFeature: {
              F1: {
                base_terms: ["특허"],
                exact_phrase_terms: ["특허 심사"]
              }
            },
            featureStateById: {
              F1: { enabled: true, core: true, text: "특허 심사" }
            }
          }
        ]
      }
    ],
    kresearch_active_session_v1: "legacy_1"
  };

  const normalized = normalizeWorkspacePayload(payload);
  const session = normalized.sessions[0];
  const version = session.queryVersions[0];

  check(Array.isArray(version.termsByFeature.F1), "legacy: string term arrays are preserved");
  check(typeof session.features[0].id === "string", "legacy: feature list restored");
  check(session.queryVersions[0].featureStateById.F1.active !== undefined, "legacy: new state fields are normalized");
  check(typeof version.fingerprint === "string", "legacy: fingerprint field normalized");
  check(typeof version.semanticFingerprint === "string", "legacy: semanticFingerprint field normalized");
  check(Array.isArray(version.activeTerms), "legacy: activeTerms normalized");
}

function testFingerprintIgnoresGroupOrder() {
  const queryPlanA = {
    groups: [
      { group_id: "G1", feature_ids: ["F1"], required: true, active: true, terms: ["patent"] },
      { group_id: "G2", feature_ids: ["F2"], required: true, active: true, terms: ["examination"] }
    ]
  };
  const queryPlanB = {
    groups: [
      { group_id: "G2", feature_ids: ["F2"], required: true, active: true, terms: ["examination"] },
      { group_id: "G1", feature_ids: ["F1"], required: true, active: true, terms: ["patent"] }
    ]
  };
  const termsByFeature = { F1: ["patent"], F2: ["examination"] };
  const featureStateById = {
    F1: { enabled: true, active: true, core: true, queryRole: "must", weight: 5 },
    F2: { enabled: true, active: true, core: true, queryRole: "must", weight: 4 }
  };

  const left = buildQueryFingerprint({ queryPlan: queryPlanA, termsByFeature, featureStateById });
  const right = buildQueryFingerprint({ queryPlan: queryPlanB, termsByFeature, featureStateById });
  check(left === right, "fingerprint: group order difference is canonicalized");
}

function testFingerprintIgnoresOrTermOrderAndCaseSpace() {
  const queryPlanA = {
    groups: [
      { group_id: "G1", feature_ids: ["F1"], required: true, active: true, terms: [" Patent ", "EXAMINATION"] }
    ]
  };
  const queryPlanB = {
    groups: [
      { group_id: "G1", feature_ids: ["F1"], required: true, active: true, terms: ["examination", "patent"] }
    ]
  };
  const termsByFeature = { F1: ["patent", "examination"] };
  const featureStateById = { F1: { enabled: true, active: true, core: true, queryRole: "must", weight: 5 } };
  const left = buildQueryFingerprint({ queryPlan: queryPlanA, termsByFeature, featureStateById });
  const right = buildQueryFingerprint({ queryPlan: queryPlanB, termsByFeature, featureStateById });
  check(left === right, "fingerprint: OR-term order/case/space difference is canonicalized");
}

function testCrossGroupDedupeOwnerAndDropRules() {
  const queryPlan = {
    groups: [
      { group_id: "G1", feature_ids: ["F1"], required: true, active: true, terms: ["patent"] },
      { group_id: "G2", feature_ids: ["F2"], required: false, active: true, terms: ["patent"] },
      { group_id: "G3", feature_ids: ["F3"], required: true, active: true, terms: ["sensor"] },
      { group_id: "G4", feature_ids: ["F4"], required: true, active: true, terms: ["sensor"] }
    ]
  };
  const termsByFeature = {
    F1: ["patent", "invention"],
    F2: ["patent"],
    F3: ["sensor"],
    F4: ["sensor"]
  };
  const featureStateById = {
    F1: { enabled: true, active: true, core: true, queryRole: "must", weight: 5 },
    F2: { enabled: true, active: true, core: false, queryRole: "should", weight: 2 },
    F3: { enabled: true, active: true, core: true, queryRole: "must", weight: 4 },
    F4: { enabled: true, active: true, core: true, queryRole: "must", weight: 3 }
  };
  const deduped = dedupeTermsAcrossActiveGroups({ queryPlan, termsByFeature, featureStateById });
  const dedupedGroups = deduped.queryPlan.groups;
  const g1 = dedupedGroups.find((group) => group.group_id === "G1");
  const g2 = dedupedGroups.find((group) => group.group_id === "G2");
  check((g1?.terms || []).includes("patent"), "cross-group dedupe: required/core owner keeps duplicated term");
  check(g2?.active === false || !(g2?.terms || []).includes("patent"), "cross-group dedupe: non-owner group loses duplicated term");
  check(deduped.debugMeta.rebuild_required_due_to_cross_group_dedupe === true, "cross-group dedupe: required group empty triggers rebuild_required");
}

async function testSemanticDuplicateBlockedNoNewVersion() {
  const features = [{ id: "F1", text: "patent", type: "anchor", weight: 5, query_role: "must", relation_to: [], negative: false }];
  const currentVersion = {
    queryVersionId: "krqv_current",
    expression: "(patent)",
    termsByFeature: { F1: ["patent"] },
    seedByFeature: {
      F1: {
        base_terms: ["patent"],
        support_terms: [],
        broad_terms: [],
        narrow_terms: [],
        avoid_terms: [],
        locked_bigrams: []
      }
    },
    featureStateById: {
      F1: {
        enabled: true,
        active: true,
        core: true,
        text: "patent",
        type: "anchor",
        weight: 5,
        queryRole: "must",
        relationTo: [],
        negative: false,
        focus: false,
        simplified: false,
        phrase_locked_terms: []
      }
    },
    queryPlan: {
      groups: [
        { group_id: "G1", feature_ids: ["F1"], required: true, active: true, terms: ["patent"] }
      ]
    },
    fingerprint: buildQueryFingerprint({
      queryPlan: { groups: [{ group_id: "G1", feature_ids: ["F1"], required: true, active: true, terms: ["patent"] }] },
      termsByFeature: { F1: ["patent"] },
      featureStateById: { F1: { enabled: true, active: true } }
    }),
    semanticFingerprint: buildSemanticQueryFingerprint({
      queryPlan: { groups: [{ group_id: "G1", feature_ids: ["F1"], required: true, active: true, terms: ["patent"] }] },
      termsByFeature: { F1: ["patent"] },
      featureStateById: { F1: { enabled: true, active: true } }
    })
  };

  const result = await manualGateRefineQuery({
    claimText: "patent",
    features,
    currentVersion,
    queryVersions: [currentVersion],
    iterations: [],
    feedbackLog: [],
    decision: "too_few",
    repeatCount: 2,
    skipLlm: true,
    modelName: "gemma-26b-moe"
  });

  check(result?.noChange === true, "duplicate guard: semantic duplicate blocks new queryVersion");
  check(!result?.queryVersionId, "duplicate guard: no queryVersionId is created on semantic duplicate");
}

async function testDuplicateBlockedRunsCorrectivePass() {
  const features = [
    { id: "F1", text: "patent", type: "anchor", weight: 5, query_role: "must", relation_to: [], negative: false },
    { id: "F2", text: "examination", type: "discriminator", weight: 4, query_role: "should", relation_to: [], negative: false }
  ];
  const currentVersion = {
    queryVersionId: "krqv_current_2",
    expression: "(patent)",
    termsByFeature: { F1: ["patent"], F2: ["examination"] },
    seedByFeature: {
      F1: { base_terms: ["patent"], support_terms: [], broad_terms: [], narrow_terms: [], avoid_terms: [], locked_bigrams: [] },
      F2: { base_terms: ["examination"], support_terms: [], broad_terms: ["review"], narrow_terms: [], avoid_terms: [], locked_bigrams: [] }
    },
    featureStateById: {
      F1: { enabled: true, active: true, core: true, text: "patent", type: "anchor", weight: 5, queryRole: "must", relationTo: [], negative: false, focus: false, simplified: false, phrase_locked_terms: [] },
      F2: { enabled: true, active: false, core: false, text: "examination", type: "discriminator", weight: 4, queryRole: "should", relationTo: [], negative: false, focus: false, simplified: false, phrase_locked_terms: [] }
    },
    queryPlan: {
      groups: [
        { group_id: "G1", feature_ids: ["F1"], required: true, active: true, terms: ["patent"] },
        { group_id: "G2", feature_ids: ["F2"], required: false, active: false, terms: ["examination"] }
      ]
    },
    fingerprint: "test",
    semanticFingerprint: "test_sem"
  };

  const duplicatePlan = {
    groups: [
      { group_id: "G1", feature_ids: ["F1"], required: true, active: true, terms: ["patent"] },
      { group_id: "G2", feature_ids: ["F2"], required: true, active: true, terms: ["examination"] }
    ]
  };
  const duplicateHistory = {
    ...currentVersion,
    queryVersionId: "krqv_old_dup",
    expression: "(patent) & (examination)",
    queryPlan: duplicatePlan,
    termsByFeature: { F1: ["patent"], F2: ["examination"] },
    featureStateById: {
      ...currentVersion.featureStateById,
      F2: { ...currentVersion.featureStateById.F2, enabled: true, active: true, core: true, focus: true }
    },
    fingerprint: buildQueryFingerprint({
      queryPlan: duplicatePlan,
      termsByFeature: { F1: ["patent"], F2: ["examination"] },
      featureStateById: {
        F1: { enabled: true, active: true },
        F2: { enabled: true, active: true }
      }
    }),
    semanticFingerprint: buildSemanticQueryFingerprint({
      queryPlan: duplicatePlan,
      termsByFeature: { F1: ["patent"], F2: ["examination"] },
      featureStateById: {
        F1: { enabled: true, active: true },
        F2: { enabled: true, active: true }
      }
    })
  };

  const result = await manualGateRefineQuery({
    claimText: "patent examination",
    features,
    currentVersion,
    queryVersions: [duplicateHistory, currentVersion],
    iterations: [],
    feedbackLog: [],
    decision: "too_many",
    repeatCount: 2,
    skipLlm: true,
    modelName: "gemma-26b-moe"
  });

  check(result?.duplicateBlocked === true || result?.noChange === true, "duplicate guard: duplicate conflict triggers blocked/corrective path");
  check(
    !!result?.duplicateBlocked || !!result?.duplicateOfQueryVersionId || result?.noChange === true,
    "duplicate guard: duplicate blocking metadata is present"
  );
}

async function testDeterministicDuplicateRepairPath() {
  const features = [
    { id: "F1", text: "특허 심사", type: "anchor", weight: 5, query_role: "must", relation_to: [], negative: false },
    { id: "F2", text: "보정", type: "discriminator", weight: 4, query_role: "should", relation_to: [], negative: false }
  ];

  const currentVersion = {
    queryVersionId: "krqv_dup_current",
    expression: "(특허) & (보정)",
    termsByFeature: { F1: ["특허"], F2: ["보정"] },
    seedByFeature: {
      F1: { base_terms: ["특허"], support_terms: ["심사"], broad_terms: [], narrow_terms: [], avoid_terms: [], locked_bigrams: [] },
      F2: { base_terms: ["보정"], support_terms: ["개선"], broad_terms: ["조정"], narrow_terms: ["정밀"], avoid_terms: [], locked_bigrams: [] }
    },
    featureStateById: {
      F1: { enabled: true, active: true, core: true, text: "특허 심사", type: "anchor", weight: 5, queryRole: "must", relationTo: [], negative: false, focus: false, simplified: false, phrase_locked_terms: [] },
      F2: { enabled: true, active: true, core: false, text: "보정", type: "discriminator", weight: 4, queryRole: "should", relationTo: [], negative: false, focus: false, simplified: false, phrase_locked_terms: [] }
    },
    queryPlan: {
      groups: [
        { group_id: "G1", feature_ids: ["F1"], required: true, active: true, terms: ["특허"] },
        { group_id: "G2", feature_ids: ["F2"], required: false, active: true, terms: ["보정"] }
      ]
    }
  };

  const oldDuplicate = {
    ...currentVersion,
    queryVersionId: "krqv_dup_old",
    fingerprint: buildQueryFingerprint({
      queryPlan: currentVersion.queryPlan,
      termsByFeature: currentVersion.termsByFeature,
      featureStateById: currentVersion.featureStateById
    }),
    semanticFingerprint: buildSemanticQueryFingerprint({
      queryPlan: currentVersion.queryPlan,
      termsByFeature: currentVersion.termsByFeature,
      featureStateById: currentVersion.featureStateById
    })
  };

  const repaired = await autoRepairDuplicateQuery({
    claimText: "특허 심사 보정",
    features,
    currentVersion,
    queryVersions: [oldDuplicate, currentVersion],
    trigger: {
      reason: "preflight_query_version_reused",
      duplicateOfQueryVersionId: "krqv_dup_old",
      matchType: "query_version_reuse"
    },
    skipLlm: true
  });

  check(!!repaired?.queryVersionId, "duplicate repair: deterministic path can create a new query version");
  check(
    String(repaired?.expression || "").trim() !== String(currentVersion.expression || "").trim(),
    "duplicate repair: deterministic path produces changed expression"
  );
  check(repaired?.duplicateBlocked !== true, "duplicate repair: deterministic path result is not duplicate-blocked");
}

function testCrossGroupDedupeAppliedOnRender() {
  const features = [
    { id: "F1", text: "patent", type: "anchor", weight: 5, query_role: "must", relation_to: [], negative: false },
    { id: "F2", text: "review", type: "discriminator", weight: 3, query_role: "should", relation_to: [], negative: false }
  ];
  const featureStateById = {
    F1: { enabled: true, active: true, core: true, text: "patent", type: "anchor", weight: 5, queryRole: "must", relationTo: [], negative: false, focus: false, simplified: false, phrase_locked_terms: [] },
    F2: { enabled: true, active: true, core: false, text: "review", type: "discriminator", weight: 3, queryRole: "should", relationTo: [], negative: false, focus: false, simplified: false, phrase_locked_terms: [] }
  };
  const queryPlan = {
    groups: [
      { group_id: "G1", feature_ids: ["F1"], required: true, active: true, terms: ["patent"] },
      { group_id: "G2", feature_ids: ["F2"], required: false, active: true, terms: ["patent"] }
    ]
  };

  const expression = buildExpression({
    queryPlan,
    features,
    termsByFeature: { F1: ["patent"], F2: ["patent"] },
    featureStateById
  });

  const patentOccurrences = (expression.match(/patent/gi) || []).length;
  check(patentOccurrences === 1, "cross-group dedupe: final rendered expression keeps duplicate term in one group only");
}

function testCrossGroupDedupeWithTwoTermGroups() {
  const features = [
    { id: "F1", text: "특허", type: "anchor", weight: 5, query_role: "must", relation_to: [], negative: false },
    { id: "F2", text: "심사", type: "anchor", weight: 4, query_role: "must", relation_to: [], negative: false }
  ];
  const featureStateById = {
    F1: { enabled: true, active: true, core: true, queryRole: "must", type: "anchor", weight: 5 },
    F2: { enabled: true, active: true, core: true, queryRole: "must", type: "anchor", weight: 4 }
  };
  const expression = buildExpression({
    queryPlan: {
      groups: [
        { group_id: "G1", feature_ids: ["F1"], required: true, active: true, terms: ["특허", "patent"] },
        { group_id: "G2", feature_ids: ["F2"], required: true, active: true, terms: ["patent", "심사"] }
      ]
    },
    features,
    termsByFeature: {
      F1: ["특허", "patent"],
      F2: ["patent", "심사"]
    },
    featureStateById,
    maxTermsPerFeature: 1,
    maxTermsPerFeatureByFeatureId: {
      F1: 2,
      F2: 2
    }
  });

  const patentOccurrences = (expression.match(/patent/gi) || []).length;
  check(patentOccurrences === 1, "cross-group dedupe: duplicate term removed even with two-term groups");
}

async function main() {
  process.stdout.write("Running K-Research refactor policy tests...\n");
  testRefineHistoryPromptLimitIsFour();
  testBuildCompactRefineContextKeepsCoreSignals();
  testDuplicateRetryPolicyOneExtraAttempt();
  testRefinePromptPayloadUsesCompactContextVariable();
  testStructuredCallsUsePromptSchemaGuard();
  testPromptSchemasDefineExplicitEnums();
  testApiDisablesResponseFormatTransport();
  testSettingsModelControlsNormalizeAndLoad();
  testResolvePromptCallOptionsReasoningOverrides();
  testSettingsInvalidReasoningFallbackLow();
  testNormalizeQueryRefineActionTypeFallback();
  testPromptLoaderIncludesDuplicateRepairBundle();
  testPromptIncludesCompoundSplitRule();
  testSeedNormalizeSplitsMultiword();
  testFallbackBaseTermSingleAtom();
  testNoSpaceCompoundIsDecomposedToAtoms();
  testSeedNormalizationSpillsCompoundTailToSupport();
  testBuilderNoStateFeatureTextInjection();
  testFingerprintIgnoresGroupOrder();
  testFingerprintIgnoresOrTermOrderAndCaseSpace();
  testCrossGroupDedupeOwnerAndDropRules();
  testCrossGroupDedupeAppliedOnRender();
  testCrossGroupDedupeWithTwoTermGroups();
  testInitialUsesTopAnchorsOnly();
  testWidenModeKeepsBaseAndBroadOnTarget();
  testNarrowModeKeepsBaseAndNarrowOnFocus();
  testBalancedModeKeepsBaseAndSupportOnSelectedFeatures();
  testBuilderFeatureOverrideRendersTwoTerms();
  testTooFewSimplifiesAndMayDropWeakGroup();
  testTooManyPromotesFocusAndTrimsNoise();
  testRefineStructuredOutputWithoutQueryExpression();
  await testNoOpRefineSkipsVersion();
  await testSemanticDuplicateBlockedNoNewVersion();
  await testDuplicateBlockedRunsCorrectivePass();
  await testDeterministicDuplicateRepairPath();
  testLockedBigramException();
  testLegacyExactPhraseNotAutoQuoted();
  testLegacyCompatibilityLoad();
  process.stdout.write("All K-Research refactor policy tests passed.\n");
}

main().catch((error) => {
  process.stderr.write(`K-Research refactor policy test failed: ${error.message}\n`);
  process.exitCode = 1;
});
