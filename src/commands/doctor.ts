import chalk from "chalk";

// CheckResult shape is the convention across rotunda/reflux/kash/sp-tools.
// Keep it stable: tooling and `--json` consumers depend on it.
export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

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

async function runChecks(): Promise<CheckResult[]> {
  return [
    checkNode(),
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
