import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { TuiControlDriver } from "../../src/extension/tui-control-driver.ts";

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const values: unknown[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

function fixture() {
  const sendUserMessage = vi.fn();
  const abort = vi.fn();
  const setThinkingLevel = vi.fn();
  const model = { provider: "openai", id: "gpt-test", name: "Test" };
  const pi = {
    sendUserMessage,
    getThinkingLevel: () => "high",
    setThinkingLevel,
    setModel: vi.fn(async () => true),
  } as unknown as ExtensionAPI;
  const context = {
    cwd: "D:\\repo",
    isIdle: () => true,
    waitForIdle: vi.fn(async () => undefined),
    abort,
    model,
    modelRegistry: {
      getAvailable: () => [model],
      find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
    },
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => "D:\\sessions\\session-1.jsonl",
    },
  } as unknown as ExtensionCommandContext;
  const driver = new TuiControlDriver({ packageRoot: "D:\\package", piEntry: "pi.js", cwd: context.cwd }, pi, context);
  return { driver, sendUserMessage, abort, setThinkingLevel };
}

describe("TUI-bound remote Control authority", () => {
  it("runs a remote turn through the already-running Pi TUI", async () => {
    const { driver, sendUserMessage } = fixture();
    const events = await collect(driver.run({
      prompt: "continue",
      session: "session-1",
      cwd: "D:\\repo",
      nonInteractive: false,
    }));

    expect(sendUserMessage).toHaveBeenCalledWith("continue");
    expect(events).toMatchObject([
      { kind: "run.started", payload: { sessionId: "session-1" } },
      { kind: "run.completed", payload: { sessionId: "session-1" } },
    ]);
  });

  it("rejects another Chat, another workspace, and remote policy changes", async () => {
    const { driver, sendUserMessage } = fixture();
    const wrongSession = await collect(driver.run({ prompt: "x", session: "other", nonInteractive: false }));
    const wrongWorkspace = await collect(driver.run({ prompt: "x", cwd: "D:\\other", nonInteractive: false }));
    const policyChange = await collect(driver.run({ prompt: "x", harnessTier: "tdd", nonInteractive: false }));

    expect(wrongSession).toMatchObject([{ kind: "run.error" }]);
    expect(wrongWorkspace).toMatchObject([{ kind: "run.error" }]);
    expect(policyChange).toMatchObject([{ kind: "run.error" }]);
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("changes model settings only through the active Pi authority", async () => {
    const { driver, setThinkingLevel } = fixture();
    await driver.setSessionThinking("session-1", "xhigh");
    const selected = await driver.setSessionModel("session-1", "openai", "gpt-test");

    expect(setThinkingLevel).toHaveBeenCalledWith("xhigh");
    expect(selected).toMatchObject({ model: { provider: "openai", id: "gpt-test" } });
  });
});
