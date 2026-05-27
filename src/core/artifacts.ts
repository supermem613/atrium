import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface OutputArtifact {
  stdoutPath?: string;
  stderrPath?: string;
  stdoutBytes?: number;
  stderrBytes?: number;
}

export async function writeRunArtifacts(stdout: Buffer, stderr: Buffer): Promise<OutputArtifact> {
  const directory = join(tmpdir(), "atrium", "runs", randomUUID());
  const artifact: OutputArtifact = {};
  const writes: Array<Promise<void>> = [];

  if (stdout.byteLength > 0) {
    await mkdir(directory, { recursive: true });
    artifact.stdoutPath = join(directory, "stdout.txt");
    artifact.stdoutBytes = stdout.byteLength;
    writes.push(writeFile(artifact.stdoutPath, stdout));
  }

  if (stderr.byteLength > 0) {
    await mkdir(directory, { recursive: true });
    artifact.stderrPath = join(directory, "stderr.txt");
    artifact.stderrBytes = stderr.byteLength;
    writes.push(writeFile(artifact.stderrPath, stderr));
  }

  await Promise.all(writes);
  return artifact;
}

export function previewBuffer(buffer: Buffer, maxBytes: number): string {
  return buffer.subarray(0, Math.max(0, maxBytes)).toString("utf8");
}
