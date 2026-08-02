import { describe, expect, test, vi } from "vitest";
import { ConversationClient } from "./conversation-client.js";

function granted(chatId, generation) {
  return {
    decision: "granted",
    control: {
      chatId,
      state: "owned_idle",
      controller: { generation, clientId: "gui-a" },
    },
  };
}

describe("ConversationClient", () => {
  test("claims once, installs fencing on the websocket, and renews", async () => {
    const transport = {
      claimConversation: vi.fn(async () => granted("chat-a", 3)),
      renewConversation: vi.fn(async () => ({ state: "owned_idle" })),
      releaseConversation: vi.fn(async () => "released"),
    };
    const ws = { setConversationControl: vi.fn() };
    const client = new ConversationClient(transport, ws, { heartbeatMs: 100_000 });

    expect(await client.ensureControl("chat-a")).toEqual({ granted: true, generation: 3 });
    expect(ws.setConversationControl).toHaveBeenCalledWith({ chatId: "chat-a", generation: 3 });
    await client.renew();
    expect(transport.renewConversation).toHaveBeenCalledWith("chat-a", 3);
    client.stop();
  });

  test("keeps the local draft when another healthy client is controller", async () => {
    const transport = {
      claimConversation: vi.fn(async () => ({
        decision: "observing",
        control: { chatId: "chat-a", state: "owned_active", controller: { clientId: "tui-b" } },
      })),
    };
    const ws = { setConversationControl: vi.fn() };
    const client = new ConversationClient(transport, ws, { heartbeatMs: 100_000 });

    const result = await client.ensureControl("chat-a");

    expect(result.granted).toBe(false);
    expect(result.state).toBe("owned_active");
    expect(ws.setConversationControl).not.toHaveBeenCalled();
    client.stop();
  });

  test("a suspect expired controller is probed before a safe takeover retry", async () => {
    const transport = {
      claimConversation: vi
        .fn()
        .mockResolvedValueOnce({
          decision: "observing",
          control: {
            chatId: "chat-a",
            state: "suspect",
            controller: { challengeDeadline: Date.now() - 1 },
          },
        })
        .mockResolvedValueOnce(granted("chat-a", 4)),
      reportFailedConversationProbe: vi.fn(async () => ({ state: "takeover_available" })),
      renewConversation: vi.fn(),
      releaseConversation: vi.fn(),
    };
    const ws = { setConversationControl: vi.fn() };
    const client = new ConversationClient(transport, ws, { heartbeatMs: 100_000 });

    expect(await client.ensureControl("chat-a")).toEqual({ granted: true, generation: 4 });
    expect(transport.reportFailedConversationProbe).toHaveBeenCalledWith("chat-a");
    expect(transport.claimConversation).toHaveBeenCalledTimes(2);
    client.stop();
  });
});
