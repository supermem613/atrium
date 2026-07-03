import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { canonicalizeRootPath, type FffStatePaths } from '../../src/core/fff/state.js';
import { createFffSupervisor } from '../../src/core/fff/supervisor.js';
import type { FffLaunchArgs, FffRootOptions, FffToolCallArguments, FffToolCallResult, FffToolDefinition } from '../../src/core/fff/types.js';

class FakeSupervisorClient {
  public connectCalls: FffRootOptions[] = [];
  public listToolsCalls = 0;
  public callHistory: Array<{ name: string; args: FffToolCallArguments }> = [];
  public closeCount = 0;
  public disposeCount = 0;

  constructor(
    public readonly rootPath: string,
    public readonly launchArgs: FffLaunchArgs,
    public readonly statePaths: FffStatePaths,
    private readonly tools: FffToolDefinition[] = [],
    private readonly toolResult: FffToolCallResult = { content: [] },
  ) {}

  async connect(rootOptions: FffRootOptions): Promise<void> {
    this.connectCalls.push(rootOptions);
  }

  async listTools(): Promise<FffToolDefinition[]> {
    this.listToolsCalls += 1;
    return this.tools;
  }

  async callTool(name: string, args: FffToolCallArguments = {}): Promise<FffToolCallResult> {
    this.callHistory.push({ name, args });
    return this.toolResult;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
  }
}

test('reuses a resident client for the same canonical root', async () => {
  const createdClients: FakeSupervisorClient[] = [];
  const supervisor = createFffSupervisor({
    binaryResolver: async () => '/tmp/fff-mcp',
    createClient: (rootPath, launchArgs, statePaths) => {
      const client = new FakeSupervisorClient(rootPath, launchArgs, statePaths);
      createdClients.push(client);
      return client;
    },
  });

  const rootA = path.join(process.cwd(), 'tmp', 'workspace', 'subdir', '..', 'project');
  const rootB = path.join(process.cwd(), 'tmp', 'workspace', 'project');

  await supervisor.listTools(rootA);
  await supervisor.listTools(rootB);
  await supervisor.callTool(rootA, 'echo', { message: 'hi' });
  await supervisor.callTool(rootB, 'echo', { message: 'bye' });

  assert.equal(createdClients.length, 1);
  assert.equal(createdClients[0].listToolsCalls, 2);
  assert.equal(createdClients[0].callHistory.length, 2);
  assert.deepEqual(createdClients[0].callHistory.map((entry) => entry.name), ['echo', 'echo']);
});

test('keeps distinct roots separated', async () => {
  const createdClients: FakeSupervisorClient[] = [];
  const supervisor = createFffSupervisor({
    binaryResolver: async () => '/tmp/fff-mcp',
    createClient: (rootPath, launchArgs, statePaths) => {
      const client = new FakeSupervisorClient(rootPath, launchArgs, statePaths);
      createdClients.push(client);
      return client;
    },
  });

  const rootA = path.join(process.cwd(), 'tmp', 'root-a');
  const rootB = path.join(process.cwd(), 'tmp', 'root-b');

  await supervisor.listTools(rootA);
  await supervisor.listTools(rootB);
  await supervisor.callTool(rootA, 'alpha');
  await supervisor.callTool(rootB, 'beta');

  assert.equal(createdClients.length, 2);
  assert.deepEqual(createdClients.map((client) => client.rootPath), [
    canonicalizeRootPath(rootA),
    canonicalizeRootPath(rootB),
  ]);
  assert.equal(createdClients[0].connectCalls.length, 1);
  assert.equal(createdClients[1].connectCalls.length, 1);
});

test('builds launch args from managed state paths', async () => {
  let recordedLaunchArgs: FffLaunchArgs | undefined;
  const rootPath = path.join(process.cwd(), 'tmp', 'project');

  const supervisor = createFffSupervisor({
    binaryResolver: async (_rootPath, statePaths) => {
      assert.equal(statePaths.rootPath, canonicalizeRootPath(rootPath));
      return '/opt/fff-mcp';
    },
    createClient: (rootPathArg, launchArgs, statePaths) => {
      recordedLaunchArgs = launchArgs;
      return new FakeSupervisorClient(rootPathArg, launchArgs, statePaths);
    },
  });

  await supervisor.listTools(rootPath);

  assert.ok(recordedLaunchArgs);
  assert.deepEqual(recordedLaunchArgs, {
    command: '/opt/fff-mcp',
    args: [
      '--no-update-check',
      '--frecency-db',
      recordedLaunchArgs!.args[2],
      '--history-db',
      recordedLaunchArgs!.args[4],
      '--log-file',
      recordedLaunchArgs!.args[6],
    ],
    cwd: canonicalizeRootPath(rootPath),
  });
  assert.ok(recordedLaunchArgs!.args[2].endsWith('frecency.db'));
  assert.ok(recordedLaunchArgs!.args[4].endsWith('history.db'));
  assert.ok(recordedLaunchArgs!.args[6].endsWith('fff.log'));
});

test('default launch path uses the bundled resident server instead of a runtime downloader', async () => {
  let recordedLaunchArgs: FffLaunchArgs | undefined;
  const supervisor = createFffSupervisor({
    createClient: (rootPath, launchArgs, statePaths) => {
      recordedLaunchArgs = launchArgs;
      return new FakeSupervisorClient(rootPath, launchArgs, statePaths);
    },
  });

  await supervisor.listTools(path.join(process.cwd(), 'tmp', 'project'));

  assert.ok(recordedLaunchArgs);
  assert.equal(recordedLaunchArgs.command, process.execPath);
  assert.equal(recordedLaunchArgs.args[0].endsWith('residentServer.js'), true);
});

test('routes listTools and callTool through the resident client for each root', async () => {
  const createdByRoot = new Map<string, FakeSupervisorClient>();
  const supervisor = createFffSupervisor({
    binaryResolver: async () => '/tmp/fff-mcp',
    createClient: (rootPath, launchArgs, statePaths) => {
      const client = new FakeSupervisorClient(rootPath, launchArgs, statePaths, [{ name: 'root-tool' }]);
      createdByRoot.set(rootPath, client);
      return client;
    },
  });

  const rootA = path.join(process.cwd(), 'tmp', 'root-a');
  const rootB = path.join(process.cwd(), 'tmp', 'root-b');

  const toolsA = await supervisor.listTools(rootA);
  await supervisor.callTool(rootA, 'alpha', { input: 1 });
  const toolsB = await supervisor.listTools(rootB);
  await supervisor.callTool(rootB, 'beta', { input: 2 });

  assert.deepEqual(toolsA, [{ name: 'root-tool' }]);
  assert.deepEqual(toolsB, [{ name: 'root-tool' }]);
  assert.equal(createdByRoot.get(canonicalizeRootPath(rootA))?.callHistory[0]?.name, 'alpha');
  assert.equal(createdByRoot.get(canonicalizeRootPath(rootB))?.callHistory[0]?.name, 'beta');
  assert.equal(createdByRoot.get(canonicalizeRootPath(rootA))?.callHistory[0]?.args.input, 1);
  assert.equal(createdByRoot.get(canonicalizeRootPath(rootB))?.callHistory[0]?.args.input, 2);
});

test('evicts the least-recently-used resident root when the cap is exceeded', async () => {
  const createdClients: FakeSupervisorClient[] = [];
  let now = 1000;
  const supervisor = createFffSupervisor({
    binaryResolver: async () => '/tmp/fff-mcp',
    createClient: (rootPath, launchArgs, statePaths) => {
      const client = new FakeSupervisorClient(rootPath, launchArgs, statePaths);
      createdClients.push(client);
      return client;
    },
    maxResidentRoots: 2,
    nowMs: () => now,
  });

  const rootA = path.join(process.cwd(), 'tmp', 'root-a');
  const rootB = path.join(process.cwd(), 'tmp', 'root-b');
  const rootC = path.join(process.cwd(), 'tmp', 'root-c');

  await supervisor.listTools(rootA);
  now = 2000;
  await supervisor.listTools(rootB);
  now = 3000;
  await supervisor.listTools(rootC);

  assert.equal(createdClients.length, 3);
  assert.equal(createdClients[0].closeCount, 1);
  assert.equal(createdClients[1].closeCount, 0);
  assert.equal(createdClients[2].closeCount, 0);
});

test('closes the evicted client before adding the replacement root', async () => {
  const createdClients: FakeSupervisorClient[] = [];
  let now = 1000;
  const supervisor = createFffSupervisor({
    binaryResolver: async () => '/tmp/fff-mcp',
    createClient: (rootPath, launchArgs, statePaths) => {
      const client = new FakeSupervisorClient(rootPath, launchArgs, statePaths);
      createdClients.push(client);
      return client;
    },
    maxResidentRoots: 1,
    nowMs: () => now,
  });

  const rootA = path.join(process.cwd(), 'tmp', 'root-a');
  const rootB = path.join(process.cwd(), 'tmp', 'root-b');

  await supervisor.listTools(rootA);
  now = 2000;
  await supervisor.listTools(rootB);

  assert.equal(createdClients.length, 2);
  assert.equal(createdClients[0].closeCount, 1);
  assert.equal(createdClients[1].closeCount, 0);
});

test('does not evict resident roots when the pool is under the cap', async () => {
  const createdClients: FakeSupervisorClient[] = [];
  const supervisor = createFffSupervisor({
    binaryResolver: async () => '/tmp/fff-mcp',
    createClient: (rootPath, launchArgs, statePaths) => {
      const client = new FakeSupervisorClient(rootPath, launchArgs, statePaths);
      createdClients.push(client);
      return client;
    },
    maxResidentRoots: 3,
  });

  const rootA = path.join(process.cwd(), 'tmp', 'root-a');
  const rootB = path.join(process.cwd(), 'tmp', 'root-b');

  await supervisor.listTools(rootA);
  await supervisor.listTools(rootB);

  assert.equal(createdClients.length, 2);
  assert.equal(createdClients[0].closeCount, 0);
  assert.equal(createdClients[1].closeCount, 0);
});

test('reusing a root updates its recency so a different root is evicted', async () => {
  const createdClients: FakeSupervisorClient[] = [];
  let now = 1000;
  const supervisor = createFffSupervisor({
    binaryResolver: async () => '/tmp/fff-mcp',
    createClient: (rootPath, launchArgs, statePaths) => {
      const client = new FakeSupervisorClient(rootPath, launchArgs, statePaths);
      createdClients.push(client);
      return client;
    },
    maxResidentRoots: 2,
    nowMs: () => now,
  });

  const rootA = path.join(process.cwd(), 'tmp', 'root-a');
  const rootB = path.join(process.cwd(), 'tmp', 'root-b');
  const rootC = path.join(process.cwd(), 'tmp', 'root-c');

  await supervisor.listTools(rootA);
  now = 2000;
  await supervisor.listTools(rootB);
  now = 3000;
  await supervisor.callTool(rootA, 'echo');
  now = 4000;
  await supervisor.listTools(rootC);

  assert.equal(createdClients.length, 3);
  assert.equal(createdClients[0].closeCount, 0);
  assert.equal(createdClients[1].closeCount, 1);
  assert.equal(createdClients[2].closeCount, 0);
});

test('dispose closes all resident clients and clears the pool', async () => {
  const createdClients: FakeSupervisorClient[] = [];
  const supervisor = createFffSupervisor({
    binaryResolver: async () => '/tmp/fff-mcp',
    createClient: (rootPath, launchArgs, statePaths) => {
      const client = new FakeSupervisorClient(rootPath, launchArgs, statePaths);
      createdClients.push(client);
      return client;
    },
  });

  const rootA = path.join(process.cwd(), 'tmp', 'root-a');
  const rootB = path.join(process.cwd(), 'tmp', 'root-b');

  await supervisor.listTools(rootA);
  await supervisor.listTools(rootB);
  await supervisor.dispose();

  assert.equal(createdClients[0].closeCount, 1);
  assert.equal(createdClients[1].closeCount, 1);

  await supervisor.listTools(rootA);

  assert.equal(createdClients.length, 3);
});
