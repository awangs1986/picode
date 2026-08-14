import { describe, expect, it } from "vitest";
import { ChatWriterLeases } from "../../src/guard/chat-writer-lease.ts";

describe("ChatWriterLeases", () => {
  it("keeps one writer per Chat and lets the same owner renew", () => {
    let now = 1_000;
    const leases = new ChatWriterLeases(() => now);
    const phone = { kind: "remote" as const, id: "device-a/connection-a" };
    const other = { kind: "remote" as const, id: "device-b/connection-b" };

    const first = leases.acquire("session-1", phone, 300);
    expect(first.ok).toBe(true);
    expect(leases.acquire("session-1", other, 300)).toMatchObject({
      ok: false,
      error: { code: "guard/writer-lease-held" },
    });

    now += 100;
    const renewed = leases.acquire("session-1", phone, 300);
    expect(renewed).toMatchObject({ ok: true, value: { expiresAt: 1_400 } });
  });

  it("allows takeover only after expiry and rejects stale heartbeats", () => {
    let now = 2_000;
    const leases = new ChatWriterLeases(() => now);
    const first = { kind: "remote" as const, id: "first" };
    const second = { kind: "tui" as const, id: "local" };
    expect(leases.acquire("session-1", first, 100).ok).toBe(true);

    now = 2_101;
    expect(leases.heartbeat("session-1", first, 100)).toMatchObject({
      ok: false,
      error: { code: "guard/writer-lease-missing" },
    });
    expect(leases.acquire("session-1", second, 100)).toMatchObject({
      ok: true,
      value: { owner: second },
    });
  });

  it("releases every Chat owned by a disconnected client", () => {
    const leases = new ChatWriterLeases(() => 5_000);
    const owner = { kind: "remote" as const, id: "device/connection" };
    expect(leases.acquire("session-1", owner, 300).ok).toBe(true);
    expect(leases.acquire("session-2", owner, 300).ok).toBe(true);

    expect(leases.releaseOwner(owner)).toBe(2);
    expect(leases.current("session-1")).toBeUndefined();
    expect(leases.current("session-2")).toBeUndefined();
  });
});
