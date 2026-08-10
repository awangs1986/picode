import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCursorSessionStateRoot,
  hashCursorSessionStoreScope,
} from "pi-cursor-sdk/src/cursor-session-store.ts";
import { parseCursorSessionAgentResumeEntryData } from "pi-cursor-sdk/src/cursor-session-agent-resume.ts";
import {
  MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP,
  planCursorSessionSend,
} from "pi-cursor-sdk/src/cursor-session-send-policy.ts";

describe("Picode Cursor long-session contract", () => {
  it("pins pi-cursor-sdk 0.1.61 as the formal Cursor provider", () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    expect(manifest.dependencies?.["pi-cursor-sdk"]).toBe("0.1.61");
  });

  it("isolates the Cursor SQLite state root by persistent Pi session scope", () => {
    const first = buildCursorSessionStateRoot("C:/cursor-state", "session-file:A", true);
    const same = buildCursorSessionStateRoot("C:/cursor-state", "session-file:A", true);
    const second = buildCursorSessionStateRoot("C:/cursor-state", "session-file:B", true);
    expect(first).toBe(same);
    expect(first).not.toBe(second);
    expect(first.replaceAll("\\", "/")).toContain(`/pi-sessions/${hashCursorSessionStoreScope("session-file:A")}`);
  });

  it("accepts only a strict v2 resume ledger entry with its recorded store identity", () => {
    const valid = {
      version: 2, runtime: "local", agentId: "agent-long-session", scopeKey: "scope",
      sessionFile: "C:/sessions/pi.jsonl", sessionId: "pi-session", cwd: "C:/repo",
      poolKey: "cursor/model/tools", branchPathHash: "branch", compactionGeneration: 3,
      sendState: { bootstrapped: true, contextFingerprint: "ctx", incrementalSendCount: 4 },
      createdAt: "2026-08-09T00:00:00Z",
      storeIdentity: { version: 1, stateRoot: "C:/cursor-state/pi-sessions/hash" },
    };
    expect(parseCursorSessionAgentResumeEntryData(valid)).toMatchObject(valid);
    const { storeIdentity: _removed, ...withoutStore } = valid;
    expect(parseCursorSessionAgentResumeEntryData(withoutStore)).toBeUndefined();
  });

  it("rebootstraps from the current Pi transcript initially and after bounded incremental drift", () => {
    const context = { systemPrompt: "system", messages: [], tools: [] };
    expect(planCursorSessionSend({ bootstrapped: false, contextFingerprint: "", incrementalSendCount: 0 }, context)).toMatchObject({ mode: "bootstrap", reason: "initial" });
    expect(planCursorSessionSend({ bootstrapped: true, contextFingerprint: "anything", incrementalSendCount: MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP }, context)).toMatchObject({ mode: "bootstrap", resetAgent: true, reason: "incremental_threshold" });
  });
});
