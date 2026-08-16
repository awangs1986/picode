import { describe, expect, it } from "vitest";
import { FooterComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js";
import { initTheme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

describe("Picode default TUI footer", () => {
  it("shows cache hit rate and active context without lifetime price totals", () => {
    initTheme("dark", false);
    const session = {
      state: {
        model: {
          id: "gpt-test",
          provider: "openai",
          reasoning: false,
          contextWindow: 1_000_000,
        },
      },
      sessionManager: {
        getEntries: () => [{
          type: "message",
          message: {
            role: "assistant",
            usage: {
              input: 10_000,
              output: 2_000,
              cacheRead: 90_000,
              cacheWrite: 1_000,
              cost: { total: 1.234 },
            },
          },
        }],
        getCwd: () => "C:/repo",
        getSessionName: () => undefined,
      },
      getContextUsage: () => ({
        tokens: 100_000,
        contextWindow: 1_000_000,
        percent: 10,
      }),
      modelRuntime: { isUsingSubscription: () => false },
    };
    const footerData = {
      getGitBranch: () => undefined,
      getExtensionStatuses: () => new Map(),
      getAvailableProviderCount: () => 1,
    };

    const lines = new FooterComponent(session as never, footerData as never).render(160);
    const stats = lines.join("\n");

    expect(stats).toContain("CH89.1%");
    expect(stats).toContain("10.0%/1.0M (auto)");
    expect(stats).not.toContain("↑");
    expect(stats).not.toContain("↓");
    expect(stats).not.toContain("R90k");
    expect(stats).not.toContain("$1.234");
  });
});
