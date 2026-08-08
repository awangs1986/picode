import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWindowsPowerShellOperations,
  createWindowsPowerShellProvider,
} from "../../src/extension/windows-shell-provider.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

describe("Windows Landstrip PowerShell provider", () => {
  it("keeps secrets out of the launcher environment and supplies Windows bootstrap variables", async () => {
    await withTempPicodeDir(async (dir) => {
      const provider = createWindowsPowerShellProvider({
        SystemRoot: "C:\\Windows",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        PATH: "C:\\Windows\\System32",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        ProgramData: "C:\\ProgramData",
        TEMP: "C:\\Temp",
        TMP: "C:\\Temp",
        USERPROFILE: "C:\\Users\\tester",
      }, dir);

      const invocation = await provider.prepare({
        command: "Get-ChildItem -Name",
        cwd: "C:\\repo",
        env: { SECRET_TOKEN: "do-not-put-in-launcher", NORMAL: "value" },
      });

      expect(invocation.executable).toBe(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      );
      expect(invocation.launcherEnv).toMatchObject({
        SystemRoot: "C:\\Windows",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        TEMP: "C:\\Temp",
      });
      expect(invocation.launcherEnv.SECRET_TOKEN).toBeUndefined();
      expect(invocation.readPaths).toHaveLength(2);
      const environmentFile = invocation.readPaths?.find((path) => path.endsWith("environment.json"));
      const commandFile = invocation.readPaths?.find((path) => path.endsWith("command.ps1"));
      expect(environmentFile).toBeDefined();
      expect(commandFile).toBeDefined();
      expect(JSON.parse(readFileSync(environmentFile!, "utf8"))).toMatchObject({
        SECRET_TOKEN: "do-not-put-in-launcher",
        NORMAL: "value",
      });
      expect(readFileSync(commandFile!, "utf8")).toContain("Get-ChildItem -Name");
      expect(readFileSync(commandFile!, "utf8")).toContain("Set-Location -LiteralPath 'C:\\repo'");

      await invocation.dispose?.();
      expect(existsSync(join(dir, "environment.json"))).toBe(false);
      expect(existsSync(environmentFile!)).toBe(false);
    });
  });
});

describe.runIf(process.platform === "win32")("Windows PowerShell operations", () => {
  it("streams cwd and external command output through Pi's bash operations", async () => {
    const chunks: Buffer[] = [];
    const result = await createWindowsPowerShellOperations().exec(
      "$PWD.Path; node --version",
      process.cwd(),
      { onData: (chunk) => chunks.push(chunk), timeout: 10 },
    );
    const output = Buffer.concat(chunks).toString("utf8");
    expect(result.exitCode).toBe(0);
    expect(output).toContain(process.cwd());
    expect(output).toMatch(/v\d+\.\d+\.\d+/);
  });
});
