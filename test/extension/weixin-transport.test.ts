import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IlinkClient, IlinkCredentials } from "../../src/extension/weixin-ilink-client.ts";
import { WeixinStateStore } from "../../src/extension/weixin-state.ts";
import { WeixinTransport } from "../../src/extension/weixin-transport.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tempState(): WeixinStateStore {
  const root = mkdtempSync(join(tmpdir(), "picode-weixin-"));
  roots.push(root);
  return new WeixinStateStore(join(root, "state.json"));
}

const credentials: IlinkCredentials = {
  accountId: "bot-1", token: "secret", baseUrl: "https://ilinkai.weixin.qq.com", userId: "owner-1",
};

describe("WeixinTransport", () => {
  it("delivers one allowed text message to the bound Chat and replies once", async () => {
    const client = {
      getUpdates: vi.fn()
        .mockResolvedValueOnce({ syncBuf: "s1", messages: [{ messageId: "m1", senderId: "owner-1", text: "继续", contextToken: "ctx" }] })
        .mockImplementation(async (_credentials, syncBuf, signal: AbortSignal) => {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          return { syncBuf, messages: [] };
        }),
      sendText: vi.fn().mockResolvedValue(undefined),
    } as unknown as IlinkClient;
    const handleMessage = vi.fn().mockResolvedValue("已经完成");
    const store = tempState();
    await store.write({ version: 1, accountRefId: "weixin-ilink:bot-1", boundSessionId: "chat-1", allowedUserIds: ["owner-1"], syncBuf: "", contextTokens: {}, recentMessageIds: [] });
    const transport = new WeixinTransport({ client, credentials: () => credentials, store, handleMessage });

    await transport.start();
    await vi.waitFor(() => expect(client.sendText).toHaveBeenCalledTimes(1));
    await transport.stop();

    expect(handleMessage).toHaveBeenCalledWith({ sessionId: "chat-1", senderId: "owner-1", text: "继续" });
    expect(client.sendText).toHaveBeenCalledWith(credentials, expect.objectContaining({ peerId: "owner-1", text: "已经完成", contextToken: "ctx" }));
    const saved = await store.read();
    expect(saved.ok && saved.value).toMatchObject({ syncBuf: "s1", contextTokens: { "owner-1": "ctx" }, recentMessageIds: ["m1"] });
  });

  it("ignores unapproved senders and duplicate messages", async () => {
    const updates = { syncBuf: "s1", messages: [
      { messageId: "seen", senderId: "owner-1", text: "again" },
      { messageId: "foreign", senderId: "stranger", text: "hello" },
    ] };
    const client = {
      getUpdates: vi.fn().mockResolvedValueOnce(updates).mockImplementation(async (_c, syncBuf, signal: AbortSignal) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { syncBuf, messages: [] };
      }),
      sendText: vi.fn(),
    } as unknown as IlinkClient;
    const handleMessage = vi.fn();
    const store = tempState();
    await store.write({ version: 1, accountRefId: "weixin-ilink:bot-1", boundSessionId: "chat-1", allowedUserIds: ["owner-1"], syncBuf: "", contextTokens: {}, recentMessageIds: ["seen"] });
    const transport = new WeixinTransport({ client, credentials: () => credentials, store, handleMessage });

    await transport.start();
    await vi.waitFor(() => expect(client.getUpdates).toHaveBeenCalledTimes(2));
    await transport.stop();
    expect(handleMessage).not.toHaveBeenCalled();
    expect(client.sendText).not.toHaveBeenCalled();
  });

  it("pairs an unknown sender through the Host before delivering its first message", async () => {
    const client = {
      getUpdates: vi.fn()
        .mockResolvedValueOnce({ syncBuf: "s1", messages: [{ messageId: "m-new", senderId: "actual-owner", text: "测试", contextToken: "ctx-new" }] })
        .mockImplementation(async (_c, syncBuf, signal: AbortSignal) => {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          return { syncBuf, messages: [] };
        }),
      sendText: vi.fn().mockResolvedValue(undefined),
    } as unknown as IlinkClient;
    const authorizeSender = vi.fn().mockResolvedValue(true);
    const handleMessage = vi.fn().mockResolvedValue("收到");
    const store = tempState();
    await store.write({ version: 1, accountRefId: "weixin-ilink:bot-1", boundSessionId: "chat-1", allowedUserIds: ["qr-user-id"], syncBuf: "", contextTokens: {}, recentMessageIds: [] });
    const transport = new WeixinTransport({ client, credentials: () => credentials, store, handleMessage, authorizeSender });

    await transport.start();
    await vi.waitFor(() => expect(client.sendText).toHaveBeenCalledTimes(1));
    await transport.stop();

    expect(authorizeSender).toHaveBeenCalledWith("actual-owner");
    expect(handleMessage).toHaveBeenCalledWith({ sessionId: "chat-1", senderId: "actual-owner", text: "测试" });
    const saved = await store.read();
    expect(saved.ok ? saved.value.allowedUserIds : []).toContain("actual-owner");
  });
});
