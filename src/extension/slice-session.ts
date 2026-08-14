import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CapsuleSealer, ContextLedger, createCapsule, evaluateSlice, renderCapsule } from "../devloop/index.ts";
import type { TaskCapsule, WorkspaceSnapshotRef } from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";
import { createHash } from "node:crypto";
import type { HarnessTier } from "../shared/types.ts";
import type { TaskStateHeader } from "../devloop/index.ts";
import type { PicodeRuntime } from "./index.ts";
import { PiSessionLifecycle } from "../engine/pi-session-lifecycle.ts";

export const TASK_BINDING_ENTRY_TYPE = "picode.task-binding";
export const TASK_CAPSULE_MESSAGE_TYPE = "picode.task-capsule";
export const MAX_CAPSULE_FILES_TOUCHED = 200;

export interface TaskBinding {
  taskId: string;
  taskRevision: number;
}

function sessionIdOf(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): string {
  const manager = ctx.sessionManager as { getSessionId?: () => string };
  return typeof manager.getSessionId === "function" ? manager.getSessionId() : `ephemeral:${ctx.cwd}`;
}

export function restoreTaskBinding(entries: readonly unknown[]): TaskBinding | undefined {
  let binding: TaskBinding | undefined;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (row.type !== "custom" || row.customType !== TASK_BINDING_ENTRY_TYPE) continue;
    if (typeof row.data !== "object" || row.data === null) continue;
    const data = row.data as Partial<TaskBinding>;
    if (typeof data.taskId === "string" && typeof data.taskRevision === "number") {
      binding = { taskId: data.taskId, taskRevision: data.taskRevision };
    }
  }
  return binding;
}

export class SliceSessionCoordinator {
  private binding: TaskBinding | undefined;
  private sessionId: string | undefined;
  private turnCount = 0;
  private taskTitle = "";
  private readonly advisedChannels = new Set<string>();
  private hardBoundary = false;
  private hardBoundaryDeferred = false;
  private hardBoundaryDeferUsed = false;

  constructor(
    private readonly runtime: PicodeRuntime,
    private readonly snapshotOf: (cwd: string) => Promise<WorkspaceSnapshotRef> = async (cwd) => ({ repo: cwd }),
    private readonly filesTouchedOf: (cwd: string) => Promise<string[]> = async () => [],
  ) {}

  currentTaskId(): string | undefined {
    return this.binding?.taskId;
  }

  currentTaskRevision(): number | undefined {
    return this.binding?.taskRevision;
  }

  async capsuleInjectionBinding(cwd: string): Promise<{
    taskId: string;
    taskRevision: number;
    workspace?: WorkspaceSnapshotRef;
  } | undefined> {
    if (this.binding === undefined) return undefined;
    try {
      return { ...this.binding, workspace: await this.snapshotOf(cwd) };
    } catch {
      return { ...this.binding };
    }
  }

  async syncHarnessTier(tier: HarnessTier): Promise<void> {
    if (this.binding === undefined) return;
    const updated = await this.runtime.taskIngress.updateHarnessTier(this.binding.taskId, tier);
    if (!updated.ok) throw new Error(updated.error.message);
  }

  taskState(mode: HarnessTier, phase: string, requiredContextRefs: string[]): TaskStateHeader | undefined {
    if (this.binding === undefined) return undefined;
    return {
      taskId: this.binding.taskId,
      revision: this.binding.taskRevision,
      mode,
      ...(this.sessionId === undefined ? {} : { sliceId: this.sessionId }),
      goal: this.taskTitle === "" ? this.binding.taskId : this.taskTitle,
      acceptance: [],
      phase,
      ...(mode === "tdd" ? { currentGate: phase } : {}),
      blockedBy: [],
      requiredContextRefs,
    };
  }

  async onSessionStart(ctx: ExtensionContext): Promise<void> {
    this.turnCount = 0;
    this.advisedChannels.clear();
    this.hardBoundary = false;
    this.hardBoundaryDeferred = false;
    this.hardBoundaryDeferUsed = false;
    const restored = restoreTaskBinding(ctx.sessionManager.getBranch());
    if (restored !== undefined) {
      this.binding = restored;
      this.sessionId = sessionIdOf(ctx);
      const task = await this.runtime.taskIngress.read(restored.taskId);
      this.taskTitle = task.ok ? task.value.title : restored.taskId;
      return;
    }
    const manager = ctx.sessionManager as { getSessionName?: () => string | undefined };
    const title = manager.getSessionName?.() ?? sessionIdOf(ctx);
    const accepted = await this.runtime.taskIngress.accept({
      source: "pi-session",
      externalId: sessionIdOf(ctx),
      title,
      harnessTier: this.runtime.harness.current(),
      workspace: ctx.cwd,
    });
    if (!accepted.ok) throw new Error(accepted.error.message);
    this.binding = { taskId: accepted.value.taskId, taskRevision: 1 };
    const sessionManager = ctx.sessionManager as {
      appendCustomEntry?: (type: string, data: unknown) => unknown;
    };
    sessionManager.appendCustomEntry?.(TASK_BINDING_ENTRY_TYPE, this.binding);
    this.sessionId = sessionIdOf(ctx);
    this.taskTitle = title;
  }

  observeTurn(ctx: ExtensionContext): void {
    this.turnCount += 1;
    if (this.runtime.harness.current() === "simple") return;
    const percent = ctx.getContextUsage?.()?.percent;
    const advice = evaluateSlice({
      userRequested: false,
      contextUsageRatio: typeof percent === "number" ? percent / 100 : 0,
      turnCount: this.turnCount,
      scopeDriftReported: false,
    });
    const newChannels = advice.channels.filter((channel) => !this.advisedChannels.has(channel));
    if (advice.enforce && !this.hardBoundaryDeferred) this.hardBoundary = true;
    else if (this.hardBoundaryDeferred) this.hardBoundaryDeferred = false;
    if (!advice.advise || newChannels.length === 0) return;
    for (const channel of newChannels) this.advisedChannels.add(channel);
    ctx.ui.notify(
      `${advice.enforce ? "Slice required" : "Slice recommended"}: ${advice.reason}. ` +
        `Use /slice <next intent>${advice.enforce ? " or /slice-defer once" : " when ready"}.`,
      "warning",
    );
  }

  mutationBlocked(): boolean {
    return this.hardBoundary;
  }

  deferHardBoundary(): boolean {
    if (!this.hardBoundary || this.hardBoundaryDeferred || this.hardBoundaryDeferUsed) return false;
    this.hardBoundary = false;
    this.hardBoundaryDeferred = true;
    this.hardBoundaryDeferUsed = true;
    return true;
  }

  async slice(intent: string, ctx: ExtensionCommandContext): Promise<void> {
    if (this.binding === undefined || this.sessionId !== sessionIdOf(ctx)) {
      await this.onSessionStart(ctx);
    }
    const binding = this.binding;
    if (binding === undefined) throw new Error("task binding unavailable");
    const normalizedIntent = intent.trim();
    if (normalizedIntent === "") {
      ctx.ui.notify("usage: /slice <next slice intent>", "error");
      return;
    }
    const task = await this.runtime.taskIngress.read(binding.taskId);
    if (!task.ok) {
      ctx.ui.notify(task.error.message, "error");
      return;
    }
    const todos = await this.runtime.store.loadTaskTodos(binding.taskId);
    const workspaceSnapshot = await this.snapshotOf(ctx.cwd);
    const sourceSessionId = sessionIdOf(ctx);
    const capsuleId = createHash("sha256")
      .update(`${binding.taskId}\0${binding.taskRevision}\0${sourceSessionId}\0${normalizedIntent}`)
      .digest("hex")
      .slice(0, 32);
    const existing = await this.runtime.store.loadCapsule(binding.taskId, capsuleId);
    if (existing.ok) {
      await this.startFreshSession(existing.value, ctx);
      return;
    }
    if (existing.error.code !== "store/state-missing") {
      ctx.ui.notify(existing.error.message, "error");
      return;
    }
    const changedFiles = await this.filesTouchedOf(ctx.cwd);
    const filesTouched = changedFiles.slice(0, MAX_CAPSULE_FILES_TOUCHED);
    const filesTouchedOmitted = Math.max(0, changedFiles.length - filesTouched.length);
    const verificationRefs = this.runtime.store.loadTaskVerificationRefs(binding.taskId);
    const openQuestions = todos.ok
      ? todos.value.items.filter((item) => item.status !== "completed").map((item) => item.content)
      : [];
    const taskTitleSource = task.value.title;
    const taskTitleSourceRef = {
      kind: "file" as const,
      id: `${binding.taskId}/task.json#title`,
      locator: `tasks/${binding.taskId}/task.json#title`,
      sourceDigest: createHash("sha256").update(taskTitleSource).digest("hex"),
    };
    const sealer = new CapsuleSealer({
      resolve: async (source) => source.id === taskTitleSourceRef.id
        ? ok({ content: taskTitleSource })
        : err("store/source-missing", `Capsule source is unavailable: ${source.kind}:${source.id}`),
    });
    const sealed = await sealer.seal(createCapsule({
      taskId: binding.taskId,
      taskRevision: binding.taskRevision,
      workspaceSnapshot,
      verificationRefs: verificationRefs.ok ? verificationRefs.value : [],
      intent: normalizedIntent,
      verbatimFacts: [{
        text: taskTitleSource,
        source: taskTitleSourceRef,
      }],
      decisions: [],
      filesTouched,
      ...(filesTouchedOmitted === 0 ? {} : { filesTouchedOmitted }),
      openQuestions,
      nextSteps: [normalizedIntent],
      narrative: "Fresh context continuation created explicitly by the user.",
    }, capsuleId));
    if (!sealed.ok) {
      ctx.ui.notify(sealed.error.message, "error");
      return;
    }
    const saved = await this.runtime.store.saveCapsule(sealed.value);
    if (!saved.ok) {
      ctx.ui.notify(saved.error.message, "error");
      return;
    }
    await new ContextLedger(this.runtime.store).record({
      sessionId: sourceSessionId,
      sessionRevision: `task:${binding.taskRevision}`,
      layer: "capsule",
      action: "sealed",
      sourceDigest: sealed.value.digest ?? createHash("sha256").update(JSON.stringify(sealed.value)).digest("hex"),
      artifactRef: `tasks/${binding.taskId}/capsules/${sealed.value.capsuleId}.json`,
      requestOnly: false,
      ...(sealed.value.supersedes === undefined ? {} : { supersedes: sealed.value.supersedes }),
    });
    await this.startFreshSession(sealed.value, ctx);
  }

  private async startFreshSession(capsule: TaskCapsule, ctx: ExtensionCommandContext): Promise<void> {
    const binding: TaskBinding = { taskId: capsule.taskId, taskRevision: capsule.taskRevision };
    const injectable = this.runtime.devloop.canInjectCapsule(capsule, {
      ...binding,
      workspace: await this.snapshotOf(ctx.cwd),
    });
    if (!injectable.ok) {
      ctx.ui.notify(`Capsule injection refused: ${injectable.error.message}`, "error");
      return;
    }
    const result = await ctx.newSession({
      setup: async (sessionManager) => {
        sessionManager.appendCustomEntry(TASK_BINDING_ENTRY_TYPE, binding);
        sessionManager.appendCustomEntry(TASK_CAPSULE_MESSAGE_TYPE, capsule);
      },
      withSession: async (replacementCtx) => {
        this.binding = binding;
        this.sessionId = sessionIdOf(replacementCtx);
        await replacementCtx.sendMessage({
          customType: TASK_CAPSULE_MESSAGE_TYPE,
          content: renderCapsule(capsule),
          display: true,
          details: { capsuleId: capsule.capsuleId },
        }, { triggerTurn: false });
        PiSessionLifecycle.persistSeed(replacementCtx.sessionManager);
        replacementCtx.ui.notify("Fresh Slice session is ready; submit your next instruction when ready.", "info");
      },
    });
    if (result.cancelled) ctx.ui.notify("Slice session creation cancelled", "info");
  }
}
