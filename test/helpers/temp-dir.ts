import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withTempPicodeDir(
  fn: (dir: string) => void | Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "picode-test-"));
  const prev = process.env["PICODE_DIR"];
  process.env["PICODE_DIR"] = dir;
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env["PICODE_DIR"];
    else process.env["PICODE_DIR"] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}
