import { createHash, randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

export const INTERJECTION_ENTRY_TYPE = "picode.interjection";
export const INTERJECTION_MESSAGE_TYPE = "picode-interjection";
export const INTERJECTION_TEXT_LIMIT = 25_000;

export interface InterjectionDetails {
  id: string;
  originalText: string;
  queuedAt: number;
  source: "interjection";
}

export interface InterjectionHost {
  id?: () => string;
  now?: () => number;
}

function sanitizeText(input: string): string {
  return input
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .trim();
}

function truncateText(input: string): string {
  const characters = Array.from(input);
  if (characters.length <= INTERJECTION_TEXT_LIMIT) return input;
  return `${characters.slice(0, INTERJECTION_TEXT_LIMIT).join("")}\n[truncated]`;
}

export function formatInterjection(input: string): { originalText: string; modelText: string } | undefined {
  const originalText = truncateText(sanitizeText(input));
  if (originalText === "") return undefined;
  return {
    originalText,
    modelText: "The user sent a message while you were working:\n" +
      `<user_query>\n${originalText}\n</user_query>`,
  };
}

/**
 * Adds Grok-style mid-turn interjection semantics over Pi's public steering
 * seam. Pi guarantees that steering is consumed after the current assistant
 * turn's tool calls and before the next provider request, so no second Agent
 * Loop or cancellation path is introduced here.
 */
export function registerInterjection(pi: ExtensionAPI, host: InterjectionHost = {}): void {
  const nextId = host.id ?? randomUUID;
  const now = host.now ?? Date.now;
  const pending = new Map<string, { queuedAt: number; textDigest: string }>();

  const appendTransition = (
    id: string,
    state: "started" | "queued" | "delivered" | "cancelled",
    queuedAt: number,
    textDigest: string,
  ): void => {
    pi.appendEntry(INTERJECTION_ENTRY_TYPE, {
      schemaVersion: 1,
      id,
      queuedAt,
      source: "interjection",
      state,
      textDigest,
      transitionAt: now(),
    });
  };

  pi.registerMessageRenderer<InterjectionDetails>(
    INTERJECTION_MESSAGE_TYPE,
    (message, { outputPad }, theme) => {
      const details = message.details as InterjectionDetails | undefined;
      const visibleText = details?.originalText ?? String(message.content);
      const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
      box.addChild(new Text(`${theme.fg("accent", "Interjection")} ${visibleText}`, 0, 0));
      return box;
    },
  );

  pi.on("message_end", (event) => {
    if (event.message.role !== "custom" || event.message.customType !== INTERJECTION_MESSAGE_TYPE) return;
    const id = (event.message.details as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string") return;
    const record = pending.get(id);
    if (record === undefined) return;
    pending.delete(id);
    appendTransition(id, "delivered", record.queuedAt, record.textDigest);
  });
  pi.on("agent_end", () => {
    for (const [id, record] of pending) {
      appendTransition(id, "cancelled", record.queuedAt, record.textDigest);
    }
    pending.clear();
  });

  pi.registerCommand("insert", {
    description: "Insert a message into the active turn without cancelling the current tool",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const formatted = formatInterjection(args);
      if (formatted === undefined) {
        ctx.ui.notify("Usage: /insert <message>", "warning");
        return;
      }

      const id = nextId();
      const queuedAt = now();
      const idle = ctx.isIdle();
      const textDigest = createHash("sha256").update(formatted.originalText).digest("hex");
      pending.set(id, { queuedAt, textDigest });
      appendTransition(id, idle ? "started" : "queued", queuedAt, textDigest);
      pi.sendMessage({
        customType: INTERJECTION_MESSAGE_TYPE,
        content: idle ? formatted.originalText : formatted.modelText,
        display: true,
        details: {
          id,
          originalText: formatted.originalText,
          queuedAt,
          source: "interjection",
        } satisfies InterjectionDetails,
      // Both options close the isIdle()/send race through Pi's public seam:
      // streaming uses steer; idle uses triggerTurn, so nothing is stranded.
      }, { deliverAs: "steer", triggerTurn: true });
      ctx.ui.notify(
        idle
          ? "The turn had already finished; the message started a new turn."
          : "Message inserted after the current tool completes.",
        "info",
      );
    },
  });
}
