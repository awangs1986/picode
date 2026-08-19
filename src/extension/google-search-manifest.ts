import type { CapabilityManifest } from "../shared/types.ts";

export const GOOGLE_SEARCH_SUBAGENT_CAPABILITY_ID = "google-search-subagent";
export const GOOGLE_SEARCH_SUBAGENT_TOOL_NAME = "google_search_subagent";

/**
 * Optional third-tier capability. Registration only makes the setting visible
 * to the user; Disabled keeps its manifest out of search_tools and its tool
 * schema out of the model request.
 */
export const GOOGLE_SEARCH_SUBAGENT_MANIFEST: CapabilityManifest = {
  id: GOOGLE_SEARCH_SUBAGENT_CAPABILITY_ID,
  kind: "pi-extension",
  title: "Google Search Subagent",
  summary: "Grounded Google Search through a selected Gemini API account and isolated pi-subagents researchers",
  keywords: ["google", "search", "gemini", "grounding", "research", "subagent"],
  supportsProxyCall: false,
  origin: "suite",
  harnessTiers: ["simple", "standard", "tdd"],
  semanticOperations: ["web.search@1"],
};
