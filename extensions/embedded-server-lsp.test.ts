import fs from "node:fs";
import { describe, expect, test } from "vitest";

describe("native WorkManager LSP bridge", () => {
  test("routes the Pi tool to the native adapter and contains no JS LSP spawn path", () => {
    const source = fs.readFileSync("extensions/embedded-server.ts", "utf8");
    expect(source).toContain('"code_lsp_request"');
    expect(source).not.toContain("runScopedLspRequest");
    expect(source).not.toContain('case "picode_lsp_request"');
  });
});
