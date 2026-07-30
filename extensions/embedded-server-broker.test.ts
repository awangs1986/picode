import { afterEach, describe, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { callBrokerControl } from "./embedded-server.ts";

const originalPort = process.env.PI_STUDIO_BROKER_PORT;

afterEach(() => {
  if (originalPort === undefined) delete process.env.PI_STUDIO_BROKER_PORT;
  else process.env.PI_STUDIO_BROKER_PORT = originalPort;
});

describe("agent-to-host broker controls", () => {
  test("uses correlated local control frames and returns only the matching result", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/ui-ws" });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (typeof address === "string") throw new Error("unexpected pipe address");
    process.env.PI_STUDIO_BROKER_PORT = String(address.port);
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const request = JSON.parse(String(raw));
        expect(request).toMatchObject({
          type: "broker_control",
          command: "task_snapshot",
          args: {},
        });
        socket.send(
          JSON.stringify({
            type: "control_response",
            requestId: "not-this-request",
            ok: true,
            result: "wrong",
          }),
        );
        socket.send(
          JSON.stringify({
            type: "control_response",
            requestId: request.requestId,
            ok: true,
            result: { agentRuns: [] },
          }),
        );
      });
    });

    await expect(callBrokerControl("task_snapshot", {})).resolves.toEqual({ agentRuns: [] });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
