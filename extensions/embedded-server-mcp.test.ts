import path from "node:path";
import { describe, expect, test } from "vitest";
import { type McpClientContext, runScopedMcpRequest } from "./embedded-server.ts";

describe("scoped MCP client", () => {
  test("starts a direct stdio process on demand, calls a tool, and returns a bounded result", async () => {
    const config: McpClientContext = {
      serverId: "mock",
      taskId: "task-a",
      transport: "stdio",
      command: process.execPath,
      arguments: [path.resolve("extensions/fixtures/mock-mcp-server.mjs")],
      environment: { PICODE_MCP_TEST_SECRET: "reference-resolved" },
    };
    const listed = (await runScopedMcpRequest(config, "tools/list", {})) as {
      tools: Array<{ name: string }>;
    };
    expect(listed.tools[0].name).toBe("secret_length");
    const called = (await runScopedMcpRequest(config, "tools/call", {
      name: "secret_length",
      arguments: {},
    })) as { content: Array<{ text: string }> };
    expect(called.content[0].text).toBe(String("reference-resolved".length));
  });
});
