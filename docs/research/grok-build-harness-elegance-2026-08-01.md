# Picode 与 Grok Build Harness 管线：精简性与优雅性复评

日期：2026-08-01

## 核验范围

- Grok Build 固定基线：公开镜像提交 [`dd04f397b1d02f2272b092555669dfba1f01bc85`](https://github.com/xai-org/grok-build/tree/dd04f397b1d02f2272b092555669dfba1f01bc85)，并在 2026-08-01 复核官方 `main` 用户指南。官方 [`SOURCE_REV`](https://raw.githubusercontent.com/xai-org/grok-build/main/SOURCE_REV) 当日记录的上游 monorepo revision 为 `2a28b4a86cfc4a4c133c35b7fc2a6a9964387c39`。
- Picode：本地提交 `2b7245499af373bfd2b24ef1f663eb89e6404b80` 加当前未提交的 Runtime Lifecycle 深化修改；以当前源码、`docs/specs/task-execution.md`、ADR-0025/0027 为准。
- 本文的“精简”分为三种：用户步骤少、模型上下文负担小、运行时常驻成本低。“优雅”采用深模块标准：复杂度是否被小接口隐藏，以及默认管线是否与产品目标一致。

## 结论

如果只问**当前默认开发体验谁更优雅**，Grok Build 胜出。它把绝大多数能力收在一个连续 Agent Session 后面：用户给任务，模型自行决定直接执行、进入 Plan、调用 Skill 或派生子代理；验证可通过可选 Stop Hook 接入。这条主路径短、成熟、可组合。

如果问**谁在资源和上下文上更克制**，Picode 的 Simple Task 胜出。它默认不加载 Harness Profile、扩展发现、LSP、MCP、子代理或完整工具 schema，专业能力保持可发现但非驻留。Grok Build 默认启用子代理和代码库索引，会加载适用范围内的项目规则，并允许模型根据 Skill 描述自动调用 Skill。

如果问**谁更适合作为可证明完成的中型工程开发者 Harness**，Picode 的目标模型更严格：Gate、红探针、Evidence、Task/Agent/Runtime lineage 是一等概念；Grok Build 的 Stop Hook 很灵活，但 hook 失败会 fail-open，而且连续阻止八次后强制结束，因此不能单独充当高保证完成证明。

因此不能用一个总分掩盖差异：

- 默认 Agent 回路：Grok Build 更精简、更优雅。
- 空闲资源与模型上下文：Picode Simple 更精简。
- 工程验证契约：Picode 更严格，但当前用户可见概念更多、管线不够优雅。
- “强模型少 Harness”理念：Grok Build 的运行行为目前更接近；Picode 已有正确分层，但尚未按模型能力自动减少软指导。

## 用户管线对比

| 阶段 | Grok Build | Picode Simple | Picode Harness |
|---|---|---|---|
| 入口 | 打开一个 Session，直接输入任务 | 新建 Simple，可无工作区 | 新建 Harness，绑定工作区 |
| 初始规则 | 加载作用域内项目规则；Agent/Profile 决定模型、工具、prompt mode | Pi 核心行为；无 Harness Profile | 精简任务契约 + 模板/Profile/Override |
| 规划 | 模型判断是否请求进入只读 Plan Mode；用户也可手动进入 | Pi 自主决定，用户/Skill 可覆盖 | Task Harness 可要求规划，用户/Skill 可覆盖 |
| Skill | Skill 描述参与匹配，模型可自动调用；完整正文调用时进入对话 | 安装/发现不自动控制流程；明确调用后生效 | 明确调用形成可见 Task Override |
| 工具 | 统一工具集、MCP、LSP、plugins；部分能力由配置开关 | 最小 Pi 核心；扩展发现默认关闭 | 核心 + 可搜索的 lazy 能力；实现调用时加载 |
| 子代理 | 默认启用；模型调用 `spawn_subagent`，独立上下文，可选 persona/model/worktree | 默认不需要 | 只有合格的有界任务才自动委派，模型候选由用户配置 |
| 上下文 | Session 全历史 + 自动 compact + checkpoint；项目规则进入每次交互上下文 | 有界 Pi 上下文，无额外 Harness 注入 | 目标/状态/Gate 摘要应进入上下文，完整证据留在本地模块 |
| 完成 | 模型 EndTurn；可选 Stop Hook 阻止并反馈，最多八轮且 hook 失败 fail-open | 普通 Pi 回合结束，不声称 Harness verified | Runtime Lifecycle 在 `agent_end` 后运行 Completion Gate；只有真实通过才完成 |
| 恢复 | Session 事件流、plan、rewind snapshot、compact checkpoint、subagent metadata | 聊天/任务持久化与账号续接 | Task/Agent/Runtime lineage、投影 checkpoint、Reconciling、Git/evidence |

## 为什么 Grok Build 的主路径更优雅

### 1. 一个主接口隐藏多数能力

Grok Build 的外部心智模型主要是“Session + prompt + tools”。Plan、Skill、Subagent、background task、hooks 和权限都是同一 Session 的可选行为，而不是开始任务前必须理解的产品类型。官方 README 也把 TUI、headless 与 ACP 都放在同一个 Agent runtime 上。[README](https://github.com/xai-org/grok-build)

从深模块角度看，这个接口具有高 leverage：相同 Session 语义覆盖交互、脚本、CI 和编辑器嵌入。Picode 目前要求用户或内部管线理解 Chat Session、Task Run、Task Kind、Task Harness、Profile、Override、Execution Epoch、Agent Run、Runtime Instance 与 Gate；这些概念各自合理，但整体接口仍偏宽。

### 2. 规划是渐进启用，不是默认仪式

Grok Build 的 Plan Mode 只用于真正存在实现歧义的任务，模型请求进入时还需要用户批准；明确的小改动不应进入 Plan。Plan 模式才会把写入限制到 session 的 `plan.md`。[Plan Mode](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/19-plan-mode.md)

这与“强模型先自主工作，遇到架构不确定性再加结构”高度一致。Picode 的 Simple Task 已经如此，但 Harness Task 仍倾向于在任务开始时实例化完整工程契约。

### 3. 验证作为可组合 Stop Hook

Grok Build 的 Stop Hook 可以在模型准备结束时运行测试并把失败原因反馈给模型，形成简洁的 `work -> stop check -> continue/finish` 回路。[Hooks](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/10-hooks.md)

这个 seam 很优雅，但保证等级有限：hook 超时、崩溃或格式错误时 fail-open；连续八次阻止后也会强制结束。它适合普通工作流自动化，不足以单独证明严格 Harness completion。

## 为什么 Picode 仍然更克制

### 1. Simple Task 是真正的零 Harness 路径

Picode 明确规定 Simple Task 不要求工作区选择、Harness discovery、Git、LSP、MCP、子代理或扩展进程，并且新 Simple Task 不接收全局能力 shortlist，除非用户主动开启扩展发现。这比 Grok Build 的单一默认 Session 更能保证低常驻成本和低提示负担。

### 2. 能力发现与实现加载分离

Picode 的二级能力只暴露轻量 manifest，完整 schema 和进程在选择后才加载；三级能力在用户启用前连模型都搜索不到。Grok Build 同样支持配置开关和 Skill 按调用加载正文，但官方配置显示代码库索引默认开启，子代理默认开启，所有匹配的项目规则会加入上下文。[Configuration](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/05-configuration.md) · [Project Rules](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/12-project-rules.md) · [Subagents](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/16-subagents.md)

### 3. 安全和验证不靠提示词

Picode 把权限、Secret Reference、workspace binding、破坏性操作确认和 Runtime transition 放在本地代码中。Grok Build 也有分层权限和可选 OS sandbox，但 sandbox 默认关闭；其权限模式与 allow/ask/deny 规则仍然是可靠的底层防线。[Permissions](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/22-permissions-and-safety.md) · [Sandbox](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/18-sandbox.md)

Picode 的方向更适合“少用 prompt 管模型”：确定性要求由代码执行，模型只需要知道目标、当前约束、可用动作与完成条件。

## 与“模型越强，越少 Harness”理念的符合度

### Grok Build

更符合**运行时自主性**：

- 模型判断是否需要 Plan；
- 模型可根据任务自动调用 Skill；
- 模型自行决定是否派生子代理；
- 默认 EndTurn 即可完成，只有配置了 Stop Hook 才增加 Gate。

但也存在反方向因素：

- 自动 Skill 调用可能给强模型叠加不必要流程；
- project rules 对树内每次交互生效，多规则文件可以累积上下文负担；
- 子代理和代码库索引默认开启；
- Agent/Profile/persona 可以叠加 prompt body、skills 和行为 overlay。

### Picode

更符合**架构分层**：

- Simple 与 Harness 分离；
- 安装 Skill 不等于调用 Skill；
- 扩展和完整 schema 延迟加载；
- Gate 验证事实，不要求模型按固定思维链工作；
- Runtime Lifecycle 和权限在代码层执行。

但尚未实现关键的自适应部分：

- Harness 强度目前主要由 Task Kind/Profile 决定，而不是模型经验证的能力；
- 同一个 Harness 对强模型和弱模型暴露的流程指导差异不大；
- 没有完整的“先薄后厚”升级状态机；
- 两轮修复等默认自治限制没有按模型和任务证据动态调整。

## 推荐的 Picode 收敛方式

不要取消 Simple/Harness，也不要让高级模型绕过 Gate。应把 Harness 分成两条互相独立的轴：

1. **Assurance Policy（硬约束）**：权限、Secret、workspace/Git safety、必须运行的 Gate、红能力、Evidence、完成标签。它由任务风险和用户要求决定，不因模型更强而取消。
2. **Guidance Policy（软脚手架）**：提示详细度、是否强制计划、Skill 推荐、任务拆分、子代理建议、检查清单和修复轮次。它可以根据模型能力减少。

建议默认提供：

- `Lean`：只给目标、硬边界、工具摘要和 Gate；不自动调用 Skill，不强制计划。
- `Adaptive`：从 Lean 开始，发生 Gate 失败、重复错误、上下文遗漏或不确定性时逐级增加指导。
- `Guided`：为能力较弱或用户指定的模型预先提供更细计划、Skill 和检查清单。

模型档案不能按品牌或名字猜测。必须来自本地/官方声明能力、工具兼容性和 Picode 对相同任务类的可重复评测。即便是最强模型，复杂高风险任务仍可选 Guided；即便是小模型，明确的一行修改也不必进入完整 Harness。

## 最终判断

当前版本如果必须只选一个“更精简和优雅”的整体 Harness，答案是 **Grok Build**：它的默认用户管线更短，Session seam 更深，Plan/Skill/Subagent/Hook 围绕同一个 Agent loop 组合，成熟度也更高。

但这个结论不等于 Picode 应复制 Grok Build。Picode 的 **Simple Task + lazy capability + deterministic Gate + multi-provider GUI** 更贴合自身定位。Picode 真正的问题不是功能太多，而是 Harness 的软指导和硬保证尚未彻底分离。完成 `Assurance Policy / Guidance Policy` 分轴和渐进式脚手架后，Picode 可以在保留更强工程证明的同时，比 Grok Build 更少消耗提示词、更少启动常驻能力，也更符合先进模型的自主性。
