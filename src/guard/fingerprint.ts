import { createHash } from "node:crypto";
import type { OperationIntent } from "../shared/types.ts";

/**
 * approval_fingerprint（MODULES.md §2.2，Q13 已决）：
 * 成分 = 操作类别 + 规范化目标 + 精确命令 + 引用脚本内容摘要 + cwd。
 * 环境变量有意不进指纹（P0–P4 已知豁口，OS 沙箱兜底）。
 */
export function computeFingerprint(intent: OperationIntent): string {
  const canonical = JSON.stringify({
    category: intent.category,
    targets: [...intent.targets].sort(),
    command: intent.command ?? null,
    scriptDigests: sortedEntries(intent.scriptDigests ?? {}),
    cwd: intent.cwd ?? null,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function sortedEntries(record: Record<string, string>): [string, string][] {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
