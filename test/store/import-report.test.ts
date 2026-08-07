import { describe, expect, it } from "vitest";
import type { ForeignTranscriptIR } from "../../src/shared/import-ir.ts";
import { ImportCompiler } from "../../src/store/import-compiler.ts";
import { buildCompatReport, renderCompatReport } from "../../src/store/import-report.ts";

const compiler = new ImportCompiler();

const makeIr = (overrides: Partial<ForeignTranscriptIR> = {}): ForeignTranscriptIR => ({
  contractVersion: "1",
  sourceAgent: "claude-code",
  events: [],
  signatures: [],
  structureRepairs: [],
  ...overrides,
});

describe("buildCompatReport", () => {
  it("reports continueStatus yes for fully equivalent transcripts with no repairs", () => {
    const ir = makeIr({
      events: [
        { kind: "user", index: 0, text: "hi" },
        {
          kind: "tool_call",
          index: 1,
          toolName: "Read",
          callId: "c1",
          argsJson: JSON.stringify({ file_path: "/a.ts" }),
        },
        { kind: "tool_result", index: 2, callId: "c1", resultJson: "body" },
      ],
      signatures: [{ sourceAgent: "claude-code", toolName: "Read", schemaDigest: "sd" }],
    });
    const report = buildCompatReport(ir, compiler.compile(ir));
    expect(report.browsable).toBe(true);
    expect(report.continueStatus).toBe("yes");
    expect(report.counts.equivalent).toBe(1);
    expect(report.danglingCalls).toBe(0);
    expect(report.orphanResults).toBe(0);
    expect(report.unparseableLines).toBe(0);
  });

  it("reports needs-revalidation when an AdaptedLossy tool is present", () => {
    const ir = makeIr({
      sourceAgent: "codex",
      events: [{ kind: "tool_call", index: 0, toolName: "apply_patch", callId: "p1" }],
      signatures: [{ sourceAgent: "codex", toolName: "apply_patch" }],
    });
    const report = buildCompatReport(ir, compiler.compile(ir));
    expect(report.counts.adaptedLossy).toBe(1);
    expect(report.continueStatus).toBe("needs-revalidation");
  });

  it("reports needs-revalidation on dangling calls or orphan results", () => {
    const ir = makeIr({
      events: [{ kind: "tool_call", index: 0, toolName: "Read", callId: "c1" }],
      signatures: [{ sourceAgent: "claude-code", toolName: "Read", schemaDigest: "sd" }],
      structureRepairs: ["dangling-call:c1", "orphan-result:x", "unparseable-line:3"],
    });
    const report = buildCompatReport(ir, compiler.compile(ir));
    expect(report.danglingCalls).toBe(1);
    expect(report.orphanResults).toBe(1);
    expect(report.unparseableLines).toBe(1);
    expect(report.continueStatus).toBe("needs-revalidation");
  });

  it("reports read-only and not browsable when there are no events", () => {
    const ir = makeIr();
    const report = buildCompatReport(ir, compiler.compile(ir));
    expect(report.browsable).toBe(false);
    expect(report.continueStatus).toBe("read-only");
  });
});

describe("renderCompatReport", () => {
  it("renders the four-line Chinese status text", () => {
    const ir = makeIr({
      events: [
        { kind: "tool_call", index: 0, toolName: "Read", callId: "c1" },
        { kind: "tool_result", index: 1, callId: "c1", resultJson: "ok" },
      ],
      signatures: [
        { sourceAgent: "claude-code", toolName: "Read", schemaDigest: "sd" },
        { sourceAgent: "claude-code", toolName: "Grep" },
        { sourceAgent: "claude-code", toolName: "TodoWrite" },
      ],
    });
    const lines = renderCompatReport(buildCompatReport(ir, compiler.compile(ir))).split("\n");
    expect(lines).toEqual([
      "可浏览：是",
      "可继续：是",
      "工具兼容：1 等价 · 1 无损适配 · 0 有损 · 1 仅历史 · 0 未知",
      "结构修复：0 个中断调用 · 0 个孤立结果",
    ]);
  });

  it("renders read-only status for an empty transcript", () => {
    const ir = makeIr();
    const text = renderCompatReport(buildCompatReport(ir, compiler.compile(ir)));
    expect(text).toContain("可浏览：否");
    expect(text).toContain("可继续：只读");
  });
});
