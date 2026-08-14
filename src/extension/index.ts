import { Devloop, TaskIngress } from "../devloop/index.ts";
import { appendEvidence } from "../devloop/index.ts";
import { Engine } from "../engine/index.ts";
import type { ActiveToolAdapter } from "../engine/index.ts";
import { Guard } from "../guard/index.ts";
import { EventBus } from "../shared/bus.ts";
import { makeEvent } from "../shared/events.ts";
import { err, ok } from "../shared/types.ts";
import type { CapabilityManifest, Result, TaskContext } from "../shared/types.ts";
import { AccountsManager, StateFile, Store } from "../store/index.ts";
import { dataPaths } from "../shared/paths.ts";
import { DEFAULT_CONFIG, loadConfig } from "../store/config.ts";
import type { PicodeConfig } from "../store/config.ts";
import { handleAccountsCommand } from "./accounts-command.ts";
import { CacheMeter } from "./cache-meter.ts";
import { HarnessState, handleHarnessCommand } from "./harness.ts";
import { handleSearchTools } from "./search-tools.ts";
import type { SearchToolsInput } from "./search-tools.ts";
import { SUITE_ENTRIES } from "./suite.ts";
import { systemPromptInjection } from "./prompts.ts";
import { enrichUnknownToolError } from "./unknown-tool-hook.ts";
import { ONBOARDING_MANIFESTS } from "./onboarding-runner.ts";
import { WEIXIN_CAPABILITY_MANIFEST } from "./weixin-manifest.ts";
import {
  RuntimeEnvelopeIngress,
  type ExecutionIdentity,
  type RuntimeEnvelopeAdmission,
} from "./runtime-envelope.ts";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { withFileLock } from "../shared/fs.ts";

export { CacheMeter } from "./cache-meter.ts";
export { computePrefixSignals, appendCacheMetric } from "./cache-signals.ts";
export type { PrefixInputs, CacheMetricRecord } from "./cache-signals.ts";
export { HarnessState, TIER_POLICIES, handleHarnessCommand } from "./harness.ts";
export type { TierPolicy } from "./harness.ts";
export {
  ONBOARDING_ITEMS,
  applyOnboarding,
  onboardingQuestions,
  reopenOnboarding,
  shouldRunOnboarding,
  skipOnboarding,
} from "./onboarding.ts";
export { handleAccountsCommand } from "./accounts-command.ts";
export {
  SEARCH_TOOLS_DEFINITION,
  formatSearchResults,
  handleSearchTools,
} from "./search-tools.ts";
export type { SearchToolsInput, SearchToolsDeps } from "./search-tools.ts";
export {
  SIMPLE_EXTENSION_SCHEMA_BUDGET_TOKENS,
  SUITE_ENTRIES,
  measureToolSchemaBudget,
  suiteForTier,
  suiteRespectsPolicy,
  withinSimpleToolBudget,
} from "./suite.ts";
export type { SuiteEntry } from "./suite.ts";
export {
  applyToolPlaceholders,
  BUILTIN_LEAN_PROMPT,
  BUILTIN_TDD_PROMPT,
  effectivePromptLevel,
  PROMPT_LEVEL_ENTRY_TYPE,
  restorePromptOverride,
  sessionPromptInjection,
  stripAuthorComments,
  systemPromptInjection,
  TOOL_PLACEHOLDERS,
} from "./prompts.ts";
export type { PromptLevel } from "./prompts.ts";
export { enrichUnknownToolError } from "./unknown-tool-hook.ts";
export type { RedirectContext } from "./unknown-tool-hook.ts";
export {
  parseToolsMd,
  registerTaskExtensions,
  renderTaskExtensionSummary,
  toTaskManifest,
} from "./tools-md.ts";
export type { ToolsMdEntry } from "./tools-md.ts";

/**
 * Adapter Extension 组合根（ADR-0003）。extension/ 与 api/ 是唯一
 * 允许 import 全部领域模块的组合层；模块不感知宿主形态。
 * 零业务逻辑纪律：这里只做接线（Epoch 记账、Evidence 落盘、回调编排）。
 *
 * 真实 Pi 0.84 Adapter 入口位于 pi-entry.ts；本文件保持纯组合根。
 */

export type CommandHandler = (argv: string[]) => Promise<string>;

export interface PicodeRuntime {
  store: Store;
  accounts: AccountsManager;
  guard: Guard;
  engine: Engine;
  devloop: Devloop;
  taskIngress: TaskIngress;
  cacheMeter: CacheMeter;
  harness: HarnessState;
  config: PicodeConfig;
  bus: EventBus;
  envelopes: RuntimeEnvelopeIngress;
  admitRuntime(raw: string | Uint8Array, identity: ExecutionIdentity): RuntimeEnvelopeAdmission;
  bindRemoteMessageSender(
    sender: ((sessionId: string, message: string) => Promise<Result<void>>) | undefined,
  ): void;
  sendRemoteMessage(sessionId: string, message: string): Promise<Result<void>>;
  /** headless 命令注册表（/v1/commands 只执行这里注册过的） */
  commands: Map<string, CommandHandler>;
}

/** Spike 13 前的占位 Adapter：记录调用，不碰真实 pi API */
class NoopToolAdapter implements ActiveToolAdapter {
  readonly registered: string[] = [];

  async register(manifest: CapabilityManifest): Promise<Result<void>> {
    this.registered.push(manifest.id);
    return ok(undefined);
  }

  async deactivate(capabilityId: string): Promise<Result<void>> {
    const at = this.registered.indexOf(capabilityId);
    if (at >= 0) this.registered.splice(at, 1);
    return ok(undefined);
  }
}

export interface RuntimeOptions {
  toolAdapter?: ActiveToolAdapter;
  config?: PicodeConfig;
  /** Evidence 落盘开关。默认 false（库安全）；真实入口经 bootRuntime 开启 */
  persistEvidence?: boolean;
}

/** 真实 pi 扩展入口用：读磁盘配置 + 开 Evidence 落盘 + 载入持久 Grant */
export function bootRuntime(opts: Omit<RuntimeOptions, "config" | "persistEvidence"> = {}): PicodeRuntime {
  const loaded = loadConfig();
  if (!loaded.ok) {
    console.error(`[picode] ${loaded.error.message}; the unreadable file was quarantined and safe defaults are active`);
  }
  return createRuntime({
    ...opts,
    config: loaded.ok ? loaded.value : structuredClone(DEFAULT_CONFIG),
    persistEvidence: true,
  });
}

export function createRuntime(opts: RuntimeOptions = {}): PicodeRuntime {
  const config = opts.config ?? structuredClone(DEFAULT_CONFIG);
  const persistEvidence = opts.persistEvidence ?? false;
  const bus = new EventBus();
  const envelopes = new RuntimeEnvelopeIngress();
  let remoteMessageSender: ((sessionId: string, message: string) => Promise<Result<void>>) | undefined;

  const record = (kind: string, payload: unknown, opts: { taskId?: string; sliceId?: string } = {}): void => {
    const event = makeEvent(kind, payload, opts);
    bus.publish(event);
    if (persistEvidence) void appendEvidence(event);
  };

  const store = new Store();
  const guard = new Guard("auto", undefined, (decision) => {
    record("guard.decision", decision);
  });
  guard.grants.load();
  const cacheMeter = new CacheMeter();
  const devloop = new Devloop();
  const taskIngress = new TaskIngress({
    tasksRoot: dataPaths.tasks(),
    stateFile: (path, validate) => new StateFile(path, validate),
  });

  const engine = new Engine({
    toolAdapter: opts.toolAdapter ?? new NoopToolAdapter(),
    residencyOf: (id) => (config.residentCapabilities.includes(id) ? "resident" : "none"),
    manifestOf: (id) => guard.catalog.get(id)?.manifest,
    onDeliberateCacheReset: (reason) => {
      cacheMeter.beginNewEpoch();
      record("cache-epoch", { reason });
    },
  });

  // 账号切换：上下文不动，只记新 Execution Epoch（缓存重置经 Engine 回调可见化）
  const accounts = new AccountsManager((provider, accountId) => {
    const epoch = engine.beginNewEpoch(`account switch: ${provider}/${accountId}`);
    record("execution-epoch", { epoch, provider, accountId });
  });

  // 切档 = 显式缓存重置点 + 档位审计
  const harness = new HarnessState("simple", (from, to) => {
    engine.beginNewEpoch(`harness switch: ${from} → ${to}`);
    record("harness-switch", { from, to });
  });

  // 套件 manifest 全量登记进能力目录（设置轴初值：出厂套件 = trusted，
  // 装载与否由档位策略决定，三级纪律只约束用户装的 External Extension）
  for (const entry of SUITE_ENTRIES) {
    guard.catalog.register({ ...entry.manifest, harnessTiers: [...entry.tiers] }, "trusted");
  }
  for (const manifest of ONBOARDING_MANIFESTS) {
    guard.catalog.register(manifest, "disabled");
  }
  guard.catalog.register(WEIXIN_CAPABILITY_MANIFEST, "disabled");

  const runtime: PicodeRuntime = {
    store,
    accounts,
    guard,
    engine,
    devloop,
    taskIngress,
    cacheMeter,
    harness,
    config,
    bus,
    envelopes,
    admitRuntime(raw, identity) {
      const admission = envelopes.dispatch(raw, identity, (event, admittedIdentity) => {
        record(event.kind, { identity: admittedIdentity, payload: event.payload }, {
          ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
          ...(event.sliceId === undefined ? {} : { sliceId: event.sliceId }),
        });
      });
      if (!admission.admitted && admission.reason === "malformed" && persistEvidence) {
        const path = dataPaths.runtimeDiagnostics();
        mkdirSync(dirname(path), { recursive: true });
        const encoded = typeof raw === "string"
          ? Buffer.from(raw, "utf8").toString("base64")
          : Buffer.from(raw).toString("base64");
        void withFileLock(`${path}.lock`, () => {
          appendFileSync(path, `${JSON.stringify({
            at: new Date().toISOString(),
            identity,
            diagnostic: admission.diagnostic,
            rawBase64: encoded,
          })}\n`, { encoding: "utf8", mode: 0o600 });
        });
      }
      return admission;
    },
    bindRemoteMessageSender(sender) {
      remoteMessageSender = sender;
    },
    sendRemoteMessage(sessionId, message) {
      if (remoteMessageSender === undefined) {
        return Promise.resolve(err("api/session-not-writable", "no live Pi session is attached"));
      }
      return remoteMessageSender(sessionId, message);
    },
    commands: new Map(),
  };

  // headless 命令注册（/v1/commands 的白名单即这张表）
  runtime.commands.set("harness", async (argv) => handleHarnessCommand(harness, argv[0]));
  runtime.commands.set("accounts", (argv) => handleAccountsCommand(accounts, argv));

  return runtime;
}

/**
 * search_tools → Activate 的完整链路（MODULES.md §2.4）：
 * Guard 检查 Enabled+Trusted → Engine 确定性激活。
 */
export async function requestActivate(
  runtime: PicodeRuntime,
  capabilityId: string,
  ctx: TaskContext,
): ReturnType<Engine["activate"]> {
  const gate = runtime.guard.checkActivatable(capabilityId, ctx);
  if (!gate.ok) return gate;
  return runtime.engine.activate(capabilityId, ctx);
}

/** 当前档位的系统提示词增量（simple 无；standard lean；tdd full）。 */
export function promptInjectionFor(runtime: PicodeRuntime, promptsDir?: string): string | undefined {
  // Runtime-only callers have no Pi session branch. Return the Harness default;
  // pi-bridge.ts owns restoration and application of a session-level override.
  return systemPromptInjection(runtime.harness.current(), promptsDir);
}

/**
 * 导入会话的 unknown-tool 错误加厚器（P3-C 第 3 层防线）：
 * Store 的重定向表（历史映射权威）+ Guard Catalog resolveLive（live 解析权威）。
 */
export function unknownToolEnricherFor(
  runtime: PicodeRuntime,
  sourceAgent: string,
): (toolName: string) => string | undefined {
  const redirects = runtime.store.redirectTable(sourceAgent);
  const liveTools: Record<string, string> = {};
  for (const semanticOp of Object.values(redirects)) {
    const live = runtime.guard.catalog.resolveLive(semanticOp);
    if (live !== undefined) liveTools[semanticOp] = live.id;
  }
  return (toolName) => enrichUnknownToolError(toolName, { sourceAgent, redirects, liveTools });
}

/** search_tools 工具调用入口（真实 Pi 工具经 Adapter Extension 注册到这里） */
export function searchToolsHandler(
  runtime: PicodeRuntime,
): (input: SearchToolsInput, ctx: TaskContext) => Promise<string> {
  return (input, ctx) =>
    handleSearchTools(
      {
        guard: runtime.guard,
        activate: (id, c) => requestActivate(runtime, id, c),
      },
      input,
      ctx,
    );
}
