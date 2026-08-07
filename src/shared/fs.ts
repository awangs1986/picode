import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * 文件权威的两条纪律（ADR-0002 + ADR-0003 多进程修订）：
 * 1. 一切共享产品状态写入必须原子写（临时文件 + rename）；
 * 2. 写前必须持有文件锁——多个 pi 进程可以并存，谁都不许裸写。
 * 这两条属于 Guard 的可红 Gate（ADR-0003 决策 6）。
 */

export function atomicWriteFile(
  path: string,
  contents: string,
  opts: { mode?: number } = {},
): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  // mode 在 Windows 上近似生效（只读位）；凭据文件仍额外依赖用户目录 ACL
  writeFileSync(tmp, contents, opts.mode === undefined ? { encoding: "utf8" } : { encoding: "utf8", mode: opts.mode });
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      renameSync(tmp, path);
      return;
    } catch (cause) {
      lastError = cause;
      const code = typeof cause === "object" && cause !== null && "code" in cause
        ? String((cause as { code?: unknown }).code)
        : "";
      if (!new Set(["EPERM", "EBUSY", "EACCES"]).has(code) || attempt === 7) break;
      // Antivirus/indexers can briefly hold the destination on Windows. Keep
      // retrying the atomic rename; never unlink the authority as a fallback.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 * (attempt + 1));
    }
  }
  rmSync(tmp, { force: true });
  throw lastError;
}

const STALE_LOCK_MS = 30_000;

/**
 * 排他锁：独占创建 lockfile，含 pid 与时间戳；超龄锁视为残留并清除。
 * Spike 8：Windows 下 rename/独占创建语义的并发实测。
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  opts: { timeoutMs?: number; retryMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const retryMs = opts.retryMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  mkdirSync(dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd);
      break;
    } catch {
      if (existsSync(lockPath)) {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > STALE_LOCK_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`file lock timeout: ${lockPath}`);
      }
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }

  try {
    return await fn();
  } finally {
    rmSync(lockPath, { force: true });
  }
}
