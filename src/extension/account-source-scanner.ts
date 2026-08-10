import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountCredentials } from "../store/accounts.ts";
import type { AccountRef } from "../shared/types.ts";
import { capacityFromModelRecord } from "./model-capacity.ts";

export interface AccountImportCandidate {
  id: string;
  provider: string;
  label: string;
  source: string;
  summary: string;
  credentials: AccountCredentials;
  defaultModel?: string;
  piProvider: string;
  authKind: "api_key" | "oauth" | "session";
  chatCompatible: boolean;
  endpoint?: AccountRef["endpoint"];
  metadata?: Record<string, unknown>;
  warnings: string[];
}

type SourceKind = "codex" | "cursor" | "claude" | "custom";

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nested(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    const row = object(current);
    if (row === undefined) return undefined;
    current = row[key];
  }
  return current;
}

function firstString(value: unknown, paths: readonly (readonly string[])[]): string | undefined {
  for (const path of paths) {
    const found = nested(value, path);
    if (typeof found === "string" && found.trim() !== "") return found;
  }
  return undefined;
}

function firstNumber(value: unknown, paths: readonly (readonly string[])[]): number | undefined {
  for (const path of paths) {
    const found = nested(value, path);
    if (typeof found === "number" && Number.isFinite(found)) return found;
  }
  return undefined;
}

function candidate(input: Omit<AccountImportCandidate, "id" | "summary">): AccountImportCandidate {
  const id = createHash("sha256")
    .update(`${input.source}\0${input.provider}\0${input.label}`, "utf8")
    .digest("hex")
    .slice(0, 20);
  return {
    ...input,
    id,
    summary: `${input.provider} · ${input.label} · ${input.authKind} · ${input.source}`,
  };
}

function flatten(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(flatten);
  const row = object(value);
  if (row === undefined) return [value];
  if (Array.isArray(row.accounts)) return row.accounts.flatMap(flatten);
  return [value];
}

interface CodexConfigProjection {
  baseUrl?: string;
  defaultModel?: string;
  providerName?: string;
}

function tomlString(value: string): string | undefined {
  const trimmed = value.trim();
  const doubleQuoted = trimmed.match(/^"((?:\\.|[^"\\])*)"\s*(?:#.*)?$/);
  if (doubleQuoted?.[1] !== undefined) {
    try {
      return JSON.parse(`"${doubleQuoted[1]}"`) as string;
    } catch {
      return undefined;
    }
  }
  const singleQuoted = trimmed.match(/^'([^']*)'\s*(?:#.*)?$/);
  return singleQuoted?.[1];
}

/** Bounded projection of the Codex settings that affect account routing. */
function parseCodexConfig(text: string): CodexConfigProjection {
  const root = new Map<string, string>();
  const providerSections = new Map<string, Map<string, string>>();
  let section: string | undefined;
  for (const rawLine of text.split(/\r?\n/u)) {
    const sectionMatch = rawLine.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);
    if (sectionMatch?.[1] !== undefined) {
      section = sectionMatch[1].trim();
      continue;
    }
    const assignment = rawLine.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (assignment?.[1] === undefined || assignment[2] === undefined) continue;
    const value = tomlString(assignment[2]);
    if (value === undefined) continue;
    if (section === undefined) {
      root.set(assignment[1], value);
      continue;
    }
    const providerMatch = section.match(/^model_providers\.([A-Za-z0-9_.-]+)$/);
    if (providerMatch?.[1] === undefined) continue;
    const provider = providerSections.get(providerMatch[1]) ?? new Map<string, string>();
    provider.set(assignment[1], value);
    providerSections.set(providerMatch[1], provider);
  }
  const providerName = root.get("model_provider");
  const provider = providerName === undefined ? undefined : providerSections.get(providerName);
  const baseUrl = root.get("openai_base_url") ?? provider?.get("base_url");
  const defaultModel = root.get("model");
  return {
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(defaultModel === undefined ? {} : { defaultModel }),
    ...(providerName === undefined ? {} : { providerName }),
  };
}

function mergeCodexConfig(authText: string, configText: string | undefined): string {
  if (configText === undefined) return authText;
  const parsed = JSON.parse(authText) as unknown;
  const row = object(parsed);
  if (row === undefined || Array.isArray(row.accounts)) return authText;
  const config = parseCodexConfig(configText);
  return JSON.stringify({
    ...row,
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(config.defaultModel === undefined ? {} : { model: config.defaultModel }),
    ...(config.providerName === undefined ? {} : { label: `Codex · ${config.providerName}` }),
  });
}

export function parseAccountJson(kind: SourceKind, text: string, source: string): AccountImportCandidate[] {
  const parsed = JSON.parse(text) as unknown;
  const rows = flatten(parsed);
  const result: AccountImportCandidate[] = [];
  for (const row of rows) {
    const capacity = capacityFromModelRecord(row);
    if (kind === "codex") {
      const accessToken = firstString(row, [
        ["OPENAI_API_KEY"], ["apiKey"], ["api_key"], ["access_token"], ["accessToken"],
        ["tokens", "access_token"], ["tokens", "accessToken"],
      ]);
      if (accessToken === undefined) continue;
      const refreshToken = firstString(row, [
        ["refresh_token"], ["refreshToken"], ["tokens", "refresh_token"], ["tokens", "refreshToken"],
      ]);
      const baseUrl = firstString(row, [["baseUrl"], ["base_url"], ["api_base_url"]]);
      const expiresAt = firstNumber(row, [["expires"], ["expiresAt"], ["tokens", "expires"]]);
      const defaultModel = firstString(row, [["model"], ["defaultModel"]]);
      const isApiKey = firstString(row, [["OPENAI_API_KEY"], ["apiKey"], ["api_key"]]) !== undefined;
      result.push(candidate({
        provider: isApiKey && baseUrl !== undefined ? "openai" : "openai-codex",
        piProvider: isApiKey && baseUrl !== undefined ? "openai" : "openai-codex",
        label: firstString(row, [["email"], ["name"], ["label"]]) ?? "Codex",
        source,
        credentials: {
          accessToken,
          ...(refreshToken === undefined ? {} : { refreshToken }),
          ...(baseUrl === undefined ? {} : { baseUrl }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
        },
        ...(defaultModel === undefined ? {} : { defaultModel }),
        authKind: isApiKey ? "api_key" : "oauth",
        chatCompatible: true,
        endpoint: {
          ...(baseUrl === undefined ? {} : { baseUrl }),
          api: "openai-responses",
          ...(defaultModel === undefined ? {} : { model: defaultModel }),
          ...(capacity === undefined ? {} : capacity),
        },
        warnings: refreshToken === undefined && !isApiKey
          ? ["This Codex OAuth snapshot has no refresh token; chat may stop when it expires."]
          : [],
      }));
      continue;
    }
    if (kind === "claude") {
      const accessToken = firstString(row, [
        ["claudeAiOauth", "accessToken"], ["claudeAiOauth", "access_token"],
        ["accessToken"], ["access_token"], ["apiKey"],
      ]);
      if (accessToken === undefined) continue;
      const refreshToken = firstString(row, [
        ["claudeAiOauth", "refreshToken"], ["claudeAiOauth", "refresh_token"], ["refreshToken"],
      ]);
      const expiresAt = firstNumber(row, [["claudeAiOauth", "expiresAt"], ["expiresAt"]]);
      result.push(candidate({
        provider: "anthropic",
        piProvider: "anthropic",
        label: firstString(row, [
          ["oauthAccount", "emailAddress"], ["oauthAccount", "email"], ["email"], ["label"],
        ]) ?? "Claude",
        source,
        credentials: {
          accessToken,
          ...(refreshToken === undefined ? {} : { refreshToken }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
        },
        authKind: "oauth",
        chatCompatible: true,
        warnings: refreshToken === undefined
          ? ["This Claude OAuth snapshot has no refresh token; chat may stop when it expires."]
          : [],
      }));
      continue;
    }
    if (kind === "cursor") {
      const accessToken = firstString(row, [
        ["CURSOR_API_KEY"], ["apiKey"], ["api_key"], ["access"], ["accessToken"],
        ["access_token"], ["cursor", "access"], ["cursor", "key"],
      ]);
      if (accessToken === undefined) continue;
      const refreshToken = firstString(row, [["refresh"], ["refreshToken"], ["refresh_token"]]);
      const sdkApiKey = firstString(row, [
        ["CURSOR_API_KEY"], ["apiKey"], ["api_key"], ["cursor", "key"],
      ]) !== undefined;
      result.push(candidate({
        provider: "cursor",
        piProvider: "cursor",
        label: firstString(row, [["email"], ["label"], ["name"]]) ?? "Cursor",
        source,
        credentials: { accessToken, ...(refreshToken === undefined ? {} : { refreshToken }) },
        authKind: sdkApiKey ? "api_key" : "oauth",
        chatCompatible: sdkApiKey,
        metadata: { credentialKind: sdkApiKey ? "cursor_sdk_api_key" : "cursor_ide_cli_oauth" },
        warnings: sdkApiKey ? [] : [
          "Cursor Desktop/CLI OAuth is retained for account backup only. Cursor chat requires a Cursor SDK API Key.",
        ],
      }));
      continue;
    }
    const provider = firstString(row, [["provider"], ["providerId"]]);
    const accessToken = firstString(row, [["apiKey"], ["api_key"], ["accessToken"], ["access_token"]]);
    if (provider === undefined || accessToken === undefined) continue;
    const baseUrl = firstString(row, [["baseUrl"], ["base_url"]]);
    const defaultModel = firstString(row, [["model"], ["defaultModel"]]);
    result.push(candidate({
      provider,
      piProvider: provider,
      label: firstString(row, [["label"], ["name"], ["email"]]) ?? provider,
      source,
      credentials: { accessToken, ...(baseUrl === undefined ? {} : { baseUrl }) },
      ...(defaultModel === undefined ? {} : { defaultModel }),
      authKind: "api_key",
      chatCompatible: true,
      endpoint: {
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(defaultModel === undefined ? {} : { model: defaultModel }),
        ...(capacity === undefined ? {} : capacity),
      },
      warnings: [],
    }));
  }
  return result;
}

export interface LocalAccountScanOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
}

/** Small-file credential discovery only; never traverses chat/session trees. */
export async function scanLocalAccountCandidates(options: LocalAccountScanOptions = {}): Promise<AccountImportCandidate[]> {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const appData = env["APPDATA"];
  const xdgConfig = env["XDG_CONFIG_HOME"] ?? join(home, ".config");
  const sources: Array<{ kind: SourceKind; path: string }> = [
    { kind: "codex", path: join(env["CODEX_HOME"] ?? join(home, ".codex"), "auth.json") },
    { kind: "claude", path: join(env["CLAUDE_CONFIG_DIR"] ?? join(home, ".claude"), ".credentials.json") },
    { kind: "cursor", path: join(home, ".cursor", "auth.json") },
    { kind: "cursor", path: join(home, ".cursor", "cli-config.json") },
    ...(appData === undefined ? [] : [{ kind: "cursor" as const, path: join(appData, "Cursor", "auth.json") }]),
    { kind: "cursor", path: join(xdgConfig, "Cursor", "auth.json") },
    { kind: "cursor", path: join(home, "Library", "Application Support", "Cursor", "auth.json") },
  ];
  const found: AccountImportCandidate[] = [];
  for (const source of [...new Map(sources.map((item) => [item.path, item])).values()]) {
    if (!existsSync(source.path)) continue;
    try {
      const sourceText = readFileSync(source.path, "utf8");
      const text = source.kind === "codex"
        ? mergeCodexConfig(
          sourceText,
          existsSync(join(source.path, "..", "config.toml"))
            ? readFileSync(join(source.path, "..", "config.toml"), "utf8")
            : undefined,
        )
        : sourceText;
      found.push(...parseAccountJson(source.kind, text, source.path));
    } catch {
      // One corrupt/unsupported source must not hide other candidates.
    }
  }
  const cursorApiKey = env["CURSOR_API_KEY"]?.trim();
  if (cursorApiKey !== undefined && cursorApiKey !== "") {
    found.push(...parseAccountJson("cursor", JSON.stringify({ CURSOR_API_KEY: cursorApiKey }), "environment:CURSOR_API_KEY"));
  }
  const unique = new Map<string, AccountImportCandidate>();
  for (const item of found) {
    const identity = createHash("sha256")
      .update(`${item.provider}\0${item.credentials.accessToken}`)
      .digest("hex");
    if (!unique.has(identity)) unique.set(identity, item);
  }
  return [...unique.values()];
}
