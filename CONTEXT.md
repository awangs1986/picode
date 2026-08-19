# Picode Next Domain Language

> 本文件只定义领域词汇，不记录实现语言、进程拓扑或路线图。

## Core

**Picode** — 围绕上游 Pi Runtime 提供软件开发治理的轻量 Harness；不拥有第二套 Agent Loop。

**Picode V3** — 本轮重写的目标版本（Extension-first 架构：pi 发行版 = pi + Picode 扩展套件 + 伴生 CLI + 独立导入工具）。V2 指旧实现，仅作迁移与对照来源；不使用"V1"指代新版本，阶段目标用里程碑（M-x）命名。

**Serve Mode** — P5 的无头会话宿主进程（`picode serve`），为手机/GUI 远程端复用同一批模块；P0–P4 不存在。

**Pi Runtime** — 上游 Pi 的模型调用、Agent Loop、实时会话、分支、compaction、TUI 和原生工具运行语义。

**Harness** — 用户显式选择的工程开发契约，增加项目 Context、任务治理、受控执行和验证；不是另一个 Agent Runtime。

**Simple Task** — 不启用工程 Harness 的任务，接近原生 Pi 体验：不加载沙箱、MCP 与扩展工具，唯一附加能力是 Web 搜索。

**Vendored Pi** — 随 Picode 分发、pin 版本、可带补丁（仅最后手段）的专属 pi 实例；与系统安装的 pi 互不相干。

**Harness Task** — 绑定 Workspace 并启用工程 Context、权限、Work 和 Verification 的任务。

**StateFile** — Store 内统一持久化纪律的深 Interface；集中负责 schema、文件锁、flush/fsync、原子替换、known-good、quarantine 和迁移 tombstone 校验。Workspace Fence 与 Worktree Registry 等安全权威复用同一恢复原语：主文件损坏时只可从通过 schema 的 known-good 恢复，否则 fail-closed。业务模块只提交/读取类型化状态，不各自实现恢复逻辑。

## Conversation and task

**Chat Session** — 持久对话容器，可以跨账号、模型和 Execution Epoch。

**Account Vault** — Store 内账号引用、凭据、Provider 单活跃关系与持久化格式的唯一权威。TUI、Web Wizard、OAuth Adapter 和调试面只能通过其 Interface 读取投影或提交变更，不得直接读写另一份账号状态。Vault Logout 清除敏感凭据并把账号标记为 `retired`，但保留账号身份、Chat 和 Provider continuity 元数据；注销活跃账号必须同步撤销当前 Pi Runtime Provider。

**Account Import Wizard** — 由 `/pico-import` 启动、Adapter Extension 临时托管的本机 Web 深模块；默认自动打开浏览器并在 TUI 打印回退链接。裸 `/import` 与 `/import <path.jsonl>` 均归上游 Pi，执行其原生会话导入语义。Wizard 只绑定 loopback，使用独立一次性认证，完成、取消、超时或 TUI 退出即销毁；浏览器只承载交互，账号事实仍归 Account Vault。它不是 GUI、独立 Backend 或 `/v1` 自动化客户端。

**Task Run** — 一项用户工作及其目标、计划、当前 Harness 档位、证据、风险和终态。会话切换 Harness 时必须原子同步 Task 文件权威；`task status` 不得继续显示创建会话时的旧档位。

**Task Outcome** — Devloop/task 拥有的结构化运行终态。Standard/TDD 在必需前置条件不满足或工作被阻塞时必须通过 `task_outcome` 记录 `failed_preflight`/`blocked`、摘要和证据引用；Control Interface 将其投影为 `run.failed` 与非零退出码。模型文本、任意业务 JSON 文件和 Todo 状态都不能自行制造终态；新一轮开始必须把上一轮失败重置为 running。

**Todo Verification** — Todo 的 `completed` 只表示 Agent 声明的进度，默认 `unverified`；只有 Devloop/verify 产生 Gate/Review Evidence 后才能标记 `verified` 并附 verificationRefs。失败回合不得把无证据的 completed 投影为已验收。

**Task Objective** — Task Run 要解决的问题和验收方向；它是任务事实，不等于可自动续跑的 Goal 模式。

**Planning Workflow** — 用户请求规划时采用的协作流程。Picode 的 `/plan` 首次使用会从随包固定快照按需物化 `grill-with-docs` 及其依赖到私有 Pi skill root，重载会话后把请求交给该工作流；不联网、不提供外部安装命令，也不自动续跑。

**Bundled Skill** — 随 Picode 分发、由来源 Commit/许可证/摘要固定的 Skills 快照。它不在启动时整体加载，只有用户显式使用某个指令时才物化对应依赖闭包。

**Skill Materialization** — 将随包 Skill 的一个依赖闭包原子复制到 Picode 私有 Pi skill root 的一次性操作；不覆盖已有用户目录，完成后由 Pi 重载发现，不等于启动后台进程。

**Recommended Component Reinstall** — 用户显式执行 `/reinstall` 时，对 mattpocock/skills、Herdr 与 CodebaseMemoryProvider 分别检查现有安装/能力状态；只询问缺失项。Skills 从随包固定快照物化，外部能力进入 Enabled + Trusted 的二级驻留状态；两者都不等于启动常驻进程。

**Goal Mode** — 被 Picode 明确废弃的独立自动推进插件语义；任务仍可拥有 Objective、Next Steps 和 Capsule，但不得因为存在目标字段而自动继续执行。

**Task Slice** — Task Run 中目标单一、范围明确、可以独立验证的一段工作。

**Task Capsule** — Slice 之间传递的有界事实包；生命周期与事实内容由 Devloop/task 唯一拥有，Devloop/context 只负责校验后渲染。包含不可摘要覆盖的 Verbatim Facts 和允许有来源摘要的 Narrative。生成时从 Git 工作区事实采集 `filesTouched`（tracked 优先，最多 200 条；排除未跟踪依赖缓存目录），超限必须以 `filesTouchedOmitted` 明示，完整代码身份仍由 `workspaceSnapshot` 负责；从未完成 Todo 采集待解决事项，禁止用空数组掩盖已知变化。v1 外壳带 `schemaVersion`，绑定 taskRevision 与 workspaceSnapshot（版本不符不得注入），事实使用可带 sourceDigest 的通用 SourceRef，并关联 verificationRefs；`CapsuleSealer` 在 sealed 前必须重新解析来源、校验来源摘要，并证明每条 Verbatim Fact 确实逐字存在，来源不可用或内容不符即拒绝封存。sealed 内容带 digest，生命周期 `draft → sealed → superseded`，通过 supersedes 串联替代关系，sealed 后不可变。`/slice` 只有在新 Pi JSONL 已持久化且可由下一无头进程重新打开时才可报告成功。

**Execution Epoch** — Task Run 中账号、Channel、模型和能力集合固定的一段执行。

**Task Narrative Revision** — 用户 steer、rewind、fork 或恢复改变任务叙事时递增的版本。

**Interjection** — 用户在 Agent 工作时通过 `/insert <message>` 追加的同回合指令。它不取消当前工具；由 Pi 的 steering 安全缝在当前 assistant 工具调用完成后、下一次模型请求前，作为独立 custom-user 会话事件按 FIFO 交付。若提交时回合恰好结束，则自动启动普通新回合，消息不得滞留或丢失。它不同于等待整个 Agent Run 结束的 Follow-up，也不同于 Abort。

**TaskIngress** — Devloop/task 接收 TUI、CLI、Agent Inbox、Telegram 或未来远程输入并创建唯一 Task 权威的深 Interface；负责去重和失败语义。Pi 新会话尚未命名时，session ID 只能作为临时标题；第一次真实用户请求通过 TaskIngress 原子替换该占位值，之后不得随每轮消息反复改名。来源 Adapter 不得自行写 Task 状态、直接向子端口发 prompt，或在失败后回退到 legacy 双写链。

**Control Interface** — TUI 和自动化 CLI 共同调用的组合层契约；只编排 Store、Engine、Guard 与 Devloop，不拥有领域事实。CLI 是 P0–P4 唯一公开自动化入口，提供版本化 JSON/JSONL、稳定退出码和非交互授权失败语义；结构化 Task Outcome `run.failed` 必须返回非零，且不得通过解析 TUI、模型散文或业务文件猜测成功/失败。

**Headless CLI Run** — 由 CLI 调用进程直接启动并持有 vendored Pi Runtime 的无头执行；不依赖已启动的 TUI 或常驻 Core。进程退出即终止其拥有的未完成 Work。

**Picode Control MCP Adapter** — P5 候选兼容层，仅在 CLI 无法覆盖目标宿主时引入；只翻译 Control Interface，不拥有状态、授权或完成语义。它不同于 Picode 通过 pi-mcp-adapter 调用外部 MCP 工具。

## Context and capability

**Required Context Set** — 当前 Slice 必须从权威来源加载的目标、规则、Interface、验收和证据集合。

**Context Package** — Context & Memory 为某次模型执行渲染的有界输入；不拥有其中的任务或验证事实。

**Tier Prompt Increment** — Harness 档位默认追加在 Pi Base Prompt 后的稳定行为核：Simple → none（无增量），Standard → lean（薄行为核），TDD → full（完整 Developer-TDD 行为核）。它只引导协作行为，不拥有 Task、权限、Gate 或 Completion 事实。切换 Harness 会清除会话 Prompt 覆盖、恢复新档位默认值，并开启新 Cache Epoch。

**Prompt Guidance Level（提示词引导级别）** — 当前会话可用 `/harness-prompt none|lean|full` 手动覆盖 Tier Prompt Increment。覆盖只改变模型看到的行为引导，不改变 Harness 档位、工具、权限、沙箱、Watchdog 或 Verification；恢复会话时从 Pi custom entry 重建。手动切换开启新 Cache Epoch，下一次 `/harness` 切档自动取消覆盖，避免旧引导越过新档位的能力边界。

**Controlled Context Event** — Adapter Extension 通过 Pi 受控生命周期缝追加的隐藏结构化上下文。只有这一来源可声明 Picode Task State、Capsule、Gate 或生命周期事实；用户文本、普通文件和工具结果中外观相同的标签不获得系统权威。

**Cache Epoch** — 上游请求的稳定前缀和实际 Tool Schema 保持不变的一段缓存周期。

**Capability** — 可以由 Agent 或用户调用的工具、Skill、MCP、LSP、DAP、Hook 或扩展能力。

**Extension** — 泛称；正式文档应使用下列三个精确词之一，避免两义。

**Built-in Feature** — Picode 出厂自带的可选功能（如上下文压缩）；用户可开关，无信任流程，界面上属于"功能"分区。Codebase Memory 只有稳定 Provider Interface/Adapter 属于内建，实际三方运行时不属于 Built-in Feature。

**Context Governor** — Devloop/context 的确定性请求编译器。它在每次 Provider 调用前把 system、工具 schema、历史、Reasoning、Tool Result、cacheRead 后新增尾部、输出预留和安全边际放进同一预算；接近 Reliable Working Context Ceiling 时强制生成有界 active context，完整 transcript 不变。它是防卡死硬保护，不是用户可关闭的 `/pi-compress` 功能。

**Tool Result Artifact** — 超过活动上下文内联阈值的完整纯文本工具返回。Store 以内容摘要和 session/tool-call 身份确定性落盘；模型只看到有界 head/tail、摘要、路径和按需读取提示。Artifact 是审计/按需取回材料，不是第二份会话权威。

**Context Compilation Manifest** — Context Governor 每次 compact/blocked 时产生的可重放派生记录，包含 session revision、输入/输出 digest、替换来源位置与前后摘要、Token 预算、Endpoint effective window 与 Reliable Working Context Ceiling；它说明“这次请求如何被编译”，不保存或取代会话正文。

**Context Ledger** — Store 按会话保存的 append-only 派生审计账本，统一记录 Retention、Governor、Durable Compaction 与 Capsule 四层对上下文做过的变换。每条记录绑定层、动作、session revision、输入/输出摘要、Token 变化与 Artifact 指针，并以确定性事件 ID 去重；它用于发现重复压缩和缓存税，不拥有或改写 Pi transcript。

**Endpoint Context Profile** — 某个 provider API + 去凭据 Base URL + provider/model 路由的容量证据。模型卡片声明值与真实 endpoint 成功证据分开记录；第三方 endpoint 未验证前仍使用保守窗口。

**Fresh Delegation** — pi-subagents 的默认 Picode 子代理上下文策略：直接委派只接收任务文本和当前 Task 最新、校验通过的 sealed Capsule，不继承父会话全文。显式 `fork` 始终保留为用户选择。

**Active Context** — 某一次 Provider 请求实际获得的有界消息集合。它是从完整 Pi transcript 编译出的临时投影，不是第二份会话权威。工具轨迹可在这里被 envelope 化或折叠，但原 JSONL 仍可审计和恢复。

**Effective Context Window** — Picode 有证据认为某个 provider/endpoint/model 组合实际可接受的窗口。它可以低于模型卡片声明值；未经验证的第三方 Responses endpoint 使用保守上限，不能用“模型理论支持 1M”替代 endpoint 证据。

**Reliable Working Context Ceiling** — Picode 为降低长任务漂移而主动采用的活动上下文产品上限，与 Endpoint 容量正交。当前值为 `min(Effective Context Window, 400K)`；大窗口模型的 Auto Slice 最迟在 320K（80%）开始由当前主模型打包 Capsule，Context Governor 预留输出与安全边际后禁止原始请求越过该上限。400K 是可由漂移实验继续下调的保守边界，不表示范围内绝不漂移。

**Simple Extension Schema Budget** — Simple 档活动扩展工具 schema 的确定性上限，当前为估算 4096 Token。启动时从 Pi 实际活动工具面测量；超过预算时 fail-closed 地停用 Simple 扩展工具并显示诊断，不影响 Pi 原生工具。

**Adapter Extension** — Picode 一方编写、随产品分发的 pi 扩展胶水；只把 pi 事件与意图翻译到 Module 接口，零业务逻辑、零自有状态；对用户不可见，不可单独停用。

**External Extension** — 用户从外部来源安装的能力包（三方 pi 扩展、MCP、Skills、Hooks）；受能力目录治理。`Discovered` 表示目录中存在；持久化用户设置记录 Enabled/Disabled 与 Trusted/Untrusted；运行轴独立记录 Stopped/Running。不得把这些状态实现成一条会让 Enabled 自动进入 Running、或让 Trusted 自动扩大权限的线性状态机。

**Sandbox Provider** — 向 Guard 声明能力、编译政策、包装命令并回调升级的 OS 沙箱实现；政策权威永远在 Guard，Provider 可替换（合格标准 = 通过一致性测试套件）。

**Tool Semantic Operation** — 与某个产品工具名无关的稳定工具语义。

**Historical Tool Trace** — 从外部会话导入的惰性历史工具证据；永不自动执行，也不等于当前 live tool。

**Tool Residency Tier** — 工具三级驻留：一级常驻核心（schema 进上下文）、二级可发现懒加载（`enabled=true` 且 `trustedDigest` 匹配当前 manifest digest，manifest 可搜但未运行）、三级默认 `enabled=false`（模型完全不可见：不注册、搜索过滤、零进程）。驻留层级与扩展生命周期正交：持久设置用 `{enabled, trustedDigest?}` 两个独立事实且仅用户可改；运行轴 Activate/Running 描述会话内临时激活；模型只能请求 Activate。

**Codebase Memory Provider** — Picode 内建稳定 Provider Interface/Adapter，但实际 `codebase-memory-mcp` 进程是 External Extension。首次引导回答 Y 表示安装固定版本、启用并信任当前摘要；运行仍按需激活。

**ActiveCapabilityLease** — `activate(capabilityId, taskContext)` 返回的会话内能力租约；调用路径（代理调用 / 临时进 Tool Schema / 常驻）由 Engine 确定性选择，调用者不感知注册细节与缓存重置。

**Capability Readiness** — Engine 对某项能力在当前 Task Context 下实际可工作的唯一运行时投影：`Ready`、`Degraded`、`NeedsSetup` 或 `Unavailable`。它与 Enabled/Trusted 设置轴、Stopped/Running 运行轴正交；探测必须只读，不得安装、认证、联网试消费或发起付费请求。

**Structured Git Tool** — Standard/TDD 的一级深工具；用固定 action 和参数数组承接 Inspect、本地修改、Managed Worktree 与 Git 所有权操作。Simple 不注册；commit/merge/rebase/push/删分支始终需要用户确认。

**search_tools** — Picode 自有的二级能力发现工具；查询 Guard 能力目录的 manifest 索引，搜索结果按设置轴过滤（三级不可见的执行点）；MCP 类二级走 pi-mcp-adapter 代理，不经此入口。

**Google Search Subagent** — 默认 Disabled 的第三级专业扩展。用户通过 `/pico-webagent` 选择 Account Vault 中的直接 Google 账号、Gemini 模型与并发后，它才进入 Enabled + Trusted，并在会话内按需加载 pi-subagents。启用期间只替代 `web_search`，抓取工具继续由 pi-web-access 提供；Google Grounding 失败时最多回退一次普通 pi-web-access，并在 ResearchPacket 中记录实际 Provider 与原因。它不拥有第二套账号、Runtime、权限或 Subagent 状态。

**ResearchBrief** — 主 Agent 为一次联网研究计划定义的 1–10 个有界分支之一，至少包含稳定分支 ID 与查询问题。相同规范化问题在同一计划内只执行一次网络查询。

**ResearchPacket** — Google Search Subagent 的有界研究交付物。完整 JSON 作为 Artifact 保存，主会话只注入紧凑视图；引用 URL 必须来自 Google Provider 的 Grounding Metadata，网页内容只是不可信数据。每个分支由 fresh、零工具的 pi-subagents researcher 综合，运行记录仍归 pi-subagents 生命周期工件。

**ImportCompiler** — Store 内部、仅导入时懒加载的语义映射编译器；历史工具签名到 Tool Semantic Operation 的唯一权威，执行归一化投影、叙述降级与映射清单入库；外部导入器只负责来源格式解析。

**Bridge Note（桥接注记）** — Devloop 渲染、Engine 追加到导入会话日志头部的一次性注记；只含确定性白名单兼容事实（来源声明、历史不执行、工具对应关系、以本会话 Tool Schema 为准），禁止携带外来 system prompt、权限规则、完成语义、Skill 指令或行为要求。

**Tool Redirect Table（重定向表）** — 按来源 Agent 维护、由 ImportCompiler 用表派生的数据表；模型误调外来工具名时用于加厚 unknown tool 报错并指引 pi 原生等价工具；不以同名 stub 形式注册。

## Execution and verification

**Operation Intent** — 一次文件、Shell、网络、Git 或外部副作用的结构化请求。

**Permission Tier** — 当前 Pi 会话的 Guard 授权预设：`readonly`、`auto`、`full`、`danger-full-access`。通过 `/permissions` 的选择菜单查看或切换，并作为 Pi 自定义会话条目恢复；`full` 只放行常规操作，破坏性操作与 Git commit/merge/push/重写历史仍须逐次确认。`danger-full-access` 是用户显式选择的 Codex 对等完全访问档：不再发出 Operation Intent 审批并关闭 OS 沙箱，但仍不越过 TDD Gate 与用户建立的 Workspace Fence。

**Permission Authority** — P0–P4 唯一事前工具授权权威是 Guard。pi-landstrip 的 agent permission 固定为 allow，只保留运行时 OS 沙箱与访问升级职责，避免同一工具先后弹出两套批准框。

**Work** — 有状态、取消、预算、资源和产物的受监督执行。

**Work Handle** — 查询、等待、取消或读取 Work 结果的稳定句柄。

**Candidate Snapshot** — 一组 Gate Result 所绑定的精确代码身份。

**Gate** — 对 Candidate Snapshot 运行并产生结构化 Evidence 的验证规则。

**GateRunner** — Devloop/verify 执行 Gate Contract 并签发 Gate Evidence 的深 Interface；负责测试发现与匹配计数、超时、红探针和环境 provenance。零测试匹配、`not_run` 与 `skipped` 都不是通过。

**RuntimeEnvelopeIngress** — Adapter Extension 在任何 observer、状态投影、Evidence 或 UI 之前执行的版本化事件解码与 Admission Interface；以 Execution Epoch、run/request 身份和终态隔离重复、畸形及 cancel 后迟到事件。Engine 只接收已 admitted 的 typed event。

**Verification Profile** — `None`、`Quick Review` 或 `Developer TDD`，描述当前 Task 的本地开发验证强度。

**Flaky Gate** — 在相同 Candidate Snapshot、命令和环境下产生不一致结果的 Gate。

**Completion Label** — 对本地开发验证结果和风险的准确说明；不等于 QA、CI 或发布认证。

**QA Handoff** — 从开发验证移交给外部 QA/CI 的 Snapshot、Gate、风险和复现信息。

## Workspace and session product

**Workspace Identity** — 与 Windows/Linux/macOS 路径文本分离的工作区身份。

**Forced Workspace Switch** — 用户在 TUI 通过 `/workspace <absolute-directory>` 明确确认的破坏上下文边界操作。Adapter Extension 只生成一次性切换请求；Picode Launcher 等待旧 Pi 退出后，以目标目录和全新会话重启 vendored Pi。目标工作区的标准 `AGENTS.md` 保存当前路径和禁止写入的旧路径；Guard 在所有 Harness 档位拒绝旧路径写入，Standard/TDD 另将禁令编译进 Sandbox Provider。它不是 `cd`、不会伪造 Pi 的 cwd，也不继承旧会话上下文。

**Managed Worktree** — 由 Picode 管理、用于隔离并发或高风险开发写入的 Git Worktree。

**Foreign Transcript Snapshot** — 外部 Agent 原始会话的不可变导入副本；不是 Pi 实时 Transcript。

**Import Contract** — 版本化的导入交换格式（manifest + Foreign Transcript IR + SourceToolSignature + 附件引用）；来源解析工具与 Picode 核心之间唯一的耦合点。来源格式解析住在核心之外；语义映射（工具痕迹五级判定、归一化投影）由核心内的 ImportCompiler 集中执行。

**Writer Lease** — 同一 Chat Session 在本机某一时刻唯一写入者的短期所有权。其 acquire、heartbeat、expiry、release 与连接清理由 Guard 的 Chat Writer Lease module 唯一裁决；TUI、CLI 与 Remote Adapter 不得建立各自的 lease Map。

**Pi Session Lifecycle** — Engine 内封装 Pi Session 创建、seed、首次持久化、解析和重新打开的 deep module。任何成功返回的 Session identity 必须已有真实 Pi JSONL，可被另一进程恢复；Adapter 不得手写 Pi JSONL，也不得接触 `flushed` 等上游私有状态。

**Account Import Wizard** — `/pico-import` 启动的临时 loopback 网页。它只负责扫描、预览和收集用户选择；Account Vault 是凭据权威，Wizard 关闭后不保留第二份状态。账号导入与激活是两个动作，导入不会隐式替换当前账号。Pi 的 `/import` 保持完全原生。

**Chat Source Discovery** — Web 导入页按当前用户和平台嗅探 Codex、Cursor 与 Claude Code 的受支持 JSONL 历史根，选中来源时预填首个存在目录；用户可以改写路径。它不把尚无 Adapter 的 Cursor SQLite 目录伪装成可导入来源，也不扫描 Picode/Pi 自己的登录凭据。

**Chat Import Catalog** — 外部聊天的短生命周期元数据投影：标题、最后一条对话摘要、时间、大小、归档状态、来源与原工作区组。扫描只读文件边界，不把工具日志或推理当作可见对话；选中导入前必须完成本机工作区绑定。

**Cursor Session Ledger** — `pi-cursor-sdk` 写入 Pi 会话 custom entry 的 Cursor Agent 恢复记录，包含 store identity、分支/压缩谱系和发送状态。它是 Cursor 连续性的唯一权威；Picode 不维护平行 ledger。

**Transcript Bootstrap** — Cursor checkpoint 不存在、不匹配或恢复失败时，从当前 Pi transcript 重建给新 Cursor Agent 的上下文。失败必须显示连续性提示，不得静默假装恢复了旧 Agent。
