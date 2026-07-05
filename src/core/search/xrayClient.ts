import { readFile } from "node:fs/promises";
import type { OutputValue } from "../artifacts.js";
import { runExecutable, type RunExecutableInput, type RunExecutableResult, type StartExecutableRunOptions } from "../runner.js";
import type { XrayEnvelope, XrayRunOptions, XraySearchClientLike } from "./types.js";

export type ExecutableRunner = (input: RunExecutableInput, options?: StartExecutableRunOptions) => Promise<RunExecutableResult>;

// Grace the runner's hard-kill deadline must add on top of xray's own --timeoutMs.
// xray reaches its --timeoutMs, then flushes partial results plus a timeout warning.
// If the runner kill fires at the same instant it truncates that flush and turns a
// graceful partial result into a hard "Process exceeded timeoutMs" failure. This
// mirrors requestTimeoutForRun in mcpDebug, which grants the outer wait the same margin.
const RUNNER_KILL_GRACE_MS = 1_000;

export function buildXrayArgs(options: XrayRunOptions): string[] {
  const args: string[] = [options.command];
  if (options.query !== undefined) {
    if (options.query.startsWith("-")) {
      args.push("--query", options.query);
    } else {
      args.push(options.query);
    }
  }
  args.push("--root", options.root);
  if (options.regex === true) {
    args.push("--regex");
  }
  if (options.all === true) {
    args.push("--all");
  }
  if (options.glob !== undefined) {
    args.push("--glob", options.glob);
  }
  if (options.exclude !== undefined) {
    args.push("--glob", `!${options.exclude}`);
  }
  if (options.max !== undefined) {
    args.push("--max", String(options.max));
  }
  if (options.timeoutMs !== undefined) {
    args.push("--timeoutMs", String(options.timeoutMs));
  }
  return args;
}

async function readOutputValue(value: OutputValue | undefined): Promise<string> {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return readFile(value.file, "utf8");
}

export function createXrayClient(runner: ExecutableRunner = runExecutable): XraySearchClientLike {
  return {
    async run(options: XrayRunOptions): Promise<XrayEnvelope> {
      const result = await runner(
        {
          tool: "xray",
          args: buildXrayArgs(options),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs + RUNNER_KILL_GRACE_MS } : {}),
        },
        { executionQueue: false },
      );
      const stdout = await readOutputValue(result.stdout);
      let envelope: XrayEnvelope;
      try {
        envelope = JSON.parse(stdout) as XrayEnvelope;
      } catch {
        const detail = result.error?.message ?? "xray returned no parseable JSON output";
        throw new Error(`xray ${options.command} failed: ${detail}`);
      }
      if (!envelope.ok) {
        const reason = envelope.error ?? "unknown error";
        const hint = envelope.hint !== undefined ? ` (${envelope.hint})` : "";
        throw new Error(`xray ${options.command} failed: ${reason}${hint}`);
      }
      return envelope;
    },
  };
}
