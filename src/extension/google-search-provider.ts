import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  searchGeminiApiOnly,
  searchWithPiWebAccess,
} from "../../scripts/pi-web-access-runtime.mjs";
import type { GroundedSearchEvidence } from "../devloop/index.ts";

export interface GoogleGroundingRequest {
  query: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  signal?: AbortSignal;
  extensionContext?: ExtensionContext;
  fallback: boolean;
}

export interface GoogleSearchBackend {
  ground(request: GoogleGroundingRequest): Promise<GroundedSearchEvidence>;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function safeFallbackReason(cause: unknown, apiKey: string): string {
  const message = messageOf(cause);
  const raw = apiKey === "" ? message : message.replaceAll(apiKey, "[redacted]");
  const normalized = raw.replace(/[\r\n]+/gu, " ").slice(0, 300);
  return normalized === "" ? "Google API search failed" : normalized;
}

function modelId(value: string): string {
  const slash = value.indexOf("/");
  return slash === -1 ? value : value.slice(slash + 1);
}

/** Uses pi-web-access for both paths; never opens a Gemini browser session. */
export class PiWebGoogleSearchBackend implements GoogleSearchBackend {
  constructor(private readonly adapter: {
    google: typeof searchGeminiApiOnly;
    fallback: typeof searchWithPiWebAccess;
  } = { google: searchGeminiApiOnly, fallback: searchWithPiWebAccess }) {}

  async ground(request: GoogleGroundingRequest): Promise<GroundedSearchEvidence> {
    try {
      const result = await this.adapter.google(request.query, {
        apiKey: request.apiKey,
        model: modelId(request.model),
        timeoutMs: request.timeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (result === null) throw new Error("Google Gemini API returned no grounded result");
      return {
        answer: result.answer,
        sources: result.results,
        actualProvider: "google-gemini-api",
        queries: result.queries.length > 0 ? result.queries : [request.query],
      };
    } catch (cause) {
      const googleFailure = safeFallbackReason(cause, request.apiKey);
      if (!request.fallback || request.signal?.aborted === true) throw new Error(googleFailure);
      try {
        const fallback = await this.adapter.fallback(request.query, {
          provider: "auto",
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          ...(request.extensionContext === undefined
            ? {}
            : { extensionContext: request.extensionContext }),
        });
        return {
          answer: fallback.answer,
          sources: fallback.results,
          actualProvider: `pi-web-access:${fallback.provider}`,
          queries: [request.query],
          fallbackReason: googleFailure,
        };
      } catch (fallbackCause) {
        throw new Error(
          `Google API search failed: ${googleFailure}; pi-web-access fallback failed: ${safeFallbackReason(fallbackCause, request.apiKey)}`,
        );
      }
    }
  }
}
