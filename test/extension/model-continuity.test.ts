import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { registerModelContinuity } from "../../src/extension/model-continuity.ts";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../../src/store/config.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler>();
  const selected: Array<{ provider: string; id: string }> = [];
  const api = {
    on(name: string, handler: Handler) { handlers.set(name, handler); },
    async setModel(model: { provider: string; id: string }) {
      selected.push(model);
      await handlers.get("model_select")?.(
        { type: "model_select", model, previousModel: undefined, source: "set" },
        {} as ExtensionContext,
      );
      return true;
    },
  } as unknown as ExtensionAPI;
  return { api, handlers, selected };
}

function context(
  model: { provider: string; id: string },
  entries: Array<{ type: string }>,
  models: Array<{ provider: string; id: string }> = [model],
): ExtensionContext {
  return {
    mode: "tui",
    model,
    modelRegistry: {
      find: (provider: string, id: string) => models.find((item) => item.provider === provider && item.id === id),
      hasConfiguredAuth: () => true,
    },
    sessionManager: { getBranch: () => entries },
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;
}

describe("conversation model continuity", () => {
  it("makes the resumed conversation's model the default for the next new project", async () => {
    await withTempPicodeDir(async () => {
      expect((await saveConfig({
        ...structuredClone(DEFAULT_CONFIG),
        lastConversationModel: { provider: "cursor", modelId: "grok-old" },
      })).ok).toBe(true);
      const pi = fakePi();
      registerModelContinuity(pi.api);
      const codex = { provider: "openai-codex", id: "gpt-5.6-sol" };

      await pi.handlers.get("session_start")?.(
        { type: "session_start", reason: "resume" },
        context(codex, [{ type: "message" }]),
      );
      expect(loadConfig()).toMatchObject({
        ok: true,
        value: { lastConversationModel: { provider: "openai-codex", modelId: "gpt-5.6-sol" } },
      });

      await pi.handlers.get("session_start")?.(
        { type: "session_start", reason: "startup" },
        context(
          { provider: "cursor", id: "grok-old" },
          [],
          [codex, { provider: "cursor", id: "grok-old" }],
        ),
      );
      expect(pi.selected).toEqual([codex]);
    });
  });

  it("records an explicit model selection for later new conversations", async () => {
    await withTempPicodeDir(async () => {
      const pi = fakePi();
      registerModelContinuity(pi.api);

      await pi.handlers.get("model_select")?.(
        { type: "model_select", model: { provider: "anthropic", id: "claude-sonnet" } },
        {} as ExtensionContext,
      );

      expect(loadConfig()).toMatchObject({
        ok: true,
        value: { lastConversationModel: { provider: "anthropic", modelId: "claude-sonnet" } },
      });
    });
  });

  it("never overrides a model explicitly selected at process startup", async () => {
    await withTempPicodeDir(async () => {
      expect((await saveConfig({
        ...structuredClone(DEFAULT_CONFIG),
        lastConversationModel: { provider: "cursor", modelId: "grok-old" },
      })).ok).toBe(true);
      const pi = fakePi();
      registerModelContinuity(pi.api, { explicitModelRequested: true });
      const explicit = { provider: "openai-codex", id: "gpt-explicit" };

      await pi.handlers.get("session_start")?.(
        { type: "session_start", reason: "startup" },
        context(explicit, [], [explicit, { provider: "cursor", id: "grok-old" }]),
      );

      expect(pi.selected).toEqual([]);
      expect(loadConfig()).toMatchObject({
        ok: true,
        value: { lastConversationModel: { provider: "openai-codex", modelId: "gpt-explicit" } },
      });
    });
  });
});
