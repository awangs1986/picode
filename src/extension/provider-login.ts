import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AccountsManager } from "../store/accounts.ts";
import type { AccountRef, Result } from "../shared/types.ts";
import { err } from "../shared/types.ts";

function interactionFor(ui: ExtensionUIContext, signal: AbortSignal): AuthInteraction {
  return {
    signal,
    async prompt(prompt: AuthPrompt): Promise<string> {
      if (prompt.type === "select") {
        const labels = prompt.options.map((option) => option.label);
        const selected = await ui.select(
          prompt.message,
          labels,
          prompt.signal === undefined ? undefined : { signal: prompt.signal },
        );
        const option = prompt.options.find((candidate) => candidate.label === selected);
        if (option === undefined) throw new Error("login cancelled");
        return option.id;
      }
      const value = await ui.input(
        prompt.message,
        prompt.placeholder,
        prompt.signal === undefined ? undefined : { signal: prompt.signal },
      );
      if (value === undefined) throw new Error("login cancelled");
      return value;
    },
    notify(event: AuthEvent): void {
      const links = "links" in event && event.links !== undefined
        ? event.links.map((link) => link.url).join(" ")
        : event.type === "auth_url"
          ? event.url
          : event.type === "device_code"
            ? `${event.verificationUri} (${event.userCode})`
            : "";
      const message = "message" in event
        ? event.message
        : event.type === "auth_url"
          ? (event.instructions ?? "Open the authorization URL")
          : "Complete authorization in your browser";
      ui.notify(`${message}${links === "" ? "" : `\n${links}`}`, "info");
    },
  };
}

/** Run the auth implementation shipped by the pinned Pi provider, but persist
 * the resulting credential through Picode's one Account Vault authority. */
export async function loginProviderIntoVault(
  accounts: AccountsManager,
  provider: Provider,
  ui: ExtensionUIContext,
  signal: AbortSignal = new AbortController().signal,
): Promise<Result<AccountRef>> {
  try {
    const interaction = interactionFor(ui, signal);
    if (provider.auth.oauth !== undefined) {
      const credential = await provider.auth.oauth.login({ ...interaction, signal });
      return accounts.importCredentials({
        provider: provider.id,
        label: provider.name,
        credentials: {
          accessToken: credential.access,
          refreshToken: credential.refresh,
          expiresAt: credential.expires,
        },
      });
    }
    if (provider.auth.apiKey?.login !== undefined) {
      const credential = await provider.auth.apiKey.login({ ...interaction, signal });
      if (credential.key === undefined || credential.key === "") {
        return err("accounts/key-missing", `${provider.name} did not return an API key`);
      }
      return accounts.importCredentials({
        provider: provider.id,
        label: provider.name,
        credentials: { accessToken: credential.key },
      });
    }
    return err("accounts/login-unavailable", `${provider.name} has no interactive login flow`);
  } catch (cause) {
    return err("accounts/login-failed", `login failed for ${provider.name}`, cause);
  }
}
