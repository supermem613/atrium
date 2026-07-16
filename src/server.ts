#!/usr/bin/env node

import { Command } from "commander";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultWaitTimeoutMs } from "./core/backgroundRuns.js";
import { ExecutionQueue } from "./core/executionQueue.js";
import { createNativeSearchClient } from "./core/search/searchClient.js";
import type { SearchClientLike } from "./core/search/types.js";
import {
  composeInstructions,
  createSurfaces,
  parseSurfaceArg,
  selectEnabledSurfaces,
  surfaceOptionDescription,
} from "./mcp/surfaces.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  defaultStderrSink,
  registerProcessCrashHandlers,
  registerTransportDiagnostics,
  type DiagnosticSink,
} from "./mcp/transportDiagnostics.js";

const defaultBackgroundHandoffAfterMs = 45_000;

const packageVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

export interface AtriumServerOptions {
  backgroundHandoffAfterMs?: number;
  waitTimeoutMs?: number;
  executionQueue?: ExecutionQueue | false;
  searchClient?: SearchClientLike;
  surfaces?: string[];
  transport?: Transport;
  sink?: DiagnosticSink;
}

export function createAtriumServer(options: AtriumServerOptions = {}): McpServer {
  const backgroundHandoffAfterMs = options.backgroundHandoffAfterMs ?? defaultBackgroundHandoffAfterMs;
  const waitTimeoutMs = options.waitTimeoutMs ?? defaultWaitTimeoutMs;
  const executionOptions = {
    executionQueue: options.executionQueue,
  };
  const searchClient = options.searchClient ?? createNativeSearchClient();

  const surfaces = selectEnabledSurfaces(createSurfaces({
    executionOptions,
    backgroundHandoffAfterMs,
    waitTimeoutMs,
    searchClient,
  }), options.surfaces);

  const server = new McpServer(
    {
      name: "atrium",
      version: packageVersion,
    },
    {
      instructions: composeInstructions(surfaces),
    },
  );

  for (const surface of surfaces) {
    for (const tool of surface.tools) {
      tool.register(server);
    }
  }

  return server;
}

export async function startAtriumServer(options: AtriumServerOptions = {}): Promise<void> {
  const transport: Transport = options.transport ?? new StdioServerTransport();
  const sink = options.sink ?? defaultStderrSink;
  const server = createAtriumServer(options);

  registerTransportDiagnostics(transport, sink);
  registerProcessCrashHandlers({
    sink,
    exit: (code: number) => {
      process.exit(code);
    },
  });

  await server.connect(transport);
}

// Parses the atrium-mcp entrypoint argv so this bin honors --surface exactly
// like the `atrium mcp-server` command. Without this the direct entrypoint
// would silently ignore the flag and expose every surface.
export function parseServerArgv(argv: string[]): AtriumServerOptions {
  const program = new Command();
  program
    .allowExcessArguments(false)
    .option("--surface <names>", surfaceOptionDescription, parseSurfaceArg)
    .parse(argv);
  const options = program.opts<{ surface?: string[] }>();
  return { surfaces: options.surface };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startAtriumServer(parseServerArgv(process.argv));
}
