import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A version bump must keep package.json and the Bun lock in the same release set.
// bun.lock stores the workspace name, not the package version, so the version
// source of truth stays package.json while the lock must still name this package.

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function readJson(relativePath: string): { version?: string; name?: string; packageManager?: string } {
  return JSON.parse(readFileSync(new URL(relativePath, "file://" + repoRoot), "utf8"));
}

test("package.json pins Bun and bun.lock names the same workspace package", () => {
  const pkg = readJson("package.json");
  const lockText = readFileSync(new URL("bun.lock", "file://" + repoRoot), "utf8");

  assert.ok(pkg.version, "expected package.json to declare a version");
  assert.ok(pkg.name, "expected package.json to declare a name");
  assert.match(String(pkg.packageManager ?? ""), /^bun@\d+\.\d+\.\d+$/, "expected packageManager to pin bun");
  assert.equal(existsSync(new URL("package-lock.json", "file://" + repoRoot)), false, "package-lock.json must not remain");

  const escapedName = pkg.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(lockText, new RegExp("\"name\": \"" + escapedName + "\""), "expected bun.lock workspace name to match package.json");
});
