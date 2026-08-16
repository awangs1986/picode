import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PINNED_VERSION = "0.42.1";

const inspectStructuredOriginal = `\tif (options.structuredOutput && result.exitCode === 0 && !result.error) {`;
const inspectStructuredPatched = `\t// Picode compatibility seam: inspect a submitted structured result even after an earlier child tool error.
\tif (options.structuredOutput) {`;

const preserveEarlierErrorOriginal = `\t\tif (!structuredOutputToolInvoked) {
\t\t\tresult.exitCode = 1;
\t\t\tresult.error = MISSING_STRUCTURED_OUTPUT_CALL_ERROR;
\t\t\tresult.structuredOutputFailed = true;
\t\t} else {`;
const preserveEarlierErrorPatched = `\t\tif (!structuredOutputToolInvoked) {
\t\t\tif (result.exitCode === 0 && !result.error) {
\t\t\t\tresult.exitCode = 1;
\t\t\t\tresult.error = MISSING_STRUCTURED_OUTPUT_CALL_ERROR;
\t\t\t\tresult.structuredOutputFailed = true;
\t\t\t}
\t\t} else {`;

const projectFailedStructuredOriginal = `\tif (status === "completed") {`;
const projectFailedStructuredPatched = `\t// Picode compatibility seam: project a validated structured result after recoverable child tool errors.
\tif (status === "completed" || (status === "failed" && request.result.kind === "structured" && child?.structuredOutput !== undefined)) {`;

function applyPinnedPatch(source, patch) {
  if (source.includes(patch.original)) return source.replace(patch.original, patch.replacement);
  if (source.includes(patch.marker)) return source;
  throw new Error(patch.error);
}

/**
 * Narrow compatibility seam for pi-subagents 0.42.1.
 *
 * A read-only reviewer may recover from an exploratory tool failure and still
 * submit schema-valid structured_output. Upstream currently records that value
 * on disk but drops it from the terminal delegation response because the prior
 * tool failure determines the run status first. Preserve the validated value;
 * Picode still rejects cancellation, timeout, budget exhaustion and malformed
 * decisions at its own review admission boundary.
 */
export function applyPiSubagentsCompatibility(packageRoot) {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (packageJson.name !== "pi-subagents" || packageJson.version !== PINNED_VERSION) {
    throw new Error(
      `Unsupported pi-subagents version ${String(packageJson.version)}; review the pinned ${PINNED_VERSION} compatibility patch before upgrading.`,
    );
  }

  const targets = [
    {
      path: join(packageRoot, "src", "runs", "foreground", "execution.ts"),
      patches: [
        {
          original: inspectStructuredOriginal,
          replacement: inspectStructuredPatched,
          marker: "Picode compatibility seam: inspect a submitted structured result",
          error: "Unsupported pi-subagents structured-output execution layout.",
        },
        {
          original: preserveEarlierErrorOriginal,
          replacement: preserveEarlierErrorPatched,
          marker: "if (result.exitCode === 0 && !result.error) {",
          error: "Unsupported pi-subagents missing structured-output layout.",
        },
      ],
    },
    {
      path: join(packageRoot, "src", "slash", "delegation-adapters.ts"),
      patches: [{
        original: projectFailedStructuredOriginal,
        replacement: projectFailedStructuredPatched,
        marker: "Picode compatibility seam: project a validated structured result",
        error: "Unsupported pi-subagents delegation result projection layout.",
      }],
    },
  ];

  let changedFiles = 0;
  let patches = 0;
  for (const target of targets) {
    const original = readFileSync(target.path, "utf8");
    let next = original;
    for (const pinnedPatch of target.patches) {
      next = applyPinnedPatch(next, pinnedPatch);
      patches += 1;
    }
    if (next === original) continue;
    writeFileSync(target.path, next, "utf8");
    changedFiles += 1;
  }
  return { changedFiles, patches };
}
