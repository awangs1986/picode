import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { atomicWriteFile, withFileLock } from "../shared/fs.ts";
import { dataPaths } from "../shared/paths.ts";
import type {
  HistoricalCompatibility,
  Result,
  SourceToolSignature,
  SourceRef,
  StorePort,
  ContextArtifactInput,
  ContextArtifactRef,
  ContextCompilationManifest,
  ContextLedgerEntry,
  EndpointContextProfile,
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

function isContextLedgerEntry(value: unknown): value is ContextLedgerEntry {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Partial<ContextLedgerEntry>;
  return row.schemaVersion === "picode.context-ledger/v1" &&
    typeof row.eventId === "string" && typeof row.recordedAt === "string" &&
    typeof row.sessionId === "string" && typeof row.sessionRevision === "string" &&
    typeof row.layer === "string" && typeof row.action === "string" &&
    typeof row.sourceDigest === "string" && typeof row.requestOnly === "boolean";
}

function parseContextLedger(text: string): ContextLedgerEntry[] {
  if (text.trim() === "") return [];
  return text.split(/\r?\n/).filter((line) => line.trim() !== "").map((line) => {
    const value: unknown = JSON.parse(line);
    if (!isContextLedgerEntry(value)) throw new Error("Context Ledger schema rejected");
    return value;
  });
}

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

  async saveContextArtifact(input: ContextArtifactInput): Promise<Result<ContextArtifactRef>> {
    const sha256 = createHash("sha256").update(input.text).digest("hex");
    const sessionKey = createHash("sha256").update(input.sessionId).digest("hex").slice(0, 24);
    const artifactId = createHash("sha256")
      .update(`${input.sessionId}\0${input.toolCallId}\0${sha256}`)
      .digest("hex")
      .slice(0, 32);
    const path = join(dataPaths.artifacts(), "context", sessionKey, `${artifactId}.txt`);
    try {
      await withFileLock(`${path}.lock`, () => {
        if (existsSync(path)) {
          if (readFileSync(path, "utf8") !== input.text) {
            throw new Error(`context artifact collision: ${artifactId}`);
          }
          return;
        }
        atomicWriteFile(path, input.text, { mode: 0o600 });
      });
      return ok({
        artifactId,
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        path,
        bytes: Buffer.byteLength(input.text, "utf8"),
        sha256,
      });
    } catch (cause) {
      return err("store/artifact-write-failed", `failed to persist context artifact ${artifactId}`, cause);
    }
  }

  async saveContextCompilation(manifest: ContextCompilationManifest): Promise<Result<string>> {
    const sessionKey = createHash("sha256").update(manifest.sessionId).digest("hex").slice(0, 24);
    const revisionKey = createHash("sha256")
      .update(`${manifest.sessionRevision}\0${manifest.inputDigest}`)
      .digest("hex")
      .slice(0, 32);
    const path = join(dataPaths.catalog(), "context-compilations", sessionKey, `${revisionKey}.json`);
    try {
      await withFileLock(`${path}.lock`, () => {
        atomicWriteFile(path, JSON.stringify(manifest, null, 2), { mode: 0o600 });
      });
      return ok(path);
    } catch (cause) {
      return err("store/context-compilation-write-failed", "failed to persist context compilation manifest", cause);
    }
  }

  async appendContextLedger(entry: ContextLedgerEntry): Promise<Result<void>> {
    const sessionKey = createHash("sha256").update(entry.sessionId).digest("hex").slice(0, 24);
    const path = join(dataPaths.metrics(), "context-ledger", `${sessionKey}.jsonl`);
    try {
      await withFileLock(`${path}.lock`, () => {
        const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
        const entries = parseContextLedger(existing);
        if (entries.some((candidate) => candidate.eventId === entry.eventId)) return;
        const next = `${existing.trimEnd()}${existing.trim() === "" ? "" : "\n"}${JSON.stringify(entry)}\n`;
        atomicWriteFile(path, next, { mode: 0o600 });
      });
      return ok(undefined);
    } catch (cause) {
      return err("store/context-ledger-write-failed", "failed to append Context Ledger", cause);
    }
  }

  async listContextLedger(sessionId: string): Promise<Result<ContextLedgerEntry[]>> {
    const sessionKey = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
    const path = join(dataPaths.metrics(), "context-ledger", `${sessionKey}.jsonl`);
    if (!existsSync(path)) return ok([]);
    try {
      return ok(parseContextLedger(readFileSync(path, "utf8")));
    } catch (cause) {
      return err("store/context-ledger-unreadable", "failed to read Context Ledger", cause);
    }
  }

  async loadEndpointContextProfile(routeKey: string): Promise<Result<EndpointContextProfile>> {
    const key = createHash("sha256").update(routeKey).digest("hex");
    return new StateFile(
      join(dataPaths.metrics(), "endpoint-context", `${key}.json`),
      isEndpointContextProfile,
    ).read();
  }

  async saveEndpointContextProfile(profile: EndpointContextProfile): Promise<Result<void>> {
    const key = createHash("sha256").update(profile.routeKey).digest("hex");
    return new StateFile(
      join(dataPaths.metrics(), "endpoint-context", `${key}.json`),
      isEndpointContextProfile,
    ).write(profile);
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

  loadCapsule(taskId: string, capsuleId: string): Promise<Result<TaskCapsule>> {
    return new StateFile(
      join(dataPaths.tasks(), taskId, "capsules", `${capsuleId}.json`),
      isTaskCapsule,
    ).read();
  }

  async loadLatestSealedCapsule(taskId: string): Promise<Result<TaskCapsule | undefined>> {
    const root = join(dataPaths.tasks(), taskId, "capsules");
    if (!existsSync(root)) return ok(undefined);
    try {
      const sealed: TaskCapsule[] = [];
      for (const file of readdirSync(root).filter((name) => name.endsWith(".json")).sort()) {
        const loaded = await new StateFile(join(root, file), isTaskCapsule).read();
        if (!loaded.ok) {
          if (loaded.error.code === "store/state-missing") continue;
          return loaded;
        }
        if (loaded.value.status === "sealed") sealed.push(loaded.value);
      }
      sealed.sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.capsuleId.localeCompare(right.capsuleId));
      return ok(sealed.at(-1));
    } catch (cause) {
      return err("store/capsule-index-failed", `failed to index Capsules for task ${taskId}`, cause);
    }
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
    (row.filesTouchedOmitted === undefined ||
      (Number.isInteger(row.filesTouchedOmitted) && row.filesTouchedOmitted > 0)) &&
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
    ["pending", "in_progress", "completed"].includes(String(item.status)) &&
    (item.verification === undefined || item.verification === "unverified" || item.verification === "verified") &&
    (item.verificationRefs === undefined ||
      (Array.isArray(item.verificationRefs) && item.verificationRefs.every((ref) => typeof ref === "string"))) &&
    (item.verification !== "verified" ||
      (item.status === "completed" && Array.isArray(item.verificationRefs) && item.verificationRefs.length > 0)));
}

function isEndpointContextProfile(value: unknown): value is EndpointContextProfile {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Partial<EndpointContextProfile>;
  return row.schemaVersion === "picode.endpoint-context/v1" &&
    typeof row.routeKey === "string" &&
    (row.verifiedContextWindow === undefined || (Number.isInteger(row.verifiedContextWindow) && row.verifiedContextWindow > 0)) &&
    (row.observedSuccessInputTokens === undefined || (Number.isInteger(row.observedSuccessInputTokens) && row.observedSuccessInputTokens > 0)) &&
    (row.observedOverflowInputTokens === undefined || (Number.isInteger(row.observedOverflowInputTokens) && row.observedOverflowInputTokens > 0));
}
