import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChatImportCatalog } from "../../src/extension/chat-import-catalog.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

describe("ChatImportCatalog", () => {
  it("scans dialog metadata only, removes exact duplicates, and preserves archive/workspace identity", async () => {
    await withTempPicodeDir(async (root) => {
      const active = join(root, "sessions");
      const archived = join(root, "archived_sessions");
      mkdirSync(active, { recursive: true });
      mkdirSync(archived, { recursive: true });
      const rows = [
        JSON.stringify({ type: "session_meta", payload: { cwd: "/D:/SteamLibrary/steamapps/common/CINERIS SOMNIA" } }),
        JSON.stringify({ type: "message", role: "user", content: "修复存档迁移" }),
        JSON.stringify({ type: "function_call", name: "read_file", call_id: "c1", arguments: "{}" }),
        JSON.stringify({ type: "function_call_output", call_id: "c1", output: "large tool log" }),
        JSON.stringify({ type: "message", role: "assistant", content: "迁移器已经完成。", timestamp: "2026-08-09T09:00:00Z" }),
      ].join("\n");
      writeFileSync(join(active, "one.jsonl"), rows);
      writeFileSync(join(active, "duplicate.jsonl"), rows);
      writeFileSync(join(archived, "old.jsonl"), rows.replace("迁移器已经完成。", "归档版本。"));

      const scan = new ChatImportCatalog().scan({
        sources: [{ source: "codex", path: root }],
        archiveFilter: "all",
        sort: "updated-desc",
      });

      expect(scan.candidates).toHaveLength(2);
      expect(scan.duplicatesSkipped).toBe(1);
      expect(scan.candidates[0]).toMatchObject({
        source: "codex",
        title: "修复存档迁移",
        originalWorkspace: "D:/SteamLibrary/steamapps/common/CINERIS SOMNIA",
      });
      expect(scan.candidates.map((item) => item.archived).sort()).toEqual([false, true]);
      expect(scan.candidates.every((item) => !item.lastMessageSnippet.includes("tool log"))).toBe(true);
      expect(scan.workspaceGroups).toHaveLength(1);
    });
  });

  it("filters archive state and sorts by source size without parsing full tool output", async () => {
    await withTempPicodeDir(async (root) => {
      const active = join(root, "sessions");
      const archived = join(root, "archived_sessions");
      mkdirSync(active, { recursive: true });
      mkdirSync(archived, { recursive: true });
      writeFileSync(join(active, "small.jsonl"), `${JSON.stringify({ type: "message", role: "user", content: "small" })}\n`);
      writeFileSync(join(archived, "large.jsonl"), `${JSON.stringify({ type: "message", role: "user", content: "large" })}\n${" ".repeat(1000)}`);

      const catalog = new ChatImportCatalog();
      const activeOnly = catalog.scan({
        sources: [{ source: "codex", path: root }],
        archiveFilter: "active",
        sort: "size-desc",
      });
      expect(activeOnly.candidates.map((item) => item.title)).toEqual(["small"]);
      const all = catalog.scan({
        sources: [{ source: "codex", path: root }],
        archiveFilter: "all",
        sort: "size-desc",
      });
      expect(all.candidates[0]?.title).toBe("large");
    });
  });
});
