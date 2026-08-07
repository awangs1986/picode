/**
 * 重定向表错误钩子（V3 §3.5 第 3 层防线）：
 * 模型在导入会话中调用外来工具名时，把 Pi 的 unknown tool 错误
 * 加厚为带重定向建议的提示。数据来自 ImportCompiler.redirectTable
 * （组合根在导入会话装载时传入），本模块不自己维护映射。
 *
 * 兜底顺序（Spike 12）：优先扩展钩子拦截；不可行时退 tool_result 包装；
 * 最后手段才是 unknown-tool 最小 Pi Patch。
 */

export interface RedirectContext {
  sourceAgent: string;
  /** 外来工具名 → 当前语义 ID（如 Read → fs.read@1） */
  redirects: Record<string, string>;
  /** 语义 ID → 当前 live 工具名（Guard Catalog resolveLive 的结果） */
  liveTools?: Record<string, string>;
}

/** 命中重定向表时返回加厚错误文案；未命中返回 undefined（保持 Pi 原始报错） */
export function enrichUnknownToolError(
  toolName: string,
  ctx: RedirectContext,
): string | undefined {
  const semanticOp = ctx.redirects[toolName];
  if (semanticOp === undefined) return undefined;
  const live = ctx.liveTools?.[semanticOp];
  const suggestion =
    live !== undefined
      ? `use the "${live}" tool instead`
      : `the equivalent capability is "${semanticOp}"; discover it via search_tools`;
  return (
    `Tool "${toolName}" belongs to the imported ${ctx.sourceAgent} history and is not available here. ` +
    `Historical tool traces are records only. For the same operation, ${suggestion}.`
  );
}
