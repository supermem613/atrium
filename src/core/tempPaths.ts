import { tmpdir } from "node:os";
import { join } from "node:path";

export function atriumTempPath(...segments: string[]): string {
  return join(tmpdir(), "atrium", ...segments);
}
