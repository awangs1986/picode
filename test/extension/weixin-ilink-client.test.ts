import { describe, expect, it, vi } from "vitest";
import { IlinkClient } from "../../src/extension/weixin-ilink-client.ts";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

describe("IlinkClient", () => {
  it("performs QR login against the official iLink endpoints", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ qrcode: "qr-1", qrcode_img_content: "wx://scan-me" }))
      .mockResolvedValueOnce(jsonResponse({
        status: "confirmed", ilink_bot_id: "bot-1", bot_token: "secret",
        baseurl: "https://ilinkai.weixin.qq.com", ilink_user_id: "owner-1",
      }));
    const client = new IlinkClient({ fetch });

    const qr = await client.requestQr();
    const status = await client.pollQr(qr.qrCode);

    expect(qr).toEqual({ qrCode: "qr-1", content: "wx://scan-me" });
    expect(status).toEqual({ status: "confirmed", credentials: {
      accountId: "bot-1", token: "secret", baseUrl: "https://ilinkai.weixin.qq.com", userId: "owner-1",
    } });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3",
      "https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=qr-1",
    ]);
  });

  it("decodes text updates and echoes the peer context token when replying", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ ret: 0, get_updates_buf: "next", msgs: [{
        message_id: "m1", from_user_id: "owner-1", context_token: "ctx-1",
        item_list: [{ type: 1, text_item: { text: "继续" } }],
      }] }))
      .mockResolvedValueOnce(jsonResponse({ ret: 0 }));
    const client = new IlinkClient({ fetch, randomUin: () => 42 });
    const credentials = { accountId: "bot-1", token: "secret", baseUrl: "https://ilinkai.weixin.qq.com", userId: "owner-1" };

    const updates = await client.getUpdates(credentials, "before");
    await client.sendText(credentials, { peerId: "owner-1", text: "完成", contextToken: "ctx-1", clientId: "out-1" });

    expect(updates).toEqual({ syncBuf: "next", messages: [{ messageId: "m1", senderId: "owner-1", text: "继续", contextToken: "ctx-1" }] });
    const updateBody = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(updateBody).toEqual({ get_updates_buf: "before", base_info: { channel_version: "2.2.0" } });
    const sendBody = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(sendBody.msg).toMatchObject({
      to_user_id: "owner-1", client_id: "out-1", message_type: 2, message_state: 2,
      context_token: "ctx-1", item_list: [{ type: 1, text_item: { text: "完成" } }],
    });
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("authorization")).toBe("Bearer secret");
  });

  it("rejects a redirected credential host outside Tencent iLink", async () => {
    const client = new IlinkClient({ fetch: vi.fn<typeof globalThis.fetch>() });
    await expect(client.getUpdates({
      accountId: "bot-1", token: "secret", baseUrl: "https://attacker.example", userId: "owner-1",
    }, "")).rejects.toThrow("untrusted iLink host");
  });
});
