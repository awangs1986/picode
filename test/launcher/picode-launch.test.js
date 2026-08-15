import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { buildPiLaunch, consumeWorkspaceSwitchRequest, resolveVendoredPi } from "../../bin/picode-launch.mjs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

describe("Picode vendored Pi launch contract", () => {
  it("consumes only the matching launch's validated workspace switch request", async () => {
    const isolated = await mkdtemp(join(tmpdir(), "picode-workspace-switch-"));
    const from = join(isolated, "old");
    const target = join(isolated, "new");
    await mkdir(from);
    await mkdir(target);
    const request = join(isolated, "workspace-switch-launch-1.json");
    await writeFile(request, JSON.stringify({
      version: 1,
      launchId: "launch-1",
      fromWorkspace: from,
      targetWorkspace: target,
    }));

    try {
      await expect(consumeWorkspaceSwitchRequest({
        picodeDir: isolated,
        launchId: "launch-1",
        fromCwd: from,
      })).resolves.toBe(target);
      await expect(readFile(request, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  });

  it("leaves both bare and path-based /import behavior with upstream Pi", async () => {
    const interactiveMode = await readFile(
      join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "modes", "interactive", "interactive-mode.js"),
      "utf8",
    );

    expect(interactiveMode).toContain('if (text === "/import" || text.startsWith("/import "))');
  });

  it("ships a loadable Pi extension entry", async () => {
    const entry = await import("../../src/extension/pi-entry.ts");
    expect(entry.default).toBeTypeOf("function");
  }, 20_000);

  it("resolves the pinned earendil coding-agent CLI instead of the unrelated legacy package", () => {
    const requested = [];
    const entry = resolveVendoredPi({
      resolve(specifier) {
        requested.push(specifier);
        return "C:/pkg/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
      },
    });

    expect(requested).toEqual(["@earendil-works/pi-coding-agent"]);
    expect(entry.replaceAll("\\", "/")).toBe(
      "C:/pkg/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    );
  });

  it("accepts the file URL returned by ESM import.meta.resolve", () => {
    const sdkEntry = join(process.cwd(), "pkg", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
    const entry = resolveVendoredPi({
      resolve: () => pathToFileURL(sdkEntry).href,
    });
    expect(entry).toBe(join(dirname(sdkEntry), "cli.js"));
  });

  it("injects Picode and its pinned Cursor SDK adapter while preserving all user Pi arguments", () => {
    const launch = buildPiLaunch({
      packageRoot: "C:/pkg/picode",
      picodeDir: "C:/Users/dev/.picode",
      piEntry: "C:/pkg/pi/dist/cli.js",
      userArgs: ["--resume", "session.jsonl"],
      parentEnv: { PATH: "C:/bin" },
    });

    expect(launch.args.map((part) => part.replaceAll("\\", "/"))).toEqual([
      "C:/pkg/pi/dist/cli.js",
      "--extension",
      "C:/pkg/picode/src/extension/pi-entry.ts",
      "--extension",
      "C:/pkg/picode/src/extension/cursor-sdk-entry.ts",
      "--tui-mode",
      "fullscreen",
      "--resume",
      "session.jsonl",
    ]);
    expect({
      ...launch.env,
      PI_CODING_AGENT_DIR: launch.env.PI_CODING_AGENT_DIR.replaceAll("\\", "/"),
    }).toMatchObject({
      PATH: "C:/bin",
      PICODE_DIR: "C:/Users/dev/.picode",
      PI_CODING_AGENT_DIR: "C:/Users/dev/.picode/agent",
      PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE: "1",
      PI_HARDWARE_CURSOR: "1",
    });

    const explicitRegular = buildPiLaunch({
      packageRoot: "C:/pkg/picode",
      picodeDir: "C:/Users/dev/.picode",
      piEntry: "C:/pkg/pi/dist/cli.js",
      userArgs: ["--tui-mode", "regular"],
      parentEnv: {},
    });
    expect(explicitRegular.args.slice(-4)).toEqual([
      "--tui-mode",
      "fullscreen",
      "--tui-mode",
      "regular",
    ]);
  });

  it("prints RPC protocol help instead of starting the stdin server", async () => {
    const { stdout } = await execFileAsync(process.execPath, [join(process.cwd(), "bin", "picode.mjs"), "rpc", "--help"], {
      cwd: process.cwd(),
      timeout: 20_000,
    });

    expect(stdout).toContain("run.start");
    expect(stdout).toContain("approval.respond");
  }, 20_000);

  it("explains how to start the TUI when SSH did not allocate a terminal", async () => {
    const isolated = await mkdtemp(join(tmpdir(), "picode-no-tty-"));
    try {
      await expect(execFileAsync(
        process.execPath,
        [join(process.cwd(), "bin", "picode.mjs")],
        { cwd: process.cwd(), env: { ...process.env, PICODE_DIR: isolated }, timeout: 20_000 },
      )).rejects.toMatchObject({
        code: 2,
        stderr: expect.stringContaining("ssh -t"),
      });
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  }, 20_000);
});
