import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error — run.mjs is plain JS with no type declarations.
import { evaluateBudgets } from "../run.mjs";

const timings = [{ file: "a.test.ts", name: "slow one", ms: 200 }];

test("evaluateBudgets flags a test that exceeds the default budget", () => {
  const budgets = { defaultTestMs: 100, slowThresholdMs: 50, tests: [] };
  const violations = evaluateBudgets(timings, budgets);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].name, "slow one");
  assert.equal(violations[0].budgetMs, 100);
});

test("evaluateBudgets honours a matching per-test override", () => {
  const budgets = {
    defaultTestMs: 100,
    slowThresholdMs: 50,
    tests: [{ file: "a.test.ts", nameIncludes: "slow", maxMs: 500 }],
  };
  const violations = evaluateBudgets(timings, budgets);
  assert.equal(violations.length, 0);
});
