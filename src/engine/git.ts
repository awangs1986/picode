import { spawn } from "node:child_process";
import type { OperationIntent } from "../shared/types.ts";
import { WorktreeRegistry } from "./worktree.ts";

export type GitAction = "status" | "diff" | "log" | "show" | "branches" | "worktrees" | "stage" | "unstage" | "switch" | "create_branch" | "restore" | "create_worktree" | "claim_worktree" | "release_worktree" | "remove_worktree" | "commit" | "merge" | "rebase" | "push" | "delete_branch";
export type GitRequest = { action: GitAction; cwd: string; paths?: string[]; ref?: string; message?: string; remote?: string; taskId?: string; worktreePath?: string };
export interface GitResult { ok: boolean; action: GitAction; exitCode: number; stdout: string; stderr: string; truncated: boolean; errorCode?: string }
const OWNERSHIP = new Set<GitAction>(["commit", "merge", "rebase", "push", "delete_branch"]);
const INSPECT = new Set<GitAction>(["status", "diff", "log", "show", "branches", "worktrees"]);
const MAX_OUTPUT = 256 * 1024;
function required(value: string | undefined, name: string): string { if (!value) throw new Error(`missing ${name}`); return value; }
function argsFor(r: GitRequest): string[] {
  const paths = r.paths ?? [];
  switch (r.action) {
    case "status": return ["status", "--short", "--branch"];
    case "diff": return ["diff", "--", ...paths];
    case "log": return ["log", "--oneline", "--decorate", "-n", "50"];
    case "show": return ["show", "--stat", "--oneline", r.ref ?? "HEAD"];
    case "branches": return ["branch", "--format=%(refname:short)"];
    case "worktrees": return ["worktree", "list", "--porcelain"];
    case "stage": return ["add", "--", ...paths];
    case "unstage": return ["restore", "--staged", "--", ...paths];
    case "switch": return ["switch", required(r.ref, "ref")];
    case "create_branch": return ["switch", "-c", required(r.ref, "ref")];
    case "restore": return ["restore", "--", ...paths];
    case "create_worktree": return ["worktree", "add", "-b", `picode/${required(r.taskId, "taskId")}`, required(r.worktreePath, "worktreePath")];
    case "remove_worktree": return ["worktree", "remove", required(r.worktreePath, "worktreePath")];
    case "claim_worktree":
    case "release_worktree": return [];
    case "commit": return ["commit", "-m", required(r.message, "message")];
    case "merge": return ["merge", required(r.ref, "ref")];
    case "rebase": return ["rebase", required(r.ref, "ref")];
    case "push": return ["push", r.remote ?? "origin", r.ref ?? "HEAD"];
    case "delete_branch": return ["branch", "-d", required(r.ref, "ref")];
  }
}

/** Fixed-action Git deep module. It never accepts arbitrary argv or shell strings. */
export class StructuredGit {
  constructor(private readonly worktrees = new WorktreeRegistry()) {}
  static intent(r: GitRequest): OperationIntent {
    return { category: OWNERSHIP.has(r.action) ? "git-mutate" : INSPECT.has(r.action) ? "git-read" : "fs-write", targets: r.paths ?? [r.worktreePath ?? r.ref ?? r.cwd], cwd: r.cwd, destructive: r.action === "restore" || r.action === "remove_worktree" || r.action === "delete_branch" };
  }
  async execute(r: GitRequest, signal?: AbortSignal): Promise<GitResult> {
    if (r.action === "claim_worktree" || r.action === "release_worktree") {
      const taskId = r.taskId; const path = r.worktreePath ?? r.cwd;
      if (!taskId) return { ok: false, action: r.action, exitCode: 64, stdout: "", stderr: "missing taskId", truncated: false, errorCode: "git/invalid-request" };
      const result = r.action === "claim_worktree" ? await this.worktrees.claimWriter(path, taskId) : await this.worktrees.releaseWriter(path, taskId);
      return { ok: result.ok, action: r.action, exitCode: result.ok ? 0 : 1, stdout: result.ok ? JSON.stringify({ taskId, path }) : "", stderr: result.ok ? "" : result.error.message, truncated: false, ...(result.ok ? {} : { errorCode: result.error.code }) };
    }
    if (r.action === "remove_worktree" && r.worktreePath) {
      const dirty = await this.run({ action: "status", cwd: r.worktreePath }, ["status", "--porcelain"], signal);
      if (!dirty.ok || dirty.stdout.trim() !== "") return { ok: false, action: r.action, exitCode: 2, stdout: "", stderr: "managed worktree is dirty; remove refused", truncated: false, errorCode: "git/worktree-dirty" };
    }
    let args: string[];
    try { args = argsFor(r); } catch (cause) { return { ok: false, action: r.action, exitCode: 64, stdout: "", stderr: cause instanceof Error ? cause.message : String(cause), truncated: false, errorCode: "git/invalid-request" }; }
    const result = await this.run(r, args, signal);
    if (result.ok && r.action === "create_worktree" && r.taskId && r.worktreePath) {
      const registered = await this.worktrees.registerManagedWorktree(r.cwd, r.taskId, r.worktreePath);
      if (!registered.ok) return { ...result, ok: false, exitCode: 1, stderr: registered.error.message, errorCode: registered.error.code };
    }
    return result;
  }

  private run(r: GitRequest, args: string[], signal?: AbortSignal): Promise<GitResult> {
    return new Promise((resolveResult) => {
      const child = spawn("git", args, { cwd: r.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], signal });
      let stdout = ""; let stderr = ""; let truncated = false; let settled = false;
      const finish = (value: GitResult): void => { if (!settled) { settled = true; resolveResult(value); } };
      const collect = (target: "stdout" | "stderr", chunk: Buffer): void => {
        const current = target === "stdout" ? stdout : stderr;
        const next = current + chunk.toString("utf8");
        if (target === "stdout") stdout = next.slice(0, MAX_OUTPUT); else stderr = next.slice(0, MAX_OUTPUT);
        if (next.length > MAX_OUTPUT) truncated = true;
      };
      child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk)); child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
      child.on("error", (cause) => finish({ ok: false, action: r.action, exitCode: 127, stdout, stderr: cause.message, truncated, errorCode: "git/unavailable" }));
      child.on("close", (code) => finish({ ok: code === 0, action: r.action, exitCode: code ?? 1, stdout, stderr, truncated, ...(code === 0 ? {} : { errorCode: "git/command-failed" }) }));
    });
  }
}
