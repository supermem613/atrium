import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

type CliPayload = Record<string, unknown>;

let cliLaunchCount = 0;

export const MAX_CLI_LAUNCHES = 2;

export function getCliLaunchCount(): number {
  return cliLaunchCount;
}

export function runCliDebug(args: string[]): CliPayload {
  cliLaunchCount += 1;

  const cliPath = join(process.cwd(), "dist", "cli.js");
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return parseJsonPayload(result.stdout);
}

function parseJsonPayload(stdout: string): CliPayload {
  const trimmed = stdout.trim();
  assert.notEqual(trimmed, "", "expected CLI output");
  return JSON.parse(trimmed) as CliPayload;
}
