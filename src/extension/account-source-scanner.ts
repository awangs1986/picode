import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountCredentials } from "../store/accounts.ts";

export interface AccountImportCandidate {
  id: string;
  provider: string;
  label: string;
  source: string;
  summary: string;
  credentials: AccountCredentials;
  defaultModel?: string;
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
    summary: `${input.provider} · ${input.label} · ${input.source}`,
  };
}

function flatten(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(flatten);
  const row = object(value);
  if (row === undefined) return [value];
  if (Array.isArray(row.accounts)) return row.accounts.flatMap(flatten);
  return [value];
}

export function parseAccountJson(kind: SourceKind, text: string, source: string): AccountImportCandidate[] {
  const parsed = JSON.parse(text) as unknown;
  const rows = flatten(parsed);
  const result: AccountImportCandidate[] = [];
  for (const row of rows) {
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
        label: firstString(row, [["email"], ["name"], ["label"]]) ?? "Codex",
        source,
        credentials: {
          accessToken,
          ...(refreshToken === undefined ? {} : { refreshToken }),
          ...(baseUrl === undefined ? {} : { baseUrl }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
        },
        ...(defaultModel === undefined ? {} : { defaultModel }),
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
        label: firstString(row, [
          ["oauthAccount", "emailAddress"], ["oauthAccount", "email"], ["email"], ["label"],
        ]) ?? "Claude",
        source,
        credentials: {
          accessToken,
          ...(refreshToken === undefined ? {} : { refreshToken }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
        },
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
      result.push(candidate({
        provider: "cursor",
        label: firstString(row, [["email"], ["label"], ["name"]]) ?? "Cursor",
        source,
        credentials: { accessToken, ...(refreshToken === undefined ? {} : { refreshToken }) },
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
      label: firstString(row, [["label"], ["name"], ["email"]]) ?? provider,
      source,
      credentials: { accessToken, ...(baseUrl === undefined ? {} : { baseUrl }) },
      ...(defaultModel === undefined ? {} : { defaultModel }),
    }));
  }
  return result;
}

/** Small-file credential discovery only; never traverses chat/session trees. */
export async function scanLocalAccountCandidates(): Promise<AccountImportCandidate[]> {
  const home = homedir();
  const sources: Array<{ kind: SourceKind; path: string }> = [
    { kind: "codex", path: join(process.env["CODEX_HOME"] ?? join(home, ".codex"), "auth.json") },
    { kind: "claude", path: join(process.env["CLAUDE_CONFIG_DIR"] ?? join(home, ".claude"), ".credentials.json") },
    { kind: "cursor", path: join(home, ".cursor", "auth.json") },
    { kind: "cursor", path: join(home, ".cursor", "cli-config.json") },
  ];
  const found: AccountImportCandidate[] = [];
  for (const source of sources) {
    if (!existsSync(source.path)) continue;
    try {
      found.push(...parseAccountJson(source.kind, readFileSync(source.path, "utf8"), source.path));
    } catch {
      // One corrupt/unsupported source must not hide other candidates.
    }
  }
  return found;
}
