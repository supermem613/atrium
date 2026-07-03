import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FFF_MCP_MANIFEST,
  UnsupportedPlatformError,
  selectFffManifest,
} from '../../src/core/fff/manifest.js';

test('maps win32 x64 to the pinned Windows asset', () => {
  const resolved = selectFffManifest('win32', 'x64');

  assert.equal(resolved.platform, 'win32');
  assert.equal(resolved.arch, 'x64');
  assert.equal(resolved.version, FFF_MCP_MANIFEST.version);
  assert.equal(resolved.binaryName, 'fff-mcp.exe');
  assert.equal(resolved.url, FFF_MCP_MANIFEST.platformAssets.win32.x64?.url);
  assert.equal(resolved.checksum, FFF_MCP_MANIFEST.platformAssets.win32.x64?.checksum);
});

test('throws a typed error for unsupported platforms or architectures', () => {
  assert.throws(
    () => selectFffManifest('freebsd', 'x64'),
    (error: unknown) => {
      if (!(error instanceof UnsupportedPlatformError)) {
        return false;
      }
      assert.equal(error.platform, 'freebsd');
      assert.equal(error.arch, 'x64');
      return true;
    },
  );
});
