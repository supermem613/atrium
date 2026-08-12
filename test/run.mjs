// Cross-platform test runner — expands glob and passes files to node --test.
// Sandboxes HOME/USERPROFILE to a tmpdir so tests cannot read the developer's
// real ~/.atrium/ state, mirroring CI exactly. Set ATRIUM_TEST_REAL_HOME=1 to opt out.
//
// Avoids `node --test` worker subprocesses (their IPC pipe intermittently
// fails on Windows runners with deserialize errors).
//
// Most files share one in-process batch (`--test-isolation=none --test-concurrency=1`)
// so tsx/node startup is paid once. That stays serial inside the batch and does
// not oversubscribe CI cores the way multi-file parallel workers would.
// Files that mock process globals stay in their own child processes.
import { mkdirSync, readdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { minimatch } from "minimatch";
import { spawn } from "node:child_process";

// Collect every pattern argument. A shell that expands `test/**/*.test.ts` before
// node sees it (sh and bash do, cmd.exe does not) hands over one argument per
// matched file, so reading a single argument silently ran one file on Linux CI.
function parseCliArgs(argv) {
  const patterns = [];
  let slowestCount = 5;
  let verbose = false;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--slowest-count") {
      const rawValue = argv[index + 1];
      if (rawValue == null || rawValue.startsWith("-")) {
        throw new Error("Expected a positive integer after --slowest-count");
      }
      const parsedValue = Number.parseInt(rawValue, 10);
      if (!Number.isInteger(parsedValue) || parsedValue < 1) {
        throw new Error(`Expected a positive integer after --slowest-count, got ${rawValue}`);
      }
      slowestCount = parsedValue;
      index += 1;
      continue;
    }
    if (arg === "--verbose") {
      verbose = true;
      continue;
    }
    if (arg.length > 0) {
      patterns.push(arg);
    }
  }

  return {
    patterns: patterns.length ? patterns : ["test/**/*.test.ts"],
    slowestCount,
    verbose,
  };
}

export function resolveTestPatterns(argv) {
  return parseCliArgs(argv).patterns;
}

// Expand one or more glob patterns into a de-duplicated, ordered file list.
export function discoverTestFiles(patterns) {
  const found = new Set();
  for (const pattern of patterns) {
    const baseDir = pattern.split(/[/\\]/)[0] || ".";
    const matches = readdirSync(baseDir, { recursive: true })
      .map((f) => join(baseDir, f).split("\\").join("/"))
      .filter((f) => minimatch(f, pattern));
    for (const match of matches) {
      found.add(match);
    }
  }
  return [...found].sort();
}

// Parse the three TAP summary counts emitted by node:test's tap reporter.
export function parseTapCounts(tapText) {
  const tests = parseInt((tapText.match(/^# tests (\d+)/m) ?? [])[1] ?? "0", 10);
  const pass = parseInt((tapText.match(/^# pass (\d+)/m) ?? [])[1] ?? "0", 10);
  const fail = parseInt((tapText.match(/^# fail (\d+)/m) ?? [])[1] ?? "0", 10);
  return { tests, pass, fail };
}

// Compare per-test timings against the budgets file and return violations.
// A test's budget is the last matching tests[] rule (by file glob and
// nameIncludes substring), otherwise defaultTestMs.
export function evaluateBudgets(timings, budgets) {
  const rules = Array.isArray(budgets.tests) ? budgets.tests : [];
  const violations = [];
  for (const timing of timings) {
    let budgetMs = budgets.defaultTestMs;
    for (const rule of rules) {
      if (rule.file && rule.file !== timing.file && !minimatch(timing.file, rule.file)) {
        continue;
      }
      if (rule.nameIncludes && !timing.name.includes(rule.nameIncludes)) {
        continue;
      }
      budgetMs = Number(rule.maxMs);
    }
    if (Number.isFinite(budgetMs) && timing.ms > budgetMs) {
      violations.push({ file: timing.file, name: timing.name, ms: timing.ms, budgetMs });
    }
  }
  return violations;
}

// Extract per-test durations from TAP. node:test emits a YAML diagnostic block
// after each ok/not ok line. Collect the whole block (through `...`) before
// recording so location/type can appear after duration_ms. Skip type: suite
// rows so nested suites are not double-counted as tests.
export function parseTestTimings(tapText, file) {
  const timings = [];
  let pending = null;

  const flush = () => {
    if (!pending) {
      return;
    }
    if (pending.type === "suite" || pending.ms == null || !pending.name) {
      pending = null;
      return;
    }
    timings.push({
      file: pending.file,
      name: pending.name,
      ms: pending.ms,
      failed: pending.failed,
    });
    pending = null;
  };

  for (const line of tapText.split(/\r?\n/)) {
    const result = line.match(/^\s*(ok|not ok) \d+ - (.+?)(?:\s+#.*)?$/);
    if (result) {
      flush();
      pending = {
        failed: result[1] === "not ok",
        name: result[2].trim(),
        file,
        ms: null,
        type: null,
      };
      continue;
    }
    if (!pending) {
      continue;
    }
    if (/^\s*\.\.\.\s*$/.test(line)) {
      flush();
      continue;
    }
    const location = line.match(/^\s*location:\s*'([^']+)'/);
    if (location) {
      const located = repoRelativeTestPath(location[1]);
      if (located) {
        pending.file = located;
      }
      continue;
    }
    const duration = line.match(/^\s*duration_ms:\s*([\d.]+)/);
    if (duration) {
      pending.ms = Number(duration[1]);
      continue;
    }
    const type = line.match(/^\s*type:\s*'([^']+)'/);
    if (type) {
      pending.type = type[1];
    }
  }
  flush();
  return timings;
}

// Normalize node:test location paths (often absolute, sometimes with :line:col)
// back to the repo-relative test/*.test.ts form used elsewhere in the runner.
export function repoRelativeTestPath(location) {
  const withoutPos = location.replace(/:(\d+):(\d+)$/, "");
  const normalized = withoutPos.split("\\").join("/");
  const marker = "/test/";
  const index = normalized.toLowerCase().lastIndexOf(marker);
  if (index >= 0) {
    return normalized.slice(index + 1);
  }
  if (normalized.startsWith("test/")) {
    return normalized;
  }
  return null;
}

// Files that must keep process isolation under shared-batch isolation=none:
// - process.on / process.stdout mocks leak across files
// - runner/queue spawn races tighten under a long shared event-loop load
const ISOLATED_TEST_FILES = new Set([
  "test/unit/transportDiagnostics.test.ts",
  "test/unit/transportDiagnosticsCause.test.ts",
  "test/unit/runner.test.ts",
  "test/unit/backgroundRunLeanEnvelope.test.ts",
]);

export function partitionTestFiles(files) {
  const shared = [];
  const isolated = [];
  for (const file of files) {
    const normalized = file.split("\\").join("/");
    if (ISOLATED_TEST_FILES.has(normalized)) {
      isolated.push(file);
    } else {
      shared.push(file);
    }
  }
  return { shared, isolated };
}

function buildSandboxEnv(baseEnv, sandboxRoot) {
  if (process.env.ATRIUM_TEST_REAL_HOME) {
    return { env: { ...baseEnv }, home: null };
  }
  const home = mkdtempSync(join(sandboxRoot, "home-"));
  return {
    home,
    env: {
      ...baseEnv,
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: join(home, "AppData", "Local"),
    },
  };
}

function spawnTap(args, env) {
  return new Promise((resolve) => {
    const child = spawn("node", args, { env });
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        failed: code !== 0,
      });
    });
    child.on("error", (err) => {
      resolve({
        stdout,
        stderr: `${stderr}${err}`,
        durationMs: Date.now() - startedAt,
        failed: true,
      });
    });
  });
}

// Shared-batch TAP (isolation=none) does not emit file paths on passing tests.
// Keep one batch row for wall accounting and attach leaf-test timings for budgets
// and slowest-test ranking. Isolated files still get true per-file rows.
function expandSharedBatchResult(files, stdout, stderr, durationMs, failed) {
  const batchLabel = `shared-batch (${files.length} files)`;
  const counts = parseTapCounts(stdout);
  const timings = parseTestTimings(stdout, batchLabel).map((timing) => ({
    ...timing,
    // Prefer a real location when present (failures); otherwise keep the batch label.
    file: timing.file && timing.file !== batchLabel && !timing.file.startsWith("shared-batch")
      ? timing.file
      : batchLabel,
  }));
  return [{
    file: batchLabel,
    stdout: failed ? stdout : "",
    stderr: failed ? stderr : "",
    counts,
    durationMs,
    failed: failed || counts.fail > 0,
    timings,
  }];
}

// Build a machine-readable report object from per-file results.
export function buildReport(fileResults, runMetadata = {}) {
  const summary = {
    files: fileResults.length,
    tests: 0,
    pass: 0,
    fail: 0,
    durationMs: 0,
    wallClockMs: 0,
    concurrency: 1,
  };
  const files = [];
  const slowestFiles = [];
  const slowestTests = [];
  for (const result of fileResults) {
    const tests = result.tests ?? 0;
    const pass = result.pass ?? 0;
    const fail = result.fail ?? 0;
    const durationMs = result.durationMs ?? 0;
    summary.tests += tests;
    summary.pass += pass;
    summary.fail += fail;
    summary.durationMs += durationMs;
    files.push({ file: result.file, tests, pass, fail, durationMs });
    slowestFiles.push({ file: result.file, durationMs });
    for (const timing of Array.isArray(result.timings) ? result.timings : []) {
      slowestTests.push({ file: timing.file ?? result.file, name: timing.name, ms: timing.ms ?? 0 });
    }
  }

  const slowestCount = Number.isInteger(runMetadata?.slowestCount) && runMetadata.slowestCount > 0
    ? runMetadata.slowestCount
    : 5;
  const wallClockMs = Number.isFinite(runMetadata?.wallClockMs) ? Number(runMetadata.wallClockMs) : 0;
  const concurrency = Number.isInteger(runMetadata?.concurrency) && runMetadata.concurrency > 0
    ? runMetadata.concurrency
    : 1;

  summary.wallClockMs = wallClockMs;
  summary.concurrency = concurrency;

  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    summary,
    files,
    slowestFiles: slowestFiles.sort((left, right) => right.durationMs - left.durationMs).slice(0, slowestCount),
    slowestTests: slowestTests.sort((left, right) => right.ms - left.ms).slice(0, slowestCount),
  };
}

// Extract GitHub Actions error annotations from a failing file's TAP output.
// Mirrors the `::error file=,line=,col=,title=::message` format so CI surfaces
// the failure inline on the offending source line.
export function extractGitHubAnnotations(tapText, file) {
  const titleMatch = tapText.match(/^\s*not ok\s+\d+\s+-\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "";
  const messageMatch = tapText.match(/^\s*(?:error|message):\s*'([^']*)'/m);
  const message = messageMatch ? messageMatch[1].trim() : "";
  if (!title && !message) {
    return [];
  }
  // Prefer the repo-relative test path we control for the annotation target so
  // GitHub can link the annotation to the source. The absolute location path
  // node:test reports is only used for its trailing line:col.
  const target = file.split("\\").join("/");
  const locationMatch = tapText.match(/^\s*location:\s*'([^']+)'/m);
  const parts = (locationMatch ? locationMatch[1] : "").match(/:(\d+):(\d+)'?\s*$/);
  const body = message || "test failed";
  if (!parts) {
    return [`::error file=${target},title=${title}::${body}`];
  }
  return [`::error file=${target},line=${parts[1]},col=${parts[2]},title=${title}::${body}`];
}

function loadBudgets(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
      defaultTestMs: Number(parsed.defaultTestMs ?? 120_000),
      slowThresholdMs: Number(parsed.slowThresholdMs ?? 10_000),
      tests: Array.isArray(parsed.tests) ? parsed.tests : [],
    };
  } catch (err) {
    if (err.code === "ENOENT") {
      return { defaultTestMs: 120_000, slowThresholdMs: 10_000, tests: [] };
    }
    throw err;
  }
}

// Run one test file in its own child process with a private sandbox HOME.
async function runOneFile(file, baseEnv, sandboxRoot) {
  const { env, home } = buildSandboxEnv(baseEnv, sandboxRoot);
  try {
    const result = await spawnTap(["--import", "tsx", "--test-reporter=tap", file], env);
    const timings = parseTestTimings(result.stdout, file);
    return {
      file,
      stdout: result.stdout,
      stderr: result.stderr,
      counts: parseTapCounts(result.stdout),
      durationMs: result.durationMs,
      failed: result.failed,
      timings,
    };
  } finally {
    if (home) {
      rmSync(home, { recursive: true, force: true });
    }
  }
}

// One serial in-process batch for files that do not need process isolation.
async function runSharedBatch(files, baseEnv, sandboxRoot) {
  if (files.length === 0) {
    return [];
  }
  if (files.length === 1) {
    return [await runOneFile(files[0], baseEnv, sandboxRoot)];
  }

  const { env, home } = buildSandboxEnv(baseEnv, sandboxRoot);
  try {
    const result = await spawnTap([
      "--import",
      "tsx",
      "--test",
      "--test-reporter=tap",
      "--test-isolation=none",
      "--test-concurrency=1",
      ...files,
    ], env);
    return expandSharedBatchResult(files, result.stdout, result.stderr, result.durationMs, result.failed);
  } finally {
    if (home) {
      rmSync(home, { recursive: true, force: true });
    }
  }
}

async function main() {
  const startedAt = Date.now();
  const { patterns, slowestCount, verbose } = parseCliArgs(process.argv);
  const files = discoverTestFiles(patterns);

  if (files.length === 0) {
    console.error(`No test files found matching: ${patterns.join(" ")}`);
    process.exit(1);
  }

  const testTempRoot = join(tmpdir(), "atrium", "tests");
  mkdirSync(testTempRoot, { recursive: true });

  const baseEnv = { ...process.env };
  const { shared, isolated } = partitionTestFiles(files);

  const results = [];
  results.push(...await runSharedBatch(shared, baseEnv, testTempRoot));
  for (const file of isolated) {
    results.push(await runOneFile(file, baseEnv, testTempRoot));
  }

  let totalTests = 0;
  let totalPass = 0;
  let totalFail = 0;
  const failedFiles = [];
  const timings = [];
  for (const result of results) {
    // A green run stays quiet. Per-file TAP is captured either way and replayed
    // only when the file fails, so a failure is still fully diagnosable without
    // making every passing run scroll past thousands of ok lines.
    if (result.failed || verbose) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr && (result.failed || verbose)) {
      process.stderr.write(result.stderr);
    }
    totalTests += result.counts.tests;
    totalPass += result.counts.pass;
    totalFail += result.counts.fail;
    timings.push(...(result.timings ?? []));
    if (result.failed) {
      failedFiles.push(result.file);
      for (const annotation of extractGitHubAnnotations(result.stdout, result.file)) {
        console.log(annotation);
      }
      if (result.counts.fail === 0) {
        totalFail += 1;
      }
    }
  }

  const wallClockMs = Date.now() - startedAt;
  const report = buildReport(results.map((result) => ({
    file: result.file,
    tests: result.counts.tests,
    pass: result.counts.pass,
    fail: result.counts.fail,
    durationMs: result.durationMs,
    timings: result.timings,
  })), { wallClockMs, concurrency: 1, slowestCount });

  const label = failedFiles.length || totalFail ? "FAIL" : "PASS";
  console.log(
    `# ${label} tests=${totalTests} files=${files.length} pass=${totalPass} fail=${totalFail} durationMs=${Math.max(0, Math.round(wallClockMs))}`,
  );

  // The slowest lists are the whole point of the accounting, so they print on
  // every run. Only the per-file TAP is noise, and that stays behind a failure
  // or --verbose.
  if (report.slowestFiles.length) {
    console.log(`# Slowest files (${report.slowestFiles.length}):`);
    for (const entry of report.slowestFiles) {
      console.log(`#   ${entry.durationMs.toFixed(1)}ms  ${entry.file}`);
    }
  }
  if (report.slowestTests.length) {
    console.log(`# Slowest tests (${report.slowestTests.length}):`);
    for (const entry of report.slowestTests) {
      console.log(`#   ${entry.ms.toFixed(1)}ms  ${entry.file}  ${entry.name}`);
    }
  }

  let exitCode = 0;
  if (failedFiles.length) {
    console.log(`# Failed files:\n${failedFiles.map((f) => `#   ${f}`).join("\n")}`);
    exitCode = 1;
  }

  const budgets = loadBudgets(fileURLToPath(new URL("./perf-budgets.json", import.meta.url)));
  const violations = evaluateBudgets(timings, budgets);
  if (violations.length) {
    console.log(`# Budget violations (${violations.length}):`);
    for (const v of violations) {
      console.log(`#   ${v.ms.toFixed(1)}ms > ${v.budgetMs}ms  ${v.file}  ${v.name}`);
    }
    exitCode = 1;
  }

  const reportDir = fileURLToPath(new URL("../test-results", import.meta.url));
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, "atrium-tests.json"), JSON.stringify(report, null, 2));

  process.exit(exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
