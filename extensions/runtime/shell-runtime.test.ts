import { describe, expect, test } from "vitest";
import {
  BoundedShellOutput,
  buildShellFrame,
  PersistentShellPool,
  resolvePersistentShell,
} from "./shell-runtime";

describe("Picode persistent shell runtime", () => {
  test("builds a state-preserving bash frame with cwd, environment, and status marker", () => {
    const frame = buildShellFrame(
      { kind: "bash" },
      { command: "printf hello", cwd: "/tmp/a b", env: { MODE: "test'value" } },
      "__MARK__",
    );
    expect(frame).toContain("cd -- '/tmp/a b'");
    expect(frame).toContain("export MODE='test'\"'\"'value'");
    expect(frame).toContain("printf hello");
    expect(frame).toContain("__MARK__:%s");
  });

  test("encodes PowerShell commands instead of interpolating user code into the control frame", () => {
    const frame = buildShellFrame(
      { kind: "powershell" },
      { command: "Write-Output '__MARK__:99'", cwd: "C:\\work" },
      "__MARK__",
    );
    expect(frame).toContain("FromBase64String");
    expect(frame).not.toContain("Write-Output '__MARK__:99'");
    expect(frame).toContain("Write-Output ('__MARK__:' + $s)");
  });

  test("rejects unsafe environment names", () => {
    expect(() =>
      buildShellFrame(
        { kind: "bash" },
        { command: "true", env: { "BAD-NAME": "value" } },
        "__MARK__",
      ),
    ).toThrow("Invalid environment variable name");
  });

  test("retains a bounded tail and reports truncation", () => {
    const output = new BoundedShellOutput(5);
    output.append("abc");
    output.append("defg");
    expect(output.totalBytes).toBe(7);
    expect(output.truncated).toBe(true);
    expect(output.text()).toBe("cdefg");
  });

  test("retains environment state across real shell calls", async () => {
    const descriptor = resolvePersistentShell();
    const pool = new PersistentShellPool(descriptor);
    try {
      await pool.execute("integration", process.cwd(), {
        command: descriptor.kind === "bash" ? "printf initialized" : "echo initialized",
        env: { PICODE_PERSIST_TEST: "retained-value" },
        timeout: 10,
      });
      const command =
        descriptor.kind === "bash"
          ? 'printf "$PICODE_PERSIST_TEST"'
          : descriptor.kind === "powershell"
            ? "Write-Output $env:PICODE_PERSIST_TEST"
            : "echo %PICODE_PERSIST_TEST%";
      const result = await pool.execute("integration", process.cwd(), { command, timeout: 10 });
      expect(result.output).toContain("retained-value");
      expect(result.reusedSession).toBe(true);
    } finally {
      pool.dispose();
    }
  });
});
