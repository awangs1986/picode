import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PINNED_VERSION = "0.18.0";
const MARKER = "Picode compatibility seam: explicit Gemini API-only grounding";

/**
 * Export the already-implemented Gemini API path without copying the client.
 * The normal pi-web-access `gemini` provider deliberately keeps its browser
 * fallback; Picode's opt-in Google Search Subagent needs an explicit API-only
 * seam with caller-owned Vault credentials and model selection.
 */
export function applyPiWebAccessCompatibility(packageRoot) {
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (pkg.name !== "pi-web-access" || pkg.version !== PINNED_VERSION) {
    throw new Error(
      `Unsupported pi-web-access version ${String(pkg.version)}; review the pinned ${PINNED_VERSION} compatibility patch before upgrading.`,
    );
  }
  const path = join(packageRoot, "gemini-search.ts");
  const original = readFileSync(path, "utf8");
  if (original.includes(MARKER)) return { changedFiles: 0, patches: 1 };

  const functionOriginal = "async function searchWithGeminiApi(query: string, options: SearchOptions = {}): Promise<SearchResponse | null> {";
  if (!original.includes(functionOriginal)) {
    throw new Error("Unsupported pi-web-access Gemini API search layout.");
  }

  let next = original.replaceAll("searchWithGeminiApi(", "searchWithGeminiApiOnly(");
  next = next.replace(
    "async function searchWithGeminiApiOnly(query: string, options: SearchOptions = {}): Promise<SearchResponse | null> {",
    `// ${MARKER}\nexport interface GeminiApiOnlySearchOptions extends SearchOptions {\n\tapiKey?: string;\n\tmodel?: string;\n\ttimeoutMs?: number;\n}\n\nexport interface GeminiApiOnlySearchResponse extends SearchResponse {\n\tqueries: string[];\n}\n\nexport async function searchWithGeminiApiOnly(query: string, options: GeminiApiOnlySearchOptions = {}): Promise<GeminiApiOnlySearchResponse | null> {`,
  );
  next = next.replace("AbortSignal.timeout(60000)", "AbortSignal.timeout(options.timeoutMs ?? 60000)");
  next = next.replace(
    "const apiKey = await getApiKey(requestSignal);",
    "const apiKey = options.apiKey ?? await getApiKey(requestSignal);",
  );
  next = next.replace(
    "const model = getSearchConfig().searchModel ?? DEFAULT_SEARCH_MODEL;",
    "const model = options.model ?? getSearchConfig().searchModel ?? DEFAULT_SEARCH_MODEL;",
  );
  next = next.replace(
    "return { answer, results };",
    "return { answer, results, queries: metadata?.webSearchQueries ?? [query] };",
  );
  if (!next.includes(MARKER) || next === original) {
    throw new Error("Failed to apply pi-web-access API-only compatibility seam.");
  }
  writeFileSync(path, next, "utf8");
  return { changedFiles: 1, patches: 1 };
}
