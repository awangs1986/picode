const ACTIVE_TASK_KEY = "picode:active-task:v1";

function validTask(task) {
  return (
    task &&
    typeof task.id === "string" &&
    task.id.trim() &&
    typeof task.chatId === "string" &&
    task.chatId.trim() &&
    ["simple", "harness"].includes(task.kind)
  );
}

export function rememberActiveTask(storage, task) {
  if (!validTask(task)) throw new Error("A durable Picode task identity is required");
  const normalized = {
    id: task.id.trim(),
    chatId: task.chatId.trim(),
    kind: task.kind,
  };
  storage?.setItem?.(ACTIVE_TASK_KEY, JSON.stringify(normalized));
  return normalized;
}

export function loadActiveTask(storage) {
  try {
    const task = JSON.parse(storage?.getItem?.(ACTIVE_TASK_KEY) || "null");
    return validTask(task) ? task : null;
  } catch {
    storage?.removeItem?.(ACTIVE_TASK_KEY);
    return null;
  }
}

export function clearActiveTask(storage) {
  storage?.removeItem?.(ACTIVE_TASK_KEY);
}

export function activePromptContext(task, sourcePort, model) {
  if (!Number.isInteger(sourcePort) || sourcePort <= 0 || sourcePort > 65_535) return {};
  if (!validTask(task)) return { sourcePort };
  if (typeof model !== "string" || !model.trim()) return {};
  return { taskId: task.id, sourcePort, model: model.trim() };
}
