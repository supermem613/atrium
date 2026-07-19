import { test, before } from "node:test";
import { strict as assert } from "node:assert";
import {
  registerTransportDiagnostics,
  registerProcessCrashHandlers,
} from "../../src/mcp/transportDiagnostics.js";

// These guard tests encode the causal-detail contract that backlog #1 depends on.
// A transport that dies must tell an operator WHY (error detail + crash origin),
// and a single recoverable unhandledRejection must not terminate the long-lived
// MCP server and drop the session stdio transport.

type CrashHandler = (arg?: unknown) => void;

const capturedHandlers: Record<string, CrashHandler> = {};

before(() => {
  const originalOn = process.on;
  // Capture the process-level crash handlers the module installs so each test can
  // drive one specific crash origin directly. The module registers them once
  // behind a singleton guard, so capture happens on this first registration.
  process.on = ((event: string, handler: CrashHandler) => {
    if (event === "uncaughtException" || event === "unhandledRejection") {
      capturedHandlers[event] = handler;
    }
    return process;
  }) as typeof process.on;
  try {
    registerProcessCrashHandlers({ sink: () => {}, exit: () => {} });
  } finally {
    process.on = originalOn;
  }
});

test("transport error diagnostic carries the underlying error detail", () => {
  const lines: string[] = [];
  const transport: { onclose?: () => void; onerror?: (error: Error) => void } = {};

  registerTransportDiagnostics(transport, (line) => lines.push(line));
  transport.onerror?.(new Error("errmsg-AAA-onerror"));

  assert.ok(
    lines.some((line) => line.includes("ATRIUM_TRANSPORT_ERROR") && line.includes("errmsg-AAA-onerror")),
    `expected the transport error diagnostic to include the error message, got: ${JSON.stringify(lines)}`,
  );
});

test("uncaughtException crash diagnostic records the origin and error detail, and exits", () => {
  const lines: string[] = [];
  const exitCodes: number[] = [];

  registerProcessCrashHandlers({ sink: (line) => lines.push(line), exit: (code) => exitCodes.push(code) });

  assert.ok(capturedHandlers.uncaughtException, "expected an uncaughtException handler to be registered");
  capturedHandlers.uncaughtException?.(new Error("crashmsg-BBB-uncaught"));

  assert.ok(
    lines.some(
      (line) =>
        line.includes("ATRIUM_SERVER_CRASH") &&
        line.includes("uncaughtException") &&
        line.includes("crashmsg-BBB-uncaught"),
    ),
    `expected the crash diagnostic to record origin and error detail, got: ${JSON.stringify(lines)}`,
  );
  assert.deepEqual(exitCodes, [1], "expected an uncaughtException to exit the process with code 1");
});

test("a stray unhandledRejection is logged with detail but does not terminate the server", () => {
  const lines: string[] = [];
  const exitCodes: number[] = [];

  registerProcessCrashHandlers({ sink: (line) => lines.push(line), exit: (code) => exitCodes.push(code) });

  assert.ok(capturedHandlers.unhandledRejection, "expected an unhandledRejection handler to be registered");
  capturedHandlers.unhandledRejection?.(new Error("rejmsg-CCC-unhandled"));

  assert.ok(
    lines.some((line) => line.includes("unhandledRejection") && line.includes("rejmsg-CCC-unhandled")),
    `expected the rejection to be logged with its detail, got: ${JSON.stringify(lines)}`,
  );
  assert.deepEqual(exitCodes, [], "expected a recoverable unhandledRejection NOT to exit the server");
});

test("a rejection whose reason cannot be stringified is logged safely and still does not terminate the server", () => {
  const lines: string[] = [];
  const exitCodes: number[] = [];

  registerProcessCrashHandlers({ sink: (line) => lines.push(line), exit: (code) => exitCodes.push(code) });

  // A hostile reason whose toString throws must not escape the handler. On the
  // unhandledRejection path an escaping throw would escalate into a fatal
  // uncaughtException, defeating the non-fatal guarantee.
  const hostile = {
    toString() {
      throw new Error("cannot stringify");
    },
  };

  assert.ok(capturedHandlers.unhandledRejection, "expected an unhandledRejection handler to be registered");
  capturedHandlers.unhandledRejection?.(hostile);

  assert.ok(
    lines.some((line) => line.includes("ATRIUM_SERVER_CRASH") && line.includes("unhandledRejection")),
    `expected the unstringifiable rejection to still be logged with its origin, got: ${JSON.stringify(lines)}`,
  );
  assert.deepEqual(exitCodes, [], "expected an unstringifiable unhandledRejection NOT to exit the server");
});
