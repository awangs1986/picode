import type { CapabilityManifest } from "../shared/types.ts";
import type { CapabilityCatalog } from "../guard/catalog.ts";

/**
 * TOOLS.md 任务绑定扩展（V3 §3.4 / P4）：
 * 任务开始时强制解析仓库根的 TOOLS.md，声明的能力以 origin="task"
 * 注册进 Capability Catalog（走 search_tools 同一发现链），
 * 并注入一段紧凑摘要——不注入完整 schema，保持缓存前缀轻量。
 *
 * 格式约定（每个二级标题一个能力）：
 *   ## <capability-id>
 *   <一段摘要文字>
 *   keywords: a, b, c        （可选）
 *   proxy: true|false        （可选，默认 true）
 */

export interface ToolsMdEntry {
  id: string;
  summary: string;
  keywords: string[];
  supportsProxyCall: boolean;
}

export function parseToolsMd(content: string): ToolsMdEntry[] {
  const entries: ToolsMdEntry[] = [];
  const sections = content.split(/^##\s+/m).slice(1);
  for (const section of sections) {
    const lines = section.split(/\r?\n/);
    const id = (lines[0] ?? "").trim();
    if (id === "" || /\s/.test(id)) continue; // 能力 ID 不允许空白
    const body: string[] = [];
    let keywords: string[] = [];
    let proxy = true;
    for (const line of lines.slice(1)) {
      const kw = /^keywords:\s*(.+)$/i.exec(line.trim());
      if (kw?.[1] !== undefined) {
        keywords = kw[1].split(",").map((k) => k.trim()).filter((k) => k !== "");
        continue;
      }
      const px = /^proxy:\s*(true|false)$/i.exec(line.trim());
      if (px?.[1] !== undefined) {
        proxy = px[1].toLowerCase() === "true";
        continue;
      }
      body.push(line);
    }
    const summary = body.join("\n").trim();
    if (summary === "") continue;
    entries.push({ id, summary, keywords, supportsProxyCall: proxy });
  }
  return entries;
}

export function toTaskManifest(entry: ToolsMdEntry): CapabilityManifest {
  return {
    id: `task:${entry.id}`,
    kind: "pi-extension",
    title: entry.id,
    summary: entry.summary,
    keywords: entry.keywords,
    supportsProxyCall: entry.supportsProxyCall,
    origin: "task",
  };
}

/**
 * 注册任务绑定能力。信任跟随文件夹信任（folderTrusted）：
 * 受信任仓库的 TOOLS.md 直接 trusted（可 Activate）；
 * 未信任只到 enabled（可搜索，Activate 时提示用户去信任）。
 */
export function registerTaskExtensions(
  catalog: CapabilityCatalog,
  entries: readonly ToolsMdEntry[],
  folderTrusted: boolean,
): CapabilityManifest[] {
  const manifests = entries.map(toTaskManifest);
  for (const manifest of manifests) {
    catalog.register(manifest, folderTrusted ? "trusted" : "enabled");
  }
  return manifests;
}

/** 任务开始时注入的紧凑摘要（一行一个；不含 schema） */
export function renderTaskExtensionSummary(entries: readonly ToolsMdEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  const lines = entries.map((e) => `- task:${e.id} — ${e.summary.split("\n")[0]}`);
  return `Task-bound capabilities declared in TOOLS.md (discover via search_tools):\n${lines.join("\n")}`;
}
