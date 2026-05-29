import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

  it("runs modern node cmd shims without shell splitting paths with spaces", { skip: process.platform !== "win32" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "Program Files atrium-test-"));
    const shimFile = join(dir, "tool.cmd");
    const scriptFile = join(dir, "node_modules", "tool", "bin", "tool-cli.js");
    await mkdir(join(dir, "node_modules", "tool", "bin"), { recursive: true });
    await writeFile(shimFile, [
      "@ECHO OFF",
      "SETLOCAL",
      "SET \"NODE_EXE=%~dp0\\node.exe\"",
      "IF NOT EXIST \"%NODE_EXE%\" (",
      "  SET \"NODE_EXE=node\"",
      ")",
      "SET \"TOOL_CLI_JS=%~dp0\\node_modules\\tool\\bin\\tool-cli.js\"",
      "\"%NODE_EXE%\" \"%TOOL_CLI_JS%\" %*",
      "",
    ].join("\r\n"));
    await writeFile(scriptFile, "process.stdout.write(process.argv.slice(2).join('|'))");

    const result = await runExecutable({
      tool: shimFile,
      args: ["left value", "quoted \"value\"", "caret^value"],
    });

    assert.equal(result.ok, true);
    assert.equal(result.stdout, "left value|quoted \"value\"|caret^value");
  });

  it("runs legacy node cmd shims without shell splitting paths with spaces", { skip: process.platform !== "win32" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "Program Files atrium-test-"));
    const shimFile = join(dir, "tool.cmd");
    const scriptFile = join(dir, "node_modules", "tool", "bin", "tool-cli.js");
    await mkdir(join(dir, "node_modules", "tool", "bin"), { recursive: true });
    await writeFile(shimFile, [
      "@ECHO off",
      "SETLOCAL",
      "CALL :find_dp0",
      "IF EXIST \"%dp0%\\node.exe\" (",
      "  SET \"_prog=%dp0%\\node.exe\"",
      ") ELSE (",
      "  SET \"_prog=node\"",
      ")",
      "\"%_prog%\" \"%dp0%\\node_modules\\tool\\bin\\tool-cli.js\" %*",
      "ENDLOCAL",
      "EXIT /b %errorlevel%",
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      "",
    ].join("\r\n"));
    await writeFile(scriptFile, "process.stdout.write(process.argv.slice(2).join('|'))");

    const result = await runExecutable({
      tool: shimFile,
      args: ["left", "right"],
    });

    assert.equal(result.ok, true);
    assert.equal(result.stdout, "left|right");
  });
});
