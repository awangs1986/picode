/**
 * 固定工具语义 ID vocabulary（契约文档 §13 P1）：
 * 与产品工具名无关的稳定工具语义（Tool Semantic Operation）。
 * ImportCompiler 的映射目标、未来兼容判定的最小词汇表。
 * 版本后缀 @N：语义（输入/结果/副作用边界）变更时递增，不复用。
 */
export const SEMANTIC_OPS = {
  fsRead: "fs.read@1",
  fsWrite: "fs.write@1",
  fsEdit: "fs.edit@1",
  fsSearchText: "fs.search_text@1",
  fsGlob: "fs.glob@1",
  processExec: "process.exec@1",
  webFetch: "web.fetch@1",
  webSearch: "web.search@1",
  taskTodo: "task.todo@1",
  taskDelegate: "task.delegate@1",
} as const;

export type SemanticOp = (typeof SEMANTIC_OPS)[keyof typeof SEMANTIC_OPS];

const ALL: ReadonlySet<string> = new Set(Object.values(SEMANTIC_OPS));

export function isKnownSemanticOp(value: string): value is SemanticOp {
  return ALL.has(value);
}
