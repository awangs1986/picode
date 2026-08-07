import type { CapabilityManifest, OperationIntent, TaskCapsule } from "../../src/shared/types.ts";
import type { CapsuleDraftInput } from "../../src/devloop/task/capsule.ts";
import { capsuleDigest } from "../../src/devloop/task/capsule.ts";

export function makeIntent(overrides: Partial<OperationIntent> = {}): OperationIntent {
  return {
    category: "fs-read",
    targets: ["/tmp/foo"],
    ...overrides,
  };
}

export function makeManifest(overrides: Partial<CapabilityManifest> = {}): CapabilityManifest {
  return {
    id: "test-cap",
    kind: "builtin",
    title: "Test Capability",
    summary: "A test capability for unit tests",
    keywords: ["test", "demo"],
    supportsProxyCall: false,
    origin: "suite",
    ...overrides,
  };
}

export function makeCapsuleInput(overrides: Partial<CapsuleDraftInput> = {}): CapsuleDraftInput {
  return {
    taskId: "task-1",
    taskRevision: 1,
    verificationRefs: [],
    intent: "Fix the bug",
    verbatimFacts: [{ text: "error: ENOENT", source: { kind: "session", id: "s1" } }],
    decisions: [{ decision: "use mock", rationale: "faster tests" }],
    filesTouched: ["src/foo.ts"],
    openQuestions: [],
    nextSteps: ["run tests"],
    narrative: "Summary here",
    ...overrides,
  };
}

export function sealedCapsule(overrides: Partial<TaskCapsule> = {}): TaskCapsule {
  const capsule: TaskCapsule = {
    schemaVersion: "picode.capsule/v1",
    capsuleId: "cap-1",
    taskId: "task-1",
    taskRevision: 1,
    status: "sealed",
    verificationRefs: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    intent: "Fix the bug",
    verbatimFacts: [{ text: "error: ENOENT", source: { kind: "session", id: "s1" } }],
    decisions: [],
    filesTouched: [],
    openQuestions: [],
    nextSteps: [],
    narrative: "",
    ...overrides,
  };
  return { ...capsule, digest: overrides.digest ?? capsuleDigest(capsule) };
}
