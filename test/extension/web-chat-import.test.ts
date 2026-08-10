import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createRuntime } from "../../src/extension/index.ts";
import { WebChatImportCoordinator } from "../../src/extension/web-chat-import.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

describe("WebChatImportCoordinator", () => {
  it("imports only selected chats after every original workspace group is rebound", async () => {
    await withTempPicodeDir(async (root) => {
      const source = join(root, "source");
      const workspace = join(root, "workspace");
      const sessions = join(root, "agent", "sessions");
      mkdirSync(source, { recursive: true });
      mkdirSync(workspace, { recursive: true });
      mkdirSync(sessions, { recursive: true });
      writeFileSync(join(source, "one.jsonl"), [
        JSON.stringify({ type: "session_meta", payload: { cwd: "C:/old/repo" } }),
        JSON.stringify({ type: "message", role: "user", content: "Continue migration" }),
        JSON.stringify({ type: "message", role: "assistant", content: "Ready" }),
      ].join("\n"));
      const coordinator = new WebChatImportCoordinator(createRuntime(), sessions);
      const scan = coordinator.scan({ source: "codex", path: source, archiveFilter: "all", sort: "updated-desc" });
      const candidate = scan.candidates[0];
      if (candidate === undefined) throw new Error("fixture was not scanned");

      await expect(coordinator.apply({
        scanId: scan.scanId,
        candidateIds: [candidate.id],
        workspaceBindings: {},
        includeReasoning: true,
      })).rejects.toThrow(/choose a workspace/i);

      const result = await coordinator.apply({
        scanId: scan.scanId,
        candidateIds: [candidate.id],
        workspaceBindings: { [candidate.workspaceGroupId]: workspace },
        includeReasoning: true,
      });
      expect(result).toHaveLength(1);
      const sessionFile = result[0]?.sessionFile;
      expect(sessionFile).toBeTypeOf("string");
      const importedEntry = SessionManager.open(sessionFile as string, sessions).getEntries().find((entry) =>
        entry.type === "custom" && entry.customType === "picode.foreign-import"
      );
      expect(importedEntry?.type === "custom" ? importedEntry.data : undefined).toMatchObject({
        includeReasoning: true,
        originalWorkspace: "C:/old/repo",
        boundWorkspace: workspace,
      });
    });
  });
});
