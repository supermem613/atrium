import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

type VerbName = "schema" | "run" | "operation-wait" | "read" | "find-files" | "grep" | "grep-code";

type OperationRunner = (context: { fixtureData: Record<string, unknown>; verb: VerbName; suite: string; operationId: string }) => Promise<Record<string, unknown>>;

type AllVerbSuiteRequest = {
  suite: string;
  verbs: VerbName[];
  fixtureData: Record<string, unknown>;
  operationRunners: Record<VerbName, OperationRunner>;
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

function isAllVerbBuilder(value: unknown): value is AllVerbBuilder {
  return typeof value === "function";
}

function isCompatBuilder(value: unknown): value is (options: BenchmarkPerfReportOptions) => BenchmarkPerfReport {
  return typeof value === "function";
}

describe("benchmark-owned all-verb aggregate reports", { concurrency: false }, () => {
  it("builds a deterministic aggregate report for an all-verb suite", async () => {
    const report = await buildAllVerbAggregateReport();
    const cases = report.cases;
    const perOperation = report.perOperation;
    const verbs: VerbName[] = ["schema", "run", "operation-wait", "read", "find-files", "grep", "grep-code"];

    assert.equal(typeof report.elapsedMs, "number");
    assert.ok(report.elapsedMs >= 0);
    assert.equal(typeof report.concurrency, "number");
    assert.ok(report.concurrency >= 1);

    assert.equal(cases.length, 7);
    assert.deepEqual(cases.map((entry) => entry.name), verbs);
    for (const caseEntry of cases) {
      assert.equal(typeof caseEntry.ok, "boolean");
      assert.equal(caseEntry.ok, true);
      assert.equal(typeof caseEntry.elapsedMs, "number");
      assert.ok(caseEntry.elapsedMs >= 0);
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
      schema: async () => ({ ok: true, payload: { verb: "schema" } }),
      run: async () => ({ ok: true, payload: { verb: "run" } }),
      "operation-wait": async () => ({ ok: true, payload: { verb: "operation-wait" } }),
      read: async () => ({ ok: true, payload: { verb: "read" } }),
      "find-files": async () => ({ ok: true, payload: { verb: "find-files" } }),
      grep: async () => ({ ok: true, payload: { verb: "grep" } }),
      "grep-code": async () => ({ ok: true, payload: { verb: "grep-code" } }),
    },
  };

  return await builder(request);
}

async function resolveAllVerbSuiteBuilder(): Promise<AllVerbBuilder | undefined> {
  // @ts-expect-error - benchmark-atrium.mjs does not ship authoring-time declaration metadata in this test context
  const benchmarkModule = await import("../../scripts/benchmark-atrium.mjs");
  const candidates: Array<AllVerbBuilder | undefined> = [
    isAllVerbBuilder(benchmarkModule.buildSpeedifyCompatibleAggregatePerfReport) ? benchmarkModule.buildSpeedifyCompatibleAggregatePerfReport : undefined,
    isAllVerbBuilder(benchmarkModule.buildAllVerbAggregatePerfReport) ? benchmarkModule.buildAllVerbAggregatePerfReport : undefined,
    isAllVerbBuilder(benchmarkModule.buildAllVerbBenchmarkReport) ? benchmarkModule.buildAllVerbBenchmarkReport : undefined,
    isAllVerbBuilder(benchmarkModule.buildAggregatePerfReport) ? benchmarkModule.buildAggregatePerfReport : undefined,
    isAllVerbBuilder(benchmarkModule.buildBenchmarkAggregateReport) ? benchmarkModule.buildBenchmarkAggregateReport : undefined,
    isAllVerbBuilder(benchmarkModule.buildAllVerbSuiteReport) ? benchmarkModule.buildAllVerbSuiteReport : undefined,
    isAllVerbBuilder(benchmarkModule.runAllVerbSuite) ? benchmarkModule.runAllVerbSuite : undefined,
    isAllVerbBuilder(benchmarkModule.runAllVerbBenchmarkSuite) ? benchmarkModule.runAllVerbBenchmarkSuite : undefined,
  ];

  return candidates.find((candidate): candidate is AllVerbBuilder => typeof candidate === "function");
}

async function buildSpeedifyCompatiblePerfReport(options: BenchmarkPerfReportOptions): Promise<BenchmarkPerfReport> {
  // @ts-expect-error - benchmark-atrium.mjs does not ship authoring-time declaration metadata in this test context
  const benchmarkModule = await import("../../scripts/benchmark-atrium.mjs");
  if (!isCompatBuilder(benchmarkModule.buildSpeedifyCompatiblePerfReport)) {
    throw new Error("expected benchmark module to expose buildSpeedifyCompatiblePerfReport");
  }
  return benchmarkModule.buildSpeedifyCompatiblePerfReport(options);
}
