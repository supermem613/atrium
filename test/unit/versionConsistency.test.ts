import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A version bump must update package.json and package-lock.json together. A lock
// that lags the manifest breaks reproducible installs and publish metadata.

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function readJson(relativePath: string): { version?: string; packages?: Record<string, { version?: string }> } {
  return JSON.parse(readFileSync(new URL(relativePath, `file://${repoRoot}`), "utf8"));
}

test("package.json and package-lock.json declare the same version", () => {
  const pkg = readJson("package.json");
  const lock = readJson("package-lock.json");

  assert.ok(pkg.version, "expected package.json to declare a version");
  assert.equal(lock.version, pkg.version, "expected package-lock.json root version to match package.json");
  assert.equal(
    lock.packages?.[""]?.version,
    pkg.version,
    "expected the package-lock.json root package entry to match package.json",
  );
});
