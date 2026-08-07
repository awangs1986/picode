import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { RuntimeEnvelopeIngress } from "../../src/extension/runtime-envelope.ts";

const identity = { executionEpoch: 3, runId: "run-a", requestId: "request-a" };

describe("RuntimeEnvelopeIngress", () => {
  it("dispatches only admitted typed events and never exposes late raw frames to observers", () => {
    const ingress = new RuntimeEnvelopeIngress();
    const observer = vi.fn();
    const identity = { executionEpoch: 4, runId: "run-a" };
    ingress.dispatch(JSON.stringify({ version: 1, eventId: "cancel", kind: "run.cancelled", payload: {} }), identity, observer);
    const rejected = ingress.dispatch(
      JSON.stringify({ version: 1, eventId: "late", kind: "tool.result", payload: { secret: "must-not-leak" } }),
      identity,
      observer,
    );
    expect(rejected).toMatchObject({ admitted: false, reason: "late-after-terminal" });
    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer).not.toHaveBeenCalledWith(expect.objectContaining({ eventId: "late" }));
  });

  it("rejects every result for the same execution identity after cancellation", () => {
    const ingress = new RuntimeEnvelopeIngress();

    const cancelled = ingress.admit(
      JSON.stringify({ version: 1, eventId: "e1", kind: "run.cancelled", payload: {} }),
      identity,
    );
    const lateResult = ingress.admit(
      JSON.stringify({
        version: 1,
        eventId: "e2",
        kind: "tool.result",
        sequence: 999,
        payload: { text: "late" },
      }),
      identity,
    );

    expect(cancelled).toMatchObject({ admitted: true });
    expect(lateResult).toEqual({
      admitted: false,
      reason: "late-after-terminal",
      identity,
      eventId: "e2",
    });
  });

  it("keeps a run terminal even when a late result claims a different request id", () => {
    const ingress = new RuntimeEnvelopeIngress();
    ingress.admit(
      JSON.stringify({ version: 1, eventId: "cancel", kind: "run.cancelled", payload: {} }),
      identity,
    );

    const late = ingress.admit(
      JSON.stringify({ version: 1, eventId: "late", kind: "tool.result", payload: {} }),
      { ...identity, requestId: "request-b" },
    );

    expect(late).toMatchObject({ admitted: false, reason: "late-after-terminal" });
  });

  it("returns a replayable diagnostic for malformed JSON instead of throwing", () => {
    const ingress = new RuntimeEnvelopeIngress();

    const result = ingress.admit("{not-json", identity);

    expect(result).toEqual({
      admitted: false,
      reason: "malformed",
      identity,
      diagnostic: { code: "invalid-json", rawPreview: "{not-json" },
    });
  });

  it("rejects an oversized frame before parsing it", () => {
    const ingress = new RuntimeEnvelopeIngress(16);
    const raw = JSON.stringify({ version: 1, eventId: "large", kind: "tool.result", payload: {} });

    const result = ingress.admit(raw, identity);

    expect(result).toEqual({
      admitted: false,
      reason: "malformed",
      identity,
      diagnostic: { code: "frame-too-large", byteLength: raw.length, maxBytes: 16 },
    });
  });

  it("distinguishes invalid UTF-8 bytes from invalid JSON", () => {
    const ingress = new RuntimeEnvelopeIngress();

    const result = ingress.admit(new Uint8Array([0xc3, 0x28]), identity);

    expect(result).toEqual({
      admitted: false,
      reason: "malformed",
      identity,
      diagnostic: { code: "invalid-utf8", byteLength: 2 },
    });
  });

  it("rejects an unsupported envelope version", () => {
    const ingress = new RuntimeEnvelopeIngress();

    const result = ingress.admit(
      JSON.stringify({ version: 2, eventId: "future", kind: "tool.result", payload: {} }),
      identity,
    );

    expect(result).toEqual({
      admitted: false,
      reason: "malformed",
      identity,
      diagnostic: { code: "unsupported-version", received: 2 },
    });
  });

  it("rejects a versioned envelope with missing required fields", () => {
    const ingress = new RuntimeEnvelopeIngress();

    const result = ingress.admit(
      JSON.stringify({ version: 1, kind: "tool.result", payload: {} }),
      identity,
    );

    expect(result).toEqual({
      admitted: false,
      reason: "malformed",
      identity,
      diagnostic: { code: "invalid-shape", fields: ["eventId"] },
    });
  });

  it("rejects a duplicate event id within the same run", () => {
    const ingress = new RuntimeEnvelopeIngress();
    const raw = JSON.stringify({ version: 1, eventId: "same", kind: "tool.result", payload: {} });

    expect(ingress.admit(raw, identity)).toMatchObject({ admitted: true });
    expect(ingress.admit(raw, identity)).toEqual({
      admitted: false,
      reason: "duplicate-event",
      identity,
      eventId: "same",
    });
  });
});
