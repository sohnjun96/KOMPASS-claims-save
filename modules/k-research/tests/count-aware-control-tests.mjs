import assert from "node:assert/strict";

import {
  parseKompassDialogCount,
  resolveBestObservedCount,
  classifyResultCount,
  buildRepeatReasonSignature,
  computeGroupBudget
} from "../core/count_control.js";
import { planQueryAdjustment, deriveEscalationFamily } from "../core/engine.js";

function check(condition, message) {
  assert.ok(condition, message);
  process.stdout.write(`PASS  ${message}\n`);
}

function buildFeatureSet(count = 4) {
  const features = [];
  for (let i = 1; i <= count; i += 1) {
    features.push({
      id: `F${i}`,
      text: `구성 ${i}`,
      type: i <= 2 ? "anchor" : (i === 3 ? "discriminator" : "relation"),
      weight: i <= 2 ? 5 - (i - 1) : 3,
      query_role: i <= 2 ? "must" : "should",
      relation_to: [],
      negative: false,
      search_hint: `키워드${i}`
    });
  }
  return features;
}

function buildFeatureState(features) {
  const out = {};
  features.forEach((feature, idx) => {
    const featureId = String(feature.id || "").toUpperCase();
    out[featureId] = {
      enabled: true,
      active: true,
      core: idx < 2,
      text: feature.text,
      type: feature.type,
      weight: feature.weight,
      queryRole: feature.query_role,
      relationTo: [],
      negative: false,
      focus: false,
      simplified: false,
      phrase_locked_terms: []
    };
  });
  return out;
}

function buildTermsByFeature(features) {
  const out = {};
  features.forEach((feature, idx) => {
    const featureId = String(feature.id || "").toUpperCase();
    out[featureId] = [`키워드${idx + 1}`];
  });
  return out;
}

function buildSeedByFeature(features) {
  const out = {};
  features.forEach((feature, idx) => {
    const featureId = String(feature.id || "").toUpperCase();
    out[featureId] = {
      base_terms: [`키워드${idx + 1}`],
      support_terms: [`대체${idx + 1}`],
      broad_terms: [`광의${idx + 1}`],
      narrow_terms: [`협의${idx + 1}`],
      avoid_terms: [],
      entity_terms: [`대상${idx + 1}`],
      action_terms: [`동작${idx + 1}`],
      qualifier_terms: [`조건${idx + 1}`],
      noise_prone_terms: [`노이즈${idx + 1}`],
      locked_bigrams: []
    };
  });
  return out;
}

function testParseKompassDialogCountExact() {
  const message = "검색된 국문 내용이 1만건(1,120,123건)을 초과하였습니다.";
  const parsed = parseKompassDialogCount(message);
  check(parsed === 1120123, "dialog exact count: extract 1,120,123 -> 1120123");
}

function testResolveBestObservedCountPriority() {
  const observed = resolveBestObservedCount({
    dialogState: {
      history: [
        {
          rawType: "confirm",
          kind: "many",
          message: "검색된 국문 내용이 1만건(1,120,123건)을 초과하였습니다.",
          parsedCount: 1120123
        }
      ],
      firstDialog: { rawType: "confirm", kind: "many", parsedCount: 1120123 },
      lastDialog: { rawType: "confirm", kind: "many", parsedCount: 1120123 }
    },
    pageCountState: { ok: true, count: 842 }
  });
  check(observed.count === 1120123, "count source priority: dialog exact count wins over page count");
  check(observed.countSource === "dialog_exact_over_10k", "count source priority: source is dialog_exact_over_10k");
}

function testCountBucketClassification() {
  check(classifyResultCount(0).bucket === "0", "bucket: 0 -> 0");
  check(classifyResultCount(15).bucket === "1_20", "bucket: 15 -> 1_20");
  check(classifyResultCount(75).bucket === "21_100", "bucket: 75 -> 21_100");
  check(classifyResultCount(250).bucket === "101_300", "bucket: 250 -> 101_300");
  check(classifyResultCount(350).bucket === "301_1000", "bucket: 350 -> 301_1000");
}

function testRepeatReasonSignature() {
  const signature = buildRepeatReasonSignature({
    decision: "too_many",
    countBucket: "over_10000",
    previousBucket: "over_10000",
    reductionRatio: 0.94
  });
  check(signature.includes("too_many|over_10000"), "repeat signature: includes decision and bucket");
  check(signature.includes("low_reduction"), "repeat signature: encodes reduction severity");
}

function testEscalationFamilySwitchByRepeatReason() {
  const direct = deriveEscalationFamily({
    mode: "narrow",
    countBucket: "over_10000",
    repeatReasonCount: 2,
    repeatReasonSignature: "too_many|over_10000|low_reduction|same_bucket"
  });
  check(direct === "split_feature_narrow", "deriveEscalationFamily: repeat too_many escalates to split_feature_narrow");

  const features = buildFeatureSet(4);
  const planned = planQueryAdjustment(null, {
    decision: "noise_cluster_dominant",
    countBucket: "over_10000",
    repeatReasonCount: 2,
    repeatReasonSignature: "too_many|over_10000|low_reduction|same_bucket",
    currentResultCount: 1120123,
    saturatedFeatureIds: ["F1", "F2"],
    gapFeatureIds: [],
    noisyTermsByFeature: {}
  }, 2, {
    features,
    currentExpression: "(키워드1) & (키워드2)",
    expression: "(키워드1) & (키워드2)",
    termsByFeature: buildTermsByFeature(features),
    seedByFeature: buildSeedByFeature(features),
    featureStateById: {
      ...buildFeatureState(features),
      F3: {
        ...buildFeatureState(features).F3,
        active: false,
        enabled: true,
        core: false,
        queryRole: "should",
        type: "discriminator"
      }
    },
    queryPlan: null,
    modeHint: "narrow",
    featureActions: [],
    signals: { addCandidates: [], removeCandidates: [] },
    recentEscalationFamilies: ["standard_narrow"]
  });
  check(planned?.plannerMeta?.escalationFamily !== "standard_narrow", "same reason blocking: avoid repeating standard_narrow family");
}

function testSplitFeaturePlanCanIncreaseGroupCount() {
  const features = buildFeatureSet(1);
  const planned = planQueryAdjustment("too_many", {
    decision: "noise_cluster_dominant",
    countBucket: "1001_10000",
    repeatReasonCount: 2,
    repeatReasonSignature: "too_many|1001_10000|low_reduction|same_bucket",
    currentResultCount: 2200,
    saturatedFeatureIds: ["F1"],
    gapFeatureIds: [],
    noisyTermsByFeature: {}
  }, 2, {
    features,
    currentExpression: "(키워드1)",
    expression: "(키워드1)",
    termsByFeature: { F1: ["키워드1"] },
    seedByFeature: {
      F1: {
        base_terms: ["키워드1"],
        support_terms: ["대체1"],
        broad_terms: ["광의1"],
        narrow_terms: ["협의1"],
        avoid_terms: [],
        entity_terms: ["대상1"],
        action_terms: ["동작1"],
        qualifier_terms: ["조건1"],
        noise_prone_terms: ["노이즈1"],
        locked_bigrams: []
      }
    },
    featureStateById: {
      F1: {
        enabled: true,
        active: true,
        core: true,
        text: "구성 1",
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
    queryPlan: null,
    modeHint: "narrow",
    featureActions: [],
    signals: { addCandidates: [], removeCandidates: [] },
    refineHints: {
      splitFeaturePlans: [
        {
          featureId: "F1",
          groups: [
            { group_role: "micro_entity", terms: ["대상1", "개체1"] },
            { group_role: "micro_action", terms: ["동작1", "판정1"] }
          ]
        }
      ],
      promoteFeatureIds: [],
      dropFeatureIds: [],
      dephraseTerms: [],
      dropGroupIds: [],
      antiNoiseTerms: [],
      countStrategyNote: "",
      rebuildRequired: false
    }
  });

  const groups = Array.isArray(planned?.queryPlan?.groups) ? planned.queryPlan.groups : [];
  const activeGroups = groups.filter((group) => group?.active !== false);
  check(activeGroups.length >= 2, "split_feature_plans: single feature can materialize into multiple retrieval groups");
}

function testGroupBudgetHardCap() {
  const features = buildFeatureSet(8);
  const planned = planQueryAdjustment("too_many", {
    decision: "noise_cluster_dominant",
    countBucket: "over_10000",
    repeatReasonCount: 4,
    repeatReasonSignature: "too_many|over_10000|low_reduction|same_bucket",
    currentResultCount: 200000,
    saturatedFeatureIds: ["F1", "F2", "F3", "F4", "F5", "F6"],
    gapFeatureIds: [],
    noisyTermsByFeature: {}
  }, 4, {
    features,
    currentExpression: "(키워드1) & (키워드2) & (키워드3)",
    expression: "(키워드1) & (키워드2) & (키워드3)",
    termsByFeature: buildTermsByFeature(features),
    seedByFeature: buildSeedByFeature(features),
    featureStateById: buildFeatureState(features),
    queryPlan: null,
    modeHint: "narrow",
    featureActions: [],
    signals: { addCandidates: [], removeCandidates: [] }
  });

  const budget = Number(planned?.plannerMeta?.groupBudget || 0);
  const activeGroupIds = Array.isArray(planned?.plannerMeta?.activeGroupIds) ? planned.plannerMeta.activeGroupIds : [];
  check(budget >= 2 && budget <= 5, "group budget: computed within 2~5 hard cap");
  check(activeGroupIds.length <= 5, "group budget: active retrieval groups do not exceed hard cap");
  check(computeGroupBudget({ mode: "narrow", countBucket: "over_10000", repeatReasonCount: 4 }) <= 5, "group budget helper: hard cap <= 5");
}

function main() {
  process.stdout.write("Running K-Research count-aware control tests...\n");
  testParseKompassDialogCountExact();
  testResolveBestObservedCountPriority();
  testCountBucketClassification();
  testRepeatReasonSignature();
  testEscalationFamilySwitchByRepeatReason();
  testSplitFeaturePlanCanIncreaseGroupCount();
  testGroupBudgetHardCap();
  process.stdout.write("All K-Research count-aware control tests passed.\n");
}

main();
