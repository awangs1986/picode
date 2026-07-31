import { describe, expect, it } from "vitest";
import { presentWorkState } from "./work-status.js";

describe("presentWorkState", () => {
  it.each([
    ["modelWait", "working"],
    ["toolWait", "working"],
    ["permissionWait", "needsInput"],
    ["verifying", "verifying"],
    ["completed", "completed"],
    ["cancelled", "paused"],
    ["failed", "notCompleted"],
    ["unresponsive", "notCompleted"],
  ])("presents %s as the user-facing %s phase", (rawState, phase) => {
    expect(presentWorkState(rawState)).toMatchObject({ phase, rawState });
  });
});
