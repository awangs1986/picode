import type { SourceRef, WorkspaceSnapshotRef } from "../../shared/types.ts";

/**
 * Gate 与 Candidate Snapshot（MODULES.md §3.3 / R0 §11）。
 * Gate 对精确代码身份运行并产生结构化 Evidence；
 * 同 Snapshot + 同命令 + 结果不一致 = Flaky Gate。
 */

export interface CandidateSnapshot extends WorkspaceSnapshotRef {
  /** 未提交内容摘要（dirty 时区分不同工作区状态） */
  contentDigest?: string;
}

export interface GateRun {
  gateId: string;
  command: string;
  snapshot: CandidateSnapshot;
  result: "pass" | "fail";
  ranAt: string;
  evidenceRef?: SourceRef;
  /** 导入的外部声明不算当前 Gate 结果（契约文档 §10） */
  origin: "local" | "imported";
}

const snapshotKey = (s: CandidateSnapshot): string =>
  JSON.stringify([s.repo ?? null, s.head ?? null, s.dirty ?? null, s.contentDigest ?? null]);

/** 同 Snapshot 同命令出现 pass 与 fail 并存 → Flaky */
export function detectFlaky(runs: readonly GateRun[]): string[] {
  const seen = new Map<string, Set<string>>();
  for (const run of runs) {
    if (run.origin !== "local") continue;
    const key = `${run.gateId}\u0000${run.command}\u0000${snapshotKey(run.snapshot)}`;
    const results = seen.get(key) ?? new Set<string>();
    results.add(run.result);
    seen.set(key, results);
  }
  const flaky: string[] = [];
  for (const [key, results] of seen) {
    if (results.size > 1) flaky.push(key.split("\u0000")[0] as string);
  }
  return [...new Set(flaky)];
}

/** 当前有效 Gate 结果：只认 local 且属于给定 Snapshot 的最后一次运行 */
export function effectiveResults(
  runs: readonly GateRun[],
  snapshot: CandidateSnapshot,
): Map<string, "pass" | "fail"> {
  const key = snapshotKey(snapshot);
  const effective = new Map<string, "pass" | "fail">();
  for (const run of runs) {
    if (run.origin !== "local") continue;
    if (snapshotKey(run.snapshot) !== key) continue;
    effective.set(run.gateId, run.result);
  }
  return effective;
}
