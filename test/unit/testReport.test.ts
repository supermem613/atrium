import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error — run.mjs is plain JS with no type declarations.
import { extractGitHubAnnotations, buildReport } from "../run.mjs";

const failingTap = [
  "TAP version 13",
  "not ok 1 - widget renders the header",
  "  ---",
  "  duration_ms: 3.1",
  "  location: 'test/x.test.ts:12:5'",
  "  error: 'expected true to equal false'",
  "  ...",
  "1..1",
].join("\n");

test("extractGitHubAnnotations emits one ::error annotation with location", () => {
  const annotations = extractGitHubAnnotations(failingTap, "test/x.test.ts");
  assert.equal(annotations.length, 1);
  assert.match(annotations[0], /^::error file=test\/x\.test\.ts,line=12,col=5,title=.*::.*/);
});

test("buildReport aggregates per-file results into a summary and files array", () => {
  const report = buildReport([{ file: "a", tests: 1, pass: 1, fail: 0, durationMs: 5 }]);
  assert.equal(report?.summary?.tests, 1);
  assert.ok(Array.isArray(report?.files));
});

test("buildReport records wall-clock elapsed, concurrency, and slowest file and test views", () => {
  const startedAt = Date.now();
  const report = buildReport([
    {
      file: "a",
      tests: 2,
      pass: 2,
      fail: 0,
      durationMs: 5,
      timings: [
        { name: "alpha", ms: 3 },
        { name: "beta", ms: 2 },
      ],
    },
    {
      file: "b",
      tests: 1,
      pass: 1,
      fail: 0,
      durationMs: 7,
      timings: [{ name: "gamma", ms: 7 }],
    },
  ]);

  const elapsedMs = Date.now() - startedAt;
  assert.equal(typeof report?.summary?.wallClockMs, "number");
  assert.ok(Number.isFinite(report?.summary?.wallClockMs));
  assert.ok((report?.summary?.wallClockMs ?? 0) >= 0);
  assert.ok((report?.summary?.wallClockMs ?? 0) <= elapsedMs + 1000);
  assert.equal(typeof report?.summary?.concurrency, "number");
  assert.ok(Number.isInteger(report?.summary?.concurrency));
  assert.ok((report?.summary?.concurrency ?? 0) > 0);
  assert.ok(Array.isArray(report?.slowestFiles));
  assert.ok(report?.slowestFiles?.length > 0);
  assert.deepEqual(
    report?.slowestFiles?.map((entry: { durationMs: number }) => entry.durationMs),
    [...(report?.slowestFiles ?? [])].sort((left, right) => right.durationMs - left.durationMs).map((entry) => entry.durationMs),
  );
  assert.ok(Array.isArray(report?.slowestTests));
  assert.ok(report?.slowestTests?.length > 0);
  assert.deepEqual(
    report?.slowestTests?.map(({ file, name, ms }: { file: string; name: string; ms: number }) => ({ file, name, ms })),
    [...(report?.slowestTests ?? [])].sort((left, right) => right.ms - left.ms).map(({ file, name, ms }) => ({ file, name, ms })),
  );
});
