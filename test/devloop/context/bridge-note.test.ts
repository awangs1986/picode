import { describe, expect, it } from "vitest";
import { renderBridgeNote } from "../../../src/devloop/context/bridge-note.ts";

describe("renderBridgeNote", () => {
  it("renders mapping lines and null mappings as historical-only", () => {
    const note = renderBridgeNote({
      sourceAgent: "claude-code",
      toolMappings: {
        Read: "read_file",
        TodoWrite: null,
      },
    });
    expect(note).toContain("历史 Read 对应当前 read_file。");
    expect(note).toContain("历史 TodoWrite 只作为历史记录，无当前对应工具。");
  });

  it("includes fixed opening and closing declarations", () => {
    const note = renderBridgeNote({ sourceAgent: "codex", toolMappings: {} });
    expect(note.startsWith("[imported-session note]")).toBe(true);
    expect(note).toContain("这是从 codex 导入的历史。");
    expect(note).toContain("历史 Tool Trace 不会执行。");
    expect(note.endsWith("当前可调用工具以本会话 Tool Schema 为准。")).toBe(true);
  });
});
