import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { ControlEvent, SessionIdentity } from "../control/index.ts";
import { RpcControlDriver, type DriverOptions } from "../control/rpc-driver.ts";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

function event(kind: string, payload: unknown): ControlEvent {
  return { version: 1, kind, payload };
}

/**
 * Control adapter for `/server` inside the Pi TUI.
 *
 * Read-only projections still use RpcControlDriver, but model turns, session
 * switching, cancellation, steering, model choice and thinking level are
 * executed by the already-running Pi authority. No second Pi process may
 * write the active Chat.
 */
export class TuiControlDriver extends RpcControlDriver {
  private context: ExtensionCommandContext;
  private readonly tuiRuns = new Map<string, string>();
  private readonly tuiCancelledRuns = new Set<string>();

  constructor(
    options: DriverOptions,
    private readonly pi: ExtensionAPI,
    context: ExtensionCommandContext,
  ) {
    super(options);
    this.context = context;
  }

  private identity(): SessionIdentity {
    const sessionFile = this.context.sessionManager.getSessionFile();
    return {
      sessionId: this.context.sessionManager.getSessionId(),
      ...(sessionFile === undefined ? {} : { sessionFile }),
    };
  }

  private assertCurrent(session?: string): void {
    if (session === undefined) return;
    const identity = this.identity();
    if (session !== identity.sessionId && session !== identity.sessionFile) {
      throw new Error(`session ${session} is not the active Pi TUI session`);
    }
  }

  private adopt(next: ExtensionCommandContext): void {
    this.context = next;
  }

  override async *run(input: Parameters<RpcControlDriver["run"]>[0]): AsyncIterable<ControlEvent> {
    const runId = randomUUID();
    try {
      this.assertCurrent(input.session);
      if (input.cwd !== undefined && resolve(input.cwd) !== resolve(this.context.cwd)) {
        throw new Error("remote run cwd must equal the PC-authorized active workspace");
      }
      if (input.harnessTier !== undefined || input.permissionTier !== undefined) {
        throw new Error("remote devices cannot change Harness or permission policy through run.start");
      }
      if (!this.context.isIdle()) throw new Error("the active Pi TUI turn is already running; use confirmed steering");
      if (input.provider !== undefined || input.model !== undefined) {
        if (input.provider === undefined || input.model === undefined) {
          throw new Error("provider and model must be selected together");
        }
        await this.setSessionModel(this.identity().sessionId, input.provider, input.model);
      }
      const identity = this.identity();
      this.tuiRuns.set(runId, identity.sessionId);
      yield event("run.started", { runId, executionEpoch: 1, ...identity });
      const content = input.images === undefined || input.images.length === 0
        ? input.prompt
        : [
          { type: "text" as const, text: input.prompt },
          ...input.images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
        ];
      this.pi.sendUserMessage(content);
      await Promise.resolve();
      const completion = this.context.waitForIdle();
      if (input.timeoutMs === undefined) await completion;
      else {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            completion,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Timeout waiting for TUI run")), input.timeoutMs);
            }),
          ]);
        } catch (cause) {
          this.context.abort();
          throw cause;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      if (this.tuiCancelledRuns.has(runId)) yield event("run.cancelled", { runId });
      else yield event("run.completed", { runId, executionEpoch: 1, ...this.identity() });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      yield event(/timeout/i.test(message) ? "run.timeout" : "run.error", { runId, message });
    } finally {
      this.tuiRuns.delete(runId);
      this.tuiCancelledRuns.delete(runId);
    }
  }

  override async cancelRun(runId: string): Promise<unknown> {
    if (!this.tuiRuns.has(runId)) throw new Error(`run not found: ${runId}`);
    this.tuiCancelledRuns.add(runId);
    this.context.abort();
    return { runId, cancelled: true };
  }

  override async steerRun(runId: string, message: string): Promise<unknown> {
    if (!this.tuiRuns.has(runId)) throw new Error(`run not found: ${runId}`);
    this.pi.sendUserMessage(message, { deliverAs: "steer" });
    return { runId, steered: true };
  }

  override async createSession(input: { id?: string; cwd?: string }): Promise<SessionIdentity> {
    if (input.id !== undefined) throw new Error("the active Pi TUI chooses new Chat identifiers");
    if (input.cwd !== undefined && resolve(input.cwd) !== resolve(this.context.cwd)) {
      throw new Error("new remote Chats are limited to the PC-authorized active workspace");
    }
    const result = await this.context.newSession({ withSession: async (next) => this.adopt(next) });
    if (result.cancelled) throw new Error("new Chat was cancelled on the Host");
    return this.identity();
  }

  override async resumeSession(session: string): Promise<SessionIdentity> {
    const identity = await super.resumeSession(session);
    if (identity.sessionFile === undefined) throw new Error(`session has no persistent file: ${session}`);
    const result = await this.context.switchSession(identity.sessionFile, {
      withSession: async (next) => this.adopt(next),
    });
    if (result.cancelled) throw new Error("Chat resume was cancelled on the Host");
    return this.identity();
  }

  override switchSession(session: string): Promise<SessionIdentity> {
    return this.resumeSession(session);
  }

  override async sessionModelState(session: string): Promise<unknown> {
    this.assertCurrent(session);
    const model = this.context.model;
    return {
      model: model === undefined ? null : { provider: model.provider, id: model.id, name: model.name },
      thinkingLevel: this.pi.getThinkingLevel(),
      harnessTier: await super.harnessTier(session),
      permissionTier: await super.permissionTier(session),
      availableModels: this.context.modelRegistry.getAvailable().map((item) => ({ provider: item.provider, id: item.id })),
      availableThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
    };
  }

  override async setSessionModel(session: string, provider: string, modelId: string): Promise<unknown> {
    this.assertCurrent(session);
    const model = this.context.modelRegistry.find(provider, modelId);
    if (model === undefined) throw new Error(`model is unavailable on the Host: ${provider}/${modelId}`);
    if (!await this.pi.setModel(model)) throw new Error(`model authentication is unavailable: ${provider}/${modelId}`);
    return { model: { provider: model.provider, id: model.id, name: model.name }, thinkingLevel: this.pi.getThinkingLevel() };
  }

  override async setSessionThinking(session: string, level: ThinkingLevel): Promise<unknown> {
    this.assertCurrent(session);
    this.pi.setThinkingLevel(level);
    const model = this.context.model;
    return {
      model: model === undefined ? null : { provider: model.provider, id: model.id, name: model.name },
      thinkingLevel: this.pi.getThinkingLevel(),
    };
  }
}
