import { randomUUID } from "node:crypto";
import type {
  ActivationPath,
  ActiveCapabilityLease,
  CapabilityManifest,
  Result,
  TaskContext,
} from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";

/**
 * 激活深模块（PICODE-V3-DESIGN.md §3.4，R3：确定性策略，不交给模型）。
 * 模型只表达"我要使用这个能力"；路径选择在这里，调用者不感知
 * registerTool/setActiveTools/代理调用/缓存重置。
 */

/**
 * Active Tool Adapter（对 pin 版 pi 的注册/停用窄缝）。
 * 具体用 registerTool/unregisterTool、setActiveTools 还是 reload，
 * 由 pin 版本一致性测试决定（Spike 13）；上游接口变化不影响调用者。
 */
export interface ActiveToolAdapter {
  /** 在轮次边界把能力的完整 schema 注入当前会话 */
  register(manifest: CapabilityManifest): Promise<Result<void>>;
  /** 停用（unregister 或从 active tool set 移除，按版本能力降级） */
  deactivate(capabilityId: string): Promise<Result<void>>;
}

/** 用户显式固定为常用工具（会话/项目常驻）的查询缝，由组合根接线 */
export type ResidencyPreference = (capabilityId: string) => "resident" | "none";

/**
 * 确定性路径选择（纯函数，可测）：
 * ① 用户固定常驻 → resident；② 能代理调用 → proxy（schema 不进上下文，零缓存代价）；
 * ③ 其余 → registered（轮次边界临时激活，Cache Epoch +1）。
 * 连续调用晋升只产生建议（suggestPromotion），不自动改持久配置。
 */
export function choosePath(
  manifest: CapabilityManifest,
  preference: "resident" | "none",
): ActivationPath {
  if (preference === "resident") return "resident";
  if (manifest.supportsProxyCall) return "proxy";
  return "registered";
}

const PROMOTION_THRESHOLD = 3;

export class ActivationManager {
  private leases = new Map<string, ActiveCapabilityLease>();
  private proxyCallCounts = new Map<string, number>();

  constructor(
    private readonly adapter: ActiveToolAdapter,
    private readonly residencyOf: ResidencyPreference,
    /** registered 路径产生刻意缓存重置：通知缓存部件 Epoch +1 并归因 */
    private readonly onDeliberateCacheReset: (reason: string) => void,
  ) {}

  async activate(
    manifest: CapabilityManifest,
    ctx: TaskContext,
  ): Promise<Result<ActiveCapabilityLease>> {
    const path = choosePath(manifest, this.residencyOf(manifest.id));

    if (path !== "proxy") {
      const registered = await this.adapter.register(manifest);
      if (!registered.ok) return registered;
      if (path === "registered") {
        this.onDeliberateCacheReset(`tool-schema change: activate ${manifest.id}`);
      }
    }

    const lease: ActiveCapabilityLease = {
      leaseId: randomUUID(),
      capabilityId: manifest.id,
      path,
      activatedAtTurn: ctx.currentTurn,
    };
    this.leases.set(lease.leaseId, lease);
    if (path === "proxy") {
      this.proxyCallCounts.set(
        manifest.id,
        (this.proxyCallCounts.get(manifest.id) ?? 0) + 1,
      );
    }
    return ok(lease);
  }

  async release(leaseId: string): Promise<Result<void>> {
    const lease = this.leases.get(leaseId);
    if (!lease) return err("engine/lease-unknown", `no lease: ${leaseId}`);
    this.leases.delete(leaseId);
    if (lease.path === "registered") {
      return this.adapter.deactivate(lease.capabilityId);
    }
    return ok(undefined);
  }

  /** 确定性阈值只建议晋升；持久配置永远由用户改（R3 P0-2 第 4 条） */
  suggestPromotion(capabilityId: string): boolean {
    return (this.proxyCallCounts.get(capabilityId) ?? 0) >= PROMOTION_THRESHOLD;
  }

  activeLeases(): readonly ActiveCapabilityLease[] {
    return [...this.leases.values()];
  }
}
