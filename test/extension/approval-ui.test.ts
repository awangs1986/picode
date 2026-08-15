import { describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Guard } from "../../src/guard/index.ts";
import { requestIntentApproval } from "../../src/extension/approval-ui.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

const intent = {
  category: "exec" as const,
  targets: ["npm test"],
  command: "npm test",
  cwd: "C:/repo",
};

describe("requestIntentApproval", () => {
  it("supports allow once without creating a grant", async () => {
    const guard = new Guard("auto");
    const ui = { select: vi.fn(async () => "Allow once") } as unknown as ExtensionUIContext;
    expect(await requestIntentApproval(ui, guard, intent, "confirm")).toBe(true);
    expect(guard.grants.all()).toHaveLength(0);
  });

  it("denies without changing grants or permission tier", async () => {
    const guard = new Guard("auto");
    const ui = { select: vi.fn(async () => "Deny") } as unknown as ExtensionUIContext;
    expect(await requestIntentApproval(ui, guard, intent, "confirm")).toBe(false);
    expect(guard.grants.all()).toHaveLength(0);
    expect(guard.permissionTier()).toBe("auto");
  });

  it("supports an exact command grant for the current process session", async () => {
    const guard = new Guard("auto");
    const ui = { select: vi.fn(async () => "Allow exact command for this session") } as unknown as ExtensionUIContext;
    expect(await requestIntentApproval(ui, guard, intent, "confirm")).toBe(true);
    expect(guard.decide(intent).verdict).toBe("allow");
    expect(guard.decide({ ...intent, command: "npm test -- --watch", targets: ["npm test -- --watch"] }).verdict)
      .toBe("ask");
  });

  it("supports allowing all routine operations for the current session", async () => {
    const guard = new Guard("auto");
    const ui = {
      select: vi.fn(async () => "Allow routine operations for this session (destructive/Git still ask)"),
    } as unknown as ExtensionUIContext;

    expect(await requestIntentApproval(ui, guard, intent, "confirm")).toBe(true);
    expect(guard.permissionTier()).toBe("full");
    expect(guard.decide({ ...intent, command: "npm run build", targets: ["npm run build"] }).verdict)
      .toBe("allow");
  });

  it("supports explicit unrestricted access for the current session without later prompts", async () => {
    const guard = new Guard("auto");
    const ui = {
      select: vi.fn(async () => "Danger: allow everything for this session (no more prompts)"),
    } as unknown as ExtensionUIContext;

    expect(await requestIntentApproval(ui, guard, intent, "confirm")).toBe(true);
    expect(guard.permissionTier()).toBe("danger-full-access");
    expect(guard.decide({
      ...intent,
      category: "git-mutate",
      command: "git commit -m test",
      targets: ["git commit -m test"],
      destructive: true,
    }).verdict).toBe("allow");
  });

  it("supports a persistent global command-prefix grant", async () => {
    await withTempPicodeDir(async () => {
      const guard = new Guard("auto");
      const ui = { select: vi.fn(async () => "Always allow this command prefix") } as unknown as ExtensionUIContext;
      expect(await requestIntentApproval(ui, guard, intent, "confirm")).toBe(true);
      expect(guard.grants.all()).toContainEqual({ kind: "pattern", value: "npm test", scope: "global" });
    });
  });
});
