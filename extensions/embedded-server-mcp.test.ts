import { describe, expect, test } from "vitest";
import { type McpClientContext, runScopedMcpRequest } from "./embedded-server.ts";

describe("scoped MCP client", () => {
  test("refuses to create a second stdio lifecycle outside native WorkManager", async () => {
    const config: McpClientContext = {
      serverId: "mock",
      taskId: "task-a",
      transport: "stdio",
      command: undefined,
      arguments: [],
      environment: {},
    };
    await expect(runScopedMcpRequest(config, "tools/list", {})).rejects.toThrow("WorkManager");
  });
});
