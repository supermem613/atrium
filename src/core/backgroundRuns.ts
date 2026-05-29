import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runExecutable, RunExecutableInput, RunExecutableResult } from "./runner.js";
import { atriumTempPath } from "./tempPaths.js";

type BackgroundRunStatus = "running" | "completed" | "failed";

export interface BackgroundRunHandle {
  ok: true;
  status: "running";
  runId: string;
  resultPath: string;
  startedAt: string;
}

export interface BackgroundRunSnapshot {
  ok: boolean;
  status: BackgroundRunStatus;
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

interface BackgroundRunRecord {
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
}

const runs = new Map<string, BackgroundRunRecord>();

export async function startBackgroundRun(input: RunExecutableInput): Promise<BackgroundRunHandle> {
  const runId = randomUUID();
  const directory = atriumTempPath("background-runs", runId);
  const resultPath = join(directory, "result.json");
  const record: BackgroundRunRecord = {
    runId,
    resultPath,
    startedAt: new Date().toISOString(),
    status: "running",
  };

  await mkdir(directory, { recursive: true });
  runs.set(runId, record);
  await persistSnapshot(record);
  void executeBackgroundRun(record, input);

  return {
    ok: true,
    status: "running",
    runId,
    resultPath,
    startedAt: record.startedAt,
  };
}

export function getBackgroundRun(runId: string): BackgroundRunSnapshot {
  const record = runs.get(runId);
  if (record === undefined) {
    return {
      ok: false,
      status: "failed",
      runId,
      resultPath: "",
      startedAt: "",
      error: {
        code: "UnknownRun",
        message: `No background run found for runId=${runId}.`,
      },
    };
  }

  return toSnapshot(record);
}

async function executeBackgroundRun(record: BackgroundRunRecord, input: RunExecutableInput): Promise<void> {
  try {
    record.result = await runExecutable(input);
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

function toSnapshot(record: BackgroundRunRecord): BackgroundRunSnapshot {
  return {
    ok: record.status !== "failed",
    status: record.status,
    runId: record.runId,
    resultPath: record.resultPath,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    result: record.result,
    error: record.error,
  };
}
