# Picode V3 四模块设计

> 状态：设计基线（2026-08-07）。拓扑见 ADR-0003（Extension-first），存储见
> ADR-0002（文件权威），沙箱见 ADR-0004，MCP 见 ADR-0005。
> 本文是四模块职责与模块内关键决策的单一记录点。

## 1. 模块划分（七模块合并而来）

| 模块 | 吸收的原模块 | 权威范围 |
|---|---|---|
| **Store** | Session Gateway | 文件权威的读写纪律（原子写+文件锁）、Chat/Task 目录索引、单一 Account Vault、外部会话导入（Import Contract Ingester）、备份 |
| **Engine** | Work & Sandbox + Pi Seam | pi SDK/扩展 API 封装、执行生命周期、Subagent 接入、Work 监督、Managed Worktree、沙箱 Provider 的调用侧 |
| **Guard** | Authorization & Policy + Capability & Tool Catalog | 权限预设、Operation Intent 裁决、approval_fingerprint、能力目录与信任生命周期、扩展状态 |
| **Devloop** | Task Control + Context & Memory + Verification | Task Run/Slice/Capsule、上下文组装与压缩、Quick Review、TDD 状态机、Gate/Evidence、Completion Label |

合并理由：每个模块对应一个真实交付物，变更节奏不同（Engine 跟 pi 升级走、
Guard 跟安全需求走、Devloop 是产品核心价值、Store 最稳定）。
"事实 → 唯一权威"表不变，只是从七个箱子装进四个箱子。

保留条款：

1. **Devloop 内部三道墙**：Capsule 事实归 task、context 只渲染、verify 唯一
   签发 Completion Label（三个子目录边界，不对外拆成模块）。
2. **Guard 的裁决逻辑必须是纯函数**（输入 Intent + 政策 + Grant 状态，输出
   决定），保证可红测试。

依赖纪律：模块间只经接口通信 + 一条内部事件总线做生命周期通知；
Adapter Extension 是组合根，模块不感知宿主形态（pi 进程 / P5 serve）。

### 1.0.1 默认 TUI 扩展

`pi-sticky-input` 是随安装包固定源码的 UI-only 默认扩展。组合根必须在首个
`session_start` 前注册它，使其能够给当前 Pi TUI 安装有界历史视口和增量行重绘；
不能等到会话内能力激活阶段。它不属于模型能力，不进入 Guard Catalog、工具 Schema、
Prompt 或 ActiveCapabilityLease。无法识别 Pi TUI 布局时必须回退上游 renderer，不能使
会话启动失败。来源版本和本地兼容补丁记录在
`vendor/pi-sticky-input/PICODE-PROVENANCE.json`。

**Pi Session Lifecycle** 位于 Engine：隐藏 Pi 首次 assistant turn 前延迟落盘的
实现细节。CLI、Slice 与导入 Adapter 只能通过该 interface 创建、seed、持久化、
解析和重新打开 Session；任何成功返回的 Session identity 都必须对应真实可恢复的
Pi JSONL。调用方不得手写 JSONL 或依赖 Pi 的 `flushed` 私有状态。

**Chat Writer Lease** 位于 Guard：它是“一 Chat 同时一个写入者”的唯一短期
所有权 module，负责 acquire、heartbeat、expiry、release 与连接清理。TUI、CLI、
Remote Serve 都只能共享或调用该 authority；传输 Adapter 不得维护自己的 lease Map。

### 1.1 CLI-first Control Interface Seam

Control Interface 位于组合层，不是第五个领域模块。增强 Pi TUI 与第一方无头 CLI
都只通过它编排四个领域模块；它不保存 Session、Task、Grant、Gate 或 Evidence。

- CLI 是 P0–P4 唯一公开自动化入口，不抓取或解析 TUI 文案。
- 无头 CLI 自己持有 vendored Pi Runtime，不依赖 TUI/Core。
- stdout 使用版本化 JSON/JSONL，诊断只进 stderr，非交互 ask fail-closed。
- HTTP/SSE 只是显式启用的内部诊断 Adapter；P5 MCP 只能薄映射同一 Interface。

### 1.2 Account Import Wizard Seam

裸 `/import`（以及兼容入口 `/accounts import`）进入 Adapter Extension 内的临时 Account Import Wizard；带路径的 `/import <path.jsonl>` 仍进入上游 Pi 原生会话导入。

聊天来源由 Adapter Extension 在启动 Wizard 时嗅探：Codex 使用 `CODEX_HOME`/`~/.codex`，Cursor 使用 `~/.cursor/projects` 等受支持 JSONL 根，Claude 使用 `CLAUDE_CONFIG_DIR`/`~/.claude/projects`。页面预填但不锁定路径。账号候选只来自外部 Agent 配置；Picode Account Vault、vendored Pi `auth.json` 和独立 Pi `/login` 库不得回流到导入候选。
它是深模块，不是新 Backend：调用者只需要启动/取消并观察完成结果；浏览器打开、
loopback listener、一次性认证、OAuth callback、来源选择和超时都藏在实现内。

- 默认自动打开系统浏览器，并在 TUI 打印回退链接；浏览器 Adapter 失败只产生
  可见诊断，不使 Wizard 失败。
- 页面只提交用户选择和凭据输入；本机配置扫描、来源解析、冲突计算与最终写入
  由 Picode 执行。
- Account Vault 是账号/凭据唯一权威。Wizard 只持有有界临时状态，不能直接写
  `accounts.json`，也不能建立浏览器侧账号缓存。
- Wizard 可复用 loopback HTTP 实现，但不复用 `/v1` 持久 token。一次性
  bootstrap token 交换临时 HttpOnly cookie 后清理 URL；完成、取消、超时或
  TUI 退出时撤销。
- Interface 的结果是结构化 `ImportOutcome`（applied/skipped/warnings/
  activeAccountChanged），供组合根刷新 TUI 并在需要时开启 Execution Epoch；
页面文案不是事实 Interface。

### 1.2.1 Remote Serve Adapter Seam（P5）

`serve/` 是 HTTPS/WSS 传输与配对 Adapter，不是第五个领域模块，也不拥有
Chat、Task、Guard、Account 或 Model 事实。它可以组合 Control、Store 与 Shared
接口，但不得自行修改领域状态。

- 独立 `picode serve --workspace <path>` 是显式无头入口，可以持有自己的前台
  Pi Runtime；工作区必须由 PC 参数显式授权。
- Pi TUI 中 `/server` 绑定当前运行的 Pi Authority。模型回合、取消、Steering、
  模型和 Thinking 切换都回到该 TUI；不得另启 Pi RPC writer。
- `command.execute` 只开放查询命令。写 Chat 只能走带 Chat Writer Lease 的专用
  RPC；权限、Harness、能力、Worktree 和账号变更保持 PC-only。
- Remote Serve 由组合根注入 Guard 的 Chat Writer Lease authority；WebSocket
  只把 lease 协议翻译为 Guard 操作，不自行判断 owner 或过期规则。
- Android/网页客户端只持有投影和请求权。设备令牌只存 Host 哈希，Host 私钥、
  凭据、缓存、日志和 scripted demo 均不属于可合并或可返回的数据面。

### 1.3 V2 P1-02～P1-05 复用 Seam

2026-08-07 复核确认旧实现的协议、迁移和错误测试语料有价值，但旧调用链不能
成为 V3 的第二权威。复用时只允许跨越以下 Interface：

| Interface / Seam | 唯一拥有者 | 隐藏的复杂性 | 明确禁止 |
|---|---|---|---|
| `TaskIngress.accept(input) -> TaskRef` | **Devloop/task** | Agent Inbox、Telegram、HTTP/远程输入的去重、Task 创建和失败语义 | Adapter 自写任务文件、直接向子端口发 prompt、失败后 legacy fallback |
| `StateFile<T>` | **Store** | schema、锁、fsync/原子替换、known-good、quarantine、迁移 tombstone 校验 | 各调用方复制恢复逻辑；只因 tombstone 文件“存在”就跳过迁移 |
| `RuntimeEnvelopeIngress.admit(raw, executionIdentity)` | **Adapter Extension**；Engine 只接收 admitted typed event | 大帧/UTF-8/JSON/枚举校验、malformed 记录、epoch/run/request fence、终态去重 | observer、状态投影、Evidence 或 UI 在 Admission 前消费 raw event |
| `GateRunner.run(contract) -> GateEvidence` | **Devloop/verify** | 测试发现、匹配计数、超时、红探针、环境 provenance、`not_run` | 仅凭进程退出码判绿；零测试匹配判绿；把 skipped 当 passed |

真实安装产物 smoke 属于发布验证，不是新的运行时 Module。静态资源/manifest
检查只能命名为 package metadata contract，不能冒充 boot/package smoke。

## 2. Guard 设计条目

### 2.1 权限档位（UX 预设）

`readonly` → `auto`（自动处理常规、危险询问）→ `full` →
`danger-full-access`。当前档位属于会话
事实，可用 `/permissions` 查看或切换；`full` 仍不越过破坏性操作和 Git
所有权确认。`danger-full-access` 对齐 Codex 的 `AskForApproval::Never` +
`DangerFullAccess`，放行所有 Operation Intent 并关闭 OS 沙箱；它不改变 TDD
状态机，也不覆盖用户明确建立的 Workspace Fence。Guard 是唯一事前工具授权权威并写 Evidence；pi-mcp-adapter 的
approval 事件翻译到 Guard（ADR-0005）。pi-landstrip 的 agent permission
固定为 allow，只承接 Guard 编译后的 OS 沙箱政策和运行时访问升级，禁止再弹
第二套逐工具确认框。

### 2.2 approval_fingerprint（Q13 已决）

- **成分**：操作类别 + 规范化目标路径 + 精确命令字符串 + 被引用脚本的
  内容摘要 + **cwd**（cwd 为 V3 新增：同一命令在不同目录含义不同）。
- **重算点**：Guard 工具包装层，调 landstrip `prepareProcess()` 之前；
  与批准时指纹不一致 → 决定作废、重新询问。
- **环境变量不进指纹（P0–P4）**：纳入会导致 ask 疲劳；PATH 劫持类风险由
  OS 沙箱政策兜底（文件写入/网络仍被罩）。列为已知豁口，P5 评估白名单式
  env 摘要。
- **Grant 分级**：一次性/会话批准绑定精确指纹（内存态）；首次询问也可把
  当前会话切成 `full`，一次放行后续常规操作；`danger-full-access` 只能由用户
  通过命令/CLI/RPC 明确选择，不出现在普通审批选项里；"永远允许"绑定命令模式不绑
  指纹（持久化到项目/全局），仍受工作区与破坏性操作上限约束。所有 Grant
  只由 Guard 消费，不再复制进 landstrip agent permission。

### 2.3 Guard 自持、无现货的部分

approval_fingerprint、Git 所有权（未经确认不 commit/merge/push/删分支/
重写历史）、Managed Worktree 准入、秘密引用与禁区（denyWrite 硬阻断 +
Secret Reference 不落明文）、External Extension 的 Trusted 门。

### 2.4 三级工具可见性（V3-DESIGN §3.4，R4 收敛持久状态）

能力目录 manifest 索引归 Guard；`search_tools` 工具（套件自有，约 200
token 常驻）是二级能力唯一发现入口——搜索结果按用户设置轴过滤即三级
不可见的执行点。

两轴正交，不得混写：

- **用户设置轴（持久化，仅用户）**：两个独立字段
  `{enabled: boolean, trustedDigest?: string}`。禁用保留信任摘要；摘要变化使
  旧信任失效。Enabled ≠ Running，Trusted ≠ 获得权限；模型不能改动设置或
  信任事实。
- **会话运行轴（临时）**：模型 search_tools → 请求 Activate → Guard 检查
  `enabled=true` 且 `trustedDigest` 匹配当前 manifest digest → 裁决本次调用
  权限 → Engine 临时激活（Running）。

二级 = 已启用且当前摘要已信任、可搜索、未运行；三级 = `enabled=false`、模型完全
不可见；用户启用并信任当前摘要后三级实际进入二级。激活路径（代理调用 vs
临时进 Tool Schema vs 会话/项目常驻）由 Engine 的
`activate(capabilityId, taskContext) → ActiveCapabilityLease` 确定性
选择，模型只表达"要用这个能力"；Engine 经 Active Tool Adapter 操作
pin 版 pi 的注册/停用接口（一致性测试决定具体 API）。MCP 类二级由
pi-mcp-adapter 代理模式承接，不经 search_tools。

Codebase Memory 的 Provider Interface/Adapter 是随产品分发的稳定
Implementation；实际 `codebase-memory-mcp` 进程按 External Extension 治理，
同样受上述 enabled/trustedDigest 与临时运行轴约束。

Simple 档另有确定性的扩展 Tool Schema Gate：组合根只统计当前活动、由 Simple
套件贡献的扩展工具，预算上限为估算 4096 Token。超限时停用这些扩展工具并显示
诊断，不能静默继续污染稳定前缀，也不能隐藏 Pi 原生工具。该 Gate 约束的是实际
活动 schema，不以包是否已安装代替测量。

## 3. Devloop 设计条目（2026-08-07，Q15–Q18 已决）

Task Capsule 的生命周期与事实内容由 **Devloop/task** 唯一拥有；
Devloop/context 只把已校验 Capsule 渲染进 Context Package，不得改写、补齐或
另存一份 Capsule 权威。Store 只提供文件写入纪律和索引，不解释 Capsule 语义。

### 3.0 Context Governor（请求边界硬不变量）

Context Governor 位于 `Devloop/context`，不是第五个模块。它只拥有“本次 Provider
请求允许看见的活动上下文”编译语义；Pi JSONL 仍是完整会话权威，Engine/Adapter
只负责把 Pi 的逐请求 `context` event 交给 Governor。

- 预算必须同时计入 system、活动工具 schema、历史消息、Reasoning、Tool Result、
  provider 上轮 `totalTokens`（含 cacheRead）之后新增尾部、输出预留和安全边际。
- cacheRead 是成本优化，不是上下文豁免；不得只看本轮 uncached input。
- 达到 trigger 后依次压缩大型工具结果（保留 head/tail、摘要元数据、SHA-256、
  toolCallId/toolName）、移除旧 Reasoning、折叠旧叙事；完整原文继续留在 transcript。
- 编译后仍超过 hard budget 时必须 abort/fail-closed，绝不发送原始请求。
- 该保护独立于用户可关闭的普通 auto-compact；settle 后再请求持久化 compaction，
  失败只保留 pending，不得让下一轮恢复为原始超预算请求。
- 未验证第三方 endpoint 使用保守 effective window；提高窗口必须有 endpoint 级证据。

请求编译前还有一条更早、更便宜的摄取路径：Adapter 在 Pi 接受 `tool_result`
时先调用 Devloop 的语义渲染器，为 bash/test、search、Git、Web 与 MCP 返回追加
有界证据头；未知工具保持原样。纯文本结果超过 64 KiB 时，Store 以 SHA-256
内容寻址保存完整 **Tool Result Artifact**，活动会话只保留 head/tail、摘要、路径
与读取提示。即使 Artifact 写入失败，也只返回有界错误说明，不能把超大原文重新
塞回请求。

预算由可重放的 `ContextBudgetMeter` 计算：有 Provider usage 时以最近成功回合的
`totalTokens`（含 cacheRead）为锚点并加入后续消息增量；没有时使用保守 UTF-8
估算。相同 session revision + prefix envelope 必须得到相同结果。发生编译时，
Store 只保存可重建的 **Context Compilation Manifest**（输入/输出 digest、替换
位置、toolCallId、前后摘要、Token 与 effective window），不建立第二份会话。
Provider/endpoint/model 的成功容量证据保存在独立 Endpoint Context Profile；URL
凭据不得进入 route key。

Retention、Governor、Durable Compaction 与 Capsule 的每次变换还必须经
`ContextLedger.record()` 写入同一会话的 append-only 审计账本。Ledger 使用确定性
事件 ID 去重，记录 layer/action、session revision、输入/输出摘要、Token 变化与
Artifact 指针；它只回答“哪一层对上下文做过什么”，不得成为第二份 transcript。

Task State、TDD State 和 sealed Capsule 属于 protected context：普通叙事折叠不得
删除或摘要覆盖它们。只有在 emergency history fold 中才允许重排其位置，同时必须
逐条原样保留。

### 3.1 Capsule schema（契约，R3 补入 v1 外壳）

强制分节模板（Factory.ai 式填空，防静默丢失），JSON 存
`tasks/<id>/capsules/`，注入时渲染 Markdown。

**v1 外壳（绑定与生命周期，防注入错误任务版本/代码快照）**：

```text
schemaVersion              固定为 picode.capsule/v1；未知 major → 拒绝注入
capsuleId
taskId + taskRevision      绑定任务叙事版本；revision 不符 → 不得注入
workspaceSnapshot          生成时的代码身份（repo/HEAD/dirty 摘要）
createdAt                  Capsule 创建时间
status                     draft → sealed → superseded
                           sealed 后内容不可变；被新 Capsule 取代记 superseded
supersedes?                当前 Capsule 取代的上一 Capsule ID
verificationRefs[]         关联的 Gate/Evidence 指针（导入类证据标 Imported/Unverified）
digest                     sealed 内容的稳定摘要；注入前必须校验
```

**正文分节（不变）**：

```text
intent            本 Slice 目标原文
verbatimFacts[]   命令/路径/错误串/验收标准；禁改写；带通用 SourceRef
decisions[]       已定决策 + 一句话理由
filesTouched[]     从 Git 工作区采集；Capsule 最多携带 200 条，tracked 优先
filesTouchedOmitted? 超限时记录未展开数量；不得静默截断或把依赖目录当业务变更
openQuestions[]
nextSteps[]
narrative         唯一允许摘要的自由段
```

**SourceRef（通用来源指针，取代仅限 `{sessionId, turn}`）**：
`{kind: session|evidence|import|file, id, locator?, sourceDigest?}` —— 事实可指向
会话轮次、Evidence 条目、导入 Snapshot 或文件位置。引用可变文件时
`sourceDigest` 必填，防止 Verbatim Fact 的来源在 Capsule sealed 后漂移。
封存不能只检查摘要格式：Devloop/task 的 `CapsuleSealer` 必须通过
`CapsuleSourceResolver` 重新读取权威来源，验证摘要，并确认 fact 文本逐字存在；
来源不可用、摘要变化或文本不在来源中均 fail-closed。Store 只负责保存封存结果。

### 3.2 Slice 触发（决策）

三通道并存：用户 `/slice` 可立即请求；模型和 watchdog 可提议；Devloop 根据
上下文占用、轮次与任务阶段做确定性裁决。软阈值只提醒，硬阈值在当前不可分割
操作结束后强制切片；用户可显式推迟一次并留下 Evidence，但模型不能无限推迟。
切片动作 = 从权威源重建事实 → 生成并 seal Capsule → 新会话/子代理
（context fresh）→ 校验 digest/revision/snapshot 后注入。软硬阈值在 P2 通过
真实中型仓库实验校准，避免切得过碎导致交接开销和缓存失效。
新会话必须在 `/slice` 返回成功前形成可重新打开的 Pi JSONL；仅存在于当前
进程内存中的 Session 不得作为成功结果。后续无头进程必须能按返回路径恢复，
并读到 Task Binding 与 Capsule。Capsule 的文件清单排除未跟踪依赖缓存目录，
超出有界载荷的部分用 `filesTouchedOmitted` 明示，完整代码身份仍由
`workspaceSnapshot` 负责。

直接调用 pi-subagents 时，省略 `context` 默认写成 `fresh`；只有用户/模型显式
指定 `fork` 才继承完整父会话。Fresh 直接委派会从 Store 选择当前 Task 最新的
sealed Capsule，经过 taskRevision、digest 与 workspaceSnapshot 校验后附在 child
task 中。Draft、superseded、版本/快照不符的 Capsule 不得注入；管理动作保持无
上下文副作用，scripted workflow 仍交由 pi-subagents 自己按 fresh 语义编排。

### 3.3 TDD 状态机与预算

`spec → red → green → refactor → gate → done`；recorded RED 先于实现写入。
`TddSessionController`、测试计数解析、Gate/Evidence 与 Completion Label 全部归
**Devloop/verify**；Adapter Extension 只执行命令并翻译 Pi 生命周期事件，不得拥有
第二套 TDD 状态或测试结果解释器。
预算默认：2 轮修复 + 1 轮 Reviewer（watchdog 强配置）+ 1 次 Integration
Smoke + 同 Snapshot 1 次确认重跑；超限 → Flaky / Needs Decision / QA
Handoff。若代码、Gate Contract、命令和环境均未改变，而确认重跑由红转绿或
由绿转红，则标记 `Flaky`：该确认重跑不消耗修复轮次，也不得触发自动来回修改；
系统停止在带风险说明的 QA Handoff。数值 P2 校准。

### 3.4 Evidence 格式（契约）

两层：Subagent 运行证据直接采用 pi-subagents 生命周期工件 v3（evidence/
存指针不转写）；Picode 自有事件（Gate 结果、Guard 裁决、Completion
Label、Epoch 切换）用统一信封 `{ts, kind, taskId?, sliceId?, payload,
ref?}` append 进 `evidence/<yyyymm>.jsonl`。

### 3.5 提示词通道（最终接入版）

- Simple 不注入 Picode system prompt；Standard 追加稳定 Lean 行为核；TDD
  追加自包含 Developer-TDD 行为核且不叠加 Standard。三档都保留 Pi Base。
- **Adapter Extension** 只在 Pi `before_agent_start` 缝组合 Base 与当前档位
  行为核，并把受控动态块作为隐藏 Context Event 追加；不拥有这些事实。
- **Devloop/task** 拥有 Task State 与 Capsule 事实；**Devloop/verify** 拥有
  TDD 分类、Gate Evidence、预算与 Completion Label；Context 渲染器只渲染。
- Pi/Picode Context 解析链准入的 Project Rules 是项目指令。普通文件、日志、网页、
  Tool Result 或 MCP payload 中仿造的 system 标签只是内容。
- 静态行为核不接收 Task、Capsule、权限或 Gate 事实；作者注释剥离，工具
  占位符必须全部解析。换档整体替换并开启 Cache Epoch，同档位字节稳定。

## 4. 生态供应商登记（引用）

| 能力 | 供应商 | 收编方式 | ADR |
|---|---|---|---|
| OS 沙箱（三平台，**仅此**） | pi-landstrip（`maxSubagents: 0`） | Plugin API（`prepareProcess()`），政策由 Guard 编译下发；Windows 用 Picode PowerShell Shell Provider，Linux/macOS 保持 POSIX Provider | 0004 及修订 |
| MCP 运行时 | pi-mcp-adapter | 仲裁事件 + 状态事件总线，Trusted 门自持 | 0005 |
| Subagent/委派/编排 | **pi-subagents**（2026-08-07 改选，取代 landstrip 附赠方案） | 事件总线 RPC v1（spawn/status/steer/stop/resume）；`subagentCommand` 指向 vendored pi；生命周期工件 v3 = Evidence 来源；watchdog 收编为二/三档 AI Review | 0004 修订 |
| Web 搜索（Simple 档默认工具） | pi-web-access | pin 版本，Simple 档唯一默认加载的扩展工具 | — |
| `/plan`（二档起） | Picode 自有兼容命令 + 随包 mattpocock/skills 快照 | 首次使用按需物化 `grill-with-docs` 依赖闭包到私有 Pi skill root，重载会话后继续；不联网、不覆盖用户目录、不自动续跑 | ADR-0007 |
| LSP/诊断（三档默认） | pi-lens | 写/编辑即时诊断、影响级联、read-guard；一二档不加载，watchdog LSP 兜底；**待核 C#/GDScript 覆盖** | Q23（2026-08-07） |
| 缓存 provider 兼容面 | pi-cache-optimizer | pin 采用；关闭提示词重写（前缀结构归 Picode 纪律）；OpenAI `prompt_cache_key` 兜底、session affinity、Anthropic TTL 守卫、compat doctor | V3-DESIGN §3.3 v2 |

Subagent（pi-subagents）沙箱兼容路径：子代理是真 pi 子进程且做环境级
扩展发现 → 每个子进程自行加载 landstrip，bash 被 OS 沙箱罩住；
以 `subagent:acknowledge-extension` 协议验证"子进程确实带沙箱"后 Guard
才放行写操作。`denyExtensions` 只是同进程政策边界，不替代 OS 沙箱。

Subagent 相关 Spike：① 子进程 landstrip 加载与确认协议实测；
② `subagentCommand` 指向 vendored pi 的继承行为；③ watchdog 与 Devloop
verify/ 的签发边界（watchdog 只报告，Completion Label 仍由 verify 签发）；
④ worker 凭据裁剪（worker 可读 pi 认证与继承 env）。

## 5. 导入工具契约映射的模块分工（V3-DESIGN §3.5，R3 修正权威归属）

语义映射权威集中在 Picode 内部；外部导入器只理解来源格式：

| 阶段 | 权威 | 职责 |
|---|---|---|
| 来源解析、call/result 配对 | 外部来源 Adapter（核心外） | 理解 Codex/Claude/Cursor 等来源格式 |
| `Foreign Transcript IR` + `SourceToolSignature` | Import Contract | 版本化交换格式，导入器与核心唯一耦合点 |
| 历史工具 → Tool Semantic Operation | **Store `ImportCompiler`** | 集中维护映射表与五级兼容判定；仅导入时懒加载；归一化改写/叙述降级/映射清单入库在此执行 |
| 规范语义 → 当前 live tool | Guard Capability Catalog | `resolveLive(semantic_operation, task_id)` |
| 桥接注记与 Context 渲染 | **Devloop** | 只渲染白名单兼容事实（来源声明/不执行声明/工具对应/以本会话 Schema 为准）；禁止外来 system prompt、权限规则、完成语义、Skill 指令、行为要求 |
| 追加进 Pi Session | Engine | 只追加已生成内容，不产 Context 业务逻辑 |
| 运行时重定向表 | Adapter Extension（错误钩子） | unknown tool 报错加厚，查 `~/.picode/import/toolmap-<source>.json`（由 ImportCompiler 用表派生）；不注册同名 stub |
