import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STEADY_BLOCK = "\u001b[2 q";
const DEFAULT_CURSOR = "\u001b[0 q";
const SHOW_CURSOR = "\u001b[?25h";
const HIDE_CURSOR = "\u001b[?25l";
export const INPUT_TEXT_STATE_SYMBOL = Symbol.for("picode.input-text-state");

type SymbolRecord = Record<symbol, unknown>;

export interface InputCursorBlinkHost {
  readonly isTTY?: boolean;
  readonly phaseMs?: number;
  readonly write?: (sequence: string) => void;
}

/** Owns Picode's interactive input-cursor presentation and nothing else. */
export class InputCursorBlink {
  private timer: ReturnType<typeof setInterval> | undefined;
  private visible = true;
  private active = false;
  private working = false;
  private hasInput = false;

  constructor(
    private readonly write: (sequence: string) => void,
    private readonly phaseMs = 850,
  ) {}

  activate(): void {
    if (this.active) return;
    this.active = true;
    this.visible = true;
    this.write(`${STEADY_BLOCK}${SHOW_CURSOR}`);
    this.startBlinking();
  }

  setWorking(working: boolean): void {
    if (!this.active) return;
    this.working = working;
    this.reconcile();
  }

  setHasInput(hasInput: boolean): void {
    if (!this.active) return;
    this.hasInput = hasInput;
    this.reconcile();
  }

  private reconcile(): void {
    if (!this.working || this.hasInput) {
      this.startBlinking();
      return;
    }
    this.stopBlinking();
    this.visible = true;
    this.write(`${STEADY_BLOCK}${SHOW_CURSOR}`);
  }

  private startBlinking(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      this.visible = !this.visible;
      this.write(this.visible ? SHOW_CURSOR : HIDE_CURSOR);
    }, this.phaseMs);
    this.timer.unref?.();
  }

  private stopBlinking(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  deactivate(): void {
    this.stopBlinking();
    this.active = false;
    this.working = false;
    this.hasInput = false;
    this.visible = true;
    this.write(`${DEFAULT_CURSOR}${SHOW_CURSOR}`);
  }
}

/**
 * Connects Pi lifecycle events and the tiny vendored editor-text notification
 * seam to Picode's cursor policy. Non-TUI modes never touch terminal state.
 */
export function registerInputCursorBlink(
  pi: ExtensionAPI,
  host: InputCursorBlinkHost = {},
): InputCursorBlink {
  const write = host.write ?? ((sequence: string) => { process.stdout.write(sequence); });
  const cursor = new InputCursorBlink(write, host.phaseMs);
  const globals = globalThis as unknown as SymbolRecord;
  let tuiActive = false;

  const inputListener = (hasInput: boolean): void => {
    cursor.setHasInput(hasInput);
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || (host.isTTY ?? process.stdout.isTTY) !== true) return;
    tuiActive = true;
    globals[INPUT_TEXT_STATE_SYMBOL] = inputListener;
    cursor.activate();
    cursor.setWorking(!ctx.isIdle());
  });
  pi.on("agent_start", () => {
    if (tuiActive) cursor.setWorking(true);
  });
  pi.on("agent_end", () => {
    if (tuiActive) cursor.setWorking(false);
  });
  pi.on("session_shutdown", () => {
    if (!tuiActive) return;
    if (globals[INPUT_TEXT_STATE_SYMBOL] === inputListener) {
      delete globals[INPUT_TEXT_STATE_SYMBOL];
    }
    tuiActive = false;
    cursor.deactivate();
  });

  return cursor;
}
