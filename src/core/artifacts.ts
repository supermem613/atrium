import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface FileRef {
  file: string;
  bytes: number;
}

export type OutputValue = string | FileRef;

export interface RunOutput {
  stdout?: OutputValue;
  stderr?: OutputValue;
}

export async function materializeRunOutput(stdout: Buffer, stderr: Buffer, inlineOutputMaxBytes: number): Promise<RunOutput> {
  const directory = join(tmpdir(), "atrium", "runs", randomUUID());
  const output: RunOutput = {};
  const writes: Array<Promise<void>> = [];

  if (stdout.byteLength > 0) {
    if (stdout.byteLength <= inlineOutputMaxBytes) {
      output.stdout = stdout.toString("utf8");
    } else {
      await mkdir(directory, { recursive: true });
      const file = join(directory, "stdout.txt");
      output.stdout = { file, bytes: stdout.byteLength };
      writes.push(writeFile(file, stdout));
    }
  }

  if (stderr.byteLength > 0) {
    if (stderr.byteLength <= inlineOutputMaxBytes) {
      output.stderr = stderr.toString("utf8");
    } else {
      await mkdir(directory, { recursive: true });
      const file = join(directory, "stderr.txt");
      output.stderr = { file, bytes: stderr.byteLength };
      writes.push(writeFile(file, stderr));
    }
  }

  await Promise.all(writes);
  return output;
}
