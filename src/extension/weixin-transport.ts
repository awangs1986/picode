import type { IlinkClient, IlinkCredentials, IlinkMessage } from "./weixin-ilink-client.ts";
import type { WeixinStateV1 } from "./weixin-state.ts";
import { WeixinStateStore } from "./weixin-state.ts";

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
  /** Host-owned one-time pairing decision for a previously unseen sender. */
  authorizeSender?(senderId: string): Promise<boolean>;
  onError?(error: Error): void;
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

  constructor(private readonly deps: WeixinTransportDeps) {}

  isRunning(): boolean {
    return this.loop !== undefined;
  }

  async start(): Promise<void> {
    if (this.loop !== undefined) return;
    const state = await this.deps.store.readOrEmpty();
    if (state.accountRefId === undefined) throw new Error("Weixin account is not connected; run /weixin login");
    if (state.boundSessionId === undefined) throw new Error("Weixin is not bound to a persisted Chat");
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.loop = this.poll(state, signal).finally(() => {
      this.loop = undefined;
      this.controller = undefined;
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
        state = { ...state, syncBuf: update.syncBuf };
        for (const message of update.messages) {
          if (signal.aborted) break;
          state = await this.process(credentials, state, message);
        }
        const saved = await this.deps.store.write(state);
        if (!saved.ok) throw new Error(saved.error.message);
      } catch (cause) {
        if (signal.aborted) break;
        this.deps.onError?.(cause instanceof Error ? cause : new Error(String(cause)));
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.deps.retryDelayMs ?? 2_000);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    }
  }

  private async process(
    credentials: IlinkCredentials,
    state: WeixinStateV1,
    message: IlinkMessage,
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
    const recentMessageIds = [...state.recentMessageIds, message.messageId].slice(-MAX_RECENT_MESSAGES);
    const contextTokens = message.contextToken === undefined
      ? state.contextTokens
      : { ...state.contextTokens, [message.senderId]: message.contextToken };
    const next = { ...state, allowedUserIds, recentMessageIds, contextTokens };
    // Persist admission and its context token before executing the model turn.
    const saved = await this.deps.store.write(next);
    if (!saved.ok) throw new Error(saved.error.message);
    const sessionId = state.boundSessionId;
    if (sessionId === undefined) return next;
    const reply = await this.deps.handleMessage({ sessionId, senderId: message.senderId, text: message.text });
    for (const text of chunks(reply)) {
      await this.deps.client.sendText(credentials, {
        peerId: message.senderId,
        text,
        ...(contextTokens[message.senderId] === undefined ? {} : { contextToken: contextTokens[message.senderId] }),
      });
    }
    return next;
  }
}
