import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { Model, ModelThinkingLevel, ThinkingLevel } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { registerThinkingCommand } from "../../src/extension/thinking-command.ts";

type Command = {
  description?: string;
  handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void;
};

function reasoningModel(overrides: Partial<Model<any>> = {}): Model<any> {
  return {
    id: "gpt-test",
    name: "GPT Test",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://example.test/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_000,
    ...overrides,
  };
}

function setup(model: Model<any> | undefined, selected: string | undefined, current: ModelThinkingLevel = "medium") {
  const commands = new Map<string, Command>();
  const select = vi.fn().mockResolvedValue(selected);
  const notify = vi.fn();
  let thinkingLevel = current;
  const api = {
    registerCommand(name: string, command: Command) { commands.set(name, command); },
    getThinkingLevel: vi.fn(() => thinkingLevel as ThinkingLevel),
    setThinkingLevel: vi.fn((level: ThinkingLevel) => { thinkingLevel = level; }),
  } as unknown as ExtensionAPI;
  const ctx = {
    model,
    ui: { select, notify },
  } as unknown as ExtensionCommandContext;
  registerThinkingCommand(api);
  return { api, command: commands.get("thinking")!, ctx, select, notify };
}

describe("/thinking", () => {
  it("offers only levels supported by the current model and marks the current level", async () => {
    const model = reasoningModel({
      thinkingLevelMap: { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null },
    });
    const fixture = setup(model, "High", "medium");

    await fixture.command.handler("", fixture.ctx);

    expect(fixture.select).toHaveBeenCalledWith(
      "Thinking level · openai/gpt-test",
      ["Off", "Minimal", "Low", "Medium (current)", "High"],
    );
    expect(fixture.api.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(fixture.notify).toHaveBeenCalledWith("Thinking level: high", "info");
  });

  it("does not change the level when the selector is cancelled", async () => {
    const fixture = setup(reasoningModel(), undefined, "low");

    await fixture.command.handler("", fixture.ctx);

    expect(fixture.api.setThinkingLevel).not.toHaveBeenCalled();
    expect(fixture.notify).not.toHaveBeenCalled();
  });

  it("reports that a non-reasoning model only supports off", async () => {
    const fixture = setup(reasoningModel({ reasoning: false }), "Off (current)", "off");

    await fixture.command.handler("", fixture.ctx);

    expect(fixture.select).toHaveBeenCalledWith(
      "Thinking level · openai/gpt-test",
      ["Off (current)"],
    );
    expect(fixture.api.setThinkingLevel).toHaveBeenCalledWith("off");
  });

  it("warns when no model is selected", async () => {
    const fixture = setup(undefined, undefined);

    await fixture.command.handler("", fixture.ctx);

    expect(fixture.select).not.toHaveBeenCalled();
    expect(fixture.notify).toHaveBeenCalledWith("Select a model before changing thinking level.", "warning");
  });
});
