// @vitest-environment jsdom

import { beforeEach, describe, expect, test } from "vitest";
import { loadSubagentPolicy } from "./subagent-policy.js";
import "./subagent-policy.js";

describe("Subagent model policy settings", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
  });

  test("configuration alone never spawns work and persists exact fallback/model choices", () => {
    const Panel = customElements.get("picode-subagent-policy");
    const panel = new Panel();
    document.body.appendChild(panel);
    panel.querySelector("[data-enabled]").checked = true;
    panel.querySelector("[data-candidates]").value = "deepseek/deepseek-chat,8,9,1";
    panel.querySelector("[data-fallback]").value = "doNotDelegate";
    panel.querySelector("[data-save]").click();

    expect(loadSubagentPolicy(localStorage)).toEqual({
      enabled: true,
      fallback: "doNotDelegate",
      candidates: [
        { id: "deepseek/deepseek-chat", capability: 8, quality: 9, costRank: 1, healthy: true },
      ],
      qualifiedClasses: ["repository-search", "advisory-review"],
    });
    expect(panel.dispatchEvent).not.toHaveProperty("spawnSubagent");
  });

  test("invalid candidate rows are rejected instead of guessed", () => {
    const Panel = customElements.get("picode-subagent-policy");
    const panel = new Panel();
    document.body.appendChild(panel);
    panel.querySelector("[data-candidates]").value = "missing-scores";
    panel.querySelector("[data-save]").click();
    expect(panel.textContent).toContain("provider/model, capability, quality, cost rank");
    expect(loadSubagentPolicy(localStorage).candidates).toEqual([]);
  });

  test("hydrates the durable Rust policy instead of trusting browser storage", async () => {
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
    expect(panel.querySelector("[data-candidates]").value).toContain("openai/gpt-5");
  });
});
