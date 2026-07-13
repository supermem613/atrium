import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ensureCargo, pathWithCargo } from "./ensure-rust.mjs";

// The native addon is a gitignored build artifact, so a fresh clone will not
// have it. Building it is expensive and napi always recompiles, so only build
// it when it is absent. Editing the Rust crate requires an explicit
// `npm run build:native` to force a rebuild.
const addonDir = join(process.cwd(), "crates", "atrium-search");
const hasAddon =
  existsSync(addonDir) && readdirSync(addonDir).some((f) => f.endsWith(".node"));

if (hasAddon) {
  console.log(
    "[build] native addon present, skipping native build. Run `npm run build:native` to force a rebuild.",
  );
} else {
  console.log("[build] native addon missing, building it.");
  // Bootstrap Rust when cargo is missing so `npm install; npm run build` needs
  // no separate toolchain step. When cargo had to be installed this run, put it
  // on the child PATH so napi can find it without a new shell.
  const cargoBinDir = ensureCargo();
  execSync("npm run build:native", {
    stdio: "inherit",
    env: cargoBinDir ? { ...process.env, PATH: pathWithCargo(cargoBinDir) } : process.env,
  });
}

execSync("npx tsc", { stdio: "inherit" });
