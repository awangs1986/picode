import type { SourceRef } from "./types.ts";

/**
 * Picode 自有事件统一信封（MODULES.md §3.4 Evidence 双层格式）：
 * Gate 结果、Guard 裁决、Completion Label、Epoch 切换等 append 进
 * evidence/<yyyymm>.jsonl。Subagent 运行证据不走此信封——直接存
 * pi-subagents 生命周期工件 v3 的指针。
 */
export interface PicodeEvent<T = unknown> {
  ts: string;
  kind: string;
  taskId?: string;
  sliceId?: string;
  payload: T;
  ref?: SourceRef;
}

export function makeEvent<T>(
  kind: string,
  payload: T,
  opts: { taskId?: string; sliceId?: string; ref?: SourceRef } = {},
): PicodeEvent<T> {
  const event: PicodeEvent<T> = { ts: new Date().toISOString(), kind, payload };
  if (opts.taskId !== undefined) event.taskId = opts.taskId;
  if (opts.sliceId !== undefined) event.sliceId = opts.sliceId;
  if (opts.ref !== undefined) event.ref = opts.ref;
  return event;
}
