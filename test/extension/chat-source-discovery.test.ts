import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverLocalChatSources } from "../../src/extension/chat-source-discovery.ts";

describe("discoverLocalChatSources", () => {
  it("finds supported local history roots and keeps conventional editable fallbacks", async () => {
    const root = mkdtempSync(join(tmpdir(), "picode-chat-roots-"));
    try {
      const home = join(root, "home");
      const appData = join(root, "AppData", "Roaming");
      mkdirSync(join(home, ".codex", "sessions"), { recursive: true });
      mkdirSync(join(home, ".codex", "archived_sessions"), { recursive: true });
      mkdirSync(join(home, ".cursor", "projects"), { recursive: true });
      // Claude is deliberately absent: its conventional path should still be editable.

      const result = await discoverLocalChatSources({ home, env: { APPDATA: appData } });

      expect(result.codex.defaultPath).toBe(join(home, ".codex"));
      expect(result.cursor.defaultPath).toBe(join(home, ".cursor", "projects"));
      expect(result["claude-code"].defaultPath).toBe(join(home, ".claude", "projects"));
      expect(result.codex.candidates).toContain(join(home, ".codex"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
