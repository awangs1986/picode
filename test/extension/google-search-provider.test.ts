import { describe, expect, it, vi } from "vitest";
import { PiWebGoogleSearchBackend } from "../../src/extension/google-search-provider.ts";

describe("PiWebGoogleSearchBackend", () => {
  it("passes the Vault key and selected model only to the API-only seam", async () => {
    const google = vi.fn(async () => ({
      answer: "answer",
      results: [{ title: "source", url: "https://example.test", snippet: "fact" }],
      queries: ["q1", "q2"],
    }));
    const fallback = vi.fn();
    const backend = new PiWebGoogleSearchBackend({ google, fallback });

    const result = await backend.ground({
      query: "question",
      apiKey: "vault-secret",
      model: "google/gemini-test",
      timeoutMs: 10_000,
      fallback: true,
    });

    expect(google).toHaveBeenCalledWith("question", expect.objectContaining({
      apiKey: "vault-secret",
      model: "gemini-test",
    }));
    expect(fallback).not.toHaveBeenCalled();
    expect(result.actualProvider).toBe("google-gemini-api");
    expect(result.queries).toEqual(["q1", "q2"]);
  });

  it("falls back exactly once, records the actual provider, and redacts the key", async () => {
    const google = vi.fn(async () => { throw new Error("quota for vault-secret"); });
    const fallback = vi.fn(async () => ({
      answer: "fallback",
      results: [{ title: "source", url: "https://fallback.test", snippet: "fact" }],
      provider: "brave",
    }));
    const backend = new PiWebGoogleSearchBackend({ google, fallback });

    const result = await backend.ground({
      query: "question",
      apiKey: "vault-secret",
      model: "google/gemini-test",
      timeoutMs: 10_000,
      fallback: true,
    });

    expect(google).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledOnce();
    expect(result.actualProvider).toBe("pi-web-access:brave");
    expect(result.fallbackReason).toContain("[redacted]");
    expect(result.fallbackReason).not.toContain("vault-secret");
  });

  it("redacts the Vault key even when fallback is disabled or also fails", async () => {
    const google = vi.fn(async () => { throw new Error("bad vault-secret"); });
    const fallback = vi.fn(async () => { throw new Error("fallback echoed vault-secret"); });
    const backend = new PiWebGoogleSearchBackend({ google, fallback });
    const request = {
      query: "question",
      apiKey: "vault-secret",
      model: "google/gemini-test",
      timeoutMs: 10_000,
    };

    await expect(backend.ground({ ...request, fallback: false })).rejects.not.toThrow(/vault-secret/u);
    await expect(backend.ground({ ...request, fallback: true })).rejects.not.toThrow(/vault-secret/u);
    expect(fallback).toHaveBeenCalledOnce();
  });
});
