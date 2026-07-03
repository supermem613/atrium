import { createHash } from 'node:crypto';
import path from 'node:path';
import { atriumTempPath } from '../tempPaths.js';

export interface FffStatePaths {
  binaryCachePath: string;
  binCachePath: string;
  frecencyDbPath: string;
  frecencyDatabasePath: string;
  historyDbPath: string;
  historyDatabasePath: string;
  logPath: string;
  logFilePath: string;
  rootHash: string;
  rootPath: string;
  storageRoot: string;
}

export function canonicalizeRootPath(rootPath: string | null | undefined = process.cwd()): string {
  const candidate = rootPath?.trim() ? rootPath : process.cwd();
  const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(candidate);
  const normalized = path.normalize(absolute);
  const resolved = path.resolve(normalized);

  if (process.platform === 'win32') {
    return resolved.toLowerCase();
  }

  return resolved;
}

export function hashRootPath(rootPath: string | null | undefined = process.cwd()): string {
  return createHash('sha256').update(canonicalizeRootPath(rootPath)).digest('hex').slice(0, 16);
}

export function getFffStateStorageRoot(): string {
  return atriumTempPath('fff');
}

export function getFffStatePaths(rootPath: string | null | undefined = process.cwd()): FffStatePaths {
  const canonicalRoot = canonicalizeRootPath(rootPath);
  const rootHash = hashRootPath(canonicalRoot);
  const storageRoot = getFffStateStorageRoot();
  const rootStateDir = path.join(storageRoot, rootHash);

  const binaryCachePath = path.join(rootStateDir, 'binary-cache');
  const frecencyDbPath = path.join(rootStateDir, 'frecency.db');
  const historyDbPath = path.join(rootStateDir, 'history.db');
  const logPath = path.join(rootStateDir, 'fff.log');

  return {
    binaryCachePath,
    binCachePath: binaryCachePath,
    frecencyDbPath,
    frecencyDatabasePath: frecencyDbPath,
    historyDbPath,
    historyDatabasePath: historyDbPath,
    logPath,
    logFilePath: logPath,
    rootHash,
    rootPath: canonicalRoot,
    storageRoot,
  };
}

export const getRootScopedFffStatePaths = getFffStatePaths;
export const getAtriumManagedFffStatePaths = getFffStatePaths;
export const getRootStateHash = hashRootPath;
