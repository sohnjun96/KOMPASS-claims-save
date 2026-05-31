import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const suiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEXT_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".json",
  ".txt",
  ".md",
  ".html",
  ".css",
  ".yml",
  ".yaml",
  ".ts",
  ".tsx",
  ".jsx",
  ".xml",
  ".csv",
  ".svg"
]);

function readFile(relativePath) {
  return fs.readFileSync(path.join(suiteRoot, relativePath), "utf8");
}

function exists(relativePath) {
  return fs.existsSync(path.join(suiteRoot, relativePath));
}

function check(condition, message) {
  assert.ok(condition, message);
  process.stdout.write(`PASS  ${message}\n`);
}

function loadSharedConstants() {
  const code = readFile("suite/shared-constants.js");
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.runInNewContext(code, sandbox, { filename: "suite/shared-constants.js" });
  return sandbox;
}

function includesAll(filePath, patterns) {
  const source = readFile(filePath);
  return patterns.every((pattern) => source.includes(pattern));
}

function normalizeRelativePath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function collectFiles(relativeDir) {
  const absoluteDir = path.join(suiteRoot, relativeDir);
  if (!fs.existsSync(absoluteDir)) return [];

  const entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  const files = [];

  entries.forEach((entry) => {
    const childRelativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(childRelativePath));
      return;
    }
    files.push(normalizeRelativePath(childRelativePath));
  });

  return files;
}

function isEncodingGuardTarget(relativePath) {
  const baseName = path.basename(relativePath);
  if (baseName === ".editorconfig" || baseName === ".gitattributes") return true;
  const extension = path.extname(relativePath).toLowerCase();
  return TEXT_EXTENSIONS.has(extension);
}

function hasUtf8Bom(buffer) {
  return buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
}

function findTextFilesWithBom() {
  const scanRoots = ["modules", "suite", "tests"];
  const topLevelTargets = [".editorconfig", ".gitattributes", "manifest.json", "README.md", "service-worker.js"];
  const candidates = [
    ...scanRoots.flatMap((relativeDir) => collectFiles(relativeDir)),
    ...topLevelTargets.filter((relativePath) => exists(relativePath))
  ];

  const uniqueCandidates = [...new Set(candidates)].filter((relativePath) => isEncodingGuardTarget(relativePath));

  return uniqueCandidates.filter((relativePath) => {
    const buffer = fs.readFileSync(path.join(suiteRoot, relativePath));
    return hasUtf8Bom(buffer);
  });
}

function main() {
  process.stdout.write("Running K-SUITE smoke checks...\n");

  const shared = loadSharedConstants();
  const modules = shared.KSUITE_MODULES;
  const settingsFields = shared.KSUITE_SETTINGS_FIELDS;
  const buildLaunchers = shared.KSUITE_BUILD_MODULE_LAUNCHERS;

  check(Array.isArray(modules) && modules.length >= 4, "module registry is loaded");
  check(Array.isArray(settingsFields) && settingsFields.length >= 2, "settings schema is loaded");
  check(typeof buildLaunchers === "function", "launcher builder is loaded");

  const launchers = buildLaunchers(modules);
  modules.forEach((module) => {
    check(typeof module.id === "string" && module.id.length > 0, `module id exists: ${module.id}`);
    check(["tab", "sidepanel"].includes(module.launchType), `module launchType valid: ${module.id}`);
    check(exists(module.path), `module path exists: ${module.path}`);
    check(Boolean(launchers[module.id]), `module launcher generated: ${module.id}`);
  });

  check(
    includesAll("service-worker.js", [
      "KSUITE_BUILD_MODULE_LAUNCHERS",
      "chrome.tabs.create({",
      "FALLBACK_SIDEPANEL_HOST_URL"
    ]),
    "service worker uses registry launcher + sidepanel fallback tab policy"
  );

  check(
    includesAll("suite/app-nav.js", [
      "KSUITE_BUILD_MODULE_LAUNCHERS",
      "renderNav",
      "chrome.tabs.create({",
      "FALLBACK_SIDEPANEL_HOST_URL"
    ]),
    "app navigation uses registry launcher + auto nav render + sidepanel fallback tab policy"
  );

  check(
    includesAll("suite/popup.js", [
      "getModuleMissingFieldIds(module, state.savedValues)",
      "STORAGE_KEYS.SHARED_API_KEY",
      "createFallbackSidePanelTab"
    ]),
    "popup enforces key gate + single shared key + sidepanel fallback tab policy"
  );

  check(
    includesAll("suite/popup.html", ["shared-constants.js"]),
    "popup loads shared constants"
  );
  check(
    includesAll("modules/k-larc/dashboard.html", [
      "../../suite/shared-constants.js",
      "../../suite/shared-feedback.js"
    ]),
    "K-LARC loads shared constants + feedback"
  );
  check(
    includesAll("modules/k-query/src/sidebar/sidepanel.html", [
      "../../../../suite/shared-constants.js",
      "../../../../suite/shared-feedback.js"
    ]),
    "K-Query loads shared constants + feedback"
  );
  check(
    includesAll("modules/k-scan/sidepanel.html", [
      "../../suite/shared-constants.js",
      "../../suite/shared-feedback.js"
    ]),
    "K-SCAN loads shared constants + feedback"
  );
  check(
    includesAll("modules/k-research/sidepanel.html", [
      "../../suite/shared-constants.js",
      "../../suite/shared-feedback.js"
    ]),
    "K-Research loads shared constants + feedback"
  );

  const bomFiles = findTextFilesWithBom();
  const bomHint = bomFiles.slice(0, 5).join(", ");
  check(
    bomFiles.length === 0,
    bomFiles.length === 0
      ? "text files are UTF-8 without BOM"
      : `text files are UTF-8 without BOM (remove BOM: ${bomHint})`
  );

  const kResearchTestPath = path.join(suiteRoot, "tests", "kresearch", "run-kresearch-tests.mjs");
  const kResearchResult = spawnSync(process.execPath, [kResearchTestPath], {
    cwd: suiteRoot,
    encoding: "utf8"
  });
  if (kResearchResult.stdout) {
    process.stdout.write(kResearchResult.stdout);
  }
  if (kResearchResult.stderr) {
    process.stderr.write(kResearchResult.stderr);
  }
  check(kResearchResult.status === 0, "K-Research regression tests pass");

  process.stdout.write("All smoke checks passed.\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`SMOKE CHECK FAILED: ${error.message}\n`);
  process.exitCode = 1;
}
