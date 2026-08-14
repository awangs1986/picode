import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IlinkSessionExpiredError, type IlinkClient, type IlinkCredentials } from "../../src/extension/weixin-ilink-client.ts";
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

  it("retries an admitted message when the Pi turn fails transiently", async () => {
    const client = {
      getUpdates: vi.fn()
        .mockResolvedValueOnce({ syncBuf: "s1", messages: [{ messageId: "m-retry", senderId: "owner-1", text: "继续", contextToken: "ctx-retry" }] })
        .mockImplementation(async (_credentials, syncBuf, signal: AbortSignal) => {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          return { syncBuf, messages: [] };
        }),
      sendText: vi.fn().mockResolvedValue(undefined),
    } as unknown as IlinkClient;
    const handleMessage = vi.fn()
      .mockRejectedValueOnce(new Error("the active Pi TUI turn is already running"))
      .mockResolvedValueOnce("稍后继续完成");
    const onError = vi.fn();
    const store = tempState();
    await store.write({ version: 1, accountRefId: "weixin-ilink:bot-1", boundSessionId: "chat-1", allowedUserIds: ["owner-1"], syncBuf: "", contextTokens: {}, recentMessageIds: [] });
    const transport = new WeixinTransport({
      client,
      credentials: () => credentials,
      store,
      handleMessage,
      onError,
      retryDelayMs: 1,
    });

    await transport.start();
    await vi.waitFor(() => expect(client.sendText).toHaveBeenCalledTimes(1));
    await transport.stop();

    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "the active Pi TUI turn is already running" }));
    const saved = await store.read();
    expect(saved.ok && saved.value).toMatchObject({ syncBuf: "s1", recentMessageIds: ["m-retry"] });
  });

  it("leaves a stopped in-flight message unconsumed for recovery", async () => {
    const client = {
      getUpdates: vi.fn().mockResolvedValue({
        syncBuf: "s1",
        messages: [{ messageId: "m-stopped", senderId: "owner-1", text: "稍后重试", contextToken: "ctx-stopped" }],
      }),
      sendText: vi.fn(),
    } as unknown as IlinkClient;
    const handleMessage = vi.fn().mockRejectedValue(new Error("Pi is still busy"));
    const store = tempState();
    await store.write({ version: 1, accountRefId: "weixin-ilink:bot-1", boundSessionId: "chat-1", allowedUserIds: ["owner-1"], syncBuf: "", contextTokens: {}, recentMessageIds: [] });
    const transport = new WeixinTransport({
      client,
      credentials: () => credentials,
      store,
      handleMessage,
      retryDelayMs: 10_000,
    });

    await transport.start();
    await vi.waitFor(() => expect(handleMessage).toHaveBeenCalledTimes(1));
    await transport.stop();

    const saved = await store.read();
    expect(saved.ok && saved.value).toMatchObject({ syncBuf: "", recentMessageIds: [] });
  });

  it("retries reply compaction without rerunning the completed Pi turn", async () => {
    const client = {
      getUpdates: vi.fn()
        .mockResolvedValueOnce({ syncBuf: "s1", messages: [{ messageId: "m-compact-retry", senderId: "owner-1", text: "状态", contextToken: "ctx-compact" }] })
        .mockImplementation(async (_credentials, syncBuf, signal: AbortSignal) => {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          return { syncBuf, messages: [] };
        }),
      sendText: vi.fn().mockResolvedValue(undefined),
    } as unknown as IlinkClient;
    const handleMessage = vi.fn().mockResolvedValue("完整 TUI 回答");
    const transformReply = vi.fn()
      .mockRejectedValueOnce(new Error("temporary compaction failure"))
      .mockResolvedValueOnce("精简微信回答");
    const store = tempState();
    await store.write({ version: 1, accountRefId: "weixin-ilink:bot-1", boundSessionId: "chat-1", allowedUserIds: ["owner-1"], syncBuf: "", contextTokens: {}, recentMessageIds: [] });
    const transport = new WeixinTransport({
      client,
      credentials: () => credentials,
      store,
      handleMessage,
      transformReply,
      retryDelayMs: 1,
    });

    await transport.start();
    await vi.waitFor(() => expect(client.sendText).toHaveBeenCalledTimes(1));
    await transport.stop();

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(transformReply).toHaveBeenCalledTimes(2);
    expect(transformReply).toHaveBeenCalledWith({ sessionId: "chat-1", text: "完整 TUI 回答" });
    expect(client.sendText).toHaveBeenCalledWith(credentials, expect.objectContaining({ text: "精简微信回答" }));
  });

  it("retries outbound delivery without rerunning the completed Pi turn", async () => {
    const client = {
      getUpdates: vi.fn()
        .mockResolvedValueOnce({ syncBuf: "s1", messages: [{ messageId: "m-send-retry", senderId: "owner-1", text: "状态", contextToken: "ctx-send" }] })
        .mockImplementation(async (_credentials, syncBuf, signal: AbortSignal) => {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          return { syncBuf, messages: [] };
        }),
      sendText: vi.fn()
        .mockRejectedValueOnce(new Error("iLink sendmessage HTTP 503"))
        .mockResolvedValueOnce(undefined),
    } as unknown as IlinkClient;
    const handleMessage = vi.fn().mockResolvedValue("已经完成");
    const store = tempState();
    await store.write({ version: 1, accountRefId: "weixin-ilink:bot-1", boundSessionId: "chat-1", allowedUserIds: ["owner-1"], syncBuf: "", contextTokens: {}, recentMessageIds: [] });
    const transport = new WeixinTransport({
      client,
      credentials: () => credentials,
      store,
      handleMessage,
      retryDelayMs: 1,
    });

    await transport.start();
    await vi.waitFor(() => expect(client.sendText).toHaveBeenCalledTimes(2));
    await transport.stop();

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(client.sendText).toHaveBeenNthCalledWith(1, credentials, expect.objectContaining({ clientId: "picode-weixin-m-send-retry-0" }));
    expect(client.sendText).toHaveBeenNthCalledWith(2, credentials, expect.objectContaining({ clientId: "picode-weixin-m-send-retry-0" }));
    const saved = await store.read();
    expect(saved.ok && saved.value).toMatchObject({ syncBuf: "s1", recentMessageIds: ["m-send-retry"] });
  });

  it("stops instead of retrying forever when the iLink login session expires", async () => {
    const client = {
      getUpdates: vi.fn().mockRejectedValue(new IlinkSessionExpiredError("getupdates")),
      sendText: vi.fn(),
    } as unknown as IlinkClient;
    const onError = vi.fn();
    const store = tempState();
    await store.write({ version: 1, accountRefId: "weixin-ilink:bot-1", boundSessionId: "chat-1", allowedUserIds: ["owner-1"], syncBuf: "", contextTokens: {}, recentMessageIds: [] });
    const transport = new WeixinTransport({
      client,
      credentials: () => credentials,
      store,
      handleMessage: vi.fn(),
      onError,
      retryDelayMs: 1,
    });

    await transport.start();
    await vi.waitFor(() => expect(transport.isRunning()).toBe(false));

    expect(client.getUpdates).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("run /weixin login") }));
  });

  it("allows only one live poller for the same iLink token", async () => {
    const firstStore = tempState();
    const secondStore = tempState();
    const state = { version: 1 as const, accountRefId: "weixin-ilink:bot-1", boundSessionId: "chat-1", allowedUserIds: ["owner-1"], syncBuf: "", contextTokens: {}, recentMessageIds: [] };
    await firstStore.write(state);
    await secondStore.write(state);
    const blockingClient = {
      getUpdates: vi.fn().mockImplementation(async (_credentials, syncBuf, signal: AbortSignal) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { syncBuf, messages: [] };
      }),
      sendText: vi.fn(),
    } as unknown as IlinkClient;
    const first = new WeixinTransport({ client: blockingClient, credentials: () => credentials, store: firstStore, handleMessage: vi.fn() });
    const second = new WeixinTransport({ client: blockingClient, credentials: () => credentials, store: secondStore, handleMessage: vi.fn() });

    await first.start();
    await expect(second.start()).rejects.toThrow("already polled by another Picode process");
    await first.stop();
    await second.start();
    await second.stop();
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
