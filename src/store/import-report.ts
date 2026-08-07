import type { ForeignTranscriptIR } from "../shared/import-ir.ts";
import type { CompiledTranscript } from "./import-compiler.ts";

/**
 * 导入预览/兼容报告（契约文档 §11，P4）：
 * 每条导入 Chat 的简洁状态。数据来自 IR + 编译结果，本模块只统计与渲染文本，
 * TUI 呈现由组合根/前端接线。
 */

export type ContinueStatus = "yes" | "needs-revalidation" | "read-only";

export interface CompatReport {
  browsable: boolean;
  continueStatus: ContinueStatus;
  counts: {
    equivalent: number;
    adaptedLossless: number;
    adaptedLossy: number;
    historicalOnly: number;
    unsupported: number;
  };
  danglingCalls: number;
  orphanResults: number;
  unparseableLines: number;
  mappingDigest: string;
}

export function buildCompatReport(
  ir: ForeignTranscriptIR,
  compiled: CompiledTranscript,
): CompatReport {
  const counts = compiled.manifest.counts;
  const danglingCalls = ir.structureRepairs.filter((r) => r.startsWith("dangling-call:")).length;
  const orphanResults = ir.structureRepairs.filter((r) => r.startsWith("orphan-result:")).length;
  const unparseableLines = ir.structureRepairs.filter((r) =>
    r.startsWith("unparseable-line:"),
  ).length;

  // 可继续判定：有损/未知/结构修复 → 需要重新验证；只有解析近乎全失败才降只读
  const hasLoss =
    counts.AdaptedLossy > 0 || counts.Unsupported > 0 || danglingCalls > 0 || orphanResults > 0;
  const browsable = ir.events.length > 0;
  const continueStatus: ContinueStatus = !browsable
    ? "read-only"
    : hasLoss
      ? "needs-revalidation"
      : "yes";

  return {
    browsable,
    continueStatus,
    counts: {
      equivalent: counts.Equivalent,
      adaptedLossless: counts.AdaptedLossless,
      adaptedLossy: counts.AdaptedLossy,
      historicalOnly: counts.HistoricalOnly,
      unsupported: counts.Unsupported,
    },
    danglingCalls,
    orphanResults,
    unparseableLines,
    mappingDigest: compiled.manifest.mappingDigest,
  };
}

const CONTINUE_LABEL: Record<ContinueStatus, string> = {
  yes: "是",
  "needs-revalidation": "需要重新验证",
  "read-only": "只读",
};

/** §11 简洁状态文本（默认不展开 tool trace/reasoning/日志） */
export function renderCompatReport(report: CompatReport): string {
  const c = report.counts;
  return [
    `可浏览：${report.browsable ? "是" : "否"}`,
    `可继续：${CONTINUE_LABEL[report.continueStatus]}`,
    `工具兼容：${c.equivalent} 等价 · ${c.adaptedLossless} 无损适配 · ${c.adaptedLossy} 有损 · ${c.historicalOnly} 仅历史 · ${c.unsupported} 未知`,
    `结构修复：${report.danglingCalls} 个中断调用 · ${report.orphanResults} 个孤立结果`,
  ].join("\n");
}
