import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWriteFile, withFileLock } from "../shared/fs.ts";
import { dataPaths } from "../shared/paths.ts";
import type { Result } from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";

/**
 * Worktree 规则（Q8：R0 §13.2/13.3 原样沿用）：
 * - 同一物理工作目录只允许一个写入任务，其他聊天并行只读；
 * - 需要并行写入时，每个任务进入独立安全分支 + Git Worktree
 *   （pi-subagents 的 worktree 生命周期是 Subagent 隔离的实现）；
 * - 任务完成只提供差异/证据/整合建议，不自动合并主分支、不自动删 worktree。
 *
 * 本文件管注册表与规则；Git 操作本体（worktree add 等）在 Guard 的
 * Git 所有权纪律下由用户确认后执行（P2 作者实装）。
 */

interface WriterRecord {
  workspaceId: string;
  taskId: string;
  pid: number;
  claimedAt: string;
  /** Explicit CLI leases survive the short-lived claimant process until release. */
  persistent?: boolean;
}

interface ManagedWorktreeRecord {
  workspaceId: string;
  taskId: string;
  branch: string;
  path: string;
  createdAt: string;
  /** 完成后保留：不自动删除（R0 §13.3） */
  state: "active" | "completed";
}

interface WorktreeFile {
  version: 1;
  writers: WriterRecord[];
  managed: ManagedWorktreeRecord[];
}

const FILE = "worktrees.json";

export function normalizeWorkspaceId(workspace: string): string {
  const absolute = resolve(workspace).replaceAll("\\", "/").replace(/\/$/, "");
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

export class WorktreeRegistry {
  private path(): string {
    return join(dataPaths.tasks(), FILE);
  }

  private load(): WorktreeFile {
    const path = this.path();
    if (!existsSync(path)) return { version: 1, writers: [], managed: [] };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<WorktreeFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.writers) || !Array.isArray(parsed.managed)) {
      throw new Error(`invalid worktree registry: ${path}`);
    }
    return parsed as WorktreeFile;
  }

  private async mutate<T>(fn: (file: WorktreeFile) => Result<T>): Promise<Result<T>> {
    try {
      return await withFileLock(`${this.path()}.lock`, () => {
        const file = this.load();
        const result = fn(file);
        if (result.ok) {
          atomicWriteFile(this.path(), JSON.stringify(file, null, 2));
        }
        return result;
      });
    } catch (cause) {
      return err("engine/worktree-registry-io", "worktree registry write failed", cause);
    }
  }

  /** 单写手：同一 workspace 已有活跃写手（且进程存活）则拒绝 */
  async claimWriter(workspaceId: string, taskId: string, options: { persistent?: boolean } = {}): Promise<Result<void>> {
    return this.mutate((file) => {
      const existing = file.writers.find(
        (w) => normalizeWorkspaceId(w.workspaceId) === normalizeWorkspaceId(workspaceId),
      );
      if (existing !== undefined) {
        if (existing.taskId === taskId) {
          if (existing.persistent === true || existing.pid === process.pid) return ok(undefined);
          if (isProcessAlive(existing.pid)) {
            return err(
              "engine/workspace-has-writer",
              `workspace ${workspaceId} is already active in another process for task ${taskId}`,
            );
          }
          // The same task is recovering after an abnormal exit. Replace the
          // dead short-lived owner with this process instead of preserving the
          // stale pid through the old idempotent path.
          file.writers = file.writers.filter(
            (w) => normalizeWorkspaceId(w.workspaceId) !== normalizeWorkspaceId(workspaceId),
          );
        } else if (existing.persistent === true || isProcessAlive(existing.pid)) {
          return err(
            "engine/workspace-has-writer",
            `workspace ${workspaceId} is being written by task ${existing.taskId}; ` +
              `use a managed worktree for parallel writes`,
          );
        } else {
          // 残留写手（进程已死）：清除后接管
          file.writers = file.writers.filter(
            (w) => normalizeWorkspaceId(w.workspaceId) !== normalizeWorkspaceId(workspaceId),
          );
        }
      }
      file.writers.push({
        workspaceId,
        taskId,
        pid: process.pid,
        claimedAt: new Date().toISOString(),
        ...(options.persistent === true ? { persistent: true } : {}),
      });
      return ok(undefined);
    });
  }

  async releaseWriter(workspaceId: string, taskId: string): Promise<Result<void>> {
    return this.mutate((file) => {
      file.writers = file.writers.filter(
        (w) => !(normalizeWorkspaceId(w.workspaceId) === normalizeWorkspaceId(workspaceId) && w.taskId === taskId),
      );
      return ok(undefined);
    });
  }

  /**
   * 并行写入：登记 Managed Worktree（分支命名 picode/<taskId>）。
   * 项目首次启用并行写入由用户授权（Guard ask，调用方先裁决）。
   */
  async registerManagedWorktree(
    workspaceId: string,
    taskId: string,
    worktreePath: string,
  ): Promise<Result<ManagedWorktreeRecord>> {
    return this.mutate((file) => {
      const record: ManagedWorktreeRecord = {
        workspaceId,
        taskId,
        branch: `picode/${taskId}`,
        path: worktreePath,
        createdAt: new Date().toISOString(),
        state: "active",
      };
      file.managed.push(record);
      return ok(record);
    });
  }

  /** 完成 = 改状态保留记录；差异/证据/整合建议由 Devloop 出，不自动合并 */
  async completeManagedWorktree(taskId: string): Promise<Result<void>> {
    return this.mutate((file) => {
      const record = file.managed.find((m) => m.taskId === taskId && m.state === "active");
      if (record === undefined) {
        return err("engine/worktree-unknown", `no active managed worktree for task ${taskId}`);
      }
      record.state = "completed";
      return ok(undefined);
    });
  }

  list(): WorktreeFile {
    const file = this.load();
    return {
      ...file,
      // Explicit persistent CLI leases remain visible until release. Runtime
      // leases whose owner died are not active and must not appear as writers.
      writers: file.writers.filter((writer) => writer.persistent === true || isProcessAlive(writer.pid)),
    };
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
