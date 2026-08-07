# Coding Agent 的 Slice/Capsule 抗失真机制市场核查

> 日期：2026-08-07  
> 结论范围：只依据公开的第一方文档、官方源码仓库和官方产品文档；没有公开证据的内部实现不作断言。

## 结论

截至本次核查，没有找到一个公开 Coding Agent 完整实现 Picode 当前设计的全部组合：

1. Task Control 根据阶段/预算确定性切分主任务；
2. 每个 Slice 有范围、Gate、Candidate Snapshot 和完成条件；
3. Capsule 把权威复制的 Verbatim Facts 与模型摘要 Narrative 分开；
4. 下一 Slice 默认使用新会话；
5. Required Context 从文件、Git、设计文档和 Gate Evidence 重新推导，而非只信摘要；
6. steer/rewind/账号接续使旧 Capsule 和 Evidence 显式 stale。

公开实现中，**Oh My Pi 的 handoff strategy 最接近“新 Session + 交接文档”**；Claude Code 最接近“隔离工作单元 + 只回传摘要”；Grok Build、Codex、OpenCode、Cursor 和原版 Pi 主要提供 compaction、fork、checkpoint、subagent 或 session summary。它们都没有公开证明具备 Picode 的权威事实分区与 Evidence 重新推导闭环。

## 对比标准

| 能力 | Picode 含义 |
|---|---|
| Deterministic Slice | 系统根据阶段、预算和生命周期决定任务切片，不只靠模型建议 |
| Slice Contract | 目标、范围、Contract Edge、Gate、预算和完成条件 |
| Verbatim Capsule | 用户决定、Snapshot、Gate 和文档身份从权威源复制，禁止摘要覆盖 |
| Narrative Capsule | 允许模型总结过程和理由，但不能替代事实 |
| Fresh Session | 下一工作段默认使用新模型会话 |
| Re-derived Context | 新会话重新读取项目文件、Git、设计文档和 Evidence |
| Stale Invalidation | 目标、Snapshot 或 Revision 变化使旧证据失效 |

## 产品核查

### 1. Oh My Pi：最接近，但仍不完整

Oh My Pi 的 compaction 文档公开了 `handoff` strategy：`generateHandoff(...)` 根据当前 system prompt、tool array 和真实消息历史生成 handoff document；随后 `AgentSession.handoff()` 开始一个新 Session，把文档作为可见的 `custom_message` 注入，并从新 Session 重建模型消息。

它还累计跟踪 `read/write/edit` 文件活动，把文件列表加入 summary/handoff；普通 compaction 有边界选择、tool-result 配对保护、Artifact/Shake/Snapcompact 和分支摘要。

第一方来源：

- [Oh My Pi compaction pipeline](https://github.com/can1357/oh-my-pi/blob/main/docs/compaction.md)
- [Oh My Pi task/subagent tool](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md)

与 Picode 的差距：

- handoff document 仍主要由模型生成，不是 Task Control 从多个权威源复制的 Capsule；
- 没有公开的 Verbatim Facts/Narrative 强制分区；
- 没有公开证明新 Session 会重新从 Git、Gate Result 和设计文档推导 Required Context；
- 没有 Candidate Snapshot/Task Revision 驱动的 Evidence stale 规则；
- handoff 由 context maintenance 驱动，不等于完整工程阶段 Slice Contract。

裁定：**高度相似的 Session Handoff，约覆盖 Picode 机制的一半，是最值得直接参考的实现。**

### 2. Claude Code：隔离上下文与委派摘要

Claude Code 的 Subagent 在独立、全新的 context window 中工作。父 Agent 为其生成 delegation task message；Subagent 完成后只把结果摘要返回主会话。官方建议把会产生大量文件、日志和测试输出的工作交给 Subagent，以保护主 Context。Subagent 还能使用独立 Git Worktree，并有独立 transcript 和自动 compaction。

第一方来源：

- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code context window](https://code.claude.com/docs/en/context-window)
- [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)

与 Picode 的差距：

- 它切的是委派工作，不是主 Task 的确定性阶段 Slice；
- delegation message 是父 Agent 生成的任务摘要，没有公开的权威事实 Capsule schema；
-官方说明在多阶段共享大量 Context 时应继续使用主会话，未公开自动把主任务迁移到新会话；
- 没有公开的 Candidate Snapshot/Gate Evidence 重新推导和 stale 机制。

裁定：**强 Context 隔离和工作单元设计，但不是 Picode 的主任务 Slice/Capsule。**

### 3. Grok Build：Goal/Workflow + compaction/fork

Grok Build 公开提供 `/compact`、85% auto-compact、`/fork`、`/rewind`、`/goal` 和可暂停/恢复 Workflow。`/goal` 有预算和独立 Evidence Review，Workflow 有确定性脚本与运行状态。

第一方来源：

- [Grok Build slash commands](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/04-slash-commands.md)
- [Grok Build repository](https://github.com/xai-org/grok-build)

与 Picode 的差距：

- `/compact` 是同一 Session 的历史压缩；`/fork` 继承此前历史；
- Goal/Workflow 提供任务控制，但公开文档没有把阶段自动转成新 Session + Capsule；
- 没有公开 Verbatim/Narrative Capsule 或跨 Slice 重新推导 Context/Evidence 的契约。

裁定：**任务治理和验证思想接近，Context Handoff 仍主要是 compact/fork。**

### 4. OpenCode：子 Session + 隐藏 compaction/summary Agent

OpenCode 的 Subagent 建立 child session，可在 parent/child session 间导航。它还有隐藏的 compaction Agent 和 summary Agent，在需要时自动压缩长 Context 或生成 Session summary。

第一方来源：

- [OpenCode agents](https://opencode.ai/docs/agents/)

与 Picode 的差距：

- child session 是委派结构，不是主 Task 的阶段切片；
- compaction/summary 仍是模型摘要；
- 没有公开权威 Capsule、Snapshot/Evidence stale 或 Required Context 重新推导。

裁定：**具备组成零件，没有形成同一套抗失真契约。**

### 5. Cursor：自动摘要 + 代码 Checkpoint

Cursor 官方文档公开自动 summarization，用于长对话 Context 管理；Checkpoint 是 Agent 修改代码的自动快照，可恢复文件状态。

第一方来源：

- [Cursor summarization](https://docs.cursor.com/en/agent/chat/summarization)
- [Cursor checkpoints](https://docs.cursor.com/en/agent/chat/checkpoints)

与 Picode 的差距：

-摘要仍在同一 Chat 的 Context 维护中；
- Checkpoint 保存代码改动，不是任务事实、Gate Evidence 或设计决策 Capsule；
- 没有公开阶段 Slice、新 Session 重建或 Evidence stale 契约。

裁定：**普通摘要和代码恢复，不是 Task Slice/Capsule。**

### 6. OpenAI Codex：Context compaction + resume/fork 基础

Codex 官方开源配置 schema 提供 `compact_prompt`，产品会进行 Context compaction；公开仓库的会话/问题记录也显示 `context_compacted` 事件和 resume 行为。公开资料没有显示一套由 Task Control 拥有的 Slice Contract/Capsule。

第一方来源：

- [Codex configuration schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json)
- [OpenAI Codex repository](https://github.com/openai/codex)

与 Picode 的差距：

- 主要机制是对同一会话做 compaction；
- compact summary 可配置，但依然是 summary；
- 没有公开 Verbatim Facts、从 Git/Gate 重新推导 Context 或 Task Revision stale 语义。

裁定：**提供长会话压缩，不是阶段式权威交接。**

### 7. 原版 Pi

Pi 有 Session Tree、branch/resume 和 compaction。它保留原始 Session 数据，并用 summary + recent messages 构建压缩后 Context。

第一方来源：

- [Pi monorepo](https://github.com/badlogic/pi-mono)
- [Pi context compaction design/implementation issue](https://github.com/badlogic/pi-mono/issues/92)

与 Picode 的差距：

- Pi 不拥有 Task Run、Slice Contract、Verification 或 Candidate Snapshot；
- compaction 是会话能力，不是工程治理；
- 这正是 Picode 应以 Extension/Bridge 补足、而不应重写 Pi 的部分。

裁定：**提供底层会话原语，Picode 在其上增加工程语义。**

## 相似度总结

| 产品 | 新 Context/Session | 交接摘要 | 权威事实分区 | 重新推导文件/Git/Gate | 工程 Slice | 综合判断 |
|---|---:|---:|---:|---:|---:|---|
| Oh My Pi handoff | 是 | 是 | 否 | 未公开 | 部分 | 最接近 |
| Claude Code Subagent | 是 | 是 | 否 | Subagent 自行读取，非系统契约 | 委派单元 | 部分相似 |
| Grok Build | fork/compact | 是 | 否 | 未公开 | Goal/Workflow 有 | 思路组合相似 |
| OpenCode | Child Session | 是 | 否 | 未公开 | 委派单元 | 部分相似 |
| Cursor | 否/未公开 | 是 | 否 | 否 | 否 | 普通 Context 管理 |
| Codex | compaction/resume | 是 | 否 | 未公开 | 否 | 普通 Context 管理 |
| Pi | branch/compaction | 是 | 否 | 否 | 否 | 底层原语 |
| Picode 设计 | 是 | Narrative only | 是 | 是 | 是 | 完整组合 |

## 对 Picode 的建议

1. **直接学习 OMP 的 handoff Session transition**：新 Session、可见 handoff、完整旧 transcript 仍可浏览、工具边界保护。
2. **不要照搬其模型摘要作为唯一真相**：Task Control 应单独构建 Verbatim Facts；模型只写 Narrative。
3. **学习 Claude Code 的 Context 隔离和 Worktree Subagent**：高噪音探索/测试留在子 Context，只返回有界结果。
4. **学习 Grok Build 的 Goal/Workflow/Evidence Review**：Slice 触发与完成必须是 lifecycle-driven，而不是仅写在 Prompt。
5. **保留 Pi 原生 Session/branch/compaction**：Picode 只增加 Task/Slice/Capsule 层，不重写 Session Runtime。
6. **用可红 Gate 证明差异**：故意让 Narrative 漏掉用户约束，下一 Slice 仍必须从 Verbatim Facts/Required Context 恢复正确目标。

## 最终判断

Picode 的单项技术并非市场上完全没有：handoff、new session、subagent isolation、compaction、checkpoint、goal 和 evidence review 都有成熟先例。真正少见的是把它们组合成一套由确定性 Task Control 拥有的工程抗失真协议，并明确把“权威事实复制”和“模型叙事摘要”分离。

因此更准确的定位不是“发明了全新的 Context 技术”，而是：

> Picode 把多个成熟 Agent 的最佳实践收敛成一套针对中型软件开发、可验证且不依赖模型记忆自觉的 Slice/Capsule 协议。
