import type { Model } from "@earendil-works/pi-ai";
import type { ModelCapacity, Result } from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";

const CONTEXT_PATHS = [
  ["context_window"],
  ["contextWindow"],
  ["context_length"],
  ["contextLength"],
  ["max_context_length"],
  ["maxContextLength"],
  ["input_token_limit"],
  ["inputTokenLimit"],
  ["capabilities", "context_window"],
  ["limits", "context_window"],
  ["metadata", "context_window"],
] as const;

const OUTPUT_PATHS = [
  ["max_output_tokens"],
  ["maxOutputTokens"],
  ["max_completion_tokens"],
  ["maxCompletionTokens"],
  ["output_token_limit"],
  ["outputTokenLimit"],
  ["capabilities", "max_output_tokens"],
  ["limits", "max_output_tokens"],
] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function atPath(value: unknown, path: readonly string[]): unknown {
  let cursor: unknown = value;
  for (const segment of path) {
    const current = record(cursor);
    if (current === undefined) return undefined;
    cursor = current[segment];
  }
  return cursor;
}

export function parseTokenLimit(value: unknown): number | undefined {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value.replaceAll("_", "").replace(/k$/i, "000"))
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 1_024 ? parsed : undefined;
}

function largestAtPaths(value: unknown, paths: readonly (readonly string[])[]): number | undefined {
  const found = paths
    .map((path) => parseTokenLimit(atPath(value, path)))
    .filter((candidate): candidate is number => candidate !== undefined);
  return found.length === 0 ? undefined : Math.max(...found);
}

export function capacityFromModelRecord(value: unknown): ModelCapacity | undefined {
  const contextWindow = largestAtPaths(value, CONTEXT_PATHS);
  if (contextWindow === undefined) return undefined;
  const maxTokens = largestAtPaths(value, OUTPUT_PATHS);
  return {
    contextWindow,
    ...(maxTokens === undefined ? {} : { maxTokens: Math.min(maxTokens, contextWindow) }),
  };
}

export function largestKnownCapacity(
  modelId: string,
  models: readonly Model<any>[],
  providerId?: string,
): ModelCapacity | undefined {
  const sameId = models.filter((model) => model.id === modelId && model.contextWindow > 0);
  const providerMatches = providerId === undefined
    ? sameId
    : sameId.filter((model) => model.provider === providerId);
  // A custom reverse-proxy provider may deliberately reuse an upstream model ID.
  // Prefer an exact Provider identity, then fall back only when no such identity exists.
  const matches = providerMatches.length > 0 ? providerMatches : sameId;
  if (matches.length === 0) return undefined;
  const largest = matches.reduce((best, model) =>
    model.contextWindow > best.contextWindow ? model : best
  );
  return {
    contextWindow: largest.contextWindow,
    ...(largest.maxTokens > 0 ? { maxTokens: largest.maxTokens } : {}),
  };
}

function modelsUrl(baseUrl: string): URL {
  const normalized = new URL(baseUrl);
  if (normalized.protocol !== "https:" && normalized.protocol !== "http:") {
    throw new Error("model endpoint must use http or https");
  }
  if (!normalized.pathname.endsWith("/")) normalized.pathname += "/";
  return new URL("models", normalized);
}

/** Probe optional capacity metadata exposed by OpenAI-compatible /models APIs. */
export async function probeModelCapacity(input: {
  baseUrl: string;
  accessToken: string;
  modelId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<Result<ModelCapacity | undefined>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 5_000);
  try {
    const response = await (input.fetchImpl ?? fetch)(modelsUrl(input.baseUrl), {
      headers: { authorization: `Bearer ${input.accessToken}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      return err("accounts/model-capacity-probe-failed", `model catalog returned HTTP ${response.status}`);
    }
    const payload = await response.json() as unknown;
    const root = record(payload);
    const rows = Array.isArray(root?.["data"])
      ? root["data"]
      : Array.isArray(root?.["models"])
        ? root["models"]
        : [];
    const matching = rows.filter((row) => {
      const item = record(row);
      return item?.["id"] === input.modelId || item?.["name"] === input.modelId;
    });
    const capacities = matching
      .map(capacityFromModelRecord)
      .filter((capacity): capacity is ModelCapacity => capacity !== undefined);
    if (capacities.length === 0) return ok(undefined);
    return ok(capacities.reduce((best, capacity) =>
      capacity.contextWindow > best.contextWindow ? capacity : best
    ));
  } catch (cause) {
    return err("accounts/model-capacity-probe-failed", "could not read model capacity metadata", cause);
  } finally {
    clearTimeout(timer);
  }
}
