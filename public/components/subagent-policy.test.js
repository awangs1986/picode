// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadSubagentPolicy } from "./subagent-policy.js";
import "./subagent-policy.js";

const EMPTY_POLICY = {
  enabled: false,
  fallback: "doNotDelegate",
  candidates: [],
  qualifiedClasses: ["repository-search", "advisory-review"],
};

function stubAvailableModels(models) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      json: async () => ({ success: true, data: { models } }),
    })),
  );
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("Subagent model policy settings", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("uses the chat model catalog while saving a distinct Subagent-only model choice", async () => {
    stubAvailableModels([
      { id: "gpt-5.6", provider: "cursor", contextWindow: 200_000 },
      { id: "gpt-5.6", provider: "openai-codex", contextWindow: 272_000 },
    ]);
    const setSubagentPolicy = vi.fn(async (policy) => policy);
    const Panel = customElements.get("picode-subagent-policy");
    const panel = new Panel();
    panel.transport = {
      getSubagentPolicy: async () => EMPTY_POLICY,
      setSubagentPolicy,
    };
    document.body.appendChild(panel);
    await settle();

    expect(fetch).toHaveBeenCalledWith(
      "/api/rpc",
      expect.objectContaining({ body: JSON.stringify({ type: "get_available_models" }) }),
    );
    expect(panel.querySelector("textarea[data-candidates]")).toBeNull();
    panel.querySelector("[data-model-picker-button]").click();
    expect(panel.querySelector("[data-model-picker-menu]").textContent).toContain(
      "gpt-5.6 · Cursor",
    );
    expect(panel.querySelector("[data-model-picker-menu]").textContent).toContain(
      "gpt-5.6 · Codex",
    );
    panel
      .querySelector('[data-model-candidate-id="openai-codex/gpt-5.6"]')
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    panel.querySelector("[data-enabled]").checked = true;
    panel.querySelector("[data-fallback]").value = "doNotDelegate";
    panel.querySelector("[data-save]").click();
    await settle();

    expect(loadSubagentPolicy(localStorage)).toEqual({
      enabled: true,
      fallback: "doNotDelegate",
      candidates: [
        {
          id: "openai-codex/gpt-5.6",
          capability: 10,
          quality: 10,
          costRank: 0,
          healthy: true,
        },
      ],
      qualifiedClasses: ["repository-search", "advisory-review"],
    });
    expect(setSubagentPolicy).toHaveBeenCalledWith(loadSubagentPolicy(localStorage));
    expect(panel.dispatchEvent).not.toHaveProperty("spawnSubagent");
  });

  test("starts with no Subagent candidates and never invents models for an empty catalog", async () => {
    stubAvailableModels([]);
    const Panel = customElements.get("picode-subagent-policy");
    const panel = new Panel();
    panel.transport = {
      getSubagentPolicy: async () => EMPTY_POLICY,
      setSubagentPolicy: async (policy) => policy,
    };
    document.body.appendChild(panel);
    await settle();
    panel.querySelector("[data-model-picker-button]").click();
    expect(panel.querySelector("[data-model-picker-menu]").textContent).toContain(
      "No models available",
    );
    panel.querySelector("[data-save]").click();
    expect(loadSubagentPolicy(localStorage).candidates).toEqual([]);
  });

  test("hydrates the durable Rust policy instead of trusting browser storage", async () => {
    stubAvailableModels([{ id: "gpt-5", provider: "openai", contextWindow: 128_000 }]);
    localStorage.setItem("picode:subagent-model-policy:v1", JSON.stringify({ enabled: false }));
    const Panel = customElements.get("picode-subagent-policy");
    const panel = new Panel();
    panel.transport = {
      getSubagentPolicy: async () => ({
        enabled: true,
        fallback: "ask",
        candidates: [
          { id: "openai/gpt-5", capability: 10, quality: 10, costRank: 7, healthy: true },
        ],
        qualifiedClasses: ["repository-search", "advisory-review"],
      }),
    };
    document.body.appendChild(panel);
    await Promise.resolve();
    await Promise.resolve();
    expect(panel.querySelector("[data-enabled]").checked).toBe(true);
    expect(panel.querySelector("[data-fallback]").value).toBe("ask");
    expect(panel.querySelector("[data-model-picker-label]").textContent).toContain(
      "gpt-5 · Codex / OpenAI",
    );
  });
});
