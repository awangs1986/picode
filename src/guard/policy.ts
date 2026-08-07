import type {
  Decision,
  Grant,
  OperationIntent,
  PermissionTier,
} from "../shared/types.ts";
import { computeFingerprint } from "./fingerprint.ts";
import { posix, win32 } from "node:path";

/**
 * Guard 裁决核心。保留条款 ②（MODULES.md §1）：必须是纯函数——
 * 输入 Intent + 档位 + Grant 集合，输出 Decision，无 IO、无隐藏状态。
 *
 * 执行底座的编译（landstrip permission 规则、mcp-adapter approveTools）
 * 属于 src/extension/ 组合层，不在这里。
 */

export interface PolicyInput {
  tier: PermissionTier;
  intent: OperationIntent;
  grants: readonly Grant[];
}

export function decide({ tier, intent, grants }: PolicyInput): Decision {
  // Git 所有权：变更类 Git 操作在任何档位都必须用户确认（MODULES.md §2.3）
  if (intent.category === "git-mutate") {
    return { verdict: "ask", reason: "git-ownership: mutation requires explicit user consent" };
  }

  // 破坏性操作：full 档也不自动放行（R0 §10.2 全局允许的上限）
  if (intent.destructive) {
    return { verdict: "ask", reason: "destructive operation always asks" };
  }

  if (matchesGrant(intent, grants)) {
    return { verdict: "allow", reason: "matched existing grant" };
  }

  switch (tier) {
    case "readonly":
      return isReadOnly(intent)
        ? { verdict: "allow", reason: "readonly tier: read operation" }
        : { verdict: "ask", reason: "readonly tier: side effect requires consent" };
    case "auto":
      return isRisky(intent)
        ? { verdict: "ask", reason: "auto tier: risky operation requires consent" }
        : { verdict: "allow", reason: "auto tier: routine operation" };
    case "full":
      return { verdict: "allow", reason: "full tier" };
  }
}

function isReadOnly(intent: OperationIntent): boolean {
  return intent.category === "fs-read" || intent.category === "git-read";
}

function isRisky(intent: OperationIntent): boolean {
  if (intent.category === "network" || intent.category === "exec" || intent.category === "mcp-tool") {
    return true;
  }
  if (intent.category !== "fs-write" || intent.cwd === undefined) return false;
  const paths = /^[A-Za-z]:[\\/]/.test(intent.cwd) ? win32 : posix;
  const cwd = paths.resolve(intent.cwd);
  return intent.targets.some((target) => {
    const resolved = paths.resolve(cwd, target);
    const relative = paths.relative(cwd, resolved);
    return relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative);
  });
}

function matchesGrant(intent: OperationIntent, grants: readonly Grant[]): boolean {
  const fp = computeFingerprint(intent);
  return grants.some((g) => {
    if (g.kind === "fingerprint") return g.value === fp;
    // pattern Grant：命令前缀匹配（"永远允许这条命令"），不绑指纹
    return intent.command !== undefined && intent.command.startsWith(g.value);
  });
}
