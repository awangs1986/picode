import { describe, expect, it } from "vitest";
import {
  filterModelsByProvider,
  modelOptionLabel,
  modelProviderLabel,
  summarizeModelProviders,
} from "./provider-view.js";

describe("model provider presentation", () => {
  const models = [
    { provider: "cursor", id: "cursor-model" },
    { provider: "openai", id: "gpt-5-codex" },
    { provider: "openai-codex", id: "gpt-5.3-codex" },
  ];

  it("makes imported Codex API-key and OAuth channels recognizable", () => {
    expect(modelProviderLabel("openai")).toBe("Codex / OpenAI");
    expect(modelProviderLabel("openai-codex")).toBe("Codex");
  });

  it("summarizes and filters providers without dropping similarly named Codex channels", () => {
    expect(summarizeModelProviders(models)).toEqual([
      { provider: "openai-codex", label: "Codex", count: 1 },
      { provider: "openai", label: "Codex / OpenAI", count: 1 },
      { provider: "cursor", label: "Cursor", count: 1 },
    ]);
    expect(filterModelsByProvider(models, "openai-codex")).toEqual([models[2]]);
  });

  it("labels equal model ids with their independent agent route", () => {
    expect(modelOptionLabel({ provider: "cursor", id: "gpt-5.6" })).toBe("gpt-5.6 · Cursor");
    expect(modelOptionLabel({ provider: "openai-codex", id: "gpt-5.6" })).toBe("gpt-5.6 · Codex");
  });
});
