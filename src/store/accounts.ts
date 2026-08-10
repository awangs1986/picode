import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { atomicWriteFile, withFileLock } from "../shared/fs.ts";
import { dataPaths } from "../shared/paths.ts";
import type { AccountRef, ModelCapacity, Result } from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";

/**
 * 账号 vault（PICODE-V3-DESIGN.md §3.1，Q4/Q14）：
 * Picode 自己管理 OAuth 流与凭据，存 accounts.json（0600）。
 * 同 Provider 可存多个账号，同时只有一个 active；
 * 切换不动上下文——组合根收到 switched 信号后记新 Execution Epoch
 * 并另起 Cache Epoch（前缀失效可见化）。
 */

export interface AccountCredentials {
  accessToken: string;
  refreshToken?: string;
  baseUrl?: string;
  /** epoch ms */
  expiresAt?: number;
}

export interface StoredAccount extends AccountRef {
  credentials?: AccountCredentials;
}

export interface AccountImportInput {
  stableId?: string;
  provider: string;
  piProvider?: string;
  label: string;
  credentials: AccountCredentials;
  defaultModel?: string;
  authKind?: AccountRef["authKind"];
  chatCompatible?: boolean;
  endpoint?: AccountRef["endpoint"];
  metadata?: Record<string, unknown>;
  warnings?: string[];
}

interface VaultFile {
  version: 1;
  accounts: StoredAccount[];
}

/**
 * OAuth 流的窄缝：每个 Provider 一个实现（P1 作者实装/官方流引导）。
 * 外部 Agent 账号"导入" = 引导式走各家官方 OAuth（不搬运外部凭据文件）。
 */
export interface OAuthFlow {
  provider: string;
  login(): Promise<Result<{ label: string; credentials: AccountCredentials }>>;
}

function toRef(account: StoredAccount): AccountRef {
  const { credentials: _credentials, ...ref } = account;
  return ref;
}

export class AccountsManager {
  constructor(
    /** 活跃账号变更 → 组合根记 Execution Epoch + Cache Epoch */
    private readonly onActiveChanged: (provider: string, accountId: string) => void,
  ) {}

  private accountId(provider: string): string {
    return `${provider}:${randomUUID()}`;
  }

  private load(): Result<VaultFile> {
    const path = dataPaths.accounts();
    if (!existsSync(path)) return ok({ version: 1, accounts: [] });
    try {
      return ok(JSON.parse(readFileSync(path, "utf8")) as VaultFile);
    } catch (cause) {
      return err("store/accounts-unreadable", `cannot parse ${path}`, cause);
    }
  }

  private async save(vault: VaultFile): Promise<Result<void>> {
    try {
      await withFileLock(`${dataPaths.accounts()}.lock`, () => {
        atomicWriteFile(dataPaths.accounts(), JSON.stringify(vault, null, 2), {
          mode: 0o600,
        });
      });
      return ok(undefined);
    } catch (cause) {
      return err("store/accounts-write-failed", "failed to persist accounts", cause);
    }
  }

  /** 无秘密投影（/accounts 列表、调试面用） */
  list(): Result<AccountRef[]> {
    const vault = this.load();
    if (!vault.ok) return vault;
    return ok(vault.value.accounts.map(toRef));
  }

  /** OAuth 登录成功后入库；新账号默认 stored（不抢 active） */
  async addFromOAuth(flow: OAuthFlow): Promise<Result<AccountRef>> {
    const login = await flow.login();
    if (!login.ok) return login;
    const vault = this.load();
    if (!vault.ok) return vault;

    const account: StoredAccount = {
      id: this.accountId(flow.provider),
      provider: flow.provider,
      label: login.value.label,
      status: "stored",
      credentials: login.value.credentials,
    };
    vault.value.accounts.push(account);
    const saved = await this.save(vault.value);
    if (!saved.ok) return saved;
    return ok(toRef(account));
  }

  /** Web Wizard/JSON import enters through the same vault authority as OAuth. */
  async importCredentials(input: AccountImportInput): Promise<Result<AccountRef>> {
    const imported = await this.importMany([input]);
    if (!imported.ok) return imported;
    const account = imported.value[0];
    return account === undefined
      ? err("store/account-import-empty", "account import produced no account")
      : ok(account);
  }

  /** Atomic Web Wizard apply seam: selected candidates are upserted in one vault write. */
  async importMany(
    inputs: readonly AccountImportInput[],
    activateStableId?: string,
  ): Promise<Result<AccountRef[]>> {
    if (inputs.length === 0) return err("store/account-import-empty", "select at least one account");
    const vault = this.load();
    if (!vault.ok) return vault;
    const imported: StoredAccount[] = [];
    for (const input of inputs) {
      const id = input.stableId === undefined
        ? this.accountId(input.provider)
        : `${input.provider}:${input.stableId}`;
      const account: StoredAccount = {
        id,
        provider: input.provider,
        label: input.label,
        status: "stored",
        credentials: input.credentials,
        ...(input.piProvider === undefined ? {} : { piProvider: input.piProvider }),
        ...(input.defaultModel === undefined ? {} : { defaultModel: input.defaultModel }),
        ...(input.authKind === undefined ? {} : { authKind: input.authKind }),
        ...(input.chatCompatible === undefined ? {} : { chatCompatible: input.chatCompatible }),
        ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        ...(input.warnings === undefined ? {} : { warnings: input.warnings }),
      };
      const index = vault.value.accounts.findIndex((candidate) => candidate.id === id);
      if (index === -1) vault.value.accounts.push(account);
      else vault.value.accounts[index] = account;
      imported.push(account);
    }
    if (activateStableId !== undefined) {
      const active = imported.find((account) => account.id === `${account.provider}:${activateStableId}`);
      if (active === undefined) return err("store/account-activation-missing", "active account was not selected");
      if (active.chatCompatible === false) {
        return err("store/account-chat-incompatible", "selected account cannot be activated for Pi chat");
      }
      for (const account of vault.value.accounts) {
        if (account.provider === active.provider && account.status === "active") account.status = "stored";
      }
      active.status = "active";
    }
    const saved = await this.save(vault.value);
    return saved.ok ? ok(imported.map(toRef)) : saved;
  }

  /**
   * 切换活跃账号：同 Provider 原 active 降为 stored（单账号活跃不变量）。
   * 成功后触发 onActiveChanged（Epoch 记账在组合根）。
   */
  async setActive(accountId: string): Promise<Result<AccountRef>> {
    const vault = this.load();
    if (!vault.ok) return vault;

    const target = vault.value.accounts.find((a) => a.id === accountId);
    if (!target) return err("store/account-unknown", `no account: ${accountId}`);
    if (target.status === "retired") {
      return err("store/account-retired", `account ${accountId} is retired`);
    }

    for (const account of vault.value.accounts) {
      if (account.provider === target.provider && account.status === "active") {
        account.status = "stored";
      }
    }
    target.status = "active";

    const saved = await this.save(vault.value);
    if (!saved.ok) return saved;
    this.onActiveChanged(target.provider, target.id);
    return ok(toRef(target));
  }

  async relabel(accountId: string, label: string): Promise<Result<void>> {
    const vault = this.load();
    if (!vault.ok) return vault;
    const target = vault.value.accounts.find((a) => a.id === accountId);
    if (!target) return err("store/account-unknown", `no account: ${accountId}`);
    target.label = label;
    return this.save(vault.value);
  }

  /** 当前 Provider 的活跃凭据（Engine 侧使用；不出调试面） */
  activeCredentials(provider: string): Result<AccountCredentials> {
    const vault = this.load();
    if (!vault.ok) return vault;
    const active = vault.value.accounts.find(
      (a) => a.provider === provider && a.status === "active",
    );
    if (!active?.credentials) {
      return err("store/no-active-account", `no active account with credentials for ${provider}`);
    }
    return ok(active.credentials);
  }

  /** Internal Adapter seam; never expose this result through debug/API projections. */
  credentialsFor(accountId: string): Result<AccountCredentials> {
    const vault = this.load();
    if (!vault.ok) return vault;
    const account = vault.value.accounts.find((candidate) => candidate.id === accountId);
    if (!account?.credentials) {
      return err("store/account-credentials-missing", `no credentials for account: ${accountId}`);
    }
    return ok(account.credentials);
  }

  /**
   * Migration seam for accounts imported before model limits were persisted.
   * Only safe endpoint metadata changes; identity, status and credentials stay byte-for-byte intact.
   */
  async updateModelCapacity(
    accountId: string,
    capacity: ModelCapacity,
  ): Promise<Result<AccountRef>> {
    if (!Number.isSafeInteger(capacity.contextWindow) || capacity.contextWindow < 1_024) {
      return err("store/account-capacity-invalid", "model context window must be at least 1024 tokens");
    }
    if (capacity.maxTokens !== undefined &&
      (!Number.isSafeInteger(capacity.maxTokens) || capacity.maxTokens < 1_024 ||
        capacity.maxTokens > capacity.contextWindow)) {
      return err("store/account-capacity-invalid", "model output limit must fit within its context window");
    }
    const path = dataPaths.accounts();
    try {
      return await withFileLock(`${path}.lock`, () => {
        const vault = this.load();
        if (!vault.ok) return vault;
        const target = vault.value.accounts.find((account) => account.id === accountId);
        if (target === undefined) return err("store/account-unknown", `no account: ${accountId}`);
        target.endpoint = {
          ...target.endpoint,
          contextWindow: capacity.contextWindow,
          ...(capacity.maxTokens === undefined ? {} : { maxTokens: capacity.maxTokens }),
        };
        atomicWriteFile(path, JSON.stringify(vault.value, null, 2), { mode: 0o600 });
        return ok(toRef(target));
      });
    } catch (cause) {
      return err(
        "store/account-capacity-update-failed",
        `failed to persist model capacity for account ${accountId}`,
        cause,
      );
    }
  }

  /**
   * Adapter-only serialized credential mutation. The updater runs while the
   * cross-process vault lock is held so rotated OAuth refresh tokens cannot be
   * refreshed concurrently and then overwritten by another Picode process.
   */
  async modifyActiveCredentials(
    provider: string,
    updater: (current: AccountCredentials) => Promise<AccountCredentials> | AccountCredentials,
  ): Promise<Result<AccountCredentials>> {
    const path = dataPaths.accounts();
    try {
      return await withFileLock(`${path}.lock`, async () => {
        const vault = this.load();
        if (!vault.ok) return vault;
        const active = vault.value.accounts.find(
          (account) => account.provider === provider && account.status === "active",
        );
        if (active?.credentials === undefined) {
          return err(
            "store/no-active-account",
            `no active account with credentials for ${provider}`,
          );
        }
        const updated = await updater({ ...active.credentials });
        active.credentials = updated;
        atomicWriteFile(path, JSON.stringify(vault.value, null, 2), { mode: 0o600 });
        return ok(updated);
      });
    } catch (cause) {
      return err(
        "store/account-credential-update-failed",
        `failed to update active credentials for ${provider}`,
        cause,
      );
    }
  }
}
