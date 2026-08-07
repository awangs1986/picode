export interface ExecutionIdentity {
  executionEpoch: number;
  runId: string;
  requestId?: string;
}

export interface RuntimeEnvelope {
  version: 1;
  eventId: string;
  kind: string;
  sequence?: number;
  payload: unknown;
}

export type RuntimeEnvelopeDiagnostic =
  | { code: "invalid-json"; rawPreview: string }
  | { code: "invalid-utf8"; byteLength: number }
  | { code: "frame-too-large"; byteLength: number; maxBytes: number }
  | { code: "unsupported-version"; received: unknown }
  | { code: "invalid-shape"; fields: string[] };

export type RuntimeEnvelopeAdmission =
  | { admitted: true; identity: ExecutionIdentity; event: RuntimeEnvelope }
  | {
      admitted: false;
      reason: "late-after-terminal" | "duplicate-event";
      identity: ExecutionIdentity;
      eventId: string;
    }
  | {
      admitted: false;
      reason: "malformed";
      identity: ExecutionIdentity;
      diagnostic: RuntimeEnvelopeDiagnostic;
    };

const terminalKinds = new Set(["run.cancelled", "run.completed", "run.failed"]);

function identityKey(identity: ExecutionIdentity): string {
  return JSON.stringify([identity.executionEpoch, identity.runId]);
}

export class RuntimeEnvelopeIngress {
  private readonly terminalExecutions = new Set<string>();
  private readonly seenEvents = new Set<string>();

  constructor(private readonly maxBytes = 1024 * 1024) {}

  dispatch(
    raw: string | Uint8Array,
    identity: ExecutionIdentity,
    observer: (event: RuntimeEnvelope, identity: ExecutionIdentity) => void,
  ): RuntimeEnvelopeAdmission {
    const admission = this.admit(raw, identity);
    if (admission.admitted) observer(admission.event, admission.identity);
    return admission;
  }

  admit(raw: string | Uint8Array, identity: ExecutionIdentity): RuntimeEnvelopeAdmission {
    const byteLength = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
    if (byteLength > this.maxBytes) {
      return {
        admitted: false,
        reason: "malformed",
        identity,
        diagnostic: { code: "frame-too-large", byteLength, maxBytes: this.maxBytes },
      };
    }
    let text: string;
    try {
      text = typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      return {
        admitted: false,
        reason: "malformed",
        identity,
        diagnostic: { code: "invalid-utf8", byteLength },
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return {
        admitted: false,
        reason: "malformed",
        identity,
        diagnostic: { code: "invalid-json", rawPreview: text.slice(0, 160) },
      };
    }
    const receivedVersion =
      typeof parsed === "object" && parsed !== null && "version" in parsed
        ? parsed.version
        : undefined;
    if (receivedVersion !== 1) {
      return {
        admitted: false,
        reason: "malformed",
        identity,
        diagnostic: { code: "unsupported-version", received: receivedVersion },
      };
    }
    const record = parsed as Record<string, unknown>;
    const invalidFields: string[] = [];
    if (typeof record.eventId !== "string" || record.eventId.length === 0) {
      invalidFields.push("eventId");
    }
    if (typeof record.kind !== "string" || record.kind.length === 0) invalidFields.push("kind");
    if (!("payload" in record)) invalidFields.push("payload");
    if (invalidFields.length > 0) {
      return {
        admitted: false,
        reason: "malformed",
        identity,
        diagnostic: { code: "invalid-shape", fields: invalidFields },
      };
    }
    const event = parsed as RuntimeEnvelope;
    const key = identityKey(identity);
    const eventKey = `${key}\u0000${event.eventId}`;
    if (this.seenEvents.has(eventKey)) {
      return {
        admitted: false,
        reason: "duplicate-event",
        identity,
        eventId: event.eventId,
      };
    }
    if (this.terminalExecutions.has(key)) {
      return {
        admitted: false,
        reason: "late-after-terminal",
        identity,
        eventId: event.eventId,
      };
    }
    this.seenEvents.add(eventKey);
    if (terminalKinds.has(event.kind)) this.terminalExecutions.add(key);
    return { admitted: true, identity, event };
  }
}
