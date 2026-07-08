import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atriumTempPath } from "./tempPaths.js";

export const defaultInlineOutputLimitBytes = 8192;

export interface FileRef {
  file: string;
  bytes: number;
}

export type OutputValue = string | FileRef;

export interface RunOutput {
  stdout?: OutputValue;
  stderr?: OutputValue;
}

export async function materializeOutputValue(buffer: Buffer, inlineOutputLimitBytes: number, directory: string, fileName: string): Promise<OutputValue> {
  if (buffer.byteLength <= inlineOutputLimitBytes) {
    return buffer.toString("utf8");
  }

  await mkdir(directory, { recursive: true });
  const file = join(directory, fileName);
  await writeFile(file, buffer);
  return { file, bytes: buffer.byteLength };
}

export async function materializeRunOutput(stdout: Buffer, stderr: Buffer, inlineOutputLimitBytes: number): Promise<RunOutput> {
  const directory = atriumTempPath("runs", randomUUID());
  const output: RunOutput = {};

  if (stdout.byteLength > 0) {
    output.stdout = await materializeOutputValue(stdout, inlineOutputLimitBytes, directory, "stdout.txt");
  }

  if (stderr.byteLength > 0) {
    output.stderr = await materializeOutputValue(stderr, inlineOutputLimitBytes, directory, "stderr.txt");
  }

  return output;
}
