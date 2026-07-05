import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RunExecutableInput, RunningExecutable } from "./runner.js";
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
  completion: Promise<void>;
}

const runs = new Map<string, BackgroundRunRecord>();

export interface RunningBackgroundTask {
  startedAt: string;
  result: Promise<unknown>;
}

export async function adoptBackgroundRun(running: RunningExecutable | RunningBackgroundTask): Promise<BackgroundRunHandle> {
  const operationId = createOperationId();
  const directory = atriumTempPath("background-runs", operationId);
  const resultPath = join(directory, "result.json");
  const record = {
    operationId,
    resultPath,
    startedAt: running.startedAt,
    status: "running",
    completion: Promise.resolve(),
  } satisfies BackgroundRunRecord;
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

  const waitMs = Math.min(options.requestSafeWaitMs ?? defaultWaitTimeoutMs, defaultWaitTimeoutMs);
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

  await waitForCompletionOrTimeout(record.completion, waitMs);
  if (record.status !== "running") {
    return toSnapshot(record);
  }

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
  };
}

async function waitForCompletionOrTimeout(completion: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  await Promise.race([
    completion,
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
      timeout.unref();
    }),
  ]);
  if (timeout !== undefined) {
    clearTimeout(timeout);
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

function createOperationId(): string {
  return `atrium-${Date.now().toString(36)}-${randomUUID()}`;
}

function isSafeOperationId(operationId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]*$/u.test(operationId);
}
