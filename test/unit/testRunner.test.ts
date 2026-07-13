import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error — run.mjs is plain JS with no type declarations.
import { resolveConcurrency, discoverTestFiles, parseTapCounts } from "../run.mjs";

test("resolveConcurrency caps at 4 when cpu count is higher", () => {
  assert.equal(resolveConcurrency({}, 8), 4);
});

test("resolveConcurrency honours ATRIUM_TEST_CONCURRENCY override", () => {
  assert.equal(resolveConcurrency({ ATRIUM_TEST_CONCURRENCY: "2" }, 8), 2);
});

test("discoverTestFiles returns the exact file for a concrete path pattern", () => {
  assert.deepEqual(discoverTestFiles(["test/unit/testRunner.test.ts"]), [
    "test/unit/testRunner.test.ts",
  ]);
});

test("parseTapCounts extracts tests, pass, and fail counts", () => {
  assert.deepEqual(parseTapCounts("# tests 3\n# pass 3\n# fail 0"), {
    tests: 3,
    pass: 3,
    fail: 0,
  });
});
