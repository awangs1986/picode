import { join } from "node:path";
import { RpcControlDriver } from "../../src/control/rpc-driver.ts";

const [packageRoot, cwd, picodeDir] = process.argv.slice(2);
if (!packageRoot || !cwd || !picodeDir) throw new Error("packageRoot, cwd and picodeDir are required");

const driver = new RpcControlDriver({
  packageRoot,
  piEntry: join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
  cwd,
  env: { ...process.env, PICODE_DIR: picodeDir },
  extraExtensions: [join(packageRoot, "test", "fixtures", "scripted-model-extension.ts")],
});

for await (const event of driver.run({
  prompt: "TOOL:HANG",
  provider: "picode-scripted-test",
  model: "fixture",
  harnessTier: "simple",
  permissionTier: "full",
  nonInteractive: false,
  timeoutMs: 600_000,
})) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
