import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "notifications/initialized") return;
  if (request.method === "initialize") {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1" } } })}\n`,
    );
    return;
  }
  if (request.method === "tools/list") {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "secret_length", description: "returns a length", inputSchema: { type: "object" } }] } })}\n`,
    );
    return;
  }
  if (request.method === "tools/call") {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: String(process.env.PICODE_MCP_TEST_SECRET?.length || 0) }] } })}\n`,
    );
  }
});
