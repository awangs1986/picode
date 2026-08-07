import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, withFileLock } from "../shared/fs.ts";
import { dataPaths } from "../shared/paths.ts";
import type { Grant, Result } from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";

/**
 * Grant 分级持久化（MODULES.md §2.2）：
 * - 一次性/会话批准绑定精确指纹 → 内存态（session scope，进程结束即失效）；
 * - "永远允许"绑定命令模式不绑指纹 → 持久化到项目/全局，
 *   仍受工作区与破坏性操作上限约束（decide() 里 destructive 恒 ask）。
 *
 * 纪律：只有 pattern 类 Grant 允许持久化——精确指纹跨进程无意义
 * （重算点在工具包装层，进程内有效）。
 */

interface GrantsFile {
  version: 1;
  grants: Grant[];
}

export class GrantStore {
  private session: Grant[] = [];
  private persisted: Grant[] = [];

  /** 项目级 grants 路径由组合根按当前工作区注入；无项目则只有全局 */
  constructor(private readonly projectGrantsPath?: string) {}

  private globalPath(): string {
    return dataPaths.grants();
  }

  load(): Result<void> {
    const files = [this.globalPath(), this.projectGrantsPath].filter(
      (p): p is string => p !== undefined,
    );
    const loaded: Grant[] = [];
    for (const path of files) {
      if (!existsSync(path)) continue;
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as GrantsFile;
        loaded.push(...parsed.grants);
      } catch (cause) {
        return err("guard/grants-unreadable", `cannot parse ${path}`, cause);
      }
    }
    this.persisted = loaded;
    return ok(undefined);
  }

  /** session scope 进内存；project/global 必须是 pattern 类，落盘 */
  async add(grant: Grant): Promise<Result<void>> {
    if (grant.scope === "session") {
      this.session.push(grant);
      return ok(undefined);
    }
    if (grant.kind !== "pattern") {
      return err(
        "guard/fingerprint-grant-not-persistable",
        "only pattern grants may persist beyond the session (MODULES.md §2.2)",
      );
    }
    this.persisted.push(grant);
    return this.persist(grant.scope);
  }

  private async persist(scope: "project" | "global"): Promise<Result<void>> {
    const path = scope === "project" ? this.projectGrantsPath : this.globalPath();
    if (path === undefined) {
      return err("guard/no-project-grants-path", "no project bound; cannot persist project grant");
    }
    const grants = this.persisted.filter((g) => g.scope === scope);
    try {
      await withFileLock(join(`${path}.lock`), () => {
        atomicWriteFile(path, JSON.stringify({ version: 1, grants } satisfies GrantsFile, null, 2));
      });
      return ok(undefined);
    } catch (cause) {
      return err("guard/grants-write-failed", `failed to persist ${scope} grants`, cause);
    }
  }

  all(): readonly Grant[] {
    return [...this.session, ...this.persisted];
  }

  clearSession(): void {
    this.session = [];
  }
}
