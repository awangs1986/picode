import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "../../src/extension/index.ts";
import { WeixinController } from "../../src/extension/weixin-controller.ts";
import type { IlinkClient } from "../../src/extension/weixin-ilink-client.ts";
import { WEIXIN_CAPABILITY_ID } from "../../src/extension/weixin-manifest.ts";
import { WeixinStateStore } from "../../src/extension/weixin-state.ts";

const roots: string[] = [];
afterEach(() => {
  delete process.env["PICODE_DIR"];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("WeixinController", () => {
  it("requires an explicit enable and binds start to the current persisted Chat", async () => {
    const root = mkdtempSync(join(tmpdir(), "picode-weixin-controller-")); roots.push(root);
    process.env["PICODE_DIR"] = root;
    const runtime = createRuntime();
    const persistCapabilities = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    const store = new WeixinStateStore(join(root, "weixin.json"));
    await store.write({
      version: 1, accountRefId: "weixin-ilink:bot-1", ilinkAccountId: "bot-1", ilinkUserId: "owner-1",
      allowedUserIds: ["owner-1"], syncBuf: "", contextTokens: {}, recentMessageIds: [],
    });
    await runtime.accounts.importCredentials({
      stableId: "bot-1", provider: "weixin-ilink", label: "Weixin bot-1", authKind: "session",
      chatCompatible: false, credentials: { accessToken: "secret", baseUrl: "https://ilinkai.weixin.qq.com" },
    });
    const client = { getUpdates: vi.fn().mockImplementation(async (_c, sync, signal: AbortSignal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { syncBuf: sync, messages: [] };
    }) } as unknown as IlinkClient;
    const controller = new WeixinController({ runtime, client, store, persistCapabilities, runTurn: vi.fn() });
    const ui = { notify: vi.fn(), confirm: vi.fn() };
    const context = { sessionId: "chat-1", sessionFile: "chat.jsonl", ui };

    await controller.execute("start", context);
    expect(ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("disabled"), "error");
    await controller.execute("enable", context);
    await controller.execute("start", context);
    expect(runtime.guard.catalog.get(WEIXIN_CAPABILITY_ID)?.setting).toBe("trusted");
    expect(controller.status().running).toBe(true);
    const saved = await store.read();
    expect(saved.ok ? saved.value : undefined).toMatchObject({ boundSessionId: "chat-1", boundSessionFile: "chat.jsonl" });
    await controller.shutdown();
  });
});
