const PHASES = {
  working: new Set(["starting", "running", "modelWait", "toolWait", "queued", "spawned"]),
  needsInput: new Set(["userWait", "permissionWait", "waitingForUser"]),
  verifying: new Set(["verifying", "gateWait", "checking", "validation"]),
  completed: new Set(["completed"]),
  paused: new Set(["cancelled", "terminated", "timedOut", "resourceStopped"]),
  notCompleted: new Set(["failed", "suspectedStall", "unresponsive"]),
};

const FALLBACK_LABELS = Object.freeze({
  working: "Working",
  needsInput: "Waiting for you",
  verifying: "Verifying",
  completed: "Completed",
  paused: "Paused",
  notCompleted: "Not completed",
});

export function presentWorkState(rawState) {
  const normalized = String(rawState || "").trim();
  const phase =
    Object.entries(PHASES).find(([, states]) => states.has(normalized))?.[0] || "working";
  return {
    phase,
    labelKey: `workState.${phase}`,
    fallbackLabel: FALLBACK_LABELS[phase],
    rawState: normalized || "unknown",
  };
}
