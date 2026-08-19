export interface PiWebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface GeminiApiOnlyResult {
  answer: string;
  results: PiWebSearchResult[];
  queries: string[];
}

export interface PiWebAttributedResult {
  answer: string;
  results: PiWebSearchResult[];
  provider: string;
}

export function searchGeminiApiOnly(
  query: string,
  options: {
    apiKey: string;
    model: string;
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<GeminiApiOnlyResult | null>;

export function searchWithPiWebAccess(
  query: string,
  options: {
    provider: "auto";
    signal?: AbortSignal;
    extensionContext?: import("@earendil-works/pi-coding-agent").ExtensionContext;
  },
): Promise<PiWebAttributedResult>;
