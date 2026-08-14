import type { CapabilityManifest, HarnessTier } from "../shared/types.ts";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { TierPolicy } from "./harness.ts";
import { estimateContextTextTokens, stableContextJson } from "../devloop/context/context-budget-meter.ts";

export const SIMPLE_EXTENSION_SCHEMA_BUDGET_TOKENS = 4_096;

export interface ToolSchemaBudgetReport {
  toolNames: string[];
  bytes: number;
  estimatedTokens: number;
}

export function measureToolSchemaBudget(tools: readonly {
  name: string;
  description?: string;
  parameters?: unknown;
  promptGuidelines?: unknown;
}[]): ToolSchemaBudgetReport {
  const normalized = tools.map((tool) => ({
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
    ...(tool.promptGuidelines === undefined ? {} : { promptGuidelines: tool.promptGuidelines }),
  }));
  const serialized = stableContextJson(normalized);
  return {
    toolNames: normalized.map((tool) => tool.name),
    bytes: Buffer.byteLength(serialized, "utf8"),
    estimatedTokens: tools.length === 0 ? 0 : estimateContextTextTokens(serialized),
  };
}

export function withinSimpleToolBudget(report: ToolSchemaBudgetReport): boolean {
  return report.estimatedTokens <= SIMPLE_EXTENSION_SCHEMA_BUDGET_TOKENS;
}

/**
 * 扩展套件登记与档位装载（PICODE-V3-DESIGN.md §1/§2 + MODULES.md §4）。
 * Simple 档接近原生 pi：不加载沙箱/MCP/扩展工具，唯一默认工具 = pi-web-access。
 * 计划通过 Picode 自有 /plan 兼容入口交给 mattpocock/skills；不再加载
 * 独立的第三方 Plan/Goal 插件不再加载；pi-lens 三档默认。
 */

export interface SuiteEntry {
  manifest: CapabilityManifest;
  /** 该扩展在哪些档位装载（装载 ≠ 常驻运行，懒加载纪律不变） */
  tiers: HarnessTier[];
  /** npm 包名（精确版本与 integrity 由 package metadata Gate 校验） */
  packageName: string;
}

const suiteManifest = (
  id: string,
  title: string,
  summary: string,
  keywords: string[],
  supportsProxyCall: boolean,
): CapabilityManifest => ({
  id,
  kind: "pi-extension",
  title,
  summary,
  keywords,
  supportsProxyCall,
  origin: "suite",
});

export const SUITE_ENTRIES: readonly SuiteEntry[] = [
  {
    manifest: suiteManifest(
      "pi-web-access",
      "Web search & fetch",
      "web search and page fetch tools",
      ["web", "search", "fetch"],
      false,
    ),
    tiers: ["simple", "standard", "tdd"],
    packageName: "pi-web-access",
  },
  {
    manifest: suiteManifest(
      "pi-landstrip",
      "OS sandbox",
      "pure OS sandbox provider (maxSubagents=0), policy compiled by Guard",
      ["sandbox", "security"],
      false,
    ),
    tiers: ["standard", "tdd"],
    packageName: "pi-landstrip",
  },
  {
    manifest: suiteManifest(
      "pi-mcp-adapter",
      "MCP runtime",
      "MCP servers via single proxy tool (search/describe/call, lazy connect)",
      ["mcp", "tools", "proxy"],
      true,
    ),
    tiers: ["standard", "tdd"],
    packageName: "pi-mcp-adapter",
  },
  {
    manifest: suiteManifest(
      "pi-subagents",
      "Delegation & orchestration",
      "subagent RPC, lifecycle artifacts, watchdog review",
      ["subagent", "delegate", "watchdog"],
      false,
    ),
    tiers: ["standard", "tdd"],
    packageName: "pi-subagents",
  },
  {
    manifest: suiteManifest(
      "pi-cache-optimizer",
      "Cache compat layer",
      "provider cache compatibility (prompt rewrite disabled by Picode)",
      ["cache", "optimizer"],
      false,
    ),
    tiers: ["simple", "standard", "tdd"], // 缓存是全局策略（Q5）
    packageName: "pi-cache-optimizer",
  },
  {
    manifest: suiteManifest(
      "pi-lens",
      "LSP diagnostics",
      "write/edit-time diagnostics, impact cascade, read-guard",
      ["lsp", "diagnostics"],
      false,
    ),
    tiers: ["tdd"],
    packageName: "pi-lens",
  },
];

/** 当前档位应装载的套件（组合根据此启停 Adapter/子系统） */
export function suiteForTier(tier: HarnessTier): SuiteEntry[] {
  return SUITE_ENTRIES.filter((entry) => entry.tiers.includes(tier));
}

export type SuiteImporter = (packageName: string) => Promise<{ default: ExtensionFactory }>;

/** Load only the vendors belonging to the selected session tier. */
export async function loadSuiteForTier(
  pi: ExtensionAPI,
  tier: HarnessTier,
  importer: SuiteImporter = async (packageName) => import(packageName) as Promise<{ default: ExtensionFactory }>,
  onLoaded?: (entry: SuiteEntry, toolNames: readonly string[]) => void,
  loadedPackages?: Set<string>,
): Promise<void> {
  for (const entry of suiteForTier(tier)) {
    if (loadedPackages?.has(entry.packageName)) continue;
    const before = onLoaded === undefined
      ? undefined
      : new Set(pi.getAllTools().map((tool) => tool.name));
    const vendor = await importer(entry.packageName);
    await vendor.default(pi);
    loadedPackages?.add(entry.packageName);
    if (before !== undefined) {
      const contributed = pi.getAllTools()
        .map((tool) => tool.name)
        .filter((name) => !before.has(name));
      onLoaded?.(entry, contributed);
    }
  }
}

/** 档位策略与套件表的一致性断言（可红测试用） */
export function suiteRespectsPolicy(tier: HarnessTier, policy: TierPolicy): boolean {
  const loaded = new Set(suiteForTier(tier).map((e) => e.manifest.id));
  if (!policy.sandbox && loaded.has("pi-landstrip")) return false;
  if (!policy.mcp && loaded.has("pi-mcp-adapter")) return false;
  if (policy.extensionTools === "web-only") {
    const allowed = new Set(["pi-web-access", "pi-cache-optimizer"]);
    for (const id of loaded) {
      if (!allowed.has(id)) return false;
    }
  }
  return true;
}
