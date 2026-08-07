import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** Resolve Pi through its exported SDK entry, then select the sibling CLI. */
export function resolveVendoredPi(resolver) {
  const resolved = resolver.resolve(PI_PACKAGE);
  const sdkEntry = resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
  return join(dirname(sdkEntry), "cli.js");
}

export function buildPiLaunch({ packageRoot, picodeDir, piEntry, userArgs, parentEnv }) {
  const agentDir = join(picodeDir, "agent");
  return {
    args: [piEntry, "--extension", join(packageRoot, "src", "extension", "pi-entry.ts"), ...userArgs],
    env: {
      ...parentEnv,
      PICODE_DIR: picodeDir,
      PICODE_PACKAGE_ROOT: packageRoot,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE: "1",
    },
  };
}
