import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeWorkspacePayload } from "../../modules/k-research/core/storage.js";
import { planQueryAdjustment, summarizeIteration } from "../../modules/k-research/core/engine.js";
import { deriveQueryPlanFromExpression } from "../../modules/k-research/core/query_builder.js";
import {
  parseJsonFromText,
  validateAgainstSchema,
  normalizeCitationEval,
  normalizeFeatureExtract,
  normalizeQuerySeed
} from "../../modules/k-research/core/schema.js";

const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(testRoot, "..", "..");

function readFixture(name, asJson = true) {
  const absolutePath = path.join(testRoot, "fixtures", name);
  const raw = fs.readFileSync(absolutePath, "utf8");
  return asJson ? JSON.parse(raw) : raw;
}

function check(condition, message) {
  assert.ok(condition, message);
  process.stdout.write(`PASS  ${message}\n`);
}

function testOldSessionMigration() {
  const legacyPayload = readFixture("legacy_workspace_old_schema.json");
  const normalized = normalizeWorkspacePayload(legacyPayload);

  check(Array.isArray(normalized.sessions) && normalized.sessions.length === 1, "migration: legacy session is loaded");
  check(normalized.activeSessionId === "legacy_session_1", "migration: active session id is preserved");

  const session = normalized.sessions[0];
  check(Array.isArray(session.features) && session.features.length >= 2, "migration: features are present");
  session.features.forEach((feature, index) => {
    check(typeof feature.type === "string" && feature.type.length > 0, `migration: feature type normalized (${index + 1})`);
    check(typeof feature.query_role === "string" && feature.query_role.length > 0, `migration: feature query_role normalized (${index + 1})`);
    check(Number.isInteger(feature.weight) && feature.weight >= 1 && feature.weight <= 5, `migration: feature weight normalized (${index + 1})`);
  });

  const version = session.queryVersions?.[0];
  check(!!version, "migration: query version exists");
  check(typeof version.expression === "string" && version.expression.length > 0, "migration: expression reconstructed");
  check(Array.isArray(version.queryPlan?.groups) && version.queryPlan.groups.length > 0, "migration: queryPlan groups created");
  check(typeof version.feedbackBasis === "object", "migration: feedbackBasis default object created");
}

function buildPlannerInput() {
  const features = [
    { id: "F1", text: "motor drive", type: "anchor", weight: 5, query_role: "must", relation_to: [], negative: false },
    { id: "F2", text: "sensor feedback", type: "relation", weight: 4, query_role: "should", relation_to: ["F1"], negative: false },
    { id: "F3", text: "thermal compensation", type: "optional", weight: 2, query_role: "can_drop", relation_to: [], negative: false }
  ];
  const featureStateById = {
    F1: { enabled: true, core: true, text: "motor drive", queryRole: "must", type: "anchor", weight: 5, relationTo: [], negative: false },
    F2: { enabled: true, core: false, text: "sensor feedback", queryRole: "should", type: "relation", weight: 4, relationTo: ["F1"], negative: false },
    F3: { enabled: false, core: false, text: "thermal compensation", queryRole: "can_drop", type: "optional", weight: 2, relationTo: [], negative: false }
  };
  const termsByFeature = {
    F1: ["motor drive", "drive stage"],
    F2: ["sensor feedback", "feedback signal", "generic feedback"],
    F3: ["thermal compensation"]
  };

  return {
    features,
    currentExpression: "(\"motor drive\" | \"drive stage\") & (\"sensor feedback\" | \"feedback signal\" | \"generic feedback\")",
    expression: "(\"motor drive\" | \"drive stage\") & (\"sensor feedback\" | \"feedback signal\" | \"generic feedback\")",
    queryPlan: null,
    termsByFeature,
    featureStateById,
    modeHint: "balanced",
    featureActions: [],
    signals: {
      addCandidates: [{ featureId: "F3", term: "thermal correction path", count: 2 }],
      removeCandidates: [{ featureId: "F2", term: "generic feedback", count: 3 }]
    },
    maxActions: 3
  };
}

function testPlannerModes() {
  const inputBase = buildPlannerInput();

  const narrow = planQueryAdjustment("too_many", {
    decision: "noise_cluster_dominant",
    saturatedFeatureIds: ["F2"],
    gapFeatureIds: [],
    noisyTermsByFeature: { F2: ["generic feedback"] }
  }, 1, inputBase);

  check(narrow.mode === "narrow", "planner: too_many -> narrow mode");
  check(typeof narrow.expression === "string" && narrow.expression.length > 0, "planner: narrow expression built");
  check((narrow.termsByFeature.F2 || []).length <= (inputBase.termsByFeature.F2 || []).length, "planner: narrow reduces/keeps F2 terms");
  check(Array.isArray(narrow.feedbackActions) && narrow.feedbackActions.length > 0, "planner: narrow feedback actions emitted");

  const widen = planQueryAdjustment("too_few", {
    decision: "gap_feature_missing_everywhere",
    saturatedFeatureIds: ["F1"],
    gapFeatureIds: ["F3"],
    noisyTermsByFeature: {}
  }, 2, inputBase);

  check(widen.mode === "widen", "planner: too_few -> widen mode");
  check(widen.featureStateById?.F3?.enabled !== false, "planner: widen enables gap feature");
  check((widen.termsByFeature.F3 || []).length >= 1, "planner: widen expands gap feature terms");

  const balanced = planQueryAdjustment(null, {
    decision: "restart_direction",
    saturatedFeatureIds: ["F1"],
    gapFeatureIds: ["F2"],
    noisyTermsByFeature: { F1: ["over-specific phrase"] }
  }, 1, inputBase);

  check(balanced.mode === "balanced", "planner: balanced mode preserved");
  check(typeof balanced.expression === "string" && balanced.expression.length > 0, "planner: balanced expression built");
}

function testManualEditRemap() {
  const fixture = readFixture("manual_edit_remap_case.json");
  const remapped = deriveQueryPlanFromExpression({
    expression: fixture.editedExpression,
    features: fixture.features,
    featureStateById: fixture.featureStateById,
    fallbackTermsByFeature: fixture.termsByFeature,
    baseQueryPlan: fixture.baseQueryPlan
  });

  check(Array.isArray(remapped?.queryPlan?.groups), "remap: queryPlan exists");
  check(Array.isArray(remapped?.mapping?.unmappedGroups), "remap: mapping metadata exists");
  check(remapped.mapping.unmappedGroups.length >= 1, "remap: unmapped group is preserved");
  check(
    remapped.queryPlan.groups.some((group) => String(group.group_id || "").toUpperCase().startsWith("UNMAPPED")),
    "remap: UNMAPPED group retained in queryPlan"
  );

  const featureIdsFlat = remapped.queryPlan.groups.flatMap((group) => Array.isArray(group.feature_ids) ? group.feature_ids : []);
  check(featureIdsFlat.includes("F1"), "remap: known group mapped to F1");
  check(featureIdsFlat.includes("F2"), "remap: known group mapped to F2");
}

function buildPairEvalRows({ withHardConflict }) {
  return [
    {
      applicationNo: "DOC-A",
      score: 74,
      featureHits: ["F1", "F2"],
      featureJudgments: [
        { featureId: "F1", status: "exact", evidenceText: "A", evidenceSource: "description", confidence: 0.9 },
        { featureId: "F2", status: "exact", evidenceText: "B", evidenceSource: "description", confidence: 0.87 },
        { featureId: "F3", status: "absent", evidenceText: "", evidenceSource: "unknown", confidence: 0.5 }
      ],
      fieldSimilarity: 0.84,
      pairFillValue: 0.82,
      conflictFlags: withHardConflict ? ["contradicting assembly requirement"] : []
    },
    {
      applicationNo: "DOC-B",
      score: 68,
      featureHits: ["F3"],
      featureJudgments: [
        { featureId: "F1", status: "absent", evidenceText: "", evidenceSource: "unknown", confidence: 0.5 },
        { featureId: "F2", status: "absent", evidenceText: "", evidenceSource: "unknown", confidence: 0.5 },
        { featureId: "F3", status: "exact", evidenceText: "C", evidenceSource: "description", confidence: 0.88 }
      ],
      fieldSimilarity: 0.86,
      pairFillValue: 0.86,
      conflictFlags: []
    }
  ];
}

function buildPairFeaturesAndState() {
  const features = [
    { id: "F1", text: "motor drive", query_role: "must" },
    { id: "F2", text: "feedback path", query_role: "must" },
    { id: "F3", text: "thermal compensation", query_role: "should" }
  ];
  const featureStateById = {
    F1: { enabled: true },
    F2: { enabled: true },
    F3: { enabled: true }
  };
  return { features, featureStateById };
}

function testPairTerminationGuard() {
  const { features, featureStateById } = buildPairFeaturesAndState();

  const summaryConflict = summarizeIteration({
    evaluations: buildPairEvalRows({ withHardConflict: true }),
    features,
    featureStateById
  });
  check(summaryConflict.coverage >= 0.99, "pair guard: union coverage can still be full");
  check(summaryConflict.pairHit === false, "pair guard: hard conflict blocks pair termination");

  const summaryClean = summarizeIteration({
    evaluations: buildPairEvalRows({ withHardConflict: false }),
    features,
    featureStateById
  });
  check(summaryClean.pairHit === true, "pair guard: pair termination allowed with low conflict + high plausibility");
  check(
    Number(summaryClean?.pairDecision?.combinePlausibility || 0) >= 0.7,
    "pair guard: pair decision plausibility threshold is met"
  );
}

function testPromptContractNormalizeRepair() {
  const invalidRaw = readFixture("citation_eval_invalid_raw.txt", false);
  const repairedRaw = readFixture("citation_eval_repaired_raw.txt", false);
  const schema = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "modules/k-research/prompts/citation_eval_json/schema.json"), "utf8")
  );

  const invalidParsed = parseJsonFromText(invalidRaw);
  const invalidValidation = validateAgainstSchema(invalidParsed, schema);
  check(invalidValidation.valid === false, "prompt contract: invalid output fails schema validation");

  const repairedParsed = parseJsonFromText(repairedRaw);
  const repairedValidation = validateAgainstSchema(repairedParsed, schema);
  check(repairedValidation.valid === true, "prompt contract: repaired output passes schema validation");

  const normalized = normalizeCitationEval(repairedParsed, ["F1", "F2", "F3"]);
  check(normalized.featureHits.includes("F1") && normalized.featureHits.includes("F2"), "prompt contract: feature_hits normalized");
  check(normalized.missingFeatures.includes("F3"), "prompt contract: missing_features normalized");
  check(normalized.conflictFlags.length >= 1, "prompt contract: conflict flags retained");

  const legacyFeatureExtractRaw = {
    features: [
      { id: "F1", text: "motor drive", core: true },
      { id: "F2", text: "sensor feedback", core: false }
    ]
  };
  const normalizedFeatures = normalizeFeatureExtract(legacyFeatureExtractRaw);
  check(normalizedFeatures.features[0].query_role === "must", "prompt contract: legacy feature_extract -> must role");
  check(typeof normalizedFeatures.features[0].type === "string", "prompt contract: legacy feature_extract -> type added");

  const querySeedRaw = {
    terms_by_feature: [
      { feature_id: "F1", terms: ["motor drive", "drive stage"] },
      { feature_id: "F2", must_terms: ["sensor feedback"], should_terms: ["feedback path"], avoid_terms: ["generic sensor"] }
    ]
  };
  const normalizedSeed = normalizeQuerySeed(querySeedRaw, normalizedFeatures.features);
  check(Array.isArray(normalizedSeed.termsByFeature.F1) && normalizedSeed.termsByFeature.F1.length >= 1, "prompt contract: legacy query_seed terms are accepted");
  check(Array.isArray(normalizedSeed.seedByFeature.F2.must_terms), "prompt contract: query_seed must_terms normalized");
}

function main() {
  process.stdout.write("Running K-Research regression tests...\n");
  testOldSessionMigration();
  testPlannerModes();
  testManualEditRemap();
  testPairTerminationGuard();
  testPromptContractNormalizeRepair();
  process.stdout.write("All K-Research regression tests passed.\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`K-RESEARCH TEST FAILED: ${error.message}\n`);
  process.exitCode = 1;
}
