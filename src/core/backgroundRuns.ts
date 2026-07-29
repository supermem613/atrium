import { mkdir, readFile, rename, rm, watch, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { OutputValue } from "./artifacts.js";
import { sanitizePerfAttributes } from "./perf.js";
import { RunExecutableInput, RunningExecutable, RunningExecutableProgress } from "./runner.js";
import { atriumTempPath } from "./tempPaths.js";

type BackgroundRunStatus = "running" | "completed" | "failed";

export const defaultLongRunningTimeoutMs = 14_400_000;
export const defaultRequestSafeResponseBudgetMs = 10_000;
export const defaultWaitTimeoutMs = defaultRequestSafeResponseBudgetMs;

// Single resolution point for the handoff and wait budgets. Tests assert the
// resolved default here instead of waiting one out, so this must stay the only
// place server.ts substitutes a missing budget.
export function resolveRequestSafeBudgetMs(override?: number): number {
  return override ?? defaultRequestSafeResponseBudgetMs;
}

export interface OperationNextCheck {
  tool: "atrium.operation-wait";
  arguments: {
    operationId: string;
  };
  callInMs: number;
}

export interface BackgroundRunHandle {
  ok: true;
  status: "running";
  operationId: string;
  resultPath: string;
  startedAt: string;
  nextCheck: OperationNextCheck;
  message: string;
  stdoutBytes?: number;
  stderrBytes?: number;
}

export interface BackgroundRunSnapshot extends Record<string, unknown> {
  ok: boolean;
  status: BackgroundRunStatus;
  operationId: string;
  resultPath: string;
  startedAt: string;
  completedAt?: string;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
  nextCheck?: OperationNextCheck;
  message?: string;
  stdout?: OutputValue;
  stderr?: OutputValue;
  stdoutBytes?: number;
  stderrBytes?: number;
}

export interface BackgroundRunWaitOptions {
  requestSafeWaitMs?: number;
}

export type BackgroundRunWaitResult = BackgroundRunSnapshot | BackgroundRunWaitContinue;

export interface BackgroundRunWaitContinue extends Record<string, unknown> {
  ok: true;
  status: "continue";
  operationId: string;
  resultPath: string;
  startedAt: string;
  nextWaitAfterMs: number;
  mustReissueWait: true;
  nextCheck: OperationNextCheck;
  message: string;
  stdoutBytes?: number;
  stderrBytes?: number;
}

interface BackgroundRunRecord {
  operationId: string;
  resultPath: string;
  startedAt: string;
  completedAt?: string;
  status: BackgroundRunStatus;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
  progress: RunningExecutableProgress;
  syncProgress: () => void;
  completion: Promise<void>;
}

const runs = new Map<string, BackgroundRunRecord>();

export interface RunningBackgroundTask {
  startedAt: string;
  progress?: Readonly<RunningExecutableProgress>;
  result: Promise<unknown>;
}

export async function adoptBackgroundRun(running: RunningExecutable | RunningBackgroundTask): Promise<BackgroundRunHandle> {
  const operationId = createOperationId();
  const directory = atriumTempPath("background-runs", operationId);
  const resultPath = join(directory, "result.json");
  const record: BackgroundRunRecord = {
    operationId,
    resultPath,
    startedAt: running.startedAt,
    status: "running",
    progress: createProgressSnapshot(),
    syncProgress: () => {},
    completion: Promise.resolve(),
  };
  record.progress = isRunningExecutable(running) ? copyProgressSnapshot(running.progress) : createProgressSnapshot();
  record.syncProgress = () => {
    if (!isRunningExecutable(running)) {
      return;
    }

    record.progress = copyProgressSnapshot(running.progress);
  };
  await mkdir(directory, { recursive: true });
  runs.set(operationId, record);
  await persistSnapshot(record);
  record.completion = executeBackgroundRun(record, running);

  return toHandle(record);
}

export async function getBackgroundRun(operationId: string): Promise<BackgroundRunSnapshot> {
  if (!isSafeOperationId(operationId)) {
    return unknownRun(operationId, "", "Operation id must be a single safe path segment.");
  }

  const record = runs.get(operationId);
  if (record === undefined) {
    return readPersistedSnapshot(operationId);
  }

  return toSnapshot(record);
}

export async function waitForBackgroundRun(operationId: string, options: BackgroundRunWaitOptions = {}): Promise<BackgroundRunWaitResult> {
  if (!isSafeOperationId(operationId)) {
    return unknownRun(operationId, "", "Operation id must be a single safe path segment.");
  }

  const waitMs = Math.max(0, Math.min(options.requestSafeWaitMs ?? defaultWaitTimeoutMs, defaultWaitTimeoutMs));
  const record = runs.get(operationId);
  if (record === undefined) {
    const persisted = await readPersistedSnapshot(operationId);
    if (persisted.status === "running") {
      return waitForPersistedSnapshot(operationId, persisted, waitMs);
    }

    return persisted;
  }

  if (record.status !== "running") {
    return toSnapshot(record);
  }

  record.syncProgress();
  const waitForNextEvent = waitForNextBackgroundEvent(record, waitMs);
  await waitForNextEvent;
  if (record.status !== "running") {
    return toSnapshot(record);
  }

  record.syncProgress();
  return toContinue(toSnapshot(record));
}

async function waitForPersistedSnapshot(
  operationId: string,
  initial: BackgroundRunSnapshot,
  waitMs: number,
): Promise<BackgroundRunWaitResult> {
  const signal = AbortSignal.timeout(waitMs);
  try {
    const changes = watch(dirname(initial.resultPath), { signal });
    const current = await readAvailablePersistedSnapshot(operationId);
    if (current.status !== "running") {
      return current;
    }
    for await (const change of changes) {
      if (change.filename !== null && change.filename.toString() !== "result.json") {
        continue;
      }
      const snapshot = await readAvailablePersistedSnapshot(operationId);
      if (snapshot.error?.code === "UnknownRun") {
        continue;
      }
      if (snapshot.status !== "running") {
        return snapshot;
      }
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") {
      throw error;
    }
  }
  const latest = await readAvailablePersistedSnapshot(operationId);
  return latest.status === "running" ? toContinue(latest) : latest;
}

async function readAvailablePersistedSnapshot(operationId: string): Promise<BackgroundRunSnapshot> {
  const deadline = Date.now() + 100;
  let snapshot = await readPersistedSnapshot(operationId);
  while (snapshot.error?.code === "UnknownRun" && Date.now() < deadline) {
    await waitForImmediate();
    snapshot = await readPersistedSnapshot(operationId);
  }
  return snapshot;
}

export function withLongRunningDefault(input: RunExecutableInput): RunExecutableInput {
  return {
    ...input,
    timeoutMs: input.timeoutMs ?? defaultLongRunningTimeoutMs,
  };
}

export function buildBackgroundRunPerfSpans(snapshot: BackgroundRunSnapshot | BackgroundRunWaitContinue): Array<{ name: string; attributes: Record<string, unknown> }> {
  if (snapshot.status === "running" || snapshot.status === "continue") {
    return [{ name: "continue", attributes: sanitizePerfAttributes({ continue: { status: snapshot.status } }) }];
  }

  return [{ name: snapshot.status, attributes: sanitizePerfAttributes({ status: snapshot.status, ok: snapshot.ok }) }];
}

async function executeBackgroundRun(record: BackgroundRunRecord, running: RunningExecutable | RunningBackgroundTask): Promise<void> {
  try {
    record.result = await running.result;
    record.status = "completed";
  } catch (error) {
    record.status = "failed";
    record.error = {
      code: "RunError",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    record.completedAt = new Date().toISOString();
    await persistSnapshot(record);
  }
}

async function persistSnapshot(record: BackgroundRunRecord): Promise<void> {
  record.syncProgress();
  const temporaryPath = `${record.resultPath}.${randomUUID()}.tmp`;
  const previousPath = `${record.resultPath}.previous`;
  await writeFile(temporaryPath, `${JSON.stringify(toSnapshot(record))}\n`, "utf8");
  await rm(previousPath, { force: true });
  let movedPrevious = false;
  try {
    await rename(record.resultPath, previousPath);
    movedPrevious = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  try {
    await rename(temporaryPath, record.resultPath);
  } catch (error) {
    if (movedPrevious) {
      await rename(previousPath, record.resultPath);
    }
    throw error;
  }
  if (movedPrevious) {
    await rm(previousPath, { force: true });
  }
}

function toHandle(record: BackgroundRunRecord): BackgroundRunHandle {
  return {
    ok: true,
    status: "running",
    operationId: record.operationId,
    resultPath: record.resultPath,
    startedAt: record.startedAt,
    nextCheck: nextCheck(record.operationId),
    message: runningMessage(),
    stdoutBytes: record.progress.stdoutBytes,
    stderrBytes: record.progress.stderrBytes,
  };
}

function toSnapshot(record: BackgroundRunRecord): BackgroundRunSnapshot {
  const outputValue = typeof record.result === "object" && record.result !== null
    ? (record.result as { stdout?: OutputValue; stderr?: OutputValue }).stdout
    : undefined;
  const errorValue = typeof record.result === "object" && record.result !== null
    ? (record.result as { stdout?: OutputValue; stderr?: OutputValue }).stderr
    : undefined;
  const snapshot: BackgroundRunSnapshot = {
    ok: record.status !== "failed",
    status: record.status,
    operationId: record.operationId,
    resultPath: record.resultPath,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    result: record.result,
    error: record.error,
  };

  if (record.status === "running") {
    return {
      ...snapshot,
      nextCheck: nextCheck(record.operationId),
      message: runningMessage(),
      stdoutBytes: record.progress.stdoutBytes,
      stderrBytes: record.progress.stderrBytes,
    };
  }

  return {
    ...snapshot,
    stdout: outputValue,
    stderr: errorValue,
  };
}

async function readPersistedSnapshot(operationId: string): Promise<BackgroundRunSnapshot> {
  const resultPath = join(atriumTempPath("background-runs", operationId), "result.json");
  try {
    return await readSnapshotPath(operationId, resultPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      try {
        return await readSnapshotPath(operationId, `${resultPath}.previous`);
      } catch (previousError) {
        return unknownRun(operationId, resultPath, previousError instanceof Error ? previousError.message : String(previousError));
      }
    }
    return unknownRun(operationId, resultPath, error instanceof Error ? error.message : String(error));
  }
}

async function readSnapshotPath(operationId: string, path: string): Promise<BackgroundRunSnapshot> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as PersistedSnapshot;
  const snapshot = normalizePersistedSnapshot(parsed);
  if (snapshot !== undefined) {
    return snapshot;
  }
  return unknownRun(operationId, path, "Persisted background run snapshot is malformed.");
}

type PersistedSnapshot = Partial<BackgroundRunSnapshot> & { runId?: string; progress?: RunningExecutableProgress };

function normalizePersistedSnapshot(value: PersistedSnapshot): BackgroundRunSnapshot | undefined {
  if (!isPersistedSnapshotLike(value)) {
    return undefined;
  }

  // Legacy snapshots persisted only runId before operationId became the single id.
  const operationId = value.operationId ?? value.runId ?? "";
  const stdoutBytes = typeof value.stdoutBytes === "number"
    ? value.stdoutBytes
    : value.progress === undefined
      ? undefined
      : Buffer.byteLength(value.progress.stdout ?? "", "utf8");
  const stderrBytes = typeof value.stderrBytes === "number"
    ? value.stderrBytes
    : value.progress === undefined
      ? undefined
      : Buffer.byteLength(value.progress.stderr ?? "", "utf8");
  const snapshot: BackgroundRunSnapshot = {
    ok: value.ok ?? value.status !== "failed",
    status: value.status,
    operationId,
    resultPath: value.resultPath,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    result: value.result,
    error: value.error,
    ...(typeof stdoutBytes === "number" ? { stdoutBytes } : {}),
    ...(typeof stderrBytes === "number" ? { stderrBytes } : {}),
  };

  if (value.status === "running") {
    return {
      ...snapshot,
      nextCheck: nextCheck(operationId),
      message: runningMessage(),
    };
  }

  return snapshot;
}

function isPersistedSnapshotLike(value: PersistedSnapshot): value is PersistedSnapshot & {
  status: BackgroundRunStatus;
  resultPath: string;
  startedAt: string;
} {
  return typeof value === "object"
    && value !== null
    && (value.status === "running" || value.status === "completed" || value.status === "failed")
    && (typeof value.operationId === "string" || typeof value.runId === "string")
    && typeof value.resultPath === "string"
    && typeof value.startedAt === "string";
}

function nextCheck(operationId: string): OperationNextCheck {
  return {
    tool: "atrium.operation-wait",
    arguments: {
      operationId,
    },
    callInMs: 0,
  };
}

function runningMessage(): string {
  return "Still running. Call atrium.operation-wait with this operationId. Repeat until status is completed or failed.";
}

function toContinue(snapshot: BackgroundRunSnapshot): BackgroundRunWaitContinue {
  return {
    ok: true,
    status: "continue",
    operationId: snapshot.operationId,
    resultPath: snapshot.resultPath,
    startedAt: snapshot.startedAt,
    nextWaitAfterMs: 0,
    mustReissueWait: true,
    nextCheck: nextCheck(snapshot.operationId),
    message: runningMessage(),
    stdoutBytes: snapshot.stdoutBytes ?? 0,
    stderrBytes: snapshot.stderrBytes ?? 0,
  };
}

async function waitForNextBackgroundEvent(record: BackgroundRunRecord, timeoutMs: number): Promise<void> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const deadlinePromise = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  try {
    const event = await Promise.race([
      record.completion.then(() => "completion" as const),
      deadlinePromise,
    ]);

    record.syncProgress();
    if (event === "completion") {
      return;
    }
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}

function unknownRun(operationId: string, resultPath: string, cause: string): BackgroundRunSnapshot {
  return {
    ok: false,
    status: "failed",
    operationId,
    resultPath,
    startedAt: "",
    error: {
      code: "UnknownRun",
      message: `No background run found for operationId=${operationId}: ${cause}`,
    },
  };
}

function isRunningExecutable(running: RunningExecutable | RunningBackgroundTask): running is RunningExecutable {
  return typeof running === "object"
    && running !== null
    && "progress" in running
    && running.progress !== undefined;
}

function createProgressSnapshot(): RunningExecutableProgress {
  return {
    stdout: "",
    stderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
  };
}

function copyProgressSnapshot(progress: Readonly<RunningExecutableProgress>): RunningExecutableProgress {
  return { ...progress };
}

function createOperationId(): string {
  return `atrium-${Date.now().toString(36)}-${randomUUID()}`;
}

function isSafeOperationId(operationId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]*$/u.test(operationId);
}
