import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error — run.mjs is plain JS with no type declarations.
import { discoverTestFiles, parseTapCounts, resolveTestPatterns } from "../run.mjs";

test("discoverTestFiles returns the exact file for a concrete path pattern", () => {
  assert.deepEqual(discoverTestFiles(["test/unit/testRunner.test.ts"]), [
    "test/unit/testRunner.test.ts",
  ]);
});

test("resolveTestPatterns keeps every pattern a shell expanded onto the command line", () => {
  assert.deepEqual(
    resolveTestPatterns([
      "node",
      "test/run.mjs",
      "test/integration/find-files-native.test.ts",
      "test/unit/packageLock.test.ts",
      "test/unit/testRunner.test.ts",
    ]),
    [
      "test/integration/find-files-native.test.ts",
      "test/unit/packageLock.test.ts",
      "test/unit/testRunner.test.ts",
    ],
  );
});

test("resolveTestPatterns falls back to the whole suite when no pattern is given", () => {
  assert.deepEqual(resolveTestPatterns(["node", "test/run.mjs"]), ["test/**/*.test.ts"]);
});

test("discoverTestFiles expands every shell-expanded path argument", () => {
  const expanded = [
    "test/integration/find-files-native.test.ts",
    "test/unit/packageLock.test.ts",
    "test/unit/testRunner.test.ts",
  ];
  assert.deepEqual(discoverTestFiles(resolveTestPatterns(["node", "test/run.mjs", ...expanded])), expanded);
});

test("parseTapCounts extracts tests, pass, and fail counts", () => {
  assert.deepEqual(parseTapCounts("# tests 3\n# pass 3\n# fail 0"), {
    tests: 3,
    pass: 3,
    fail: 0,
  });
});
