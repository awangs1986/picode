import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Guard } from "../guard/index.ts";
import type { OperationIntent } from "../shared/types.ts";

const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow exact command for this session";
const ALLOW_GLOBAL = "Always allow this command prefix";
const DENY = "Deny";

export type ApprovalOutcome = "once" | "session" | "global" | "denied";

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
  const choices = [ALLOW_ONCE, ALLOW_SESSION];
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
