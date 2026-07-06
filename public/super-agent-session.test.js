import { describe, expect, it } from "vitest";

import {
  getSuperAgentProject,
  isSuperAgentProjectPath,
  normalizeSuperAgentSession,
} from "./super-agent-session.js";

describe("super agent session helpers", () => {
  it("selects latest session from the super agent project and marks it as super-agent", () => {
    const project = {
      path: "/Users/me/.pi/agent/super-agent",
      dirName: "super-agent",
      sessions: [
        { filePath: "/old.jsonl", timestamp: "2026-06-01T00:00:00.000Z" },
        { filePath: "/new.jsonl", timestamp: "2026-06-02T00:00:00.000Z" },
      ],
    };

    expect(
      getSuperAgentProject([project], "/Users/me/.pi/agent/super-agent")?.session,
    ).toMatchObject({
      filePath: "/new.jsonl",
      kind: "super-agent",
      name: "Super Agent",
    });
  });

  it("prefers the chat-connected Super Agent session over a newer inactive session", () => {
    const project = {
      path: "/Users/me/.pi/agent/super-agent",
      dirName: "super-agent",
      sessions: [
        {
          filePath: "/newer.jsonl",
          timestamp: "2026-07-03T18:18:00.000Z",
          isRunning: true,
        },
        {
          filePath: "/chat-listener.jsonl",
          timestamp: "2026-07-03T18:16:00.000Z",
          isRunning: true,
          chatConnected: true,
        },
      ],
    };

    expect(
      getSuperAgentProject([project], "/Users/me/.pi/agent/super-agent")?.session,
    ).toMatchObject({
      filePath: "/chat-listener.jsonl",
      kind: "super-agent",
      name: "Super Agent",
    });
  });

  it("matches only the fixed super agent workspace path", () => {
    expect(
      isSuperAgentProjectPath("/Users/me/.pi/agent/super-agent", "/Users/me/.pi/agent/super-agent"),
    ).toBe(true);
    expect(isSuperAgentProjectPath("/Users/me/project", "/Users/me/.pi/agent/super-agent")).toBe(
      false,
    );
  });

  it("recognizes the conventional super agent path before home resolution completes", () => {
    expect(isSuperAgentProjectPath("/Users/me/.pi/agent/super-agent", "")).toBe(true);
  });

  it("does not create a pinned entry when there is no session yet", () => {
    expect(
      normalizeSuperAgentSession({
        path: "/Users/me/.pi/agent/super-agent",
        sessions: [],
      }),
    ).toBeNull();
  });
});
