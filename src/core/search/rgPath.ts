import { createRequire } from "node:module";

export type BundledRgResolver = () => string | null;

const require = createRequire(import.meta.url);

export const resolveBundledRgPath: BundledRgResolver = () => {
  try {
    const mod = require("@vscode/ripgrep") as { rgPath?: string };
    const rgPath = typeof mod.rgPath === "string" && mod.rgPath.length > 0 ? mod.rgPath : null;
    return rgPath;
  } catch {
    return null;
  }
};
