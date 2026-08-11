import QRCode from "qrcode";
import type { PicodeRuntime } from "./index.ts";
import { IlinkClient, type IlinkCredentials } from "./weixin-ilink-client.ts";
import { WEIXIN_CAPABILITY_ID } from "./weixin-manifest.ts";
import { WeixinStateStore } from "./weixin-state.ts";
import { WeixinTransport } from "./weixin-transport.ts";
import type { PersistedCapabilitySettings, Result } from "../shared/types.ts";

export interface WeixinCommandUi {
  notify(message: string, level: "info" | "warning" | "error"): void;
  confirm(title: string, message: string): Promise<boolean>;
}

export interface WeixinCommandContext {
  sessionId: string;
  sessionFile?: string;
  ui: WeixinCommandUi;
}

export interface WeixinControllerDeps {
  runtime: PicodeRuntime;
  client?: IlinkClient;
  store?: WeixinStateStore;
  persistCapabilities(settings: PersistedCapabilitySettings[]): Promise<Result<void>>;
  runTurn(input: { sessionId: string; prompt: string }): Promise<string>;
  compactReply(input: { sessionId: string; text: string }): Promise<string>;
  renderQr?(content: string): Promise<string>;
  sleep?(milliseconds: number): Promise<void>;
}

export class WeixinController {
  private readonly client: IlinkClient;
  private readonly store: WeixinStateStore;
  private readonly renderQr: (content: string) => Promise<string>;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private transport: WeixinTransport | undefined;
  private lastError: string | undefined;

  constructor(private readonly deps: WeixinControllerDeps) {
    this.client = deps.client ?? new IlinkClient();
    this.store = deps.store ?? new WeixinStateStore();
    this.renderQr = deps.renderQr ?? ((content) => QRCode.toString(content, { type: "terminal", small: true }));
    this.sleep = deps.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  status(): { setting: string; running: boolean; lastError?: string } {
    return {
      setting: this.deps.runtime.guard.catalog.get(WEIXIN_CAPABILITY_ID)?.setting ?? "missing",
      running: this.transport?.isRunning() ?? false,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    };
  }

  async execute(raw: string, context: WeixinCommandContext): Promise<void> {
    const [command = "status", argument] = raw.trim().split(/\s+/, 2);
    try {
      switch (command.toLowerCase()) {
        case "enable": await this.enable(context.ui); break;
        case "disable": await this.disable(context.ui); break;
        case "login": await this.login(context.ui); break;
        case "allow": await this.allow(argument, context.ui); break;
        case "start": await this.start(context); break;
        case "stop": await this.stop(context.ui); break;
        case "status": context.ui.notify(this.formatStatus(), "info"); break;
        default:
          context.ui.notify("Usage: /weixin <enable|login|allow <user-id>|start|status|stop|disable>", "warning");
      }
    } catch (cause) {
      this.lastError = cause instanceof Error ? cause.message : String(cause);
      context.ui.notify(`Weixin: ${this.lastError}`, "error");
    }
  }

  async onSessionChanged(sessionId: string): Promise<void> {
    if (!(this.transport?.isRunning() ?? false)) return;
    const state = await this.store.readOrEmpty();
    if (state.boundSessionId !== sessionId) await this.shutdown();
  }

  async shutdown(): Promise<void> {
    await this.transport?.stop();
    this.transport = undefined;
    this.cachedCredentials = undefined;
  }

  private async enable(ui: WeixinCommandUi): Promise<void> {
    const changed = this.deps.runtime.guard.catalog.userSetState(WEIXIN_CAPABILITY_ID, "trusted");
    if (!changed.ok) throw new Error(changed.error.message);
    const saved = await this.deps.persistCapabilities(this.deps.runtime.guard.catalog.toJSON());
    if (!saved.ok) throw new Error(saved.error.message);
    ui.notify("Weixin iLink is trusted but stopped. Run /weixin login, then /weixin start.", "info");
  }

  private async disable(ui: WeixinCommandUi): Promise<void> {
    await this.shutdown();
    const changed = this.deps.runtime.guard.catalog.userSetState(WEIXIN_CAPABILITY_ID, "disabled");
    if (!changed.ok) throw new Error(changed.error.message);
    const saved = await this.deps.persistCapabilities(this.deps.runtime.guard.catalog.toJSON());
    if (!saved.ok) throw new Error(saved.error.message);
    ui.notify("Weixin iLink disabled. It has no running poller or network activity.", "info");
  }

  private assertTrusted(): void {
    const gate = this.deps.runtime.guard.checkActivatable(WEIXIN_CAPABILITY_ID);
    if (!gate.ok) throw new Error("Weixin iLink is disabled or untrusted; run /weixin enable first");
  }

  private async login(ui: WeixinCommandUi): Promise<void> {
    this.assertTrusted();
    await this.shutdown();
    let qr = await this.client.requestQr();
    let baseUrl: string | undefined;
    ui.notify(`Scan this QR code in Weixin:\n${await this.renderQr(qr.content)}\n${qr.content}`, "info");
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const status = await this.client.pollQr(qr.qrCode, baseUrl);
      if (status.status === "redirect") baseUrl = status.baseUrl;
      else if (status.status === "scaned") ui.notify("QR scanned. Confirm the iLink Bot login in Weixin.", "info");
      else if (status.status === "expired") {
        qr = await this.client.requestQr();
        baseUrl = undefined;
        ui.notify(`QR expired; scan the refreshed code:\n${await this.renderQr(qr.content)}\n${qr.content}`, "warning");
      } else if (status.status === "confirmed") {
        const account = await this.deps.runtime.accounts.importCredentials({
          stableId: status.credentials.accountId,
          provider: "weixin-ilink",
          label: `Weixin ${status.credentials.accountId}`,
          authKind: "session",
          chatCompatible: false,
          credentials: { accessToken: status.credentials.token, baseUrl: status.credentials.baseUrl },
          metadata: { ilinkAccountId: status.credentials.accountId, ilinkUserId: status.credentials.userId },
        });
        if (!account.ok) throw new Error(account.error.message);
        const current = await this.store.readOrEmpty();
        const saved = await this.store.write({
          ...current,
          accountRefId: account.value.id,
          ilinkAccountId: status.credentials.accountId,
          ilinkUserId: status.credentials.userId,
          allowedUserIds: status.credentials.userId === "" ? current.allowedUserIds : [status.credentials.userId],
          syncBuf: "",
          contextTokens: {},
          recentMessageIds: [],
        });
        if (!saved.ok) throw new Error(saved.error.message);
        this.lastError = undefined;
        ui.notify("Weixin iLink login saved in the Picode Account Vault. Run /weixin start.", "info");
        return;
      }
      await this.sleep(1_000);
    }
    throw new Error("QR login timed out");
  }

  private async allow(userId: string | undefined, ui: WeixinCommandUi): Promise<void> {
    this.assertTrusted();
    if (userId === undefined || userId.trim() === "") throw new Error("Usage: /weixin allow <ilink-user-id>");
    const current = await this.store.readOrEmpty();
    const allowedUserIds = [...new Set([...current.allowedUserIds, userId.trim()])];
    const saved = await this.store.write({ ...current, allowedUserIds });
    if (!saved.ok) throw new Error(saved.error.message);
    ui.notify(`Allowed Weixin sender: ${userId.trim()}`, "info");
  }

  private async start(context: WeixinCommandContext): Promise<void> {
    this.assertTrusted();
    if (context.sessionFile === undefined) throw new Error("send one message first so the current Chat is persisted");
    if (this.transport?.isRunning() ?? false) {
      context.ui.notify("Weixin iLink is already running for this Chat.", "info");
      return;
    }
    const current = await this.store.readOrEmpty();
    if (current.accountRefId === undefined || current.ilinkAccountId === undefined) {
      throw new Error("Weixin account is not connected; run /weixin login");
    }
    const vaultCredentials = this.deps.runtime.accounts.credentialsFor(current.accountRefId);
    if (!vaultCredentials.ok) throw new Error(vaultCredentials.error.message);
    this.cachedCredentials = {
      accountId: current.ilinkAccountId,
      userId: current.ilinkUserId ?? "",
      token: vaultCredentials.value.accessToken,
      baseUrl: vaultCredentials.value.baseUrl ?? "https://ilinkai.weixin.qq.com",
    };
    this.lastError = undefined;
    const saved = await this.store.write({ ...current, boundSessionId: context.sessionId, boundSessionFile: context.sessionFile });
    if (!saved.ok) throw new Error(saved.error.message);
    this.transport = new WeixinTransport({
      client: this.client,
      store: this.store,
      credentials: () => this.credentials(),
      handleMessage: ({ sessionId, text }) => this.deps.runTurn({ sessionId, prompt: text }),
      transformReply: ({ sessionId, text }) => this.deps.compactReply({ sessionId, text }),
      authorizeSender: async (senderId) => {
        const allowed = await context.ui.confirm(
          "Weixin sender pairing",
          `Allow Weixin sender ${senderId} to control this Picode Chat? This is stored until disabled or edited.`,
        );
        context.ui.notify(
          allowed ? `Weixin sender paired: ${senderId}` : `Rejected Weixin sender: ${senderId}`,
          allowed ? "info" : "warning",
        );
        return allowed;
      },
      onError: (error) => { this.lastError = error.message; },
      onHealthy: () => { this.lastError = undefined; },
    });
    await this.transport.start();
    context.ui.notify("Weixin iLink started and bound exclusively to the current Chat.", "info");
  }

  private async stop(ui: WeixinCommandUi): Promise<void> {
    await this.shutdown();
    ui.notify("Weixin iLink stopped.", "info");
  }

  private credentials(): IlinkCredentials {
    if (this.cachedCredentials !== undefined) return this.cachedCredentials;
    throw new Error("Weixin credentials were not prepared");
  }

  private cachedCredentials: IlinkCredentials | undefined;

  private formatStatus(): string {
    const status = this.status();
    return `Weixin iLink: ${status.setting}; ${status.running ? "running" : "stopped"}${status.lastError === undefined ? "" : `; last error: ${status.lastError}`}`;
  }
}
