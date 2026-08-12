import type { DevloopPort, Result, TaskCapsule, WorkspaceSnapshotRef } from "../shared/types.ts";
import { canInject } from "./task/capsule.ts";

export {
  canInject,
  capsuleDigest,
  createCapsule,
  renderCapsule,
  sealCapsule,
  supersedeCapsule,
} from "./task/capsule.ts";
export type { CapsuleDraftInput } from "./task/capsule.ts";
export { renderBridgeNote } from "./context/bridge-note.ts";
export type { BridgeNoteInput } from "./context/bridge-note.ts";
export { discoverProjectContext, renderProjectContext } from "./context/project-context.ts";
export type { ProjectContextEntry } from "./context/project-context.ts";
export {
  renderTaskStateHeader,
  shouldRestateTaskState,
  taskStateDigest,
} from "./context/task-state-header.ts";
export type { TaskStateHeader } from "./context/task-state-header.ts";
export { DEFAULT_SLICE_THRESHOLDS, evaluateSlice } from "./task/slice.ts";
export type { SliceAdvice, SliceChannel, SliceSignals, SliceThresholds } from "./task/slice.ts";
export { appendEvidence } from "./verify/evidence.ts";
export { detectFlaky, effectiveResults } from "./verify/gate.ts";
export type { CandidateSnapshot, GateRun } from "./verify/gate.ts";
export { TDD_BUDGET, TddRun } from "./verify/tdd.ts";
export type { BudgetOutcome, TddState } from "./verify/tdd.ts";
export { issueCompletionLabel } from "./verify/completion.ts";
export type { CompletionLabel } from "./verify/completion.ts";
export { renderForeignResumeCapsule } from "./context/foreign-resume.ts";
export type { ForeignResumeInput } from "./context/foreign-resume.ts";
export { ContextGovernor } from "./context/context-governor.ts";
export type {
  ContextBudgetBreakdown,
  ContextGovernorBudget,
  ContextGovernorInput,
  ContextGovernorMessage,
  ContextGovernorResult,
  ContextGovernorStats,
  ContextGovernorTool,
} from "./context/context-governor.ts";
export { TaskIngress } from "./task/ingress.ts";
export type { TaskIngressInput, TaskRecord, TaskRef } from "./task/ingress.ts";
export { isTaskControlState } from "./task/control.ts";
export type { TaskControlState } from "./task/control.ts";

/**
 * Devloop：产品核心价值所在。内部三道墙（MODULES.md 保留条款 ①）：
 *
 *   task/    — Task Run / Slice / Capsule 的事实权威
 *   context/ — 只渲染（Context Package / 桥接注记），不拥有任务或验证事实
 *   verify/  — 唯一有权签发 Completion Label（Gate/Evidence/TDD 状态机）
 *
 * P2: Slice 三通道触发；P3: TDD 状态机 + Gate/Flaky + Completion Label
 * 签发 + Foreign Resume Capsule 渲染，均已落地于对应子目录。
 */
export class Devloop implements DevloopPort {
  canInjectCapsule(
    capsule: TaskCapsule,
    current: { taskId: string; taskRevision: number; workspace?: WorkspaceSnapshotRef },
  ): Result<void> {
    return canInject(capsule, current);
  }
}
