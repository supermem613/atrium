import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

type VerbName = "schema" | "run" | "operation-wait" | "read" | "find-files" | "grep" | "grep-code";

type OperationRunner = (context: { fixtureData: Record<string, unknown>; verb: VerbName; suite: string; operationId: string }) => Promise<Record<string, unknown>>;

type AllVerbSuiteRequest = {
  suite: string;
  verbs: VerbName[];
  fixtureData: Record<string, unknown>;
  operationRunners: Record<VerbName, OperationRunner>;
  now: () => number;
};

type BenchmarkPerfCase = {
  name: string;
  ok: boolean;
  elapsedMs: number;
  timings: Record<string, unknown>;
  cliPerf?: Record<string, unknown>;
  cliPerfDetail?: Record<string, unknown>;
  perf?: Record<string, unknown>;
  perfDetail?: Record<string, unknown>;
};

type BenchmarkPerfOperation = {
  elapsedMs: number;
  ok: boolean;
  timings: Record<string, unknown>;
  cliPerf?: Record<string, unknown>;
  cliPerfDetail?: Record<string, unknown>;
  perf?: Record<string, unknown>;
  perfDetail?: Record<string, unknown>;
};

type BenchmarkPerfTotals = {
  pass: number;
  fail: number;
};

type BenchmarkPerfReport = {
  suite?: string;
  operationId?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  elapsedMs: number;
  concurrency: number;
  cases: BenchmarkPerfCase[];
  totals: BenchmarkPerfTotals;
  perOperation: Record<string, BenchmarkPerfOperation>;
  status: "pass" | "fail";
};

type BenchmarkPerfReportOptions = {
  operationName?: string;
  operationId?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  elapsedMs?: number;
  concurrency?: number;
  ok?: boolean;
  timings?: Record<string, unknown>;
  perOperation?: Record<string, BenchmarkPerfOperation>;
};

type AllVerbBuilder = (request: AllVerbSuiteRequest) => BenchmarkPerfReport | Promise<BenchmarkPerfReport>;

type CliSuiteRouter = (args: string[]) => Promise<BenchmarkPerfReport>;

function isAllVerbBuilder(value: unknown): value is AllVerbBuilder {
  return typeof value === "function";
}

function isCompatBuilder(value: unknown): value is (options: BenchmarkPerfReportOptions) => BenchmarkPerfReport {
  return typeof value === "function";
}

function isCliSuiteRouter(value: unknown): value is CliSuiteRouter {
  return typeof value === "function";
}

type BenchmarkRunScript = (options?: { args?: string[] }) => Promise<unknown>;

function isBenchmarkRunScript(value: unknown): value is BenchmarkRunScript {
  return typeof value === "function";
}

describe("benchmark-owned all-verb aggregate reports", { concurrency: false }, () => {
  it("builds a deterministic aggregate report for an all-verb suite", async () => {
    const report = await buildAllVerbAggregateReport();
    const cases = report.cases;
    const perOperation = report.perOperation;
    const verbs: VerbName[] = ["schema", "run", "operation-wait", "read", "find-files", "grep", "grep-code"];

    assert.equal(typeof report.elapsedMs, "number");
    assert.equal(report.elapsedMs, 75);
    assert.equal(typeof report.concurrency, "number");
    assert.ok(report.concurrency >= 1);

    assert.equal(cases.length, 7);
    assert.deepEqual(cases.map((entry) => entry.name), verbs);
    for (const caseEntry of cases) {
      assert.equal(typeof caseEntry.ok, "boolean");
      assert.equal(caseEntry.ok, true);
      assert.equal(typeof caseEntry.elapsedMs, "number");
      assert.equal(caseEntry.elapsedMs, 5);
      assert.equal(typeof caseEntry.timings, "object");
      assert.notEqual(caseEntry.timings, null);
      const cliDetail = caseEntry.cliPerf ?? caseEntry.cliPerfDetail ?? caseEntry.perf ?? caseEntry.perfDetail;
      if (cliDetail !== undefined) {
        assert.equal(typeof cliDetail, "object");
        assert.notEqual(cliDetail, null);
      }
    }

    assert.equal(typeof report.totals, "object");
    assert.notEqual(report.totals, null);
    assert.deepEqual(report.totals, { pass: 7, fail: 0 });

    assert.equal(Object.keys(perOperation).length, 7);
    for (const verb of verbs) {
      assert.ok(verb in perOperation, `expected perOperation entry for ${verb}`);
      const operationEntry = perOperation[verb];
      assert.equal(typeof operationEntry.elapsedMs, "number");
      assert.equal(operationEntry.elapsedMs, 5);
      assert.equal(operationEntry.ok, true);
      assert.equal(typeof operationEntry.timings, "object");
      assert.notEqual(operationEntry.timings, null);
      const cliDetail = operationEntry.cliPerf ?? operationEntry.cliPerfDetail ?? operationEntry.perf ?? operationEntry.perfDetail;
      if (cliDetail !== undefined) {
        assert.equal(typeof cliDetail, "object");
        assert.notEqual(cliDetail, null);
      }
    }
  });

  // One real all-verb suite is enough: the CLI route calls
  // runRealAllVerbBenchmarkSuite. A second direct API run only doubled wall time.
  it("routes --suite all-verbs through the CLI while preserving compatibility fields", async () => {
    const router = await resolveCliSuiteRouter();
    assert.ok(router !== undefined, "expected benchmark module to expose a CLI suite router");

    const report = await router(["--suite", "all-verbs", "--operation-id", "cli-op"]);
    const verbs: VerbName[] = ["schema", "run", "operation-wait", "read", "find-files", "grep", "grep-code"];

    assert.equal(report.suite, "all-verbs");
    assert.equal(report.operationId, "cli-op");
    assert.equal(report.status, "pass");
    assert.equal(report.totals.pass, 7);
    assert.equal(report.totals.fail, 0);
    assert.equal(report.cases.length, 7);
    assert.deepEqual(report.cases.map((entry) => entry.name), verbs);
    for (const caseEntry of report.cases) {
      assert.equal(caseEntry.ok, true);
      assert.equal(typeof caseEntry.elapsedMs, "number");
      assert.ok(caseEntry.elapsedMs >= 0);
    }
    assert.deepEqual(Object.keys(report.perOperation).sort(), verbs.slice().sort());
    for (const verb of verbs) {
      assert.equal(report.perOperation[verb].ok, true);
    }
    assert.equal(typeof report.startedAt, "string");
    assert.equal(typeof report.endedAt, "string");
    assert.equal(typeof report.durationMs, "number");
    assert.equal(typeof report.elapsedMs, "number");
  });

  it("routes search benchmarking through the all-verbs suite and retires xray-small", async () => {
    const benchmarkModule = await loadBenchmarkModule();
    const runBenchmarkScript = benchmarkModule.runBenchmarkScript;
    if (!isBenchmarkRunScript(runBenchmarkScript)) {
      throw new Error("expected benchmark module to expose runBenchmarkScript");
    }

    await assert.rejects(
      () => runBenchmarkScript({ args: ["--command", "xray-small"] }),
      /Unknown --command xray-small/,
    );
  });

  it("keeps single-command benchmark compatibility", async () => {
    const report = await buildSpeedifyCompatiblePerfReport({
      operationName: "schema",
      operationId: "compat-schema",
      startedAt: "2024-01-01T00:00:00.000Z",
      endedAt: "2024-01-01T00:00:00.010Z",
      durationMs: 10,
      elapsedMs: 10,
      ok: true,
      timings: { totalMs: 10 },
      perOperation: { schema: { elapsedMs: 10, ok: true, timings: { totalMs: 10 } } },
    });

    assert.equal(report.cases.length, 1);
    assert.equal(report.cases[0].name, "schema");
    assert.equal(report.totals.pass, 1);
    assert.equal(report.totals.fail, 0);
    assert.equal(report.perOperation.schema.elapsedMs, 10);
    assert.equal(report.perOperation.schema.ok, true);
  });
});

async function buildAllVerbAggregateReport(): Promise<BenchmarkPerfReport> {
  const builder = await resolveAllVerbSuiteBuilder();
  if (builder === undefined) {
    throw new Error("expected benchmark module to expose an all-verb suite report builder");
  }

  const request: AllVerbSuiteRequest = {
    suite: "all-verbs",
    verbs: ["schema", "run", "operation-wait", "read", "find-files", "grep", "grep-code"],
    fixtureData: {
      root: "/in-memory-fixture",
      files: [{ path: "/in-memory-fixture/sample.txt", contents: "alpha\n" }],
      operationId: "fixture-op",
    },
    operationRunners: {
      schema: async () => ({ ok: true, payload: { verb: "schema" }, perf: { operationId: "schema-op" } }),
      run: async () => ({ ok: true, payload: { verb: "run" } }),
      "operation-wait": async () => ({ ok: true, payload: { verb: "operation-wait" } }),
      read: async () => ({ ok: true, payload: { verb: "read" } }),
      "find-files": async () => ({ ok: true, payload: { verb: "find-files" } }),
      grep: async () => ({ ok: true, payload: { verb: "grep" } }),
      "grep-code": async () => ({ ok: true, payload: { verb: "grep-code" } }),
    },
    now: (() => {
      let current = 0;
      return () => {
        const value = current;
        current += 5;
        return value;
      };
    })(),
  };

  return await builder(request);
}

async function resolveAllVerbSuiteBuilder(): Promise<AllVerbBuilder | undefined> {
  const benchmarkModule = await loadBenchmarkModule();
  return isAllVerbBuilder(benchmarkModule.runAllVerbBenchmarkSuite)
    ? benchmarkModule.runAllVerbBenchmarkSuite
    : undefined;
}

async function resolveCliSuiteRouter(): Promise<CliSuiteRouter | undefined> {
  const benchmarkModule = await loadBenchmarkModule();
  return isCliSuiteRouter(benchmarkModule.runBenchmarkSuiteFromCliArgs)
    ? benchmarkModule.runBenchmarkSuiteFromCliArgs
    : undefined;
}

async function buildSpeedifyCompatiblePerfReport(options: BenchmarkPerfReportOptions): Promise<BenchmarkPerfReport> {
  const benchmarkModule = await loadBenchmarkModule();
  if (!isCompatBuilder(benchmarkModule.buildSpeedifyCompatiblePerfReport)) {
    throw new Error("expected benchmark module to expose buildSpeedifyCompatiblePerfReport");
  }
  return benchmarkModule.buildSpeedifyCompatiblePerfReport(options);
}

async function loadBenchmarkModule(): Promise<Record<string, unknown>> {
  const moduleUrl = new URL("../../scripts/benchmark-atrium.mjs", import.meta.url).href;
  const benchmarkModule: unknown = await import(moduleUrl);
  if (typeof benchmarkModule !== "object" || benchmarkModule === null) {
    throw new Error("expected benchmark module exports");
  }
  return benchmarkModule as Record<string, unknown>;
}
