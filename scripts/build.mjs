import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
  execSync("npm run build:native", { stdio: "inherit" });
}

execSync("npx tsc", { stdio: "inherit" });
