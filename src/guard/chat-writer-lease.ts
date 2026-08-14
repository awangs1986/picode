import type { Result } from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";

export interface ChatWriterOwner {
  kind: "tui" | "remote" | "cli";
  id: string;
}

export interface ChatWriterLease {
  session: string;
  owner: ChatWriterOwner;
  expiresAt: number;
}

function sameOwner(left: ChatWriterOwner, right: ChatWriterOwner): boolean {
  return left.kind === right.kind && left.id === right.id;
}

/** Guard-owned authority for the one-writer-per-Chat invariant. */
export class ChatWriterLeases {
  private readonly leases = new Map<string, ChatWriterLease>();

  constructor(private readonly now: () => number = Date.now) {}

  current(session: string): ChatWriterLease | undefined {
    const lease = this.leases.get(session);
    if (lease === undefined) return undefined;
    if (lease.expiresAt <= this.now()) {
      this.leases.delete(session);
      return undefined;
    }
    return { ...lease, owner: { ...lease.owner } };
  }

  acquire(session: string, owner: ChatWriterOwner, ttlMs: number): Result<ChatWriterLease> {
    if (session.trim() === "" || owner.id.trim() === "" || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      return err("guard/writer-lease-invalid", "session, owner, and a positive lease duration are required");
    }
    const current = this.current(session);
    if (current !== undefined && !sameOwner(current.owner, owner)) {
      return err("guard/writer-lease-held", `Chat Writer Lease is held by ${current.owner.kind}`);
    }
    const lease = { session, owner: { ...owner }, expiresAt: this.now() + ttlMs };
    this.leases.set(session, lease);
    return ok({ ...lease, owner: { ...lease.owner } });
  }

  heartbeat(session: string, owner: ChatWriterOwner, ttlMs: number): Result<ChatWriterLease> {
    const current = this.current(session);
    if (current === undefined || !sameOwner(current.owner, owner)) {
      return err("guard/writer-lease-missing", "Chat Writer Lease is not held by this owner");
    }
    return this.acquire(session, owner, ttlMs);
  }

  owns(session: string, owner: ChatWriterOwner): boolean {
    const current = this.current(session);
    return current !== undefined && sameOwner(current.owner, owner);
  }

  release(session: string, owner: ChatWriterOwner): boolean {
    const current = this.current(session);
    if (current === undefined || !sameOwner(current.owner, owner)) return false;
    this.leases.delete(session);
    return true;
  }

  releaseOwner(owner: ChatWriterOwner): number {
    let released = 0;
    for (const [session, lease] of this.leases) {
      if (!sameOwner(lease.owner, owner)) continue;
      this.leases.delete(session);
      released += 1;
    }
    return released;
  }
}
