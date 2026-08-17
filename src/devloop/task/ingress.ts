import { createHash } from "node:crypto";
import { join } from "node:path";
import type { HarnessTier, Result } from "../../shared/types.ts";
import { err, ok } from "../../shared/types.ts";
import {
  isTaskControlState,
  type TaskControlState,
  type TaskFailureOutcome,
} from "./control.ts";

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
  revision: number;
  acceptance: string[];
  autoSlice: "unset" | "enabled" | "disabled";
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
      revision: 1,
      acceptance: [],
      autoSlice: "unset",
    };
    const written = await state.write(record);
    return written.ok ? ok({ taskId, path, created: true }) : written;
  }

  async read(taskId: string): Promise<Result<TaskRecord>> {
    const state = this.options.stateFile(
      join(this.options.tasksRoot, taskId, "task.json"),
      isTaskRecord,
    );
    const value = await state.read();
    if (!value.ok) return value;
    const normalized = normalizeTaskRecord(value.value);
    if (
      value.value.revision === normalized.revision &&
      value.value.acceptance === normalized.acceptance &&
      value.value.autoSlice === normalized.autoSlice
    ) return ok(normalized);
    const written = await state.write(normalized);
    return written.ok ? ok(normalized) : written;
  }

  async updateHarnessTier(taskId: string, harnessTier: HarnessTier): Promise<Result<TaskRecord>> {
    const state = this.options.stateFile(
      join(this.options.tasksRoot, taskId, "task.json"),
      isTaskRecord,
    );
    const current = await this.read(taskId);
    if (!current.ok) return current;
    if (current.value.harnessTier === harnessTier) return current;
    const updated: TaskRecord = { ...current.value, harnessTier };
    const written = await state.write(updated);
    return written.ok ? ok(updated) : written;
  }

  async updateTitle(taskId: string, title: string): Promise<Result<TaskRecord>> {
    const state = this.options.stateFile(
      join(this.options.tasksRoot, taskId, "task.json"),
      isTaskRecord,
    );
    const current = await this.read(taskId);
    if (!current.ok) return current;
    if (current.value.title === title) return current;
    const updated: TaskRecord = { ...current.value, title, revision: current.value.revision + 1 };
    const written = await state.write(updated);
    return written.ok ? ok(updated) : written;
  }

  async updateAcceptance(taskId: string, acceptance: readonly string[]): Promise<Result<TaskRecord>> {
    const state = this.options.stateFile(join(this.options.tasksRoot, taskId, "task.json"), isTaskRecord);
    const current = await this.read(taskId);
    if (!current.ok) return current;
    const normalized = acceptance.map((item) => item.trim()).filter((item) => item !== "");
    if (JSON.stringify(current.value.acceptance) === JSON.stringify(normalized)) return current;
    const updated = { ...current.value, acceptance: normalized, revision: current.value.revision + 1 };
    const written = await state.write(updated);
    return written.ok ? ok(updated) : written;
  }

  async rebindWorkspace(taskId: string, workspace: string): Promise<Result<TaskRecord>> {
    const state = this.options.stateFile(join(this.options.tasksRoot, taskId, "task.json"), isTaskRecord);
    const current = await this.read(taskId);
    if (!current.ok) return current;
    if (current.value.workspace === workspace) return current;
    const updated = { ...current.value, workspace, revision: current.value.revision + 1 };
    const written = await state.write(updated);
    return written.ok ? ok(updated) : written;
  }

  async bumpRevision(taskId: string): Promise<Result<TaskRecord>> {
    const state = this.options.stateFile(join(this.options.tasksRoot, taskId, "task.json"), isTaskRecord);
    const current = await this.read(taskId);
    if (!current.ok) return current;
    const updated = { ...current.value, revision: current.value.revision + 1 };
    const written = await state.write(updated);
    return written.ok ? ok(updated) : written;
  }

  async setAutoSlice(taskId: string, enabled: boolean): Promise<Result<TaskRecord>> {
    const state = this.options.stateFile(join(this.options.tasksRoot, taskId, "task.json"), isTaskRecord);
    const current = await this.read(taskId);
    if (!current.ok) return current;
    const autoSlice = enabled ? "enabled" as const : "disabled" as const;
    if (current.value.autoSlice === autoSlice) return current;
    const updated = { ...current.value, autoSlice };
    const written = await state.write(updated);
    return written.ok ? ok(updated) : written;
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

  beginRun(taskId: string): Promise<Result<void>> {
    return this.writeControl(taskId, "running");
  }

  reportFailure(taskId: string, input: {
    outcome: TaskFailureOutcome;
    summary: string;
    evidenceRefs?: readonly string[];
  }): Promise<Result<void>> {
    const summary = input.summary.trim();
    if (summary === "") return Promise.resolve(err(
      "devloop/task-failure-summary-required",
      "a structured Task failure requires a non-empty summary",
    ));
    const evidenceRefs = [...(input.evidenceRefs ?? [])]
      .map((ref) => ref.trim())
      .filter((ref) => ref !== "");
    return this.options.stateFile(
      join(this.options.tasksRoot, taskId, "control.json"),
      isTaskControlState,
    ).write({
      version: 1,
      taskId,
      state: "failed",
      outcome: input.outcome,
      summary,
      ...(evidenceRefs.length === 0 ? {} : { evidenceRefs }),
      updatedAt: new Date().toISOString(),
    });
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
    typeof row.createdAt === "string" &&
    (row.revision === undefined || (typeof row.revision === "number" && row.revision >= 1)) &&
    (row.acceptance === undefined || (Array.isArray(row.acceptance) && row.acceptance.every((item) => typeof item === "string"))) &&
    (row.autoSlice === undefined || row.autoSlice === "unset" || row.autoSlice === "enabled" || row.autoSlice === "disabled");
}

function normalizeTaskRecord(record: TaskRecord): TaskRecord {
  return {
    ...record,
    revision: typeof record.revision === "number" ? record.revision : 1,
    acceptance: Array.isArray(record.acceptance) ? record.acceptance : [],
    autoSlice: record.autoSlice ?? "unset",
  };
}
