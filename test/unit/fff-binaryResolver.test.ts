import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  FffBinaryResolverError,
  resolveFffBinaryExecutablePath,
} from '../../src/core/fff/binaryResolver.js';
import { selectFffManifest, type ResolvedFffManifest } from '../../src/core/fff/manifest.js';
import { getFffStatePaths } from '../../src/core/fff/state.js';

function createManifestWithPayload(payload: string): ResolvedFffManifest {
  const manifest = selectFffManifest('linux', 'x64');
  return {
    ...manifest,
    checksum: `sha256:${createHash('sha256').update(payload).digest('hex')}`,
  };
}

function createTempHarness() {
  const rootPath = mkdtempSync(path.join(os.tmpdir(), 'atrium-fff-binary-resolver-'));
  const statePaths = getFffStatePaths(rootPath);
  const cacheDir = path.join(statePaths.binaryCachePath, 'v0.1.0');

  return {
    rootPath,
    statePaths,
    cacheDir,
    cleanup: () => rmSync(rootPath, { recursive: true, force: true }),
  };
}

function writeArtifact(filePath: string, contents: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

test('returns the cached executable path when the asset checksum matches', async () => {
  const harness = createTempHarness();

  try {
    const manifest = createManifestWithPayload('cached-payload');
    const assetPath = path.join(harness.cacheDir, `${manifest.binaryName}.asset`);
    const executablePath = path.join(harness.cacheDir, manifest.binaryName);

    writeArtifact(assetPath, 'cached-payload');
    writeArtifact(executablePath, 'cached-executable');

    const resolvedPath = await resolveFffBinaryExecutablePath({
      manifest,
      statePaths: harness.statePaths,
      downloader: {
        download: () => {
          throw new Error('download should not run for a cache hit');
        },
      },
    });

    assert.equal(resolvedPath, executablePath);
  } finally {
    harness.cleanup();
  }
});

test('downloads and caches the binary when the executable is missing', async () => {
  const harness = createTempHarness();

  try {
    const manifest = createManifestWithPayload('downloaded-payload');
    const assetPath = path.join(harness.cacheDir, `${manifest.binaryName}.asset`);
    const executablePath = path.join(harness.cacheDir, manifest.binaryName);
    let downloadCalls = 0;

    const resolvedPath = await resolveFffBinaryExecutablePath({
      manifest,
      statePaths: harness.statePaths,
      downloader: {
        download: (downloadedManifest: ResolvedFffManifest, cacheDir: string) => {
          downloadCalls += 1;
          assert.equal(downloadedManifest.binaryName, manifest.binaryName);
          assert.equal(cacheDir, harness.cacheDir);
          writeArtifact(assetPath, 'downloaded-payload');
          writeArtifact(executablePath, 'downloaded-executable');
          return assetPath;
        },
      },
    });

    assert.equal(downloadCalls, 1);
    assert.equal(resolvedPath, executablePath);
  } finally {
    harness.cleanup();
  }
});

test('throws a loud checksum mismatch error for cached assets', async () => {
  const harness = createTempHarness();

  try {
    const manifest = createManifestWithPayload('expected-payload');
    const assetPath = path.join(harness.cacheDir, `${manifest.binaryName}.asset`);
    const executablePath = path.join(harness.cacheDir, manifest.binaryName);

    writeArtifact(assetPath, 'wrong-payload');
    writeArtifact(executablePath, 'cached-executable');

    await assert.rejects(
      () => resolveFffBinaryExecutablePath({
        manifest,
        statePaths: harness.statePaths,
      }),
      (error: unknown) => {
        if (!(error instanceof FffBinaryResolverError)) {
          return false;
        }
        assert.match(error.message, /Checksum mismatch/);
        return true;
      },
    );

    assert.equal(existsSync(executablePath), true);
  } finally {
    harness.cleanup();
  }
});

test('uses a fake downloader and never reaches network in unit tests', async () => {
  const harness = createTempHarness();

  try {
    const manifest = createManifestWithPayload('network-safe-payload');
    const assetPath = path.join(harness.cacheDir, `${manifest.binaryName}.asset`);
    const executablePath = path.join(harness.cacheDir, manifest.binaryName);
    const globalWithFetch = globalThis as typeof globalThis & { fetch?: typeof fetch };
    const originalFetch = globalWithFetch.fetch;
    let networkCalls = 0;

    globalWithFetch.fetch = async () => {
      networkCalls += 1;
      throw new Error('network calls are forbidden in unit tests');
    };

    try {
      const resolvedPath = await resolveFffBinaryExecutablePath({
        manifest,
        statePaths: harness.statePaths,
        downloader: {
          download: (downloadedManifest: ResolvedFffManifest, cacheDir: string) => {
            assert.equal(downloadedManifest.binaryName, manifest.binaryName);
            assert.equal(cacheDir, harness.cacheDir);
            writeArtifact(assetPath, 'network-safe-payload');
            writeArtifact(executablePath, 'downloaded-executable');
            return assetPath;
          },
        },
      });

      assert.equal(networkCalls, 0);
      assert.equal(resolvedPath, executablePath);
    } finally {
      globalWithFetch.fetch = originalFetch;
    }
  } finally {
    harness.cleanup();
  }
});
