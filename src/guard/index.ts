import type {
  CapabilityManifest,
  Decision,
  Grant,
  GuardPort,
  OperationIntent,
  PermissionTier,
  Result,
} from "../shared/types.ts";
import { CapabilityCatalog } from "./catalog.ts";
import { computeFingerprint } from "./fingerprint.ts";
import { GrantStore } from "./grants.ts";
import { decide } from "./policy.ts";

export { CapabilityCatalog } from "./catalog.ts";
export { computeFingerprint } from "./fingerprint.ts";
export { GrantStore } from "./grants.ts";
export { arbitrateMcp, mcpRequestToIntent } from "./mcp-arbitration.ts";
export type { McpApprovalRequest, McpArbitrationResult } from "./mcp-arbitration.ts";
export { decide } from "./policy.ts";
export { compileSandboxPolicy, DEFAULT_SECRET_ZONES } from "./sandbox-policy.ts";
export type { CompiledSandboxPolicy, RuleVerdict } from "./sandbox-policy.ts";

export interface GuardDecisionRecord {
  intent: OperationIntent;
  decision: Decision;
  fingerprint: string;
}

/**
 * Guard 模块入口。裁决逻辑在 policy.ts（纯函数，保留条款 ②）；
 * 本类持有 Grant 分级存储、当前档位与能力目录。
 *
 * 每次裁决经组合根注入的 sink 进入 append-only Evidence；
 *           编译层对接：landstrip permissions、mcp-adapter 仲裁事件。
 */
export class Guard implements GuardPort {
  readonly catalog = new CapabilityCatalog();
  readonly grants: GrantStore;

  constructor(
    private tier: PermissionTier,
    grants?: GrantStore,
    private readonly decisionSink?: (record: GuardDecisionRecord) => void,
  ) {
    this.grants = grants ?? new GrantStore();
  }

  setTier(tier: PermissionTier): void {
    this.tier = tier;
  }

  permissionTier(): PermissionTier {
    return this.tier;
  }

  decide(intent: OperationIntent): Decision {
    const decision = decide({ tier: this.tier, intent, grants: this.grants.all() });
    this.decisionSink?.({
      intent: structuredClone(intent),
      decision: { ...decision },
      fingerprint: computeFingerprint(intent),
    });
    return decision;
  }

  grant(g: Grant): void {
    void this.grants.add(g);
  }

  fingerprintOf(intent: OperationIntent): string {
    return computeFingerprint(intent);
  }

  searchCapabilities(query: string): CapabilityManifest[] {
    return this.catalog.search(query);
  }

  checkActivatable(capabilityId: string): Result<void> {
    return this.catalog.checkActivatable(capabilityId);
  }
}
