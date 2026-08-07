import type { PermissionTier } from "../shared/types.ts";

/**
 * 沙箱政策编译（ADR-0004：Guard 政策权威 + Sandbox Provider 窄接口）。
 * 三档 UX 预设编译成 Provider 无关的政策对象；landstrip 适配器
 * （Engine 侧）再翻译成它的 per-agent/per-tool 规则与 OS 沙箱配置。
 * 纯函数，可红测试。
 */

export type RuleVerdict = "deny" | "ask" | "allow";

export interface CompiledSandboxPolicy {
  /** 工作区边界：写操作只允许这些根之下（Managed Worktree 追加） */
  writableRoots: string[];
  /** 秘密禁区：任何档位 denyWrite 硬阻断 + 读需 ask */
  secretZones: string[];
  network: RuleVerdict;
  exec: RuleVerdict;
  fsWrite: RuleVerdict;
  /** 工作区外写：full 档也不放行（ask） */
  fsWriteOutsideWorkspace: "deny" | "ask";
  /** Git 变更类操作永远 ask（Git 所有权，MODULES.md §2.3） */
  gitMutate: "ask";
}

export const DEFAULT_SECRET_ZONES = [
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/.ssh/**",
  "**/.aws/credentials",
];

export function compileSandboxPolicy(
  tier: PermissionTier,
  workspaceRoots: string[],
  extraSecretZones: string[] = [],
): CompiledSandboxPolicy {
  const base = {
    writableRoots: [...workspaceRoots],
    secretZones: [...DEFAULT_SECRET_ZONES, ...extraSecretZones],
    fsWriteOutsideWorkspace: "ask" as const,
    gitMutate: "ask" as const,
  };
  switch (tier) {
    case "readonly":
      return { ...base, network: "ask", exec: "ask", fsWrite: "ask" };
    case "auto":
      return { ...base, network: "ask", exec: "ask", fsWrite: "allow" };
    case "full":
      return { ...base, network: "allow", exec: "allow", fsWrite: "allow" };
  }
}
