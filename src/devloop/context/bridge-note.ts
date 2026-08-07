/**
 * 桥接注记（PICODE-V3-DESIGN.md §3.5 第 2 层，R3 P0-4）。
 * Devloop 渲染，Engine 只追加。
 *
 * 只含确定性、白名单化的兼容事实。禁止注入：外来 system prompt、
 * 外来权限规则、外来完成语义、外来 Skill 指令、"继续遵循此前规则"
 * 类行为要求（提示注入风险 + 旧契约覆盖现契约）。
 *
 * 白名单靠构造实现：渲染器只接受结构化映射数据，没有自由文本入口。
 */

export interface BridgeNoteInput {
  sourceAgent: string;
  /** 外来工具名 → 当前 pi 工具名；无对应则值为 null（只作历史记录） */
  toolMappings: Record<string, string | null>;
}

export function renderBridgeNote(input: BridgeNoteInput): string {
  const lines: string[] = [
    `[imported-session note]`,
    `这是从 ${input.sourceAgent} 导入的历史。`,
    `历史 Tool Trace 不会执行。`,
  ];
  for (const [foreign, current] of Object.entries(input.toolMappings)) {
    lines.push(
      current === null
        ? `历史 ${foreign} 只作为历史记录，无当前对应工具。`
        : `历史 ${foreign} 对应当前 ${current}。`,
    );
  }
  lines.push(`当前可调用工具以本会话 Tool Schema 为准。`);
  return lines.join("\n");
}
