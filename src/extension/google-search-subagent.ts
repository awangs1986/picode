import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  SUBAGENT_DELEGATION_CANCEL_EVENT,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  type SubagentDelegationResponse,
} from "pi-subagents/delegation";
import {
  buildResearcherTask,
  buildGroundingQuery,
  buildResearchPacket,
  RESEARCH_SYNTHESIS_SCHEMA,
  renderResearchPacket,
  validateResearchBriefs,
  validateResearchSynthesis,
  type GroundedSearchEvidence,
  type ResearchBranchPacket,
  type ResearchBrief,
  type ResearchPacket,
} from "../devloop/index.ts";
import { atomicWriteFile } from "../shared/fs.ts";
import type { ActiveCapabilityLease, Result } from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";
import type { PicodeConfig } from "../store/config.ts";
import type { PicodeRuntime } from "./index.ts";
import { requestActivate } from "./index.ts";
import type { PiActiveToolAdapter } from "./pi-tool-adapter.ts";
import {
  GOOGLE_SEARCH_SUBAGENT_CAPABILITY_ID,
  GOOGLE_SEARCH_SUBAGENT_TOOL_NAME,
} from "./google-search-manifest.ts";
import {
  PiWebGoogleSearchBackend,
  type GoogleSearchBackend,
} from "./google-search-provider.ts";

const NORMAL_SEARCH_TOOL = "web_search";
const ARTIFACT_DIRECTORY = join(".pi-subagents", "artifacts", "google-search");

type ThinkingLevel = PicodeConfig["googleSearchSubagent"]["thinking"];

export interface GoogleSearchSubagentDependencies {
  runtime: PicodeRuntime;
  toolAdapter: PiActiveToolAdapter;
  persistCapabilities(): Promise<Result<void>>;
  persistConfig(config: PicodeConfig): Promise<Result<void>>;
  ensureDelegationAvailable(parallelism: number): Promise<Result<void>>;
  backend?: GoogleSearchBackend;
  now?: () => Date;
  id?: () => string;
}

interface DelegatedSynthesis {
  value: unknown;
  runId?: string;
  model?: string;
  durationMs?: number;
  tokenUsage?: number;
  cost?: number;
}

interface RecentPlan {
  planId: string;
  branches: number;
  completedAt: string;
  actualProviders: string[];
  fallbackCount: number;
  artifactPath: string;
  queryCount: number;
  durationMs: number;
  tokenUsage: number;
  cost: number;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function googleAccount(account: { provider: string; piProvider?: string }): boolean {
  return account.provider === "google" || account.piProvider === "google";
}

function combineSignals(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent === undefined ? timeout : AbortSignal.any([parent, timeout]);
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item !== undefined) results[index] = await worker(item, index);
    }
  });
  await Promise.all(runners);
  return results;
}

function delegationError(response: SubagentDelegationResponse): string {
  return response.error ?? `researcher ended as ${response.status}`;
}

async function delegateSynthesis(input: {
  pi: ExtensionAPI;
  requestId: string;
  ownerRunId: string;
  nodeId: string;
  cwd: string;
  model: string;
  thinking: ThinkingLevel;
  timeoutMs: number;
  task: string;
  signal: AbortSignal;
}): Promise<DelegatedSynthesis> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (outcome: { value: DelegatedSynthesis } | { error: Error }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      input.signal.removeEventListener("abort", onAbort);
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.value);
    };
    const unsubscribe = input.pi.events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (raw) => {
      const response = raw as SubagentDelegationResponse;
      if (response.requestId !== input.requestId) return;
      if ((response.status !== "completed" && response.status !== "failed") ||
        response.result?.kind !== "structured") {
        finish({ error: new Error(delegationError(response)) });
        return;
      }
      finish({
        value: {
          value: response.result.value,
          ...(response.runId === undefined ? {} : { runId: response.runId }),
          ...(response.model === undefined ? {} : { model: response.model }),
          ...(response.usage === undefined
            ? {}
            : {
                durationMs: response.usage.durationMs,
                tokenUsage: response.usage.input + response.usage.output,
                cost: response.usage.cost,
              }),
        },
      });
    });
    const onAbort = (): void => {
      input.pi.events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, {
        requestId: input.requestId,
        ownerRunId: input.ownerRunId,
        nodeId: input.nodeId,
      });
      finish({ error: new Error("Google Search Subagent cancelled") });
    };
    const timer = setTimeout(() => onAbort(), input.timeoutMs);
    input.signal.addEventListener("abort", onAbort, { once: true });
    input.pi.events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, {
      requestId: input.requestId,
      ownerRunId: input.ownerRunId,
      nodeId: input.nodeId,
      agent: "researcher",
      task: input.task,
      context: "fresh",
      cwd: input.cwd,
      model: input.model,
      thinking: input.thinking,
      timeoutMs: input.timeoutMs,
      turnBudget: { maxTurns: 4, graceTurns: 1 },
      // Grounding was performed by the trusted Adapter. The child only
      // synthesizes supplied evidence and must have no side-effect surface.
      toolBudget: { hard: 0, block: "*" },
      skill: false,
      artifacts: true,
      result: { kind: "structured", schema: RESEARCH_SYNTHESIS_SCHEMA },
    });
  });
}

export class GoogleSearchSubagentController {
  private readonly backend: GoogleSearchBackend;
  private readonly now: () => Date;
  private readonly id: () => string;
  private activeLease: ActiveCapabilityLease | undefined;
  private activeSessionId: string | undefined;
  private readonly activePlans = new Map<string, AbortController>();
  private recentPlan: RecentPlan | undefined;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly deps: GoogleSearchSubagentDependencies,
  ) {
    this.backend = deps.backend ?? new PiWebGoogleSearchBackend();
    this.now = deps.now ?? (() => new Date());
    this.id = deps.id ?? randomUUID;
  }

  register(): void {
    this.pi.registerTool({
      name: GOOGLE_SEARCH_SUBAGENT_TOOL_NAME,
      label: "Google Search Subagent",
      description:
        "Run 1-10 isolated Google-grounded research branches, then return a compact cited ResearchPacket. " +
        "Use this instead of web_search while the optional capability is enabled.",
      promptSnippet: "Use google_search_subagent for cited web research when this optional capability is active.",
      executionMode: "parallel",
      parameters: Type.Object({
        briefs: Type.Array(Type.Object({
          id: Type.String({ minLength: 1, maxLength: 80 }),
          question: Type.String({ minLength: 1, maxLength: 8_000 }),
          locale: Type.Optional(Type.String({ maxLength: 40 })),
          constraints: Type.Optional(Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: 30 })),
        }), { minItems: 1, maxItems: 10 }),
      }),
      execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
        try {
          const packet = await this.runPlan(params.briefs, ctx, signal);
          return {
            content: [{ type: "text", text: renderResearchPacket(packet) }],
            details: packet,
          };
        } catch (cause) {
          return {
            content: [{ type: "text", text: `Google Search Subagent failed: ${errorText(cause)}` }],
            details: { error: errorText(cause) },
            isError: true,
          };
        }
      },
    });
    this.deps.toolAdapter.bind(GOOGLE_SEARCH_SUBAGENT_CAPABILITY_ID, [
      GOOGLE_SEARCH_SUBAGENT_TOOL_NAME,
    ]);
    // Pi forbids action methods during extension loading. The tier
    // reconciliation and syncSession lifecycle hooks hide this tool before
    // the first model turn while preserving a loadable extension entry.
    this.pi.registerCommand("pico-webagent", {
      description: "Configure the optional Google Search Subagent",
      handler: (args, ctx) => this.handleCommand(args, ctx),
    });
  }

  async syncSession(ctx: ExtensionContext): Promise<Result<void>> {
    const enabled = this.deps.runtime.guard.catalog.get(GOOGLE_SEARCH_SUBAGENT_CAPABILITY_ID)
      ?.setting === "trusted";
    if (!enabled) {
      await this.deactivate();
      this.replaceSearchEntry(false);
      return ok(undefined);
    }
    const configured = this.configured();
    if (!configured.ok) {
      await this.deactivate();
      this.replaceSearchEntry(false);
      ctx.ui.notify(`Google Search Subagent is enabled but needs setup: ${configured.error.message}`, "warning");
      return configured;
    }
    if (this.activeLease !== undefined && this.activeSessionId !== ctx.sessionManager.getSessionId()) {
      await this.deactivate();
    }
    const delegation = await this.deps.ensureDelegationAvailable(
      this.deps.runtime.config.googleSearchSubagent.parallelism,
    );
    if (!delegation.ok) {
      await this.deactivate();
      this.replaceSearchEntry(false);
      ctx.ui.notify(delegation.error.message, "error");
      return delegation;
    }
    if (this.activeLease === undefined) {
      const activated = await requestActivate(this.deps.runtime, GOOGLE_SEARCH_SUBAGENT_CAPABILITY_ID, {
        sessionId: ctx.sessionManager.getSessionId(),
        harnessTier: this.deps.runtime.harness.current(),
        currentTurn: 0,
      });
      if (!activated.ok) {
        this.replaceSearchEntry(false);
        ctx.ui.notify(activated.error.message, "error");
        return activated;
      }
      this.activeLease = activated.value;
      this.activeSessionId = ctx.sessionManager.getSessionId();
    }
    this.replaceSearchEntry(true);
    return ok(undefined);
  }

  async shutdown(): Promise<void> {
    for (const controller of this.activePlans.values()) controller.abort();
    this.activePlans.clear();
    await this.deactivate();
  }

  private configured(): Result<{ accountId: string; accountLabel: string; model: string }> {
    const options = this.deps.runtime.config.googleSearchSubagent;
    if (options.accountId === undefined || options.model === undefined) {
      return err("webagent/not-configured", "run /pico-webagent config and choose a Google account and Gemini model");
    }
    if (!options.model.startsWith("google/")) {
      return err("webagent/model-not-google", "the selected model must be a direct google/Gemini model");
    }
    const listed = this.deps.runtime.accounts.list();
    if (!listed.ok) return listed;
    const account = listed.value.find((candidate) => candidate.id === options.accountId);
    if (account === undefined || account.status === "retired" || !googleAccount(account)) {
      return err("webagent/account-unavailable", "the selected Google account is missing or logged out");
    }
    const credentials = this.deps.runtime.accounts.credentialsFor(account.id);
    if (!credentials.ok) return credentials;
    return ok({ accountId: account.id, accountLabel: account.label, model: options.model });
  }

  private async configureFromArgs(args: string, ctx: ExtensionCommandContext): Promise<boolean> {
    const tokens = args.trim().split(/\s+/u).filter(Boolean);
    let accountId = tokens[0];
    let model = tokens[1];
    let parallelism = tokens[2] === undefined ? undefined : Number(tokens[2]);
    let thinking = tokens[3] as ThinkingLevel | undefined;
    const listed = this.deps.runtime.accounts.list();
    if (!listed.ok) {
      ctx.ui.notify(listed.error.message, "error");
      return false;
    }
    const accounts = listed.value.filter((account) =>
      account.status !== "retired" && account.chatCompatible !== false && googleAccount(account)
    );
    if (accounts.length === 0) {
      ctx.ui.notify("No direct Google account is available. Run /pico-login google first.", "error");
      return false;
    }
    if (accountId === undefined) {
      const choices = accounts.map((account) => `${account.label} · ${account.id}`);
      const selected = await ctx.ui.select("Google Search account", choices);
      if (selected === undefined) return false;
      accountId = accounts[choices.indexOf(selected)]?.id;
    }
    const account = accounts.find((candidate) => candidate.id === accountId);
    if (account === undefined) {
      ctx.ui.notify(`Google account is not available: ${accountId}`, "error");
      return false;
    }
    const models = ctx.modelRegistry.getAll().filter((candidate) => candidate.provider === "google");
    if (model === undefined) {
      const choices = models.map((candidate) => `${candidate.name} · google/${candidate.id}`);
      const selected = await ctx.ui.select("Gemini model for search and research", choices);
      if (selected === undefined) return false;
      model = `google/${models[choices.indexOf(selected)]?.id ?? ""}`;
    }
    if (!models.some((candidate) => `google/${candidate.id}` === model)) {
      ctx.ui.notify(`Gemini model is not in the current Pi catalog: ${model}`, "error");
      return false;
    }
    if (parallelism === undefined) {
      const selected = await ctx.ui.select("Parallel research branches", ["1", "3 (recommended)", "5", "10"]);
      if (selected === undefined) return false;
      parallelism = Number(selected.split(" ", 1)[0]);
    }
    if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > 10) {
      ctx.ui.notify("parallelism must be an integer from 1 to 10", "error");
      return false;
    }
    if (thinking === undefined) {
      const selected = await ctx.ui.select("Researcher thinking", ["high (recommended)", "medium", "xhigh", "low"]);
      if (selected === undefined) return false;
      thinking = selected.split(" ", 1)[0] as ThinkingLevel;
    }
    if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) {
      ctx.ui.notify("invalid thinking level", "error");
      return false;
    }
    const next: PicodeConfig = {
      ...this.deps.runtime.config,
      googleSearchSubagent: {
        ...this.deps.runtime.config.googleSearchSubagent,
        accountId: account.id,
        model,
        parallelism,
        thinking,
      },
    };
    const saved = await this.deps.persistConfig(next);
    if (!saved.ok) {
      ctx.ui.notify(saved.error.message, "error");
      return false;
    }
    this.deps.runtime.config = next;
    ctx.ui.notify(`Google Search Subagent configured: ${model} · ${thinking} · parallel ${parallelism}`, "info");
    return true;
  }

  private async handleCommand(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
    const [action = "status", ...rest] = rawArgs.trim().split(/\s+/u).filter(Boolean);
    if (action === "config") {
      await this.configureFromArgs(rest.join(" "), ctx);
      return;
    }
    if (action === "on") {
      if (!this.configured().ok && !await this.configureFromArgs("", ctx)) return;
      const previous = this.deps.runtime.guard.catalog.get(GOOGLE_SEARCH_SUBAGENT_CAPABILITY_ID)?.setting ?? "disabled";
      const changed = this.deps.runtime.guard.catalog.userSetState(
        GOOGLE_SEARCH_SUBAGENT_CAPABILITY_ID,
        "trusted",
      );
      if (!changed.ok) {
        ctx.ui.notify(changed.error.message, "error");
        return;
      }
      const saved = await this.deps.persistCapabilities();
      if (!saved.ok) {
        this.deps.runtime.guard.catalog.userSetState(GOOGLE_SEARCH_SUBAGENT_CAPABILITY_ID, previous);
        ctx.ui.notify(saved.error.message, "error");
        return;
      }
      const synchronized = await this.syncSession(ctx);
      ctx.ui.notify(
        synchronized.ok
          ? "Google Search Subagent enabled globally. It replaces web_search in this session; fetch tools remain available."
          : "Google Search Subagent is enabled globally but is not running in this session; normal web_search remains active.",
        synchronized.ok ? "info" : "warning",
      );
      return;
    }
    if (action === "off") {
      const previous = this.deps.runtime.guard.catalog.get(GOOGLE_SEARCH_SUBAGENT_CAPABILITY_ID)?.setting ?? "disabled";
      const changed = this.deps.runtime.guard.catalog.userSetState(
        GOOGLE_SEARCH_SUBAGENT_CAPABILITY_ID,
        "disabled",
      );
      if (!changed.ok) {
        ctx.ui.notify(changed.error.message, "error");
        return;
      }
      const saved = await this.deps.persistCapabilities();
      if (!saved.ok) {
        this.deps.runtime.guard.catalog.userSetState(GOOGLE_SEARCH_SUBAGENT_CAPABILITY_ID, previous);
        ctx.ui.notify(saved.error.message, "error");
        return;
      }
      await this.deactivate();
      this.replaceSearchEntry(false);
      ctx.ui.notify("Google Search Subagent disabled; normal pi-web-access search restored.", "info");
      return;
    }
    if (action === "doctor") {
      const configured = this.configured();
      const state = this.deps.runtime.guard.catalog.get(GOOGLE_SEARCH_SUBAGENT_CAPABILITY_ID)?.setting ?? "missing";
      ctx.ui.notify([
        "Google Search Subagent doctor (no network query)",
        `Capability: ${state}`,
        `Configuration: ${configured.ok ? `ready · ${configured.value.model}` : configured.error.message}`,
        `Delegation package: ${this.pi.getCommands().some((command) => command.name === "subagent") ? "loaded" : "loads on activation"}`,
        "Use /pico-webagent test for a paid live Google query.",
      ].join("\n"), configured.ok ? "info" : "warning");
      return;
    }
    if (action === "test") {
      try {
        const packet = await this.runPlan([{
          id: "live-test",
          question: "What is the current UTC date? Cite an authoritative source returned by Google Search.",
        }], ctx, ctx.signal);
        ctx.ui.notify(renderResearchPacket(packet, 4_000), "info");
      } catch (cause) {
        ctx.ui.notify(`Google Search Subagent test failed: ${errorText(cause)}`, "error");
      }
      return;
    }
    if (action !== "status") {
      ctx.ui.notify("usage: /pico-webagent on|off|config|status|doctor|test", "error");
      return;
    }
    const state = this.deps.runtime.guard.catalog.get(GOOGLE_SEARCH_SUBAGENT_CAPABILITY_ID)?.setting ?? "missing";
    const config = this.deps.runtime.config.googleSearchSubagent;
    const configured = this.configured();
    const recent = this.recentPlan;
    ctx.ui.notify([
      `Google Search Subagent: ${state}`,
      `Account: ${configured.ok ? configured.value.accountLabel : "not configured"}`,
      `Model: ${config.model ?? "not configured"} · thinking ${config.thinking}`,
      `Parallelism: ${config.parallelism}/10 · timeout ${Math.round(config.timeoutMs / 60_000)}m · fallback ${config.fallback ? "on" : "off"}`,
      `Running plans: ${this.activePlans.size}`,
      ...(recent === undefined ? [] : [
        `Last plan: ${recent.planId} · ${recent.branches} branches · ${recent.actualProviders.join(", ")} · fallback ${recent.fallbackCount}`,
        `Queries: ${recent.queryCount} · latency ${recent.durationMs}ms · tokens ${recent.tokenUsage} · cost $${recent.cost.toFixed(6)}`,
        `Artifact: ${recent.artifactPath}`,
      ]),
    ].join("\n"), "info");
  }

  private async runPlan(
    rawBriefs: unknown,
    ctx: ExtensionContext,
    parentSignal: AbortSignal | undefined,
  ): Promise<ResearchPacket> {
    const capability = this.deps.runtime.guard.catalog.get(GOOGLE_SEARCH_SUBAGENT_CAPABILITY_ID);
    if (capability?.setting !== "trusted") throw new Error("capability is disabled or untrusted");
    const configured = this.configured();
    if (!configured.ok) throw new Error(configured.error.message);
    const delegation = await this.deps.ensureDelegationAvailable(
      this.deps.runtime.config.googleSearchSubagent.parallelism,
    );
    if (!delegation.ok) throw new Error(delegation.error.message);
    const credentials = this.deps.runtime.accounts.credentialsFor(configured.value.accountId);
    if (!credentials.ok) throw new Error(credentials.error.message);
    const briefs = validateResearchBriefs(rawBriefs);
    const planId = this.id();
    const controller = new AbortController();
    this.activePlans.set(planId, controller);
    const signal = parentSignal === undefined
      ? controller.signal
      : AbortSignal.any([parentSignal, controller.signal]);
    const evidenceByQuery = new Map<string, Promise<GroundedSearchEvidence>>();
    const searchEvidence = (brief: ResearchBrief): Promise<GroundedSearchEvidence> => {
      const query = buildGroundingQuery(brief);
      const key = query.toLowerCase();
      const prior = evidenceByQuery.get(key);
      if (prior !== undefined) return prior;
      const request = this.backend.ground({
        query,
        apiKey: credentials.value.accessToken,
        model: configured.value.model,
        timeoutMs: this.deps.runtime.config.googleSearchSubagent.timeoutMs,
        signal: combineSignals(signal, this.deps.runtime.config.googleSearchSubagent.timeoutMs),
        extensionContext: ctx,
        fallback: this.deps.runtime.config.googleSearchSubagent.fallback,
      });
      evidenceByQuery.set(key, request);
      return request;
    };
    try {
      const branches = await mapConcurrent(
        briefs,
        this.deps.runtime.config.googleSearchSubagent.parallelism,
        async (brief, index): Promise<ResearchBranchPacket> => {
          const evidence = await searchEvidence(brief);
          if (evidence.sources.length === 0) throw new Error(`branch ${brief.id} returned no grounded source URLs`);
          const delegated = await delegateSynthesis({
            pi: this.pi,
            requestId: this.id(),
            ownerRunId: ctx.sessionManager.getSessionId(),
            nodeId: `google-research-${planId.slice(0, 8)}-${index}`,
            cwd: ctx.cwd,
            model: configured.value.model,
            thinking: this.deps.runtime.config.googleSearchSubagent.thinking,
            timeoutMs: this.deps.runtime.config.googleSearchSubagent.timeoutMs,
            task: buildResearcherTask(brief, evidence),
            signal: combineSignals(signal, this.deps.runtime.config.googleSearchSubagent.timeoutMs),
          });
          const synthesis = validateResearchSynthesis(delegated.value, evidence);
          return {
            briefId: brief.id,
            groundingAnswer: evidence.answer,
            ...synthesis,
            sources: evidence.sources,
            queries: evidence.queries,
            actualProvider: evidence.actualProvider,
            ...(evidence.fallbackReason === undefined ? {} : { fallbackReason: evidence.fallbackReason }),
            ...(delegated.runId === undefined ? {} : { runId: delegated.runId }),
            ...(delegated.model === undefined ? {} : { model: delegated.model }),
            ...(delegated.durationMs === undefined ? {} : { durationMs: delegated.durationMs }),
            ...(delegated.tokenUsage === undefined ? {} : { tokenUsage: delegated.tokenUsage }),
            ...(delegated.cost === undefined ? {} : { cost: delegated.cost }),
          };
        },
      );
      const artifactPath = join(ctx.cwd, ARTIFACT_DIRECTORY, `${planId}.json`);
      const packet = buildResearchPacket(planId, branches, this.now().toISOString(), artifactPath);
      atomicWriteFile(artifactPath, JSON.stringify(packet, null, 2));
      this.recentPlan = {
        planId,
        branches: branches.length,
        completedAt: packet.generatedAt,
        actualProviders: packet.actualProviders,
        fallbackCount: packet.fallbackCount,
        artifactPath,
        queryCount: evidenceByQuery.size,
        durationMs: branches.reduce((maximum, branch) => Math.max(maximum, branch.durationMs ?? 0), 0),
        tokenUsage: branches.reduce((total, branch) => total + (branch.tokenUsage ?? 0), 0),
        cost: branches.reduce((total, branch) => total + (branch.cost ?? 0), 0),
      };
      return packet;
    } catch (cause) {
      controller.abort();
      throw cause;
    } finally {
      this.activePlans.delete(planId);
    }
  }

  private replaceSearchEntry(enabled: boolean): void {
    const before = this.pi.getActiveTools();
    const active = new Set(before);
    if (enabled) {
      active.delete(NORMAL_SEARCH_TOOL);
      active.add(GOOGLE_SEARCH_SUBAGENT_TOOL_NAME);
    } else {
      active.delete(GOOGLE_SEARCH_SUBAGENT_TOOL_NAME);
      if (this.pi.getAllTools().some((tool) => tool.name === NORMAL_SEARCH_TOOL)) {
        active.add(NORMAL_SEARCH_TOOL);
      }
    }
    const next = [...active];
    this.pi.setActiveTools(next);
    if (!enabled && (before.length !== next.length || before.some((name) => !active.has(name)))) {
      // ActivationManager already opens an epoch when enabling. Releasing a
      // registered lease does not, so restoring web_search must do it here.
      this.deps.runtime.cacheMeter.beginNewEpoch();
    }
  }

  private async deactivate(): Promise<void> {
    if (this.activeLease === undefined) return;
    const leaseId = this.activeLease.leaseId;
    this.activeLease = undefined;
    this.activeSessionId = undefined;
    await this.deps.runtime.engine.release(leaseId);
  }
}
