import type { SourceToolSignature } from "./types.ts";

/**
 * Foreign Transcript IR（契约文档 §4 / Import Contract v1）：
 * 来源 Adapter 的唯一输出格式。Adapter 只做来源格式解析与 call/result 配对，
 * 不做语义映射（那是 Store ImportCompiler 的权威，R3 拆分）。
 */

export const IMPORT_CONTRACT_VERSION = "1" as const;

export type ForeignEventKind =
  | "user"
  | "assistant"
  | "system"
  | "tool_call"
  | "tool_result"
  | "meta";

export interface ForeignEvent {
  kind: ForeignEventKind;
  /** 原始顺序号（来源文件内单调） */
  index: number;
  text?: string;
  toolName?: string;
  /** call/result 配对键；Adapter 负责配对与孤儿标记 */
  callId?: string;
  argsJson?: string;
  resultJson?: string;
  timestamp?: string;
  /** 结构修复标记：dangling-call / orphan-result / truncated 等 */
  structureFlags?: string[];
}

export interface ForeignTranscriptIR {
  contractVersion: typeof IMPORT_CONTRACT_VERSION;
  sourceAgent: string;
  sourceVersion?: string;
  sessionTitle?: string;
  events: ForeignEvent[];
  /** 去重后的历史工具签名（交给 ImportCompiler.resolveHistorical） */
  signatures: SourceToolSignature[];
  /** 整档结构修复摘要（预览报告展示） */
  structureRepairs: string[];
}

/** 从事件流收集去重签名（Adapter 通用逻辑） */
export function collectSignatures(
  sourceAgent: string,
  events: readonly ForeignEvent[],
  sourceVersion?: string,
): SourceToolSignature[] {
  const seen = new Set<string>();
  const out: SourceToolSignature[] = [];
  for (const ev of events) {
    if (ev.kind !== "tool_call" || ev.toolName === undefined) continue;
    if (seen.has(ev.toolName)) continue;
    seen.add(ev.toolName);
    out.push({
      sourceAgent,
      toolName: ev.toolName,
      ...(sourceVersion !== undefined ? { sourceVersion } : {}),
    });
  }
  return out;
}
