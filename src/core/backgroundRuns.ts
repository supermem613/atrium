import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RunExecutableInput, RunExecutableResult, RunningExecutable, StartExecutableRunOptions, startExecutableRun } from "./runner.js";
import { atriumTempPath } from "./tempPaths.js";

type BackgroundRunStatus = "running" | "completed" | "failed";

export const defaultLongRunningTimeoutMs = 3_600_000;
export const defaultWaitTimeoutMs = 45_000;

export interface BackgroundRunHandle {
  ok: true;
  status: "running";
  operationId: string;
  runId: string;
  resultPath: string;
  startedAt: string;
  wait: BackgroundRunWaitInstruction;
}

export interface BackgroundRunSnapshot {
  ok: boolean;
  status: BackgroundRunStatus;
  operationId: string;
  runId: string;
  resultPath: string;
  startedAt: string;
  completedAt?: string;
  result?: RunExecutableResult;
  error?: {
    code: string;
    message: string;
  };
}

export interface BackgroundRunWaitInstruction {
  tool: "atrium.wait";
  arguments: {
    operationId: string;
    follow: boolean;
  };
  maxWaitMs: number;
}

export interface BackgroundRunWaitOptions {
  maxWaitMs?: number;
  follow?: boolean;
  maxTotalWaitMs?: number;
  requestSafeWaitMs?: number;
}

export type BackgroundRunWaitResult = BackgroundRunSnapshot | BackgroundRunWaitContinue;

export interface BackgroundRunWaitContinue {
  ok: true;
  status: "continue";
  operationId: string;
  runId: string;
  resultPath: string;
  startedAt: string;
  nextWaitAfterMs: number;
  mustReissueWait: true;
  message: string;
  wait: BackgroundRunWaitInstruction;
}

interface BackgroundRunRecord {
  operationId: string;
  runId: string;
  resultPath: string;
  startedAt: string;
  completedAt?: string;
  status: BackgroundRunStatus;
  result?: RunExecutableResult;
  error?: {
    code: string;
    message: string;
  };
  completion: Promise<void>;
}

const runs = new Map<string, BackgroundRunRecord>();

export async function startBackgroundRun(input: RunExecutableInput, options: StartExecutableRunOptions = {}): Promise<BackgroundRunHandle> {
  const running = await startExecutableRun(withLongRunningDefault(input), options);
  return adoptBackgroundRun(running);
}

export async function adoptBackgroundRun(running: RunningExecutable): Promise<BackgroundRunHandle> {
  const runId = createOperationId();
  const directory = atriumTempPath("background-runs", runId);
  const resultPath = join(directory, "result.json");
  const record = {
    operationId: runId,
    runId,
    resultPath,
    startedAt: running.startedAt,
    status: "running",
    completion: Promise.resolve(),
  } satisfies BackgroundRunRecord;
  await mkdir(directory, { recursive: true });
  runs.set(runId, record);
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

  // A single MCP wait call must never block past the request-safe window. The MCP
  // client enforces a request deadline (about 60s), so a wait that holds the request
  // longer surfaces to the caller as transport error -32001 instead of a structured
  // result. follow and maxTotalWaitMs may ask for a longer budget, but the total a
  // single call can block is clamped to requestSafeWaitMs so the contract holds for
  // every caller-supplied combination. Callers reissue bounded waits to keep going.
  const requestSafeWaitMs = Math.min(options.requestSafeWaitMs ?? defaultWaitTimeoutMs, defaultWaitTimeoutMs);
  const cappedWaitMs = Math.min(options.maxWaitMs ?? requestSafeWaitMs, requestSafeWaitMs);
  const requestedTotalWaitMs = Math.max(cappedWaitMs, options.maxTotalWaitMs ?? cappedWaitMs);
  const maxTotalWaitMs = Math.min(requestedTotalWaitMs, requestSafeWaitMs);
  const deadline = Date.now() + maxTotalWaitMs;
  let remainingWaitMs = cappedWaitMs;
  const record = runs.get(operationId);
  if (record === undefined) {
    const persisted = await readPersistedSnapshot(operationId);
    if (persisted.status === "running") {
      return toContinue(persisted, options.follow ?? false);
    }

    return persisted;
  }

  if (record.status !== "running") {
    return toSnapshot(record);
  }

  do {
    await waitForCompletionOrTimeout(record.completion, remainingWaitMs);
    if (record.status !== "running") {
      return toSnapshot(record);
    }

    if (options.follow !== true) {
      return toContinue(toSnapshot(record), false);
    }

    remainingWaitMs = Math.min(cappedWaitMs, deadline - Date.now());
  } while (remainingWaitMs > 0);

  return toContinue(toSnapshot(record), true);
}

export function withLongRunningDefault(input: RunExecutableInput): RunExecutableInput {
  return {
    ...input,
    timeoutMs: input.timeoutMs ?? defaultLongRunningTimeoutMs,
  };
}

async function executeBackgroundRun(record: BackgroundRunRecord, running: RunningExecutable): Promise<void> {
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
    runId: record.runId,
    resultPath: record.resultPath,
    startedAt: record.startedAt,
    wait: waitInstruction(record.operationId),
  };
}

function toSnapshot(record: BackgroundRunRecord): BackgroundRunSnapshot {
  return {
    ok: record.status !== "failed",
    status: record.status,
    operationId: record.operationId,
    runId: record.runId,
    resultPath: record.resultPath,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    result: record.result,
    error: record.error,
  };
}

async function readPersistedSnapshot(operationId: string): Promise<BackgroundRunSnapshot> {
  const resultPath = join(atriumTempPath("background-runs", operationId), "result.json");
  try {
    const parsed = JSON.parse(await readFile(resultPath, "utf8")) as Partial<BackgroundRunSnapshot>;
    const snapshot = normalizePersistedSnapshot(parsed);
    if (snapshot !== undefined) {
      return snapshot;
    }

    return unknownRun(operationId, resultPath, "Persisted background run snapshot is malformed.");
  } catch (error) {
    return unknownRun(operationId, resultPath, error instanceof Error ? error.message : String(error));
  }
}

function normalizePersistedSnapshot(value: Partial<BackgroundRunSnapshot>): BackgroundRunSnapshot | undefined {
  if (!isPersistedSnapshotLike(value)) {
    return undefined;
  }

  return {
    ok: value.ok ?? value.status !== "failed",
    status: value.status,
    operationId: value.operationId ?? value.runId,
    runId: value.runId,
    resultPath: value.resultPath,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    result: value.result,
    error: value.error,
  };
}

function isPersistedSnapshotLike(value: Partial<BackgroundRunSnapshot>): value is Omit<BackgroundRunSnapshot, "operationId"> & { operationId?: string } {
  return typeof value === "object"
    && value !== null
    && (value.status === "running" || value.status === "completed" || value.status === "failed")
    && typeof value.runId === "string"
    && typeof value.resultPath === "string"
    && typeof value.startedAt === "string";
}

function toContinue(snapshot: BackgroundRunSnapshot, follow: boolean): BackgroundRunWaitContinue {
  return {
    ok: true,
    status: "continue",
    operationId: snapshot.operationId,
    runId: snapshot.runId,
    resultPath: snapshot.resultPath,
    startedAt: snapshot.startedAt,
    nextWaitAfterMs: 0,
    mustReissueWait: true,
    message: "Operation is still running. Reissue atrium.wait with this operationId until status is completed or failed.",
    wait: waitInstruction(snapshot.operationId, follow),
  };
}

function waitInstruction(operationId: string, follow = false): BackgroundRunWaitInstruction {
  return {
    tool: "atrium.wait",
    arguments: {
      operationId,
      follow,
    },
    maxWaitMs: defaultWaitTimeoutMs,
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
    runId: operationId,
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
