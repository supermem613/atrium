#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const iterations = Number.parseInt(readFlag("--iterations") ?? "10", 10);
const warmup = Number.parseInt(readFlag("--warmup") ?? "2", 10);
const cwd = readFlag("--cwd") ?? process.cwd();
const command = readFlag("--command") ?? "node-version";

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
  command: "node",
  args: ["dist/server.js"],
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
            maxPreviewBytes: 128,
          },
        });
        const payload = JSON.parse(response.content[0].text);
        if (!payload.ok) {
          throw new Error(`atrium.run failed: ${JSON.stringify(payload.error)}`);
        }
      }),
    },
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await client.close();
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

function readFlag(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}
