import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 数据目录解析（ADR-0002 修订 + ADR-0003 Vendored Pi）：
 * ~/.picode/ 完全自包含——含专属 pi agent 目录与会话池。
 * 与系统安装的 pi（~/.pi/）互不相干。
 */

export function picodeDir(): string {
  return process.env["PICODE_DIR"] ?? join(homedir(), ".picode");
}

/** vendored pi 的 agent 目录；启动器以 PI_CODING_AGENT_DIR 注入 */
export function piAgentDir(): string {
  return process.env["PI_CODING_AGENT_DIR"] ?? join(picodeDir(), "agent");
}

export function piSessionsDir(): string {
  return join(piAgentDir(), "sessions");
}

export const dataPaths = {
  config: () => join(picodeDir(), "config.json"),
  accounts: () => join(picodeDir(), "accounts.json"),
  /** 能力目录的用户设置轴（Disabled/Enabled/Trusted，仅用户可改） */
  capabilities: () => join(picodeDir(), "capabilities.json"),
  grants: () => join(picodeDir(), "grants.json"),
  tasks: () => join(picodeDir(), "tasks"),
  evidence: () => join(picodeDir(), "evidence"),
  imports: () => join(picodeDir(), "imports"),
  /** 运行时重定向表：~/.picode/import/toolmap-<source>.json */
  importToolmap: (source: string) => join(picodeDir(), "import", `toolmap-${source}.json`),
  catalog: () => join(picodeDir(), "catalog"),
  artifacts: () => join(picodeDir(), "artifacts"),
  metrics: () => join(picodeDir(), "metrics"),
  runtimeDiagnostics: () => join(picodeDir(), "diagnostics", "runtime-frames.jsonl"),
  apiLock: () => join(picodeDir(), "api.lock"),
  apiToken: () => join(picodeDir(), "api-token"),
  apiPort: () => join(picodeDir(), "api-port"),
  serve: () => join(picodeDir(), "serve"),
  serveLock: () => join(picodeDir(), "serve", "serve.lock"),
  serveIdentityKey: () => join(picodeDir(), "serve", "identity-key.pem"),
  serveIdentityCert: () => join(picodeDir(), "serve", "identity-cert.pem"),
  serveDevices: () => join(picodeDir(), "serve", "devices.json"),
  serveRequests: () => join(picodeDir(), "serve", "requests.json"),
  serveInfo: () => join(picodeDir(), "serve", "active.json"),
  workspaceFence: () => join(picodeDir(), "workspace-fence.json"),
  weixinState: () => join(picodeDir(), "weixin", "state.json"),
};
