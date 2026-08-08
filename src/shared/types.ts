/**
 * 跨模块共享类型。领域模块之间不得互相 import——协作契约全部经由本目录。
 * 设计出处：PICODE-V3-DESIGN.md §2/§3、docs/design/MODULES.md（R3 修订版）
 */

export type Result<T, E = PicodeError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export interface PicodeError {
  code: string;
  message: string;
  cause?: unknown;
}

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = (code: string, message: string, cause?: unknown): Result<never> => ({
  ok: false,
  error: { code, message, cause },
});

// ---------------------------------------------------------------------------
// Harness 档位（挂在会话，/harness 随时切换；Q1/Q2）
// ---------------------------------------------------------------------------

export type HarnessTier = "simple" | "standard" | "tdd";

// ---------------------------------------------------------------------------
// 权限与 Guard 契约（MODULES.md §2）
// ---------------------------------------------------------------------------

/** 权限三档（UX 预设，不是新引擎） */
export type PermissionTier = "readonly" | "auto" | "full";

export type IntentCategory =
  | "fs-read"
  | "fs-write"
  | "exec"
  | "network"
  | "git-read"
  | "git-mutate" // commit/merge/push/删分支/重写历史——永远需要用户确认
  | "mcp-tool";

/** 一次副作用的结构化请求（原 R0 §10.3 Operation Intent） */
export interface OperationIntent {
  category: IntentCategory;
  /** 规范化后的目标（路径 / 域名 / server:tool） */
  targets: string[];
  /** 精确命令字符串（exec 类） */
  command?: string;
  /** 被引用脚本的内容摘要（sha256），键为规范化路径 */
  scriptDigests?: Record<string, string>;
  cwd?: string;
  /** 已知破坏性操作（rm -rf、force push 等静态判定） */
  destructive?: boolean;
}

export type GrantKind = "fingerprint" | "pattern";

export interface Grant {
  kind: GrantKind;
  /** fingerprint: 精确指纹哈希；pattern: 命令前缀模式（如 "npm test"） */
  value: string;
  scope: "session" | "project" | "global";
}

export type Decision =
  | { verdict: "allow"; reason: string }
  | { verdict: "deny"; reason: string }
  | { verdict: "ask"; reason: string };

// ---------------------------------------------------------------------------
// 三级工具与能力生命周期（PICODE-V3-DESIGN.md §3.4，R3 两轴正交）
// ---------------------------------------------------------------------------

/**
 * 用户设置轴（持久化，仅用户可改）。模型不能执行 Enable/Trust。
 * disabled = 三级驻留：模型完全不可见（不注册、搜索过滤、零进程）。
 * enabled+trusted = 二级驻留：manifest 可被 search_tools 搜到但未运行。
 */
export type CapabilitySettingState = "disabled" | "enabled" | "trusted";

export type CapabilityKind = "pi-extension" | "mcp-server" | "skill" | "builtin";

/** search_tools 返回的轻量条目；完整 schema 在激活前不进上下文 */
export interface CapabilityManifest {
  id: string;
  kind: CapabilityKind;
  title: string;
  summary: string;
  keywords: string[];
  /** 能代理调用（schema 不进上下文）则 Engine 默认走代理路径 */
  supportsProxyCall: boolean;
  /** suite=套件出厂 · user=用户全局 · task=TOOLS.md 任务绑定 */
  origin: "suite" | "user" | "task";
  /** 该能力覆盖的稳定语义 ID（fs.read@1 等）；resolveLive 的判据 */
  semanticOperations?: string[];
}

export interface CapabilityRecord {
  manifest: CapabilityManifest;
  /** Compatibility projection for UI/tests; derived from settings + current digest. */
  setting: CapabilitySettingState;
  settings: CapabilitySettingsRecord;
  manifestDigest: string;
}

/** Persistent user-owned settings axis. Running/leases are deliberately absent. */
export interface CapabilitySettingsRecord {
  enabled: boolean;
  trustedDigest?: string;
}

export interface PersistedCapabilitySettings extends CapabilitySettingsRecord {
  id: string;
}

/**
 * 会话运行轴（临时态）。模型只能请求 Activate；
 * 调用路径由 Engine 确定性选择，调用者不感知注册细节与缓存重置。
 */
export type ActivationPath = "proxy" | "registered" | "resident";

export interface ActiveCapabilityLease {
  leaseId: string;
  capabilityId: string;
  path: ActivationPath;
  /** 激活收敛到的轮次边界（缓存归因用） */
  activatedAtTurn: number;
}

export type ReadinessStatus = "Ready" | "Degraded" | "NeedsSetup" | "Unavailable";
export interface ReadinessReport {
  capabilityId: string;
  status: ReadinessStatus;
  summary: string;
  missing: string[];
  nextSteps: string[];
  inspectedAt: string;
}
export interface SetupPlan { capabilityId: string; steps: string[]; requiresApproval: true }
export interface ReadinessContext { cwd: string; harnessTier: HarnessTier }
export interface CapabilityReadiness {
  inspect(context: ReadinessContext, signal?: AbortSignal): Promise<ReadinessReport>;
  prepare(context: ReadinessContext): Promise<SetupPlan>;
}

export interface TaskContext {
  sessionId: string;
  taskId?: string;
  harnessTier: HarnessTier;
  currentTurn: number;
}

// ---------------------------------------------------------------------------
// 账号统一管理（PICODE-V3-DESIGN.md §3.1，Q4/Q14）
// Picode 自己管理 OAuth 流与凭据（accounts.json 0600）；
// AccountRef 是无秘密的引用投影，凭据本体在 Store 的 vault 分区。
// ---------------------------------------------------------------------------

export interface AccountRef {
  id: string;
  provider: string;
  label: string;
  defaultModel?: string;
  /** 同 Provider 可存多个账号，同时只有一个 active */
  status: "active" | "stored" | "unavailable" | "retired";
  notes?: string;
}

// ---------------------------------------------------------------------------
// 缓存方案 v2（PICODE-V3-DESIGN.md §3.3，R3 校正版）
// ---------------------------------------------------------------------------

/** pi SDK 每轮 usage 的最小投影；Provider 可能不返回 cache 字段（Spike 2） */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** 归因信号集（六项；仅哈希 system+schema 不足以识别日志改写） */
export interface PrefixSignals {
  systemDigest: string;
  toolSchemaDigest: string;
  retainedHistoryAnchorDigest: string;
  provider: string;
  model: string;
  baseUrl?: string;
  promptCacheKeyHash?: string;
  cacheRetention?: string;
}

/**
 * miss 归因五类。uncached-tail：新追加 token 本就不可命中，
 * 不等于整次请求 miss；unknown-provider-side：缓存是 Provider 侧
 * best-effort，不强迫归入已知类。
 */
export type MissAttribution =
  | "system-drift"
  | "tool-schema-drift"
  | "history-anchor-rewrite"
  | "uncached-tail"
  | "unknown-provider-side";

export interface CacheMeterSnapshot {
  turns: number;
  cacheEpoch: number;
  /** false = Provider 未返回 cache 字段，UI 必须显示 telemetry unavailable 而非裸 0% */
  telemetryAvailable: boolean;
  sessionHitRate: number; // 0..1
  lastTurnHitRate: number; // 0..1
  lastAttribution?: MissAttribution;
}

// ---------------------------------------------------------------------------
// Capsule v1（MODULES.md §3.1，R3 外壳：绑定 + 生命周期）
// ---------------------------------------------------------------------------

/** 通用来源指针（取代仅限 {sessionId, turn}） */
export interface SourceRef {
  kind: "session" | "evidence" | "import" | "file";
  id: string;
  locator?: string;
  sourceDigest?: string;
}

export type CapsuleStatus = "draft" | "sealed" | "superseded";

/** 生成时的代码身份；注入前校验，防注入错误代码快照 */
export interface WorkspaceSnapshotRef {
  repo?: string;
  head?: string;
  dirty?: boolean;
  contentDigest?: string;
}

export interface VerbatimFact {
  /** 命令/路径/错误串/验收标准；禁改写 */
  text: string;
  source: SourceRef;
}

export interface TaskCapsule {
  schemaVersion: "picode.capsule/v1";
  capsuleId: string;
  taskId: string;
  /** 绑定任务叙事版本；revision 不符 → 不得注入 */
  taskRevision: number;
  workspaceSnapshot?: WorkspaceSnapshotRef;
  status: CapsuleStatus;
  supersededBy?: string;
  /** The previous sealed Capsule replaced by this Capsule. */
  supersedes?: string;
  /** Stable digest of immutable Capsule contents; present only after seal. */
  digest?: string;
  /** 关联的 Gate/Evidence 指针（导入类证据标 Imported/Unverified） */
  verificationRefs: SourceRef[];
  createdAt: string;
  // ---- 正文强制分节（Factory.ai 式填空，防静默丢失） ----
  intent: string;
  verbatimFacts: VerbatimFact[];
  decisions: { decision: string; rationale: string }[];
  filesTouched: string[];
  openQuestions: string[];
  nextSteps: string[];
  /** 唯一允许摘要的自由段 */
  narrative: string;
}

export interface TaskTodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface TaskTodoState {
  version: 1;
  taskId: string;
  updatedAt: string;
  items: TaskTodoItem[];
}

// ---------------------------------------------------------------------------
// 导入契约投影（PICODE-V3-DESIGN.md §3.5 / 契约文档 §4-§6，R3 权威归属）
// ---------------------------------------------------------------------------

export type Compatibility =
  | "Equivalent"
  | "AdaptedLossless"
  | "AdaptedLossy"
  | "HistoricalOnly"
  | "Unsupported";

export interface SourceToolSignature {
  sourceAgent: string;
  sourceVersion?: string;
  toolName: string;
  schemaDigest?: string;
}

export interface HistoricalCompatibility {
  signature: SourceToolSignature;
  /** 稳定语义 ID（如 fs.read@1）；Unsupported/HistoricalOnly 时缺省 */
  semanticOperation?: string;
  compatibility: Compatibility;
  lossFlags: string[];
}

// ---------------------------------------------------------------------------
// 模块接口（组合根注入；领域模块之间只见这些类型）
// ---------------------------------------------------------------------------

export interface StorePort {
  listAccounts(): Promise<Result<AccountRef[]>>;
  saveAccounts(accounts: AccountRef[]): Promise<Result<void>>;
  // ImportCompiler 经 Store 暴露（仅导入时懒加载）
  resolveHistorical(sig: SourceToolSignature): HistoricalCompatibility;
}

export interface GuardPort {
  decide(intent: OperationIntent): Decision;
  grant(g: Grant): void;
  /** 批准时记录指纹；启动前重算校验（MODULES.md §2.2） */
  fingerprintOf(intent: OperationIntent): string;
  /** search_tools 的目录查询；结果已按设置轴过滤（disabled 不可见） */
  searchCapabilities(query: string): CapabilityManifest[];
  /** Activate 前置检查：该能力是否已 Enabled + Trusted */
  checkActivatable(capabilityId: string): Result<void>;
}

export interface EnginePort {
  /** 当前 Execution Epoch 序号；账号/模型/能力集切换时递增 */
  currentEpoch(): number;
  /** 深模块：调用者不感知 registerTool/setActiveTools/代理调用/缓存重置 */
  activate(capabilityId: string, ctx: TaskContext): Promise<Result<ActiveCapabilityLease>>;
  release(leaseId: string): void;
}

export interface DevloopPort {
  /** revision/快照校验通过才允许注入 */
  canInjectCapsule(
    capsule: TaskCapsule,
    current: { taskId: string; taskRevision: number; workspace?: WorkspaceSnapshotRef },
  ): Result<void>;
}
