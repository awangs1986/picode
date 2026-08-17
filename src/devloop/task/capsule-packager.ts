import type { Result, TaskCapsule } from "../../shared/types.ts";
import { err, ok } from "../../shared/types.ts";
import { estimateContextTextTokens } from "../context/context-budget-meter.ts";
import { renderCapsule } from "./capsule.ts";

export interface CapsuleSemanticDraft {
  decisions: Array<{ decision: string; rationale: string }>;
  failedApproaches: string[];
  nextSteps: string[];
  narrative: string;
}

function boundedStrings(value: unknown, maxItems: number, maxChars: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  for (const item of value.slice(0, maxItems)) {
    if (typeof item !== "string") return undefined;
    const normalized = item.trim();
    if (normalized !== "") result.push(normalized.slice(0, maxChars));
  }
  return result;
}

/** Parse an untrusted model proposal. Only this small semantic shape is admitted. */
export function parseCapsuleSemanticDraft(text: string): Result<CapsuleSemanticDraft> {
  const trimmed = text.trim();
  const body = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "")
    : trimmed;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (cause) {
    return err("devloop/capsule-semantic-json-invalid", "current-session model did not return valid Capsule JSON", cause);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err("devloop/capsule-semantic-shape-invalid", "Capsule semantic package must be a JSON object");
  }
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.decisions)) {
    return err("devloop/capsule-semantic-shape-invalid", "Capsule decisions must be an array");
  }
  const decisions: CapsuleSemanticDraft["decisions"] = [];
  for (const item of row.decisions.slice(0, 20)) {
    if (typeof item !== "object" || item === null) {
      return err("devloop/capsule-semantic-shape-invalid", "Capsule decision entries must be objects");
    }
    const decision = (item as Record<string, unknown>).decision;
    const rationale = (item as Record<string, unknown>).rationale;
    if (typeof decision !== "string" || typeof rationale !== "string") {
      return err("devloop/capsule-semantic-shape-invalid", "Capsule decisions require decision and rationale strings");
    }
    if (decision.trim() !== "") {
      decisions.push({ decision: decision.trim().slice(0, 1_000), rationale: rationale.trim().slice(0, 1_000) });
    }
  }
  const failedApproaches = boundedStrings(row.failedApproaches, 20, 1_500);
  const nextSteps = boundedStrings(row.nextSteps, 20, 1_000);
  if (failedApproaches === undefined || nextSteps === undefined || typeof row.narrative !== "string") {
    return err("devloop/capsule-semantic-shape-invalid", "Capsule semantic fields are missing or invalid");
  }
  return ok({
    decisions,
    failedApproaches,
    nextSteps,
    narrative: row.narrative.trim().slice(0, 12_000),
  });
}

/** Best-effort deterministic redaction before a transcript is sent to the packing call. */
export function redactCapsuleSecrets(text: string): string {
  return text
    .replace(/\b(authorization\s*:\s*bearer)\s+[^\s,;]+/giu, "$1 [REDACTED]")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\b(\s*[=:]\s*)["']?[^\s,"'};]+["']?/giu, "$1$2[REDACTED]")
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED]");
}

export function fitCapsuleBudget(
  capsule: TaskCapsule,
  limits: { targetTokens?: number; hardTokens?: number } = {},
): Result<{ capsule: TaskCapsule; estimatedTokens: number; narrativeTrimmed: boolean }> {
  const targetTokens = Math.max(512, limits.targetTokens ?? 6_000);
  const hardTokens = Math.max(targetTokens, limits.hardTokens ?? 8_000);
  const mandatory = { ...capsule, narrative: "" };
  const mandatoryTokens = estimateContextTextTokens(renderCapsule(mandatory));
  if (mandatoryTokens > hardTokens) {
    return err(
      "devloop/capsule-mandatory-budget-exceeded",
      `mandatory Capsule facts require about ${mandatoryTokens} tokens (hard limit ${hardTokens})`,
    );
  }
  const initialTokens = estimateContextTextTokens(renderCapsule(capsule));
  if (initialTokens <= targetTokens) {
    return ok({ capsule, estimatedTokens: initialTokens, narrativeTrimmed: false });
  }

  let low = 0;
  let high = capsule.narrative.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = { ...capsule, narrative: capsule.narrative.slice(0, mid) };
    if (estimateContextTextTokens(renderCapsule(candidate)) <= targetTokens) low = mid;
    else high = mid - 1;
  }
  const fitted = {
    ...capsule,
    narrative: low === capsule.narrative.length
      ? capsule.narrative
      : `${capsule.narrative.slice(0, Math.max(0, low - 24)).trimEnd()}\n[truncated to Capsule budget]`,
  };
  const estimatedTokens = estimateContextTextTokens(renderCapsule(fitted));
  if (estimatedTokens > hardTokens) {
    return err("devloop/capsule-budget-exceeded", `Capsule requires about ${estimatedTokens} tokens`);
  }
  return ok({ capsule: fitted, estimatedTokens, narrativeTrimmed: true });
}
