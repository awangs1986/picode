import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PiActiveToolAdapter } from "../../src/extension/pi-tool-adapter.ts";
import { makeManifest } from "../helpers/fixtures.ts";

function fakePi(initial: string[] = ["read", "bash"]) {
  let active = [...initial];
  const api = {
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; },
  } as unknown as ExtensionAPI;
  return { api, active: () => active };
}

describe("PiActiveToolAdapter", () => {
  it("activates only the mapped vendor tools and preserves Pi native tools", async () => {
    const pi = fakePi();
    const adapter = new PiActiveToolAdapter(pi.api);
    adapter.bind("web", ["web_search", "web_fetch"]);

    const result = await adapter.register(makeManifest({ id: "web" }));

    expect(result.ok).toBe(true);
    expect(pi.active()).toEqual(["read", "bash", "web_search", "web_fetch"]);
  });

  it("fails closed instead of claiming an unbound capability was activated", async () => {
    const adapter = new PiActiveToolAdapter(fakePi().api);
    const result = await adapter.register(makeManifest({ id: "missing" }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("engine/capability-not-loaded");
  });

  it("deactivates mapped tools without hiding native or other active tools", async () => {
    const pi = fakePi(["read", "bash", "web_search", "other_tool"]);
    const adapter = new PiActiveToolAdapter(pi.api);
    adapter.bind("web", ["web_search"]);

    const result = await adapter.deactivate("web");

    expect(result.ok).toBe(true);
    expect(pi.active()).toEqual(["read", "bash", "other_tool"]);
  });

  it("reconciles vendor tools between tiers while preserving Pi native tools", () => {
    const pi = fakePi(["read", "bash", "web_search", "mcp", "user_tool"]);
    const adapter = new PiActiveToolAdapter(pi.api);
    adapter.bind("web", ["web_search"]);
    adapter.bind("mcp", ["mcp"]);

    adapter.reconcile(["web"]);

    expect(pi.active()).toEqual(["read", "bash", "user_tool", "web_search"]);
  });
});
