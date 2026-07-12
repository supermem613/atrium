import { existsSync } from "node:fs";
import { createRequire } from "node:module";

export type BundledRgResolver = () => string | null;

export interface RgPathResolutionDeps {
  loadRgPath: () => string | null;
  fileExists: (candidate: string) => boolean;
}

const require = createRequire(import.meta.url);

function defaultLoadRgPath(): string | null {
  try {
    const mod = require("@vscode/ripgrep") as { rgPath?: string };
    return typeof mod.rgPath === "string" && mod.rgPath.length > 0 ? mod.rgPath : null;
  } catch {
    return null;
  }
}

export function resolveBundledRgPathWith(deps: RgPathResolutionDeps): string | null {
  const rgPath = deps.loadRgPath();
  if (rgPath === null) {
    return null;
  }
  // @vscode/ripgrep computes rgPath at load time, but the binary is delivered by a
  // platform optionalDependency that npm can silently omit. A path with no file on disk
  // makes spawn fail with a cryptic ENOENT or exit-code-2. Returning null here routes
  // callers to the clean "ripgrep binary not available" error instead.
  return deps.fileExists(rgPath) ? rgPath : null;
}

export const resolveBundledRgPath: BundledRgResolver = () =>
  resolveBundledRgPathWith({ loadRgPath: defaultLoadRgPath, fileExists: existsSync });
