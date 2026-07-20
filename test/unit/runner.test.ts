import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as waitForPollInterval } from "node:timers/promises";
import { ExecutionQueue } from "../../src/core/executionQueue.js";
import { atriumTempPath } from "../../src/core/tempPaths.js";
import type { RunExecutableInput, StartExecutableRunOptions } from "../../src/core/runner.js";

async function loadRunnerModule() {
  return import("../../src/core/runner.js");
}

const pythonInterpreter: string | undefined = (() => {
  for (const candidate of ["python", "python3"]) {
    try {
      execFileSync(candidate, ["-c", "pass"], { stdio: "ignore" });
      return candidate;
    } catch {
      // Try the next candidate name.
    }
  }
  return undefined;
})();

async function runExecutable(input: RunExecutableInput, options?: StartExecutableRunOptions) {
  const runnerModule = await loadRunnerModule();
  return runnerModule.runExecutable(input, options);
}

async function startExecutableRun(input: RunExecutableInput, options?: StartExecutableRunOptions) {
  const runnerModule = await loadRunnerModule();
  return runnerModule.startExecutableRun(input, options);
}

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

  it("uses a cached Windows tool resolution before the first spawn attempt", { skip: process.platform !== "win32" }, async () => {
    const resolvedTool = "C:\\repo\\bin\\tool.cmd";
    const childScript = `
      import { createRequire } from "node:module";
      import { EventEmitter } from "node:events";

      const require = createRequire(import.meta.url);
      const childProcessModule = require("node:child_process");
      const spawnCalls = [];

      function createFakeChildProcess(stdoutText, stderrText, exitCode) {
        const child = new EventEmitter();
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        stderr.resume = () => {};
        child.stdout = stdout;
        child.stderr = stderr;
        child.stdin = { end() {} };
        child.kill = () => {};
        queueMicrotask(() => {
          if (stdoutText.length > 0) {
            stdout.emit("data", Buffer.from(stdoutText));
          }
          if (stderrText.length > 0) {
            stderr.emit("data", Buffer.from(stderrText));
          }
          child.emit("close", exitCode, null);
        });
        return child;
      }

      const mockSpawn = (command, args = []) => {
        spawnCalls.push({ command, args: [...args] });
        if (command === "tool") {
          const error = new Error("spawn tool ENOENT");
          error.code = "ENOENT";
          throw error;
        }

        if (command === "where.exe") {
          return createFakeChildProcess(${JSON.stringify(`${resolvedTool}\n`)}, "", 0);
        }

        if (command === "cmd.exe") {
          return createFakeChildProcess("", "", 0);
        }

        throw new Error(\`unexpected command \${command}\`);
      };

      childProcessModule.spawn = mockSpawn;
      const runnerModule = await import("./src/core/runner.ts?cached-resolution-test=${Date.now()}");
      const firstRun = await runnerModule.runExecutable({ tool: "tool" });
      const firstRunCallCount = spawnCalls.length;
      const secondRun = await runnerModule.runExecutable({ tool: "tool" });
      const secondRunCalls = spawnCalls.slice(firstRunCallCount);
      process.stdout.write(JSON.stringify({
        firstRunOk: firstRun.ok,
        secondRunOk: secondRun.ok,
        secondRunCalls,
      }));
    `;

    const stdout = execFileSync(process.execPath, ["--import", "tsx", "-e", childScript], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const payload = JSON.parse(stdout) as {
      firstRunOk: boolean;
      secondRunOk: boolean;
      secondRunCalls: Array<{ command: string; args: string[] }>;
    };

    assert.equal(payload.firstRunOk, true);
    assert.equal(payload.secondRunOk, true);
    assert.equal(payload.secondRunCalls.length, 1);
    assert.equal(payload.secondRunCalls[0].command, "cmd.exe");
    assert.equal(payload.secondRunCalls[0].args[0], "/d");
    assert.equal(payload.secondRunCalls[0].args[1], "/s");
    assert.equal(payload.secondRunCalls[0].args[2], "/c");
    assert.ok(payload.secondRunCalls[0].args[3].includes(resolvedTool));
  });

  it("preserves non-ASCII UTF-8 stdin through a child that uses text-mode stdio", {
    skip: pythonInterpreter === undefined ? "no python interpreter available" : false,
  }, async () => {
    // Real scripts decode text-mode sys.stdin and must recover the true characters, not the
    // ANSI-code-page bytes. On Windows the child defaults stdin to cp1252 with
    // surrogateescape, so a raw stdin-to-stdout copy round-trips bytes yet still hands the
    // script mojibake. Re-encoding the decoded text as UTF-8 exposes that: cp1252 decode
    // yields lone surrogates that raise UnicodeEncodeError, so the run fails unless Atrium
    // has guaranteed the child speaks UTF-8.
    const sample = "Alejandro Quiñones — Lunch 🍔";
    const result = await runExecutable({
      tool: pythonInterpreter as string,
      args: ["-c", "import sys; sys.stdout.buffer.write(sys.stdin.read().encode('utf-8'))"],
      stdin: sample,
    });

    assert.equal(result.ok, true);
    assert.equal(result.stdout, sample);
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

  it("limits concurrent executable starts and records queue metrics", async () => {
    const dir = await createTestTempDir("execution-queue-");
    const queue = new ExecutionQueue(2);
    const starts = [0, 1, 2, 3].map((index) => join(dir, `started-${index}`));
    const releases = [0, 1, 2, 3].map((index) => join(dir, `release-${index}`));

    const running = starts.map(async (startFile, index) => startExecutableRun({
      tool: process.execPath,
      args: ["-e", waitForReleaseScript(startFile, releases[index], 0)],
    }, { executionQueue: queue }));
    const results = (await Promise.all(running)).map((run) => run.result);

    await Promise.all([waitForFile(starts[0]), waitForFile(starts[1])]);
    await Promise.all([writeFile(releases[0], ""), writeFile(releases[1], "")]);
    await Promise.all([results[0], results[1]]);

    await Promise.all([waitForFile(starts[2]), waitForFile(starts[3])]);
    await Promise.all([writeFile(releases[2], ""), writeFile(releases[3], "")]);
    const queuedResults = await Promise.all([results[2], results[3]]);

    for (const result of queuedResults) {
      assert.equal(result.ok, true);
      assert.equal(result.metrics.queueLimit, 2);
      assert.equal(result.metrics.queueActiveAtStart, 2);
      assert.ok((result.metrics.queueDepthAtEnqueue ?? 0) >= 1);
      assert.ok((result.metrics.queueWaitMs ?? 0) > 0);
    }
  });

  it("releases queue slots after timeouts", async () => {
    const dir = await createTestTempDir("execution-queue-timeout-");
    const queue = new ExecutionQueue(1);
    const firstStart = join(dir, "started-first");
    const secondStart = join(dir, "started-second");
    const secondRelease = join(dir, "release-second");

    const firstRun = await startExecutableRun({
      tool: process.execPath,
      args: ["-e", waitForReleaseScript(firstStart, join(dir, "release-first"), 0)],
      timeoutMs: 1_000,
    }, { executionQueue: queue });
    await waitForFile(firstStart);

    const secondRun = await startExecutableRun({
      tool: process.execPath,
      args: ["-e", waitForReleaseScript(secondStart, secondRelease, 0)],
    }, { executionQueue: queue });

    const firstResult = await firstRun.result;
    await waitForFile(secondStart);
    await writeFile(secondRelease, "");
    const secondResult = await secondRun.result;

    assert.equal(firstResult.ok, false);
    assert.equal(firstResult.error?.code, "Timeout");
    assert.equal(secondResult.ok, true);
    assert.equal(secondResult.metrics.queueLimit, 1);
    assert.ok((secondResult.metrics.queueWaitMs ?? 0) > 0);
  });

  it("emits generic executable semantics for command runs without xray search parsing", { skip: process.platform !== "win32" }, async () => {
    const { shimFile } = await createNodeCmdShim("Program Files native-search-metrics-", [
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
    assert.equal(simulated.metrics.semantic?.kind, "generic.command");
    assert.equal(typeof simulated.metrics.semantic?.commandHash, "string");
    assert.equal(simulated.metrics.semantic?.commandLength, "search".length);
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

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      await access(path);
      return;
    } catch {
      await waitForPollInterval(10);
    }
  }
  assert.fail(`Timed out waiting for ${path}`);
}

function waitForReleaseScript(startFile: string, releaseFile: string, exitCode: number): string {
  return [
    "const { existsSync, writeFileSync } = require('node:fs');",
    `const startFile = ${JSON.stringify(startFile)};`,
    `const releaseFile = ${JSON.stringify(releaseFile)};`,
    `const exitCode = ${String(exitCode)};`,
    "writeFileSync(startFile, 'started');",
    "const deadline = Date.now() + 10_000;",
    "const interval = setInterval(() => {",
    "  if (existsSync(releaseFile)) {",
    "    clearInterval(interval);",
    "    process.exit(exitCode);",
    "  }",
    "  if (Date.now() > deadline) {",
    "    clearInterval(interval);",
    "    process.stderr.write('release timeout');",
    "    process.exit(88);",
    "  }",
    "}, 10);",
  ].join("");
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
