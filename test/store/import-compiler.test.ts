import { describe, expect, it } from "vitest";
import type { ForeignTranscriptIR } from "../../src/shared/import-ir.ts";
import { ImportCompiler } from "../../src/store/import-compiler.ts";

describe("ImportCompiler", () => {
  const compiler = new ImportCompiler();

  it("maps claude-code Read with schemaDigest to Equivalent + fs.read@1", () => {
    const r = compiler.resolveHistorical({
      sourceAgent: "claude-code",
      toolName: "Read",
      schemaDigest: "abc123",
    });
    expect(r.compatibility).toBe("Equivalent");
    expect(r.semanticOperation).toBe("fs.read@1");
  });

  it("maps claude-code Read without schemaDigest to AdaptedLossless", () => {
    const r = compiler.resolveHistorical({ sourceAgent: "claude-code", toolName: "Read" });
    expect(r.compatibility).toBe("AdaptedLossless");
    expect(r.semanticOperation).toBe("fs.read@1");
  });

  it("maps TodoWrite to HistoricalOnly with no-live-equivalent", () => {
    const r = compiler.resolveHistorical({
      sourceAgent: "claude-code",
      toolName: "TodoWrite",
      schemaDigest: "x",
    });
    expect(r.compatibility).toBe("HistoricalOnly");
    expect(r.lossFlags).toContain("no-live-equivalent");
  });

  it("returns Unsupported for unknown tool or source", () => {
    for (const sig of [
      { sourceAgent: "claude-code", toolName: "UnknownTool" },
      { sourceAgent: "unknown-agent", toolName: "Read" },
    ]) {
      const r = compiler.resolveHistorical(sig);
      expect(r.compatibility).toBe("Unsupported");
      expect(r.lossFlags).toContain("unknown-source-tool");
    }
  });

  it("maps Cursor read_file into the same semantic read contract", () => {
    const result = compiler.resolveHistorical({ sourceAgent: "cursor", toolName: "read_file" });
    expect(result.compatibility).toBe("AdaptedLossless");
    expect(result.semanticOperation).toBe("fs.read@1");
  });

  it("redirectTable for claude-code includes Read and Bash but not TodoWrite", () => {
    const table = compiler.redirectTable("claude-code");
    expect(table["Read"]).toBe("fs.read@1");
    expect(table["Bash"]).toBe("process.exec@1");
    expect(table["TodoWrite"]).toBeUndefined();
  });

  it("accepts extraTables to extend new sources", () => {
    const extended = new ImportCompiler({
      "my-agent": {
        custom_tool: {
          semanticOperation: "custom.op@1",
          withSchema: "Equivalent",
          withoutSchema: "AdaptedLossless",
        },
      },
    });
    const r = extended.resolveHistorical({
      sourceAgent: "my-agent",
      toolName: "custom_tool",
      schemaDigest: "d",
    });
    expect(r.compatibility).toBe("Equivalent");
    expect(r.semanticOperation).toBe("custom.op@1");
  });
});

describe("ImportCompiler.compile (normalized projection)", () => {
  const compiler = new ImportCompiler();

  const makeIr = (overrides: Partial<ForeignTranscriptIR> = {}): ForeignTranscriptIR => ({
    contractVersion: "1",
    sourceAgent: "claude-code",
    events: [],
    signatures: [],
    structureRepairs: [],
    ...overrides,
  });

  it("projects an Equivalent tool as tool_use with paramMap rewrite and paired result", () => {
    const compiled = compiler.compile(
      makeIr({
        events: [
          { kind: "user", index: 0, text: "read a.ts" },
          {
            kind: "tool_call",
            index: 1,
            toolName: "Read",
            callId: "c1",
            argsJson: JSON.stringify({ file_path: "/a.ts", limit: 5 }),
          },
          { kind: "tool_result", index: 2, callId: "c1", resultJson: "file body" },
        ],
        signatures: [{ sourceAgent: "claude-code", toolName: "Read", schemaDigest: "sd" }],
      }),
    );

    expect(compiled.events.map((e) => e.kind)).toEqual(["message", "tool_use"]);
    const use = compiled.events[1]!;
    expect(use).toEqual({
      kind: "tool_use",
      semanticOperation: "fs.read@1",
      compatibility: "Equivalent",
      sourceToolName: "Read",
      args: { path: "/a.ts", limit: 5 },
      resultText: "file body",
      lossFlags: [],
    });
  });

  it("degrades HistoricalOnly tools (TodoWrite) to narrative with reason historical-only", () => {
    const compiled = compiler.compile(
      makeIr({
        events: [
          { kind: "tool_call", index: 0, toolName: "TodoWrite", callId: "t1", argsJson: "{}" },
        ],
      }),
    );
    const ev = compiled.events[0]!;
    expect(ev.kind).toBe("narrative");
    if (ev.kind === "narrative") {
      expect(ev.reason).toBe("historical-only");
      expect(ev.text).toContain("TodoWrite");
    }
  });

  it("degrades unknown tools to narrative with reason unsupported-source-tool", () => {
    const compiled = compiler.compile(
      makeIr({
        events: [{ kind: "tool_call", index: 0, toolName: "MysteryTool", callId: "m1" }],
      }),
    );
    const ev = compiled.events[0]!;
    expect(ev.kind).toBe("narrative");
    if (ev.kind === "narrative") expect(ev.reason).toBe("unsupported-source-tool");
  });

  it("keeps foreign system prompts as narrative instead of injecting them (P0-4)", () => {
    const compiled = compiler.compile(
      makeIr({ events: [{ kind: "system", index: 0, text: "You are Claude." }] }),
    );
    expect(compiled.events).toEqual([
      { kind: "narrative", text: "You are Claude.", reason: "foreign-system-prompt-not-injected" },
    ]);
  });

  it("manifest counts match per-signature resolutions", () => {
    const compiled = compiler.compile(
      makeIr({
        signatures: [
          { sourceAgent: "claude-code", toolName: "Read", schemaDigest: "sd" }, // Equivalent
          { sourceAgent: "claude-code", toolName: "Grep" }, // AdaptedLossless（无 schema）
          { sourceAgent: "claude-code", toolName: "TodoWrite" }, // HistoricalOnly
          { sourceAgent: "claude-code", toolName: "Nope" }, // Unsupported
        ],
      }),
    );
    expect(compiled.manifest.counts).toEqual({
      Equivalent: 1,
      AdaptedLossless: 1,
      AdaptedLossy: 0,
      HistoricalOnly: 1,
      Unsupported: 1,
    });
    expect(compiled.manifest.resolutions).toHaveLength(4);
  });

  it("produces a stable mappingDigest across calls and instances", () => {
    const a = compiler.compile(makeIr());
    const b = compiler.compile(makeIr());
    expect(a.manifest.mappingDigest).toBe(b.manifest.mappingDigest);
    expect(new ImportCompiler().mappingDigest()).toBe(compiler.mappingDigest());
    expect(a.manifest.mappingDigest).toMatch(/^[0-9a-f]{16}$/);
  });
});
