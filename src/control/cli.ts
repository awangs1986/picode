import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { executeControlCommand } from "./index.ts";
import { RpcControlDriver } from "./rpc-driver.ts";

export async function runControlCli(input: {
  argv: string[];
  packageRoot: string;
  piEntry: string;
}): Promise<number> {
  return executeControlCommand(input.argv, {
    driver: new RpcControlDriver({
      packageRoot: input.packageRoot,
      piEntry: input.piEntry,
      cwd: process.cwd(),
      env: process.env,
    }),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const piEntry = process.env["PICODE_PI_ENTRY"];
  if (piEntry === undefined) throw new Error("PICODE_PI_ENTRY is required");
  process.exitCode = await runControlCli({ argv: process.argv.slice(2), packageRoot, piEntry });
}
