import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { defaultInlineOutputLimitBytes, materializeRunOutput, OutputValue } from "./artifacts.js";
import { defaultExecutionQueue, ExecutionQueue, ExecutionQueueMetrics } from "./executionQueue.js";
import { sanitizePerfAttributes } from "./perf.js";
import { isDeniedShell } from "./shells.js";
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

export interface RunningExecutableProgress {
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
}

export interface RunningExecutable {
  startedAt: string;
  progress: Readonly<RunningExecutableProgress>;
  result: Promise<RunExecutableResult>;
}

export interface StartExecutableRunOptions {
  timeoutMs?: number;
  executionQueue?: ExecutionQueue | false;
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
  queueLimit?: number;
  queueWaitMs?: number;
  queueDepthAtEnqueue?: number;
  queueActiveAtEnqueue?: number;
  queueActiveAtStart?: number;
  semantic?: GenericCommandMetrics;
}

export interface GenericCommandMetrics {
  kind: "generic.command";
  commandHash: string;
  commandLength: number;
}

const defaultTimeoutMs = 60_000;
const defaultProgressOutputLimitBytes = 32_768;
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
  windowsVerbatimArguments?: boolean;
}

interface RunningExecutableProgressTracker {
  snapshot: RunningExecutableProgress;
  recordChunk(stream: "stdout" | "stderr", chunk: Buffer): void;
}

export async function runExecutable(input: RunExecutableInput, options: StartExecutableRunOptions = {}): Promise<RunExecutableResult> {
  const running = await startExecutableRun(input, options);
  return running.result;
}

export async function startExecutableRun(input: RunExecutableInput, options: StartExecutableRunOptions = {}): Promise<RunningExecutable> {
  const args = await resolveArgValues(input.args ?? [], input.cwd);
  const stdin = await resolveStdinValue(input.stdin, input.cwd);
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const progress = createProgressTracker();
  if (input.tool.trim().length === 0) {
    return {
      startedAt: startedAtIso,
      get progress() {
        return progress.snapshot;
      },
      result: Promise.resolve(failedBeforeSpawn(input, args, stdin, startedAt, "InvalidTool", "Tool name is required.")),
    };
  }

  if (isDeniedShell(input.tool)) {
    return {
      startedAt: startedAtIso,
      get progress() {
        return progress.snapshot;
      },
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
    const permit = await acquireExecutionPermit(options.executionQueue);
    try {
      const cachedResolvedTool = getCachedResolvedTool(input.tool);
      let attempt = await spawnOnce(input, cachedResolvedTool ?? input.tool, args, stdin, timeoutMs, progress);

      if (attempt.spawnError !== undefined && cachedResolvedTool === undefined && shouldResolveAfterFailure(input.tool, attempt.spawnError)) {
        const resolved = await resolveTool(input.tool);
        if (resolved !== input.tool) {
          attempt = await spawnOnce(input, resolved, args, stdin, timeoutMs, progress);
        }
      }

      if (attempt.spawnError !== undefined) {
        return failedBeforeSpawn(input, args, stdin, startedAt, "SpawnError", attempt.spawnError.message, permit?.metrics);
      }

      const stdout = attempt.stdout;
      const stderr = attempt.stderr;
      const output = await materializeRunOutput(stdout, stderr, defaultInlineOutputLimitBytes);
      const timingMs = Date.now() - startedAt;

      return {
        ok: attempt.exitCode === 0 && !attempt.timedOut,
        tool: input.tool,
        timingMs,
        metrics: buildRunMetrics(input, args, stdin, attempt, timingMs, permit?.metrics),
        ...output,
        error: attempt.exitCode === 0 && !attempt.timedOut ? undefined : {
          code: attempt.timedOut ? "Timeout" : "NonZeroExit",
          message: attempt.timedOut ? `Process exceeded timeoutMs=${timeoutMs}.` : `Process exited with code ${String(attempt.exitCode)}.`,
        },
      };
    } finally {
      permit?.release();
    }
  })();

  return {
    startedAt: startedAtIso,
    get progress() {
      return progress.snapshot;
    },
    result,
  };
}

async function acquireExecutionPermit(executionQueue: ExecutionQueue | false | undefined): Promise<{ metrics: ExecutionQueueMetrics; release(): void } | undefined> {
  if (executionQueue === false) {
    return undefined;
  }

  return (executionQueue ?? defaultExecutionQueue).acquire();
}

async function spawnOnce(input: RunExecutableInput, tool: string, args: string[], stdin: string | undefined, timeoutMs: number, progress?: RunningExecutableProgressTracker): Promise<SpawnAttempt> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const prepared = await prepareSpawn(tool, withPythonUtf8Mode(tool, args));
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(prepared.command, prepared.args, {
      cwd: input.cwd,
      windowsHide: true,
      windowsVerbatimArguments: prepared.windowsVerbatimArguments,
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
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk);
    if (progress !== undefined) {
      progress.recordChunk("stdout", chunk);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
    if (progress !== undefined) {
      progress.recordChunk("stderr", chunk);
    }
  });

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

function createProgressTracker(): RunningExecutableProgressTracker {
  const snapshot: RunningExecutableProgress = {
    stdout: "",
    stderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
  };

  return {
    get snapshot() {
      return snapshot;
    },
    recordChunk(stream: "stdout" | "stderr", chunk: Buffer): void {
      if (stream === "stdout") {
        snapshot.stdoutBytes += chunk.byteLength;
      } else {
        snapshot.stderrBytes += chunk.byteLength;
      }

      const nextValue = `${snapshot[stream]}${chunk.toString("utf8")}`;
      snapshot[stream] = truncateUtf8Output(nextValue, defaultProgressOutputLimitBytes);
    },
  };
}

function truncateUtf8Output(value: string, limitBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= limitBytes) {
    return value;
  }

  return bytes.subarray(bytes.length - limitBytes).toString("utf8");
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

function failedBeforeSpawn(input: RunExecutableInput, args: string[], stdin: string | undefined, startedAt: number, code: string, message: string, executionQueue?: ExecutionQueueMetrics): RunExecutableResult {
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
    }, timingMs, executionQueue),
    error: {
      code,
      message,
    },
  };
}

function getCachedResolvedTool(tool: string): string | undefined {
  if (process.platform !== "win32" || tool.includes("\\") || tool.includes("/")) {
    return undefined;
  }

  return resolvedToolCache.get(tool.toLowerCase());
}

async function resolveTool(tool: string): Promise<string> {
  if (process.platform !== "win32" || tool.includes("\\") || tool.includes("/")) {
    return tool;
  }

  const cached = getCachedResolvedTool(tool);
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

const PYTHON_INTERPRETER_PATTERN = /^python(?:\d+(?:\.\d+)?)?(?:\.exe)?$/iu;

// Only interpreter options before -c, -m, --, a lone -, or the script path can carry
// -X utf8. Anything after those tokens belongs to the Python program, so a -X utf8 there
// is program data and must not suppress the interpreter flag Atrium injects.
function leadingOptionsRequestUtf8Mode(args: string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-c" || arg === "-m" || arg === "--" || arg === "-" || !arg.startsWith("-")) {
      return false;
    }
    if (arg === "-X") {
      const value = args[index + 1];
      if (typeof value === "string" && /^utf8(?:=|$)/iu.test(value)) {
        return true;
      }
      index += 1;
      continue;
    }
    if (/^-Xutf8(?:=|$)/iu.test(arg)) {
      return true;
    }
  }
  return false;
}

// The child locale defect is Windows-only. There Python defaults its stdio to the legacy
// ANSI code page, so a UTF-8 stdin payload is misdecoded and UTF-8 stdout returns as
// mojibake. -X utf8 forces UTF-8 Mode so byte round-trips match what Atrium writes and
// reads, without relying on any environment variable. Other platforms already default to
// UTF-8, so forcing it there would only override a deliberate caller locale.
function withPythonUtf8Mode(tool: string, args: string[]): string[] {
  if (process.platform !== "win32") {
    return args;
  }
  if (!PYTHON_INTERPRETER_PATTERN.test(basename(tool))) {
    return args;
  }
  if (leadingOptionsRequestUtf8Mode(args)) {
    return args;
  }
  return ["-X", "utf8", ...args];
}

async function prepareSpawn(tool: string, args: string[]): Promise<PreparedSpawn> {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/iu.test(tool)) {
    return {
      command: tool,
      args,
      displayTool: tool,
    };
  }

  const nodeScript = await readNodeCmdShimScript(tool);
  if (nodeScript === undefined) {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", quoteWindowsCommandInvocation(tool, args)],
      displayTool: tool,
      windowsVerbatimArguments: true,
    };
  }

  return {
    command: process.execPath,
    args: [nodeScript, ...args],
    displayTool: nodeScript,
  };
}

function quoteWindowsCommandInvocation(command: string, args: string[]): string {
  return `"${[quoteWindowsCommandPart(command), ...args.map(quoteWindowsCommandArgument)].join(" ")}"`;
}

function quoteWindowsCommandPart(value: string): string {
  return `"${value.replace(/(["^&|<>()])/gu, "^$1")}"`;
}

function quoteWindowsCommandArgument(value: string): string {
  return /[\s"^&|<>()]/u.test(value) || value.length === 0
    ? quoteWindowsCommandPart(value)
    : value;
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
  executionQueue?: ExecutionQueueMetrics,
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
    ...executionQueue,
    semantic: buildSemanticMetrics(input.tool, args, input.cwd),
  };
}

function buildSemanticMetrics(_tool: string, args: string[], _cwd: string | undefined): GenericCommandMetrics {
  const command = args[0] ?? "";
  return {
    kind: "generic.command",
    commandHash: shortHash(command),
    commandLength: command.length,
  };
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

export function buildRunExecutablePerfSpans(result: RunExecutableResult): Array<{ name: string; attributes: Record<string, unknown> }> {
  const metrics = result.metrics;
  return [
    {
      name: "queue",
      attributes: sanitizePerfAttributes({
        queue: {
          waitMs: metrics.queueWaitMs ?? null,
          depthAtEnqueue: metrics.queueDepthAtEnqueue ?? null,
          activeAtEnqueue: metrics.queueActiveAtEnqueue ?? null,
          activeAtStart: metrics.queueActiveAtStart ?? null,
          limit: metrics.queueLimit ?? null,
        },
      }),
    },
    {
      name: "spawn",
      attributes: sanitizePerfAttributes({
        spawn: {
          childTool: metrics.childTool,
          exitCode: metrics.exitCode,
          signal: metrics.signal,
          timedOut: metrics.timedOut,
          durationMs: metrics.durationMs,
        },
      }),
    },
    {
      name: "materialize",
      attributes: sanitizePerfAttributes({
        materialize: {
          stdoutBytes: metrics.stdoutBytes,
          stderrBytes: metrics.stderrBytes,
          stdinBytes: metrics.stdinBytes,
          durationMs: metrics.durationMs,
        },
      }),
    },
    {
      name: "semantic",
      attributes: sanitizePerfAttributes({ semantic: metrics.semantic ?? null }),
    },
  ];
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
