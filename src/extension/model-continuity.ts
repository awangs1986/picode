import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PicodeConfig } from "../store/config.ts";
import { loadConfig, saveConfig } from "../store/config.ts";

export interface ConversationModelRef {
  provider: string;
  modelId: string;
}

interface ModelContinuityStore {
  current(): PicodeConfig | undefined;
  persist(model: ConversationModelRef): Promise<boolean>;
}

export interface ModelContinuityOptions {
  store?: ModelContinuityStore;
  /** Explicit startup selection always wins over automatic inheritance. */
  explicitModelRequested?: boolean;
}

function defaultStore(): ModelContinuityStore {
  return {
    current() {
      const loaded = loadConfig();
      return loaded.ok ? loaded.value : undefined;
    },
    async persist(model) {
      const loaded = loadConfig();
      if (!loaded.ok) return false;
      const saved = await saveConfig({ ...loaded.value, lastConversationModel: model });
      return saved.ok;
    },
  };
}

function isConversationEntry(entry: { type: string }): boolean {
  return entry.type === "message" || entry.type === "compaction" || entry.type === "branch_summary";
}

function modelFromConversation(entries: readonly unknown[]): ConversationModelRef | undefined {
  let model: ConversationModelRef | undefined;
  for (const value of entries) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as {
      type?: unknown;
      provider?: unknown;
      modelId?: unknown;
      message?: { role?: unknown; provider?: unknown; model?: unknown };
    };
    if (entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") {
      model = { provider: entry.provider, modelId: entry.modelId };
      continue;
    }
    if (entry.type === "message" && entry.message?.role === "assistant" &&
      typeof entry.message.provider === "string" && typeof entry.message.model === "string") {
      model = { provider: entry.message.provider, modelId: entry.message.model };
    }
  }
  return model;
}

/**
 * Pi remains authoritative for each conversation's model_change entries.
 * This adapter only carries the most recently active conversation model into
 * a genuinely new session/project.
 */
export function registerModelContinuity(
  pi: ExtensionAPI,
  options: ModelContinuityOptions = {},
): void {
  const store = options.store ?? defaultStore();
  const explicitModelRequested = options.explicitModelRequested ??
    process.argv.some((argument) => argument === "--model" || argument.startsWith("--model="));

  const persist = async (provider: string, modelId: string): Promise<void> => {
    await store.persist({ provider, modelId });
  };

  pi.on("model_select", async (event) => {
    await persist(event.model.provider, event.model.id);
  });

  pi.on("session_start", async (_event, ctx) => {
    const current = ctx.model;
    const branch = ctx.sessionManager.getBranch();
    const continuingConversation = branch.some(isConversationEntry);
    if (explicitModelRequested) {
      if (current !== undefined) await persist(current.provider, current.id);
      return;
    }

    // Pi resolves a resumed model before session_start. Imported providers are
    // registered by Picode during session_start, so Pi may have selected a
    // fallback even though the conversation's provider is now available.
    if (continuingConversation) {
      const remembered = modelFromConversation(branch);
      if (remembered === undefined) {
        if (current !== undefined) await persist(current.provider, current.id);
        return;
      }
      if (current !== undefined && remembered.provider === current.provider && remembered.modelId === current.id) {
        await persist(current.provider, current.id);
        return;
      }
      const restored = ctx.modelRegistry.find(remembered.provider, remembered.modelId);
      if (restored === undefined || !ctx.modelRegistry.hasConfiguredAuth(restored)) {
        ctx.ui.notify(
          `Conversation model ${remembered.provider}/${remembered.modelId} is unavailable; keeping ${current?.provider ?? "no"}/${current?.id ?? "model"}.`,
          "warning",
        );
        return;
      }
      const selected = await pi.setModel(restored);
      if (selected) {
        await persist(remembered.provider, remembered.modelId);
        return;
      }
      ctx.ui.notify(
        `Conversation model ${remembered.provider}/${remembered.modelId} could not be restored; keeping ${current?.provider ?? "no"}/${current?.id ?? "model"}.`,
        "warning",
      );
      return;
    }

    if (current === undefined) return;

    const previous = store.current()?.lastConversationModel;
    if (previous === undefined ||
      (previous.provider === current.provider && previous.modelId === current.id)) {
      await persist(current.provider, current.id);
      return;
    }
    const inherited = ctx.modelRegistry.find(previous.provider, previous.modelId);
    if (inherited === undefined || !ctx.modelRegistry.hasConfiguredAuth(inherited)) {
      ctx.ui.notify(
        `Previous conversation model ${previous.provider}/${previous.modelId} is unavailable; using ${current.provider}/${current.id}.`,
        "warning",
      );
      await persist(current.provider, current.id);
      return;
    }
    const selected = await pi.setModel(inherited);
    if (!selected) {
      ctx.ui.notify(
        `Previous conversation model ${previous.provider}/${previous.modelId} could not be selected; using ${current.provider}/${current.id}.`,
        "warning",
      );
      await persist(current.provider, current.id);
    }
  });
}
