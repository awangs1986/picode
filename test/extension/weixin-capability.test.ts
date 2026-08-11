import { describe, expect, it } from "vitest";
import { createRuntime } from "../../src/extension/index.ts";
import { WEIXIN_CAPABILITY_ID } from "../../src/extension/weixin-manifest.ts";

describe("Weixin iLink third-tier capability", () => {
  it("is disabled and invisible until the user explicitly trusts it", () => {
    const runtime = createRuntime();

    expect(runtime.guard.catalog.get(WEIXIN_CAPABILITY_ID)?.setting).toBe("disabled");
    expect(runtime.guard.catalog.search("weixin")).toEqual([]);

    expect(runtime.guard.catalog.userSetState(WEIXIN_CAPABILITY_ID, "trusted")).toEqual({
      ok: true,
      value: undefined,
    });
    expect(runtime.guard.catalog.search("weixin")).toEqual([
      expect.objectContaining({ id: WEIXIN_CAPABILITY_ID }),
    ]);
  });
});
