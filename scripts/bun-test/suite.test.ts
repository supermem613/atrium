/**
 * Bun's built-in runner does not fully support node:test describe()
 * (https://github.com/oven-sh/bun/issues/5090) and uses a 5s default timeout.
 * Bare `bun test` must still dogfood cleanly, so this harness is the only
 * bun:test entry and always delegates to the real Node suite runner.
 */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");

function suiteArgs(argv: string[]): string[] {
  const dash = argv.indexOf("--");
  const extra = dash >= 0 ? argv.slice(dash + 1).filter((arg) => arg.length > 0) : [];
  return extra.length > 0 ? extra : ["test/**/*.test.ts"];
}

test(
  "atrium suite via node test/run.mjs",
  () => {
    const result = spawnSync("node", ["test/run.mjs", ...suiteArgs(process.argv)], {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  },
  // Full suite wall clock under load has exceeded 5 minutes on this host.
  { timeout: 900_000 },
);
