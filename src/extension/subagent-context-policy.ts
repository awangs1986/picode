import { renderCapsule } from "../devloop/task/capsule.ts";
import type { Result, TaskCapsule, WorkspaceSnapshotRef } from "../shared/types.ts";

export interface SubagentCapsuleBinding {
  taskId: string;
  taskRevision: number;
  workspace?: WorkspaceSnapshotRef;
}

export interface SubagentContextPolicyDeps {
  binding?: SubagentCapsuleBinding;
  loadLatestSealedCapsule(taskId: string): Promise<Result<TaskCapsule | undefined>>;
  canInjectCapsule(
    capsule: TaskCapsule,
    current: SubagentCapsuleBinding,
  ): Result<void>;
}

export interface SubagentContextPolicyResult {
  applied: boolean;
  capsuleId?: string;
  warning?: string;
}

const CAPSULE_OPEN = "<picode_task_capsule>";
const CAPSULE_CLOSE = "</picode_task_capsule>";

/**
 * Picode's single policy seam for pi-subagents context transfer. Direct child
 * runs default to a fresh transcript and receive only a Store-backed, sealed
 * Capsule. An explicit fork is always honored. Management calls remain inert.
 */
export async function applySubagentContextPolicy(
  toolName: string,
  input: Record<string, unknown>,
  deps: SubagentContextPolicyDeps,
): Promise<SubagentContextPolicyResult> {
  if (toolName !== "subagent" || Object.hasOwn(input, "action")) return { applied: false };
  const isDirect = typeof input.agent === "string";
  const isWorkflow = typeof input.workflowScript === "string";
  if (!isDirect && !isWorkflow) return { applied: false };

  if (input.context === undefined) input.context = "fresh";
  if (input.context !== "fresh") return { applied: false };
  if (!isDirect || typeof input.task !== "string") return { applied: false };
  if (input.task.includes(CAPSULE_OPEN)) return { applied: false };
  if (deps.binding === undefined) return { applied: false };

  const loaded = await deps.loadLatestSealedCapsule(deps.binding.taskId);
  if (!loaded.ok) return { applied: false, warning: loaded.error.message };
  if (loaded.value === undefined) return { applied: false };
  const injectable = deps.canInjectCapsule(loaded.value, deps.binding);
  if (!injectable.ok) return { applied: false, warning: injectable.error.message };

  input.task = `${input.task.trimEnd()}\n\n${CAPSULE_OPEN}\n${renderCapsule(loaded.value)}\n${CAPSULE_CLOSE}`;
  return { applied: true, capsuleId: loaded.value.capsuleId };
}
