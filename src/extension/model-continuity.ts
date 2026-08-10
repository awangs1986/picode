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
    if (current === undefined) return;
    const continuingConversation = ctx.sessionManager.getBranch().some(isConversationEntry);
    if (continuingConversation || explicitModelRequested) {
      await persist(current.provider, current.id);
      return;
    }

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
