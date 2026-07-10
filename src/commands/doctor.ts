import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import chalk from "chalk";

// CheckResult shape is the convention across rotunda/reflux/kash/sp-tools.
// Keep it stable: tooling and `--json` consumers depend on it.
export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

const require = createRequire(import.meta.url);

function checkNode(): CheckResult {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major < 24) {
    return {
      name: "node",
      ok: false,
      detail: `Node ${process.versions.node} (need >=24)`,
      hint: "Install Node 24 or later from https://nodejs.org",
    };
  }
  return { name: "node", ok: true, detail: `Node ${process.versions.node}` };
}

function checkBundledRipgrep(): CheckResult {
  try {
    const mod = require("@vscode/ripgrep") as { rgPath?: string };
    const rgPath = typeof mod.rgPath === "string" && mod.rgPath.length > 0 ? mod.rgPath : null;

    if (rgPath && existsSync(rgPath)) {
      return {
        name: "bundled-ripgrep",
        ok: true,
        detail: `bundled ripgrep resolved and healthy at ${rgPath}`,
      };
    }
  } catch {
    // fall through to failure result below
  }

  return {
    name: "bundled-ripgrep",
    ok: false,
    detail: "bundled ripgrep not resolved",
    hint: "Install the @vscode/ripgrep runtime dependency.",
  };
}

async function runChecks(): Promise<CheckResult[]> {
  return [
    checkNode(),
    checkBundledRipgrep(),
    // Add more checks here. Pattern: each check is a pure function returning
    // CheckResult. Failures should always carry a `hint` with remediation.
  ];
}

export async function doctorCommand(opts: { json?: boolean }): Promise<void> {
  const results = await runChecks();
  const allOk = results.every((r) => r.ok);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: allOk, checks: results }, null, 2) + "\n");
    process.exit(allOk ? 0 : 1);
  }

  console.log(chalk.bold(`atrium doctor\n`));
  for (const r of results) {
    const icon = r.ok ? chalk.green("✓") : chalk.red("✗");
    console.log(`  ${icon} ${r.name.padEnd(20, ".")} ${r.detail}`);
    if (!r.ok && r.hint) {
      console.log(`      ${chalk.dim(r.hint)}`);
    }
  }
  console.log();
  console.log(allOk ? chalk.green("All checks passed.") : chalk.red("One or more checks failed."));
  process.exit(allOk ? 0 : 1);
}
