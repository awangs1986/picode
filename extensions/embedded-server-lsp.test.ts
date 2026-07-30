import path from "node:path";
import { describe, expect, test } from "vitest";
import { runScopedLspRequest } from "./embedded-server.ts";

describe("lazy scoped LSP bridge", () => {
  test("starts only on invocation, exchanges bounded JSON-RPC, and exits", async () => {
    const result = await runScopedLspRequest({
      command: process.execPath,
      args: [path.join(process.cwd(), "extensions/fixtures/mock-lsp-server.mjs")],
      cwd: process.cwd(),
      method: "textDocument/hover",
      params: { textDocument: { uri: "file:///mock.rs" }, position: { line: 0, character: 0 } },
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
    });
    expect(result).toEqual({ contents: "mock hover" });
  });

  test("rejects shells and unbounded protocol output before spawning", async () => {
    await expect(
      runScopedLspRequest({
        command: "cmd /c server",
        args: [],
        cwd: process.cwd(),
        method: "hover",
        params: {},
        timeoutMs: 100,
        maxOutputBytes: 1024,
      }),
    ).rejects.toThrow("single executable");
  });
});
