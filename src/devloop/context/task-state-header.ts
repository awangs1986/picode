import { createHash } from "node:crypto";
import type { HarnessTier } from "../../shared/types.ts";

export interface TaskStateHeader {
  taskId: string;
  revision: number;
  mode: HarnessTier;
  sliceId?: string;
  goal: string;
  acceptance: string[];
  phase: string;
  currentGate?: string;
  blockedBy: string[];
  requiredContextRefs: string[];
}

function stable(value: TaskStateHeader): string {
  return JSON.stringify({
    taskId: value.taskId,
    revision: value.revision,
    mode: value.mode,
    sliceId: value.sliceId ?? null,
    goal: value.goal,
    acceptance: value.acceptance,
    phase: value.phase,
    currentGate: value.currentGate ?? null,
    blockedBy: value.blockedBy,
    requiredContextRefs: value.requiredContextRefs,
  });
}

export function taskStateDigest(value: TaskStateHeader): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

export function renderTaskStateHeader(value: TaskStateHeader): string {
  return `<picode_task_state>\n${stable(value)}\n</picode_task_state>`;
}

export function shouldRestateTaskState(input: {
  current: TaskStateHeader;
  previousDigest?: string;
  tokensSinceLast: number;
  repeatAfterTokens?: number;
}): boolean {
  return input.previousDigest !== taskStateDigest(input.current) ||
    input.tokensSinceLast >= (input.repeatAfterTokens ?? 25_000);
}
