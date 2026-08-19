import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AccountsManager } from "../store/accounts.ts";
import { PiAccountAdapter } from "./pi-account-adapter.ts";
import { registerCursorSdkAdapter } from "./cursor-sdk-entry.ts";
import {
  registerWindowsPowerShellProvider,
  registerWindowsPowerShellTool,
} from "./windows-shell-provider.ts";
import { loadConfig } from "../store/config.ts";
import { loadCapabilitySettings } from "../store/capabilities.ts";
import { digestManifest } from "../guard/catalog.ts";
import {
  GOOGLE_SEARCH_SUBAGENT_CAPABILITY_ID,
  GOOGLE_SEARCH_SUBAGENT_MANIFEST,
} from "./google-search-manifest.ts";

type CursorRegistration = (
  pi: ExtensionAPI,
  options: { accounts: AccountsManager },
) => Promise<void>;

export interface SubagentProviderAdapterOptions {
  accounts?: AccountsManager;
  registerCursor?: CursorRegistration;
}

const NATIVE_PI_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "openai-codex",
  "google",
]);

/**
 * Keep a fresh pi-subagents child on the same Windows shell contract as its
 * parent Picode session without loading the complete Harness into the child.
 */
export function registerSubagentWindowsShell(
  pi: ExtensionAPI,
  platform = process.platform,
  options: { registerProvider?: boolean } = {},
): () => void {
  if (platform !== "win32") return () => undefined;
  const dispose = options.registerProvider === false
    ? () => undefined
    : registerWindowsPowerShellProvider(pi, platform);
  pi.on("session_start", (_event, ctx) => {
    registerWindowsPowerShellTool(pi, ctx.cwd, platform);
  });
  return dispose;
}

/**
 * Child-only provider projection for pi-subagents.
 *
 * Picode keeps imported credentials in its own Vault and projects them into
 * the parent Pi registry at runtime. A subagent is a fresh Pi process, so it
 * must repeat only that narrow projection before resolving `--model`; loading
 * the complete Harness here would create a second Task/Guard authority.
 */
export async function registerSubagentProviderAdapter(
  pi: ExtensionAPI,
  options: SubagentProviderAdapterOptions = {},
): Promise<void> {
  const accounts = options.accounts ?? new AccountsManager(() => {});
  const registerCursor = options.registerCursor ?? registerCursorSdkAdapter;
  const listed = accounts.list();
  if (!listed.ok) {
    throw new Error(`Subagent account projection failed: ${listed.error.message}`);
  }

  const [configured, capabilitySettings] = await Promise.all([
    Promise.resolve(loadConfig()),
    loadCapabilitySettings(),
  ]);
  const googleSetting = capabilitySettings.ok
    ? capabilitySettings.value.find((entry) => entry.id === GOOGLE_SEARCH_SUBAGENT_CAPABILITY_ID)
    : undefined;
  const googleSearchEnabled = googleSetting?.enabled === true &&
    googleSetting.trustedDigest === digestManifest(GOOGLE_SEARCH_SUBAGENT_MANIFEST);
  const googleSearchAccountId = configured.ok && googleSearchEnabled
    ? configured.value.googleSearchSubagent.accountId
    : undefined;
  const active = listed.value.filter((account) =>
    (account.status === "active" || account.id === googleSearchAccountId) &&
    account.status !== "retired" &&
    account.chatCompatible !== false
  );
  if (active.some((account) => account.provider === "cursor")) {
    await registerCursor(pi, { accounts });
  }

  const adapter = new PiAccountAdapter(pi);
  for (const account of active) {
    // The pinned Cursor adapter owns its SDK model catalog and credential
    // contract; applying it as an OpenAI-compatible custom provider is wrong.
    if (account.provider === "cursor") continue;
    const credentials = accounts.credentialsFor(account.id);
    if (!credentials.ok) {
      throw new Error(`Subagent account projection failed for ${account.label}: ${credentials.error.message}`);
    }
    const applied = adapter.apply(
      account,
      credentials.value,
      NATIVE_PI_PROVIDERS.has(account.provider),
    );
    if (!applied.ok) {
      throw new Error(`Subagent account projection failed for ${account.label}: ${applied.error.message}`);
    }
  }
}

export default async function subagentProviderEntry(pi: ExtensionAPI): Promise<void> {
  registerSubagentWindowsShell(pi);
  await registerSubagentProviderAdapter(pi);
}
