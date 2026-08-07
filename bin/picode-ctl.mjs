#!/usr/bin/env node
/**
 * picode-ctl：HTTP+SSE 调试面的第一个客户端（PICODE-V3-DESIGN.md §3.2）。
 * 用法：picode-ctl health | picode-ctl get /v1/sessions
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const picodeDir = process.env.PICODE_DIR ?? join(homedir(), ".picode");

function readOrExit(path, hint) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    console.error(`[picode-ctl] ${hint} (${path})`);
    process.exit(1);
  }
}

const port = readOrExit(join(picodeDir, "api-port"), "debug api not running? missing port file");
const token = readOrExit(join(picodeDir, "api-token"), "missing api token");

const [verb = "health", path] = process.argv.slice(2);
const url = `http://127.0.0.1:${port}${verb === "get" ? path : `/v1/${verb}`}`;

const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
const body = await res.text();
if (!res.ok) {
  console.error(`[picode-ctl] HTTP ${res.status}: ${body}`);
  process.exit(1);
}
try {
  console.log(JSON.stringify(JSON.parse(body), null, 2));
} catch {
  console.log(body);
}
