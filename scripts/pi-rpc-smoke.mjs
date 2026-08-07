#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runRpcBootSmoke } from "./rpc-boot-smoke.mjs";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const scratch = mkdtempSync(join(tmpdir(), "picode-rpc-smoke-"));
try {
  await runRpcBootSmoke({
    launcher: join(root, "bin", "picode.mjs"),
    cwd: root,
    env: { ...process.env, PICODE_DIR: join(scratch, "data") },
  });
  console.log("real Pi RPC boot/navigation smoke OK");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
