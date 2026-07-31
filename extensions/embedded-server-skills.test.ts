import { describe, expect, test } from "vitest";
import { normalizeSkillCommands } from "./embedded-server.ts";

describe("normalizeSkillCommands", () => {
  test("returns only invokable skills with canonical scope metadata", () => {
    expect(
      normalizeSkillCommands([
        {
          name: "skill:release-notes",
          description: "  Cut a release  ",
          source: "skill",
          sourceInfo: {
            scope: "project",
            source: "git:github.com/mattpocock/skills",
            origin: "package",
            path: "/skills/release-notes/SKILL.md",
          },
        },
        {
          name: "skill:research",
          source: "skill",
          sourceInfo: {
            scope: "user",
            source: "top-level",
            origin: "top-level",
            path: "/home/user/.pi/agent/skills/research/SKILL.md",
          },
        },
        { name: "compact", source: "extension" },
      ]),
    ).toEqual([
      {
        command: "/skill:release-notes",
        name: "release-notes",
        description: "Cut a release",
        scope: "project",
        source: "git:github.com/mattpocock/skills",
        origin: "package",
        path: "/skills/release-notes/SKILL.md",
      },
      {
        command: "/skill:research",
        name: "research",
        description: "",
        scope: "personal",
        source: "top-level",
        origin: "top-level",
        path: "/home/user/.pi/agent/skills/research/SKILL.md",
      },
    ]);
  });
});
