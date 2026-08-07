import type { OAuthCredential, Provider } from "@earendil-works/pi-ai";
import type { Result } from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";
import type { AccountsManager } from "../store/accounts.ts";

export interface ProviderRefreshResult {
  refreshed: boolean;
  accessToken?: string;
}

export interface ProviderRefreshOptions {
  now?: () => number;
  refreshSkewMs?: number;
  signal?: AbortSignal;
}

/** Refresh the selected Picode OAuth account before Pi constructs a request. */
export async function refreshActiveProviderAccount(
  accounts: AccountsManager,
  provider: Provider,
  options: ProviderRefreshOptions = {},
): Promise<Result<ProviderRefreshResult>> {
  const current = accounts.activeCredentials(provider.id);
  if (!current.ok) {
    return current.error.code === "store/no-active-account"
      ? ok({ refreshed: false })
      : current;
  }

  const now = options.now ?? Date.now;
  const skew = options.refreshSkewMs ?? 60_000;
  const credential = current.value;
  if (
    credential.refreshToken === undefined
    || credential.expiresAt === undefined
    || credential.expiresAt > now() + skew
  ) {
    return ok({ refreshed: false, accessToken: credential.accessToken });
  }
  if (provider.auth.oauth === undefined) {
    return err(
      "accounts/oauth-refresh-unavailable",
      `${provider.name} has no OAuth refresh implementation`,
    );
  }

  const signal = options.signal ?? new AbortController().signal;
  const oauth = provider.auth.oauth;
  const updated = await accounts.modifyActiveCredentials(provider.id, async (locked) => {
    if (
      locked.expiresAt !== undefined
      && locked.expiresAt > now() + skew
    ) return locked;
    if (locked.refreshToken === undefined || locked.expiresAt === undefined) return locked;
    const refreshed = await oauth.refresh({
      type: "oauth",
      access: locked.accessToken,
      refresh: locked.refreshToken,
      expires: locked.expiresAt,
    } satisfies OAuthCredential, signal);
    return {
      ...locked,
      accessToken: refreshed.access,
      refreshToken: refreshed.refresh,
      expiresAt: refreshed.expires,
    };
  });
  if (!updated.ok) return updated;
  return ok({
    refreshed: updated.value.accessToken !== credential.accessToken,
    accessToken: updated.value.accessToken,
  });
}
