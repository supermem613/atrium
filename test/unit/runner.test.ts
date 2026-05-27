import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { runExecutable } from "../../src/core/runner.js";

describe("runner", () => {
  it("runs an executable with structured args and writes artifacts", async () => {
    const result = await runExecutable({
      tool: process.execPath,
      args: ["-e", "process.stdout.write('atrium-ok')"],
    });

    assert.equal(result.ok, true);
    assert.equal(result.stdoutPreview, undefined);
    assert.ok(result.artifacts);
    assert.equal(result.artifacts.stderrPath, undefined);
    assert.equal(result.artifacts.stderrBytes, undefined);
    assert.equal(result.artifacts.stdoutBytes, "atrium-ok".length);
    assert.ok(result.artifacts.stdoutPath);
    assert.equal(await readFile(result.artifacts.stdoutPath, "utf8"), "atrium-ok");
  });

  it("denies shell tools", async () => {
    const result = await runExecutable({
      tool: "pwsh",
      args: ["-NoProfile", "-Command", "Write-Output nope"],
    });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "DeniedShell");
  });

  it("captures non-zero exits without throwing", async () => {
    const result = await runExecutable({
      tool: process.execPath,
      args: ["-e", "process.stderr.write('bad'); process.exit(7)"],
      maxPreviewBytes: 16,
    });
    assert.equal(result.ok, false);
    assert.equal(result.stderrPreview, "bad");
    assert.ok(result.artifacts);
    assert.equal(result.artifacts.stdoutPath, undefined);
    assert.equal(result.artifacts.stdoutBytes, undefined);
    assert.equal(result.artifacts.stderrBytes, "bad".length);
    assert.ok(result.artifacts.stderrPath);
  });
});
