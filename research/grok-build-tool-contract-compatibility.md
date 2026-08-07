# Grok Build 外部会话与工具契约兼容研究

研究日期：2026-08-05  
上游仓库：`xai-org/grok-build`  
核验 Commit：`d6937fe255dce4133c3d000a50f9cb94de12f06f`

## 结论

Grok Build 公开源码提供了两组对 Picode 很有价值、但彼此独立的机制：

1. 外部会话只先做有边界、元数据级扫描；选择继续时创建新的 Grok 会话，并发送 `/resume-claude <id>`、`/resume-codex <id>` 或 `/resume-cursor <id>`，没有把外部 JSONL 直接当成 Grok 原生历史载入。
2. Grok 的工具系统有 Harness-independent taxonomy、canonical metadata、稳定参数投影、工具名/参数名重映射，以及历史 tool-call/result 配对修复。

公开源码不能证明 Grok 已经实现“把 Claude/Codex/Cursor 全量历史工具调用转换成 Grok 原生工具调用”的通用迁移器。Picode 应学习它的分层，而不能声称直接复制一个已经存在的完整实现。

## 源码证据

### 1. 外部会话扫描刻意保持 metadata-only

`xai-grok-workspace/src/foreign_sessions/mod.rs` 明确把该模块描述为 bounded、metadata-only listing。公开结构 `ForeignSessionSummary` 只有来源、原始 ID、标题、cwd、更新时间和 branch。

Claude 扫描器只有限读取文件头尾来取得 cwd、标题和分支，并过滤 sidechain、meta、tool result 噪声；Codex 扫描器优先读状态数据库，失败后才读 rollout 文件。扫描结果有年龄、数量、目录条目和内容读取预算。

相关文件：

- `crates/codegen/xai-grok-workspace/src/foreign_sessions/mod.rs`
- `crates/codegen/xai-grok-workspace/src/foreign_sessions/claude.rs`
- `crates/codegen/xai-grok-workspace/src/foreign_sessions/codex/mod.rs`
- `crates/codegen/xai-grok-workspace/src/foreign_sessions/codex/db.rs`
- `crates/codegen/xai-grok-workspace/src/foreign_sessions/codex/files.rs`

这与 Picode 已决定的“候选列表不全文扫描”一致。

### 2. 外部 resume 是新会话，不是原生历史冒充

`xai-grok-pager/src/app/session_startup.rs` 将 `ForeignResume` 注释为：为恢复外部工具会话而创建的 fresh plain Grok session。

`xai-grok-pager/src/app/dispatch/session/load.rs` 对外部来源先创建新会话，再发送由 `ForeignPickerSource::resume_prompt` 生成的命令。命令格式来自 `xai-grok-pager/src/app/foreign_sessions.rs`：

```text
/resume-claude <native-id>
/resume-codex <native-id>
/resume-cursor <native-id>
```

因此 Grok 避免把外部持久化格式直接当作自己的实时会话权威。这一点应由 Picode 原样继承为原则。

本次固定 Commit 中，workspace scanner 已实现 Claude 与 Codex；`scan_foreign_sessions` 对 Cursor 仍传入返回空列表的占位 closure。公开仓库也没有包含三个 `resume-*` bundled Skill 的正文，因此不能从该源码核验 Skill 最终怎样读取和转换完整历史。相关用户指南仍把部分 session compatibility 描述为 staged，说明公开文档与当前内部装配存在演进差异。Picode 不能把这些未公开/未完成部分当作现成兼容保证。

### 3. Grok 有跨 Harness 的 canonical tool metadata

`xai-grok-tools/src/tool_taxonomy.rs` 定义 `CanonicalToolMeta`，在工具事件 `_meta["x.ai/tool"]` 中记录：

- version
- 原始/客户端可见 name
- kind
- namespace
- 跨 Harness 展示 label
- read_only
- 可选 canonical input projection

设计说明特别强调：

- `label` 是跨 Harness 分组键；
- `name` 仍保留 Harness-specific 工具名；
- `input` 只是稳定字段投影，不是 raw input 镜像；
- 没有稳定形状时省略投影，由消费者回退读取 raw input；
- 未知 kind 降级为 `other`，而不是让整条事件反序列化失败。

`xai-grok-tools/src/normalization.rs` 从已经解析成功的 typed `ToolInput` 生成投影。当前只对 read、bash、search/replace、write、list、grep 等稳定语义投影少量字段；MCP、动态工具、控制流、subagent 等没有稳定跨 Harness 形状时明确返回 `None`。

### 4. 工具注册支持名字和参数契约重映射

`xai-grok-tools/src/registry/types.rs` 的 `ToolConfig` 支持：

- `name_override`
- `params_name_overrides`
- 行为版本
- namespace 与 kind

注册表同时包含 Grok Build、Codex 和 OpenCode 的工具实现。Codex 实现明确标记为从 OpenAI Codex 移植的 faithful port；OpenCode 工具保留其参数命名习惯。说明 Grok 的兼容方式不是只有 alias，而是必要时保留不同实现和 schema，再用 canonical metadata 跨 Harness 归类。

### 5. 历史会话会独立修复 Provider-critical 工具配对

`xai-chat-state/src/compaction_utils.rs` 的 `repair_history` 会：

- 去除重复 ToolResult；
- 去除 orphan/displaced ToolResult；
- 为 dangling tool call 补入 synthetic halted result；
- 保持操作纯函数且幂等。

其注释明确指出，错误的 call/result 相邻关系会导致 Provider 400，并让会话持续不可用。

`xai-grok-sampling-types` 再把统一的 `ConversationItem` 分别转换为 Messages/Responses/Chat Completions wire format；无法原生表达的 backend tool call 会变成 synthetic text 以保留上下文。

## 对 Picode 的直接启示

Picode 需要比 Grok 公开的 session picker 多走一步，因为 Picode 的产品目标包括“选择性导入完整聊天并在 Pi 中继续”：

1. 外部原始记录必须作为不可变 Snapshot 保存。
2. 外部 structured tool call 不能直接进入新的 Pi/Provider 历史。
3. 每个来源 Adapter 先生成中立事件，再由唯一 Tool Contract Registry 映射到稳定语义。
4. 映射只用于解释历史和告诉当前 Agent 可用的替代能力；历史调用绝不自动重执行。
5. call/result 结构损坏必须按事件修复或降级，不能让整条聊天回退。
6. 继续外部聊天时创建新的 Pi Session，并注入包含来源、已完成操作、Artifacts、未决工作和兼容损失的 Resume Capsule。

## 不应照抄的部分

- 不能把 `/resume-*` Skill 当成唯一契约。Skill 可以做来源获取，但结构正确性和 Provider 兼容必须由确定性 Module 保证。
- 不能把名字相同视为语义等价。IDE buffer、selection、notebook、remote workspace 等语义不能静默降级成普通文件 edit。
- 不能把所有旧工具注册进当前模型的 Tool Schema。历史可读性与当前可调用能力必须分离。

## 许可证提醒

Grok Build 第一方代码为 Apache-2.0；其 Codex/OpenCode ports 带各自 notices。实施时可以借鉴接口形状和算法，也可以在许可证允许下复用具体代码，但必须保留上游 notices，并以固定 Commit 重新核验实际文件头和项目许可证。
