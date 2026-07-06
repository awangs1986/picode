import { describe, expect, it, vi } from "vitest";

import { ensureSuperAgentSession } from "./super-agent-bootstrap.js";

describe("ensureSuperAgentSession", () => {
  it("does not spawn when a Super Agent session is already running", async () => {
    const transport = { openWorkspace: vi.fn() };

    const result = await ensureSuperAgentSession({
      superAgentPath: "/Users/me/.pi/agent/super-agent",
      projects: [
        {
          path: "/Users/me/.pi/agent/super-agent",
          sessions: [{ filePath: "/sa.jsonl", port: 47822, isRunning: true }],
        },
      ],
      transport,
    });

    expect(result).toBe(false);
    expect(transport.openWorkspace).not.toHaveBeenCalled();
  });

  it("spawns when only Super Agent history exists", async () => {
    const transport = { openWorkspace: vi.fn().mockResolvedValue(47822) };

    const result = await ensureSuperAgentSession({
      superAgentPath: "/Users/me/.pi/agent/super-agent",
      projects: [
        {
          path: "/Users/me/.pi/agent/super-agent",
          sessions: [{ filePath: "/sa.jsonl" }],
        },
      ],
      transport,
    });

    expect(result).toBe(true);
    expect(transport.openWorkspace).toHaveBeenCalledWith("/Users/me/.pi/agent/super-agent", {
      forceNewSession: true,
      openWindow: false,
      waitForHealth: true,
      waitForSessions: true,
    });
  });

  it("spawns a background Super Agent workspace when no fixed session exists", async () => {
    const transport = { openWorkspace: vi.fn().mockResolvedValue(47822) };

    const result = await ensureSuperAgentSession({
      superAgentPath: "/Users/me/.pi/agent/super-agent",
      projects: [{ path: "/Users/me/project", sessions: [{ filePath: "/project.jsonl" }] }],
      transport,
    });

    expect(result).toBe(true);
    expect(transport.openWorkspace).toHaveBeenCalledWith("/Users/me/.pi/agent/super-agent", {
      forceNewSession: true,
      openWindow: false,
      waitForHealth: true,
      waitForSessions: true,
    });
  });
});
