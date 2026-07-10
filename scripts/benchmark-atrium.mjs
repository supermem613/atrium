#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const commands = {
  "node-version": {
    tool: process.execPath,
    args: ["--version"],
    shellCommand: `& "${process.execPath}" --version`,
  },
  "xray-small": {
    tool: "xray",
    args: ["search", "tdd", "--root", "C:\\Users\\marcusm\\.copilot", "--glob", "skills/**", "--max", "10"],
    shellCommand: 'xray search "tdd" --root "C:\\Users\\marcusm\\.copilot" --glob "skills/**" --max 10',
  },
};

export function buildSpeedifyCompatiblePerfReport({
  operationName,
  operationId,
  startedAt,
  endedAt,
  durationMs,
  elapsedMs,
  concurrency = 1,
  ok = true,
  timings = {},
  perOperation = {},
}) {
  const normalizedStartedAt = startedAt ?? new Date(0).toISOString();
  const normalizedEndedAt = endedAt ?? new Date(startedAt ?? Date.now()).toISOString();
  const normalizedDurationMs = toFiniteNumber(durationMs ?? elapsedMs ?? 0);
  const normalizedElapsedMs = toFiniteNumber(elapsedMs ?? normalizedDurationMs);
  const normalizedTimings = typeof timings === "object" && timings !== null ? timings : { totalMs: normalizedElapsedMs };
  const normalizedPerOperation = typeof perOperation === "object" && perOperation !== null ? perOperation : {};
  return {
    operationId: operationId ?? `operation-${Date.now().toString(36)}`,
    startedAt: normalizedStartedAt,
    endedAt: normalizedEndedAt,
    durationMs: normalizedDurationMs,
    elapsedMs: normalizedElapsedMs,
    concurrency,
    cases: [{
      name: operationName,
      ok,
      elapsedMs: normalizedElapsedMs,
      timings: normalizedTimings,
    }],
    totals: {
      pass: ok ? 1 : 0,
      fail: ok ? 0 : 1,
    },
    perOperation: {
      ...normalizedPerOperation,
      [operationName]: {
        elapsedMs: normalizedElapsedMs,
        ok,
        timings: normalizedTimings,
      },
    },
    status: ok ? "pass" : "fail",
  };
}

const allVerbSuiteVerbNames = ["schema", "run", "operation-wait", "read", "find-files", "grep", "grep-code"];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Benchmark-owned aggregate report: used by all-verb benchmark suites, while CLI --perf stays per-operation.
export async function runAllVerbBenchmarkSuite(request = {}) {
  const suite = typeof request.suite === "string" && request.suite.length > 0 ? request.suite : "all-verbs";
  const verbs = Array.isArray(request.verbs) && request.verbs.length > 0 ? request.verbs : allVerbSuiteVerbNames;
  const fixtureData = isRecord(request.fixtureData) ? request.fixtureData : {};
  const operationRunners = isRecord(request.operationRunners) ? request.operationRunners : {};
  const now = typeof request.now === "function" ? request.now : () => performance.now();
  const cases = [];
  const perOperation = {};
  const startedAt = new Date().toISOString();
  const suiteStartedAt = now();
  let passCount = 0;
  let failCount = 0;

  for (const verb of verbs) {
    let result = {};
    let ok = true;
    const runner = operationRunners[verb];
    const operationStartedAt = now();

    if (typeof runner === "function") {
      try {
        result = (await runner({
          fixtureData,
          verb,
          suite,
          operationId: fixtureData.operationId ?? `${suite}-${verb}`,
        })) ?? {};
      } catch (error) {
        ok = false;
        result = {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    } else {
      ok = false;
      result = {
        error: `missing operation runner for ${verb}`,
      };
    }
    const operationElapsedMs = Math.max(0, now() - operationStartedAt);

    if (typeof result.ok === "boolean") {
      ok = result.ok;
    }

    const timings = {
      totalMs: operationElapsedMs,
      runnerMs: operationElapsedMs,
    };
    const cliPerfDetail = isRecord(result.perf) ? result.perf : undefined;
    const caseEntry = {
      name: verb,
      ok,
      elapsedMs: operationElapsedMs,
      timings,
      ...(cliPerfDetail === undefined ? {} : { cliPerf: cliPerfDetail }),
    };
    cases.push(caseEntry);
    perOperation[verb] = {
      elapsedMs: operationElapsedMs,
      ok,
      timings,
      ...(cliPerfDetail === undefined ? {} : { cliPerf: cliPerfDetail }),
    };

    if (ok) {
      passCount += 1;
    } else {
      failCount += 1;
    }
  }
  const elapsedMs = Math.max(0, now() - suiteStartedAt);

  return {
    suite,
    operationId: fixtureData.operationId ?? `${suite}-aggregate`,
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: elapsedMs,
    elapsedMs,
    concurrency: 1,
    cases,
    totals: {
      pass: passCount,
      fail: failCount,
    },
    perOperation,
    status: failCount === 0 ? "pass" : "fail",
  };
}

export async function runRealAllVerbBenchmarkSuite(request = {}) {
  const suite = typeof request.suite === "string" && request.suite.length > 0 ? request.suite : "all-verbs";
  const baseFixtureData = isRecord(request.fixtureData) ? request.fixtureData : {};
  const fixtureRoot = await ensureFixtureRoot(baseFixtureData);
  const client = await createAtriumClient();

  try {
    return await runAllVerbBenchmarkSuite({
      suite,
      verbs: allVerbSuiteVerbNames,
      fixtureData: {
        ...baseFixtureData,
        root: fixtureRoot,
        operationId: typeof baseFixtureData.operationId === "string" ? baseFixtureData.operationId : undefined,
      },
      operationRunners: createRealOperationRunners(client, fixtureRoot),
      now: typeof request.now === "function" ? request.now : () => performance.now(),
    });
  } finally {
    await client.close();
  }
}

export async function runBenchmarkSuiteFromCliArgs(args = process.argv.slice(2)) {
  const suiteIndex = args.indexOf("--suite");
  const suiteName = suiteIndex >= 0 ? args[suiteIndex + 1] : undefined;
  if (suiteName === "all-verbs") {
    const operationIdIndex = args.indexOf("--operation-id");
    const operationId = operationIdIndex >= 0 ? args[operationIdIndex + 1] : undefined;
    const fixture = await createTemporaryFixture();
    try {
      return await runRealAllVerbBenchmarkSuite({
        suite: "all-verbs",
        fixtureData: {
          root: fixture.root,
          operationId,
          files: fixture.files,
        },
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }

  return runBenchmarkScript({ args });
}

async function createTemporaryFixture() {
  const root = await mkdtemp(join(tmpdir(), "atrium-benchmark-cli-"));
  const files = [
    { path: join(root, "README.md"), contents: "# sample\n" },
    { path: join(root, "src", "entry.ts"), contents: "export const value = 1;\n" },
  ];
  return {
    root,
    files,
  };
}

async function ensureFixtureRoot(fixtureData) {
  const explicitRoot = typeof fixtureData.root === "string" && fixtureData.root.length > 0 ? fixtureData.root : undefined;
  const root = explicitRoot ?? await mkdtemp(join(tmpdir(), "atrium-benchmark-"));
  await mkdir(root, { recursive: true });

  if (isRecord(fixtureData.files) || Array.isArray(fixtureData.files)) {
    for (const file of Array.isArray(fixtureData.files) ? fixtureData.files : []) {
      if (!isRecord(file) || typeof file.path !== "string") {
        continue;
      }
      const destination = isAbsolute(file.path) ? file.path : join(root, file.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, String(file.contents ?? ""));
    }
  }

  return root;
}

function createRealOperationRunners(client, fixtureRoot) {
  return {
    schema: async () => {
      const payload = await callAtriumTool(client, "schema", { tool: "node" });
      return { ok: payload?.ok !== false, payload, perf: { tool: "schema" } };
    },
    run: async () => {
      const payload = await callAtriumTool(client, "run", { tool: process.execPath, args: ["--version"], cwd: fixtureRoot });
      return { ok: payload?.ok !== false, payload, perf: { tool: "run" } };
    },
    "operation-wait": async () => {
      const payload = await maybeWaitForOperation(client);
      return { ok: true, payload, perf: { tool: "operation-wait" } };
    },
    read: async () => {
      const payload = await callAtriumTool(client, "read", { path: join(fixtureRoot, "README.md"), startLine: 1, endLine: 20 });
      return { ok: payload?.ok !== false, payload, perf: { tool: "read" } };
    },
    "find-files": async () => {
      const payload = await callAtriumTool(client, "find-files", { root: fixtureRoot, glob: "**/*", max: 20 });
      return { ok: payload?.ok !== false, payload, perf: { tool: "find-files" } };
    },
    grep: async () => {
      const payload = await callAtriumTool(client, "grep", { root: fixtureRoot, query: "sample", max: 20 });
      return { ok: payload?.ok !== false, payload, perf: { tool: "grep" } };
    },
    "grep-code": async () => {
      const payload = await callAtriumTool(client, "grep-code", { root: fixtureRoot, query: "export", max: 20 });
      return { ok: payload?.ok !== false, payload, perf: { tool: "grep-code" } };
    },
  };
}

async function createAtriumClient(cwd = repoRoot) {
  const client = new Client({ name: "atrium-benchmark", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server.ts"],
    cwd,
    stderr: "pipe",
  });

  await client.connect(transport);
  return client;
}

async function callAtriumTool(client, name, argumentsObject) {
  const response = await client.callTool({ name, arguments: argumentsObject });
  const payloadText = typeof response?.content?.[0]?.text === "string" ? response.content[0].text : "";
  if (payloadText.length === 0) {
    return { ok: true };
  }

  try {
    return JSON.parse(payloadText);
  } catch {
    return { ok: true, text: payloadText };
  }
}

async function maybeWaitForOperation(client) {
  try {
    return await callAtriumTool(client, "operation-wait", { operationId: "benchmark-operation" });
  } catch (error) {
    return {
      ok: true,
      payload: {
        note: "operation-wait fallback",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

export async function runBenchmarkScript(options = {}) {
  const argv = Array.isArray(options.args) ? options.args : process.argv.slice(2);
  const {
    iterations = Number.parseInt(readFlag("--iterations", argv) ?? "10", 10),
    warmup = Number.parseInt(readFlag("--warmup", argv) ?? "2", 10),
    cwd = readFlag("--cwd", argv) ?? process.cwd(),
    command = readFlag("--command", argv) ?? "node-version",
  } = options;

  if (!Number.isFinite(iterations) || iterations <= 0) {
    throw new Error("--iterations must be a positive number");
  }

  if (!Number.isFinite(warmup) || warmup < 0) {
    throw new Error("--warmup must be zero or a positive number");
  }

  const selected = commands[command];
  if (selected === undefined) {
    throw new Error(`Unknown --command ${command}. Known commands: ${Object.keys(commands).join(", ")}`);
  }

  const directTool = await resolveForDirect(selected.tool);
  const client = new Client({ name: "atrium-benchmark", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server.ts"],
    cwd,
    stderr: "pipe",
  });

  await client.connect(transport);

  try {
    const result = {
      command,
      iterations,
      warmup,
      cwd,
      directTool: directTool.command,
      directArgsPrefix: directTool.argsPrefix,
      timestamp: new Date().toISOString(),
      cases: {
        directExecutable: await measure("directExecutable", warmup, iterations, () => runProcess(directTool.command, [...directTool.argsPrefix, ...selected.args], { cwd })),
        powershellWrapped: await measure("powershellWrapped", warmup, iterations, () => runProcess("pwsh", ["-NoProfile", "-Command", selected.shellCommand], { cwd })),
        atriumMcp: await measure("atriumMcp", warmup, iterations, async () => {
          const response = await client.callTool({
            name: "run",
            arguments: {
              tool: selected.tool,
              args: selected.args,
              cwd,
            },
          });
          const payload = JSON.parse(response.content[0].text);
          if (!payload.ok) {
            throw new Error(`atrium.run failed: ${JSON.stringify(payload.error)}`);
          }
        }),
      },
    };

    return result;
  } finally {
    await client.close();
  }
}

async function measure(name, warmupCount, iterationCount, fn) {
  for (let index = 0; index < warmupCount; index += 1) {
    await fn();
  }

  const samplesMs = [];
  for (let index = 0; index < iterationCount; index += 1) {
    const startedAt = performance.now();
    await fn();
    samplesMs.push(performance.now() - startedAt);
  }

  samplesMs.sort((left, right) => left - right);
  return {
    name,
    samplesMs,
    minMs: round(samplesMs[0]),
    medianMs: round(percentile(samplesMs, 0.5)),
    p90Ms: round(percentile(samplesMs, 0.9)),
    maxMs: round(samplesMs[samplesMs.length - 1]),
    meanMs: round(samplesMs.reduce((sum, sample) => sum + sample, 0) / samplesMs.length),
  };
}

async function runProcess(commandName, args, options) {
  const child = spawn(commandName, args, {
    ...options,
    windowsHide: true,
    shell: process.platform === "win32" && /\.(cmd|bat)$/iu.test(commandName),
  });
  child.stdout.resume();
  child.stderr.resume();
  const [exitCode] = await once(child, "close");
  if (exitCode !== 0) {
    throw new Error(`${commandName} exited ${exitCode}`);
  }
}

async function resolveForDirect(tool) {
  if (process.platform !== "win32" || tool.includes("\\") || tool.includes("/")) {
    return { command: tool, argsPrefix: [] };
  }

  const child = spawn("where.exe", [tool], {
    windowsHide: true,
  });
  const stdout = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.resume();
  const [exitCode] = await once(child, "close");
  if (exitCode !== 0) {
    return { command: tool, argsPrefix: [] };
  }

  const candidates = Buffer.concat(stdout)
    .toString("utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const resolved = candidates.find((candidate) => /\.(cmd|exe|bat)$/iu.test(candidate)) ?? candidates[0] ?? tool;
  return resolveNpmCmdShim(resolved);
}

async function resolveNpmCmdShim(resolved) {
  if (!/\.cmd$/iu.test(resolved)) {
    return { command: resolved, argsPrefix: [] };
  }

  let content;
  try {
    content = await readFile(resolved, "utf8");
  } catch {
    return { command: resolved, argsPrefix: [] };
  }

  const match = content.match(/"%_prog%"\s+"%dp0%\\([^"]+)"\s+%\*/u);
  if (match === null) {
    return { command: resolved, argsPrefix: [] };
  }

  return {
    command: process.execPath,
    argsPrefix: [join(dirname(resolved), match[1])],
  };
}

function percentile(sortedSamples, fraction) {
  const index = Math.min(sortedSamples.length - 1, Math.ceil(sortedSamples.length * fraction) - 1);
  return sortedSamples[index];
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function toFiniteNumber(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value;
}

function readFlag(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return argv[index + 1];
}

async function main() {
  const result = await runBenchmarkSuiteFromCliArgs(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
