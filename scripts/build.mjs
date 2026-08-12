import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensureCargo, pathWithCargo } from "./ensure-rust.mjs";

// The native addon is a gitignored build artifact, so a fresh clone will not
// have it. napi always recompiles and the build is expensive, so this skips the
// native build when a .node is already present AND newer than every crate input.
// Editing the crate bumps a source mtime, which makes the built .node stale and
// forces a rebuild here. That invariant keeps a crate edit from silently leaving
// an outdated binary that fails tests until someone remembers `build:native`.
const addonDir = join(process.cwd(), "crates", "atrium-search");

// The inputs a compiled addon must reflect. The next editor must extend this
// list if the crate grows a new build input outside src or the manifests.
const crateInputs = ["src", "Cargo.toml", "Cargo.lock"].map((entry) => join(addonDir, entry));

// Newest mtime under a file or directory tree, or 0 when the path is absent.
function newestMtimeMs(path) {
  if (!existsSync(path)) {
    return 0;
  }
  const stats = statSync(path);
  if (!stats.isDirectory()) {
    return stats.mtimeMs;
  }
  let newest = stats.mtimeMs;
  for (const entry of readdirSync(path)) {
    newest = Math.max(newest, newestMtimeMs(join(path, entry)));
  }
  return newest;
}

const addonFiles = existsSync(addonDir)
  ? readdirSync(addonDir)
    .filter((file) => file.endsWith(".node"))
    .map((file) => join(addonDir, file))
  : [];
const hasAddon = addonFiles.length > 0;
// Compare the oldest built artifact against the newest crate input so a stale
// binary is caught even when several .node files exist for different platforms.
const oldestAddonMtimeMs = hasAddon
  ? Math.min(...addonFiles.map((file) => statSync(file).mtimeMs))
  : 0;
const newestInputMtimeMs = Math.max(0, ...crateInputs.map(newestMtimeMs));
const addonIsStale = hasAddon && newestInputMtimeMs > oldestAddonMtimeMs;

if (hasAddon && !addonIsStale) {
  console.log(
    "[build] native addon present and up to date, skipping native build. Run `bun run build:native` to force a rebuild.",
  );
} else {
  console.log(
    hasAddon
      ? "[build] native addon is older than the Rust crate, rebuilding it."
      : "[build] native addon missing, building it.",
  );
      // Bootstrap Rust when cargo is missing so `bun install; bun run build` needs
  // no separate toolchain step. When cargo had to be installed this run, put it
  // on the child PATH so napi can find it without a new shell.
  const cargoBinDir = ensureCargo();
      execSync("bun run build:native", {
    stdio: "inherit",
    env: cargoBinDir ? { ...process.env, PATH: pathWithCargo(cargoBinDir) } : process.env,
  });
}

    execSync("bunx tsc", { stdio: "inherit" });
