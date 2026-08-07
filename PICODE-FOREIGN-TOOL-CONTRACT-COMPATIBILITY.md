# Picode 外部会话 Tool Contract 兼容设计

状态：设计已纳入，尚未授权实现  
日期：2026-08-05  
实施参考优先级：Grok Build 固定版本源码 → Picode V2 来源解析器 → 其他开源 Agent → 自行实现

## 1. 问题定义

“能够显示外部聊天”与“能够在 Pi 中继续外部聊天”是两件事。

Claude、Codex、Cursor、OpenCode 和 Grok 的历史里不仅有 user/assistant 文本，还可能有：

- Harness-specific 工具名；
- 不同版本的参数 schema；
- tool-call ID 与 tool-result 配对；
- reasoning、approval、hook、MCP 和 subagent 生命周期事件；
- IDE buffer、selection、remote workspace 等不能等同于普通文件系统的语义；
- 已完成、失败、被取消或写到一半的工具调用。

若把这些 structured messages 原样送入新的 Pi Session，最坏结果不是“少显示一条工具日志”，而是 Provider 因未知工具、非法参数、孤立 ToolResult、错误相邻关系或重复 call ID 拒绝整段请求。会话会在每轮继续失败，最后只能丢掉历史或退回不可信的纯文本摘要。

本设计的目标是：

> 保住外部会话的目标、对话、工具证据与未决工作，同时让任何单个不兼容工具只局部降级，永远不能拖垮整条会话。

## 2. 核心决策

### 2.1 外部会话永远不伪装成原生 Pi Session

外部记录作为不可变 `Foreign Transcript Snapshot` 导入 SQLite/Artifact Store。用户明确选择“继续”后，Picode 创建新的 Pi Session，并注入确定性编译的 `Foreign Resume Capsule`。

只有真正的 Pi JSONL 才允许走 Pi 原生 resume/fork。外部来源没有 `Raw Replay` 模式。

### 2.2 历史 Tool Trace 是证据，不是待执行命令

导入的命令、patch、MCP call、Hook、网络请求和 subagent call 永远是 inert data：

- 导入时不执行；
- 打开全文时不执行；
- 继续会话时不执行；
- 提升兼容映射版本时也不执行。

当前 Agent 若需要重复某个操作，必须根据当前 Workspace、当前工具和当前 Policy 重新规划并产生新的 Operation Intent。

### 2.3 规范化是有损可见的投影，不覆盖原文

每条外部工具事件同时保留：

1. 原始来源记录；
2. 规范化语义投影；
3. 映射判定与损失标记；
4. 面向模型的安全历史表示。

映射更新时可以重建投影，但不得改写原始 Snapshot。

## 3. 不新增第五个 Module（2026-08-07 R3 对齐 V3 四模块）

该能力跨越现有 Module，但没有新的领域权威。原七模块表述映射到 V3 四模块，且**历史语义映射权威从 Capability Catalog 移入 Store 的 `ImportCompiler`**（避免每个来源导入器复制映射逻辑，也避免正常聊天加载映射数据）：

| Module / Seam | 唯一职责 |
|---|---|
| 外部来源 Adapter（核心外） | 来源格式解析、call/result 配对；经 Import Contract 输出 `Foreign Transcript IR` + `SourceToolSignature` |
| Store（含 `ImportCompiler`） | 来源扫描、不可变 Snapshot、导入报告；**历史工具签名 → `Tool Semantic Operation` 的唯一映射**（导入时懒加载）、归一化投影与映射清单入库 |
| Guard（Capability Catalog） | 规范语义 → 当前可调用工具的解析（`resolveLive`）；当前 live tool 的名称、schema 与可用性 |
| Devloop（context/） | 把外部 IR、Artifacts、损失信息和 Task Capsule 渲染成 `Foreign Resume Capsule` 与桥接注记（白名单事实）；不决定映射 |
| Devloop（task/ 与 verify/） | 用户输入"继续"后创建 Task/Slice/Execution Epoch；外部测试结果默认 `Imported / Unverified`，当前 Candidate 重跑后才成为 Gate Evidence |
| Engine | 使用上游支持的事件形状创建新 Pi Session、只追加已生成内容；不把 foreign structured tool messages 原样发给 Provider |
| Guard（裁决）+ 沙箱 | 只治理继续后新产生的操作；不执行导入历史 |

删除某个来源 Adapter，只会使该来源不可导入，不会改变 Pi Runtime、当前工具目录或其他来源的兼容能力。

## 4. 两个中间表示

### 4.1 Foreign Transcript IR

Session Gateway 将各来源格式解析为统一但保真的事件流：

```text
ForeignEvent {
  imported_event_id
  source_agent
  source_version?
  source_session_id
  source_event_id?
  timestamp?
  actor
  event_kind
  raw_payload_ref
  normalized_payload?
  visibility
  parse_diagnostics[]
}
```

`event_kind` 至少区分 user、assistant、reasoning、system、environment、approval、tool_call、tool_result、artifact、task、hook 和 unknown。列表标题与摘要只消费 user/assistant；其余类型不会再被模糊 JSON 遍历误当聊天。

### 4.2 Historical Tool Trace

每个 tool call/result 对被编译成：

```text
HistoricalToolTrace {
  trace_id
  source_agent
  source_version?
  source_tool_name
  source_schema_digest?
  namespaced_call_id
  raw_arguments_ref
  raw_result_ref?
  semantic_operation?
  semantic_version?
  canonical_input?
  execution_state
  compatibility
  adapter_id
  adapter_version
  loss_flags[]
  diagnostics[]
}
```

Call ID 使用 `source_agent/source_session_id/source_call_id` 命名空间，避免多个来源或分支重复 ID。

### 4.3 Source Tool Contract Manifest

若来源 Session、请求日志或来源版本包能够提供当时的 tool definitions，导入器必须保存一份不可执行的契约清单：

```text
SourceToolContract {
  source_agent
  source_version?
  source_tool_name
  input_schema?
  result_shape_hint?
  declared_effect?
  contract_digest?
  provenance
}
```

优先级是“会话实际携带的 schema → 固定来源版本的已核验 schema → 仅观察历史参数形状”。最后一种不能取得 `Equivalent`，因为一次调用没有使用某字段，不代表旧契约不存在该字段或副作用。

## 5. 兼容判定

兼容性和历史执行状态必须分开：

### 5.1 Compatibility

| 状态 | 含义 | 可否宣称等价 |
|---|---|---|
| `Equivalent` | 名称、输入语义、结果语义和副作用边界等价 | 可以 |
| `AdaptedLossless` | 字段重命名、路径表示或默认值不同，但能确定性无损转换 | 可以，需显示 Adapter |
| `AdaptedLossy` | 只保住主要意图，丢失 IDE/显示/控制字段 | 不可以 |
| `HistoricalOnly` | 能解释和显示，但当前没有可信 live mapping | 不可以 |
| `Unsupported` | 无法可靠识别语义 | 不可以 |

### 5.2 Execution State

`Completed | Failed | Cancelled | Interrupted | Unknown`

缺少 ToolResult 的历史调用通常标记 `Interrupted` 或 `Unknown`，不能因为补了一段展示文字就伪装为 `Completed`。

### 5.3 Alias 不是兼容性的全部

下列情况通常可以无损映射：

```text
Claude Read / Codex read_file / Pi read -> fs.read@1
Claude Grep / OpenCode grep / Pi grep   -> fs.search_text@1
Codex shell_command / Claude Bash       -> process.exec@1
```

但 Cursor 的 selection edit、notebook cell edit、未落盘 buffer，或某个 MCP 私有工具即使名字叫 `edit`，也不能静默映射为普通文件 edit。它们应是 `AdaptedLossy`、`HistoricalOnly` 或 `Unsupported`。

## 6. Tool Contract Registry（R3 拆分归属）

Registry 职能一分为二：**历史侧**（来源签名 → 规范语义）归 Store 的 `ImportCompiler`，仅导入时懒加载；**当前侧**（规范语义 → live tool）归 Guard 的 Capability Catalog。外部 Interface 保持窄：

```text
# Store ImportCompiler
resolveHistorical(source_signature) -> HistoricalCompatibility
contractSnapshot() -> ToolContractSnapshot

# Guard Capability Catalog
resolveLive(semantic_operation, task_id) -> LiveToolResolution
```

`source_signature` 至少包含 source agent、source version、tool name 和 source schema digest；字段不可用时必须显式标记 unknown。仅凭工具名或一次历史参数样本不允许判定 `Equivalent`。

ImportCompiler 内部可以有多个映射 Adapter：Claude、Codex、Cursor、OpenCode、Grok 和版本变体（区别于核心外的来源格式解析 Adapter）。映射 Adapter 负责：

- 识别工具与版本；
- 验证参数形状；
- 生成稳定语义和最小 canonical input；
- 声明结果语义、损失和限制；
- 提供面向人的显示 metadata。

当前 live tool 的名称、schema、来源和可用性仍由 Capability Catalog 管理。历史 Adapter 不会把旧工具加入当前模型 Tool Schema。

## 7. 导入与继续流程

```mermaid
flowchart LR
    A["元数据扫描"] --> B["用户选择 Chat"]
    B --> C["来源 Adapter 全文解析"]
    C --> D["Foreign Transcript IR"]
    D --> E["Store ImportCompiler 规范化"]
    E --> F["配对修复与兼容报告"]
    F --> G["不可变 Snapshot / 只读浏览"]
    G -->|"用户输入继续"| H["Workspace Rebind"]
    H --> I["Foreign Resume Capsule"]
    I --> J["新 Pi Session + 当前 Live Tools"]
```

### 7.1 扫描

候选列表仍只读取标题、最近可读消息、时间、大小、Archive、来源、原 Workspace 和稳定 Session ID，不解析全文工具契约。

### 7.2 选择性导入

只有用户勾选的 Chat 才全文解析。每个 Chat 产生兼容报告：

- 对话事件数量；
- Equivalent / Adapted / HistoricalOnly / Unsupported 数量；
- dangling/orphan/duplicate call 数量；
- 是否可直接只读浏览；
- 是否存在阻止可靠继续的未决依赖。

单条事件失败不能中止整个 Chat；单个 Chat 失败也不能中止同批其他 Chat。

### 7.3 继续

继续前必须完成原 Workspace 分组绑定。Context & Memory 从权威源生成 `Foreign Resume Capsule`：

- 用户目标和最近有效对话；
- 已完成、失败和未决操作；
- 修改过的文件、patch 和输出 Artifact 引用；
- 当前仍存在的 Todo/Task；
- 映射损失、未知工具和不可信结论；
- 当前 Workspace 状态与当前可调用替代工具。

新 Pi Session 只收到普通上下文事件/Artifacts 和当前 live tool schema。外部 native tool call/result 不作为 Provider-native tool messages 重放。

新 Session 的 Task Kind 由用户当前选择决定：Simple 仍使用上游 Pi 的最小提示词和原生工具，Harness 才加载工程治理。旧 Transcript 中提到的 Skill、MCP、Hook、规则文件或工具定义一律是历史事实，不会因此自动启用；当前项目规则和能力必须从已绑定 Workspace 与当前 Capability Catalog 重新发现。

若未决任务依赖 `Unsupported` 工具的私有结果，系统必须明确显示 `Needs Revalidation`，让 Agent 读取当前仓库、重新运行等价检查或询问用户；不能静默宣布已恢复。

## 8. 历史结构修复

导入编译器必须处理 Provider-critical 结构错误：

- 重复 ToolResult；
- orphan ToolResult；
- ToolResult 出现在错误位置；
- dangling ToolCall；
- 重复 call ID；
- 参数不是合法 JSON；
- 工具名不满足当前 Provider 字符规则；
- 被截断的 JSONL/SQLite row；
- 一个来源 Session 被多个文件分片保存。
- 同名工具在来源版本升级后发生 schema 或副作用语义漂移。

修复只作用于规范化投影：原始 Snapshot 不改。由于外部历史不会直接重放为 native tool messages，损坏事件可以变成带 diagnostics 的 `HistoricalToolTrace`，而不需要为了满足 Provider 伪造成功结果。

## 9. Context、缓存与压缩

- 外部历史工具不进入当前 Tool Schema，因此不会单独改变 Tool Schema Digest。
- 只有当前真正可调用能力变化才开启新的 Tool/Cache Epoch。
- 全文解析和契约编译只针对用户勾选的 Chat 懒执行；普通启动、Simple Task 和候选列表扫描不加载这些 Adapter 的完整映射数据。
- 导入投影记录 `adapter_id/version` 与 `mapping_digest`；Registry 升级后可按需重编译投影。
- raw arguments/result 大对象进入 Artifact Store，Resume Capsule 只放稳定摘要与引用。
- `/pi-compress` 可以压缩历史叙事，但目标、未决任务、兼容损失、关键 Artifact 和 `Needs Revalidation` 属于不可被摘要覆盖的事实区。

## 10. Verification 与安全语义

- 外部 Agent 声称测试通过，只是 `Imported Claim`。
- 外部日志存在且结构可读，是 `Imported Artifact`。
- 只有在当前 Workspace/Candidate 上由 Picode Gate 重跑，才能成为当前 `Gate Result`。
- 导入的 shell 命令、脚本、MCP 请求和 Hook 永不执行。
- Secret redaction 发生在预览、Context 渲染和导出层；原始加密 Snapshot 的访问受 Session Gateway 控制。
- 原路径只作 provenance；任何继续执行使用显式 Workspace rebind 后的当前路径。

## 11. 用户界面

导入预览为每条 Chat 显示一个简洁状态：

```text
可浏览：是
可继续：是 / 需要重新验证 / 只读
工具兼容：42 等价 · 7 无损适配 · 2 有损 · 1 仅历史 · 0 未知
结构修复：1 个中断调用 · 0 个孤立结果
```

默认不展开 tool trace、reasoning 和日志。全文查看中工具显示统一 label、来源 badge、状态和摘要；点击后才显示原工具名、参数、结果、Adapter 与损失说明。

## 12. 可红 Gate

P3-C 每个来源 Adapter 必须通过独立 fixture Gate：

1. 未知工具只降级该事件，Chat 仍能导入和浏览。
2. 外部 ToolCall 永不在导入或继续时执行。
3. call/result 配对、重复 ID 和截断记录被稳定诊断。
4. 同一个外部 Chat 只产生一个稳定 Snapshot，不因文件分片重复。
5. 任何 raw foreign history 都不会作为 native tool message 直接进入 Pi Provider 请求。
6. 移除当前 live tool 后，历史仍可读，兼容状态变为 `HistoricalOnly/Needs Revalidation`，不会丢 Transcript。
7. Adapter 升级只重建 projection，原始 Snapshot hash 不变。
8. Windows/Linux/macOS 路径 fixture 经 rebind 后不会写入不存在或越界目录。
9. reasoning、system、approval 和 tool logs 不进入标题/最近消息摘要。
10. `Imported Claim` 不可让当前 Gate 变绿。
11. 缺失 source schema/version 时不得仅凭同名工具判为 `Equivalent`。

## 13. 分期

- **P1**：固定 Harness 工具获得稳定 semantic operation ID，为未来兼容建立最小 vocabulary；不实现外部导入。
- **P3-B**：Store ImportCompiler 实现历史语义映射，Guard Capability Catalog 实现 current live resolution（R3 拆分归属）。
- **P3-C**：逐个实现 Claude、Codex、Cursor 来源 Adapter、Snapshot、兼容报告和 Compiled Resume。单个 Adapter 延期不阻塞其他来源。
- **P4**：GUI/TUI 共享兼容报告、全文折叠和诊断 UI；用真实迁移样本做性能与失真验收。
- **P5**：只增加恶意 payload fuzzing、签名 Adapter/Registry 等 hardened 能力，不改变 P0-P4 的继续语义。

## 14. 最终不变量

1. 外部 Transcript 永远不是 Pi 实时 Transcript 的第二权威。
2. 外部历史工具永远不自动执行。
3. 原始 Snapshot 永远可追溯且不被 normalization 覆盖。
4. 工具兼容只按确定性 Adapter 判定，模型不能自称等价。
5. 未知/有损映射必须可见，不能静默吞掉。
6. 单条工具契约失效不能导致整条 Chat 回退。
7. 当前 Tool Schema 与历史 Tool Trace 分离。
8. 外部会话继续必定创建新 Pi Session，并且必须由用户明确输入“继续”。
