import { executeControlCommand, type ControlDriver, type ControlEvent } from "./index.ts";

export type RpcRequest = { version: number; id: string; method: string; params?: Record<string, unknown> };
export type RpcMessage =
  | { version: 1; id: string; event: string; payload: unknown }
  | { version: 1; id: string; result: unknown }
  | { version: 1; id: string; error: { code: string; message: string } };

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`missing ${name}`);
  return value;
}

/** Long-lived protocol seam. It owns correlation only, never product state. */
export class ControlRpcServer {
  private readonly pending = new Set<Promise<void>>();
  constructor(private readonly driver: ControlDriver, private readonly emit: (message: RpcMessage) => void) {}

  async receive(request: RpcRequest): Promise<void> {
    if (request.version !== 1) {
      this.emit({ version: 1, id: request.id, error: { code: "control/version-unsupported", message: `unsupported protocol version: ${request.version}` } });
      return;
    }
    try {
      if (request.method === "run.start") {
        const params = request.params ?? {};
        const task = this.stream(request.id, this.driver.run({
          prompt: text(params.prompt, "prompt"),
          ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
          ...(typeof params.session === "string" ? { session: params.session } : {}),
          ...(typeof params.provider === "string" ? { provider: params.provider } : {}),
          ...(typeof params.model === "string" ? { model: params.model } : {}),
          ...(typeof params.timeoutMs === "number" ? { timeoutMs: params.timeoutMs } : {}),
          nonInteractive: false,
        }));
        this.pending.add(task);
        void task.finally(() => this.pending.delete(task));
        return;
      }
      if (request.method === "approval.respond") {
        if (this.driver.respondApproval === undefined) throw new Error("approval responses are unavailable");
        const params = request.params ?? {};
        const action = text(params.action, "action");
        if (action !== "once" && action !== "session" && action !== "session-full" && action !== "deny") throw new Error(`invalid approval action: ${action}`);
        this.emit({ version: 1, id: request.id, result: await this.driver.respondApproval(text(params.requestId, "requestId"), action) });
        return;
      }
      if (request.method === "run.cancel") {
        if (this.driver.cancelRun === undefined) throw new Error("run cancellation is unavailable");
        this.emit({ version: 1, id: request.id, result: await this.driver.cancelRun(text(request.params?.runId, "runId")) });
        return;
      }
      if (request.method === "command.execute") {
        const argv = request.params?.argv;
        if (!Array.isArray(argv) || argv.some((item) => typeof item !== "string")) throw new Error("params.argv must be a string array");
        const stdout: string[] = []; const stderr: string[] = [];
        const exitCode = await executeControlCommand(argv, { driver: this.driver, stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) });
        this.emit({ version: 1, id: request.id, result: { exitCode, stdout: stdout.map(parseLine), stderr } });
        return;
      }
      throw new Error(`unknown method: ${request.method}`);
    } catch (cause) {
      this.emit({ version: 1, id: request.id, error: { code: "control/request-invalid", message: cause instanceof Error ? cause.message : String(cause) } });
    }
  }

  async settle(): Promise<void> { await Promise.all([...this.pending]); }

  private async stream(id: string, events: AsyncIterable<ControlEvent>): Promise<void> {
    for await (const event of events) this.emit({ version: 1, id, event: event.kind, payload: event.payload });
  }
}

function parseLine(line: string): unknown { try { return JSON.parse(line); } catch { return line; } }
