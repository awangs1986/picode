import { IlinkSessionExpiredError, type IlinkClient, type IlinkCredentials, type IlinkMessage } from "./weixin-ilink-client.ts";
import type { WeixinStateV1 } from "./weixin-state.ts";
import { WeixinStateStore } from "./weixin-state.ts";
import { WeixinTokenLease, type WeixinTokenLeaseHandle } from "./weixin-token-lease.ts";

const MAX_RECENT_MESSAGES = 256;
const MAX_WEIXIN_TEXT = 2_000;

export interface WeixinInbound {
  sessionId: string;
  senderId: string;
  text: string;
}

export interface WeixinTransportDeps {
  client: IlinkClient;
  credentials(): IlinkCredentials;
  store: WeixinStateStore;
  handleMessage(input: WeixinInbound): Promise<string>;
  transformReply?(input: { sessionId: string; text: string }): Promise<string>;
  /** Host-owned one-time pairing decision for a previously unseen sender. */
  authorizeSender?(senderId: string): Promise<boolean>;
  onError?(error: Error): void;
  onHealthy?(): void;
  retryDelayMs?: number;
}

function chunks(text: string): string[] {
  const normalized = text.trim();
  if (normalized === "") return [];
  const result: string[] = [];
  for (let offset = 0; offset < normalized.length; offset += MAX_WEIXIN_TEXT) {
    result.push(normalized.slice(offset, offset + MAX_WEIXIN_TEXT));
  }
  return result;
}

export class WeixinTransport {
  private controller: AbortController | undefined;
  private loop: Promise<void> | undefined;
  private tokenLease: WeixinTokenLeaseHandle | undefined;

  constructor(private readonly deps: WeixinTransportDeps) {}

  isRunning(): boolean {
    return this.loop !== undefined;
  }

  async start(): Promise<void> {
    if (this.loop !== undefined) return;
    const state = await this.deps.store.readOrEmpty();
    if (state.accountRefId === undefined) throw new Error("Weixin account is not connected; run /weixin login");
    if (state.boundSessionId === undefined) throw new Error("Weixin is not bound to a persisted Chat");
    const lease = new WeixinTokenLease().acquire(
      this.deps.credentials().token,
    );
    this.tokenLease = lease;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.loop = this.poll(state, signal).finally(() => {
      this.loop = undefined;
      this.controller = undefined;
      lease.release();
      if (this.tokenLease === lease) this.tokenLease = undefined;
    });
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    await this.loop;
  }

  private async poll(initial: WeixinStateV1, signal: AbortSignal): Promise<void> {
    let state = initial;
    while (!signal.aborted) {
      try {
        const credentials = this.deps.credentials();
        const update = await this.deps.client.getUpdates(credentials, state.syncBuf, signal);
        if (signal.aborted) break;
        for (const message of update.messages) {
          state = await this.process(credentials, state, message, signal);
        }
        state = { ...state, syncBuf: update.syncBuf };
        const saved = await this.deps.store.write(state);
        if (!saved.ok) throw new Error(saved.error.message);
        this.deps.onHealthy?.();
      } catch (cause) {
        if (signal.aborted) break;
        this.report(cause);
        if (cause instanceof IlinkSessionExpiredError) break;
        await this.waitForRetry(signal);
      }
    }
  }

  private async process(
    credentials: IlinkCredentials,
    state: WeixinStateV1,
    message: IlinkMessage,
    signal: AbortSignal,
  ): Promise<WeixinStateV1> {
    if (state.recentMessageIds.includes(message.messageId)) {
      return state;
    }
    let allowedUserIds = state.allowedUserIds;
    if (!allowedUserIds.includes(message.senderId)) {
      if (this.deps.authorizeSender === undefined || !await this.deps.authorizeSender(message.senderId)) {
        return state;
      }
      allowedUserIds = [...new Set([...allowedUserIds, message.senderId])];
    }
    const contextTokens = message.contextToken === undefined
      ? state.contextTokens
      : { ...state.contextTokens, [message.senderId]: message.contextToken };
    const admitted = { ...state, allowedUserIds, contextTokens };
    // Persist authorization and the reply context, but do not mark the message
    // complete until both the Pi turn and outbound delivery have succeeded.
    const admittedSave = await this.deps.store.write(admitted);
    if (!admittedSave.ok) throw new Error(admittedSave.error.message);
    const sessionId = state.boundSessionId;
    if (sessionId === undefined) return admitted;
    const fullReply = await this.retry(
      () => this.deps.handleMessage({ sessionId, senderId: message.senderId, text: message.text }),
      signal,
    );
    const transformReply = this.deps.transformReply;
    const reply = transformReply === undefined
      ? fullReply
      : await this.retry(() => transformReply({ sessionId, text: fullReply }), signal);
    const replyChunks = chunks(reply);
    for (const [index, text] of replyChunks.entries()) {
      await this.retry(() => this.deps.client.sendText(credentials, {
        peerId: message.senderId,
        text,
        clientId: `picode-weixin-${message.messageId}-${index}`,
        ...(contextTokens[message.senderId] === undefined ? {} : { contextToken: contextTokens[message.senderId] }),
      }), signal);
    }
    const completed = {
      ...admitted,
      recentMessageIds: [...state.recentMessageIds, message.messageId].slice(-MAX_RECENT_MESSAGES),
    };
    const completedSave = await this.deps.store.write(completed);
    if (!completedSave.ok) throw new Error(completedSave.error.message);
    return completed;
  }

  private async retry<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    while (!signal.aborted) {
      try {
        return await operation();
      } catch (cause) {
        if (signal.aborted) break;
        this.report(cause);
        await this.waitForRetry(signal);
      }
    }
    throw new Error("Weixin transport stopped");
  }

  private report(cause: unknown): void {
    this.deps.onError?.(cause instanceof Error ? cause : new Error(String(cause)));
  }

  private async waitForRetry(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, this.deps.retryDelayMs ?? 2_000);
      signal.addEventListener("abort", finish, { once: true });
    });
  }
}
