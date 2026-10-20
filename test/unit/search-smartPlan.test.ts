import test from "node:test";
import assert from "node:assert/strict";
import { planSmartSearch } from "../../src/core/search/smartPlan.js";

test("smart plan uses fixed-string defaults for literal queries", () => {
  const plan = planSmartSearch({ query: "needle", regex: false });
  assert.equal(plan.fixedString, true);
  assert.equal(plan.strategy, "fanout");
  assert.deepEqual(plan.lanes.map((lane) => lane.name), ["markdown", "code", "everything"]);
});

test("smart plan narrows extension-like queries to a single lane", () => {
  const plan = planSmartSearch({ query: "README.md", regex: false });
  assert.equal(plan.strategy, "narrowed");
  assert.equal(plan.fixedString, true);
  assert.deepEqual(plan.lanes.map((lane) => lane.name), ["markdown"]);
  assert.equal(plan.fallbackOnZero, true);
});

test("smart plan fans out non-markdown non-code extension queries", () => {
  const plan = planSmartSearch({ query: "package.json", regex: false });
  assert.equal(plan.strategy, "fanout");
  assert.deepEqual(plan.lanes.map((lane) => lane.name), ["markdown", "code", "everything"]);
});

test("smart plan keeps regex searches sequential", () => {
  const plan = planSmartSearch({ query: "needle.*", regex: true });
  assert.equal(plan.strategy, "sequential");
  assert.equal(plan.fixedString, false);
  assert.deepEqual(plan.lanes, []);
  assert.equal(plan.reason, "regex search uses one ripgrep walk");
});

test("smart plan uses one fixed-string walk when positive globs override type lanes", () => {
  for (const query of ["needle", "README.md", "package.json"]) {
    const plan = planSmartSearch({ query, globs: ["!**/vendor/**", "**/*.ts"] });
    assert.equal(plan.strategy, "sequential");
    assert.equal(plan.fixedString, true);
    assert.equal(plan.fallbackOnZero, false);
    assert.deepEqual(plan.lanes, []);
  }
});

test("smart plan preserves type lanes for negation-only globs", () => {
  const plan = planSmartSearch({ query: "needle", globs: ["!**/vendor/**", "#comment", "", " \u0085"] });
  assert.equal(plan.strategy, "fanout");
  assert.deepEqual(plan.lanes.map((lane) => lane.name), ["markdown", "code", "everything"]);
});
