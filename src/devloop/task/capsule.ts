import { createHash, randomUUID } from "node:crypto";
import type { Result, TaskCapsule, WorkspaceSnapshotRef } from "../../shared/types.ts";
import { err, ok } from "../../shared/types.ts";

/**
 * Capsule v1（MODULES.md §3.1，R3 外壳）。
 * 生命周期 draft → sealed → superseded；sealed 后内容不可变。
 * 注入前必须过 canInject 校验（revision/快照绑定），防注入错误
 * 任务版本或代码快照。全部纯函数，落盘归 Store 纪律。
 */

export type CapsuleDraftInput = Omit<
  TaskCapsule,
  "schemaVersion" | "capsuleId" | "status" | "createdAt" | "supersededBy" | "digest"
>;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().filter((key) => row[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stable(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Digest excludes lifecycle-only fields so superseding a sealed Capsule does not rewrite its facts. */
export function capsuleDigest(capsule: TaskCapsule): string {
  const { digest: _digest, status: _status, supersededBy: _supersededBy, ...immutable } = capsule;
  return createHash("sha256").update(stable(immutable)).digest("hex");
}

export function createCapsule(input: CapsuleDraftInput): TaskCapsule {
  return {
    ...input,
    schemaVersion: "picode.capsule/v1",
    capsuleId: randomUUID(),
    status: "draft",
    createdAt: new Date().toISOString(),
  };
}

export function sealCapsule(capsule: TaskCapsule): Result<TaskCapsule> {
  if (capsule.status !== "draft") {
    return err("devloop/capsule-not-draft", `cannot seal capsule in status ${capsule.status}`);
  }
  if (capsule.intent.trim() === "") {
    return err("devloop/capsule-missing-intent", "intent section must not be empty");
  }
  for (const fact of capsule.verbatimFacts) {
    if (fact.source.kind === "file" && fact.source.sourceDigest === undefined) {
      return err(
        "devloop/capsule-source-digest-required",
        `file fact source ${fact.source.locator ?? fact.source.id} requires sourceDigest`,
      );
    }
  }
  const sealed: TaskCapsule = { ...capsule, status: "sealed" };
  return ok({ ...sealed, digest: capsuleDigest(sealed) });
}

export function supersedeCapsule(
  old: TaskCapsule,
  successorId: string,
): Result<TaskCapsule> {
  if (old.status !== "sealed") {
    return err(
      "devloop/capsule-not-sealed",
      `only sealed capsules can be superseded (got ${old.status})`,
    );
  }
  return ok({ ...old, status: "superseded", supersededBy: successorId });
}

export function canInject(
  capsule: TaskCapsule,
  current: { taskId: string; taskRevision: number; workspace?: WorkspaceSnapshotRef },
): Result<void> {
  if (capsule.status !== "sealed") {
    return err("devloop/capsule-not-sealed", `cannot inject capsule in status ${capsule.status}`);
  }
  if (capsule.schemaVersion !== "picode.capsule/v1") {
    return err("devloop/capsule-schema-unsupported", `unsupported Capsule schema ${String(capsule.schemaVersion)}`);
  }
  if (capsule.taskId !== current.taskId) {
    return err("devloop/capsule-task-mismatch", "capsule belongs to a different task");
  }
  if (capsule.taskRevision !== current.taskRevision) {
    return err(
      "devloop/capsule-revision-mismatch",
      `capsule bound to task revision ${capsule.taskRevision}, current is ${current.taskRevision}`,
    );
  }
  if (capsule.digest === undefined || capsule.digest !== capsuleDigest(capsule)) {
    return err("devloop/capsule-digest-mismatch", "sealed Capsule content digest does not match");
  }
  if (
    capsule.workspaceSnapshot?.head !== undefined &&
    current.workspace?.head !== undefined &&
    capsule.workspaceSnapshot.head !== current.workspace.head
  ) {
    return err(
      "devloop/capsule-snapshot-mismatch",
      "capsule was generated against a different workspace HEAD",
    );
  }
  if (
    capsule.workspaceSnapshot?.contentDigest !== undefined &&
    current.workspace?.contentDigest !== undefined &&
    capsule.workspaceSnapshot.contentDigest !== current.workspace.contentDigest
  ) {
    return err("devloop/capsule-snapshot-mismatch", "capsule content digest no longer matches the workspace");
  }
  return ok(undefined);
}

/** 注入时渲染 Markdown（强制分节；verbatim facts 禁改写原样输出） */
export function renderCapsule(capsule: TaskCapsule): string {
  const lines: string[] = [
    `# Task Capsule (${capsule.capsuleId})`,
    `Schema: ${capsule.schemaVersion}`,
    `Digest: ${capsule.digest ?? "unsealed"}`,
    "",
    `## Intent`,
    capsule.intent,
    "",
    `## Verbatim Facts`,
    ...capsule.verbatimFacts.map((f) => `- ${f.text} [${f.source.kind}:${f.source.id}]`),
    "",
    `## Decisions`,
    ...capsule.decisions.map((d) => `- ${d.decision} — ${d.rationale}`),
    "",
    `## Files Touched`,
    ...capsule.filesTouched.map((f) => `- ${f}`),
    "",
    `## Open Questions`,
    ...capsule.openQuestions.map((q) => `- ${q}`),
    "",
    `## Next Steps`,
    ...capsule.nextSteps.map((s) => `- ${s}`),
    "",
    `## Narrative`,
    capsule.narrative,
  ];
  return lines.join("\n");
}
