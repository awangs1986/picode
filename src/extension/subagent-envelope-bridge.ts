import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  SUBAGENT_DELEGATION_UPDATE_EVENT,
  type SubagentDelegationResponse,
  type SubagentDelegationUpdate,
} from "pi-subagents/delegation";
import type { PicodeRuntime } from "./index.ts";

type Events = Pick<ExtensionAPI["events"], "on">;

function eventId(prefix: string, payload: Record<string, unknown>): string {
  return `${prefix}:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

function childRunId(payload: {
  ownerRunId?: string;
  nodeId?: string;
  runId?: string;
  requestId: string;
}): string {
  if (typeof payload.runId === "string" && payload.runId.length > 0) return payload.runId;
  const owner = typeof payload.ownerRunId === "string" ? payload.ownerRunId : payload.requestId;
  const node = typeof payload.nodeId === "string" ? payload.nodeId : payload.requestId;
  return `${owner}:${node}`;
}

export function registerSubagentEnvelopeBridge(
  events: Events,
  runtime: PicodeRuntime,
): () => void {
  const unsubs = [
    events.on(SUBAGENT_DELEGATION_UPDATE_EVENT, (raw) => {
      const update = raw as SubagentDelegationUpdate;
      if (typeof update.requestId !== "string" || typeof update.ownerRunId !== "string") return;
      runtime.admitRuntime(JSON.stringify({
        version: 1,
        eventId: eventId("subagent-update", update as unknown as Record<string, unknown>),
        kind: "subagent.update",
        payload: update,
      }), {
        executionEpoch: runtime.engine.currentEpoch(),
        runId: childRunId(update),
        requestId: update.requestId,
      });
    }),
    events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (raw) => {
      const response = raw as SubagentDelegationResponse;
      if (typeof response.requestId !== "string") return;
      const status = response.status;
      const kind = status === "completed"
        ? "run.completed"
        : status === "cancelled" || status === "interrupted"
          ? "run.cancelled"
          : "run.failed";
      runtime.admitRuntime(JSON.stringify({
        version: 1,
        eventId: eventId("subagent-terminal", response as unknown as Record<string, unknown>),
        kind,
        payload: response,
      }), {
        executionEpoch: runtime.engine.currentEpoch(),
        runId: childRunId(response),
        requestId: response.requestId,
      });
    }),
  ];
  return () => { for (const unsubscribe of unsubs) unsubscribe(); };
}
