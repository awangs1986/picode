import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Guard } from "../guard/index.ts";
import type { OperationIntent } from "../shared/types.ts";

const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow exact command for this session";
const ALLOW_SESSION_ROUTINE = "Allow routine operations for this session (destructive/Git still ask)";
const ALLOW_SESSION_UNRESTRICTED = "Danger: allow everything for this session (no more prompts)";
const ALLOW_GLOBAL = "Always allow this command prefix";
const DENY = "Deny";

export type ApprovalOutcome = "once" | "session" | "session-full" | "session-unrestricted" | "global" | "denied";

/** User-owned approval UX; models can trigger it but cannot choose the answer. */
export async function requestIntentApproval(
  ui: ExtensionUIContext,
  guard: Guard,
  intent: OperationIntent,
  reason: string,
): Promise<boolean> {
  return (await resolveIntentApproval(ui, guard, intent, reason)) !== "denied";
}

export async function resolveIntentApproval(
  ui: ExtensionUIContext,
  guard: Guard,
  intent: OperationIntent,
  reason: string,
): Promise<ApprovalOutcome> {
  const choices = [ALLOW_ONCE, ALLOW_SESSION, ALLOW_SESSION_ROUTINE, ALLOW_SESSION_UNRESTRICTED];
  if (intent.category === "exec" && intent.command !== undefined) choices.push(ALLOW_GLOBAL);
  choices.push(DENY);
  const selected = await ui.select(`Picode permission · ${reason}`, choices);
  if (selected === ALLOW_ONCE) return "once";
  if (selected === ALLOW_SESSION) {
    const added = await guard.grants.add({
      kind: "fingerprint",
      value: guard.fingerprintOf(intent),
      scope: "session",
    });
    return added.ok ? "session" : "denied";
  }
  if (selected === ALLOW_SESSION_ROUTINE) {
    guard.setTier("full");
    return "session-full";
  }
  if (selected === ALLOW_SESSION_UNRESTRICTED) {
    guard.setTier("danger-full-access");
    return "session-unrestricted";
  }
  if (selected === ALLOW_GLOBAL && intent.command !== undefined) {
    const added = await guard.grants.add({
      kind: "pattern",
      value: intent.command,
      scope: "global",
    });
    return added.ok ? "global" : "denied";
  }
  return "denied";
}
