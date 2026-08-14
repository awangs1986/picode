import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface LeaseRecord {
  version: 1;
  ownerId: string;
  pid: number;
  acquiredAt: string;
}

export interface WeixinTokenLeaseHandle {
  release(): void;
}

function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readRecord(path: string): LeaseRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LeaseRecord>;
    return value.version === 1 && typeof value.ownerId === "string" &&
      typeof value.pid === "number" && typeof value.acquiredAt === "string"
      ? value as LeaseRecord
      : undefined;
  } catch {
    return undefined;
  }
}

function defaultLockDirectory(): string {
  const override = process.env["PICODE_RUNTIME_LOCK_DIR"];
  if (override !== undefined && override.trim() !== "") return override;
  if (process.platform === "win32") {
    return join(process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "Picode", "locks");
  }
  return join(process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "picode", "locks");
}

/**
 * Cross-process exclusion for Tencent's single-consumer getupdates cursor.
 * The token is never written to disk: only its SHA-256 digest names the lease.
 */
export class WeixinTokenLease {
  constructor(private readonly directory = defaultLockDirectory()) {}

  acquire(token: string): WeixinTokenLeaseHandle {
    mkdirSync(this.directory, { recursive: true });
    const digest = createHash("sha256").update(token).digest("hex");
    const path = join(this.directory, `poll-${digest}.lock`);
    const record: LeaseRecord = {
      version: 1,
      ownerId: randomUUID(),
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(path, "wx", 0o600);
        try {
          writeFileSync(fd, JSON.stringify(record), { encoding: "utf8" });
        } finally {
          closeSync(fd);
        }
        return {
          release: () => {
            const current = readRecord(path);
            if (current?.ownerId !== record.ownerId) return;
            try { unlinkSync(path); } catch { /* already released */ }
          },
        };
      } catch (cause) {
        const code = cause instanceof Error && "code" in cause
          ? String((cause as NodeJS.ErrnoException).code)
          : "";
        if (code !== "EEXIST") throw cause;
        const current = readRecord(path);
        if (current !== undefined && isAlive(current.pid)) {
          throw new Error(`iLink account is already polled by another Picode process (pid ${current.pid})`);
        }
        try { unlinkSync(path); } catch { /* another contender removed the stale lease */ }
      }
    }
    throw new Error("could not acquire the iLink poll lease");
  }
}
