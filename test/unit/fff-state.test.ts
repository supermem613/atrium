import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { atriumTempPath } from '../../src/core/tempPaths.js';
import { canonicalizeRootPath, getFffStatePaths, hashRootPath } from '../../src/core/fff/state.js';

test('distinct roots compute different hashes', () => {
  const rootA = path.join('/tmp', 'root-a', 'nested');
  const rootB = path.join('/tmp', 'root-b', 'nested');

  assert.notEqual(hashRootPath(rootA), hashRootPath(rootB));
});

test('equivalent roots normalize consistently', () => {
  const rootA = path.join('/tmp', 'workspace', 'subdir', '..', 'project');
  const rootB = path.join('/tmp', 'workspace', 'project');

  assert.equal(canonicalizeRootPath(rootA), canonicalizeRootPath(rootB));
  assert.equal(hashRootPath(rootA), hashRootPath(rootB));
});

test('returned paths stay under Atrium-managed storage', () => {
  const root = path.join('/tmp', 'generated', 'root');
  const paths = getFffStatePaths(root);
  const storageRoot = atriumTempPath('fff');

  for (const candidate of [paths.binaryCachePath, paths.frecencyDbPath, paths.historyDbPath, paths.logPath]) {
    assert.ok(candidate.startsWith(storageRoot), `${candidate} should be inside ${storageRoot}`);
  }
});
