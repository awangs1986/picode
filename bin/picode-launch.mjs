import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, realpath, stat, unlink } from "node:fs/promises";

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

function comparablePath(path) {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Consume the one-shot request created by /workspace for this exact TUI process. */
export async function consumeWorkspaceSwitchRequest({ picodeDir, launchId, fromCwd }) {
  if (!/^[A-Za-z0-9-]+$/.test(launchId)) throw new Error("invalid Picode launch id");
  const requestPath = join(picodeDir, `workspace-switch-${launchId}.json`);
  let raw;
  try {
    raw = await readFile(requestPath, "utf8");
  } catch (cause) {
    if (cause?.code === "ENOENT") return undefined;
    throw cause;
  }
  const request = JSON.parse(raw);
  if (request?.version !== 1 || request?.launchId !== launchId) {
    throw new Error("workspace switch request does not match this launch");
  }
  const [actualFrom, target] = await Promise.all([
    realpath(fromCwd),
    realpath(request.targetWorkspace),
  ]);
  if (comparablePath(actualFrom) !== comparablePath(request.fromWorkspace)) {
    throw new Error("workspace switch request does not match the active workspace");
  }
  if (!(await stat(target)).isDirectory()) throw new Error("workspace switch target is not a directory");
  await unlink(requestPath);
  return target;
}

/** Resolve Pi through its exported SDK entry, then select the sibling CLI. */
export function resolveVendoredPi(resolver) {
  const resolved = resolver.resolve(PI_PACKAGE);
  const sdkEntry = resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
  return join(dirname(sdkEntry), "cli.js");
}

export function buildPiLaunch({ packageRoot, picodeDir, piEntry, userArgs, parentEnv }) {
  const agentDir = join(picodeDir, "agent");
  return {
    args: [
      piEntry,
      "--extension", join(packageRoot, "src", "extension", "pi-entry.ts"),
      "--extension", join(packageRoot, "src", "extension", "cursor-sdk-entry.ts"),
      // Pi 0.84's native fullscreen renderer owns a bounded, mouse-scrollable
      // transcript and fixed input dock. Keep this before user arguments so an
      // explicit `--tui-mode regular` remains the final authority.
      "--tui-mode", "fullscreen",
      ...userArgs,
    ],
    env: {
      ...parentEnv,
      PICODE_DIR: picodeDir,
      PICODE_PACKAGE_ROOT: packageRoot,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE: "1",
      // Use Pi TUI's native cursor marker + terminal hardware cursor. The
      // terminal supplies the blink, so no redraw timer or resident work is added.
      PI_HARDWARE_CURSOR: parentEnv.PI_HARDWARE_CURSOR ?? "1",
    },
  };
}
