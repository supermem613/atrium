import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExecutable } from "../../src/core/runner.js";

describe("runner", () => {
  it("inlines small stdout and omits empty stderr", async () => {
    const result = await runExecutable({
      tool: process.execPath,
      args: ["-e", "process.stdout.write('atrium-ok')"],
    });

    assert.equal(result.ok, true);
    assert.equal(result.stdout, "atrium-ok");
    assert.equal(result.stderr, undefined);
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
    });
    assert.equal(result.ok, false);
    assert.equal(result.stdout, undefined);
    assert.equal(result.stderr, "bad");
  });

  it("writes large stdout as a file value", async () => {
    const result = await runExecutable({
      tool: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(129))"],
    });

    assert.equal(result.ok, true);
    assert.equal(typeof result.stdout, "object");
    assert.ok(result.stdout !== undefined && typeof result.stdout !== "string");
    assert.equal(result.stdout.bytes, 129);
    assert.equal(await readFile(result.stdout.file, "utf8"), "x".repeat(129));
  });

  it("resolves file nodes in args and stdin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atrium-test-"));
    const argFile = join(dir, "arg.txt");
    const stdinFile = join(dir, "stdin.txt");
    await writeFile(argFile, "arg-file");
    await writeFile(stdinFile, "stdin-file");

    const result = await runExecutable({
      tool: process.execPath,
      args: ["-e", "process.stdin.once('data', chunk => process.stdout.write(`${process.argv[1]}:${chunk}`))", { file: argFile }],
      stdin: { file: stdinFile },
    });

    assert.equal(result.ok, true);
    assert.equal(result.stdout, "arg-file:stdin-file");
  });
});
