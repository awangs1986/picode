/**
 * Foreign Resume Capsule 渲染（契约文档 §7.3，Devloop 只渲染不拥有事实）：
 * 从外部导入会话续作时的最小续作胶囊。与 Bridge Note 同为白名单化输出——
 * 只含确定性事实，不搬运外来行为指令（P0-4）。
 */

export interface ForeignResumeInput {
  sourceAgent: string;
  goal: string;
  /** 最近对话摘录（导入器已截取；此处原样呈现） */
  recentDialog: string[];
  completed: string[];
  pending: string[];
  filesChanged: string[];
  /** 导入损失申明（AdaptedLossy/Unsupported 摘要） */
  losses: string[];
  /** 工作区实际状态说明（如 "历史工作区不可用，代码需重新核对"） */
  workspaceState: string;
}

const section = (title: string, items: readonly string[]): string =>
  items.length === 0 ? `## ${title}\n(none)` : `## ${title}\n${items.map((i) => `- ${i}`).join("\n")}`;

export function renderForeignResumeCapsule(input: ForeignResumeInput): string {
  return [
    `# Resume from imported ${input.sourceAgent} session`,
    "",
    "Historical tool traces below are records only and will not execute.",
    "Current callable tools are defined by this session's tool schema.",
    "",
    `## Goal\n${input.goal}`,
    "",
    section("Completed (as claimed by imported history; unverified)", input.completed),
    "",
    section("Pending", input.pending),
    "",
    section("Files changed in imported history", input.filesChanged),
    "",
    section("Import losses", input.losses),
    "",
    `## Workspace state\n${input.workspaceState}`,
    "",
    section("Recent dialog", input.recentDialog),
  ].join("\n");
}
