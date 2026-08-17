import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { AccountsManager } from "../store/accounts.ts";
import { PiAccountAdapter } from "./pi-account-adapter.ts";
import {
  loadCursorModelCatalog,
  refreshCursorModelCatalog,
  type CursorModelCatalogRefresh,
} from "./cursor-model-catalog.ts";

type CursorSdkFactory = (pi: ExtensionAPI) => Promise<void> | void;

async function loadPinnedCursorSdk(): Promise<CursorSdkFactory> {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve("pi-cursor-sdk/package.json");
  const moduleUrl = pathToFileURL(join(dirname(manifest), "src", "index.ts")).href;
  const loaded = await import(moduleUrl) as { default: CursorSdkFactory };
  return loaded.default;
}

export interface CursorSdkAdapterOptions {
  accounts?: AccountsManager;
  loadSdk?: () => Promise<CursorSdkFactory>;
  loadModels?: (apiKey: string) => Promise<CursorModelCatalogRefresh>;
  refreshModels?: (apiKey: string) => Promise<CursorModelCatalogRefresh>;
}

function knownModels(ctx: ExtensionCommandContext): readonly Model<any>[] {
  return ctx.modelRegistry.getAll();
}

function notifyFailure(ctx: ExtensionCommandContext, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message, "error");
}

/**
 * Load the pinned Cursor extension behind one Picode-owned adapter seam.
 *
 * The upstream refresh command re-registers its provider with a placeholder
 * credential that can only resolve from Pi auth.json or CURSOR_API_KEY. Picode
 * deliberately keeps its Account Vault authoritative, so the adapter replaces
 * only that command handler and atomically applies the live catalog with the
 * active Vault key. All other SDK tools, hooks, and provider behavior pass
 * through unchanged.
 */
export async function registerCursorSdkAdapter(
  pi: ExtensionAPI,
  options: CursorSdkAdapterOptions = {},
): Promise<void> {
  const accounts = options.accounts ?? new AccountsManager(() => {});
  const accountAdapter = new PiAccountAdapter(pi);
  const loadSdk = options.loadSdk ?? loadPinnedCursorSdk;
  const refreshModels = options.refreshModels ?? refreshCursorModelCatalog;
  const loadModels = options.loadModels ?? loadCursorModelCatalog;
  const listed = accounts.list();
  const active = listed.ok
    ? listed.value.find((candidate) =>
      candidate.provider === "cursor" &&
      candidate.authKind === "api_key" &&
      candidate.status === "active" &&
      candidate.chatCompatible !== false
    )
    : undefined;
  const credentials = active === undefined ? undefined : accounts.credentialsFor(active.id);
  const exposeCursorCatalog = credentials?.ok === true;

  const sdkApi = new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerProvider") {
        return (name: string, config: Parameters<ExtensionAPI["registerProvider"]>[1]): void => {
          if (name === "cursor" && !exposeCursorCatalog) {
            // Keep the SDK runtime/hooks loaded so a later Picode account import
            // can activate it in this process, but never expose its bundled
            // fallback catalog as if the fresh machine had a Cursor account.
            pi.registerProvider(name, { ...config, models: [] });
            return;
          }
          pi.registerProvider(name, config);
        };
      }
      if (property !== "registerCommand") {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (
        name: string,
        command: Parameters<ExtensionAPI["registerCommand"]>[1],
      ): void => {
        if (name !== "cursor-refresh-models") {
          pi.registerCommand(name, command);
          return;
        }
        pi.registerCommand(name, {
          ...command,
          description: "Refresh Cursor models with the active Picode account",
          handler: async (args, ctx) => {
            const listed = accounts.list();
            if (!listed.ok) {
              notifyFailure(ctx, `Cursor account lookup failed: ${listed.error.message}`);
              return;
            }
            const active = listed.value.find((candidate) =>
              candidate.provider === "cursor" &&
              candidate.authKind === "api_key" &&
              candidate.status === "active" &&
              candidate.chatCompatible !== false
            );
            // Keep the upstream command useful for native Pi /login users when
            // Picode has no Cursor API-key account to project.
            if (active === undefined) {
              await command.handler(args, ctx);
              return;
            }
            const credentials = accounts.credentialsFor(active.id);
            if (!credentials.ok) {
              notifyFailure(ctx, `Cursor credentials could not be loaded: ${credentials.error.message}`);
              return;
            }
            try {
              const refreshed = await refreshModels(credentials.value.accessToken);
              const applied = accountAdapter.apply(
                active,
                credentials.value,
                true,
                knownModels(ctx),
                refreshed.models as ProviderModelConfig[],
              );
              if (!applied.ok) {
                notifyFailure(ctx, `Cursor model refresh could not update Pi: ${applied.error.message}`);
                return;
              }
              if (!ctx.hasUI) return;
              if (refreshed.fallbackIssue !== undefined) {
                ctx.ui.notify(
                  `Cursor model catalog refresh did not use a live catalog: ${refreshed.fallbackIssue.message}`,
                  "warning",
                );
                return;
              }
              const suffix = refreshed.models.length === 1 ? "model" : "models";
              ctx.ui.notify(`Cursor model catalog refreshed with ${refreshed.models.length} ${suffix}.`, "info");
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : String(cause);
              if (!ctx.hasUI) throw cause;
              ctx.ui.notify(`Cursor model catalog refresh failed: ${message}`, "error");
            }
          },
        });
      };
    },
  });

  const sdk = await loadSdk();
  await sdk(sdkApi);

  // The SDK initializes before Picode's session_start account projection. Its
  // own discovery therefore cannot see credentials held only in the Picode
  // Vault and would register the bundled fallback list on every restart.
  // Restore the cache-aware live catalog immediately through the same provider
  // seam; transient discovery failures leave the upstream fallback intact.
  if (!listed.ok) return;
  if (active === undefined) return;
  if (credentials?.ok !== true) return;
  try {
    const restored = await loadModels(credentials.value.accessToken);
    accountAdapter.apply(
      active,
      credentials.value,
      true,
      [],
      restored.models as ProviderModelConfig[],
    );
  } catch {
    // Startup remains available with the SDK fallback catalog. The explicit
    // refresh command reports actionable failures and can retry later.
  }
}

export default async function cursorSdkAdapter(pi: ExtensionAPI): Promise<void> {
  await registerCursorSdkAdapter(pi);
}
