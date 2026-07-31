import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";

export type EvalLanguage = "js" | "py";

export type EvalCell = {
  language: EvalLanguage;
  code: string;
  title?: string;
  timeout?: number;
  reset?: boolean;
};

export type EvalCellResult = {
  language: EvalLanguage;
  title?: string;
  output: string;
  value?: unknown;
  durationMs: number;
  isError: boolean;
};

type EvalHooks = {
  signal?: AbortSignal;
  onUpdate?: (text: string) => void;
};

type PendingRequest = {
  resolve: (value: { output: string; value?: unknown }) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
};

const JS_WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");
const vm = require("node:vm");
const util = require("node:util");
let context;
let output = [];
function printable(value) {
  if (typeof value === "string") return value;
  return util.inspect(value, { depth: 6, colors: false, maxArrayLength: 100 });
}
function reset() {
  const sandbox = {
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: globalThis.fetch,
  };
  sandbox.globalThis = sandbox;
  sandbox.display = (value) => output.push(printable(value));
  sandbox.print = (...values) => output.push(values.map(printable).join(" "));
  sandbox.console = {
    log: (...values) => sandbox.print(...values),
    info: (...values) => sandbox.print(...values),
    warn: (...values) => sandbox.print(...values),
    error: (...values) => sandbox.print(...values),
  };
  context = vm.createContext(sandbox, { name: "picode-eval" });
}
function cloneable(value) {
  if (value === undefined) return undefined;
  try { return structuredClone(value); } catch { return printable(value); }
}
reset();
parentPort.on("message", async (message) => {
  output = [];
  if (message.reset) reset();
  try {
    let script;
    try {
      script = new vm.Script(message.code, { filename: message.title || "picode-eval.js" });
    } catch (error) {
      if (!(error instanceof SyntaxError) || !/await/i.test(String(error.message))) throw error;
      script = new vm.Script("(async () => {\n" + message.code + "\n})()", {
        filename: message.title || "picode-eval.js",
      });
    }
    let value = script.runInContext(context, { timeout: message.timeoutMs });
    if (value && typeof value.then === "function") value = await value;
    parentPort.postMessage({ id: message.id, output: output.join("\n"), value: cloneable(value) });
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      error: error && error.stack ? String(error.stack) : String(error),
      output: output.join("\n"),
    });
  }
});
`;

const PYTHON_RUNNER = `
import ast, asyncio, contextlib, inspect, io, json, sys, traceback

TLA_FLAG = getattr(ast, "PyCF_ALLOW_TOP_LEVEL_AWAIT", 0x2000)
event_loop = asyncio.new_event_loop()
asyncio.set_event_loop(event_loop)
state = {"__name__": "__picode_eval__", "asyncio": asyncio}

def safe(value):
    try:
        json.dumps(value)
        return value
    except Exception:
        return repr(value)

def run_compiled(code, mode):
    # Python's top-level-await compiler emits a coroutine code object. Keep a
    # persistent event loop so variables and scheduled tasks survive between
    # cells, matching the JavaScript kernel and OMP's Python evaluator.
    if code.co_flags & inspect.CO_COROUTINE:
        return event_loop.run_until_complete(eval(code, state, state))
    if mode == "eval":
        return eval(code, state, state)
    exec(code, state, state)
    return None

def execute(code):
    tree = ast.parse(code, mode="exec")
    value = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        tail = ast.Expression(tree.body.pop().value)
        ast.fix_missing_locations(tail)
        if tree.body:
            run_compiled(compile(tree, "<picode-eval>", "exec", flags=TLA_FLAG), "exec")
        value = run_compiled(compile(tail, "<picode-eval>", "eval", flags=TLA_FLAG), "eval")
    else:
        run_compiled(compile(tree, "<picode-eval>", "exec", flags=TLA_FLAG), "exec")
    return value
for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        if request.get("reset"):
            state = {"__name__": "__picode_eval__"}
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            value = execute(request.get("code", ""))
        print(json.dumps({"id": request["id"], "output": stdout.getvalue() + stderr.getvalue(), "value": safe(value)}, ensure_ascii=False), flush=True)
    except BaseException:
        print(json.dumps({"id": request.get("id") if isinstance(request, dict) else None, "error": traceback.format_exc()}, ensure_ascii=False), flush=True)
`;

class JavaScriptKernel {
  private worker: Worker | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private queue: Promise<unknown> = Promise.resolve();

  execute(cell: EvalCell, hooks: EvalHooks): Promise<{ output: string; value?: unknown }> {
    const run = this.queue.then(() => this.executeNow(cell, hooks));
    this.queue = run.catch(() => undefined);
    return run;
  }

  dispose(reason = "JavaScript evaluator disposed") {
    const worker = this.worker;
    this.worker = null;
    void worker?.terminate();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private ensureWorker() {
    if (this.worker) return this.worker;
    const worker = new Worker(JS_WORKER_SOURCE, { eval: true });
    worker.on(
      "message",
      (message: { id?: string; output?: string; value?: unknown; error?: string }) => {
        if (!message.id) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (pending.abort && pending.signal) {
          pending.signal.removeEventListener("abort", pending.abort);
        }
        if (message.error) {
          pending.reject(new Error([message.output, message.error].filter(Boolean).join("\n")));
        } else {
          pending.resolve({ output: message.output || "", value: message.value });
        }
      },
    );
    worker.on("error", (error) => this.dispose(error.message));
    worker.on("exit", (code) => {
      if (this.worker === worker) this.worker = null;
      if (code !== 0 && this.pending.size > 0)
        this.dispose(`JavaScript evaluator exited (${code})`);
    });
    this.worker = worker;
    return worker;
  }

  private executeNow(cell: EvalCell, hooks: EvalHooks) {
    const worker = this.ensureWorker();
    const id = randomUUID();
    const timeoutMs = normalizeTimeout(cell.timeout);
    return new Promise<{ output: string; value?: unknown }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.dispose();
        reject(new Error(`JavaScript cell timed out after ${timeoutMs / 1000} seconds`));
      }, timeoutMs);
      const pending: PendingRequest = { resolve, reject, timer, signal: hooks.signal };
      if (hooks.signal) {
        pending.abort = () => {
          this.pending.delete(id);
          this.dispose();
          reject(new Error("JavaScript cell aborted"));
        };
        hooks.signal.addEventListener("abort", pending.abort, { once: true });
      }
      this.pending.set(id, pending);
      hooks.onUpdate?.(`Running JavaScript cell${cell.title ? `: ${cell.title}` : ""}`);
      worker.postMessage({
        id,
        code: cell.code,
        reset: cell.reset === true,
        timeoutMs,
        title: cell.title,
      });
    });
  }
}

function pythonCandidates(): string[] {
  const candidates = [process.env.PICODE_PYTHON, process.env.PYTHON];
  if (process.platform === "win32") candidates.push("python.exe", "py.exe");
  else candidates.push("python3", "python");
  return candidates.filter((value): value is string => Boolean(value));
}

export function resolvePythonExecutable(): string | null {
  for (const executable of pythonCandidates()) {
    const args = pathlessName(executable) === "py.exe" ? ["-3", "--version"] : ["--version"];
    const result = spawnSync(executable, args, {
      encoding: "utf8",
      stdio: "ignore",
      timeout: 2_000,
      windowsHide: true,
    });
    if (result.status === 0) return executable;
  }
  return null;
}

function pathlessName(value: string) {
  return value.replace(/\\/g, "/").split("/").pop()?.toLowerCase() || value.toLowerCase();
}

class PythonKernel {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lineBuffer = "";
  private readonly pending = new Map<string, PendingRequest>();
  private queue: Promise<unknown> = Promise.resolve();

  execute(cell: EvalCell, hooks: EvalHooks): Promise<{ output: string; value?: unknown }> {
    const run = this.queue.then(() => this.executeNow(cell, hooks));
    this.queue = run.catch(() => undefined);
    return run;
  }

  dispose(reason = "Python evaluator disposed") {
    const child = this.child;
    this.child = null;
    child?.kill();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private ensureChild() {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    const executable = resolvePythonExecutable();
    if (!executable)
      throw new Error("Python evaluator is unavailable: install Python 3 or set PICODE_PYTHON");
    const args =
      pathlessName(executable) === "py.exe"
        ? ["-3", "-u", "-c", PYTHON_RUNNER]
        : ["-u", "-c", PYTHON_RUNNER];
    const child = spawn(executable, args, {
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (chunk.trim()) this.failAll(new Error(chunk.trim()));
    });
    child.on("error", (error) => this.failAll(error));
    child.on("exit", (code) => {
      if (this.child === child) this.child = null;
      if (this.pending.size > 0)
        this.failAll(new Error(`Python evaluator exited (${code ?? "unknown"})`));
    });
    this.child = child;
    return child;
  }

  private executeNow(cell: EvalCell, hooks: EvalHooks) {
    const child = this.ensureChild();
    const id = randomUUID();
    const timeoutMs = normalizeTimeout(cell.timeout);
    return new Promise<{ output: string; value?: unknown }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.dispose();
        reject(new Error(`Python cell timed out after ${timeoutMs / 1000} seconds`));
      }, timeoutMs);
      const pending: PendingRequest = { resolve, reject, timer, signal: hooks.signal };
      if (hooks.signal) {
        pending.abort = () => {
          this.pending.delete(id);
          this.dispose();
          reject(new Error("Python cell aborted"));
        };
        hooks.signal.addEventListener("abort", pending.abort, { once: true });
      }
      this.pending.set(id, pending);
      hooks.onUpdate?.(`Running Python cell${cell.title ? `: ${cell.title}` : ""}`);
      child.stdin.write(`${JSON.stringify({ id, code: cell.code, reset: cell.reset === true })}\n`);
    });
  }

  private consume(chunk: string) {
    this.lineBuffer += chunk;
    while (true) {
      const newline = this.lineBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.lineBuffer.slice(0, newline).trim();
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (!line) continue;
      let message: { id?: string; output?: string; value?: unknown; error?: string };
      try {
        message = JSON.parse(line);
      } catch {
        this.failAll(new Error(`Invalid Python evaluator response: ${line.slice(0, 500)}`));
        continue;
      }
      if (!message.id) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (pending.abort && pending.signal)
        pending.signal.removeEventListener("abort", pending.abort);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve({ output: message.output || "", value: message.value });
    }
  }

  private failAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function normalizeTimeout(timeout: number | undefined) {
  const seconds = timeout ?? 30;
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) {
    throw new Error("Eval timeout must be between 1 and 3600 seconds");
  }
  return Math.floor(seconds * 1000);
}

function renderCellValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export class PersistentEvalRuntime {
  private readonly javascript = new Map<string, JavaScriptKernel>();
  private readonly python = new Map<string, PythonKernel>();

  async execute(
    sessionId: string,
    cells: EvalCell[],
    hooks: EvalHooks = {},
  ): Promise<EvalCellResult[]> {
    if (cells.length === 0 || cells.length > 32) throw new Error("Eval requires 1 to 32 cells");
    const results: EvalCellResult[] = [];
    for (const cell of cells) {
      if (!cell.code.trim()) throw new Error("Eval cell code is required");
      const startedAt = Date.now();
      try {
        const kernel = this.kernel(sessionId, cell.language);
        const result = await kernel.execute(cell, hooks);
        const value = renderCellValue(result.value);
        results.push({
          language: cell.language,
          title: cell.title,
          output: [result.output.trimEnd(), value].filter(Boolean).join("\n") || "(no output)",
          value: result.value,
          durationMs: Date.now() - startedAt,
          isError: false,
        });
      } catch (error) {
        results.push({
          language: cell.language,
          title: cell.title,
          output: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
          isError: true,
        });
        break;
      }
    }
    return results;
  }

  dispose(sessionId?: string) {
    const disposeMap = <T extends { dispose: () => void }>(map: Map<string, T>) => {
      if (sessionId) {
        map.get(sessionId)?.dispose();
        map.delete(sessionId);
      } else {
        for (const kernel of map.values()) kernel.dispose();
        map.clear();
      }
    };
    disposeMap(this.javascript);
    disposeMap(this.python);
  }

  snapshot() {
    return {
      javascriptKernels: this.javascript.size,
      pythonKernels: this.python.size,
    };
  }

  private kernel(sessionId: string, language: EvalLanguage) {
    if (language === "js") {
      let kernel = this.javascript.get(sessionId);
      if (!kernel) {
        kernel = new JavaScriptKernel();
        this.javascript.set(sessionId, kernel);
      }
      return kernel;
    }
    let kernel = this.python.get(sessionId);
    if (!kernel) {
      kernel = new PythonKernel();
      this.python.set(sessionId, kernel);
    }
    return kernel;
  }
}
