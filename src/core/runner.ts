import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeRunArtifacts, previewBuffer, OutputArtifact } from "./artifacts.js";
import { isDeniedShell, needsWindowsCommandShell } from "./shells.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface RunExecutableInput {
  tool: string;
  args?: string[];
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
  maxPreviewBytes?: number;
}

export interface RunExecutableResult {
  ok: boolean;
  tool: string;
  timingMs: number;
  artifacts?: OutputArtifact;
  stdoutPreview?: string;
  stderrPreview?: string;
  error?: {
    code: string;
    message: string;
  };
}

const defaultTimeoutMs = 120_000;
const defaultPreviewBytes = 0;
const resolvedToolCache = new Map<string, string>();

interface SpawnAttempt {
  tool: string;
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError?: NodeJS.ErrnoException;
}

interface PreparedSpawn {
  command: string;
  args: string[];
  displayTool: string;
}

export async function runExecutable(input: RunExecutableInput): Promise<RunExecutableResult> {
  const args = input.args ?? [];
  const startedAt = Date.now();
  if (input.tool.trim().length === 0) {
    return failedBeforeSpawn(input, args, startedAt, "InvalidTool", "Tool name is required.");
  }

  if (isDeniedShell(input.tool)) {
    return failedBeforeSpawn(
      input,
      args,
      startedAt,
      "DeniedShell",
      `${input.tool} is denied in Atrium.`,
    );
  }

  const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
  let attempt = await spawnOnce(input, input.tool, args, timeoutMs);

  if (attempt.spawnError !== undefined && shouldResolveAfterFailure(input.tool, attempt.spawnError)) {
    const resolved = await resolveTool(input.tool);
    if (resolved !== input.tool) {
      attempt = await spawnOnce(input, resolved, args, timeoutMs);
    }
  }

  if (attempt.spawnError !== undefined) {
    return failedBeforeSpawn(input, args, startedAt, "SpawnError", attempt.spawnError.message);
  }

  const stdout = attempt.stdout;
  const stderr = attempt.stderr;
  const artifacts = await writeRunArtifacts(stdout, stderr);
  const maxPreviewBytes = input.maxPreviewBytes ?? defaultPreviewBytes;

  const result: RunExecutableResult = {
    ok: attempt.exitCode === 0 && !attempt.timedOut,
    tool: input.tool,
    timingMs: Date.now() - startedAt,
    artifacts,
    error: attempt.exitCode === 0 && !attempt.timedOut ? undefined : {
      code: attempt.timedOut ? "Timeout" : "NonZeroExit",
      message: attempt.timedOut ? `Process exceeded timeoutMs=${timeoutMs}.` : `Process exited with code ${String(attempt.exitCode)}.`,
    },
  };

  if (maxPreviewBytes > 0) {
    result.stdoutPreview = previewBuffer(stdout, maxPreviewBytes);
    result.stderrPreview = previewBuffer(stderr, maxPreviewBytes);
  }

  return result;
}

async function spawnOnce(input: RunExecutableInput, tool: string, args: string[], timeoutMs: number): Promise<SpawnAttempt> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const prepared = await prepareSpawn(tool, args);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(prepared.command, prepared.args, {
      cwd: input.cwd,
      shell: needsWindowsCommandShell(prepared.command),
      windowsHide: true,
    });
  } catch (error) {
    return {
      tool: prepared.displayTool,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: null,
      signal: null,
      timedOut: false,
      spawnError: toErrnoException(error),
    };
  }

  let timedOut = false;
  let spawnError: NodeJS.ErrnoException | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);

  child.once("error", (error) => {
    spawnError = toErrnoException(error);
  });
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  if (input.stdin !== undefined) {
    child.stdin.end(input.stdin);
  } else {
    child.stdin.end();
  }

  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  try {
    const [code, closeSignal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
    exitCode = code;
    signal = closeSignal;
  } catch (error) {
    spawnError = toErrnoException(error);
  } finally {
    clearTimeout(timeout);
  }

  return {
    tool: prepared.displayTool,
    stdout: Buffer.concat(stdoutChunks),
    stderr: Buffer.concat(stderrChunks),
    exitCode,
    signal,
    timedOut,
    spawnError,
  };
}

function failedBeforeSpawn(input: RunExecutableInput, _args: string[], startedAt: number, code: string, message: string): RunExecutableResult {
  return {
    ok: false,
    tool: input.tool,
    timingMs: Date.now() - startedAt,
    error: {
      code,
      message,
    },
  };
}

async function resolveTool(tool: string): Promise<string> {
  if (process.platform !== "win32" || tool.includes("\\") || tool.includes("/")) {
    return tool;
  }

  const cached = resolvedToolCache.get(tool.toLowerCase());
  if (cached !== undefined) {
    return cached;
  }

  const whereResult = await runWhere(tool);
  if (whereResult.length === 0) {
    return tool;
  }

  const resolved = await chooseWindowsExecutable(whereResult);
  resolvedToolCache.set(tool.toLowerCase(), resolved);
  return resolved;
}

async function chooseWindowsExecutable(candidates: string[]): Promise<string> {
  const explicitExecutable = candidates.find((candidate) => /\.(cmd|exe|bat)$/iu.test(candidate));
  if (explicitExecutable !== undefined) {
    return explicitExecutable;
  }

  for (const candidate of candidates) {
    for (const extension of [".cmd", ".exe", ".bat"]) {
      const expanded = `${candidate}${extension}`;
      if (await pathExists(expanded)) {
        return expanded;
      }
    }
  }

  return candidates[0];
}

async function prepareSpawn(tool: string, args: string[]): Promise<PreparedSpawn> {
  if (process.platform !== "win32" || !/\.cmd$/iu.test(tool)) {
    return {
      command: tool,
      args,
      displayTool: tool,
    };
  }

  const nodeScript = await readNpmCmdShimScript(tool);
  if (nodeScript === undefined) {
    return {
      command: tool,
      args,
      displayTool: tool,
    };
  }

  return {
    command: process.execPath,
    args: [nodeScript, ...args],
    displayTool: nodeScript,
  };
}

async function readNpmCmdShimScript(cmdPath: string): Promise<string | undefined> {
  let content: string;
  try {
    content = await readFile(cmdPath, "utf8");
  } catch {
    return undefined;
  }

  const match = content.match(/"%_prog%"\s+"%dp0%\\([^"]+)"\s+%\*/u);
  if (match === null) {
    return undefined;
  }

  return join(dirname(cmdPath), match[1]);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function shouldResolveAfterFailure(tool: string, error: NodeJS.ErrnoException): boolean {
  return process.platform === "win32" && error.code === "ENOENT" && !tool.includes("\\") && !tool.includes("/");
}

function toErrnoException(error: unknown): NodeJS.ErrnoException {
  if (error instanceof Error) {
    return error as NodeJS.ErrnoException;
  }

  return new Error(String(error)) as NodeJS.ErrnoException;
}

async function runWhere(tool: string): Promise<string[]> {
  const child = spawn("where.exe", [tool], {
    windowsHide: true,
  });
  const stdoutChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.resume();

  let code: number | null = null;
  try {
    [code] = await once(child, "close") as [number | null, NodeJS.Signals | null];
  } catch {
    return [];
  }

  if (code !== 0) {
    return [];
  }

  return Buffer.concat(stdoutChunks)
    .toString("utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
