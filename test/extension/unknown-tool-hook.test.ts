import { describe, expect, it } from "vitest";
import type { RedirectContext } from "../../src/extension/unknown-tool-hook.ts";
import { enrichUnknownToolError } from "../../src/extension/unknown-tool-hook.ts";

const baseCtx: RedirectContext = {
  sourceAgent: "claude-code",
  redirects: { Read: "fs.read@1", Bash: "process.exec@1" },
};

describe("enrichUnknownToolError", () => {
  it("suggests the concrete live tool when the semantic op has one", () => {
    const message = enrichUnknownToolError("Read", {
      ...baseCtx,
      liveTools: { "fs.read@1": "pi-fs-reader" },
    });
    expect(message).toBeDefined();
    expect(message).toContain('use the "pi-fs-reader" tool instead');
    expect(message).toContain('Tool "Read"');
    expect(message).toContain("claude-code");
  });

  it("falls back to search_tools plus the semantic ID when no live tool resolves", () => {
    const message = enrichUnknownToolError("Bash", baseCtx);
    expect(message).toBeDefined();
    expect(message).toContain('"process.exec@1"');
    expect(message).toContain("search_tools");
  });

  it("returns undefined for tool names outside the redirect table", () => {
    expect(enrichUnknownToolError("TotallyUnknown", baseCtx)).toBeUndefined();
  });
});
