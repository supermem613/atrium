import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const lockUrl = new URL("../../bun.lock", import.meta.url);
const packageLockUrl = new URL("../../package-lock.json", import.meta.url);

describe("package lock", () => {
  it("uses bun.lock and keeps emnapi peers required by the native build CLI", () => {
    assert.equal(existsSync(packageLockUrl), false, "package-lock.json must not remain after the Bun migration");
    assert.ok(existsSync(lockUrl), "expected bun.lock");

    const lockText = readFileSync(lockUrl, "utf8");

    // Guards the old npm-ci omission case (CI run 29293976143). Bun lock format
    // is text, so assert the peer package names resolve into the lock body.
    for (const name of ["@emnapi/core", "@emnapi/runtime"]) {
      assert.match(lockText, new RegExp(name.replace("/", "\\/")), "missing lock entry for " + name);
    }

    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    assert.match(String(pkg.packageManager ?? ""), /^bun@\d+\.\d+\.\d+$/, "package.json must pin packageManager to bun");

    const bunfig = readFileSync(new URL("../../bunfig.toml", import.meta.url), "utf8");
    assert.match(bunfig, /\[test\]/, "bunfig must configure [test] so bare bun test does not use Bun's runner");
    assert.match(bunfig, /root\s*=\s*"scripts\/bun-test"/, "bun test root must be the node-runner harness");
  });
});
