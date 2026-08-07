import type { Result } from "../../shared/types.ts";
import { err, ok } from "../../shared/types.ts";
import type { CandidateSnapshot, GateRun } from "./gate.ts";
import { detectFlaky, effectiveResults } from "./gate.ts";
import type { TddRun } from "./tdd.ts";

/**
 * Completion Label（MODULES.md 保留条款 ①：verify/ 唯一签发）。
 * 对本地开发验证结果和风险的准确说明；不等于 QA、CI 或发布认证。
 */

export interface CompletionLabel {
  verificationProfile: "none" | "quick-review" | "developer-tdd";
  snapshot: CandidateSnapshot;
  gatesPassed: string[];
  gatesFailed: string[];
  flakyGates: string[];
  risks: string[];
  issuedAt: string;
}

export function issueCompletionLabel(input: {
  profile: CompletionLabel["verificationProfile"];
  snapshot: CandidateSnapshot;
  gateRuns: readonly GateRun[];
  tdd?: TddRun;
}): Result<CompletionLabel> {
  // developer-tdd 档：状态机必须走到 done 且无预算终局
  if (input.profile === "developer-tdd") {
    if (input.tdd === undefined) {
      return err("devloop/label-missing-tdd", "developer-tdd label requires a TddRun");
    }
    const outcome = input.tdd.budgetOutcome();
    if (outcome !== undefined) {
      return err(
        "devloop/label-budget-outcome",
        `cannot issue completion label: run ended with ${outcome}`,
      );
    }
    if (input.tdd.current() !== "done") {
      return err(
        "devloop/label-tdd-incomplete",
        `tdd state machine at ${input.tdd.current()}, not done`,
      );
    }
  }

  const effective = effectiveResults(input.gateRuns, input.snapshot);
  const gatesPassed = [...effective.entries()].filter(([, r]) => r === "pass").map(([g]) => g);
  const gatesFailed = [...effective.entries()].filter(([, r]) => r === "fail").map(([g]) => g);
  const flakyGates = detectFlaky(input.gateRuns);

  if (input.profile === "developer-tdd" && gatesFailed.length > 0) {
    return err(
      "devloop/label-gates-failing",
      `cannot issue developer-tdd label with failing gates: ${gatesFailed.join(", ")}`,
    );
  }

  const risks: string[] = [];
  if (flakyGates.length > 0) risks.push(`flaky gates: ${flakyGates.join(", ")}`);
  if (input.gateRuns.some((r) => r.origin === "imported")) {
    risks.push("imported claims present; not counted as current gate evidence");
  }
  if (input.snapshot.dirty === true) risks.push("snapshot has uncommitted changes");

  return ok({
    verificationProfile: input.profile,
    snapshot: input.snapshot,
    gatesPassed,
    gatesFailed,
    flakyGates,
    risks,
    issuedAt: new Date().toISOString(),
  });
}
