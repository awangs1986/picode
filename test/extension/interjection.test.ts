import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  INTERJECTION_ENTRY_TYPE,
  INTERJECTION_MESSAGE_TYPE,
  registerInterjection,
} from "../../src/extension/interjection.ts";

type Command = {
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
};

function fixture(idle: boolean) {
  const commands = new Map<string, Command>();
  const handlers = new Map<string, (event: unknown) => void>();
  const entries: Array<{ type: string; data: unknown }> = [];
  const messages: Array<{ message: unknown; options: unknown }> = [];
  const notify = vi.fn();
  const api = {
    on(name: string, handler: (event: unknown) => void) { handlers.set(name, handler); },
    registerCommand(name: string, command: Command) { commands.set(name, command); },
    registerMessageRenderer: vi.fn(),
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
    sendMessage(message: unknown, options: unknown) { messages.push({ message, options }); },
  } as unknown as ExtensionAPI;
  const context = {
    isIdle: () => idle,
    ui: { notify },
  } as unknown as ExtensionCommandContext;
  registerInterjection(api, { id: () => "interjection-1", now: () => 42 });
  return { commands, handlers, entries, messages, notify, context };
}

describe("Picode Interjection", () => {
  it("injects into the active turn without cancelling its current tool", async () => {
    const f = fixture(false);

    await f.commands.get("insert")?.handler("also preserve the public API", f.context);

    expect(f.messages).toEqual([{
      message: {
        customType: INTERJECTION_MESSAGE_TYPE,
        content: "The user sent a message while you were working:\n<user_query>\nalso preserve the public API\n</user_query>",
        display: true,
        details: {
          id: "interjection-1",
          originalText: "also preserve the public API",
          queuedAt: 42,
          source: "interjection",
        },
      },
      options: { deliverAs: "steer", triggerTurn: true },
    }]);
    expect(f.entries).toEqual([{
      type: INTERJECTION_ENTRY_TYPE,
      data: expect.objectContaining({
        id: "interjection-1",
        state: "queued",
        source: "interjection",
      }),
    }]);
  });

  it("falls back to its own prompt when the turn has already become idle", async () => {
    const f = fixture(true);

    await f.commands.get("insert")?.handler("continue with the new constraint", f.context);

    expect(f.messages[0]?.options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(f.entries[0]?.data).toEqual(expect.objectContaining({ state: "started" }));
  });

  it("keeps separate FIFO submissions and rejects an empty command", async () => {
    const f = fixture(false);
    await f.commands.get("insert")?.handler("first", f.context);
    await f.commands.get("insert")?.handler("second", f.context);
    await f.commands.get("insert")?.handler("   ", f.context);

    expect(f.messages.map(({ message }) => (message as { details: { originalText: string } }).details.originalText))
      .toEqual(["first", "second"]);
    expect(f.notify).toHaveBeenCalledWith("Usage: /insert <message>", "warning");
  });

  it("records delivery and cancellation without leaving false queued state", async () => {
    const delivered = fixture(false);
    await delivered.commands.get("insert")?.handler("delivered", delivered.context);
    delivered.handlers.get("message_end")?.({
      message: {
        role: "custom",
        customType: INTERJECTION_MESSAGE_TYPE,
        details: { id: "interjection-1" },
      },
    });
    expect(delivered.entries.map(({ data }) => (data as { state: string }).state))
      .toEqual(["queued", "delivered"]);

    const cancelled = fixture(false);
    await cancelled.commands.get("insert")?.handler("cancelled", cancelled.context);
    cancelled.handlers.get("agent_end")?.({});
    expect(cancelled.entries.map(({ data }) => (data as { state: string }).state))
      .toEqual(["queued", "cancelled"]);
  });
});
