import { createHash, randomInt, randomUUID } from "node:crypto";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const CLIENT_VERSION = String((2 << 16) | (2 << 8));
const CHANNEL_VERSION = "2.2.0";

export interface IlinkCredentials {
  accountId: string;
  token: string;
  baseUrl: string;
  userId: string;
}

export type IlinkQrStatus =
  | { status: "wait" | "scaned" | "expired" }
  | { status: "redirect"; baseUrl: string }
  | { status: "confirmed"; credentials: IlinkCredentials };

export interface IlinkMessage {
  messageId: string;
  senderId: string;
  text: string;
  contextToken?: string;
}

export interface IlinkClientOptions {
  fetch?: typeof globalThis.fetch;
  randomUin?: () => number;
}

export class IlinkSessionExpiredError extends Error {
  constructor(endpoint: string) {
    super(`iLink ${endpoint} session expired; run /weixin login`);
    this.name = "IlinkSessionExpiredError";
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid iLink response");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function trustedBaseUrl(value: string): string {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || (host !== "weixin.qq.com" && !host.endsWith(".weixin.qq.com"))) {
    throw new Error(`untrusted iLink host: ${url.hostname}`);
  }
  return `${url.protocol}//${url.host}`;
}

function textFromItems(value: unknown): string {
  if (!Array.isArray(value)) return "";
  for (const raw of value) {
    const item = object(raw);
    if (item["type"] !== 1) continue;
    const textItem = object(item["text_item"]);
    const text = string(textItem["text"]).trim();
    if (text !== "") return text;
  }
  return "";
}

export class IlinkClient {
  private readonly fetch: typeof globalThis.fetch;
  private readonly randomUin: () => number;

  constructor(options: IlinkClientOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.randomUin = options.randomUin ?? (() => randomInt(0, 0x1_0000_0000));
  }

  async requestQr(botType = 3): Promise<{ qrCode: string; content: string }> {
    const response = await this.get(DEFAULT_BASE_URL, `ilink/bot/get_bot_qrcode?bot_type=${botType}`);
    const qrCode = string(response["qrcode"]);
    if (qrCode === "") throw new Error("iLink QR response omitted qrcode");
    return { qrCode, content: string(response["qrcode_img_content"]) || qrCode };
  }

  async pollQr(qrCode: string, baseUrl = DEFAULT_BASE_URL): Promise<IlinkQrStatus> {
    const response = await this.get(baseUrl, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrCode)}`);
    const status = string(response["status"]) || "wait";
    if (status === "scaned_but_redirect") {
      return { status: "redirect", baseUrl: trustedBaseUrl(`https://${string(response["redirect_host"])}`) };
    }
    if (status === "confirmed") {
      const credentials = {
        accountId: string(response["ilink_bot_id"]),
        token: string(response["bot_token"]),
        baseUrl: trustedBaseUrl(string(response["baseurl"]) || baseUrl),
        userId: string(response["ilink_user_id"]),
      };
      if (credentials.accountId === "" || credentials.token === "") {
        throw new Error("iLink QR confirmation omitted credentials");
      }
      return { status: "confirmed", credentials };
    }
    return { status: status === "scaned" || status === "expired" ? status : "wait" };
  }

  async getUpdates(
    credentials: IlinkCredentials,
    syncBuf: string,
    signal?: AbortSignal,
  ): Promise<{ syncBuf: string; messages: IlinkMessage[] }> {
    const response = await this.post(credentials.baseUrl, "ilink/bot/getupdates", {
      get_updates_buf: syncBuf,
    }, credentials.token, signal);
    this.assertSuccess(response, "getupdates");
    const messages = Array.isArray(response["msgs"])
      ? response["msgs"].flatMap((raw): IlinkMessage[] => {
        const message = object(raw);
        const messageId = string(message["message_id"]) ||
          `synthetic:${createHash("sha256").update(JSON.stringify(message)).digest("hex")}`;
        const senderId = string(message["from_user_id"]);
        const text = textFromItems(message["item_list"]);
        if (senderId === "" || text === "") return [];
        const contextToken = string(message["context_token"]);
        return [{ messageId, senderId, text, ...(contextToken === "" ? {} : { contextToken }) }];
      })
      : [];
    return { syncBuf: string(response["get_updates_buf"]) || syncBuf, messages };
  }

  async sendText(
    credentials: IlinkCredentials,
    input: { peerId: string; text: string; contextToken?: string; clientId?: string },
  ): Promise<void> {
    if (input.text.trim() === "") throw new Error("iLink text must not be empty");
    const msg = {
      from_user_id: "",
      to_user_id: input.peerId,
      client_id: input.clientId ?? `picode-weixin-${randomUUID()}`,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: input.text } }],
      ...(input.contextToken === undefined ? {} : { context_token: input.contextToken }),
    };
    let response = await this.post(credentials.baseUrl, "ilink/bot/sendmessage", { msg }, credentials.token);
    if (input.contextToken !== undefined && this.isStaleSession(response)) {
      const { context_token: _contextToken, ...withoutToken } = msg;
      response = await this.post(credentials.baseUrl, "ilink/bot/sendmessage", { msg: withoutToken }, credentials.token);
    }
    this.assertSuccess(response, "sendmessage");
  }

  private async get(baseUrl: string, endpoint: string): Promise<Record<string, unknown>> {
    const response = await this.fetch(`${trustedBaseUrl(baseUrl)}/${endpoint}`, {
      headers: { "iLink-App-Id": "bot", "iLink-App-ClientVersion": CLIENT_VERSION },
    });
    return this.decode(response, endpoint);
  }

  private async post(
    baseUrl: string,
    endpoint: string,
    payload: Record<string, unknown>,
    token: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const body = JSON.stringify({ ...payload, base_info: { channel_version: CHANNEL_VERSION } });
    const response = await this.fetch(`${trustedBaseUrl(baseUrl)}/${endpoint}`, {
      method: "POST",
      body,
      ...(signal === undefined ? {} : { signal }),
      headers: {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        Authorization: `Bearer ${token}`,
        "Content-Length": String(Buffer.byteLength(body)),
        "X-WECHAT-UIN": Buffer.from(String(this.randomUin())).toString("base64"),
        "iLink-App-Id": "bot",
        "iLink-App-ClientVersion": CLIENT_VERSION,
      },
    });
    return this.decode(response, endpoint);
  }

  private async decode(response: Response, endpoint: string): Promise<Record<string, unknown>> {
    if (!response.ok) throw new Error(`iLink ${endpoint} HTTP ${response.status}`);
    return object(await response.json());
  }

  private assertSuccess(response: Record<string, unknown>, endpoint: string): void {
    const ret = typeof response["ret"] === "number" ? response["ret"] : 0;
    const errcode = typeof response["errcode"] === "number" ? response["errcode"] : 0;
    if (ret === -14 || errcode === -14) {
      throw new IlinkSessionExpiredError(endpoint);
    }
    if (ret !== 0 || errcode !== 0) {
      throw new Error(`iLink ${endpoint} failed: ret=${ret} errcode=${errcode} ${string(response["errmsg"])}`.trim());
    }
  }

  private isStaleSession(response: Record<string, unknown>): boolean {
    const ret = response["ret"];
    const errcode = response["errcode"];
    return errcode === -14 || ((ret === -2 || errcode === -2) && string(response["errmsg"]).toLowerCase() === "unknown error");
  }
}
