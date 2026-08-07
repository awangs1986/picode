import { describe, expect, it, vi } from "vitest";
import {
  SEARCH_TOOLS_DEFINITION,
  formatSearchResults,
  handleSearchTools,
} from "../../src/extension/search-tools.ts";
import { makeManifest } from "../helpers/fixtures.ts";
import { ok, err } from "../../src/shared/types.ts";
import type { GuardPort, TaskContext } from "../../src/shared/types.ts";

const ctx: TaskContext = { sessionId: "s1", harnessTier: "standard", currentTurn: 1 };

function fakeGuard(manifests: ReturnType<typeof makeManifest>[]): GuardPort {
  return {
    decide: () => ({ verdict: "allow", reason: "test" }),
    grant: () => {},
    fingerprintOf: () => "fp",
    searchCapabilities: (query: string) =>
      manifests.filter(
        (m) =>
          m.id.includes(query) ||
          m.title.toLowerCase().includes(query.toLowerCase()) ||
          m.keywords.some((k) => k.includes(query)),
      ),
    checkActivatable: () => ok(undefined),
  };
}

describe("SEARCH_TOOLS_DEFINITION", () => {
  it("has name search_tools and required action parameter", () => {
    expect(SEARCH_TOOLS_DEFINITION.name).toBe("search_tools");
    expect(SEARCH_TOOLS_DEFINITION.parameters.required).toEqual(["action"]);
  });
});

describe("formatSearchResults", () => {
  it('returns "no matching capabilities" for empty list', () => {
    expect(formatSearchResults([])).toBe("no matching capabilities");
  });

  it("includes id, title, and summary per entry", () => {
    const text = formatSearchResults([
      makeManifest({ id: "cap-1", title: "Cap One", summary: "Does things" }),
    ]);
    expect(text).toContain("cap-1");
    expect(text).toContain("Cap One");
    expect(text).toContain("Does things");
  });
});

describe("handleSearchTools", () => {
  it("search action calls guard.searchCapabilities and formats results", async () => {
    const manifest = makeManifest({
      id: "fs-tools",
      title: "FS",
      keywords: ["file"],
    });
    const guard = fakeGuard([manifest]);
    const searchSpy = vi.spyOn(guard, "searchCapabilities");

    const out = await handleSearchTools(
      { guard, activate: vi.fn() },
      { action: "search", query: "file" },
      ctx,
    );

    expect(searchSpy).toHaveBeenCalledWith("file");
    expect(out).toContain("fs-tools");
    expect(out).toContain("FS");
  });

  it("activate without capabilityId prompts for id", async () => {
    const out = await handleSearchTools(
      { guard: fakeGuard([]), activate: vi.fn() },
      { action: "activate" },
      ctx,
    );
    expect(out).toBe("activate requires capabilityId");
  });

  it("activate failure returns cannot activate message", async () => {
    const out = await handleSearchTools(
      {
        guard: fakeGuard([]),
        activate: vi.fn().mockResolvedValue(err("guard/not-trusted", "not trusted")),
      },
      { action: "activate", capabilityId: "x" },
      ctx,
    );
    expect(out).toBe("cannot activate: not trusted");
  });

  it("proxy lease message mentions via proxy call", async () => {
    const out = await handleSearchTools(
      {
        guard: fakeGuard([]),
        activate: vi.fn().mockResolvedValue(
          ok({
            leaseId: "l1",
            capabilityId: "proxy-cap",
            path: "proxy",
            activatedAtTurn: 1,
          }),
        ),
      },
      { action: "activate", capabilityId: "proxy-cap" },
      ctx,
    );
    expect(out).toContain("via proxy call");
  });

  it("registered lease message mentions next turn", async () => {
    const out = await handleSearchTools(
      {
        guard: fakeGuard([]),
        activate: vi.fn().mockResolvedValue(
          ok({
            leaseId: "l2",
            capabilityId: "reg-cap",
            path: "registered",
            activatedAtTurn: 1,
          }),
        ),
      },
      { action: "activate", capabilityId: "reg-cap" },
      ctx,
    );
    expect(out).toContain("next turn");
  });
});
