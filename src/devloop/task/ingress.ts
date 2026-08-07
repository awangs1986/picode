import { createHash } from "node:crypto";
import { join } from "node:path";
import type { HarnessTier, Result } from "../../shared/types.ts";
import { ok } from "../../shared/types.ts";
import { isTaskControlState, type TaskControlState } from "./control.ts";

export interface TaskIngressInput {
  source: string;
  externalId: string;
  title: string;
  harnessTier: HarnessTier;
  workspace?: string;
}

export interface TaskRecord extends TaskIngressInput {
  version: 1;
  taskId: string;
  createdAt: string;
}

export interface TaskRef {
  taskId: string;
  path: string;
  created: boolean;
}

interface StateAuthority<T> {
  read(): Promise<Result<T>>;
  write(value: T): Promise<Result<void>>;
}

export class TaskIngress {
  constructor(private readonly options: {
    tasksRoot: string;
    stateFile: <T>(path: string, validate: (value: unknown) => value is T) => StateAuthority<T>;
  }) {}

  async accept(input: TaskIngressInput): Promise<Result<TaskRef>> {
    const taskId = createHash("sha256")
      .update(`${input.source}\0${input.externalId}`)
      .digest("hex")
      .slice(0, 24);
    const path = join(this.options.tasksRoot, taskId, "task.json");
    const state = this.options.stateFile(path, isTaskRecord);
    const existing = await state.read();
    if (existing.ok) return ok({ taskId, path, created: false });
    const record: TaskRecord = {
      version: 1,
      taskId,
      ...input,
      createdAt: new Date().toISOString(),
    };
    const written = await state.write(record);
    return written.ok ? ok({ taskId, path, created: true }) : written;
  }

  read(taskId: string): Promise<Result<TaskRecord>> {
    return this.options.stateFile(
      join(this.options.tasksRoot, taskId, "task.json"),
      isTaskRecord,
    ).read();
  }

  readControl(taskId: string): Promise<Result<TaskControlState>> {
    return this.options.stateFile(
      join(this.options.tasksRoot, taskId, "control.json"),
      isTaskControlState,
    ).read();
  }

  writeControl(taskId: string, state: TaskControlState["state"]): Promise<Result<void>> {
    return this.options.stateFile(
      join(this.options.tasksRoot, taskId, "control.json"),
      isTaskControlState,
    ).write({ version: 1, taskId, state, updatedAt: new Date().toISOString() });
  }

  cancellationRequested(taskId: string): Promise<boolean> {
    return this.readControl(taskId).then(
      (result) => result.ok && result.value.state === "cancel_requested",
    );
  }
}

function isTaskRecord(value: unknown): value is TaskRecord {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return row.version === 1 && typeof row.taskId === "string" &&
    typeof row.source === "string" && typeof row.externalId === "string" &&
    typeof row.title === "string" &&
    (row.harnessTier === "simple" || row.harnessTier === "standard" || row.harnessTier === "tdd") &&
    typeof row.createdAt === "string";
}
