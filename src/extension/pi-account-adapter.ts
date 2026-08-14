import type {
  ExtensionAPI,
  ProviderConfig,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { AccountRef, Result } from "../shared/types.ts";
import type { AccountCredentials } from "../store/accounts.ts";
import { err, ok } from "../shared/types.ts";
import { largestKnownCapacity, parseTokenLimit } from "./model-capacity.ts";

/** Apply the selected Picode Vault account to Pi's live provider registry. */
export class PiAccountAdapter {
  constructor(private readonly pi: Pick<ExtensionAPI, "registerProvider">) {}

  apply(
    account: AccountRef,
    credentials: AccountCredentials,
    providerAlreadyExists: boolean,
    knownModels: readonly Model<any>[] = [],
    refreshedModels?: readonly ProviderModelConfig[],
  ): Result<void> {
    try {
      if (providerAlreadyExists) {
        const refreshedBaseUrl = credentials.baseUrl ?? account.endpoint?.baseUrl ??
          (account.provider === "cursor" ? "https://cursor.com" : undefined);
        const refreshedApi = account.provider === "cursor"
          ? "cursor-sdk" as const
          : account.endpoint?.api as ProviderConfig["api"] | undefined;
        if (refreshedModels !== undefined) {
          if (refreshedBaseUrl === undefined || refreshedApi === undefined) {
            return err(
              "accounts/refreshed-provider-incomplete",
              `refreshed provider ${account.provider} requires Base URL and API type`,
            );
          }
          this.pi.registerProvider(account.provider, {
            name: account.label,
            apiKey: credentials.accessToken,
            baseUrl: refreshedBaseUrl,
            api: refreshedApi,
            models: [...refreshedModels],
          });
          return ok(undefined);
        }
        this.pi.registerProvider(account.provider, {
          name: account.label,
          apiKey: credentials.accessToken,
          ...(credentials.baseUrl === undefined ? {} : { baseUrl: credentials.baseUrl }),
        });
        return ok(undefined);
      }
      if (credentials.baseUrl === undefined || account.defaultModel === undefined) {
        return err(
          "accounts/custom-provider-incomplete",
          `custom provider ${account.provider} requires Base URL and default model`,
        );
      }
      const api = account.provider.toLowerCase().includes("anthropic")
        ? "anthropic-messages" as const
        : "openai-responses" as const;
      const importedContextWindow = parseTokenLimit(account.endpoint?.contextWindow);
      const importedMaxTokens = parseTokenLimit(account.endpoint?.maxTokens);
      const importedCapacity = importedContextWindow === undefined
        ? undefined
        : {
            contextWindow: importedContextWindow,
            ...(importedMaxTokens === undefined
              ? {}
              : { maxTokens: Math.min(importedMaxTokens, importedContextWindow) }),
          };
      const capacity = importedCapacity ?? largestKnownCapacity(
        account.defaultModel,
        knownModels,
        account.piProvider ?? account.provider,
      );
      if (capacity === undefined) {
        return err(
          "accounts/model-capacity-unknown",
          `model ${account.defaultModel} has no trustworthy context-window metadata; re-import it with a context limit or expose capacity from the provider model catalog`,
        );
      }
      const config: ProviderConfig = {
        name: account.label,
        baseUrl: credentials.baseUrl,
        apiKey: credentials.accessToken,
        api,
        models: [{
          id: account.defaultModel,
          name: account.defaultModel,
          api,
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: capacity.contextWindow,
          maxTokens: capacity.maxTokens ?? Math.min(16_384, capacity.contextWindow),
        }],
      };
      this.pi.registerProvider(account.provider, config);
      return ok(undefined);
    } catch (cause) {
      return err("accounts/provider-apply-failed", `failed to apply ${account.id} to Pi`, cause);
    }
  }
}
