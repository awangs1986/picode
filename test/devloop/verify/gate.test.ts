import { describe, expect, it } from "vitest";
import type { CandidateSnapshot, GateRun } from "../../../src/devloop/verify/gate.ts";
import { detectFlaky, effectiveResults } from "../../../src/devloop/verify/gate.ts";

const snapA: CandidateSnapshot = { repo: "r1", head: "aaa", dirty: false };
const snapB: CandidateSnapshot = { repo: "r1", head: "bbb", dirty: false };

function run(overrides: Partial<GateRun> = {}): GateRun {
  return {
    gateId: "unit",
    command: "npm test",
    snapshot: snapA,
    result: "pass",
    ranAt: "2026-01-01T00:00:00.000Z",
    origin: "local",
    ...overrides,
  };
}

describe("detectFlaky", () => {
  it("flags a gate with pass and fail on same gateId + command + snapshot", () => {
    const flaky = detectFlaky([run({ result: "pass" }), run({ result: "fail" })]);
    expect(flaky).toEqual(["unit"]);
  });

  it("does not flag pass/fail across different snapshots", () => {
    const flaky = detectFlaky([
      run({ result: "pass", snapshot: snapA }),
      run({ result: "fail", snapshot: snapB }),
    ]);
    expect(flaky).toEqual([]);
  });

  it("does not flag pass/fail across different commands or gateIds", () => {
    expect(
      detectFlaky([run({ result: "pass" }), run({ result: "fail", command: "npm run e2e" })]),
    ).toEqual([]);
    expect(
      detectFlaky([run({ result: "pass" }), run({ result: "fail", gateId: "e2e" })]),
    ).toEqual([]);
  });

  it("distinguishes dirty snapshots by contentDigest", () => {
    const dirtyA: CandidateSnapshot = { ...snapA, dirty: true, contentDigest: "d1" };
    const dirtyB: CandidateSnapshot = { ...snapA, dirty: true, contentDigest: "d2" };
    expect(
      detectFlaky([
        run({ result: "pass", snapshot: dirtyA }),
        run({ result: "fail", snapshot: dirtyB }),
      ]),
    ).toEqual([]);
    expect(
      detectFlaky([
        run({ result: "pass", snapshot: dirtyA }),
        run({ result: "fail", snapshot: dirtyA }),
      ]),
    ).toEqual(["unit"]);
  });

  it("ignores imported runs entirely", () => {
    const flaky = detectFlaky([
      run({ result: "pass", origin: "imported" }),
      run({ result: "fail", origin: "imported" }),
      run({ result: "fail", origin: "local" }),
    ]);
    expect(flaky).toEqual([]);
  });
});

describe("effectiveResults", () => {
  it("keeps only the last result per gate for the matching snapshot", () => {
    const results = effectiveResults(
      [run({ result: "fail" }), run({ result: "pass" }), run({ gateId: "e2e", result: "fail" })],
      snapA,
    );
    expect(results.get("unit")).toBe("pass");
    expect(results.get("e2e")).toBe("fail");
  });

  it("excludes runs from other snapshots", () => {
    const results = effectiveResults(
      [run({ result: "pass", snapshot: snapB }), run({ gateId: "e2e", snapshot: snapA })],
      snapA,
    );
    expect(results.has("unit")).toBe(false);
    expect(results.get("e2e")).toBe("pass");
  });

  it("excludes imported runs even on the matching snapshot", () => {
    const results = effectiveResults([run({ origin: "imported" })], snapA);
    expect(results.size).toBe(0);
  });
});
