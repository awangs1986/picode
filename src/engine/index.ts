import type {
  ActiveCapabilityLease,
  CapabilityManifest,
  EnginePort,
  Result,
  TaskContext,
} from "../shared/types.ts";
import { err } from "../shared/types.ts";
import type { ActiveToolAdapter, ResidencyPreference } from "./activation.ts";
import { ActivationManager } from "./activation.ts";

export { ActivationManager, choosePath } from "./activation.ts";
export type { ActiveToolAdapter, ResidencyPreference } from "./activation.ts";
export { WATCHDOG_PRESETS, gateSubagentWrite } from "./subagents.ts";
export type {
  DelegationRequest,
  SubagentArtifactRef,
  SubagentRpc,
  SubagentStatus,
  WatchdogConfig,
  WatchdogLevel,
} from "./subagents.ts";
export { WorktreeRegistry } from "./worktree.ts";

/**
 * Engine：pi SDK/扩展 API 封装、执行生命周期、Execution Epoch、
 * 能力激活（ActiveCapabilityLease）、landstrip 调用侧、Managed Worktree。
 *
 * manifest 查询经组合根注入（Guard 目录持有 manifest；Engine 不 import Guard）。
 *
 * Host 适配分别位于 extension/landstrip-config.ts 与 pi-tool-adapter.ts；
 * 账号切换由组合根调用 beginNewEpoch，不把宿主 API 泄漏进 Engine。
 */
export class Engine implements EnginePort {
  private epoch = 1;
  private readonly activation: ActivationManager;

  constructor(
    private readonly deps: {
      toolAdapter: ActiveToolAdapter;
      residencyOf: ResidencyPreference;
      manifestOf: (capabilityId: string) => CapabilityManifest | undefined;
      onDeliberateCacheReset: (reason: string) => void;
    },
  ) {
    this.activation = new ActivationManager(
      deps.toolAdapter,
      deps.residencyOf,
      deps.onDeliberateCacheReset,
    );
  }

  currentEpoch(): number {
    return this.epoch;
  }

  beginNewEpoch(reason: string): number {
    this.epoch += 1;
    this.deps.onDeliberateCacheReset(reason);
    return this.epoch;
  }

  async activate(
    capabilityId: string,
    ctx: TaskContext,
  ): Promise<Result<ActiveCapabilityLease>> {
    // Enabled+Trusted 前置检查由组合根在调用前经 GuardPort 完成；
    // Engine 只负责已放行能力的路径选择与激活。
    const manifest = this.deps.manifestOf(capabilityId);
    if (!manifest) return err("engine/manifest-missing", `no manifest for ${capabilityId}`);
    return this.activation.activate(manifest, ctx);
  }

  release(leaseId: string): void {
    void this.activation.release(leaseId);
  }

  suggestPromotion(capabilityId: string): boolean {
    return this.activation.suggestPromotion(capabilityId);
  }
}
