import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const pidFile = process.argv[2];
if (!pidFile) throw new Error("pid file argument is required");

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
  windowsHide: true,
});
writeFileSync(pidFile, JSON.stringify({ parentPid: process.pid, childPid: child.pid }), "utf8");
setInterval(() => {}, 1000);
