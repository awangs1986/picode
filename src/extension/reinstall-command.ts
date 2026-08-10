import type { CapabilityCatalog } from "../guard/catalog.ts";
import { ok, type PersistedCapabilitySettings, type Result } from "../shared/types.ts";

export interface RecommendedReinstallReport {
  prompted: string[];
  installed: string[];
  alreadyInstalled: string[];
  declined: string[];
}

export interface RecommendedReinstallDeps {
  locale: "zh" | "en";
  catalog: CapabilityCatalog;
  confirm(title: string, message: string): Promise<boolean>;
  mattPocockInstalled(): boolean;
  installMattPocock(): Result<void>;
  persistCapabilities(settings: PersistedCapabilitySettings[]): Promise<Result<void>>;
}

const RECOMMENDATION_IDS = [
  "mattpocock-skills",
  "herdr",
  "codebase-memory-provider",
] as const;

const INTRO = {
  "mattpocock-skills": {
    zh: "mattpocock/skills：软件开发工作流技能集合；Picode 按需加载，/plan 使用 grill-with-docs。是否安装随包固定版本？",
    en: "mattpocock/skills: software-development workflow skills, loaded on demand; /plan uses grill-with-docs. Install the bundled pinned version?",
  },
  herdr: {
    zh: "Herdr：多任务与多 Agent 编排；只有实际使用时才启动，不替代 pi-subagents。是否启用并信任？",
    en: "Herdr: multi-task and multi-agent orchestration, started only when used; it does not replace pi-subagents. Enable and trust it?",
  },
  "codebase-memory-provider": {
    zh: "CodebaseMemoryProvider：代码库级长期记忆、结构索引和跨会话检索。是否启用并信任？",
    en: "CodebaseMemoryProvider: repository-level memory, structural indexing, and cross-session retrieval. Enable and trust it?",
  },
} as const;

const LABELS = {
  "mattpocock-skills": "mattpocock/skills",
  herdr: "Herdr",
  "codebase-memory-provider": "CodebaseMemoryProvider",
} as const;

export function formatRecommendedReinstallReport(
  report: RecommendedReinstallReport,
  locale: "zh" | "en",
): string {
  if (report.prompted.length === 0) {
    return locale === "zh"
      ? "三项推荐组件均已安装，无需重新安装。"
      : "All three recommended components are already installed; nothing to reinstall.";
  }
  const names = (ids: string[]): string => ids.map((id) => LABELS[id as keyof typeof LABELS] ?? id).join("、");
  const rows = locale === "zh"
    ? [
        `已安装：${names(report.installed) || "无"}`,
        `已存在并跳过：${names(report.alreadyInstalled) || "无"}`,
        `用户跳过：${names(report.declined) || "无"}`,
      ]
    : [
        `Installed: ${names(report.installed) || "none"}`,
        `Already present: ${names(report.alreadyInstalled) || "none"}`,
        `Declined: ${names(report.declined) || "none"}`,
      ];
  return rows.join("\n");
}

export async function runRecommendedReinstall(
  deps: RecommendedReinstallDeps,
): Promise<Result<RecommendedReinstallReport>> {
  const installed = [
    deps.mattPocockInstalled(),
    deps.catalog.get("herdr")?.setting !== "disabled",
    deps.catalog.get("codebase-memory-provider")?.setting !== "disabled",
  ];
  const report: RecommendedReinstallReport = {
    prompted: [],
    installed: [],
    alreadyInstalled: [],
    declined: [],
  };
  let capabilitiesChanged = false;
  for (const [index, id] of RECOMMENDATION_IDS.entries()) {
    if (installed[index]) {
      report.alreadyInstalled.push(id);
      continue;
    }
    report.prompted.push(id);
    const accepted = await deps.confirm(
      deps.locale === "zh" ? "Picode 重新安装" : "Picode reinstall",
      INTRO[id][deps.locale],
    );
    if (!accepted) {
      report.declined.push(id);
      continue;
    }
    if (id === "mattpocock-skills") {
      const materialized = deps.installMattPocock();
      if (!materialized.ok) return materialized;
    } else {
      const changed = deps.catalog.userSetState(id, "trusted");
      if (!changed.ok) return changed;
      capabilitiesChanged = true;
    }
    report.installed.push(id);
  }
  if (capabilitiesChanged) {
    const persisted = await deps.persistCapabilities(deps.catalog.toJSON());
    if (!persisted.ok) return persisted;
  }
  return ok(report);
}
