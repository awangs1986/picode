import type {
  ContextLedgerEntry,
  ContextLedgerEntryInput,
  ContextLedgerStorePort,
  Result,
} from "../../shared/types.ts";
import { contextDigest } from "./context-budget-meter.ts";

/** Single audit seam for every context-retention and compaction layer. */
export class ContextLedger {
  constructor(private readonly store: ContextLedgerStorePort) {}

  record(input: ContextLedgerEntryInput): Promise<Result<void>> {
    const eventId = contextDigest(input);
    return this.store.appendContextLedger({
      ...input,
      schemaVersion: "picode.context-ledger/v1",
      eventId,
      recordedAt: new Date().toISOString(),
    });
  }

  list(sessionId: string): Promise<Result<ContextLedgerEntry[]>> {
    return this.store.listContextLedger(sessionId);
  }
}
