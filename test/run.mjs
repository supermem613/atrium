// Cross-platform test runner — expands glob and passes files to node --test.
// Sandboxes HOME/USERPROFILE to a tmpdir so tests cannot read the developer's
// real ~/.atrium/ state, mirroring CI exactly. Set ATRIUM_TEST_REAL_HOME=1 to opt out.
//
// Avoids `node --test` worker subprocesses (their IPC pipe intermittently
// fails on Windows runners with deserialize errors). Spawns one child process
// per file with a TAP reporter and aggregates the per-file summaries.
import { mkdirSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { minimatch } from "minimatch";
import { spawn } from "node:child_process";

// Bounded concurrency for the per-file worker pool. Explicit override via
// ATRIUM_TEST_CONCURRENCY, otherwise cap at the machine's cpu count but never
// exceed 4 so a many-core CI box does not oversubscribe the native addon.
export function resolveConcurrency(env, cpuCount) {
  const override = env?.ATRIUM_TEST_CONCURRENCY;
  if (override !== undefined && override !== "") {
    const parsed = Number.parseInt(override, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return Math.max(1, Math.min(cpuCount || 1, 4));
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

// Run one test file in its own child process with a private sandbox HOME so
// parallel files cannot collide on ~/.atrium state. Resolves rather than
// rejects so one crashed file cannot abort the pool.
function runOneFile(file, baseEnv, sandboxRoot) {
  return new Promise((resolve) => {
    const home = process.env.ATRIUM_TEST_REAL_HOME
      ? null
      : mkdtempSync(join(sandboxRoot, "home-"));
    const env = { ...baseEnv };
    if (home) {
      env.HOME = home;
      env.USERPROFILE = home;
      env.LOCALAPPDATA = join(home, "AppData", "Local");
    }
    const child = spawn("node", ["--import", "tsx", "--test-reporter=tap", file], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk; 
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk; 
    });
    const cleanup = () => {
      if (home) {
        rmSync(home, { recursive: true, force: true });
      }
    };
    child.on("close", (code) => {
      cleanup();
      resolve({ file, stdout, stderr, counts: parseTapCounts(stdout), failed: code !== 0 });
    });
    child.on("error", (err) => {
      cleanup();
      resolve({
        file,
        stdout,
        stderr: `${stderr}${err}`,
        counts: { tests: 0, pass: 0, fail: 0 },
        failed: true,
      });
    });
  });
}

async function main() {
  const pattern = process.argv[2] || "test/**/*.test.ts";
  const files = discoverTestFiles([pattern]);

  if (files.length === 0) {
    console.error(`No test files found matching: ${pattern}`);
    process.exit(1);
  }

  const testTempRoot = join(tmpdir(), "atrium", "tests");
  mkdirSync(testTempRoot, { recursive: true });

  const baseEnv = { ...process.env };
  const concurrency = resolveConcurrency(process.env, cpus().length);
  const workerCount = Math.min(concurrency, files.length);

  const results = new Array(files.length);
  let next = 0;
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < files.length) {
      const index = next++;
      results[index] = await runOneFile(files[index], baseEnv, testTempRoot);
    }
  });
  await Promise.all(workers);

  let totalTests = 0;
  let totalPass = 0;
  let totalFail = 0;
  const failedFiles = [];
  for (const result of results) {
    process.stdout.write(result.stdout);
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    totalTests += result.counts.tests;
    totalPass += result.counts.pass;
    totalFail += result.counts.fail;
    if (result.failed) {
      failedFiles.push(result.file);
      if (result.counts.fail === 0) {
        totalFail += 1;
      }
    }
  }

  console.log(`\n# AGGREGATE: tests ${totalTests} | pass ${totalPass} | fail ${totalFail}`);
  let exitCode = 0;
  if (failedFiles.length) {
    console.log(`# Failed files:\n${failedFiles.map((f) => `#   ${f}`).join("\n")}`);
    exitCode = 1;
  }
  process.exit(exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
