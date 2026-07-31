import { afterEach, describe, expect, test } from "vitest";
import { PersistentEvalRuntime, resolvePythonExecutable } from "./eval-runtime";

const runtimes: PersistentEvalRuntime[] = [];

afterEach(() => {
  for (const runtime of runtimes) runtime.dispose();
  runtimes.length = 0;
});

describe("Picode persistent eval runtime", () => {
  test("retains JavaScript lexical state across cells and calls", async () => {
    const runtime = new PersistentEvalRuntime();
    runtimes.push(runtime);
    const first = await runtime.execute("session-a", [
      { language: "js", code: "const base = 40; base + 1" },
    ]);
    const second = await runtime.execute("session-a", [{ language: "js", code: "base + 2" }]);
    expect(first[0]).toMatchObject({ isError: false, value: 41 });
    expect(second[0]).toMatchObject({ isError: false, value: 42 });
  });

  test("keeps sessions isolated and supports reset", async () => {
    const runtime = new PersistentEvalRuntime();
    runtimes.push(runtime);
    await runtime.execute("session-a", [{ language: "js", code: "var token = 7" }]);
    const isolated = await runtime.execute("session-b", [{ language: "js", code: "typeof token" }]);
    const reset = await runtime.execute("session-a", [
      { language: "js", code: "typeof token", reset: true },
    ]);
    expect(isolated[0].value).toBe("undefined");
    expect(reset[0].value).toBe("undefined");
  });

  test("stops subsequent cells after an error", async () => {
    const runtime = new PersistentEvalRuntime();
    runtimes.push(runtime);
    const results = await runtime.execute("session-a", [
      { language: "js", code: "throw new Error('boom')" },
      { language: "js", code: "21 * 2" },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    expect(results[0].output).toContain("boom");
  });

  test("retains Python state when Python 3 is available", async () => {
    if (!resolvePythonExecutable()) return;
    const runtime = new PersistentEvalRuntime();
    runtimes.push(runtime);
    const first = await runtime.execute("python-session", [
      { language: "py", code: "base = 40\nbase + 1" },
    ]);
    const second = await runtime.execute("python-session", [{ language: "py", code: "base + 2" }]);
    expect(first[0]).toMatchObject({ isError: false, value: 41 });
    expect(second[0]).toMatchObject({ isError: false, value: 42 });
  });

  test("supports Python top-level await while retaining state", async () => {
    if (!resolvePythonExecutable()) return;
    const runtime = new PersistentEvalRuntime();
    runtimes.push(runtime);
    const awaited = await runtime.execute("python-async-session", [
      {
        language: "py",
        code: ["import asyncio", "base = 40", "await asyncio.sleep(0.01)", "base + 1"].join("\n"),
      },
    ]);
    const resumed = await runtime.execute("python-async-session", [
      { language: "py", code: "await asyncio.sleep(0.01)\nbase + 2" },
    ]);
    expect(awaited[0]).toMatchObject({ isError: false, value: 41 });
    expect(resumed[0]).toMatchObject({ isError: false, value: 42 });
  });
});
