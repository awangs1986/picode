import { describe, expect, it } from "vitest";
import type { ForeignEvent } from "../../src/shared/import-ir.ts";
import {
  ClaudeCodeAdapter,
  CodexAdapter,
  CursorAdapter,
  repairPairing,
} from "../../src/store/import-adapters.ts";

const claudeFixture = [
  JSON.stringify({ type: "user", message: { content: "please read a.ts" } }),
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "reading now" },
        { type: "tool_use", id: "c1", name: "Read", input: { file_path: "/a.ts" } },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "file body" }] },
  }),
].join("\n");

describe("ClaudeCodeAdapter", () => {
  const adapter = new ClaudeCodeAdapter();

  it("parses user/assistant text and pairs tool_use with tool_result", () => {
    const r = adapter.parse(claudeFixture);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ir = r.value;
    expect(ir.contractVersion).toBe("1");
    expect(ir.sourceAgent).toBe("claude-code");
    expect(ir.events.map((e) => e.kind)).toEqual(["user", "assistant", "tool_call", "tool_result"]);
    expect(ir.events[0]!.text).toBe("please read a.ts");
    expect(ir.events[1]!.text).toBe("reading now");
    const call = ir.events[2]!;
    expect(call.toolName).toBe("Read");
    expect(call.callId).toBe("c1");
    expect(call.argsJson).toBe(JSON.stringify({ file_path: "/a.ts" }));
    expect(ir.events[3]!.resultJson).toBe("file body");
    expect(ir.signatures).toEqual([{ sourceAgent: "claude-code", toolName: "Read" }]);
    expect(ir.structureRepairs).toEqual([]);
  });

  it("degrades only the unparseable line and keeps parsing the rest", () => {
    const r = adapter.parse(`not json at all\n${claudeFixture}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.structureRepairs.filter((s) => s.startsWith("unparseable-line:"))).toHaveLength(
      1,
    );
    expect(r.value.events.map((e) => e.kind)).toEqual([
      "user",
      "assistant",
      "tool_call",
      "tool_result",
    ]);
  });

  it("marks a dangling call when the result is missing", () => {
    const content = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "c9", name: "Bash", input: {} }] },
    });
    const r = adapter.parse(content);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.structureRepairs).toContain("dangling-call:c9");
    expect(r.value.events[0]!.structureFlags).toContain("dangling-call");
  });

  it("marks an orphan result when no call precedes it", () => {
    const content = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "ghost", content: "x" }] },
    });
    const r = adapter.parse(content);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.structureRepairs).toContain("orphan-result:ghost");
    expect(r.value.events[0]!.structureFlags).toContain("orphan-result");
  });

  it("returns store/import-empty for empty or whitespace-only content", () => {
    for (const content of ["", "\n  \n"]) {
      const r = adapter.parse(content);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("store/import-empty");
    }
  });
});

const codexFixture = [
  JSON.stringify({ type: "message", role: "user", content: [{ type: "input_text", text: "run ls" }] }),
  JSON.stringify({
    type: "function_call",
    name: "shell_command",
    call_id: "f1",
    arguments: JSON.stringify({ command: "ls" }),
  }),
  JSON.stringify({ type: "function_call_output", call_id: "f1", output: "a.ts b.ts" }),
  JSON.stringify({ type: "message", role: "assistant", content: "two files" }),
].join("\n");

describe("CodexAdapter", () => {
  const adapter = new CodexAdapter();

  it("parses message/function_call/function_call_output rows", () => {
    const r = adapter.parse(codexFixture);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ir = r.value;
    expect(ir.sourceAgent).toBe("codex");
    expect(ir.events.map((e) => e.kind)).toEqual(["user", "tool_call", "tool_result", "assistant"]);
    expect(ir.events[0]!.text).toBe("run ls");
    const call = ir.events[1]!;
    expect(call.toolName).toBe("shell_command");
    expect(call.callId).toBe("f1");
    expect(call.argsJson).toBe(JSON.stringify({ command: "ls" }));
    expect(ir.events[2]!.resultJson).toBe("a.ts b.ts");
    expect(ir.events[3]!.text).toBe("two files");
    expect(ir.signatures).toEqual([{ sourceAgent: "codex", toolName: "shell_command" }]);
    expect(ir.structureRepairs).toEqual([]);
  });

  it("degrades bad lines and flags dangling calls", () => {
    const content = [
      "{{{ broken",
      JSON.stringify({ type: "function_call", name: "read_file", call_id: "f2", arguments: "{}" }),
    ].join("\n");
    const r = adapter.parse(content);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.structureRepairs.some((s) => s.startsWith("unparseable-line:"))).toBe(true);
    expect(r.value.structureRepairs).toContain("dangling-call:f2");
  });

  it("returns store/import-empty for an empty file", () => {
    const r = adapter.parse("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("store/import-empty");
  });
});

describe("CursorAdapter", () => {
  it("parses exported bubble JSONL without treating reasoning as visible chat", () => {
    const content = [
      JSON.stringify({ type: 1, bubbleId: "u1", text: "inspect src" }),
      JSON.stringify({
        type: 2,
        bubbleId: "a1",
        text: "I found it",
        reasoning: "private chain",
        toolCalls: [{ id: "c1", name: "read_file", input: { path: "src/a.ts" } }],
        toolResults: [{ callId: "c1", name: "read_file", output: "body" }],
      }),
    ].join("\n");

    const result = new CursorAdapter().parse(content);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sourceAgent).toBe("cursor");
    expect(result.value.events.map((event) => event.kind)).toEqual([
      "user", "assistant", "meta", "tool_call", "tool_result",
    ]);
    expect(result.value.events[2]?.text).toBe("private chain");
    expect(result.value.structureRepairs).toEqual([]);
  });
});

describe("repairPairing", () => {
  it("reports no repairs when every call has a result", () => {
    const events: ForeignEvent[] = [
      { kind: "tool_call", index: 0, toolName: "Read", callId: "c1" },
      { kind: "tool_result", index: 1, callId: "c1", resultJson: "ok" },
    ];
    expect(repairPairing(events)).toEqual([]);
    expect(events[0]!.structureFlags).toBeUndefined();
    expect(events[1]!.structureFlags).toBeUndefined();
  });

  it("flags dangling calls and orphan results in one pass", () => {
    const events: ForeignEvent[] = [
      { kind: "tool_call", index: 0, toolName: "Read", callId: "c1" },
      { kind: "tool_result", index: 1, callId: "other", resultJson: "?" },
    ];
    const repairs = repairPairing(events);
    expect(repairs).toContain("dangling-call:c1");
    expect(repairs).toContain("orphan-result:other");
  });
});
