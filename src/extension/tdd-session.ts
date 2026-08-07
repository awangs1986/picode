import { createHash } from "node:crypto";
import {
  GateRunner,
  type GateContract,
  type GateEvidence,
  type GateExecutor,
} from "../devloop/verify/gate-runner.ts";
import type { CandidateSnapshot, GateRun } from "../devloop/verify/gate.ts";
import { issueCompletionLabel, type CompletionLabel } from "../devloop/verify/completion.ts";
import { TddRun, type TddRunCheckpoint, type TddState } from "../devloop/verify/tdd.ts";
import type { Result, SourceRef } from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";

function evidenceId(gateId: string, phase: string, command: string): string {
  return createHash("sha256").update(`${gateId}\0${phase}\0${command}\0${Date.now()}`).digest("hex").slice(0, 24);
}

function isTestPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return /(^|\/)(test|tests|__tests__|spec|specs|fixtures)(\/|$)/.test(normalized) ||
    /(?:\.test|\.spec|_test)\.[^/]+$/.test(normalized);
}

/** Session-local enforcement adapter around the Devloop TDD state machine. */
export class TddSessionController {
  private run = new TddRun();
  private readonly gateRunner: GateRunner;
  private contract: GateContract | undefined;
  private readonly gateRuns: GateRun[] = [];
  private lastEvidence: GateEvidence | undefined;

  constructor(private readonly executor: GateExecutor) {
    this.gateRunner = new GateRunner(executor);
  }

  state(): TddState {
    return this.run.current();
  }

  begin(): Result<TddState> {
    return this.run.transition("red");
  }

  mayWrite(path: string): boolean {
    if (isTestPath(path)) return true;
    return ["green", "refactor", "gate", "done"].includes(this.run.current());
  }

  /**
   * Pi's bash tool is an unavoidable secondary write channel. In strict TDD we
   * block only commands that clearly mutate files before RED; inspection and
   * test commands remain available so the workflow does not become a sandbox.
   */
  mayRunShell(command: string): boolean {
    if (["green", "refactor", "gate", "done"].includes(this.run.current())) return true;
    const obviousMutation = /(?:^|[;&|]\s*|\s)(?:rm|mv|cp|del|erase|move|copy|mkdir|rmdir|touch|tee|sed\s+-i|set-content|add-content|out-file|new-item|remove-item|move-item|copy-item)\b|(?:^|[^<>])>{1,2}(?!>)|\b(?:python|python3|node|ruby|perl)\b[^\r\n]*\b(?:write|writefile|appendfile|open\s*\([^)]*['"](?:w|a|x))/i;
    return !obviousMutation.test(command);
  }

  async proveRed(contract: GateContract): Promise<Result<GateEvidence>> {
    if (this.run.current() !== "red") {
      return err("devloop/tdd-not-red", `cannot prove RED while state is ${this.run.current()}`);
    }
    const execution = await this.executor.execute(contract.command, contract.timeoutMs);
    const proved = execution.disposition !== "skipped" && execution.disposition !== "not_run" &&
      !execution.timedOut && execution.matchedTests > 0 &&
      (execution.exitCode !== 0 || execution.failedTests > 0);
    if (!proved) {
      return err("devloop/tdd-red-not-proved", "RED requires at least one matched test and a target failure");
    }
    const id = evidenceId(contract.gateId, "red", contract.command);
    const recorded = this.run.recordRed({ kind: "evidence", id });
    if (!recorded.ok) return recorded;
    const advanced = this.run.transition("green");
    if (!advanced.ok) return advanced;
    this.contract = { ...contract };
    const evidence: GateEvidence = {
      gateId: contract.gateId,
      command: contract.command,
      status: "failed",
      reason: "recorded-red",
      matchedTests: execution.matchedTests,
      passedTests: execution.passedTests,
      failedTests: execution.failedTests,
      timedOut: execution.timedOut,
      ranAt: new Date().toISOString(),
    };
    this.lastEvidence = evidence;
    return ok(evidence);
  }

  async runGate(
    contract: GateContract,
    snapshot: CandidateSnapshot,
    pipeline: {
      review: () => Promise<Result<SourceRef>>;
      integrationContract: GateContract;
      snapshotNow: () => Promise<CandidateSnapshot>;
    },
  ): Promise<Result<CompletionLabel>> {
    if (this.contract === undefined ||
      this.contract.gateId !== contract.gateId || this.contract.command !== contract.command) {
      return err("devloop/tdd-gate-contract-changed", "GREEN must use the same gate id and command that proved RED");
    }
    if (this.run.current() === "green" || this.run.current() === "refactor") {
      const toGate = this.run.transition("gate");
      if (!toGate.ok) return toGate;
    }
    if (this.run.current() !== "gate") {
      return err("devloop/tdd-not-at-gate", `cannot run completion gate while state is ${this.run.current()}`);
    }
    const evidence = await this.gateRunner.run(contract);
    this.lastEvidence = evidence;
    this.gateRuns.push({
      gateId: contract.gateId,
      command: contract.command,
      snapshot,
      result: evidence.status === "passed" ? "pass" : "fail",
      ranAt: evidence.ranAt,
      evidenceRef: { kind: "evidence", id: evidenceId(contract.gateId, "gate", contract.command) },
      origin: "local",
    });
    if (evidence.status !== "passed") {
      const retry = this.run.transition("green");
      return retry.ok
        ? err("devloop/tdd-gate-failed", evidence.reason)
        : retry;
    }

    const reviewerBudget = this.run.useReviewerRound();
    if (!reviewerBudget.ok) return reviewerBudget;
    const review = await pipeline.review();
    if (!review.ok) {
      const retry = this.run.transition("green");
      return retry.ok
        ? err("devloop/tdd-review-failed", review.error.message)
        : retry;
    }

    const integrationEvidence = await this.gateRunner.run(pipeline.integrationContract);
    this.gateRuns.push({
      gateId: pipeline.integrationContract.gateId,
      command: pipeline.integrationContract.command,
      snapshot,
      result: integrationEvidence.status === "passed" ? "pass" : "fail",
      ranAt: integrationEvidence.ranAt,
      evidenceRef: { kind: "evidence", id: evidenceId(
        pipeline.integrationContract.gateId,
        "integration",
        pipeline.integrationContract.command,
      ) },
      origin: "local",
    });
    if (integrationEvidence.status !== "passed") {
      const retry = this.run.transition("green");
      return retry.ok
        ? err("devloop/tdd-integration-failed", integrationEvidence.reason)
        : retry;
    }

    const confirmedSnapshot = await pipeline.snapshotNow();
    if (snapshotIdentity(snapshot) !== snapshotIdentity(confirmedSnapshot)) {
      const retry = this.run.transition("green");
      return retry.ok
        ? err("devloop/tdd-snapshot-changed", "candidate changed before confirmation rerun")
        : retry;
    }
    const confirmation = await this.gateRunner.run(contract);
    this.gateRuns.push({
      gateId: contract.gateId,
      command: contract.command,
      snapshot: confirmedSnapshot,
      result: confirmation.status === "passed" ? "pass" : "fail",
      ranAt: confirmation.ranAt,
      evidenceRef: { kind: "evidence", id: evidenceId(contract.gateId, "confirm", contract.command) },
      origin: "local",
    });
    if (confirmation.status !== "passed") {
      this.run.markFlaky();
      return err(
        "devloop/tdd-flaky-confirmation",
        "same snapshot changed result during confirmation; stop automatic fixes and hand off to QA",
      );
    }
    const done = this.run.transition("done");
    if (!done.ok) return done;
    return issueCompletionLabel({
      profile: "developer-tdd",
      snapshot,
      gateRuns: this.gateRuns,
      tdd: this.run,
    });
  }

  snapshot(): { state: TddState; contract?: GateContract; lastEvidence?: GateEvidence } {
    return {
      state: this.run.current(),
      ...(this.contract === undefined ? {} : { contract: { ...this.contract } }),
      ...(this.lastEvidence === undefined ? {} : { lastEvidence: { ...this.lastEvidence } }),
    };
  }

  checkpoint(): TddSessionCheckpoint {
    return {
      version: 1,
      run: this.run.checkpoint(),
      ...(this.contract === undefined ? {} : { contract: { ...this.contract } }),
      gateRuns: this.gateRuns.map((run) => structuredClone(run)),
      ...(this.lastEvidence === undefined ? {} : { lastEvidence: structuredClone(this.lastEvidence) }),
    };
  }

  static restore(executor: GateExecutor, value: unknown): TddSessionController | undefined {
    if (!isTddSessionCheckpoint(value)) return undefined;
    const controller = new TddSessionController(executor);
    controller.run = TddRun.restore(value.run);
    controller.contract = value.contract === undefined ? undefined : { ...value.contract };
    controller.gateRuns.push(...value.gateRuns.map((run) => structuredClone(run)));
    controller.lastEvidence = value.lastEvidence === undefined
      ? undefined
      : structuredClone(value.lastEvidence);
    return controller;
  }
}

function snapshotIdentity(snapshot: CandidateSnapshot): string {
  return JSON.stringify([
    snapshot.repo ?? null,
    snapshot.head ?? null,
    snapshot.dirty ?? null,
    snapshot.contentDigest ?? null,
  ]);
}

export interface TddSessionCheckpoint {
  version: 1;
  run: TddRunCheckpoint;
  contract?: GateContract;
  gateRuns: GateRun[];
  lastEvidence?: GateEvidence;
}

function isTddSessionCheckpoint(value: unknown): value is TddSessionCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Partial<TddSessionCheckpoint>;
  if (row.version !== 1 || typeof row.run !== "object" || row.run === null || !Array.isArray(row.gateRuns)) {
    return false;
  }
  const run = row.run as Partial<TddRunCheckpoint>;
  return run.version === 1 &&
    ["spec", "red", "green", "refactor", "gate", "done"].includes(String(run.state)) &&
    typeof run.fixRoundsUsed === "number" && typeof run.reviewerRoundsUsed === "number";
}
