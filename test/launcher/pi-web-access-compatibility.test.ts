import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applyPiWebAccessCompatibility } from "../../scripts/pi-web-access-compatibility.mjs";
import { searchGeminiApiOnly } from "../../scripts/pi-web-access-runtime.mjs";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

describe("pi-web-access compatibility", () => {
  it("exports one pinned API-only seam idempotently", async () => {
    await withTempPicodeDir(async (root) => {
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pi-web-access", version: "0.18.0" }));
      writeFileSync(join(root, "gemini-search.ts"), [
        "async function caller() { return searchWithGeminiApi('q', {}); }",
        "async function searchWithGeminiApi(query: string, options: SearchOptions = {}): Promise<SearchResponse | null> {",
        "const requestSignal = AbortSignal.any([AbortSignal.timeout(60000)]);",
        "const apiKey = await getApiKey(requestSignal);",
        "const model = getSearchConfig().searchModel ?? DEFAULT_SEARCH_MODEL;",
        "const metadata = data.candidates?.[0]?.groundingMetadata;",
        "return { answer, results };",
        "}",
      ].join("\n"));

      expect(applyPiWebAccessCompatibility(root)).toEqual({ changedFiles: 1, patches: 1 });
      expect(applyPiWebAccessCompatibility(root)).toEqual({ changedFiles: 0, patches: 1 });
      const patched = readFileSync(join(root, "gemini-search.ts"), "utf8");
      expect(patched).toContain("export async function searchWithGeminiApiOnly");
      expect(patched).toContain("options.apiKey ?? await getApiKey");
      expect(patched).toContain("queries: metadata?.webSearchQueries ?? [query]");
    });
  });

  it("refuses an unreviewed dependency version", async () => {
    await withTempPicodeDir(async (root) => {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pi-web-access", version: "9.0.0" }));
      expect(() => applyPiWebAccessCompatibility(root)).toThrow(/Unsupported pi-web-access version/u);
    });
  });

  it("loads the patched pinned package and returns real grounding metadata through the runtime seam", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: "grounded answer" }] },
        groundingMetadata: {
          webSearchQueries: ["grounded query"],
          groundingChunks: [{ web: { title: "Official", uri: "https://example.test/source" } }],
        },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const previousFetch = globalThis.fetch;
    globalThis.fetch = request as typeof fetch;
    try {
      const result = await searchGeminiApiOnly("question", {
        apiKey: "test-only-key",
        model: "gemini-test",
        timeoutMs: 10_000,
      });
      expect(result).toEqual({
        answer: "grounded answer",
        queries: ["grounded query"],
        results: [{ title: "Official", url: "https://example.test/source", snippet: "" }],
      });
      expect(request).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
