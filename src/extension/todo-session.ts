import type { TaskTodoItem, TaskTodoState, Result } from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";
import type { Store } from "../store/index.ts";

export class TodoSessionController {
  private taskId: string | undefined;
  private items: TaskTodoItem[] = [];

  constructor(private readonly store: Store) {}

  async bind(taskId: string): Promise<Result<readonly TaskTodoItem[]>> {
    this.taskId = taskId;
    const loaded = await this.store.loadTaskTodos(taskId);
    this.items = loaded.ok ? loaded.value.items.map((item) => ({ ...item })) : [];
    return ok(this.snapshot());
  }

  snapshot(): readonly TaskTodoItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  async replace(items: readonly TaskTodoItem[]): Promise<Result<readonly TaskTodoItem[]>> {
    if (this.taskId === undefined) return err("devloop/todo-task-unbound", "todo_write requires an active task");
    if (items.length > 100) return err("devloop/todo-too-large", "todo_write accepts at most 100 items");
    const ids = new Set<string>();
    let inProgress = 0;
    for (const item of items) {
      if (item.id.trim() === "" || item.content.trim() === "") {
        return err("devloop/todo-invalid", "todo ids and content must not be empty");
      }
      if (ids.has(item.id)) return err("devloop/todo-duplicate", `duplicate todo id: ${item.id}`);
      ids.add(item.id);
      if (item.status === "in_progress") inProgress += 1;
    }
    if (inProgress > 1) return err("devloop/todo-multiple-active", "only one todo may be in progress");
    const state: TaskTodoState = {
      version: 1,
      taskId: this.taskId,
      updatedAt: new Date().toISOString(),
      items: items.map((item) => ({ ...item, id: item.id.trim(), content: item.content.trim() })),
    };
    const saved = await this.store.saveTaskTodos(state);
    if (!saved.ok) return saved;
    this.items = state.items;
    return ok(this.snapshot());
  }
}
