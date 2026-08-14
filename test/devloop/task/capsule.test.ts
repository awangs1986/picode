import { describe, expect, it } from "vitest";
import {
  CapsuleSealer,
  canInject,
  createCapsule,
  capsuleDigest,
  renderCapsule,
  sealCapsule,
  supersedeCapsule,
} from "../../../src/devloop/task/capsule.ts";
import { err, ok } from "../../../src/shared/types.ts";
import { makeCapsuleInput, sealedCapsule } from "../../helpers/fixtures.ts";

describe("Capsule v1 lifecycle", () => {
  it("refuses to seal a verbatim fact that is absent from its attested source", async () => {
    const source = "Acceptance: preserve existing saves\nNever delete user data.";
    const sourceDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source))
      .then((value) => Buffer.from(value).toString("hex"));
    const capsule = createCapsule(makeCapsuleInput({
      verbatimFacts: [{
        text: "Acceptance: deleting old saves is allowed",
        source: { kind: "file", id: "design", locator: "docs/design.md", sourceDigest },
      }],
    }));
    const sealer = new CapsuleSealer({
      resolve: async () => ok({ content: source }),
    });

    const result = await sealer.seal(capsule);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("devloop/capsule-fact-not-verbatim");
  });

  it("seals only after every verbatim fact is attested by its source", async () => {
    const source = "Acceptance: preserve existing saves\nNever delete user data.";
    const sourceDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source))
      .then((value) => Buffer.from(value).toString("hex"));
    const capsule = createCapsule(makeCapsuleInput({
      verbatimFacts: [{
        text: "Acceptance: preserve existing saves",
        source: { kind: "file", id: "design", locator: "docs/design.md", sourceDigest },
      }],
    }));
    const sealer = new CapsuleSealer({ resolve: async () => ok({ content: source }) });

    const result = await sealer.seal(capsule);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe("sealed");
  });

  it("fails closed when a verbatim source cannot be resolved", async () => {
    const capsule = createCapsule(makeCapsuleInput({
      verbatimFacts: [{ text: "Gate RED", source: { kind: "evidence", id: "gate-red" } }],
    }));
    const sealer = new CapsuleSealer({
      resolve: async () => err("store/source-missing", "source is unavailable"),
    });

    const result = await sealer.seal(capsule);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("devloop/capsule-source-unavailable");
  });

  it("createCapsule starts in draft status", () => {
    const cap = createCapsule(makeCapsuleInput());
    expect(cap.status).toBe("draft");
    expect(cap.schemaVersion).toBe("picode.capsule/v1");
    expect(cap.digest).toBeUndefined();
    expect(cap.capsuleId).toBeTruthy();
    expect(cap.createdAt).toBeTruthy();
  });

  it("seals with a stable digest and rejects content drift before injection", () => {
    const sealed = sealCapsule(createCapsule(makeCapsuleInput()));
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(sealed.value.digest).toBe(capsuleDigest(sealed.value));

    const tampered = { ...sealed.value, intent: "silently changed" };
    const result = canInject(tampered, { taskId: "task-1", taskRevision: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("devloop/capsule-digest-mismatch");
  });

  it("requires a source digest for mutable file facts", () => {
    const result = sealCapsule(createCapsule(makeCapsuleInput({
      verbatimFacts: [{
        text: "Acceptance: preserves saves",
        source: { kind: "file", id: "design", locator: "docs/design.md" },
      }],
    })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("devloop/capsule-source-digest-required");
  });

  it("sealCapsule rejects empty intent", () => {
    const cap = createCapsule(makeCapsuleInput({ intent: "   " }));
    const r = sealCapsule(cap);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("devloop/capsule-missing-intent");
  });

  it("sealCapsule rejects non-draft capsule", () => {
    const r = sealCapsule(sealedCapsule());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("devloop/capsule-not-draft");
  });

  it("supersedeCapsule only works on sealed capsules and records supersededBy", () => {
    const draft = createCapsule(makeCapsuleInput());
    expect(supersedeCapsule(draft, "new-id").ok).toBe(false);

    const sealed = sealCapsule(createCapsule(makeCapsuleInput()));
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    const superseded = supersedeCapsule(sealed.value, "successor-99");
    expect(superseded.ok).toBe(true);
    if (superseded.ok) {
      expect(superseded.value.status).toBe("superseded");
      expect(superseded.value.supersededBy).toBe("successor-99");
    }
  });

  describe("canInject", () => {
    it("rejects draft capsules", () => {
      const cap = createCapsule(makeCapsuleInput());
      const r = canInject(cap, { taskId: cap.taskId, taskRevision: cap.taskRevision });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("devloop/capsule-not-sealed");
    });

    it("rejects taskId mismatch", () => {
      const cap = sealedCapsule({ taskId: "task-a" });
      const r = canInject(cap, { taskId: "task-b", taskRevision: cap.taskRevision });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("devloop/capsule-task-mismatch");
    });

    it("rejects taskRevision mismatch", () => {
      const cap = sealedCapsule({ taskRevision: 1 });
      const r = canInject(cap, { taskId: cap.taskId, taskRevision: 2 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("devloop/capsule-revision-mismatch");
    });

    it("rejects workspace head mismatch", () => {
      const cap = sealedCapsule({
        workspaceSnapshot: { head: "abc111" },
      });
      const r = canInject(cap, {
        taskId: cap.taskId,
        taskRevision: cap.taskRevision,
        workspace: { head: "def222" },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("devloop/capsule-snapshot-mismatch");
    });

    it("allows when all bindings match", () => {
      const cap = sealedCapsule({
        workspaceSnapshot: { head: "abc111" },
      });
      const r = canInject(cap, {
        taskId: cap.taskId,
        taskRevision: cap.taskRevision,
        workspace: { head: "abc111" },
      });
      expect(r.ok).toBe(true);
    });

    it("skips snapshot check when capsule or current lacks head", () => {
      const capNoHead = sealedCapsule({ workspaceSnapshot: {} });
      expect(
        canInject(capNoHead, {
          taskId: capNoHead.taskId,
          taskRevision: capNoHead.taskRevision,
          workspace: { head: "anything" },
        }).ok,
      ).toBe(true);

      const capWithHead = sealedCapsule({ workspaceSnapshot: { head: "abc" } });
      expect(
        canInject(capWithHead, {
          taskId: capWithHead.taskId,
          taskRevision: capWithHead.taskRevision,
        }).ok,
      ).toBe(true);
    });
  });

  it("renderCapsule includes verbatim fact text and source pointer", () => {
    const cap = sealedCapsule({
      verbatimFacts: [{ text: "ENOENT on /tmp/x", source: { kind: "evidence", id: "ev-42" } }],
    });
    const md = renderCapsule(cap);
    expect(md).toContain("ENOENT on /tmp/x");
    expect(md).toContain("[evidence:ev-42]");
  });

  it("renders an explicit notice when the bounded file list omits changed files", () => {
    const cap = sealedCapsule({
      filesTouched: ["src/first.ts"],
      filesTouchedOmitted: 7,
    });
    const md = renderCapsule(cap);
    expect(md).toContain("src/first.ts");
    expect(md).toContain("7 additional changed files omitted");
    expect(md).toContain("workspace snapshot remains authoritative");
  });

  it("preserves Unicode intent and narrative byte-for-byte", () => {
    const cap = sealedCapsule({
      intent: "继续下一阶段：验证缓存模块",
      nextSteps: ["检查中文、emoji 与路径：你好 🎮 /tmp/项目"],
      narrative: "不要把用户文本按系统代码页重新解码。",
    });
    const rendered = renderCapsule(cap);
    expect(rendered).toContain("继续下一阶段：验证缓存模块");
    expect(rendered).toContain("检查中文、emoji 与路径：你好 🎮 /tmp/项目");
    expect(rendered).toContain("不要把用户文本按系统代码页重新解码。");
  });
});
