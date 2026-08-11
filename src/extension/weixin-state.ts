import { dataPaths } from "../shared/paths.ts";
import type { Result } from "../shared/types.ts";
import { StateFile } from "../store/state-file.ts";

export interface WeixinStateV1 {
  version: 1;
  accountRefId?: string;
  ilinkAccountId?: string;
  ilinkUserId?: string;
  boundSessionId?: string;
  boundSessionFile?: string;
  allowedUserIds: string[];
  syncBuf: string;
  contextTokens: Record<string, string>;
  recentMessageIds: string[];
}

export function emptyWeixinState(): WeixinStateV1 {
  return { version: 1, allowedUserIds: [], syncBuf: "", contextTokens: {}, recentMessageIds: [] };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string");
}

function valid(value: unknown): value is WeixinStateV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row["version"] === 1 && typeof row["syncBuf"] === "string" &&
    isStringArray(row["allowedUserIds"]) && isStringArray(row["recentMessageIds"]) &&
    isStringRecord(row["contextTokens"]) &&
    (row["accountRefId"] === undefined || typeof row["accountRefId"] === "string") &&
    (row["ilinkAccountId"] === undefined || typeof row["ilinkAccountId"] === "string") &&
    (row["ilinkUserId"] === undefined || typeof row["ilinkUserId"] === "string") &&
    (row["boundSessionId"] === undefined || typeof row["boundSessionId"] === "string") &&
    (row["boundSessionFile"] === undefined || typeof row["boundSessionFile"] === "string");
}

export class WeixinStateStore {
  private readonly file: StateFile<WeixinStateV1>;

  constructor(path = dataPaths.weixinState()) {
    this.file = new StateFile(path, valid);
  }

  async read(): Promise<Result<WeixinStateV1>> {
    return this.file.read();
  }

  async readOrEmpty(): Promise<WeixinStateV1> {
    const state = await this.file.read();
    return state.ok ? state.value : emptyWeixinState();
  }

  write(state: WeixinStateV1): Promise<Result<void>> {
    return this.file.write(state);
  }
}
