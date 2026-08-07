import { createHash } from "node:crypto";
import type { ForeignEvent, ForeignTranscriptIR } from "../shared/import-ir.ts";
import { SEMANTIC_OPS } from "../shared/semantic-ops.ts";
import type {
  Compatibility,
  HistoricalCompatibility,
  SourceToolSignature,
} from "../shared/types.ts";

/**
 * ImportCompiler（PICODE-V3-DESIGN.md §3.5 / 契约文档 §6，R3 拆分归属）：
 * 历史工具签名 → Tool Semantic Operation 的唯一权威。
 * 仅导入时懒加载；外部导入器只负责来源格式解析。
 *
 * 判定纪律（契约文档 §5/§6）：
 * - 仅凭工具名或一次参数样本不得判 Equivalent（需 schemaDigest 佐证）；
 * - 无 schema 时最高只到 AdaptedLossless；
 * - 未识别语义 = Unsupported，只降级该事件，不拖垮整条会话。
 */

interface MappingEntry {
  semanticOperation: string;
  /** 无 source schema 佐证时的兼容上限 */
  withSchema: Compatibility;
  withoutSchema: Compatibility;
  lossFlags?: string[];
  /** 来源参数名 → 语义参数名（归一化投影用；缺省 = 原样保留） */
  paramMap?: Record<string, string>;
}

/** 映射表按来源 Agent 维护；版本升级只改这里，导入器无需同步升级 */
const MAPPING_TABLES: Record<string, Record<string, MappingEntry>> = {
  "claude-code": {
    Read: {
      semanticOperation: SEMANTIC_OPS.fsRead,
      withSchema: "Equivalent",
      withoutSchema: "AdaptedLossless",
      paramMap: { file_path: "path", offset: "offset", limit: "limit" },
    },
    Grep: {
      semanticOperation: SEMANTIC_OPS.fsSearchText,
      withSchema: "Equivalent",
      withoutSchema: "AdaptedLossless",
      paramMap: { pattern: "pattern", path: "path", glob: "glob" },
    },
    Glob: {
      semanticOperation: SEMANTIC_OPS.fsGlob,
      withSchema: "Equivalent",
      withoutSchema: "AdaptedLossless",
      paramMap: { pattern: "pattern", path: "path" },
    },
    Bash: {
      semanticOperation: SEMANTIC_OPS.processExec,
      withSchema: "Equivalent",
      withoutSchema: "AdaptedLossless",
      paramMap: { command: "command" },
    },
    Write: {
      semanticOperation: SEMANTIC_OPS.fsWrite,
      withSchema: "Equivalent",
      withoutSchema: "AdaptedLossless",
      paramMap: { file_path: "path", content: "content" },
    },
    Edit: {
      semanticOperation: SEMANTIC_OPS.fsEdit,
      withSchema: "AdaptedLossless",
      withoutSchema: "AdaptedLossless",
      paramMap: { file_path: "path", old_string: "oldString", new_string: "newString" },
      lossFlags: ["edit-semantics-differ"],
    },
    TodoWrite: {
      semanticOperation: SEMANTIC_OPS.taskTodo,
      withSchema: "HistoricalOnly",
      withoutSchema: "HistoricalOnly",
      lossFlags: ["no-live-equivalent"],
    },
  },
  codex: {
    read_file: {
      semanticOperation: SEMANTIC_OPS.fsRead,
      withSchema: "Equivalent",
      withoutSchema: "AdaptedLossless",
      paramMap: { path: "path" },
    },
    shell_command: {
      semanticOperation: SEMANTIC_OPS.processExec,
      withSchema: "Equivalent",
      withoutSchema: "AdaptedLossless",
      paramMap: { command: "command" },
    },
    apply_patch: {
      semanticOperation: SEMANTIC_OPS.fsEdit,
      withSchema: "AdaptedLossy",
      withoutSchema: "AdaptedLossy",
      lossFlags: ["patch-format-not-replayable"],
    },
  },
  cursor: {
    read_file: {
      semanticOperation: SEMANTIC_OPS.fsRead,
      withSchema: "Equivalent",
      withoutSchema: "AdaptedLossless",
      paramMap: { path: "path", file_path: "path" },
    },
    grep: {
      semanticOperation: SEMANTIC_OPS.fsSearchText,
      withSchema: "Equivalent",
      withoutSchema: "AdaptedLossless",
      paramMap: { pattern: "pattern", path: "path" },
    },
    run_terminal_command: {
      semanticOperation: SEMANTIC_OPS.processExec,
      withSchema: "Equivalent",
      withoutSchema: "AdaptedLossless",
      paramMap: { command: "command" },
    },
    edit_file: {
      semanticOperation: SEMANTIC_OPS.fsEdit,
      withSchema: "AdaptedLossless",
      withoutSchema: "AdaptedLossless",
      lossFlags: ["edit-semantics-differ"],
    },
  },
  // opencode/grok：有真实导入需求时作为独立来源 Adapter 增补
};

// ---------------------------------------------------------------------------
// 归一化投影（P3-B）：Foreign Transcript IR → Normalized Events + 映射清单
// ---------------------------------------------------------------------------

export type NormalizedEvent =
  | { kind: "message"; role: "user" | "assistant" | "system-note"; text: string }
  | {
      kind: "tool_use";
      semanticOperation: string;
      compatibility: Compatibility;
      sourceToolName: string;
      /** 参数已按 paramMap 改写为语义参数名 */
      args: Record<string, unknown>;
      resultText?: string;
      lossFlags: string[];
    }
  | { kind: "narrative"; text: string; reason: string };

export interface MappingManifest {
  /** 映射表内容摘要；Registry 升级后据此判断是否需要重编译投影 */
  mappingDigest: string;
  resolutions: HistoricalCompatibility[];
  counts: Record<Compatibility, number>;
}

export interface CompiledTranscript {
  events: NormalizedEvent[];
  manifest: MappingManifest;
}

const parseArgs = (json: string | undefined): Record<string, unknown> => {
  if (json === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

export class ImportCompiler {
  private readonly tables: Record<string, Record<string, MappingEntry>>;

  constructor(extraTables: Record<string, Record<string, MappingEntry>> = {}) {
    this.tables = { ...MAPPING_TABLES, ...extraTables };
  }

  resolveHistorical(sig: SourceToolSignature): HistoricalCompatibility {
    const entry = this.tables[sig.sourceAgent]?.[sig.toolName];
    if (!entry) {
      return {
        signature: sig,
        compatibility: "Unsupported",
        lossFlags: ["unknown-source-tool"],
      };
    }
    const compatibility = sig.schemaDigest !== undefined ? entry.withSchema : entry.withoutSchema;
    return {
      signature: sig,
      semanticOperation: entry.semanticOperation,
      compatibility,
      lossFlags: entry.lossFlags ?? [],
    };
  }

  /**
   * 运行时重定向表派生（§3.5 第 3 层数据来源）：
   * 外来工具名 → 当前语义 ID；unknown tool 错误钩子据此加厚报错。
   */
  redirectTable(sourceAgent: string): Record<string, string> {
    const table = this.tables[sourceAgent] ?? {};
    const redirect: Record<string, string> = {};
    for (const [toolName, entry] of Object.entries(table)) {
      if (entry.withSchema === "Equivalent" || entry.withSchema === "AdaptedLossless") {
        redirect[toolName] = entry.semanticOperation;
      }
    }
    return redirect;
  }

  /** 映射表版本摘要（映射清单入库 + 按需重编译判据） */
  mappingDigest(): string {
    return createHash("sha256").update(JSON.stringify(this.tables)).digest("hex").slice(0, 16);
  }

  /**
   * 归一化投影（P3-B）：
   * - Equivalent/AdaptedLossless/AdaptedLossy 的 tool_call 改写为语义化 tool_use
   *   （参数名按 paramMap 投影，结果原文保留）；
   * - HistoricalOnly/Unsupported 降级为叙述块（narrative），只降级该事件；
   * - 输出映射清单（逐签名判定 + 计数 + mappingDigest）供预览报告与入库。
   */
  compile(ir: ForeignTranscriptIR): CompiledTranscript {
    const resultsByCall = new Map<string, ForeignEvent>();
    for (const ev of ir.events) {
      if (ev.kind === "tool_result" && ev.callId !== undefined) resultsByCall.set(ev.callId, ev);
    }

    const resolutionCache = new Map<string, HistoricalCompatibility>();
    const resolve = (toolName: string): HistoricalCompatibility => {
      const cached = resolutionCache.get(toolName);
      if (cached) return cached;
      const sig =
        ir.signatures.find((s) => s.toolName === toolName) ??
        ({ sourceAgent: ir.sourceAgent, toolName } satisfies SourceToolSignature);
      const resolved = this.resolveHistorical(sig);
      resolutionCache.set(toolName, resolved);
      return resolved;
    };

    const events: NormalizedEvent[] = [];
    for (const ev of ir.events) {
      switch (ev.kind) {
        case "user":
          events.push({ kind: "message", role: "user", text: ev.text ?? "" });
          break;
        case "assistant":
          events.push({ kind: "message", role: "assistant", text: ev.text ?? "" });
          break;
        case "system":
          // 外来 system prompt 不注入（P0-4）；保留为叙述块供人查阅
          events.push({
            kind: "narrative",
            text: ev.text ?? "",
            reason: "foreign-system-prompt-not-injected",
          });
          break;
        case "tool_call": {
          const toolName = ev.toolName ?? "";
          const resolved = resolve(toolName);
          const compat = resolved.compatibility;
          if (compat === "HistoricalOnly" || compat === "Unsupported") {
            events.push({
              kind: "narrative",
              text: `[historical tool ${toolName}] args: ${ev.argsJson ?? "{}"}`,
              reason: compat === "HistoricalOnly" ? "historical-only" : "unsupported-source-tool",
            });
            break;
          }
          const rawArgs = parseArgs(ev.argsJson);
          const paramMap = this.tables[ir.sourceAgent]?.[toolName]?.paramMap;
          const args: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(rawArgs)) {
            args[paramMap?.[key] ?? key] = value;
          }
          const result = ev.callId !== undefined ? resultsByCall.get(ev.callId) : undefined;
          const resultText = result?.resultJson ?? result?.text;
          events.push({
            kind: "tool_use",
            semanticOperation: resolved.semanticOperation ?? "",
            compatibility: compat,
            sourceToolName: toolName,
            args,
            ...(resultText !== undefined ? { resultText } : {}),
            lossFlags: [...resolved.lossFlags, ...(ev.structureFlags ?? [])],
          });
          break;
        }
        case "tool_result":
          break; // 已随 tool_call 配对消费；孤儿由 Adapter 标记在 structureRepairs
        case "meta":
          break;
      }
    }

    const resolutions = ir.signatures.map((sig) => this.resolveHistorical(sig));
    const counts: Record<Compatibility, number> = {
      Equivalent: 0,
      AdaptedLossless: 0,
      AdaptedLossy: 0,
      HistoricalOnly: 0,
      Unsupported: 0,
    };
    for (const r of resolutions) counts[r.compatibility] += 1;

    return {
      events,
      manifest: { mappingDigest: this.mappingDigest(), resolutions, counts },
    };
  }
}
