import type {
  ActiveCapabilityLease,
  CapabilityManifest,
  GuardPort,
  Result,
  TaskContext,
  ReadinessReport,
} from "../shared/types.ts";

/**
 * search_tools（PICODE-V3-DESIGN.md §3.4，MODULES.md §2.4）：
 * 二级能力唯一发现入口，约 200 token 常驻。
 * 模型只表达"搜索/我要使用"；Enable/Trust 是用户设置轴，模型不可达；
 * 激活路径与缓存重置由 Engine 确定性选择，不进模型决策。
 */

/** 常驻工具定义（注册进 pi 的 schema；措辞面向模型，保持紧凑） */
export const SEARCH_TOOLS_DEFINITION = {
  name: "search_tools",
  description:
    "Discover optional capabilities. action=search lists matching capabilities; " +
    "action=activate makes one usable (the runtime picks the cheapest path). " +
    "Capabilities not listed here do not exist in this environment.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["search", "activate"] },
      query: { type: "string", description: "keywords for action=search" },
      capabilityId: { type: "string", description: "id for action=activate" },
    },
    required: ["action"],
  },
} as const;

export interface SearchToolsDeps {
  guard: GuardPort;
  activate(capabilityId: string, ctx: TaskContext): Promise<Result<ActiveCapabilityLease>>;
  readiness?(capabilityId: string, ctx: TaskContext): Promise<ReadinessReport>;
}

export type SearchToolsInput =
  | { action: "search"; query?: string }
  | { action: "activate"; capabilityId?: string };

/** 轻量条目渲染：id + 一句话；完整 schema 不在此出现（懒加载纪律） */
export function formatSearchResults(manifests: CapabilityManifest[], readiness: ReadonlyMap<string, ReadinessReport> = new Map()): string {
  if (manifests.length === 0) return "no matching capabilities";
  return manifests
    .map((m) => {
      const current = readiness.get(m.id);
      return `${m.id} — ${m.title}: ${m.summary}${current === undefined ? "" : ` [${current.status}: ${current.summary}]`}`;
    })
    .join("\n");
}

export async function handleSearchTools(
  deps: SearchToolsDeps,
  input: SearchToolsInput,
  ctx: TaskContext,
): Promise<string> {
  if (input.action === "search") {
    const manifests = deps.guard.searchCapabilities(input.query ?? "", ctx);
    const reports = deps.readiness === undefined ? [] : await Promise.all(manifests.map(async (manifest) => [manifest.id, await deps.readiness!(manifest.id, ctx)] as const));
    return formatSearchResults(manifests, new Map(reports));
  }

  if (input.capabilityId === undefined || input.capabilityId.trim() === "") {
    return "activate requires capabilityId";
  }
  // Guard 前置检查（Enabled+Trusted）在 deps.activate 链路内完成（组合根接线）
  const activated = await deps.activate(input.capabilityId.trim(), ctx);
  if (!activated.ok) {
    return `cannot activate: ${activated.error.message}`;
  }
  const lease = activated.value;
  return lease.path === "proxy"
    ? `capability ${lease.capabilityId} is available via proxy call (no schema change)`
    : `capability ${lease.capabilityId} activated (${lease.path}); its tools are usable from the next turn`;
}
