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
