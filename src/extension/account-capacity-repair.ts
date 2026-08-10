import type { Model } from "@earendil-works/pi-ai";
import type { AccountCredentials, AccountsManager } from "../store/accounts.ts";
import type { AccountRef, ModelCapacity, Result } from "../shared/types.ts";
import { ok } from "../shared/types.ts";
import { largestKnownCapacity, probeModelCapacity } from "./model-capacity.ts";

export interface AccountCapacityRepair {
  account: AccountRef;
  repaired: boolean;
}

type CapacityProbe = (input: {
  baseUrl: string;
  accessToken: string;
  modelId: string;
}) => Promise<Result<ModelCapacity | undefined>>;

/** Backfill an old account at first use without changing credentials or activation state. */
export async function repairLegacyAccountCapacity(
  accounts: AccountsManager,
  account: AccountRef,
  credentials: AccountCredentials,
  knownModels: readonly Model<any>[],
  probe: CapacityProbe = probeModelCapacity,
): Promise<Result<AccountCapacityRepair>> {
  if (account.endpoint?.contextWindow !== undefined && account.endpoint.contextWindow >= 1_024) {
    return ok({ account, repaired: false });
  }

  const modelId = account.defaultModel ?? account.endpoint?.model;
  if (modelId === undefined || modelId.trim() === "") return ok({ account, repaired: false });

  const piProvider = account.piProvider ?? account.provider;
  let capacity = largestKnownCapacity(modelId, knownModels, piProvider);
  if (capacity === undefined) {
    const baseUrl = credentials.baseUrl ?? account.endpoint?.baseUrl;
    if (baseUrl === undefined || baseUrl.trim() === "") return ok({ account, repaired: false });
    const probed = await probe({ baseUrl, accessToken: credentials.accessToken, modelId });
    if (!probed.ok) return probed;
    capacity = probed.value;
  }
  if (capacity === undefined) return ok({ account, repaired: false });

  const updated = await accounts.updateModelCapacity(account.id, capacity);
  return updated.ok ? ok({ account: updated.value, repaired: true }) : updated;
}
