import { describe, expect, it } from "vitest";
import {
  createRuntime,
  promptInjectionFor,
  unknownToolEnricherFor,
} from "../../src/extension/index.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

describe("promptInjectionFor", () => {
  it("injects nothing on the default simple tier", async () => {
    await withTempPicodeDir(async () => {
      const rt = createRuntime();
      expect(rt.harness.current()).toBe("simple");
      expect(promptInjectionFor(rt)).toBeUndefined();
    });
  });

  it("returns the lean prompt after switching to standard", async () => {
    await withTempPicodeDir(async () => {
      const rt = createRuntime();
      rt.harness.switchTo("standard");
      const injection = promptInjectionFor(rt);
      expect(injection).toContain("Picode Harness Core (Lean)");
      expect(injection).not.toContain("recorded RED");
    });
  });

  it("returns the ported prompt after switching to tdd", async () => {
    await withTempPicodeDir(async () => {
      const rt = createRuntime();
      rt.harness.switchTo("tdd");
      const injection = promptInjectionFor(rt);
      expect(injection).toBeDefined();
      expect(injection).toContain("TDD");
      expect(injection).not.toContain("{{TOOL_");
    });
  });
});

describe("unknownToolEnricherFor", () => {
  it("enriches known imported claude-code tool names with a suggestion", async () => {
    await withTempPicodeDir(async () => {
      const rt = createRuntime();
      const enrich = unknownToolEnricherFor(rt, "claude-code");
      const message = enrich("Read");
      expect(message).toBeDefined();
      expect(message).toContain('Tool "Read"');
      expect(message).toContain("claude-code");
      // 套件 manifest 未声明 fs.read@1 的 live 工具 → 退 search_tools + 语义 ID 建议
      expect(message).toMatch(/search_tools|tool instead/);
    });
  });

  it("returns undefined for tool names outside the redirect table", async () => {
    await withTempPicodeDir(async () => {
      const rt = createRuntime();
      const enrich = unknownToolEnricherFor(rt, "claude-code");
      expect(enrich("NotARealTool")).toBeUndefined();
    });
  });
});
