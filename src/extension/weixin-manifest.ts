import type { CapabilityManifest } from "../shared/types.ts";

/**
 * Bundled third-tier transport. It is deliberately absent from the model tool
 * surface and performs no network work until the user trusts and starts it.
 */
export const WEIXIN_CAPABILITY_ID = "weixin-ilink";

export const WEIXIN_CAPABILITY_MANIFEST: CapabilityManifest = {
  id: WEIXIN_CAPABILITY_ID,
  kind: "builtin",
  title: "Weixin iLink",
  summary: "Connect one active Picode conversation to a Weixin iLink Bot private chat",
  keywords: ["weixin", "wechat", "ilink", "remote", "chat"],
  supportsProxyCall: false,
  origin: "suite",
};
