import { basename } from "node:path";

const deniedShellNames = new Set([
  "bash",
  "cmd",
  "powershell",
  "pwsh",
  "sh",
  "zsh",
]);

export function normalizeToolName(tool: string): string {
  return basename(tool).toLowerCase().replace(/\.(cmd|exe|bat)$/u, "");
}

export function isDeniedShell(tool: string): boolean {
  return deniedShellNames.has(normalizeToolName(tool));
}

export function shellDenylist(): string[] {
  return [...deniedShellNames].sort();
}

export function needsWindowsCommandShell(tool: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/iu.test(tool);
}
