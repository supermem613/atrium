import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  registerTransportDiagnostics,
  registerProcessCrashHandlers,
} from "../../src/mcp/transportDiagnostics.js";

class FakeTransport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
}

test("transport close/error and process crash emit typed diagnostics through the sink", () => {
  const transport = new FakeTransport();
  const sinkLines: string[] = [];
  const sink = (line: string) => {
    sinkLines.push(line);
    throw new Error("sink failed");
  };
  const fallbackLines: string[] = [];
  const fallbackSink = (line: string) => {
    fallbackLines.push(line);
  };
  const stdoutChunks: string[] = [];
  const originalStdoutWrite = process.stdout.write;
  const originalProcessOn = process.on;
  const capturedCrashHandlers: Record<string, (...args: unknown[]) => void> = {};
  let exitCode: number | undefined;
  let closeCallbackCount = 0;
  let errorCallbackCount = 0;
  let processOnEventCount = 0;

  process.stdout.write = ((chunk: string | Uint8Array, _encoding?: BufferEncoding, callback?: (error?: Error | null) => void) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    if (typeof callback === "function") {
      callback();
    }
    return true;
  }) as typeof process.stdout.write;

  process.on = ((event: string, handler: (...args: unknown[]) => void) => {
    if (event === "uncaughtException" || event === "unhandledRejection") {
      processOnEventCount += 1;
      capturedCrashHandlers[event] = handler;
    }
    return process;
  }) as typeof process.on;

  try {
    transport.onclose = () => {
      closeCallbackCount += 1;
    };
    transport.onerror = () => {
      errorCallbackCount += 1;
    };

    registerTransportDiagnostics(transport, sink, fallbackSink);

    assert.equal(typeof transport.onclose, "function", "expected close callback to be registered");
    assert.equal(typeof transport.onerror, "function", "expected error callback to be registered");

    transport.onclose?.();
    transport.onerror?.(new Error("transport closed unexpectedly"));

    registerProcessCrashHandlers({ sink, exit: (code: number) => {
      exitCode = code;
    }, fallbackSink });
    registerProcessCrashHandlers({ sink, exit: (code: number) => {
      exitCode = code;
    }, fallbackSink });

    assert.ok(capturedCrashHandlers["uncaughtException"], "expected process crash handler to be registered");
    assert.equal(processOnEventCount, 2, "expected process crash handlers to be registered once");
    capturedCrashHandlers["uncaughtException"]?.(new Error("process crash"));

    assert.equal(exitCode, 1, "expected a non-zero exit code for a process crash");
    assert.equal(closeCallbackCount, 1, "expected the previous close callback to run");
    assert.equal(errorCallbackCount, 1, "expected the previous error callback to run");
    assert.ok(
      sinkLines.some((line) => line.includes("ATRIUM_TRANSPORT_CLOSE")),
      "expected a transport close diagnostic through the sink",
    );
    assert.ok(
      sinkLines.some((line) => line.includes("ATRIUM_TRANSPORT_ERROR")),
      "expected a transport error diagnostic through the sink",
    );
    assert.ok(
      sinkLines.some((line) => line.includes("ATRIUM_SERVER_CRASH")),
      "expected a process crash diagnostic through the sink",
    );

    assert.ok(
      fallbackLines.some((line) => line.includes("ATRIUM_TRANSPORT_CLOSE")),
      "expected fallback typed diagnostics to be emitted",
    );
    assert.ok(
      fallbackLines.some((line) => line.includes("ATRIUM_TRANSPORT_ERROR")),
      "expected fallback typed diagnostics to be emitted",
    );
    assert.ok(
      fallbackLines.some((line) => line.includes("ATRIUM_SERVER_CRASH")),
      "expected fallback typed diagnostics to be emitted",
    );
    assert.equal(stdoutChunks.join(""), "", "expected no typed diagnostics on stdout");
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.on = originalProcessOn;
  }
});
