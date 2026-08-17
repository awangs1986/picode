import { spawn } from "node:child_process";

/** Boot a real vendored Pi RPC process and prove that Picode owns its commands. */
export function runRpcBootSmoke({ launcher, cwd, env, timeoutMs = 20_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcher, "--mode", "rpc", "--offline", "--no-session"], {
      cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const responses = new Map();
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      if (error === undefined) resolve(responses);
      else reject(error);
    };
    const inspect = () => {
      for (const line of stdout.split(/\r?\n/)) {
        if (line.trim() === "") continue;
        try {
          const value = JSON.parse(line);
          if (value.type === "response" && typeof value.id === "string") responses.set(value.id, value);
        } catch {
          // Startup diagnostics may be non-JSON; RPC responses remain line-delimited JSON.
        }
      }
      if (!["state", "commands", "models", "new"].every((id) => responses.has(id))) return;
      const failures = [...responses.values()].filter((response) => response.success !== true);
      if (failures.length > 0) return finish(new Error(`RPC command failed: ${JSON.stringify(failures)}`));
      const commandNames = responses.get("commands")?.data?.commands?.map((entry) => entry.name) ?? [];
      for (const required of ["harness", "pico-account", "slice", "pico-import", "subagent-model"]) {
        if (!commandNames.includes(required)) return finish(new Error(`Picode command not loaded: /${required}`));
      }
      const models = responses.get("models")?.data?.models ?? [];
      if (models.some((model) => model.provider === "picode-scripted-test")) {
        return finish(new Error("test-only scripted provider leaked into the product artifact"));
      }
      if (models.some((model) => model.provider === "cursor")) {
        return finish(new Error("Cursor fallback catalog leaked without a Picode Vault account"));
      }
      finish();
    };
    child.stdout.on("data", (chunk) => { stdout += String(chunk); inspect(); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled) finish(new Error(`Pi RPC exited before smoke completed (${code})\n${stderr}\n${stdout}`));
    });
    const timer = setTimeout(() => finish(new Error(`Pi RPC smoke timed out\n${stderr}\n${stdout}`)), timeoutMs);
    for (const command of [
      { id: "state", type: "get_state" },
      { id: "commands", type: "get_commands" },
      { id: "models", type: "get_available_models" },
      { id: "new", type: "new_session" },
    ]) child.stdin.write(`${JSON.stringify(command)}\n`);
  });
}
