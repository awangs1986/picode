import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { applyPiSubagentsCompatibility } from "../../scripts/pi-subagents-compatibility.mjs";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

const executionSource = `\tif (options.structuredOutput && result.exitCode === 0 && !result.error) {
\t\tresult.structuredOutputSchemaPath = options.structuredOutput.schemaPath;
\t\tresult.structuredOutputPath = options.structuredOutput.outputPath;
\t\tif (!structuredOutputToolInvoked) {
\t\t\tresult.exitCode = 1;
\t\t\tresult.error = MISSING_STRUCTURED_OUTPUT_CALL_ERROR;
\t\t\tresult.structuredOutputFailed = true;
\t\t} else {`;

const adapterSource = `\tlet projectedResult: SubagentDelegationValue | undefined;
\tif (status === "completed") {
\t\tif (request.result.kind === "text") {`;

describe("pinned pi-subagents compatibility module", () => {
  it("projects the validated value while retaining the failed diagnostic status", async () => {
    const adaptersPath = join(
      process.cwd(),
      "node_modules",
      "pi-subagents",
      "src",
      "slash",
      "delegation-adapters.ts",
    );
    const adapters = await import(pathToFileURL(adaptersPath).href) as {
      toSubagentDelegationResponse(
        request: Record<string, unknown>,
        result: Record<string, unknown>,
        aborted: boolean,
      ): Record<string, unknown>;
    };
    const response = adapters.toSubagentDelegationResponse({
      requestId: "request",
      ownerRunId: "owner",
      nodeId: "node",
      agent: "reviewer",
      task: "review",
      context: "fresh",
      cwd: "C:/repo",
      result: { kind: "structured", schema: {} },
    }, {
      isError: true,
      content: [{ type: "text", text: "an earlier read-only tool failed" }],
      details: {
        runId: "run",
        results: [{
          agent: "reviewer",
          exitCode: 1,
          error: "an earlier read-only tool failed",
          structuredOutput: { passed: true, blockers: [] },
        }],
      },
    }, false);

    expect(response).toMatchObject({
      status: "failed",
      error: "an earlier read-only tool failed",
      result: { kind: "structured", value: { passed: true, blockers: [] } },
    });
  });

  it("preserves a schema-validated final decision after an earlier child tool error", async () => {
    await withTempPicodeDir(async (root) => {
      const execution = join(root, "src", "runs", "foreground", "execution.ts");
      const adapter = join(root, "src", "slash", "delegation-adapters.ts");
      mkdirSync(join(root, "src", "runs", "foreground"), { recursive: true });
      mkdirSync(join(root, "src", "slash"), { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pi-subagents", version: "0.42.1" }));
      writeFileSync(execution, executionSource);
      writeFileSync(adapter, adapterSource);

      expect(applyPiSubagentsCompatibility(root)).toEqual({ changedFiles: 2, patches: 3 });
      expect(applyPiSubagentsCompatibility(root)).toEqual({ changedFiles: 0, patches: 3 });
      expect(readFileSync(execution, "utf8")).toContain("Picode compatibility seam: inspect a submitted structured result");
      expect(readFileSync(execution, "utf8")).toContain("result.exitCode === 0 && !result.error");
      expect(readFileSync(adapter, "utf8")).toContain("Picode compatibility seam: project a validated structured result");
    });
  });

  it("fails closed when the pinned pi-subagents version changes", async () => {
    await withTempPicodeDir(async (root) => {
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pi-subagents", version: "0.43.0" }));
      expect(() => applyPiSubagentsCompatibility(root)).toThrow("Unsupported pi-subagents version");
    });
  });
});
