import { describe, expect, it } from "vitest";
import {
  parseToolsMd,
  registerTaskExtensions,
  renderTaskExtensionSummary,
  toTaskManifest,
} from "../../src/extension/tools-md.ts";
import type { ToolsMdEntry } from "../../src/extension/tools-md.ts";
import { CapabilityCatalog } from "../../src/guard/catalog.ts";

const entry = (overrides: Partial<ToolsMdEntry> = {}): ToolsMdEntry => ({
  id: "db-migrate",
  summary: "Run database migrations",
  keywords: [],
  supportsProxyCall: true,
  ...overrides,
});

describe("parseToolsMd", () => {
  it("parses sections with summary, keywords and proxy", () => {
    const entries = parseToolsMd(
      [
        "# TOOLS",
        "",
        "## db-migrate",
        "Run database migrations against the local dev DB.",
        "keywords: database, migration, sql",
        "proxy: false",
        "",
        "## smoke-test",
        "Run the smoke test suite.",
      ].join("\n"),
    );
    expect(entries).toEqual([
      {
        id: "db-migrate",
        summary: "Run database migrations against the local dev DB.",
        keywords: ["database", "migration", "sql"],
        supportsProxyCall: false,
      },
      {
        id: "smoke-test",
        summary: "Run the smoke test suite.",
        keywords: [],
        supportsProxyCall: true,
      },
    ]);
  });

  it("skips sections without a summary or with whitespace in the id", () => {
    const entries = parseToolsMd(
      [
        "## empty-summary",
        "keywords: a, b",
        "",
        "## bad id with spaces",
        "Has a summary but an invalid id.",
        "",
        "## good",
        "Valid entry.",
      ].join("\n"),
    );
    expect(entries.map((e) => e.id)).toEqual(["good"]);
  });

  it("returns an empty list for content with no sections", () => {
    expect(parseToolsMd("# just a title\nsome prose")).toEqual([]);
  });
});

describe("toTaskManifest", () => {
  it("prefixes the id with task: and sets origin task", () => {
    const manifest = toTaskManifest(entry({ keywords: ["db"] }));
    expect(manifest).toEqual({
      id: "task:db-migrate",
      kind: "pi-extension",
      title: "db-migrate",
      summary: "Run database migrations",
      keywords: ["db"],
      supportsProxyCall: true,
      origin: "task",
    });
  });
});

describe("registerTaskExtensions", () => {
  it("registers as trusted when the folder is trusted (activatable)", () => {
    const catalog = new CapabilityCatalog();
    const manifests = registerTaskExtensions(catalog, [entry()], true);
    expect(manifests.map((m) => m.id)).toEqual(["task:db-migrate"]);
    expect(catalog.get("task:db-migrate")?.setting).toBe("trusted");
    expect(catalog.checkActivatable("task:db-migrate").ok).toBe(true);
  });

  it("registers as enabled when the folder is untrusted (activation blocked)", () => {
    const catalog = new CapabilityCatalog();
    registerTaskExtensions(catalog, [entry()], false);
    expect(catalog.get("task:db-migrate")?.setting).toBe("enabled");
    const r = catalog.checkActivatable("task:db-migrate");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("guard/capability-not-trusted");
  });
});

describe("renderTaskExtensionSummary", () => {
  it("returns undefined for an empty entry list", () => {
    expect(renderTaskExtensionSummary([])).toBeUndefined();
  });

  it("renders one line per entry using only the first summary line", () => {
    const text = renderTaskExtensionSummary([
      entry(),
      entry({ id: "smoke-test", summary: "First line.\nSecond line stays out." }),
    ]);
    expect(text).toBeDefined();
    const lines = text!.split("\n");
    expect(lines[0]).toContain("TOOLS.md");
    expect(lines[1]).toBe("- task:db-migrate — Run database migrations");
    expect(lines[2]).toBe("- task:smoke-test — First line.");
    expect(text).not.toContain("Second line stays out.");
  });
});
