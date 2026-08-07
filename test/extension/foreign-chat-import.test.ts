import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createRuntime } from "../../src/extension/index.ts";
import { ForeignChatImportService } from "../../src/extension/foreign-chat-import.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

describe("ForeignChatImportService", () => {
  it("previews and continues a Codex transcript in a fresh Pi session", async () => {
    await withTempPicodeDir(async (dir) => {
      const file = join(dir, "codex.jsonl");
      writeFileSync(file, [
        JSON.stringify({ type: "message", role: "user", content: "Finish the renderer" }),
        JSON.stringify({ type: "message", role: "assistant", content: "I inspected it" }),
      ].join("\n"), "utf8");
      const runtime = createRuntime();
      const service = new ForeignChatImportService(runtime);
      const entries: Array<[string, unknown]> = [];
      const messages: unknown[] = [];
      const ctx = {
        cwd: "C:/repo",
        ui: { confirm: vi.fn(async () => true), notify: vi.fn() },
        newSession: vi.fn(async (options: any) => {
          await options.setup?.({ appendCustomEntry(type: string, data: unknown) { entries.push([type, data]); } });
          await options.withSession?.({
            sessionManager: { getSessionId: () => "imported-session" },
            sendMessage: async (message: unknown) => { messages.push(message); },
            ui: { notify: vi.fn() },
          });
          return { cancelled: false };
        }),
      } as unknown as ExtensionCommandContext;

      const preview = await service.preview("codex", file);
      const continued = await service.continue("codex", file, ctx);

      expect(preview.ok).toBe(true);
      expect(continued.ok).toBe(true);
      expect(entries).toContainEqual(["picode.task-binding", expect.objectContaining({ taskId: expect.any(String) })]);
      expect(messages).toContainEqual(expect.objectContaining({
        customType: "picode.foreign-resume",
        content: expect.stringContaining("Finish the renderer"),
      }));
    });
  });
});
