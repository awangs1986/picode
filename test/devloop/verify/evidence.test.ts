import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendEvidence } from "../../../src/devloop/verify/evidence.ts";
import { makeEvent } from "../../../src/shared/events.ts";
import { dataPaths } from "../../../src/shared/paths.ts";
import { withTempPicodeDir } from "../../helpers/temp-dir.ts";

describe("makeEvent", () => {
  it("builds envelope fields", () => {
    const event = makeEvent("gate.passed", { gate: "tdd-green" }, {
      taskId: "task-1",
      sliceId: "slice-a",
      ref: { kind: "evidence", id: "ev-1" },
    });
    expect(event.kind).toBe("gate.passed");
    expect(event.payload).toEqual({ gate: "tdd-green" });
    expect(event.taskId).toBe("task-1");
    expect(event.sliceId).toBe("slice-a");
    expect(event.ref).toEqual({ kind: "evidence", id: "ev-1" });
    expect(event.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("appendEvidence", () => {
  it("appends one valid JSON line to evidence/<yyyymm>.jsonl", async () => {
    await withTempPicodeDir(async () => {
      const event = makeEvent("guard.decision", { verdict: "allow" });
      await appendEvidence(event);
      const yyyymm = event.ts.slice(0, 7).replace("-", "");
      const file = join(dataPaths.evidence(), `${yyyymm}.jsonl`);
      const lines = readFileSync(file, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!) as typeof event;
      expect(parsed.kind).toBe("guard.decision");
      expect(parsed.payload).toEqual({ verdict: "allow" });
    });
  });
});
