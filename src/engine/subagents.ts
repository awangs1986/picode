import type { Result } from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";

/**
 * Subagent/委派/编排缝（MODULES.md §4：pi-subagents，2026-08-07 改选）。
 * 事件总线 RPC v1（spawn/status/steer/stop/resume）；subagentCommand
 * 指向 vendored pi；生命周期工件 v3 = Evidence 来源（存指针不转写）。
 */

export type WatchdogLevel = "off" | "normal" | "strict";

/** 二档 = normal；三档 = strict（强模型对抗审查 + scope 监控 + LSP） */
export interface WatchdogConfig {
  level: WatchdogLevel;
  scopeDriftReporting: boolean;
  adversarialReview: boolean;
  lspDiagnostics: boolean;
}

export const WATCHDOG_PRESETS: Record<WatchdogLevel, WatchdogConfig> = {
  off: { level: "off", scopeDriftReporting: false, adversarialReview: false, lspDiagnostics: false },
  normal: { level: "normal", scopeDriftReporting: true, adversarialReview: false, lspDiagnostics: true },
  strict: { level: "strict", scopeDriftReporting: true, adversarialReview: true, lspDiagnostics: true },
};

export interface DelegationRequest {
  taskId: string;
  /** 子代理只承接能独立验收的子任务；目标/范围/方法/工具/权限显式分派 */
  goal: string;
  scope: string[];
  /** context 传递模式（pi-subagents）：fork 带上下文 / fresh 只带 Capsule */
  contextMode: "fork" | "fresh";
  /** 写任务必须走独立 worktree（Q8） */
  worktreePath?: string;
  watchdog: WatchdogConfig;
}

/** 生命周期工件 v3 的指针（Evidence 只存指针不转写，MODULES.md §3.4） */
export interface SubagentArtifactRef {
  subagentId: string;
  artifactDir: string;
  kind: "transcript" | "report" | "diff" | "watchdog-report";
}

export interface SubagentStatus {
  subagentId: string;
  state: "spawned" | "running" | "finished" | "failed" | "stopped";
  /** 子进程是否已确认加载沙箱扩展（subagent:acknowledge-extension） */
  sandboxAcknowledged: boolean;
  artifacts: SubagentArtifactRef[];
}

/** RPC v1 窄接口；真实 pi-subagents 生命周期由 Adapter Extension 事件桥接入 Envelope。 */
export interface SubagentRpc {
  spawn(request: DelegationRequest): Promise<Result<string>>;
  status(subagentId: string): Promise<Result<SubagentStatus>>;
  steer(subagentId: string, message: string): Promise<Result<void>>;
  stop(subagentId: string): Promise<Result<void>>;
  resume(subagentId: string): Promise<Result<string>>;
}

/**
 * 沙箱确认门（MODULES.md §4）：子代理是真 pi 子进程且做环境级扩展
 * 发现 → 子进程自行加载 landstrip；以确认协议验证"子进程确实带沙箱"
 * 后 Guard 才放行写操作。纯函数。
 */
export function gateSubagentWrite(status: SubagentStatus, hasWriteScope: boolean): Result<void> {
  if (!hasWriteScope) return ok(undefined);
  if (!status.sandboxAcknowledged) {
    return err(
      "engine/subagent-sandbox-unconfirmed",
      `subagent ${status.subagentId} has not acknowledged the sandbox extension; write operations stay blocked`,
    );
  }
  return ok(undefined);
}
