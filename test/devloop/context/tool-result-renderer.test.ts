import { describe, expect, it } from "vitest";
import { renderToolResult } from "../../../src/devloop/context/tool-result-renderer.ts";

describe("semantic tool-result renderer", () => {
  it("summarizes search scope and truncation without dropping matches", () => {
    const content = [{ type: "text", text: "src/a.ts:10:needle" }];
    const rendered = renderToolResult({
      toolName: "grep",
      input: { pattern: "needle", path: "src" },
      content,
      details: { matchLimitReached: true, linesTruncated: 17 },
      isError: false,
    });

    expect(rendered.semantic).toBe(true);
    expect(rendered.content[0]?.text).toContain("kind=search");
    expect(rendered.content[0]?.text).toContain("query=needle");
    expect(rendered.content[0]?.text).toContain("scope=src");
    expect(rendered.content[0]?.text).toContain("truncated=true");
    expect(rendered.content[0]?.text).toContain("src/a.ts:10:needle");
  });

  it("keeps failing command evidence and its retained-output pointer", () => {
    const rendered = renderToolResult({
      toolName: "bash",
      input: { command: "npm test" },
      content: [{ type: "text", text: "FAIL test/example.test.ts" }],
      details: { fullOutputPath: "D:/tmp/bash.log", truncation: { truncated: true } },
      isError: true,
    });

    expect(rendered.content[0]?.text).toContain("kind=command");
    expect(rendered.content[0]?.text).toContain("outcome=error");
    expect(rendered.content[0]?.text).toContain("command=npm test");
    expect(rendered.content[0]?.text).toContain("artifact=D:/tmp/bash.log");
    expect(rendered.content[0]?.text).toContain("FAIL test/example.test.ts");
  });

  it("renders git, web and MCP results as compact evidence", () => {
    const cases = [
      {
        toolName: "git",
        input: { action: "status" },
        expected: ["kind=git", "action=status"],
      },
      {
        toolName: "web_search",
        input: { query: "Godot headless testing" },
        expected: ["kind=web", "query=Godot headless testing"],
      },
      {
        toolName: "mcp",
        input: { server: "patchboard", tool: "get_patch" },
        expected: ["kind=mcp", "server=patchboard", "operation=get_patch"],
      },
    ];

    for (const row of cases) {
      const rendered = renderToolResult({
        toolName: row.toolName,
        input: row.input,
        content: [{ type: "text", text: "result" }],
        isError: false,
      });
      expect(rendered.semantic).toBe(true);
      for (const expected of row.expected) expect(rendered.content[0]?.text).toContain(expected);
      expect(Buffer.byteLength(rendered.content[0]?.text ?? "", "utf8")).toBeLessThan(2_500);
    }
  });

  it("leaves unknown tool results untouched", () => {
    const content = [{ type: "text", text: "opaque" }];
    const rendered = renderToolResult({
      toolName: "private_custom_tool",
      input: { payload: "x" },
      content,
      isError: false,
    });

    expect(rendered).toEqual({ semantic: false, content });
    expect(rendered.content).toBe(content);
  });
});
