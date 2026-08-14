import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export interface CursorModelFallbackIssue {
  reason: string;
  message: string;
  errorMessage?: string;
}

interface CursorModelDiscoveryModule {
  discoverModels(options: {
    apiKey: string;
    forceRefresh?: boolean;
    onFallback: (issue: CursorModelFallbackIssue) => void;
  }): Promise<ProviderModelConfig[]>;
}

async function loadCursorModelDiscovery(): Promise<CursorModelDiscoveryModule> {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve("pi-cursor-sdk/package.json");
  const moduleUrl = pathToFileURL(join(dirname(manifest), "src", "model-discovery.ts")).href;
  return await import(moduleUrl) as CursorModelDiscoveryModule;
}

export interface CursorModelCatalogRefresh {
  models: ProviderModelConfig[];
  fallbackIssue?: CursorModelFallbackIssue;
}

async function discoverCursorModelCatalog(
  apiKey: string,
  forceRefresh: boolean,
): Promise<CursorModelCatalogRefresh> {
  const { discoverModels } = await loadCursorModelDiscovery();
  let fallbackIssue: CursorModelFallbackIssue | undefined;
  const models = await discoverModels({
    apiKey,
    forceRefresh,
    onFallback: (issue) => {
      fallbackIssue = issue;
    },
  });
  return {
    models,
    ...(fallbackIssue === undefined ? {} : { fallbackIssue }),
  };
}

/** Restore a fresh cached catalog, querying Cursor only when the SDK cache is stale. */
export async function loadCursorModelCatalog(
  apiKey: string,
): Promise<CursorModelCatalogRefresh> {
  return await discoverCursorModelCatalog(apiKey, false);
}

/** Force one authenticated Cursor SDK catalog lookup after an API-key import. */
export async function refreshCursorModelCatalog(
  apiKey: string,
): Promise<CursorModelCatalogRefresh> {
  return await discoverCursorModelCatalog(apiKey, true);
}
