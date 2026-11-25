import { strict as assert } from "node:assert";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lockUrl = new URL("../../bun.lock", import.meta.url);
const packageLockUrl = new URL("../../package-lock.json", import.meta.url);

function resolveZodImport(specifier: string, containingFile: string, options: ts.CompilerOptions) {
  const { resolvedModule } = ts.resolveModuleName(specifier, containingFile, options, ts.sys);
  assert.ok(resolvedModule, `expected TypeScript to resolve ${specifier} from ${containingFile}`);
  assert.ok(
    resolvedModule.packageId,
    `expected packageId for ${specifier} resolved to ${resolvedModule.resolvedFileName}`,
  );
  const { resolvedFileName, packageId } = resolvedModule;
  assert.ok(
    resolvedFileName.endsWith(packageId.subModuleName),
    `expected ${resolvedFileName} to end with ${packageId.subModuleName}`,
  );
  const packageRoot = realpathSync(
    resolvedFileName.slice(0, resolvedFileName.length - packageId.subModuleName.length),
  );
  return {
    specifier,
    containingFile,
    version: packageId.version,
    packageRoot,
  };
}

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

    // Guards the Ubuntu CI failure in run 34519463750 where Bun launched the
    // native build CLI and it wrote Windows-style transaction backup paths.
    assert.match(
      String(pkg.devDependencies?.["@napi-rs/cli"] ?? ""),
      /^\^3\.9\.\d+$/,
      "@napi-rs/cli must use the maintained 3.9.x line",
    );
    assert.match(
      String(pkg.scripts?.["build:native"] ?? ""),
      /^node node_modules\/@napi-rs\/cli\/dist\/cli\.js build\b/,
      "build:native must launch @napi-rs/cli with Node on POSIX runners",
    );

    const bunfig = readFileSync(new URL("../../bunfig.toml", import.meta.url), "utf8");
    assert.match(bunfig, /\[test\]/, "bunfig must configure [test] so bare bun test does not use Bun's runner");
    assert.match(bunfig, /root\s*=\s*"scripts\/bun-test"/, "bun test root must be the node-runner harness");
  });

  // Guards against split zod installations between Atrium and @modelcontextprotocol/sdk.
  // When src/mcp/surfaces.ts and the SDK resolve zod from different package trees
  // (e.g., root zod@3.x vs nested sdk/node_modules/zod@4.x), TypeScript loses nominal
  // symbol identity at defineTool/ToolCallback and exhausts the V8 heap during tsc.
  it("resolves one shared zod package for Atrium MCP schemas and @modelcontextprotocol/sdk", () => {
    const testTsconfigPath = resolve(repoRoot, "test", "tsconfig.json");
    const readResult = ts.readConfigFile(testTsconfigPath, ts.sys.readFile);
    assert.equal(readResult.error, undefined, "expected test/tsconfig.json to parse cleanly");
    const parsed = ts.parseJsonConfigFileContent(readResult.config, ts.sys, dirname(testTsconfigPath));

    const surfacesPath = resolve(repoRoot, "src", "mcp", "surfaces.ts");
    const sdkZodCompatPath = resolve(
      repoRoot,
      "node_modules",
      "@modelcontextprotocol",
      "sdk",
      "dist",
      "esm",
      "server",
      "zod-compat.d.ts",
    );

    const surfacesZodSpecifiers = ts
      .preProcessFile(readFileSync(surfacesPath, "utf8"), true, true)
      .importedFiles.map((entry) => entry.fileName)
      .filter((spec) => spec === "zod" || spec.startsWith("zod/"));
    const sdkZodSpecifiers = ts
      .preProcessFile(readFileSync(sdkZodCompatPath, "utf8"), true, true)
      .importedFiles.map((entry) => entry.fileName)
      .filter((spec) => spec === "zod" || spec.startsWith("zod/"));

    assert.ok(surfacesZodSpecifiers.length > 0, "expected src/mcp/surfaces.ts to import zod");
    assert.ok(sdkZodSpecifiers.length > 0, "expected @modelcontextprotocol/sdk zod-compat.d.ts to import zod");

    const surfacesResolved = surfacesZodSpecifiers.map((spec) =>
      resolveZodImport(spec, surfacesPath, parsed.options),
    );
    const sdkResolved = sdkZodSpecifiers.map((spec) =>
      resolveZodImport(spec, sdkZodCompatPath, parsed.options),
    );

    const expectedVersion = surfacesResolved[0].version;
    const expectedRoot = surfacesResolved[0].packageRoot;
    const allResolved = [...surfacesResolved, ...sdkResolved];

    assert.deepStrictEqual(
      [...new Set(allResolved.map((item) => item.version))],
      [expectedVersion],
      `Atrium and @modelcontextprotocol/sdk must resolve one shared zod version; got ${allResolved.map((item) => `${item.specifier}@${item.version}`).join(", ")}`,
    );
    assert.deepStrictEqual(
      [...new Set(allResolved.map((item) => item.packageRoot))],
      [expectedRoot],
      `Atrium and @modelcontextprotocol/sdk must resolve zod from the same package directory; got ${allResolved.map((item) => `${item.specifier}->${item.packageRoot}`).join(", ")}`,
    );

    const lockText = readFileSync(lockUrl, "utf8");
    const lockZodVersions = [...lockText.matchAll(/\["zod@([^"]+)"/g)].map((match) => match[1]);
    assert.deepStrictEqual(
      lockZodVersions,
      [expectedVersion],
      `bun.lock must record one shared zod package at ${expectedVersion}; got [${lockZodVersions.join(", ")}]`,
    );
  });
});
