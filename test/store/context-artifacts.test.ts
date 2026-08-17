import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../../src/store/index.ts";
import { sealedCapsule } from "../helpers/fixtures.ts";

const roots: string[] = [];
afterEach(() => {
  delete process.env["PICODE_DIR"];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Store context artifacts", () => {
  it("persists a deterministic private artifact beneath the Picode data root", async () => {
    const root = join(tmpdir(), `picode-artifact-${randomUUID()}`);
    roots.push(root);
    process.env["PICODE_DIR"] = root;
    const store = new Store();

    const saved = await store.saveContextArtifact({
      sessionId: "session/unsafe",
      toolCallId: "call:1",
      toolName: "bash",
      text: "full tool output",
    });

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.path.startsWith(join(root, "artifacts", "context"))).toBe(true);
    expect(existsSync(saved.value.path)).toBe(true);
    expect(readFileSync(saved.value.path, "utf8")).toBe("full tool output");
    expect(saved.value.bytes).toBe(Buffer.byteLength("full tool output"));
  });

  it("persists compilation manifests and endpoint capacity evidence as derived state", async () => {
    const root = join(tmpdir(), `picode-context-derived-${randomUUID()}`);
    roots.push(root);
    process.env["PICODE_DIR"] = root;
    const store = new Store();
    const profile = {
      schemaVersion: "picode.endpoint-context/v1" as const,
      routeKey: "openai-responses|https://proxy.example/v1|gpt-test",
      verifiedContextWindow: 300_000,
      observedSuccessInputTokens: 210_000,
    };
    expect((await store.saveEndpointContextProfile(profile)).ok).toBe(true);
    expect(await store.loadEndpointContextProfile(profile.routeKey)).toEqual({ ok: true, value: profile });

    const manifest = {
      schemaVersion: "picode.context-compilation/v1" as const,
      compilerVersion: 1 as const,
      sessionId: "session-1",
      sessionRevision: "10:leaf",
      action: "compact" as const,
      inputDigest: "a".repeat(64),
      outputDigest: "b".repeat(64),
      beforeTokens: 300_000,
      afterTokens: 180_000,
      effectiveContextWindow: 320_000,
      reliableContextCeiling: 320_000,
      replacements: [],
    };
    const saved = await store.saveContextCompilation(manifest);
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(readFileSync(saved.value, "utf8")).toContain(manifest.inputDigest);
  });

  it("loads the newest sealed Capsule and ignores drafts and superseded history", async () => {
    const root = join(tmpdir(), `picode-capsule-latest-${randomUUID()}`);
    roots.push(root);
    process.env["PICODE_DIR"] = root;
    const store = new Store();
    const older = sealedCapsule({ capsuleId: "older", createdAt: "2026-01-01T00:00:00.000Z" });
    const newer = sealedCapsule({ capsuleId: "newer", createdAt: "2026-01-02T00:00:00.000Z" });
    const superseded = sealedCapsule({
      capsuleId: "superseded",
      createdAt: "2026-01-03T00:00:00.000Z",
      status: "superseded",
      supersededBy: "newer",
    });
    expect((await store.saveCapsule(older)).ok).toBe(true);
    expect((await store.saveCapsule(newer)).ok).toBe(true);
    expect((await store.saveCapsule(superseded)).ok).toBe(true);

    expect(await store.loadLatestSealedCapsule("task-1")).toEqual({ ok: true, value: newer });
    expect(await store.loadLatestSealedCapsule("missing")).toEqual({ ok: true, value: undefined });
  });
});
