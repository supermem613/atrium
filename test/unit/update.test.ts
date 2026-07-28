import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { runSelfUpdate, gitPullMadeNoChanges } from "../../src/commands/update.js";

function recordCall(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

describe("update", () => {
  it("skips install and build when pull keeps the same revision", async () => {
    const calls: string[] = [];
    const result = await runSelfUpdate({
      repoRoot: "repo",
      isGitRepo: () => true,
      execCommand: async (command, args) => {
        calls.push(recordCall(command, args));
        if (command === "git" && args.join(" ") === "rev-parse HEAD") {
          return { stdout: "abc123\n", stderr: "" };
        }
        return { stdout: "Already up to date.\n", stderr: "" };
      },
    });
    assert.deepEqual(calls, ["git rev-parse HEAD", "sd status", "git pull --ff-only", "git rev-parse HEAD"]);
    assert.equal(result.alreadyUpToDate, true);
    assert.equal(result.installed, false);
    assert.equal(result.built, false);
  });

  it("installs and builds when pull changes the revision", async () => {
    const revisions = ["abc123\n", "def456\n"];
    const calls: string[] = [];
    const result = await runSelfUpdate({
      repoRoot: "repo",
      isGitRepo: () => true,
      execCommand: async (command, args) => {
        calls.push(recordCall(command, args));
        if (command === "git" && args.join(" ") === "rev-parse HEAD") {
          return { stdout: revisions.shift() ?? "def456\n", stderr: "" };
        }
        return { stdout: "Fast-forward\n", stderr: "" };
      },
    });
    assert.deepEqual(calls, [
      "git rev-parse HEAD",
      "sd status",
      "git pull --ff-only",
      "git rev-parse HEAD",
      "npm install --no-audit --no-fund",
      "npm run build",
    ]);
    assert.equal(result.installed, true);
    assert.equal(result.built, true);
  });

  it("uses sd pull in a soda-managed repo and installs after worktree updates", async () => {
    const revisions = ["abc123\n", "def456\n"];
    const calls: string[] = [];
    const result = await runSelfUpdate({
      repoRoot: "repo",
      isGitRepo: () => true,
      execCommand: async (command, args) => {
        calls.push(recordCall(command, args));
        if (command === "git" && args.join(" ") === "rev-parse HEAD") {
          return { stdout: revisions.shift() ?? "def456\n", stderr: "" };
        }
        if (command === "sd" && args.join(" ") === "status") {
          return { stdout: JSON.stringify({ ok: true, data: { summary: { initialized: true } } }), stderr: "" };
        }
        if (command === "sd" && args.join(" ") === "pull") {
          return {
            stdout: JSON.stringify({ ok: true, data: [{ status: "up-to-date", worktreeUpdated: false }, { status: "pulled", worktreeUpdated: true }] }),
            stderr: "",
          };
        }
        return { stdout: "ok\n", stderr: "" };
      },
    });

    assert.deepEqual(calls, [
      "git rev-parse HEAD",
      "sd status",
      "sd pull",
      "git rev-parse HEAD",
      "npm install --no-audit --no-fund",
      "npm run build",
    ]);
    assert.equal(calls.includes("git pull --ff-only"), false);
    assert.equal(result.pulled, true);
    assert.equal(result.installed, true);
    assert.equal(result.built, true);
  });

  it("skips install and build when sd pull does not update the worktree", async () => {
    const revisions = ["abc123\n", "def456\n"];
    const calls: string[] = [];
    const result = await runSelfUpdate({
      repoRoot: "repo",
      isGitRepo: () => true,
      execCommand: async (command, args) => {
        calls.push(recordCall(command, args));
        if (command === "git" && args.join(" ") === "rev-parse HEAD") {
          return { stdout: revisions.shift() ?? "def456\n", stderr: "" };
        }
        if (command === "sd" && args.join(" ") === "status") {
          return { stdout: JSON.stringify({ ok: true, data: { summary: { initialized: true } } }), stderr: "" };
        }
        if (command === "sd" && args.join(" ") === "pull") {
          return { stdout: JSON.stringify({ ok: true, data: [{ status: "up-to-date", worktreeUpdated: false }] }), stderr: "" };
        }
        return { stdout: "ok\n", stderr: "" };
      },
    });

    assert.deepEqual(calls, ["git rev-parse HEAD", "sd status", "sd pull", "git rev-parse HEAD"]);
    assert.equal(result.alreadyUpToDate, true);
    assert.equal(result.installed, false);
    assert.equal(result.built, false);
  });

  it("falls back to git pull when sd status is unavailable or not initialized", async () => {
    const scenarios: Array<{
      name: string;
      sdStatus: () => Promise<{ stdout: string; stderr: string }>;
    }> = [
      {
        name: "ok false",
        sdStatus: async () => ({ stdout: JSON.stringify({ ok: false, error: "not initialized" }), stderr: "" }),
      },
      {
        name: "unparseable stdout",
        sdStatus: async () => ({ stdout: "not json", stderr: "" }),
      },
      {
        name: "sd not installed",
        sdStatus: async () => {
          throw new Error("spawn sd ENOENT");
        },
      },
    ];

    for (const scenario of scenarios) {
      const calls: string[] = [];
      const result = await runSelfUpdate({
        repoRoot: "repo",
        isGitRepo: () => true,
        execCommand: async (command, args) => {
          calls.push(recordCall(command, args));
          if (command === "git" && args.join(" ") === "rev-parse HEAD") {
            return { stdout: "abc123\n", stderr: "" };
          }
          if (command === "sd" && args.join(" ") === "status") {
            return scenario.sdStatus();
          }
          return { stdout: "Already up to date.\n", stderr: "" };
        },
      });

      assert.equal(calls.includes("git pull --ff-only"), true, scenario.name);
      assert.equal(result.alreadyUpToDate, true, scenario.name);
    }
  });

  it("surfaces sd pull envelope errors without installing or building", async () => {
    const calls: string[] = [];
    await assert.rejects(
      () =>
        runSelfUpdate({
          repoRoot: "repo",
          isGitRepo: () => true,
          execCommand: async (command, args) => {
            calls.push(recordCall(command, args));
            if (command === "git" && args.join(" ") === "rev-parse HEAD") {
              return { stdout: "abc123\n", stderr: "" };
            }
            if (command === "sd" && args.join(" ") === "status") {
              return { stdout: JSON.stringify({ ok: true, data: { summary: { initialized: true } } }), stderr: "" };
            }
            if (command === "sd" && args.join(" ") === "pull") {
              return { stdout: JSON.stringify({ ok: false, error: "stream is blocked" }), stderr: "" };
            }
            return { stdout: "ok\n", stderr: "" };
          },
        }),
      /stream is blocked/,
    );

    assert.equal(calls.includes("sd pull"), true);
    assert.equal(calls.some((call) => call.startsWith("npm ")), false);
  });

  it("fails clearly when install directory is not a git repo", async () => {
    await assert.rejects(
      () => runSelfUpdate({ repoRoot: "not-a-repo", isGitRepo: () => false }),
      /not a git repo/i,
    );
  });

  it("recognizes legacy git no-change output", () => {
    assert.equal(gitPullMadeNoChanges("Already up-to-date."), true);
    assert.equal(gitPullMadeNoChanges("Fast-forward"), false);
  });
});
