import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  autoSliceThresholdFor,
  CapsuleSealer,
  ContextLedger,
  createCapsule,
  evaluateSlice,
  fitCapsuleBudget,
  renderCapsule,
  supersedeCapsule,
  type CapsuleSemanticDraft,
} from "../devloop/index.ts";
import type { Result, TaskCapsule, WorkspaceSnapshotRef } from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";
import { createHash } from "node:crypto";
import type { HarnessTier } from "../shared/types.ts";
import type { TaskStateHeader } from "../devloop/index.ts";
import type { PicodeRuntime } from "./index.ts";
import { PiSessionLifecycle } from "../engine/pi-session-lifecycle.ts";
import { packCapsuleWithCurrentModel } from "./capsule-model-packager.ts";
import type { ContextPressureSignal } from "./context-governor.ts";

export const TASK_BINDING_ENTRY_TYPE = "picode.task-binding";
export const TASK_CAPSULE_MESSAGE_TYPE = "picode.task-capsule";
export const TASK_SLICE_LINEAGE_ENTRY_TYPE = "picode.slice-lineage";
export const MAX_CAPSULE_FILES_TOUCHED = 200;
const MAX_TASK_TITLE_LENGTH = 160;

export interface TaskBinding {
  taskId: string;
  taskRevision: number;
}

interface SliceLineage {
  relation: "slice-continuation";
  rootSessionId: string;
  parentSessionId: string;
  sliceIndex: number;
}

type SessionReplacementOptions = NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>;
type RequestNewSession = (options?: SessionReplacementOptions) => Promise<{ cancelled: boolean }>;

function sessionIdOf(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): string {
  const manager = ctx.sessionManager as { getSessionId?: () => string };
  return typeof manager.getSessionId === "function" ? manager.getSessionId() : `ephemeral:${ctx.cwd}`;
}

function taskTitleFromPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/gu, " ").trim();
  if (normalized.length <= MAX_TASK_TITLE_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_TASK_TITLE_LENGTH - 3)}...`;
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

export function restoreSliceLineage(entries: readonly unknown[]): SliceLineage | undefined {
  let lineage: SliceLineage | undefined;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (row.type !== "custom" || row.customType !== TASK_SLICE_LINEAGE_ENTRY_TYPE) continue;
    if (typeof row.data !== "object" || row.data === null) continue;
    const data = row.data as Partial<SliceLineage>;
    if (
      data.relation === "slice-continuation" &&
      typeof data.rootSessionId === "string" &&
      typeof data.parentSessionId === "string" &&
      typeof data.sliceIndex === "number"
    ) lineage = data as SliceLineage;
  }
  return lineage;
}

export class SliceSessionCoordinator {
  private binding: TaskBinding | undefined;
  private sessionId: string | undefined;
  private turnCount = 0;
  private taskTitle = "";
  private taskAcceptance: string[] = [];
  private taskTitleIsPlaceholder = false;
  private readonly advisedChannels = new Set<string>();
  private hardBoundary = false;
  private hardBoundaryDeferred = false;
  private hardBoundaryDeferUsed = false;
  private autoSliceEnabled = false;
  private autoSliceInFlight = false;
  private pendingAutoSliceUsage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  private latestContextPressure: ContextPressureSignal | undefined;
  private lineage: SliceLineage | undefined;

  constructor(
    private readonly runtime: PicodeRuntime,
    private readonly snapshotOf: (cwd: string) => Promise<WorkspaceSnapshotRef> = async (cwd) => ({ repo: cwd }),
    private readonly filesTouchedOf: (cwd: string) => Promise<string[]> = async () => [],
    private readonly packSemantics: (
      ctx: ExtensionContext,
      intent: string,
    ) => Promise<Result<CapsuleSemanticDraft>> =
      packCapsuleWithCurrentModel,
  ) {}

  currentTaskId(): string | undefined {
    return this.binding?.taskId;
  }

  currentTaskRevision(): number | undefined {
    return this.binding?.taskRevision;
  }

  observeContextPressure(signal: ContextPressureSignal): void {
    if (this.latestContextPressure === undefined || signal.tokens >= this.latestContextPressure.tokens) {
      this.latestContextPressure = signal;
    }
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

  async rebindWorkspace(workspace: string, ctx: ExtensionContext): Promise<void> {
    if (this.binding === undefined) return;
    const updated = await this.runtime.taskIngress.rebindWorkspace(this.binding.taskId, workspace);
    if (!updated.ok) throw new Error(updated.error.message);
    this.binding = { taskId: updated.value.taskId, taskRevision: updated.value.revision };
    const manager = ctx.sessionManager as { appendCustomEntry?: (type: string, data: unknown) => unknown };
    manager.appendCustomEntry?.(TASK_BINDING_ENTRY_TYPE, this.binding);
  }

  async updateAcceptance(acceptance: readonly string[], ctx: ExtensionContext): Promise<void> {
    if (this.binding === undefined) return;
    const updated = await this.runtime.taskIngress.updateAcceptance(this.binding.taskId, acceptance);
    if (!updated.ok) throw new Error(updated.error.message);
    this.binding = { taskId: updated.value.taskId, taskRevision: updated.value.revision };
    this.taskAcceptance = updated.value.acceptance;
    const manager = ctx.sessionManager as { appendCustomEntry?: (type: string, data: unknown) => unknown };
    manager.appendCustomEntry?.(TASK_BINDING_ENTRY_TYPE, this.binding);
  }

  async recordRewind(ctx: ExtensionContext): Promise<void> {
    if (this.binding === undefined) return;
    const updated = await this.runtime.taskIngress.bumpRevision(this.binding.taskId);
    if (!updated.ok) throw new Error(updated.error.message);
    this.binding = { taskId: updated.value.taskId, taskRevision: updated.value.revision };
    const manager = ctx.sessionManager as { appendCustomEntry?: (type: string, data: unknown) => unknown };
    manager.appendCustomEntry?.(TASK_BINDING_ENTRY_TYPE, this.binding);
  }

  taskState(mode: HarnessTier, phase: string, requiredContextRefs: string[]): TaskStateHeader | undefined {
    if (this.binding === undefined) return undefined;
    return {
      taskId: this.binding.taskId,
      revision: this.binding.taskRevision,
      mode,
      ...(this.sessionId === undefined ? {} : { sliceId: this.sessionId }),
      goal: this.taskTitle === "" ? this.binding.taskId : this.taskTitle,
      acceptance: this.taskAcceptance,
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
    this.autoSliceInFlight = false;
    this.pendingAutoSliceUsage = undefined;
    this.latestContextPressure = undefined;
    this.lineage = restoreSliceLineage(ctx.sessionManager.getBranch());
    const restored = restoreTaskBinding(ctx.sessionManager.getBranch());
    if (restored !== undefined) {
      this.binding = restored;
      this.sessionId = sessionIdOf(ctx);
      const task = await this.runtime.taskIngress.read(restored.taskId);
      this.taskTitle = task.ok ? task.value.title : restored.taskId;
      this.taskAcceptance = task.ok ? task.value.acceptance : [];
      this.taskTitleIsPlaceholder = !task.ok || task.value.title === task.value.externalId;
      if (task.ok) {
        this.binding = { taskId: restored.taskId, taskRevision: task.value.revision };
        this.autoSliceEnabled = task.value.autoSlice === "enabled";
        await this.offerAutoSlice(ctx, task.value.autoSlice);
      }
      return;
    }
    const manager = ctx.sessionManager as { getSessionName?: () => string | undefined };
    const sessionName = manager.getSessionName?.()?.trim();
    const title = sessionName === undefined || sessionName === "" ? sessionIdOf(ctx) : sessionName;
    const accepted = await this.runtime.taskIngress.accept({
      source: "pi-session",
      externalId: sessionIdOf(ctx),
      title,
      harnessTier: this.runtime.harness.current(),
      workspace: ctx.cwd,
    });
    if (!accepted.ok) throw new Error(accepted.error.message);
    const task = await this.runtime.taskIngress.read(accepted.value.taskId);
    this.binding = {
      taskId: accepted.value.taskId,
      taskRevision: task.ok ? task.value.revision : 1,
    };
    const sessionManager = ctx.sessionManager as {
      appendCustomEntry?: (type: string, data: unknown) => unknown;
    };
    sessionManager.appendCustomEntry?.(TASK_BINDING_ENTRY_TYPE, this.binding);
    this.sessionId = sessionIdOf(ctx);
    this.taskTitle = title;
    this.taskAcceptance = task.ok ? task.value.acceptance : [];
    this.taskTitleIsPlaceholder = sessionName === undefined || sessionName === "";
    this.autoSliceEnabled = task.ok && task.value.autoSlice === "enabled";
    if (task.ok) await this.offerAutoSlice(ctx, task.value.autoSlice);
  }

  async adoptUserIntent(prompt: string, ctx: ExtensionContext): Promise<void> {
    if (this.binding === undefined || !this.taskTitleIsPlaceholder) return;
    const title = taskTitleFromPrompt(prompt);
    if (title === "") return;
    const updated = await this.runtime.taskIngress.updateTitle(this.binding.taskId, title);
    if (!updated.ok) {
      ctx.ui.notify?.(`Task title was not updated: ${updated.error.message}`, "warning");
      return;
    }
    this.taskTitle = updated.value.title;
    this.taskTitleIsPlaceholder = false;
    this.binding = { taskId: updated.value.taskId, taskRevision: updated.value.revision };
    const manager = ctx.sessionManager as { appendCustomEntry?: (type: string, data: unknown) => unknown };
    manager.appendCustomEntry?.(TASK_BINDING_ENTRY_TYPE, this.binding);
  }

  private async offerAutoSlice(
    ctx: ExtensionContext,
    state: "unset" | "enabled" | "disabled",
  ): Promise<void> {
    if (state !== "unset" || this.runtime.harness.current() === "simple" || ctx.mode !== "tui") return;
    if (typeof ctx.ui.confirm !== "function" || this.binding === undefined) return;
    const enabled = await ctx.ui.confirm(
      "Enable experimental Auto Slice?",
      "Auto Slice replaces Pi compaction at a conservative context threshold, keeps the full parent session locally, and continues in a child session. Pi compaction remains the fallback.",
    );
    const updated = await this.runtime.taskIngress.setAutoSlice(this.binding.taskId, enabled);
    if (!updated.ok) {
      ctx.ui.notify?.(`Auto Slice preference was not saved: ${updated.error.message}`, "warning");
      return;
    }
    this.autoSliceEnabled = enabled;
    ctx.ui.notify?.(
      enabled
        ? "Experimental Auto Slice enabled for this Task."
        : "Auto Slice disabled; Pi compaction remains unchanged.",
      "info",
    );
  }

  async configureAutoSlice(value: "on" | "off" | "status", ctx: ExtensionContext): Promise<void> {
    if (this.binding === undefined) await this.onSessionStart(ctx);
    if (this.binding === undefined) throw new Error("task binding unavailable");
    if (value === "status") {
      ctx.ui.notify?.(`Auto Slice: ${this.autoSliceEnabled ? "on (experimental)" : "off"}`, "info");
      return;
    }
    const enabled = value === "on";
    const updated = await this.runtime.taskIngress.setAutoSlice(this.binding.taskId, enabled);
    if (!updated.ok) throw new Error(updated.error.message);
    this.autoSliceEnabled = enabled;
    ctx.ui.notify?.(
      enabled ? "Auto Slice enabled for this Task (experimental)." : "Auto Slice disabled for this Task.",
      "info",
    );
  }

  async observeTurn(ctx: ExtensionContext): Promise<void> {
    this.turnCount += 1;
    const measuredPressure = this.latestContextPressure;
    this.latestContextPressure = undefined;
    if (this.runtime.harness.current() === "simple") return;
    const usage = measuredPressure === undefined
      ? ctx.getContextUsage?.()
      : {
          tokens: measuredPressure.tokens,
          contextWindow: measuredPressure.reliableContextCeiling,
          percent: measuredPressure.percent,
        };
    const ratio = typeof usage?.percent === "number" ? usage.percent / 100 : 0;
    if (this.autoSliceEnabled) {
      const threshold = autoSliceThresholdFor(usage?.contextWindow ?? ctx.model?.contextWindow ?? 0);
      if (ratio < threshold || this.autoSliceInFlight) return;
      if (usage !== undefined) this.pendingAutoSliceUsage = usage;
      return;
    }
    const advice = evaluateSlice({
      userRequested: false,
      contextUsageRatio: ratio,
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

  async onAgentEnd(ctx: ExtensionContext): Promise<void> {
    const usage = this.pendingAutoSliceUsage;
    if (usage === undefined || this.autoSliceInFlight || !this.autoSliceEnabled) return;
    this.pendingAutoSliceUsage = undefined;
    await this.runAutomaticSlice(ctx, usage);
  }

  private async runAutomaticSlice(
    ctx: ExtensionContext,
    usage: { tokens: number | null; contextWindow: number; percent: number | null },
  ): Promise<void> {
    this.autoSliceInFlight = true;
    try {
      const requestNewSession = (ctx as ExtensionContext & { requestNewSession?: RequestNewSession }).requestNewSession;
      if (requestNewSession === undefined) {
        this.fallbackToPiCompaction(ctx, "automatic session continuation is unavailable in this Pi build");
        return;
      }
      const task = this.binding === undefined ? undefined : await this.runtime.taskIngress.read(this.binding.taskId);
      const baseIntent = task?.ok === true ? `Continue the current task: ${task.value.title}` : "Continue the current task";
      const prepared = await this.prepareCapsule(baseIntent, ctx, {
        automatic: true,
        sourceUsage: usage,
      });
      if (!prepared.ok) {
        this.fallbackToPiCompaction(ctx, prepared.error.message);
        return;
      }
      const switched = await this.startFreshSession(prepared.value, ctx, {
        replace: requestNewSession.bind(ctx),
        autoContinue: true,
      });
      if (!switched) this.fallbackToPiCompaction(ctx, "automatic child session creation was cancelled");
    } catch (cause) {
      this.fallbackToPiCompaction(
        ctx,
        cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      this.autoSliceInFlight = false;
    }
  }

  private fallbackToPiCompaction(ctx: ExtensionContext, reason: string): void {
    ctx.ui.notify?.(`Auto Slice could not complete (${reason}); falling back to Pi compaction.`, "warning");
    try {
      ctx.compact({
        customInstructions: "Preserve the current task goal, exact acceptance criteria, decisions, failed approaches, todos, changed files, and verification state.",
        onError: (cause) => ctx.ui.notify?.(`Pi compaction fallback failed: ${cause.message}`, "error"),
      });
    } catch (cause) {
      ctx.ui.notify?.(
        `Pi compaction fallback could not start: ${cause instanceof Error ? cause.message : String(cause)}`,
        "error",
      );
    }
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

  shouldCancelAutomaticPiCompaction(reason: "manual" | "threshold" | "overflow"): boolean {
    return this.autoSliceEnabled && reason === "threshold";
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
    const sourceSessionId = sessionIdOf(ctx);
    const capsuleId = createHash("sha256")
      .update(`${binding.taskId}\0${binding.taskRevision}\0${sourceSessionId}\0${normalizedIntent}`)
      .digest("hex")
      .slice(0, 32);
    const existing = await this.runtime.store.loadCapsule(binding.taskId, capsuleId);
    if (existing.ok) {
      await this.startFreshSession(existing.value, ctx, {
        replace: ctx.newSession.bind(ctx),
        autoContinue: false,
      });
      return;
    }
    if (existing.error.code !== "store/state-missing") {
      ctx.ui.notify(existing.error.message, "error");
      return;
    }
    const prepared = await this.prepareCapsule(normalizedIntent, ctx, { automatic: false, capsuleId });
    if (!prepared.ok) {
      ctx.ui.notify(prepared.error.message, "error");
      return;
    }
    await this.startFreshSession(prepared.value, ctx, {
      replace: ctx.newSession.bind(ctx),
      autoContinue: false,
    });
  }

  private async prepareCapsule(
    requestedIntent: string,
    ctx: ExtensionContext,
    options: {
      automatic: boolean;
      capsuleId?: string;
      sourceUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
    },
  ): Promise<Result<TaskCapsule>> {
    const binding = this.binding;
    if (binding === undefined) return err("devloop/task-binding-missing", "task binding unavailable");
    const task = await this.runtime.taskIngress.read(binding.taskId);
    if (!task.ok) return task;
    this.binding = { taskId: task.value.taskId, taskRevision: task.value.revision };
    this.taskAcceptance = task.value.acceptance;
    let workspaceSnapshot: WorkspaceSnapshotRef;
    try {
      workspaceSnapshot = await this.snapshotOf(ctx.cwd);
    } catch (cause) {
      workspaceSnapshot = { repo: ctx.cwd };
    }
    const skippedChecks: string[] = [];
    if (workspaceSnapshot.head === undefined) skippedChecks.push("Git HEAD unavailable");
    if (workspaceSnapshot.contentDigest === undefined) skippedChecks.push("workspace content digest unavailable");
    const workspaceIdentity = skippedChecks.length === 0 ? "verified" as const : "degraded" as const;
    if (options.automatic && workspaceIdentity === "degraded") {
      return err(
        "devloop/capsule-workspace-identity-degraded",
        `workspace identity is degraded: ${skippedChecks.join(", ")}`,
      );
    }
    const sourceSessionId = sessionIdOf(ctx);
    const lineage: SliceLineage = {
      relation: "slice-continuation",
      rootSessionId: this.lineage?.rootSessionId ?? sourceSessionId,
      parentSessionId: sourceSessionId,
      sliceIndex: (this.lineage?.sliceIndex ?? 0) + 1,
    };
    const capsuleId = options.capsuleId ?? createHash("sha256")
      .update(`${binding.taskId}\0${task.value.revision}\0${sourceSessionId}\0auto\0${lineage.sliceIndex}`)
      .digest("hex")
      .slice(0, 32);
    const existing = await this.runtime.store.loadCapsule(binding.taskId, capsuleId);
    if (existing.ok) return ok(existing.value);
    if (existing.error.code !== "store/state-missing") return existing;
    const semantic = await this.packSemantics(ctx, requestedIntent);
    if (!semantic.ok) return semantic;
    const normalizedIntent = options.automatic
      ? semantic.value.nextSteps[0] ?? requestedIntent
      : requestedIntent;
    const todos = await this.runtime.store.loadTaskTodos(binding.taskId);
    const todoItems = todos.ok ? todos.value.items : [];
    const openQuestions = todoItems
      .filter((item) => item.status !== "completed")
      .map((item) => item.content);
    const changedFiles = await this.filesTouchedOf(ctx.cwd);
    const filesTouched = changedFiles.slice(0, MAX_CAPSULE_FILES_TOUCHED);
    const filesTouchedOmitted = Math.max(0, changedFiles.length - filesTouched.length);
    const verificationRefs = this.runtime.store.loadTaskVerificationRefs(binding.taskId);
    const taskSource = [task.value.title, ...task.value.acceptance].join("\n");
    const taskTitleSourceRef = {
      kind: "file" as const,
      id: `${binding.taskId}/task.json#title`,
      locator: `tasks/${binding.taskId}/task.json`,
      sourceDigest: createHash("sha256").update(taskSource).digest("hex"),
    };
    const sealer = new CapsuleSealer({
      resolve: async (source) => source.id === taskTitleSourceRef.id
        ? ok({ content: taskSource })
        : err("store/source-missing", `Capsule source is unavailable: ${source.kind}:${source.id}`),
    });
    const predecessor = await this.runtime.store.loadLatestSealedCapsule(binding.taskId);
    const draft = createCapsule({
      taskId: binding.taskId,
      taskRevision: task.value.revision,
      workspaceSnapshot,
      verificationRefs: verificationRefs.ok ? verificationRefs.value : [],
      intent: normalizedIntent,
      verbatimFacts: [task.value.title, ...task.value.acceptance].map((text) => ({
        text,
        source: taskTitleSourceRef,
      })),
      decisions: semantic.value.decisions,
      filesTouched,
      ...(filesTouchedOmitted === 0 ? {} : { filesTouchedOmitted }),
      openQuestions,
      nextSteps: semantic.value.nextSteps.length === 0 ? [normalizedIntent] : semantic.value.nextSteps,
      narrative: semantic.value.narrative,
      acceptance: task.value.acceptance,
      failedApproaches: semantic.value.failedApproaches,
      taskState: {
        harnessTier: task.value.harnessTier,
        phase: "handoff",
        todos: openQuestions,
      },
      sourceSession: {
        sessionId: sourceSessionId,
        ...(ctx.model === undefined ? {} : { model: `${ctx.model.provider}/${ctx.model.id}` }),
        ...(ctx.thinkingLevel === undefined ? {} : { thinking: ctx.thinkingLevel }),
      },
      lineage: {
        ...lineage,
        ...(typeof options.sourceUsage?.tokens === "number"
          ? { sourceContextTokens: options.sourceUsage.tokens }
          : {}),
        ...(typeof options.sourceUsage?.contextWindow === "number"
          ? { sourceContextWindow: options.sourceUsage.contextWindow }
          : {}),
      },
      integrity: { workspaceIdentity, skippedChecks },
      ...(predecessor.ok && predecessor.value !== undefined && predecessor.value.taskRevision === task.value.revision
        ? { supersedes: predecessor.value.capsuleId }
        : {}),
    }, capsuleId);
    const fitted = fitCapsuleBudget(draft);
    if (!fitted.ok) return fitted;
    const packed = {
      ...fitted.value.capsule,
      packing: { method: "current-session-model" as const, estimatedTokens: fitted.value.estimatedTokens },
    };
    const sealed = await sealer.seal(packed);
    if (!sealed.ok) {
      return sealed;
    }
    const saved = await this.runtime.store.saveCapsule(sealed.value);
    if (!saved.ok) return saved;
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
    return ok(sealed.value);
  }

  private async startFreshSession(
    capsule: TaskCapsule,
    ctx: ExtensionContext,
    options: {
      replace: (options?: SessionReplacementOptions) => Promise<{ cancelled: boolean }>;
      autoContinue: boolean;
    },
  ): Promise<boolean> {
    const binding: TaskBinding = { taskId: capsule.taskId, taskRevision: capsule.taskRevision };
    const injectable = this.runtime.devloop.canInjectCapsule(capsule, {
      ...binding,
      workspace: await this.snapshotOf(ctx.cwd),
    });
    if (!injectable.ok) {
      ctx.ui.notify(`Capsule injection refused: ${injectable.error.message}`, "error");
      return false;
    }
    if (options.autoContinue && capsule.integrity?.workspaceIdentity !== "verified") {
      ctx.ui.notify("Automatic Capsule injection refused because workspace identity is degraded.", "error");
      return false;
    }
    const sourceManager = ctx.sessionManager as { getSessionFile?: () => string | undefined };
    const parentSession = sourceManager.getSessionFile?.();
    const result = await options.replace({
      ...(parentSession === undefined ? {} : { parentSession }),
      setup: async (sessionManager) => {
        sessionManager.appendCustomEntry(TASK_BINDING_ENTRY_TYPE, binding);
        sessionManager.appendCustomEntry(TASK_CAPSULE_MESSAGE_TYPE, capsule);
        if (capsule.lineage !== undefined) {
          sessionManager.appendCustomEntry(TASK_SLICE_LINEAGE_ENTRY_TYPE, capsule.lineage);
        }
      },
      withSession: async (replacementCtx) => {
        this.binding = binding;
        this.sessionId = sessionIdOf(replacementCtx);
        this.lineage = capsule.lineage;
        await replacementCtx.sendMessage({
          customType: TASK_CAPSULE_MESSAGE_TYPE,
          content: renderCapsule(capsule),
          display: true,
          details: { capsuleId: capsule.capsuleId },
        }, { triggerTurn: options.autoContinue });
        PiSessionLifecycle.persistSeed(replacementCtx.sessionManager);
        replacementCtx.ui.notify(
          options.autoContinue
            ? `Auto Slice continued ${capsule.lineage?.parentSessionId ?? "the parent session"} → ${this.sessionId}.`
            : `Fresh Slice session is ready (${capsule.lineage?.parentSessionId ?? "parent"} → ${this.sessionId}); submit your next instruction when ready.`,
          "info",
        );
      },
    });
    if (result.cancelled) {
      ctx.ui.notify("Slice session creation cancelled", "info");
      return false;
    }
    if (capsule.supersedes !== undefined) {
      const previous = await this.runtime.store.loadCapsule(capsule.taskId, capsule.supersedes);
      if (previous.ok && previous.value.status === "sealed") {
        const superseded = supersedeCapsule(previous.value, capsule.capsuleId);
        if (superseded.ok) await this.runtime.store.saveCapsule(superseded.value);
      }
    }
    return true;
  }
}
