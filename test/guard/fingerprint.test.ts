import { describe, expect, it } from "vitest";
import { computeFingerprint } from "../../src/guard/fingerprint.ts";
import { makeIntent } from "../helpers/fixtures.ts";

describe("computeFingerprint()", () => {
  const base = makeIntent({
    category: "exec",
    targets: ["a", "b"],
    command: "npm test",
    scriptDigests: { "/x/a.sh": "aaa", "/x/b.sh": "bbb" },
    cwd: "/proj",
  });

  it("is stable for the same intent", () => {
    expect(computeFingerprint(base)).toBe(computeFingerprint({ ...base }));
  });

  it("is independent of targets order", () => {
    const a = computeFingerprint(makeIntent({ ...base, targets: ["a", "b"] }));
    const b = computeFingerprint(makeIntent({ ...base, targets: ["b", "a"] }));
    expect(a).toBe(b);
  });

  it("is independent of scriptDigests key order", () => {
    const a = computeFingerprint(
      makeIntent({ ...base, scriptDigests: { "/x/a.sh": "aaa", "/x/b.sh": "bbb" } }),
    );
    const b = computeFingerprint(
      makeIntent({ ...base, scriptDigests: { "/x/b.sh": "bbb", "/x/a.sh": "aaa" } }),
    );
    expect(a).toBe(b);
  });

  it("differs when cwd changes", () => {
    const a = computeFingerprint(makeIntent({ ...base, cwd: "/proj-a" }));
    const b = computeFingerprint(makeIntent({ ...base, cwd: "/proj-b" }));
    expect(a).not.toBe(b);
  });

  it("differs when command changes", () => {
    const a = computeFingerprint(makeIntent({ ...base, command: "npm test" }));
    const b = computeFingerprint(makeIntent({ ...base, command: "npm run test" }));
    expect(a).not.toBe(b);
  });
});
