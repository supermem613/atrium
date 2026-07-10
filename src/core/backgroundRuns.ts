import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ProgressWaitRegistration, RunExecutableInput, RunningExecutable, RunningExecutableProgress } from "./runner.js";
import { atriumTempPath } from "./tempPaths.js";

type BackgroundRunStatus = "running" | "completed" | "failed";

export const defaultLongRunningTimeoutMs = 3_600_000;
export const defaultWaitTimeoutMs = 45_000;

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
  stdout?: string;
  stderr?: string;
  progress?: RunningExecutableProgress;
}

export interface BackgroundRunSnapshot {
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
  stdout?: string;
  stderr?: string;
  progress?: RunningExecutableProgress;
}

export interface BackgroundRunWaitOptions {
  requestSafeWaitMs?: number;
}

export type BackgroundRunWaitResult = BackgroundRunSnapshot | BackgroundRunWaitContinue;

export interface BackgroundRunWaitContinue {
  ok: true;
  status: "continue";
  operationId: string;
  resultPath: string;
  startedAt: string;
  nextWaitAfterMs: number;
  mustReissueWait: true;
  nextCheck: OperationNextCheck;
  message: string;
  stdout?: string;
  stderr?: string;
  progress?: RunningExecutableProgress;
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
  progressRevision: number;
  lastDeliveredProgressRevision: number;
  waitForProgressUpdate: (lastRevision: number) => ProgressWaitRegistration;
  getProgressRevision: () => number;
  syncProgress: () => void;
  completion: Promise<void>;
}

const runs = new Map<string, BackgroundRunRecord>();

export interface RunningBackgroundTask {
  startedAt: string;
  progress?: Readonly<RunningExecutableProgress>;
  progressRevision?: number;
  waitForProgressUpdate?(lastRevision: number): ProgressWaitRegistration;
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
    progressRevision: isRunningExecutable(running) ? running.progressRevision : 0,
    lastDeliveredProgressRevision: 0,
    waitForProgressUpdate: () => createResolvedProgressWaitRegistration(),
    getProgressRevision: () => 0,
    syncProgress: () => {},
    completion: Promise.resolve(),
  };
  record.progress = isRunningExecutable(running) ? copyProgressSnapshot(running.progress) : createProgressSnapshot();
  record.progressRevision = isRunningExecutable(running) ? running.progressRevision : 0;
  record.waitForProgressUpdate = isRunningExecutable(running) ? running.waitForProgressUpdate.bind(running) : () => createResolvedProgressWaitRegistration();
  record.getProgressRevision = isRunningExecutable(running) ? () => running.progressRevision : () => 0;
  record.syncProgress = () => {
    if (!isRunningExecutable(running)) {
      return;
    }

    record.progress = copyProgressSnapshot(running.progress);
    record.progressRevision = running.progressRevision;
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
      return toContinue(persisted);
    }

    return persisted;
  }

  if (record.status !== "running") {
    return toSnapshot(record);
  }

  record.syncProgress();
  const currentRevision = record.getProgressRevision();
  if (currentRevision > record.lastDeliveredProgressRevision) {
    record.progressRevision = currentRevision;
    record.lastDeliveredProgressRevision = currentRevision;
    return toContinue(toSnapshot(record));
  }

  const waitForNextEvent = waitForNextBackgroundEvent(record, waitMs, record.lastDeliveredProgressRevision);
  await waitForNextEvent;
  if (record.status !== "running") {
    return toSnapshot(record);
  }

  record.syncProgress();
  record.progressRevision = record.getProgressRevision();
  record.lastDeliveredProgressRevision = record.progressRevision;
  return toContinue(toSnapshot(record));
}

export function withLongRunningDefault(input: RunExecutableInput): RunExecutableInput {
  return {
    ...input,
    timeoutMs: input.timeoutMs ?? defaultLongRunningTimeoutMs,
  };
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
  await writeFile(record.resultPath, `${JSON.stringify(toSnapshot(record))}\n`, "utf8");
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
    ...(hasProgress(record.progress) ? { stdout: record.progress.stdout, stderr: record.progress.stderr, progress: copyProgressSnapshot(record.progress) } : {}),
  };
}

function toSnapshot(record: BackgroundRunRecord): BackgroundRunSnapshot {
  const snapshot: BackgroundRunSnapshot = {
    ok: record.status !== "failed",
    status: record.status,
    operationId: record.operationId,
    resultPath: record.resultPath,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    result: record.result,
    error: record.error,
    ...(hasProgress(record.progress) ? { stdout: record.progress.stdout, stderr: record.progress.stderr, progress: copyProgressSnapshot(record.progress) } : {}),
  };

  if (record.status === "running") {
    return {
      ...snapshot,
      nextCheck: nextCheck(record.operationId),
      message: runningMessage(),
    };
  }

  return snapshot;
}

async function readPersistedSnapshot(operationId: string): Promise<BackgroundRunSnapshot> {
  const resultPath = join(atriumTempPath("background-runs", operationId), "result.json");
  try {
    const parsed = JSON.parse(await readFile(resultPath, "utf8")) as PersistedSnapshot;
    const snapshot = normalizePersistedSnapshot(parsed);
    if (snapshot !== undefined) {
      return snapshot;
    }

    return unknownRun(operationId, resultPath, "Persisted background run snapshot is malformed.");
  } catch (error) {
    return unknownRun(operationId, resultPath, error instanceof Error ? error.message : String(error));
  }
}

type PersistedSnapshot = Partial<BackgroundRunSnapshot> & { runId?: string };

function normalizePersistedSnapshot(value: PersistedSnapshot): BackgroundRunSnapshot | undefined {
  if (!isPersistedSnapshotLike(value)) {
    return undefined;
  }

  // Legacy snapshots persisted only runId before operationId became the single id.
  const operationId = value.operationId ?? value.runId ?? "";
  const snapshot: BackgroundRunSnapshot = {
    ok: value.ok ?? value.status !== "failed",
    status: value.status,
    operationId,
    resultPath: value.resultPath,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    result: value.result,
    error: value.error,
    ...(hasProgress(value.progress) ? { stdout: value.progress.stdout, stderr: value.progress.stderr, progress: copyProgressSnapshot(value.progress) } : {}),
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
    ...(hasProgress(snapshot.progress) ? { stdout: snapshot.progress.stdout, stderr: snapshot.progress.stderr, progress: copyProgressSnapshot(snapshot.progress) } : {}),
  };
}

async function waitForNextBackgroundEvent(record: BackgroundRunRecord, timeoutMs: number, lastRevision: number): Promise<void> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const registration = record.waitForProgressUpdate(lastRevision);
  const progressPromise = registration.promise;
  const deadlinePromise = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  try {
    const event = await Promise.race([
      progressPromise.then(() => "progress" as const),
      record.completion.then(() => "completion" as const),
      deadlinePromise,
    ]);

    record.syncProgress();
    if (event === "progress") {
      record.progressRevision = record.getProgressRevision();
      return;
    }

    if (event === "completion") {
      record.progressRevision = record.getProgressRevision();
      return;
    }

    const currentRevision = record.getProgressRevision();
    if (currentRevision > lastRevision) {
      record.progressRevision = currentRevision;
      return;
    }
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
    registration.cancel();
  }

  record.progressRevision = record.getProgressRevision();
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
    && typeof (running as RunningExecutable).progressRevision === "number"
    && typeof (running as RunningExecutable).waitForProgressUpdate === "function";
}

function createProgressSnapshot(): RunningExecutableProgress {
  return {
    stdout: "",
    stderr: "",
  };
}

function copyProgressSnapshot(progress: Readonly<RunningExecutableProgress>): RunningExecutableProgress {
  return {
    stdout: progress.stdout,
    stderr: progress.stderr,
  };
}

function hasProgress(progress: RunningExecutableProgress | undefined): progress is RunningExecutableProgress {
  return progress !== undefined && (progress.stdout.length > 0 || progress.stderr.length > 0);
}

function createResolvedProgressWaitRegistration(): ProgressWaitRegistration {
  return {
    promise: Promise.resolve(),
    cancel() {},
  };
}

function createOperationId(): string {
  return `atrium-${Date.now().toString(36)}-${randomUUID()}`;
}

function isSafeOperationId(operationId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]*$/u.test(operationId);
}
