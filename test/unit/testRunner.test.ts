import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error — run.mjs is plain JS with no type declarations.
import { discoverTestFiles, parseTapCounts } from "../run.mjs";

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
