import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable } from "node:stream";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { it } from "node:test";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const serverSource = fileURLToPath(new URL("../../src/server.ts", import.meta.url));
const SDK_READ_BUFFER_LIMIT = 10 * 1024 * 1024;
const RESPONSE_TIMEOUT_MS = DEFAULT_REQUEST_TIMEOUT_MSEC;

function startSourceServer(): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["--import", "tsx", serverSource], {
    cwd: repositoryRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function startBackgroundTestServer(): ChildProcessWithoutNullStreams {
  const serverModule = pathToFileURL(serverSource).href;
  const program = [
    `import { startAtriumServer } from ${JSON.stringify(serverModule)};`,
    "await startAtriumServer({ backgroundHandoffAfterMs: 5, waitTimeoutMs: 50 });",
  ].join("");
  return spawn(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    program,
  ], {
    cwd: repositoryRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function createLineReader(stream: Readable): () => Promise<string> {
  stream.setEncoding("utf8");
  let buffered = "";
  const pending: Array<(line: string) => void> = [];
  const drain = () => {
    while (pending.length > 0) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = buffered.slice(0, newline).replace(/\r$/, "");
      buffered = buffered.slice(newline + 1);
      pending.shift()?.(line);
    }
  };
  stream.on("data", (chunk: string) => {
    buffered += chunk;
    drain();
  });
  return () => new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for MCP response after ${RESPONSE_TIMEOUT_MS}ms`));
    }, RESPONSE_TIMEOUT_MS);
    pending.push((line) => {
      clearTimeout(timeout);
      resolve(line);
    });
    drain();
  });
}

async function writeAndFlush(server: ChildProcessWithoutNullStreams, payload: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.stdin.write(payload, (error?: Error | null) => {
      if (error != null) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function stopServer(server: ChildProcessWithoutNullStreams): Promise<void> {
  if (server.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit", { signal: AbortSignal.timeout(RESPONSE_TIMEOUT_MS) });
    server.kill();
    await exited;
  }
  server.stdin.destroy();
  server.stdout.destroy();
  server.stderr.destroy();
}

function request(id: number, method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", method, params, id })}\n`;
}

function parseToolPayload(response: unknown): Record<string, unknown> {
  assert.equal(typeof response, "object");
  assert.notEqual(response, null);
  const result = (response as { result?: { content?: Array<{ type?: string; text?: string }> } }).result;
  const text = result?.content?.find((item) => item.type === "text")?.text;
  assert.ok(typeof text === "string");
  const payload: unknown = JSON.parse(text);
  assert.equal(typeof payload, "object");
  assert.notEqual(payload, null);
  return payload as Record<string, unknown>;
}

async function waitForCondition(
  condition: () => boolean,
  message: string,
  timeoutMs = RESPONSE_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await new Promise<void>((resolve, reject) => {
    const poll = () => {
      if (condition()) {
        resolve();
      } else if (Date.now() >= deadline) {
        reject(new Error(message));
      } else {
        setImmediate(poll);
      }
    };
    poll();
  });
}

it("rejects an oversized call by id and serves the next call", async () => {
  const server = startSourceServer();
  const nextLine = createLineReader(server.stdout);
  try {
    const oversized = request(7001, "tools/call", {
      name: "run",
      arguments: {
        tool: process.execPath,
        args: ["-e", "process.stdout.write('oversized-call')", "x".repeat(SDK_READ_BUFFER_LIMIT)],
      },
    });
    const valid = request(7002, "tools/list", {});
    await writeAndFlush(server, oversized + valid);

    const rejected = JSON.parse(await nextLine()) as {
      id: number;
      error?: { code?: number; data?: { code?: string } };
    };
    assert.equal(rejected.id, 7001);
    assert.equal(rejected.error?.code, -32600);
    assert.equal(rejected.error?.data?.code, "FrameTooLarge");

    const listed = JSON.parse(await nextLine()) as { id: number; result?: { tools?: unknown[] } };
    assert.equal(listed.id, 7002);
    assert.ok(Array.isArray(listed.result?.tools));
  } finally {
    await stopServer(server);
  }
});

it("survives coalesced individually-valid frames beyond the SDK aggregate budget", async () => {
  const server = startSourceServer();
  const nextLine = createLineReader(server.stdout);
  try {
    const notification = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: { padding: "x".repeat(Math.floor(SDK_READ_BUFFER_LIMIT / 2)) },
    });
    const coalesced = `${notification}\n${notification}\n`;
    assert.ok(Buffer.byteLength(coalesced, "utf8") > SDK_READ_BUFFER_LIMIT);
    await writeAndFlush(server, `${coalesced}${request(7003, "tools/list", {})}`);

    const listed = JSON.parse(await nextLine()) as { id: number; result?: { tools?: unknown[] } };
    assert.equal(listed.id, 7003);
    assert.ok(Array.isArray(listed.result?.tools));
  } finally {
    await stopServer(server);
  }
});

it("keeps a background run recoverable across an oversized frame and serves run, read, and grep", async () => {
  const gateDirectory = await mkdtemp(join(tmpdir(), "atrium-frame-recovery-"));
  const gate = join(gateDirectory, "release");
  const server = startBackgroundTestServer();
  const nextLine = createLineReader(server.stdout);
  let diagnostics = "";
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk: string) => {
    diagnostics += chunk;
  });
  let nextId = 7100;
  const callTool = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = nextId;
    nextId += 1;
    await writeAndFlush(server, request(id, "tools/call", { name, arguments: args }));
    const response = JSON.parse(await nextLine()) as { id?: number; error?: unknown };
    assert.equal(response.id, id);
    assert.equal(response.error, undefined);
    return parseToolPayload(response);
  };
  const settlePayload = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (payload.status !== "running") {
      return payload;
    }
    assert.equal(typeof payload.operationId, "string");
    let snapshot: Record<string, unknown>;
    do {
      snapshot = await callTool("operation-wait", { operationId: payload.operationId });
    } while (snapshot.status === "continue");
    assert.equal(snapshot.status, "completed");
    assert.equal(typeof snapshot.result, "object");
    assert.notEqual(snapshot.result, null);
    return snapshot.result as Record<string, unknown>;
  };

  try {
    const started = await callTool("run", {
      tool: process.execPath,
      args: [
        "-e",
        "const fs=require('node:fs'),p=process.argv[1];const w=fs.watch(require('node:path').dirname(p),()=>{if(fs.existsSync(p)){w.close();process.stdout.write('original-background-output')}});if(fs.existsSync(p)){w.close();process.stdout.write('original-background-output')}",
        gate,
      ],
    });
    assert.equal(started.status, "running");
    assert.equal(typeof started.operationId, "string");
    const operationId = started.operationId as string;

    const oversizedId = nextId;
    nextId += 1;
    const listId = nextId;
    nextId += 1;
    const oversized = request(oversizedId, "tools/call", {
      name: "run",
      arguments: {
        tool: process.execPath,
        args: ["-e", "process.stdout.write('should-not-run')", "x".repeat(SDK_READ_BUFFER_LIMIT)],
      },
    });
    await writeAndFlush(server, `${oversized}${request(listId, "tools/list", {})}`);

    const rejected = JSON.parse(await nextLine()) as {
      id: number;
      error?: { code?: number; data?: { code?: string } };
    };
    assert.equal(rejected.id, oversizedId);
    assert.equal(rejected.error?.code, -32600);
    assert.equal(rejected.error?.data?.code, "FrameTooLarge");

    const listed = JSON.parse(await nextLine()) as {
      id: number;
      result?: { tools?: Array<{ name?: string }> };
    };
    assert.equal(listed.id, listId);
    assert.deepEqual(
      listed.result?.tools?.map((tool) => tool.name).sort(),
      ["find-files", "grep", "grep-code", "operation-wait", "read", "run", "schema"],
    );

    await writeFile(gate, "release");
    let snapshot: Record<string, unknown>;
    do {
      snapshot = await callTool("operation-wait", { operationId });
    } while (snapshot.status === "continue");
    assert.equal(snapshot.status, "completed");
    assert.equal(
      (snapshot.result as { stdout?: string } | undefined)?.stdout,
      "original-background-output",
    );

    const runResult = await settlePayload(await callTool("run", {
      tool: process.execPath,
      args: ["-e", "process.stdout.write('after-recovery')"],
    }));
    assert.equal(runResult.ok, true);
    assert.equal(runResult.stdout, "after-recovery");

    const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const readResult = await settlePayload(await callTool("read", { path: packagePath }));
    assert.equal(readResult.ok, true);
    assert.equal(typeof readResult.content, "string");
    assert.match(readResult.content as string, /"name": "atrium"/);

    const grepResult = await settlePayload(await callTool("grep", { path: packagePath, query: "atrium" }));
    assert.match(JSON.stringify(grepResult), /atrium/);

    await waitForCondition(
      () => diagnostics.includes("ATRIUM_TRANSPORT_ERROR") && diagnostics.includes("FrameTooLarge"),
      "oversized-frame diagnostic did not reach stderr",
    );
  } finally {
    await writeFile(gate, "cleanup");
    await stopServer(server);
    await rm(gateDirectory, { recursive: true, force: true });
  }
});
