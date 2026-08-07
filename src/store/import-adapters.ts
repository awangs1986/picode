import type { ForeignEvent, ForeignTranscriptIR } from "../shared/import-ir.ts";
import { collectSignatures, IMPORT_CONTRACT_VERSION } from "../shared/import-ir.ts";
import type { Result } from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";

/**
 * 来源 Adapter（契约文档 §3 / R3 拆分）：
 * 只负责来源格式解析与 call/result 配对，输出 Foreign Transcript IR。
 * 不做语义映射（ImportCompiler 权威）、不做 Context 渲染（Devloop 权威）。
 *
 * 解析纪律：坏行只降级该行（structureFlags/structureRepairs），不拖垮整档。
 */

export interface SourceAdapter {
  sourceAgent: string;
  /** content = 来源会话文件原文（JSONL 等） */
  parse(content: string): Result<ForeignTranscriptIR>;
}

/** 配对修复：为 dangling call / orphan result 打标（Adapter 通用后处理） */
export function repairPairing(events: ForeignEvent[]): string[] {
  const repairs: string[] = [];
  const calls = new Map<string, ForeignEvent>();
  const resulted = new Set<string>();
  for (const ev of events) {
    if (ev.kind === "tool_call" && ev.callId !== undefined) calls.set(ev.callId, ev);
    if (ev.kind === "tool_result" && ev.callId !== undefined) {
      if (calls.has(ev.callId)) {
        resulted.add(ev.callId);
      } else {
        ev.structureFlags = [...(ev.structureFlags ?? []), "orphan-result"];
        repairs.push(`orphan-result:${ev.callId}`);
      }
    }
  }
  for (const [callId, call] of calls) {
    if (!resulted.has(callId)) {
      call.structureFlags = [...(call.structureFlags ?? []), "dangling-call"];
      repairs.push(`dangling-call:${callId}`);
    }
  }
  return repairs;
}

const parseJsonLine = (line: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Claude Code 会话 JSONL：
 * 每行 { type: "user"|"assistant", message: { content: [block...] } }，
 * block.type ∈ text | tool_use | tool_result。
 */
export class ClaudeCodeAdapter implements SourceAdapter {
  readonly sourceAgent = "claude-code";

  parse(content: string): Result<ForeignTranscriptIR> {
    const events: ForeignEvent[] = [];
    const repairs: string[] = [];
    let index = 0;
    const lines = content.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (lines.length === 0) return err("store/import-empty", "no parseable lines in source file");

    for (const line of lines) {
      const row = parseJsonLine(line);
      if (row === undefined) {
        repairs.push(`unparseable-line:${index}`);
        index += 1;
        continue;
      }
      const type = asString(row.type);
      const message = row.message as Record<string, unknown> | undefined;
      const blocks = Array.isArray(message?.content) ? (message.content as unknown[]) : [];

      if (type !== "user" && type !== "assistant") {
        index += 1;
        continue;
      }
      if (blocks.length === 0 && typeof message?.content === "string") {
        events.push({ kind: type, index, text: message.content });
        index += 1;
        continue;
      }
      for (const raw of blocks) {
        const block = raw as Record<string, unknown>;
        const blockType = asString(block.type);
        if (blockType === "text") {
          events.push({ kind: type, index, text: asString(block.text) ?? "" });
        } else if (blockType === "tool_use") {
          const toolName = asString(block.name);
          const callId = asString(block.id);
          events.push({
            kind: "tool_call",
            index,
            ...(toolName !== undefined ? { toolName } : {}),
            ...(callId !== undefined ? { callId } : {}),
            ...(block.input !== undefined ? { argsJson: JSON.stringify(block.input) } : {}),
          });
        } else if (blockType === "tool_result") {
          const callId = asString(block.tool_use_id);
          events.push({
            kind: "tool_result",
            index,
            ...(callId !== undefined ? { callId } : {}),
            resultJson:
              typeof block.content === "string" ? block.content : JSON.stringify(block.content),
          });
        }
        index += 1;
      }
    }

    repairs.push(...repairPairing(events));
    return ok({
      contractVersion: IMPORT_CONTRACT_VERSION,
      sourceAgent: this.sourceAgent,
      events,
      signatures: collectSignatures(this.sourceAgent, events),
      structureRepairs: repairs,
    });
  }
}

/**
 * Codex 会话 JSONL：
 * 每行 { type: "message"|"function_call"|"function_call_output", ... }。
 */
export class CodexAdapter implements SourceAdapter {
  readonly sourceAgent = "codex";

  parse(content: string): Result<ForeignTranscriptIR> {
    const events: ForeignEvent[] = [];
    const repairs: string[] = [];
    let index = 0;
    const lines = content.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (lines.length === 0) return err("store/import-empty", "no parseable lines in source file");

    for (const line of lines) {
      const row = parseJsonLine(line);
      if (row === undefined) {
        repairs.push(`unparseable-line:${index}`);
        index += 1;
        continue;
      }
      const type = asString(row.type);
      if (type === "message") {
        const role = asString(row.role) === "user" ? "user" : "assistant";
        const contentField = row.content;
        const text = Array.isArray(contentField)
          ? contentField
              .map((c) => asString((c as Record<string, unknown>).text) ?? "")
              .join("")
          : asString(contentField) ?? "";
        events.push({ kind: role, index, text });
      } else if (type === "function_call") {
        const toolName = asString(row.name);
        const callId = asString(row.call_id);
        const argsJson = asString(row.arguments);
        events.push({
          kind: "tool_call",
          index,
          ...(toolName !== undefined ? { toolName } : {}),
          ...(callId !== undefined ? { callId } : {}),
          ...(argsJson !== undefined ? { argsJson } : {}),
        });
      } else if (type === "function_call_output") {
        const callId = asString(row.call_id);
        const resultJson = asString(row.output);
        events.push({
          kind: "tool_result",
          index,
          ...(callId !== undefined ? { callId } : {}),
          ...(resultJson !== undefined ? { resultJson } : {}),
        });
      }
      index += 1;
    }

    repairs.push(...repairPairing(events));
    return ok({
      contractVersion: IMPORT_CONTRACT_VERSION,
      sourceAgent: this.sourceAgent,
      events,
      signatures: collectSignatures(this.sourceAgent, events),
      structureRepairs: repairs,
    });
  }
}

/** Cursor bubble export JSONL (SQLite extraction is kept outside the core Adapter). */
export class CursorAdapter implements SourceAdapter {
  readonly sourceAgent = "cursor";

  parse(content: string): Result<ForeignTranscriptIR> {
    const events: ForeignEvent[] = [];
    const repairs: string[] = [];
    let index = 0;
    const lines = content.split(/\r?\n/).filter((line) => line.trim() !== "");
    if (lines.length === 0) return err("store/import-empty", "no parseable lines in source file");

    for (const line of lines) {
      const row = parseJsonLine(line);
      if (row === undefined) {
        repairs.push(`unparseable-line:${index}`);
        index += 1;
        continue;
      }
      const role = row.type === 1 || row.role === "user" ? "user" : "assistant";
      const timestamp = asString(row.createdAt) ?? asString(row.timestamp);
      const text = asString(row.text) ?? asString(row.richText);
      if (text !== undefined && text.trim() !== "") {
        events.push({ kind: role, index, text, ...(timestamp === undefined ? {} : { timestamp }) });
        index += 1;
      }
      const reasoning = asString(row.reasoning) ?? asString(row.thinking) ?? asString(row.reasoningContent);
      if (reasoning !== undefined && reasoning.trim() !== "") {
        events.push({ kind: "meta", index, text: reasoning, structureFlags: ["reasoning-folded"] });
        index += 1;
      }
      const calls = Array.isArray(row.toolCalls) ? row.toolCalls : [];
      for (const rawCall of calls) {
        if (typeof rawCall !== "object" || rawCall === null) continue;
        const call = rawCall as Record<string, unknown>;
        const toolName = asString(call.name) ?? asString(call.toolName);
        const callId = asString(call.id) ?? asString(call.callId);
        events.push({
          kind: "tool_call",
          index,
          ...(toolName === undefined ? {} : { toolName }),
          ...(callId === undefined ? {} : { callId }),
          ...(call.input === undefined && call.arguments === undefined
            ? {}
            : { argsJson: JSON.stringify(call.input ?? call.arguments) }),
        });
        index += 1;
      }
      const results = Array.isArray(row.toolResults) ? row.toolResults : [];
      for (const rawResult of results) {
        if (typeof rawResult !== "object" || rawResult === null) continue;
        const result = rawResult as Record<string, unknown>;
        const callId = asString(result.callId) ?? asString(result.id);
        const output = result.output ?? result.content;
        events.push({
          kind: "tool_result",
          index,
          ...(callId === undefined ? {} : { callId }),
          ...(output === undefined
            ? {}
            : { resultJson: typeof output === "string" ? output : JSON.stringify(output) }),
        });
        index += 1;
      }
    }
    repairs.push(...repairPairing(events));
    return ok({
      contractVersion: IMPORT_CONTRACT_VERSION,
      sourceAgent: this.sourceAgent,
      events,
      signatures: collectSignatures(this.sourceAgent, events),
      structureRepairs: repairs,
    });
  }
}

export const BUILTIN_ADAPTERS: readonly SourceAdapter[] = [
  new ClaudeCodeAdapter(),
  new CodexAdapter(),
  new CursorAdapter(),
];

export function adapterFor(sourceAgent: string): SourceAdapter | undefined {
  return BUILTIN_ADAPTERS.find((a) => a.sourceAgent === sourceAgent);
}
