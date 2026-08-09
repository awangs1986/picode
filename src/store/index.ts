import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { atomicWriteFile, withFileLock } from "../shared/fs.ts";
import { dataPaths, picodeDir } from "../shared/paths.ts";
import type {
  AccountRef,
  HistoricalCompatibility,
  Result,
  SourceToolSignature,
  SourceRef,
  StorePort,
  TaskCapsule,
  TaskTodoState,
} from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";
import type { ForeignTranscriptIR } from "../shared/import-ir.ts";
import { ImportCompiler } from "./import-compiler.ts";
import type { CompiledTranscript } from "./import-compiler.ts";
import { StateFile } from "./state-file.ts";

export { AccountsManager } from "./accounts.ts";
export type { AccountCredentials, OAuthFlow, StoredAccount } from "./accounts.ts";
export { DEFAULT_CONFIG, loadConfig, saveConfig, stripJsonComments } from "./config.ts";
export type { PicodeConfig } from "./config.ts";
export { StateFile } from "./state-file.ts";
export { loadCapabilitySettings, saveCapabilitySettings } from "./capabilities.ts";
export { ImportCompiler } from "./import-compiler.ts";
export type { CompiledTranscript, MappingManifest, NormalizedEvent } from "./import-compiler.ts";
export { adapterFor, BUILTIN_ADAPTERS, ClaudeCodeAdapter, CodexAdapter, CursorAdapter, repairPairing } from "./import-adapters.ts";
export type { SourceAdapter } from "./import-adapters.ts";
export { buildCompatReport, renderCompatReport } from "./import-report.ts";
export type { CompatReport, ContinueStatus } from "./import-report.ts";

/**
 * Store：文件权威的读写纪律 + 账号引用 + 目录索引 + ImportCompiler。
 * 会话本体不归 Store 管——vendored pi 的 JSONL 池是唯一会话权威。
 *
 * 账号（Q4/Q14）：Picode 自己管理 OAuth 流与凭据；accounts.json 0600。
 * AccountRef 是无秘密投影，凭据本体在 vault 分区（P1 实装 OAuth 流）。
 *
 * catalog/ 仍只允许作为可重建投影；来源 Adapter 在核心外解析，Store 的
 * ImportCompiler 与 persistImport 负责校验后的编译/入库。备份属于后续独立能力。
 */
export class Store implements StorePort {
  /** 懒加载：正常聊天不付映射表的加载成本 */
  private compiler: ImportCompiler | undefined;

  async listAccounts(): Promise<Result<AccountRef[]>> {
    const path = dataPaths.accounts();
    if (!existsSync(path)) return ok([]);
    try {
      return ok(JSON.parse(readFileSync(path, "utf8")) as AccountRef[]);
    } catch (cause) {
      return err("store/accounts-unreadable", `cannot parse ${path}`, cause);
    }
  }

  async saveAccounts(accounts: AccountRef[]): Promise<Result<void>> {
    // 单账号活跃不变量：同 Provider 至多一个 active（Q4）
    const activeByProvider = new Set<string>();
    for (const account of accounts) {
      if (account.status !== "active") continue;
      if (activeByProvider.has(account.provider)) {
        return err(
          "store/multiple-active-accounts",
          `provider ${account.provider} has more than one active account`,
        );
      }
      activeByProvider.add(account.provider);
    }

    // 纪律：共享状态写入 = 文件锁 + 原子写（ADR-0003 决策 6）
    const lock = join(picodeDir(), "accounts.json.lock");
    try {
      await withFileLock(lock, () => {
        atomicWriteFile(dataPaths.accounts(), JSON.stringify(accounts, null, 2));
      });
      return ok(undefined);
    } catch (cause) {
      return err("store/accounts-write-failed", "failed to persist accounts", cause);
    }
  }

  resolveHistorical(sig: SourceToolSignature): HistoricalCompatibility {
    this.compiler ??= new ImportCompiler();
    return this.compiler.resolveHistorical(sig);
  }

  /** 导入会话编译（P3-B）；仅导入路径调用，正常聊天不加载映射表 */
  compileImport(ir: ForeignTranscriptIR): CompiledTranscript {
    this.compiler ??= new ImportCompiler();
    return this.compiler.compile(ir);
  }

  async persistImport(
    sourceAgent: string,
    raw: string,
    ir: ForeignTranscriptIR,
    compiled: CompiledTranscript,
  ): Promise<Result<{ importId: string; path: string }>> {
    const importId = createHash("sha256")
      .update(`${sourceAgent}\0${raw}`)
      .digest("hex")
      .slice(0, 24);
    const path = join(dataPaths.imports(), importId);
    try {
      await withFileLock(`${path}.lock`, () => {
        const sourcePath = join(path, "source.jsonl");
        if (existsSync(sourcePath) && readFileSync(sourcePath, "utf8") !== raw) {
          throw new Error(`immutable import collision: ${importId}`);
        }
        atomicWriteFile(sourcePath, raw, { mode: 0o600 });
        atomicWriteFile(join(path, "ir.json"), JSON.stringify(ir, null, 2), { mode: 0o600 });
        atomicWriteFile(join(path, "compiled.json"), JSON.stringify(compiled, null, 2), { mode: 0o600 });
      });
      return ok({ importId, path });
    } catch (cause) {
      return err("store/import-persist-failed", `failed to persist import ${importId}`, cause);
    }
  }

  /** unknown-tool 错误钩子的数据来源（外来工具名 → 语义 ID） */
  redirectTable(sourceAgent: string): Record<string, string> {
    this.compiler ??= new ImportCompiler();
    return this.compiler.redirectTable(sourceAgent);
  }

  async saveCapsule(capsule: TaskCapsule): Promise<Result<void>> {
    const path = join(dataPaths.tasks(), capsule.taskId, "capsules", `${capsule.capsuleId}.json`);
    return new StateFile(path, isTaskCapsule).write(capsule);
  }

  loadTaskTodos(taskId: string): Promise<Result<TaskTodoState>> {
    return new StateFile(
      join(dataPaths.tasks(), taskId, "todos.json"),
      isTaskTodoState,
    ).read();
  }

  saveTaskTodos(state: TaskTodoState): Promise<Result<void>> {
    return new StateFile(
      join(dataPaths.tasks(), state.taskId, "todos.json"),
      isTaskTodoState,
    ).write(state);
  }

  loadTaskVerificationRefs(taskId: string): Result<SourceRef[]> {
    const root = dataPaths.evidence();
    if (!existsSync(root)) return ok([]);
    try {
      const refs: SourceRef[] = [];
      for (const file of readdirSync(root).filter((name) => name.endsWith(".jsonl")).sort()) {
        const lines = readFileSync(join(root, file), "utf8").split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (line === undefined || line.trim() === "") continue;
          try {
            const event = JSON.parse(line) as { taskId?: unknown; kind?: unknown };
            if (event.taskId !== taskId || typeof event.kind !== "string") continue;
            if (!event.kind.startsWith("tdd.") && !event.kind.startsWith("gate.") &&
              !event.kind.startsWith("completion")) continue;
            const digest = createHash("sha256").update(line).digest("hex");
            refs.push({
              kind: "evidence",
              id: digest.slice(0, 24),
              locator: `evidence/${file}#L${index + 1}`,
              sourceDigest: digest,
            });
          } catch {
            // Evidence is append-only. A malformed row is ignored, never rewritten.
          }
        }
      }
      return ok(refs);
    } catch (cause) {
      return err("store/evidence-unreadable", `cannot read task evidence for ${taskId}`, cause);
    }
  }
}

function isTaskCapsule(value: unknown): value is TaskCapsule {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Partial<TaskCapsule>;
  return row.schemaVersion === "picode.capsule/v1" &&
    typeof row.capsuleId === "string" && typeof row.taskId === "string" &&
    typeof row.taskRevision === "number" && row.status !== undefined &&
    ["draft", "sealed", "superseded"].includes(row.status) &&
    typeof row.createdAt === "string" && typeof row.intent === "string" &&
    Array.isArray(row.verbatimFacts) && Array.isArray(row.decisions) &&
    Array.isArray(row.filesTouched) && Array.isArray(row.openQuestions) &&
    Array.isArray(row.nextSteps) && Array.isArray(row.verificationRefs) &&
    typeof row.narrative === "string" &&
    (row.status === "draft" ? row.digest === undefined : typeof row.digest === "string");
}

function isTaskTodoState(value: unknown): value is TaskTodoState {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Partial<TaskTodoState>;
  if (row.version !== 1 || typeof row.taskId !== "string" ||
    typeof row.updatedAt !== "string" || !Array.isArray(row.items)) return false;
  return row.items.every((item) => typeof item === "object" && item !== null &&
    typeof item.id === "string" && typeof item.content === "string" &&
    ["pending", "in_progress", "completed"].includes(String(item.status)));
}
