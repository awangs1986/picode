import { describe, expect, it } from "vitest";
import { normalizeSettingsGroup, panelsForSettingsGroup } from "./settings-experience.js";

describe("settings experience", () => {
  it("reduces internal settings destinations to four user groups", () => {
    expect(normalizeSettingsGroup("general")).toBe("general");
    expect(normalizeSettingsGroup("auth")).toBe("configuration");
    expect(normalizeSettingsGroup("usage")).toBe("configuration");
    expect(normalizeSettingsGroup("chat")).toBe("extensions");
    expect(normalizeSettingsGroup("data")).toBe("data");
  });

  it("keeps related implementation panels behind one group", () => {
    expect(panelsForSettingsGroup("configuration")).toEqual(["configuration", "usage"]);
    expect(panelsForSettingsGroup("extensions")).toEqual(["extensions", "chat"]);
  });
});
