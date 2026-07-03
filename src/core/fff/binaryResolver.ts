import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

import { type ResolvedFffManifest, selectFffManifest } from './manifest.js';
import { getFffStatePaths, type FffStatePaths } from './state.js';

export interface FffBinaryDownloader {
  download(manifest: ResolvedFffManifest, cacheDir: string): Promise<string | undefined> | string | undefined;
}

export interface ResolveFffBinaryExecutablePathOptions {
  rootPath?: string | null;
  platform?: string;
  arch?: string;
  downloader?: FffBinaryDownloader;
  manifest?: ResolvedFffManifest;
  statePaths?: FffStatePaths;
}

export class FffBinaryResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FffBinaryResolverError';
  }
}

function normalizeChecksumValue(checksum: string): string {
  return checksum.startsWith('sha256:') ? checksum.slice(7) : checksum;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function computeFileChecksum(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const contents = await fs.readFile(filePath);
  hash.update(contents);
  return hash.digest('hex');
}

async function ensureChecksum(filePath: string, checksum: string): Promise<void> {
  const expected = normalizeChecksumValue(checksum);
  const actual = await computeFileChecksum(filePath);

  if (actual !== expected) {
    throw new FffBinaryResolverError(
      `Checksum mismatch for ${filePath}: expected ${expected} but got ${actual}`,
    );
  }
}

export async function resolveFffBinaryExecutablePath(
  options: ResolveFffBinaryExecutablePathOptions = {},
): Promise<string> {
  const manifest = options.manifest ?? selectFffManifest(options.platform, options.arch);
  const statePaths = options.statePaths ?? getFffStatePaths(options.rootPath ?? process.cwd());
  const cacheDir = path.join(statePaths.binaryCachePath, manifest.version);
  const executablePath = path.join(cacheDir, manifest.binaryName);
  const assetPath = path.join(cacheDir, `${manifest.binaryName}.asset`);

  await fs.mkdir(cacheDir, { recursive: true });

  const hasCachedAsset = await fileExists(assetPath);
  const hasCachedExecutable = await fileExists(executablePath);

  if (hasCachedAsset && hasCachedExecutable) {
    await ensureChecksum(assetPath, manifest.checksum);
    return executablePath;
  }

  if (!options.downloader) {
    throw new FffBinaryResolverError(
      `No downloader configured for ${manifest.binaryName}; cannot populate ${executablePath}`,
    );
  }

  const downloadedAssetPath = await options.downloader.download(manifest, cacheDir);
  const resolvedAssetPath = downloadedAssetPath
    ? path.isAbsolute(downloadedAssetPath)
      ? downloadedAssetPath
      : path.resolve(cacheDir, downloadedAssetPath)
    : assetPath;

  if (!(await fileExists(resolvedAssetPath))) {
    throw new FffBinaryResolverError(`Missing asset after download at ${resolvedAssetPath}`);
  }

  await ensureChecksum(resolvedAssetPath, manifest.checksum);

  if (!(await fileExists(executablePath))) {
    throw new FffBinaryResolverError(`Missing executable after download at ${executablePath}`);
  }

  return executablePath;
}
