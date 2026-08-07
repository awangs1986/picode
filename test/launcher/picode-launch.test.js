import { describe, expect, it } from "vitest";
import { buildPiLaunch, resolveVendoredPi } from "../../bin/picode-launch.mjs";

describe("Picode vendored Pi launch contract", () => {
  it("ships a loadable Pi extension entry", async () => {
    const entry = await import("../../src/extension/pi-entry.ts");
    expect(entry.default).toBeTypeOf("function");
  });

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
    const entry = resolveVendoredPi({
      resolve: () => "file:///C:/pkg/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
    });
    expect(entry.replaceAll("\\", "/")).toBe(
      "C:/pkg/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    );
  });

  it("injects the Picode adapter extension while preserving all user Pi arguments", () => {
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
    });
  });
});
