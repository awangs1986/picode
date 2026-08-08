import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { executeControlCommand } from "./index.ts";
import { RpcControlDriver } from "./rpc-driver.ts";
import { ControlRpcServer, type RpcRequest } from "./rpc-server.ts";
import { createInterface } from "node:readline";

export async function runControlCli(input: {
  argv: string[];
  packageRoot: string;
  piEntry: string;
}): Promise<number> {
  const driver = new RpcControlDriver({
      packageRoot: input.packageRoot,
      piEntry: input.piEntry,
      cwd: process.cwd(),
      env: process.env,
    });
  if (input.argv[0] === "rpc") {
    const server = new ControlRpcServer(driver, (message) => process.stdout.write(`${JSON.stringify(message)}\n`));
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
    for await (const line of lines) {
      if (line.trim() === "") continue;
      try { await server.receive(JSON.parse(line) as RpcRequest); }
      catch (cause) {
        process.stdout.write(`${JSON.stringify({ version: 1, id: "", error: { code: "control/json-invalid", message: cause instanceof Error ? cause.message : String(cause) } })}\n`);
      }
    }
    await server.settle();
    return 0;
  }
  return executeControlCommand(input.argv, {
    driver,
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
