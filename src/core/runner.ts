import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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

export interface RunningExecutable {
  startedAt: string;
  result: Promise<RunExecutableResult>;
}

export interface StartExecutableRunOptions {
  timeoutMs?: number;
}

export interface RunExecutableResult {
  ok: boolean;
  tool: string;
  timingMs: number;
  metrics: RunExecutableMetrics;
  stdout?: OutputValue;
  stderr?: OutputValue;
  error?: {
    code: string;
    message: string;
  };
}

export interface RunExecutableMetrics {
  childTool: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdinBytes: number;
  argCount: number;
  argHash: string;
  argShape: string[];
  cwdHash?: string;
  semantic?: RunSemanticMetrics;
}

export type RunSemanticMetrics = XraySearchMetrics | GenericCommandMetrics;

export interface XraySearchMetrics {
  kind: "xray.search";
  queryHash: string;
  queryLength: number;
  regex: boolean;
  context: number | null;
  max: number | null;
  globCount: number;
  typeCount: number;
  rootHash?: string;
  scanScopeHash: string;
}

export interface GenericCommandMetrics {
  kind: "generic.command";
  commandHash: string;
  commandLength: number;
}

const defaultTimeoutMs = 60_000;
const defaultInlineOutputMaxBytes = 8192;
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
  const running = await startExecutableRun(input);
  return running.result;
}

export async function startExecutableRun(input: RunExecutableInput, options: StartExecutableRunOptions = {}): Promise<RunningExecutable> {
  const args = await resolveArgValues(input.args ?? [], input.cwd);
  const stdin = await resolveStdinValue(input.stdin, input.cwd);
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  if (input.tool.trim().length === 0) {
    return {
      startedAt: startedAtIso,
      result: Promise.resolve(failedBeforeSpawn(input, args, stdin, startedAt, "InvalidTool", "Tool name is required.")),
    };
  }

  if (isDeniedShell(input.tool)) {
    return {
      startedAt: startedAtIso,
      result: Promise.resolve(failedBeforeSpawn(
        input,
        args,
        stdin,
        startedAt,
        "DeniedShell",
        `${input.tool} is denied in Atrium.`,
      )),
    };
  }

  const timeoutMs = options.timeoutMs ?? input.timeoutMs ?? defaultTimeoutMs;
  const result = (async (): Promise<RunExecutableResult> => {
    let attempt = await spawnOnce(input, input.tool, args, stdin, timeoutMs);

    if (attempt.spawnError !== undefined && shouldResolveAfterFailure(input.tool, attempt.spawnError)) {
      const resolved = await resolveTool(input.tool);
      if (resolved !== input.tool) {
        attempt = await spawnOnce(input, resolved, args, stdin, timeoutMs);
      }
    }

    if (attempt.spawnError !== undefined) {
      return failedBeforeSpawn(input, args, stdin, startedAt, "SpawnError", attempt.spawnError.message);
    }

    const stdout = attempt.stdout;
    const stderr = attempt.stderr;
    const output = await materializeRunOutput(stdout, stderr, defaultInlineOutputMaxBytes);
    const timingMs = Date.now() - startedAt;

    return {
      ok: attempt.exitCode === 0 && !attempt.timedOut,
      tool: input.tool,
      timingMs,
      metrics: buildRunMetrics(input, args, stdin, attempt, timingMs),
      ...output,
      error: attempt.exitCode === 0 && !attempt.timedOut ? undefined : {
        code: attempt.timedOut ? "Timeout" : "NonZeroExit",
        message: attempt.timedOut ? `Process exceeded timeoutMs=${timeoutMs}.` : `Process exited with code ${String(attempt.exitCode)}.`,
      },
    };
  })();

  return {
    startedAt: startedAtIso,
    result,
  };
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

function failedBeforeSpawn(input: RunExecutableInput, args: string[], stdin: string | undefined, startedAt: number, code: string, message: string): RunExecutableResult {
  const timingMs = Date.now() - startedAt;
  return {
    ok: false,
    tool: input.tool,
    timingMs,
    metrics: buildRunMetrics(input, args, stdin, {
      tool: input.tool,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: null,
      signal: null,
      timedOut: false,
    }, timingMs),
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

  const endLocalScriptMatch = content.match(/endLocal\s+&\s+goto\s+#[^\r\n|&]+\s+2>NUL\s+\|\|\s+title\s+%COMSPEC%\s+&\s+"%_prog%"\s+"%dp0%\\([^"]+)"\s+%\*/iu);
  if (endLocalScriptMatch !== null) {
    return join(dirname(cmdPath), endLocalScriptMatch[1]);
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

function buildRunMetrics(
  input: RunExecutableInput,
  args: string[],
  stdin: string | undefined,
  attempt: SpawnAttempt,
  durationMs: number,
): RunExecutableMetrics {
  return {
    childTool: normalizeToolName(input.tool),
    durationMs,
    exitCode: attempt.exitCode,
    signal: attempt.signal,
    timedOut: attempt.timedOut,
    stdoutBytes: attempt.stdout.byteLength,
    stderrBytes: attempt.stderr.byteLength,
    stdinBytes: Buffer.byteLength(stdin ?? "", "utf8"),
    argCount: args.length,
    argHash: shortHash(JSON.stringify(args)),
    argShape: args.map((arg, index) => shapeArg(args, arg, index)),
    ...(input.cwd ? { cwdHash: shortHash(resolve(input.cwd)) } : {}),
    semantic: buildSemanticMetrics(input.tool, args, input.cwd),
  };
}

function buildSemanticMetrics(tool: string, args: string[], cwd: string | undefined): RunSemanticMetrics {
  const toolName = normalizeToolName(tool);
  if (toolName === "xray" && args[0] === "search") {
    return buildXraySearchMetrics(args, cwd);
  }

  return {
    kind: "generic.command",
    commandHash: shortHash(args[0] ?? ""),
    commandLength: args[0]?.length ?? 0,
  };
}

function buildXraySearchMetrics(args: string[], cwd: string | undefined): XraySearchMetrics {
  const parsed = parseXraySearchArgs(args);
  const scope = {
    cwdHash: cwd === undefined ? null : shortHash(resolve(cwd)),
    rootHash: parsed.root === undefined ? null : shortHash(resolve(cwd ?? process.cwd(), parsed.root)),
    globs: parsed.globs.slice().sort(),
    types: parsed.types.slice().sort(),
    regex: parsed.regex,
  };
  return {
    kind: "xray.search",
    queryHash: shortHash(parsed.query ?? ""),
    queryLength: parsed.query?.length ?? 0,
    regex: parsed.regex,
    context: parsed.context,
    max: parsed.max,
    globCount: parsed.globs.length,
    typeCount: parsed.types.length,
    ...(parsed.root === undefined ? {} : { rootHash: shortHash(resolve(cwd ?? process.cwd(), parsed.root)) }),
    scanScopeHash: shortHash(JSON.stringify(scope)),
  };
}

function parseXraySearchArgs(args: string[]): {
  query: string | undefined;
  regex: boolean;
  context: number | null;
  max: number | null;
  globs: string[];
  types: string[];
  root: string | undefined;
} {
  const globs: string[] = [];
  const types: string[] = [];
  let query: string | undefined;
  let context: number | null = null;
  let max: number | null = null;
  let root: string | undefined;
  let expectValueFor: string | null = null;

  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (expectValueFor !== null) {
      if (expectValueFor === "--query") {
        query = arg;
      } else if (expectValueFor === "--glob") {
        globs.push(arg);
      } else if (expectValueFor === "--type") {
        types.push(arg);
      } else if (expectValueFor === "--root") {
        root = arg;
      } else if (expectValueFor === "--context") {
        context = parseNullableInt(arg);
      } else if (expectValueFor === "--max") {
        max = parseNullableInt(arg);
      }
      expectValueFor = null;
      continue;
    }

    if (["--query", "--glob", "--type", "--root", "--context", "--max"].includes(arg)) {
      expectValueFor = arg;
      continue;
    }
    if (arg === "--regex") {
      continue;
    }
    if (!arg.startsWith("-") && query === undefined) {
      query = arg;
    }
  }

  return {
    query,
    regex: args.includes("--regex"),
    context,
    max,
    globs,
    types,
    root,
  };
}

function parseNullableInt(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function shapeArg(args: string[], arg: string, index: number): string {
  if (index === 0) {
    return arg.startsWith("-") ? "flag" : "command";
  }
  if (arg.startsWith("--")) {
    return `flag:${arg}`;
  }
  if (args[index - 1]?.startsWith("-")) {
    return "flag-value";
  }
  return "value";
}

function normalizeToolName(tool: string): string {
  return (tool.split(/[\\/]/u).pop() ?? tool).replace(/\.(cmd|exe|bat|js)$/iu, "");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
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
