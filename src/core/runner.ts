import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { materializeRunOutput, OutputValue } from "./artifacts.js";
import { isDeniedShell, needsWindowsCommandShell } from "./shells.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type FileValue = {
  file: string;
};

export type ArgValue = string | FileValue;
export type StdinValue = string | FileValue;

export interface RunExecutableInput {
  tool: string;
  args?: ArgValue[];
  cwd?: string;
  stdin?: StdinValue;
  timeoutMs?: number;
}

export interface RunExecutableResult {
  ok: boolean;
  tool: string;
  timingMs: number;
  stdout?: OutputValue;
  stderr?: OutputValue;
  error?: {
    code: string;
    message: string;
  };
}

const defaultTimeoutMs = 120_000;
const defaultInlineOutputMaxBytes = 128;
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
  const args = await resolveArgValues(input.args ?? [], input.cwd);
  const stdin = await resolveStdinValue(input.stdin, input.cwd);
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
  let attempt = await spawnOnce(input, input.tool, args, stdin, timeoutMs);

  if (attempt.spawnError !== undefined && shouldResolveAfterFailure(input.tool, attempt.spawnError)) {
    const resolved = await resolveTool(input.tool);
    if (resolved !== input.tool) {
      attempt = await spawnOnce(input, resolved, args, stdin, timeoutMs);
    }
  }

  if (attempt.spawnError !== undefined) {
    return failedBeforeSpawn(input, args, startedAt, "SpawnError", attempt.spawnError.message);
  }

  const stdout = attempt.stdout;
  const stderr = attempt.stderr;
  const output = await materializeRunOutput(stdout, stderr, defaultInlineOutputMaxBytes);

  const result: RunExecutableResult = {
    ok: attempt.exitCode === 0 && !attempt.timedOut,
    tool: input.tool,
    timingMs: Date.now() - startedAt,
    ...output,
    error: attempt.exitCode === 0 && !attempt.timedOut ? undefined : {
      code: attempt.timedOut ? "Timeout" : "NonZeroExit",
      message: attempt.timedOut ? `Process exceeded timeoutMs=${timeoutMs}.` : `Process exited with code ${String(attempt.exitCode)}.`,
    },
  };

  return result;
}

async function spawnOnce(input: RunExecutableInput, tool: string, args: string[], stdin: string | undefined, timeoutMs: number): Promise<SpawnAttempt> {
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

  if (stdin !== undefined) {
    child.stdin.end(stdin);
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

async function resolveArgValues(args: ArgValue[], cwd: string | undefined): Promise<string[]> {
  return Promise.all(args.map((arg) => resolveArgValue(arg, cwd)));
}

async function resolveArgValue(arg: ArgValue, cwd: string | undefined): Promise<string> {
  if (typeof arg === "string") {
    return arg;
  }

  return readTextFile(arg.file, cwd);
}

async function resolveStdinValue(stdin: StdinValue | undefined, cwd: string | undefined): Promise<string | undefined> {
  if (stdin === undefined || typeof stdin === "string") {
    return stdin;
  }

  return readTextFile(stdin.file, cwd);
}

async function readTextFile(file: string, cwd: string | undefined): Promise<string> {
  const resolved = isAbsolute(file) ? file : resolve(cwd ?? process.cwd(), file);
  return readFile(resolved, "utf8");
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

  const nodeScript = await readNodeCmdShimScript(tool);
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

async function readNodeCmdShimScript(cmdPath: string): Promise<string | undefined> {
  let content: string;
  try {
    content = await readFile(cmdPath, "utf8");
  } catch {
    return undefined;
  }

  const directScriptMatch = content.match(/"%_prog%"\s+"%dp0%\\([^"]+)"\s+%\*/u);
  if (directScriptMatch !== null) {
    return join(dirname(cmdPath), directScriptMatch[1]);
  }

  const variableInvocationMatch = content.match(/"%[A-Z0-9_]+%"\s+"%([A-Z0-9_]+)%"\s+%\*/iu);
  if (variableInvocationMatch !== null) {
    const variableAssignmentMatch = new RegExp(`SET\\s+"${variableInvocationMatch[1]}=%~dp0\\\\([^"]+)"`, "iu").exec(content);
    if (variableAssignmentMatch !== null) {
      return join(dirname(cmdPath), variableAssignmentMatch[1]);
    }
  }

  return undefined;
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
