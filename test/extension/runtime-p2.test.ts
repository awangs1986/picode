import { describe, expect, it } from "vitest";
import { createRuntime } from "../../src/extension/index.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

describe("createRuntime P2 wiring", () => {
  it("keeps Google Search Subagent in third-tier Disabled state by default", () => {
    const rt = createRuntime();
    expect(rt.guard.catalog.get("google-search-subagent")?.setting).toBe("disabled");
    expect(rt.guard.catalog.search("google search", {
      sessionId: "s",
      harnessTier: "standard",
      currentTurn: 1,
    })).not.toContainEqual(expect.objectContaining({ id: "google-search-subagent" }));
  });

  it("registers suite manifests as trusted in guard catalog", async () => {
    await withTempPicodeDir(async () => {
      const rt = createRuntime();
      const results = rt.guard.searchCapabilities("web");
      expect(results.some((m) => m.id === "pi-web-access")).toBe(true);
      expect(rt.guard.catalog.get("pi-web-access")?.setting).toBe("trusted");
    });
  });

  it("registers harness and accounts headless commands", () => {
    const rt = createRuntime();
    expect(rt.commands.has("harness")).toBe(true);
    expect(rt.commands.has("accounts")).toBe(true);
  });

  it("wires the single TaskIngress authority into the runtime", async () => {
    await withTempPicodeDir(async () => {
      const rt = createRuntime();
      const accepted = await rt.taskIngress.accept({
        source: "http",
        externalId: "req-1",
        title: "Build feature",
        harnessTier: "standard",
      });
      expect(accepted.ok).toBe(true);
    });
  });

  it("harness command switches tier when invoked via commands map", async () => {
    const rt = createRuntime();
    const handler = rt.commands.get("harness");
    expect(handler).toBeDefined();
    const output = await handler!(["tdd"]);
    expect(output).toContain("tdd");
    expect(rt.harness.current()).toBe("tdd");
  });

  it("publishes harness-switch on bus when harness tier changes", () => {
    const rt = createRuntime();
    const events: { kind: string; payload: unknown }[] = [];
    rt.bus.subscribe((event) => events.push({ kind: event.kind, payload: event.payload }));

    void rt.commands.get("harness")!(["tdd"]);

    const switchEvent = events.find((e) => e.kind === "harness-switch");
    expect(switchEvent).toBeDefined();
    expect(switchEvent!.payload).toEqual({ from: "simple", to: "tdd" });
  });
});
