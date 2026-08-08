import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PICODE_SUBAGENT_RESULT_PREFIX = "PICODE_SUBAGENT_RPC_RESULT:";
const REQUEST_EVENT = "subagents:rpc:v1:request";
const REPLY_PREFIX = "subagents:rpc:v1:reply:";

type Method = "status" | "stop" | "resume";

interface CommandRequest {
  method: Method;
  params?: Record<string, unknown>;
}

function decodeRequest(value: string): CommandRequest {
  const parsed = JSON.parse(Buffer.from(value.trim(), "base64url").toString("utf8")) as CommandRequest;
  if (parsed === null || typeof parsed !== "object" || !["status", "stop", "resume"].includes(parsed.method)) {
    throw new Error("invalid subagent control request");
  }
  return parsed;
}

/** Headless adapter over pi-subagents' public event RPC; owns no subagent state. */
export function registerSubagentControlCommand(pi: ExtensionAPI): void {
  pi.registerCommand("picode-subagent-rpc", {
    description: "Internal headless bridge to the pi-subagents control protocol",
    handler: async (args, ctx) => {
      try {
        const input = decodeRequest(args);
        const requestId = randomUUID();
        const replyEvent = `${REPLY_PREFIX}${requestId}`;
        const reply = await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => {
            unsubscribe?.();
            reject(new Error("pi-subagents control bridge is unavailable in this session"));
          }, 10_000);
          const unsubscribe = pi.events.on(replyEvent, (value) => {
            clearTimeout(timer);
            unsubscribe?.();
            resolve(value);
          });
          pi.events.emit(REQUEST_EVENT, {
            version: 1,
            requestId,
            method: input.method,
            ...(input.params === undefined ? {} : { params: input.params }),
            source: { extension: "picode" },
          });
        });
        ctx.ui.notify(`${PICODE_SUBAGENT_RESULT_PREFIX}${JSON.stringify(reply)}`, "info");
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        ctx.ui.notify(`${PICODE_SUBAGENT_RESULT_PREFIX}${JSON.stringify({ success: false, error: { code: "picode_bridge", message } })}`, "error");
      }
    },
  });
}
