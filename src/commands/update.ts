import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
  hasSodaWorkspace?: (dir: string) => boolean;
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

/**
 * soda stores one workspace at `<repo>/.sd`. meta.json plus a non-empty repo-id
 * is the same initialized gate soda itself uses, and it does not require `sd`
 * to be on PATH. Worktree installs that share the main `.sd` still rely on the
 * `sd status` probe or the interlock retry below.
 */
export function hasSodaWorkspaceMarkers(dir: string): boolean {
  const workspaceDir = join(dir, ".sd");
  const metaPath = join(workspaceDir, "meta.json");
  const repoIdPath = join(workspaceDir, "repo-id");
  if (!existsSync(metaPath) || !existsSync(repoIdPath)) {
    return false;
  }
  try {
    return readFileSync(repoIdPath, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

async function defaultExecCommand(command: string, args: string[], cwd: string): Promise<CommandResult> {
  // bun, npm, and sd can be Windows .cmd shims. execFile cannot launch those without a shell after CVE-2024-27980.
  // Prefer an explicit cmd.exe argv over shell:true so args are not concatenated under DEP0190.
  const invocation = process.platform === "win32" && (command === "bun" || command === "npm" || command === "sd")
    ? { command: "cmd.exe", args: ["/d", "/s", "/c", command, ...args] }
    : { command, args };
  const result = await execFileAsync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
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

export function isSodaGitInterlockError(message: string): boolean {
  return /sd-powered repo/i.test(message) || /raw git .* blocked/i.test(message);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseSodaStatus(stdout: string): boolean {
  const envelope = JSON.parse(stdout) as SodaEnvelope<{ summary?: { initialized?: boolean } }>;
  return envelope.ok === true && envelope.data?.summary?.initialized === true;
}

async function probeSodaStatus(execCommand: NonNullable<UpdateDeps["execCommand"]>, repoRoot: string): Promise<boolean> {
  try {
    const result = await execCommand("sd", ["status"], repoRoot);
    return parseSodaStatus(result.stdout);
  } catch (err: unknown) {
    const stdout = stdoutFromError(err);
    if (stdout) {
      try {
        return parseSodaStatus(stdout);
      } catch {
        return false;
      }
    }
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
    const detail = errorMessage(err);
    throw new Error(`sd pull failed: ${detail}`);
  }
}

/**
 * Prefer sd when the install repo is soda-managed. Detection uses sd status when
 * available, plus local .sd workspace markers so a missing sd binary cannot be
 * mistaken for a plain checkout. If a non-soda probe still hits soda interlock
 * hooks on pull, retry once with sd pull instead of failing on the blocked write.
 */
export async function runSelfUpdate(deps: UpdateDeps = {}): Promise<UpdateResult> {
  const repoRoot = deps.repoRoot ?? repoRootFromModule();
  const isGitRepo = deps.isGitRepo ?? defaultIsGitRepo;
  const hasSodaWorkspace = deps.hasSodaWorkspace ?? hasSodaWorkspaceMarkers;
  const execCommand = deps.execCommand ?? defaultExecCommand;

  if (!isGitRepo(repoRoot)) {
    throw new Error("Atrium install directory is not a git repo. Reinstall by cloning the repository, then run bun install and bun link.");
  }

  const beforeRevision = await currentRevision(execCommand, repoRoot);
  const sodaByStatus = await probeSodaStatus(execCommand, repoRoot);
  const sodaByMarkers = hasSodaWorkspace(repoRoot);
  const sodaManaged = sodaByStatus || sodaByMarkers;

  let pulledBySoda = false;
  if (sodaManaged) {
    try {
      pulledBySoda = await pullWithSoda(execCommand, repoRoot);
    } catch (err: unknown) {
      const detail = errorMessage(err);
      if (sodaByMarkers && !sodaByStatus) {
        throw new Error(
          `This atrium install is soda-managed, but sd pull failed. Put sd on PATH and rerun atrium update. ${detail}`,
        );
      }
      throw err instanceof Error ? err : new Error(detail);
    }
  } else {
    try {
      await execCommand("git", ["pull", "--ff-only"], repoRoot);
    } catch (err: unknown) {
      const detail = errorMessage(err);
      if (!isSodaGitInterlockError(detail)) {
        throw err instanceof Error ? err : new Error(detail);
      }
      try {
        pulledBySoda = await pullWithSoda(execCommand, repoRoot);
      } catch (sodaErr: unknown) {
        throw new Error(
          `Pull was blocked by soda interlock hooks, and sd pull failed. Put sd on PATH and rerun atrium update. ${errorMessage(sodaErr)}`,
        );
      }
    }
  }

  const afterRevision = await currentRevision(execCommand, repoRoot);
  const alreadyUpToDate = sodaManaged || pulledBySoda
    ? !pulledBySoda
    : beforeRevision === afterRevision;

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

  await execCommand("bun", ["install", "--frozen-lockfile"], repoRoot);
  await execCommand("bun", ["run", "build"], repoRoot);
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
