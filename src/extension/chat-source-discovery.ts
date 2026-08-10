import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ChatSource = "codex" | "cursor" | "claude-code";

export interface ChatSourceLocation {
  source: ChatSource;
  defaultPath: string;
  candidates: string[];
}

export type ChatSourceLocations = Record<ChatSource, ChatSourceLocation>;

export interface LocalChatSourceOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
}

function location(source: ChatSource, conventional: string[]): ChatSourceLocation {
  const candidates = [...new Set(conventional)].filter((path) => existsSync(path));
  return { source, defaultPath: candidates[0] ?? conventional[0] ?? "", candidates };
}

/** Detect only roots supported by the JSONL chat catalog. */
export async function discoverLocalChatSources(
  options: LocalChatSourceOptions = {},
): Promise<ChatSourceLocations> {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const codexHome = env["CODEX_HOME"] ?? join(home, ".codex");
  const claudeHome = env["CLAUDE_CONFIG_DIR"] ?? join(home, ".claude");
  return {
    codex: location("codex", [codexHome]),
    cursor: location("cursor", [
      join(home, ".cursor", "projects"),
      join(home, ".cursor", "sessions"),
      join(home, ".cursor", "chats"),
    ]),
    "claude-code": location("claude-code", [join(claudeHome, "projects")]),
  };
}
