import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runExecutable } from "../../src/core/runner.js";
import { atriumTempPath } from "../../src/core/tempPaths.js";

describe("runner", () => {
  it("inlines small stdout and omits empty stderr", async () => {
    const result = await runExecutable({
      tool: process.execPath,
      args: ["-e", "process.stdout.write('atrium-ok')"],
    });

    assert.equal(result.ok, true);
    assert.equal(result.stdout, "atrium-ok");
    assert.equal(result.stderr, undefined);
    assert.equal(result.metrics.childTool, "node");
    assert.equal(result.metrics.stdoutBytes, 9);
    assert.equal(result.metrics.stderrBytes, 0);
    assert.equal(result.metrics.argCount, 2);
    assert.equal(result.metrics.argShape[0], "flag");
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
    assert.equal(result.metrics.exitCode, 7);
    assert.equal(result.metrics.stderrBytes, 3);
  });

  it("emits redacted xray search metrics for trace analysis", { skip: process.platform !== "win32" }, async () => {
    const { shimFile } = await createNodeCmdShim("Program Files xray-metrics-", [
      "@ECHO off",
      "SETLOCAL",
      "SET \"NODE_EXE=%~dp0\\node.exe\"",
      "IF NOT EXIST \"%NODE_EXE%\" (",
      "  SET \"NODE_EXE=node\"",
      ")",
      "SET \"XRAY_CLI_JS=%~dp0\\node_modules\\xray\\bin\\xray.js\"",
      "\"%NODE_EXE%\" \"%XRAY_CLI_JS%\" %*",
      "",
    ], "xray.cmd");
    const simulated = await runExecutable({
      tool: shimFile,
      args: ["search", "secret query text", "--root", "C:\\repo", "--glob", "src\\**", "--context", "2", "--max", "50", "--regex"],
    });

    assert.equal(simulated.ok, true);
    assert.equal(simulated.metrics.childTool, "xray");
    assert.equal(simulated.metrics.argShape.includes("secret query text"), false);
    assert.equal(simulated.metrics.semantic?.kind, "xray.search");
    if (simulated.metrics.semantic?.kind !== "xray.search") {
      assert.fail("expected xray.search semantic metrics");
    }
    assert.equal(simulated.metrics.semantic.queryLength, "secret query text".length);
    assert.equal("query" in simulated.metrics.semantic, false);
    assert.equal(simulated.metrics.semantic.globCount, 1);
    assert.equal(simulated.metrics.semantic.context, 2);
    assert.equal(simulated.metrics.semantic.max, 50);
    assert.equal(simulated.metrics.semantic.regex, true);
    assert.equal(typeof simulated.metrics.semantic.scanScopeHash, "string");
  });

  it("writes large stdout as a file value", async () => {
    const result = await runExecutable({
      tool: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(8193))"],
    });

    assert.equal(result.ok, true);
    assert.equal(typeof result.stdout, "object");
    assert.ok(result.stdout !== undefined && typeof result.stdout !== "string");
    assert.equal(result.stdout.bytes, 8193);
    assert.equal(result.stdout.file.startsWith(atriumTempPath("runs")), true);
    assert.equal(await readFile(result.stdout.file, "utf8"), "x".repeat(8193));
  });

  it("inlines stdout at the default output limit", async () => {
    const result = await runExecutable({
      tool: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(8192))"],
    });

    assert.equal(result.ok, true);
    assert.equal(result.stdout, "x".repeat(8192));
  });

  it("resolves file nodes in args and stdin", async () => {
    const dir = await createTestTempDir("file-nodes-");
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
    const { shimFile } = await createNodeCmdShim("Program Files modern-shim-", [
      "@ECHO OFF",
      "SETLOCAL",
      "SET \"NODE_EXE=%~dp0\\node.exe\"",
      "IF NOT EXIST \"%NODE_EXE%\" (",
      "  SET \"NODE_EXE=node\"",
      ")",
      "SET \"TOOL_CLI_JS=%~dp0\\node_modules\\tool\\bin\\tool-cli.js\"",
      "\"%NODE_EXE%\" \"%TOOL_CLI_JS%\" %*",
      "",
    ]);

    const result = await runExecutable({
      tool: shimFile,
      args: ["left value", "quoted \"value\"", "caret^value"],
    });

    assert.equal(result.ok, true);
    assert.equal(result.stdout, JSON.stringify(["left value", "quoted \"value\"", "caret^value"]));
  });

  it("runs legacy node cmd shims without shell splitting paths with spaces", { skip: process.platform !== "win32" }, async () => {
    const { shimFile } = await createNodeCmdShim("Program Files legacy-shim-", [
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
    ]);

    const result = await runExecutable({
      tool: shimFile,
      args: ["left value", "right`value"],
    });

    assert.equal(result.ok, true);
    assert.equal(result.stdout, JSON.stringify(["left value", "right`value"]));
  });

  it("runs npm endLocal node cmd shims without shell splitting query args", { skip: process.platform !== "win32" }, async () => {
    for (const spacesBeforeScript of [" ", "  ", "    "]) {
      const { shimFile } = await createNodeCmdShim("Program Files endlocal-shim-", [
        "@ECHO off",
        "GOTO start",
        ":find_dp0",
        "SET dp0=%~dp0",
        "EXIT /b",
        ":start",
        "SETLOCAL",
        "CALL :find_dp0",
        "IF EXIST \"%dp0%\\node.exe\" (",
        "  SET \"_prog=%dp0%\\node.exe\"",
        ") ELSE (",
        "  SET \"_prog=node\"",
        "  SET PATHEXT=%PATHEXT:;.JS;=;%",
        ")",
        `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"${spacesBeforeScript}"%dp0%\\node_modules\\tool\\bin\\tool-cli.js" %*`,
        "",
      ]);

      const query = "Do not use `apply_patch` against paths";
      const result = await runExecutable({
        tool: shimFile,
        args: ["search", query, "--glob", ".github/references/**"],
      });

      assert.equal(result.ok, true);
      assert.equal(result.stdout, JSON.stringify(["search", query, "--glob", ".github/references/**"]));
    }
  });

  it("leaves unrecognized cmd files on the command shell fallback path", { skip: process.platform !== "win32" }, async () => {
    const dir = await createTestTempDir("fallback-shim-");
    const shimFile = join(dir, "tool.cmd");
    await writeFile(shimFile, [
      "@ECHO off",
      "ECHO fallback:%1",
      "",
    ].join("\r\n"));

    const result = await runExecutable({
      tool: shimFile,
      args: ["left"],
    });

    assert.equal(result.ok, true);
    assert.equal(result.stdout, "fallback:left\r\n");
  });

  it("runs unrecognized cmd files from paths with spaces without truncating the executable path", { skip: process.platform !== "win32" }, async () => {
    const dir = await createTestTempDir("Program Files fallback-shim-");
    const shimFile = join(dir, "tool.cmd");
    await writeFile(shimFile, [
      "@ECHO off",
      "ECHO fallback:%~1:%~2",
      "",
    ].join("\r\n"));

    const result = await runExecutable({
      tool: shimFile,
      args: ["left value", "right"],
    });

    assert.equal(result.ok, true);
    assert.equal(result.stdout, "fallback:left value:right\r\n");
  });

  it("runs unrecognized bat files from paths with spaces without truncating the executable path", { skip: process.platform !== "win32" }, async () => {
    const dir = await createTestTempDir("Program Files fallback-bat-");
    const batchFile = join(dir, "tool.bat");
    await writeFile(batchFile, [
      "@ECHO off",
      "ECHO fallback:%~1",
      "",
    ].join("\r\n"));

    const result = await runExecutable({
      tool: batchFile,
      args: ["left value"],
    });

    assert.equal(result.ok, true);
    assert.equal(result.stdout, "fallback:left value\r\n");
  });
});

async function createTestTempDir(prefix: string): Promise<string> {
  const root = atriumTempPath("tests");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, prefix));
}

async function createNodeCmdShim(prefix: string, lines: string[], shimName = "tool.cmd"): Promise<{ shimFile: string }> {
  const dir = await createTestTempDir(prefix);
  const shimFile = join(dir, shimName);
  const packageName = shimName.replace(/\.cmd$/u, "");
  await mkdir(join(dir, "node_modules", packageName, "bin"), { recursive: true });
  await writeFile(shimFile, lines.join("\r\n"));
  await writeFile(join(dir, "node_modules", packageName, "bin", `${packageName}.js`), "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  await writeFile(join(dir, "node_modules", packageName, "bin", "tool-cli.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)))");

  return { shimFile };
}
