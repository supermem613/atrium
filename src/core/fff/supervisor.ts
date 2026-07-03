import { createFffMcpClient } from './mcpClient.js';
import { resolveFffBinaryExecutablePath, type ResolveFffBinaryExecutablePathOptions } from './binaryResolver.js';
import { canonicalizeRootPath, getFffStatePaths, type FffStatePaths } from './state.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  FffLaunchArgs,
  FffRootOptions,
  FffToolCallArguments,
  FffToolCallResult,
  FffToolDefinition,
} from './types.js';

export interface FffSupervisorClient {
  connect(rootOptions: FffRootOptions): Promise<void>;
  listTools(): Promise<FffToolDefinition[]>;
  callTool(name: string, args?: FffToolCallArguments): Promise<FffToolCallResult>;
  close(): Promise<void>;
  dispose?(): Promise<void>;
}

export interface FffSupervisorOptions {
  binaryResolver?: (rootPath: string, statePaths: FffStatePaths) => Promise<string>;
  resolveBinaryExecutablePath?: (options: ResolveFffBinaryExecutablePathOptions) => Promise<string>;
  createClient?: (
    rootPath: string,
    launchArgs: FffLaunchArgs,
    statePaths: FffStatePaths,
  ) => Promise<FffSupervisorClient> | FffSupervisorClient;
  maxResidentRoots?: number;
  nowMs?: () => number;
}

export class FffSupervisor {
  private readonly residentClients = new Map<string, FffSupervisorClient>();
  private readonly residentRootLastUsedTimes = new Map<string, number>();
  private readonly maxResidentRoots: number;
  private readonly nowMs: () => number;

  constructor(private readonly options: FffSupervisorOptions = {}) {
    this.maxResidentRoots = Math.max(1, options.maxResidentRoots ?? 4);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async listTools(rootPath: string | null | undefined): Promise<FffToolDefinition[]> {
    const client = await this.getOrCreateClient(rootPath);
    return client.listTools();
  }

  async callTool(
    rootPath: string | null | undefined,
    name: string,
    args: FffToolCallArguments = {},
  ): Promise<FffToolCallResult> {
    const client = await this.getOrCreateClient(rootPath);
    return client.callTool(name, args);
  }

  async close(): Promise<void> {
    const clients = Array.from(this.residentClients.values());
    this.residentClients.clear();
    this.residentRootLastUsedTimes.clear();

    for (const client of clients) {
      await this.closeClient(client);
    }
  }

  async dispose(): Promise<void> {
    await this.close();
  }

  private async getOrCreateClient(rootPath: string | null | undefined): Promise<FffSupervisorClient> {
    const canonicalRoot = canonicalizeRootPath(rootPath);
    const existing = this.residentClients.get(canonicalRoot);
    if (existing) {
      this.touchResidentRoot(canonicalRoot);
      return existing;
    }

    if (this.residentClients.size >= this.maxResidentRoots) {
      await this.evictLeastRecentlyUsedClient();
    }

    const statePaths = getFffStatePaths(canonicalRoot);
    const launchArgs = await this.buildLaunchArgs(canonicalRoot, statePaths);
    const client = await this.createResidentClient(canonicalRoot, launchArgs, statePaths);

    await client.connect({
      rootDir: canonicalRoot,
      command: launchArgs.command,
      args: launchArgs.args,
      cwd: launchArgs.cwd,
    });

    this.residentClients.set(canonicalRoot, client);
    this.touchResidentRoot(canonicalRoot);
    return client;
  }

  private async buildLaunchArgs(rootPath: string, statePaths: FffStatePaths): Promise<FffLaunchArgs> {
    if (this.options.binaryResolver || this.options.resolveBinaryExecutablePath) {
      const executablePath = await this.resolveBinaryExecutablePath(rootPath, statePaths);
      return {
        command: executablePath,
        args: [
          '--no-update-check',
          '--frecency-db',
          statePaths.frecencyDbPath,
          '--history-db',
          statePaths.historyDbPath,
          '--log-file',
          statePaths.logPath,
        ],
        cwd: rootPath,
      };
    }

    return {
      command: process.execPath,
      args: [
        bundledResidentServerPath(),
        '--no-update-check',
        '--frecency-db',
        statePaths.frecencyDbPath,
        '--history-db',
        statePaths.historyDbPath,
        '--log-file',
        statePaths.logPath,
      ],
      cwd: rootPath,
    };
  }

  private touchResidentRoot(rootPath: string): void {
    this.residentRootLastUsedTimes.set(rootPath, this.nowMs());
  }

  private async evictLeastRecentlyUsedClient(): Promise<void> {
    if (this.residentClients.size === 0) {
      return;
    }

    let evictedRoot: string | undefined;
    let evictedAt: number | undefined;

    for (const [rootPath, lastUsedAt] of this.residentRootLastUsedTimes.entries()) {
      if (!this.residentClients.has(rootPath)) {
        continue;
      }

      if (evictedAt === undefined || lastUsedAt < evictedAt) {
        evictedRoot = rootPath;
        evictedAt = lastUsedAt;
      }
    }

    if (!evictedRoot) {
      evictedRoot = this.residentClients.keys().next().value;
    }

    if (evictedRoot === undefined) {
      return;
    }

    const client = this.residentClients.get(evictedRoot);
    if (!client) {
      return;
    }

    this.residentClients.delete(evictedRoot);
    this.residentRootLastUsedTimes.delete(evictedRoot);
    await this.closeClient(client);
  }

  private async resolveBinaryExecutablePath(rootPath: string, statePaths: FffStatePaths): Promise<string> {
    if (this.options.binaryResolver) {
      return this.options.binaryResolver(rootPath, statePaths);
    }

    const resolveBinaryExecutablePath = this.options.resolveBinaryExecutablePath ?? resolveFffBinaryExecutablePath;
    return resolveBinaryExecutablePath({ rootPath, statePaths });
  }

  private async createResidentClient(
    rootPath: string,
    launchArgs: FffLaunchArgs,
    statePaths: FffStatePaths,
  ): Promise<FffSupervisorClient> {
    if (this.options.createClient) {
      return this.options.createClient(rootPath, launchArgs, statePaths);
    }

    return createFffMcpClient();
  }

  private async closeClient(client: FffSupervisorClient): Promise<void> {
    if (typeof client.close === 'function') {
      await client.close();
      return;
    }

    if (typeof client.dispose === 'function') {
      await client.dispose();
    }
  }
}

export function createFffSupervisor(options: FffSupervisorOptions = {}): FffSupervisor {
  return new FffSupervisor(options);
}

function bundledResidentServerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'residentServer.js');
}
