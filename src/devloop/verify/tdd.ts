import type { Result, SourceRef } from "../../shared/types.ts";
import { err, ok } from "../../shared/types.ts";

/**
 * TDD 状态机与 Verification Budget（MODULES.md §3.3，数值 P3 定稿）：
 * spec → red → green → refactor → gate → done
 * recorded RED 先于实现写入：进入 green 必须持有 red 阶段的失败证据指针。
 * 预算超限 → Flaky / Needs Decision / QA Handoff（不硬闯）。
 */

export type TddState = "spec" | "red" | "green" | "refactor" | "gate" | "done";

export type BudgetOutcome = "flaky" | "needs-decision" | "qa-handoff";

export interface TddRunCheckpoint {
  version: 1;
  state: TddState;
  recordedRed?: SourceRef;
  fixRoundsUsed: number;
  reviewerRoundsUsed: number;
  outcome?: BudgetOutcome;
}

/** P3 定稿数值（Q16 默认 + 本期确认；改动须过设计文档） */
export const TDD_BUDGET = {
  fixRounds: 2,
  reviewerRounds: 1,
  integrationSmoke: 1,
  confirmRerun: 1,
} as const;

const TRANSITIONS: Record<TddState, TddState[]> = {
  spec: ["red"],
  red: ["green"],
  green: ["refactor", "gate"], // refactor 可跳过
  refactor: ["gate"],
  gate: ["done", "green"], // gate 失败回 green 修复（消耗 fixRound）
  done: [],
};

export class TddRun {
  private state: TddState = "spec";
  private recordedRed: SourceRef | undefined;
  private fixRoundsUsed = 0;
  private reviewerRoundsUsed = 0;
  private outcome: BudgetOutcome | undefined;

  current(): TddState {
    return this.state;
  }

  budgetOutcome(): BudgetOutcome | undefined {
    return this.outcome;
  }

  recordedRedRef(): SourceRef | undefined {
    return this.recordedRed;
  }

  /**
   * red 阶段登记失败测试证据（recorded RED）。
   * 只在 red 状态可登记；证据必须先于实现存在。
   */
  recordRed(evidence: SourceRef): Result<void> {
    if (this.state !== "red") {
      return err("devloop/tdd-not-red", `recordRed only valid in red state (now ${this.state})`);
    }
    this.recordedRed = evidence;
    return ok(undefined);
  }

  transition(to: TddState): Result<TddState> {
    if (this.outcome !== undefined) {
      return err("devloop/tdd-budget-exhausted", `run ended with outcome ${this.outcome}`);
    }
    if (!TRANSITIONS[this.state].includes(to)) {
      return err(
        "devloop/tdd-illegal-transition",
        `cannot transition ${this.state} → ${to}`,
      );
    }
    if (to === "green" && this.state === "red" && this.recordedRed === undefined) {
      return err(
        "devloop/tdd-red-not-recorded",
        "recorded RED evidence required before implementation (green)",
      );
    }
    if (to === "green" && this.state === "gate") {
      // gate 失败回修：消耗 fixRound；超预算 → needs-decision
      this.fixRoundsUsed += 1;
      if (this.fixRoundsUsed > TDD_BUDGET.fixRounds) {
        this.outcome = "needs-decision";
        return err(
          "devloop/tdd-fix-budget-exceeded",
          `fix rounds exceeded (${TDD_BUDGET.fixRounds}); outcome: needs-decision`,
        );
      }
    }
    this.state = to;
    return ok(this.state);
  }

  /** Reviewer（watchdog 强配置）轮次记账 */
  useReviewerRound(): Result<void> {
    this.reviewerRoundsUsed += 1;
    if (this.reviewerRoundsUsed > TDD_BUDGET.reviewerRounds) {
      this.outcome = "needs-decision";
      return err(
        "devloop/tdd-reviewer-budget-exceeded",
        `reviewer rounds exceeded (${TDD_BUDGET.reviewerRounds}); outcome: needs-decision`,
      );
    }
    return ok(undefined);
  }

  /** Flaky Gate 检出 / 无法本地裁决 → 显式终局，不硬闯 */
  markFlaky(): void {
    this.outcome = "flaky";
  }

  markQaHandoff(): void {
    this.outcome = "qa-handoff";
  }

  usage(): { fixRoundsUsed: number; reviewerRoundsUsed: number } {
    return { fixRoundsUsed: this.fixRoundsUsed, reviewerRoundsUsed: this.reviewerRoundsUsed };
  }

  checkpoint(): TddRunCheckpoint {
    return {
      version: 1,
      state: this.state,
      ...(this.recordedRed === undefined ? {} : { recordedRed: { ...this.recordedRed } }),
      fixRoundsUsed: this.fixRoundsUsed,
      reviewerRoundsUsed: this.reviewerRoundsUsed,
      ...(this.outcome === undefined ? {} : { outcome: this.outcome }),
    };
  }

  static restore(checkpoint: TddRunCheckpoint): TddRun {
    const run = new TddRun();
    run.state = checkpoint.state;
    run.recordedRed = checkpoint.recordedRed === undefined ? undefined : { ...checkpoint.recordedRed };
    run.fixRoundsUsed = checkpoint.fixRoundsUsed;
    run.reviewerRoundsUsed = checkpoint.reviewerRoundsUsed;
    run.outcome = checkpoint.outcome;
    return run;
  }
}
