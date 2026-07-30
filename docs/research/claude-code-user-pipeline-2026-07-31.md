# Claude Code 用户工作管线研究

日期：2026-07-31

## 证据边界

- `claude-code-best/claude-code` 不是 Anthropic 官方源码仓库。其 README 将项目描述为 Claude Code 的工程化复原，并声明仅供学习研究，因此本文只把它的 `/goal`、工作流脚本等内容视为第三方增强。
- Claude Code 的核心行为以 Anthropic 官方文档为准；本文不会把第三方实现细节写成官方保证。
- Picode 的比较依据是本仓库的 `CONTEXT.md`、`docs/specs/task-execution.md` 和 `docs/P0-P5-BACKLOG.md`。

## Claude Code 的用户管线

1. 用户从一个当前目录启动 Claude Code，或在 Desktop/IDE 中选择项目；核心单位是 session 和 cwd。
2. 启动时加载适用范围内的 `CLAUDE.md`、自动记忆、Git 状态以及已配置扩展的简要描述。
3. 用户直接输入任务，或先切换 Plan Mode；Plan Mode 先读项目、产出计划，再由用户选择许可模式进入实施。
4. 主 Agent 在“收集上下文 → 使用工具和修改 → 运行测试或检查”的循环中推进。
5. Skills 按需提供流程，Hooks 在生命周期事件上确定执行，MCP 提供外部工具，Plugins 负责组合与分发。
6. Subagent 使用独立上下文处理受委派工作；复杂场景还可使用后台任务、Agent Teams 或 worktree 隔离。
7. 任务的验证强度主要由用户指令、`CLAUDE.md`、Skill、Hook、项目测试和 CI 决定，不存在适用于所有项目的统一 Harness Completion Gate。
8. 中断后主要依靠 transcript、自动压缩、checkpoint、resume 和 fork session 恢复；工程文件的可靠历史仍应交给 Git。

## 与 Picode 的核心判断

| 维度 | Claude Code | Picode |
|---|---|---|
| 基本单位 | session-first、cwd-first | 持久 Chat Session、Task Run、Execution Epoch |
| 开始任务 | 进入项目后直接对话，可选 Plan Mode | 明确选择 Simple 或 Harness；Simple 使用安全 Scratch Space，Harness 绑定工作区 |
| 工作流 | 由 `CLAUDE.md`、Skills、Hooks、MCP 和提示组合 | Harness 有显式计划、证据、门禁和完成状态；Skill 可形成可见覆盖 |
| 多供应商 | 主要围绕 Claude 认证和模型选择 | Codex、Claude、Cursor、自定义 API 的账号、模型和聊天归属是核心域 |
| 中断接管 | 恢复同一 session；可换模型 | 账号断线后保留任务，但必须由用户输入“继续”才建立新 Epoch |
| 验证 | 测试、Hook、CI 和模型判断共同决定 | Harness Completion Gate、Evidence Ledger、明确的验证状态标签 |
| 可观测性 | 状态、上下文、费用、后台任务/Agent 视图 | 计划统一显示 Agent 树、账号/模型、CPU、内存、等待原因和疑似卡死 |
| 迁移 | session resume、checkpoint、fork | 聊天选择性导入、备份、跨系统工作区重新绑定、路径可移植性 |

## 最值得借鉴的部分

Claude Code 最成熟的不是单一“开发管线模板”，而是扩展职责分层：

- `CLAUDE.md`：稳定的项目事实和约定；
- Skill：需要推理的按需工作流；
- Hook：必须确定执行的检查和边界；
- MCP：外部工具与数据连接；
- Plugin：组合、版本化和分发；
- Subagent：上下文隔离和并行委派。

Picode 不应放弃自己的 Task-first、多供应商接管和 Harness 证据链；应把 Claude Code 的快速项目启动与成熟扩展内循环吸收到 Harness Task 内部。

## 来源

- [Claude Code：How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- [Claude Code：Memory](https://code.claude.com/docs/en/memory)
- [Claude Code：Permission modes](https://code.claude.com/docs/en/permission-modes)
- [Claude Code：Extend Claude Code](https://code.claude.com/docs/en/features-overview)
- [Claude Code：Subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code：Worktrees](https://code.claude.com/docs/en/worktrees)
- [Claude Code Best README](https://github.com/claude-code-best/claude-code)
- [Picode task execution specification](../specs/task-execution.md)
- [Picode P0-P5 backlog](../P0-P5-BACKLOG.md)

