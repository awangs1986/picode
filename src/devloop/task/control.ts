export type TaskFailureOutcome = "failed_preflight" | "blocked";

export interface TaskControlState {
  version: 1;
  taskId: string;
  state: "running" | "cancel_requested" | "cancelled" | "completed" | "failed";
  outcome?: TaskFailureOutcome;
  summary?: string;
  evidenceRefs?: string[];
  updatedAt: string;
}

export function isTaskControlState(value: unknown): value is TaskControlState {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Partial<TaskControlState>;
  return row.version === 1 && typeof row.taskId === "string" &&
    ["running", "cancel_requested", "cancelled", "completed", "failed"].includes(String(row.state)) &&
    (row.outcome === undefined || row.outcome === "failed_preflight" || row.outcome === "blocked") &&
    (row.summary === undefined || typeof row.summary === "string") &&
    (row.evidenceRefs === undefined ||
      (Array.isArray(row.evidenceRefs) && row.evidenceRefs.every((ref) => typeof ref === "string"))) &&
    typeof row.updatedAt === "string";
}
