/**
 * JavaScript-only lazy bridge keeps pi-web-access' internal TypeScript graph
 * outside Picode's compiler while still reusing the pinned implementation.
 */
export async function searchGeminiApiOnly(query, options) {
  const runtime = await import("pi-web-access/gemini-search.ts");
  return runtime.searchWithGeminiApiOnly(query, options);
}

export async function searchWithPiWebAccess(query, options) {
  const runtime = await import("pi-web-access/gemini-search.ts");
  return runtime.search(query, options);
}
