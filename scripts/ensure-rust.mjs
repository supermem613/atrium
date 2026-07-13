import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { join, delimiter } from "node:path";
import { homedir, tmpdir } from "node:os";

// The native search addon is compiled from a Rust crate, so a fresh clone needs
// a working `cargo`. To let `npm run build` succeed without a separate manual
// toolchain step, this bootstraps the stable Rust toolchain through rustup when
// cargo is absent. It returns the directory that contains cargo so the caller
// can put it on the child process PATH.

const isWindows = process.platform === "win32";
const cargoExe = isWindows ? "cargo.exe" : "cargo";

function cargoOnPath() {
  const probe = spawnSync("cargo", ["--version"], { stdio: "ignore", shell: isWindows });
  return probe.status === 0;
}

function cargoHomeBin() {
  // rustup installs proxies under <home>/.cargo/bin regardless of platform.
  const dir = join(homedir(), ".cargo", "bin");
  return existsSync(join(dir, cargoExe)) ? dir : null;
}

function rustupArch() {
  switch (process.arch) {
    case "arm64":
      return "aarch64";
    case "ia32":
      return "i686";
    default:
      return "x86_64";
  }
}

function installRust() {
  console.log("[build] cargo not found; installing the stable Rust toolchain via rustup.");
  const shared = ["-y", "--profile", "minimal", "--default-toolchain", "stable"];
  if (isWindows) {
    const workDir = mkdtempSync(join(tmpdir(), "atrium-rustup-"));
    const installer = join(workDir, "rustup-init.exe");
    execFileSync(
      "curl.exe",
      ["-sSfL", `https://win.rustup.rs/${rustupArch()}`, "-o", installer],
      { stdio: "inherit" },
    );
    execFileSync(installer, shared, { stdio: "inherit" });
  } else {
    // curl the POSIX installer and hand the flags to its shell entrypoint.
    const script = execFileSync(
      "curl",
      ["--proto", "=https", "--tlsv1.2", "-sSf", "https://sh.rustup.rs"],
      { encoding: "utf8" },
    );
    execFileSync("sh", ["-s", "--", ...shared], { input: script, stdio: ["pipe", "inherit", "inherit"] });
  }
}

// Returns the directory holding cargo when it had to be located or installed, or
// null when cargo is already resolvable on the ambient PATH.
export function ensureCargo() {
  if (cargoOnPath()) {
    return null;
  }
  const existing = cargoHomeBin();
  if (existing) {
    return existing;
  }
  installRust();
  const installed = cargoHomeBin();
  if (!installed) {
    throw new Error(
      "Rust installation completed but cargo was not found under ~/.cargo/bin. Install Rust from https://rustup.rs and re-run `npm run build`.",
    );
  }
  return installed;
}

// Builds a PATH value for a child process that must see a freshly installed
// cargo in the same run. This is deliberate subprocess wiring so the compiler is
// discoverable, not application configuration.
export function pathWithCargo(cargoBinDir) {
  const current = process.env.PATH ?? "";
  if (!cargoBinDir) {
    return current;
  }
  return `${cargoBinDir}${delimiter}${current}`;
}
