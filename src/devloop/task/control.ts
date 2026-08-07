export interface TaskControlState {
  version: 1;
  taskId: string;
  state: "running" | "cancel_requested" | "cancelled" | "completed" | "failed";
  updatedAt: string;
}

export function isTaskControlState(value: unknown): value is TaskControlState {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Partial<TaskControlState>;
  return row.version === 1 && typeof row.taskId === "string" &&
    ["running", "cancel_requested", "cancelled", "completed", "failed"].includes(String(row.state)) &&
    typeof row.updatedAt === "string";
}
