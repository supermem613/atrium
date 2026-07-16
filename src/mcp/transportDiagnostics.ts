import { writeSync } from "node:fs";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export type DiagnosticSink = (line: string) => void;
export type TransportDiagnosticsTransport = Pick<Transport, "onclose" | "onerror">;

export interface ProcessCrashHandlers {
  sink: DiagnosticSink;
  exit: (code: number) => void;
  fallbackSink?: DiagnosticSink;
}

let activeCrashHandlers: ProcessCrashHandlers | undefined;
let crashHandlersRegistered = false;

function createDiagnosticLine(code: string, detail: string): string {
  return `${new Date().toISOString()} ${code} ${detail}`;
}

function emitDiagnosticWithFallback(sink: DiagnosticSink, fallbackSink: DiagnosticSink, line: string): void {
  try {
    sink(line);
  } catch {
    fallbackSink(line);
  }
}

export function registerTransportDiagnostics(
  transport: TransportDiagnosticsTransport,
  sink: DiagnosticSink,
  fallbackSink: DiagnosticSink = defaultStderrSink,
): void {
  const previousOnClose = transport.onclose;
  transport.onclose = () => {
    try {
      emitDiagnosticWithFallback(sink, fallbackSink, createDiagnosticLine("ATRIUM_TRANSPORT_CLOSE", "transport closed"));
    } finally {
      previousOnClose?.();
    }
  };

  const previousOnError = transport.onerror;
  transport.onerror = (error: Error) => {
    try {
      emitDiagnosticWithFallback(sink, fallbackSink, createDiagnosticLine("ATRIUM_TRANSPORT_ERROR", "transport error"));
    } finally {
      previousOnError?.(error);
    }
  };
}

export function registerProcessCrashHandlers({ sink, exit, fallbackSink }: ProcessCrashHandlers): void {
  activeCrashHandlers = { sink, exit, fallbackSink };

  if (crashHandlersRegistered) {
    return;
  }

  const handleCrash = () => {
    const currentHandlers = activeCrashHandlers;
    if (currentHandlers === undefined) {
      return;
    }

    const currentFallbackSink = currentHandlers.fallbackSink ?? defaultStderrSink;

    try {
      // Keep crash evidence on stderr because stdout is reserved for MCP JSON-RPC and the host must receive it before the immediate exit
      emitDiagnosticWithFallback(currentHandlers.sink, currentFallbackSink, createDiagnosticLine("ATRIUM_SERVER_CRASH", "server crash"));
    } finally {
      currentHandlers.exit(1);
    }
  };

  process.on("uncaughtException", handleCrash);
  process.on("unhandledRejection", handleCrash);
  crashHandlersRegistered = true;
}

export function defaultStderrSink(line: string): void {
  writeSync(2, `${line}\n`);
}
