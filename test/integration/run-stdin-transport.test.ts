import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Grease a74c16dc32399495 and the original session tool.execution_start events
// supply these programs and measured stdin sizes. Both children fail before
// reading stdin, so substitute non-private bytes without changing the trigger.
const recordedCases = [
  {
    name: "a child syntax error",
    session: "dfe8f83e-bfee-486b-a0c5-fd2edd3753ec",
    inputBytes: 5_597_908,
    program: "let s='';for await(const c of process.stdin)s+=c;const x=JSON.parse(s);console.log(JSON.stringify(x.data.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,typeof v==='string'?v.slice(0,300):Array.isArray(v)?{length:v.length}:typeof v==='object'?Object.keys(v??{}):v]))))))",
  },
  {
    name: "missing child arguments",
    session: "061fd89d-964b-419f-8ee0-e7bde0d54716",
    inputBytes: 130_559,
    // The recorded command supplied no argv after -e. This exact prefix throws
    // at readFileSync(undefined), making the rest of its program unreachable.
    program: "const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const [sourcePath,manifestPath,sessionDir,repoRoot,...oraclePaths]=process.argv.slice(1);const listing=JSON.parse(fs.readFileSync(sourcePath,'utf8'));",
  },
];

async function verifyServerSurvival(fixture: typeof recordedCases[number]): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "atrium-stdin-transport-"));
  const inputPath = join(directory, "stdin.txt");
  const client = new Client({ name: "stdin-transport-regression", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", fileURLToPath(new URL("../../src/server.ts", import.meta.url))],
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString("utf8");
  });

  try {
    await writeFile(inputPath, "x".repeat(fixture.inputBytes));
    await client.connect(transport);
    const outcomes: unknown[] = [];
    for (const invocation of [
      { tool: process.execPath, args: ["-e", fixture.program], stdin: { file: inputPath } },
      { tool: process.execPath, args: ["-e", "process.stdout.write('server-alive')"] },
    ]) {
      try {
        const response = await client.callTool({ name: "run", arguments: invocation });
        const content = response.content;
        if (!Array.isArray(content)) {
          throw new Error("Expected MCP text content");
        }
        const text = content.find((block: { type: string }) => block.type === "text");
        if (text === undefined || typeof text.text !== "string") {
          throw new Error("Expected MCP text result");
        }
        const result: unknown = JSON.parse(text.text);
        if (typeof result !== "object" || result === null || !("ok" in result)) {
          throw new Error("Expected a structured command result");
        }
        outcomes.push(result.ok
          ? { ok: result.ok, stdout: "stdout" in result ? result.stdout : undefined }
          : {
            ok: result.ok,
            errorCode: "error" in result && typeof result.error === "object" && result.error !== null && "code" in result.error
              ? result.error.code : undefined,
            exitCode: "metrics" in result && typeof result.metrics === "object" && result.metrics !== null && "exitCode" in result.metrics
              ? result.metrics.exitCode : undefined,
          });
      } catch (error) {
        outcomes.push({ transportError: String(error) });
      }
    }

    assert.deepEqual(outcomes, [
      { ok: false, errorCode: "NonZeroExit", exitCode: 1 },
      { ok: true, stdout: "server-alive" },
    ], `Recorded session ${fixture.session}\n${diagnostics}`);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
}

for (const fixture of recordedCases) {
  it(`returns a child failure and serves the next MCP call after ${fixture.name} rejects file-backed stdin`, async () => {
    await verifyServerSurvival(fixture);
  });
}
