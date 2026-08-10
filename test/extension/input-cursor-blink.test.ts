import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  INPUT_TEXT_STATE_SYMBOL,
  InputCursorBlink,
  registerInputCursorBlink,
} from "../../src/extension/input-cursor-blink.ts";

afterEach(() => { vi.useRealTimers(); });

describe("Picode input cursor", () => {
  it("blinks the idle input cursor slowly using a steady terminal cursor", () => {
    vi.useFakeTimers();
    const output: string[] = [];
    const cursor = new InputCursorBlink((sequence) => { output.push(sequence); }, 850);

    cursor.activate();
    expect(output.join("")).toContain("\u001b[2 q\u001b[?25h");

    vi.advanceTimersByTime(849);
    expect(output.join("")).not.toContain("\u001b[?25l");
    vi.advanceTimersByTime(1);
    expect(output.at(-1)).toBe("\u001b[?25l");
    vi.advanceTimersByTime(850);
    expect(output.at(-1)).toBe("\u001b[?25h");

    cursor.deactivate();
  });

  it("keeps the cursor steady while the agent is working and resumes only when idle", () => {
    vi.useFakeTimers();
    const output: string[] = [];
    const cursor = new InputCursorBlink((sequence) => { output.push(sequence); }, 850);
    cursor.activate();
    output.length = 0;

    cursor.setWorking(true);
    vi.advanceTimersByTime(8_500);
    expect(output.join("")).toBe("\u001b[2 q\u001b[?25h");

    cursor.setWorking(false);
    vi.advanceTimersByTime(850);
    expect(output.at(-1)).toBe("\u001b[?25l");
    cursor.deactivate();
  });

  it("resumes blinking while a user edits text during agent work", () => {
    vi.useFakeTimers();
    const output: string[] = [];
    const cursor = new InputCursorBlink((sequence) => { output.push(sequence); }, 850);
    cursor.activate();
    cursor.setWorking(true);
    output.length = 0;

    cursor.setHasInput(true);
    vi.advanceTimersByTime(850);
    expect(output.at(-1)).toBe("\u001b[?25l");

    cursor.setHasInput(false);
    expect(output.at(-1)).toBe("\u001b[2 q\u001b[?25h");
    output.length = 0;
    vi.advanceTimersByTime(8_500);
    expect(output).toEqual([]);
    cursor.deactivate();
  });

  it("wires final editor text and agent lifecycle into the cursor policy", async () => {
    vi.useFakeTimers();
    const output: string[] = [];
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    const pi = {
      on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
        handlers.set(name, handler);
      },
    } as unknown as ExtensionAPI;
    registerInputCursorBlink(pi, {
      isTTY: true,
      phaseMs: 850,
      write: (sequence) => { output.push(sequence); },
    });
    const ctx = { mode: "tui", isIdle: () => true } as ExtensionContext;

    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
    output.length = 0;
    vi.advanceTimersByTime(850);
    expect(output).toEqual([]);

    const inputListener = (globalThis as unknown as Record<symbol, unknown>)[INPUT_TEXT_STATE_SYMBOL];
    expect(inputListener).toBeTypeOf("function");
    (inputListener as (hasInput: boolean) => void)(true);
    vi.advanceTimersByTime(850);
    expect(output.at(-1)).toBe("\u001b[?25l");

    (inputListener as (hasInput: boolean) => void)(false);
    output.length = 0;
    vi.advanceTimersByTime(850);
    expect(output).toEqual([]);

    await handlers.get("agent_end")?.({ type: "agent_end" }, ctx);
    vi.advanceTimersByTime(850);
    expect(output.at(-1)).toBe("\u001b[?25l");
    await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
    expect((globalThis as unknown as Record<symbol, unknown>)[INPUT_TEXT_STATE_SYMBOL]).toBeUndefined();
    expect(output.at(-1)).toBe("\u001b[0 q\u001b[?25h");
  });
});
