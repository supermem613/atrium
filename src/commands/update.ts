import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type CommandResult = {
  stdout: string;
  stderr: string;
};

type SodaEnvelope<TData> = {
  ok?: boolean;
  data?: TData;
  error?: string;
};

type SodaPullOutcome = {
  status?: string;
  worktreeUpdated?: boolean;
};

export type UpdateDeps = {
  repoRoot?: string;
  isGitRepo?: (dir: string) => boolean;
  execCommand?: (command: string, args: string[], cwd: string) => Promise<CommandResult>;
};

export type UpdateResult = {
  repoRoot: string;
  beforeRevision: string | null;
  afterRevision: string | null;
  pulled: boolean;
  alreadyUpToDate: boolean;
  installed: boolean;
  built: boolean;
};

type UpdateOptions = {
  json?: boolean;
};

function defaultIsGitRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

function repoRootFromModule(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

async function defaultExecCommand(command: string, args: string[], cwd: string): Promise<CommandResult> {
  // npm and sd are Windows .cmd shims. execFile cannot launch those without a shell after CVE-2024-27980.
  const needsWindowsShell = process.platform === "win32" && (command === "npm" || command === "sd");
  const result = await execFileAsync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: needsWindowsShell,
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

async function currentRevision(execCommand: NonNullable<UpdateDeps["execCommand"]>, repoRoot: string): Promise<string | null> {
  const result = await execCommand("git", ["rev-parse", "HEAD"], repoRoot);
  return result.stdout.trim() || null;
}

export function gitPullMadeNoChanges(output: string): boolean {
  return /already up[- ]to[- ]date\.?/i.test(output);
}

async function isSodaManagedRepo(execCommand: NonNullable<UpdateDeps["execCommand"]>, repoRoot: string): Promise<boolean> {
  try {
    const result = await execCommand("sd", ["status"], repoRoot);
    const envelope = JSON.parse(result.stdout) as SodaEnvelope<{ summary?: { initialized?: boolean } }>;
    return envelope.ok === true && envelope.data?.summary?.initialized === true;
  } catch {
    return false;
  }
}

function stdoutFromError(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "stdout" in err) {
    const stdout = (err as { stdout?: unknown }).stdout;
    return typeof stdout === "string" ? stdout : undefined;
  }
  return undefined;
}

function parseSodaPull(stdout: string): boolean {
  const envelope = JSON.parse(stdout) as SodaEnvelope<SodaPullOutcome[]>;
  if (envelope.ok !== true) {
    throw new Error(`sd pull failed: ${envelope.error ?? "unknown error"}`);
  }
  if (!Array.isArray(envelope.data)) {
    throw new Error("sd pull failed: missing pull outcomes");
  }
  return envelope.data.some((outcome) => outcome.worktreeUpdated === true);
}

async function pullWithSoda(execCommand: NonNullable<UpdateDeps["execCommand"]>, repoRoot: string): Promise<boolean> {
  try {
    const result = await execCommand("sd", ["pull"], repoRoot);
    return parseSodaPull(result.stdout);
  } catch (err: unknown) {
    const stdout = stdoutFromError(err);
    if (stdout) {
      try {
        return parseSodaPull(stdout);
      } catch (parseErr: unknown) {
        if (parseErr instanceof Error && parseErr.message.startsWith("sd pull failed:")) {
          throw parseErr;
        }
      }
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`sd pull failed: ${detail}`);
  }
}

export async function runSelfUpdate(deps: UpdateDeps = {}): Promise<UpdateResult> {
  const repoRoot = deps.repoRoot ?? repoRootFromModule();
  const isGitRepo = deps.isGitRepo ?? defaultIsGitRepo;
  const execCommand = deps.execCommand ?? defaultExecCommand;

  if (!isGitRepo(repoRoot)) {
    throw new Error("Atrium install directory is not a git repo. Reinstall by cloning the repository, then run npm install and npm link.");
  }

  const beforeRevision = await currentRevision(execCommand, repoRoot);
  const sodaManaged = await isSodaManagedRepo(execCommand, repoRoot);
  let pulled = false;
  if (sodaManaged) {
    pulled = await pullWithSoda(execCommand, repoRoot);
  } else {
    await execCommand("git", ["pull", "--ff-only"], repoRoot);
  }
  const afterRevision = await currentRevision(execCommand, repoRoot);
  const alreadyUpToDate = sodaManaged ? !pulled : beforeRevision === afterRevision;

  if (alreadyUpToDate) {
    return {
      repoRoot,
      beforeRevision,
      afterRevision,
      pulled: false,
      alreadyUpToDate: true,
      installed: false,
      built: false,
    };
  }

  await execCommand("npm", ["install", "--no-audit", "--no-fund"], repoRoot);
  await execCommand("npm", ["run", "build"], repoRoot);
  return {
    repoRoot,
    beforeRevision,
    afterRevision,
    pulled: true,
    alreadyUpToDate: false,
    installed: true,
    built: true,
  };
}

function writeHuman(result: UpdateResult): void {
  process.stdout.write("atrium repo: " + result.repoRoot + "\n");
  if (result.alreadyUpToDate) {
    process.stdout.write("Already up to date. Skipping install and build.\n");
    return;
  }
  process.stdout.write("Pulled new changes. Dependencies installed. Build complete.\n");
}

function writeJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

export async function updateCommand(opts: UpdateOptions = {}): Promise<void> {
  try {
    const result = await runSelfUpdate();
    if (opts.json) {
      writeJson({ ok: true, command: "update", data: result });
    } else {
      writeHuman(result);
    }
  } catch (err: unknown) {
    const hint = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      writeJson({ ok: false, command: "update", error: "UPDATE_FAILED", hint });
    } else {
      process.stderr.write("atrium update failed: " + hint + "\n");
    }
    process.exitCode = 1;
  }
}
