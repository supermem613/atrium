import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { runSelfUpdate, gitPullMadeNoChanges } from "../../src/commands/update.js";

describe("update", () => {
  it("skips install and build when pull keeps the same revision", async () => {
    const calls: string[] = [];
    const result = await runSelfUpdate({
      repoRoot: "repo",
      isGitRepo: () => true,
      execCommand: async (command, args) => {
        calls.push([command, ...args].join(" "));
        if (command === "git" && args.join(" ") === "rev-parse HEAD") {
          return { stdout: "abc123\n", stderr: "" };
        }
        return { stdout: "Already up to date.\n", stderr: "" };
      },
    });
    assert.deepEqual(calls, ["git rev-parse HEAD", "git pull --ff-only", "git rev-parse HEAD"]);
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
        calls.push([command, ...args].join(" "));
        if (command === "git" && args.join(" ") === "rev-parse HEAD") {
          return { stdout: revisions.shift() ?? "def456\n", stderr: "" };
        }
        return { stdout: "Fast-forward\n", stderr: "" };
      },
    });
    assert.deepEqual(calls, [
      "git rev-parse HEAD",
      "git pull --ff-only",
      "git rev-parse HEAD",
      "npm install --no-audit --no-fund",
      "npm run build",
    ]);
    assert.equal(result.installed, true);
    assert.equal(result.built, true);
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
