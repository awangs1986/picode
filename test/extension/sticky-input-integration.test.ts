import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerBundledDefaultExtensions } from "../../src/extension/bundled-default-extensions.ts";
import { registerInputCursorBlink } from "../../src/extension/input-cursor-blink.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

describe("bundled sticky input", () => {
  it("loads before session start, anchors the editor, and coexists with Picode cursor policy", async () => {
    const handlers = new Map<string, Handler[]>();
    const commands = new Map<string, unknown>();
    const pi = {
      on(name: string, handler: Handler) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      registerCommand(name: string, command: unknown) { commands.set(name, command); },
    } as unknown as ExtensionAPI;
    const terminalWrites: string[] = [];
    registerInputCursorBlink(pi, {
      isTTY: true,
      write: (value) => { terminalWrites.push(value); },
    });
    registerBundledDefaultExtensions(pi);

    expect(commands.has("sticky-input")).toBe(true);
    const setWidget = vi.fn();
    const unsubscribe = vi.fn();
    const ctx = {
      mode: "tui",
      hasUI: true,
      cwd: "D:/repo",
      isIdle: () => true,
      ui: {
        setWidget,
        onTerminalInput: vi.fn(() => unsubscribe),
        getEditorText: () => "",
        notify: vi.fn(),
      },
    } as unknown as ExtensionContext;
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({ type: "session_start", reason: "startup" }, ctx);
    }

    expect(setWidget).toHaveBeenCalledWith(
      "pi-sticky-input:runtime-renderer-hook",
      expect.any(Function),
      { placement: "belowEditor" },
    );
    expect(terminalWrites.join("")).toContain("\u001b[2 q\u001b[?25h");

    for (const handler of handlers.get("session_shutdown") ?? []) {
      await handler({ type: "session_shutdown", reason: "switch" }, ctx);
    }
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
