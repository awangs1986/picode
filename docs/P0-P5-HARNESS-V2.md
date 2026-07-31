# Picode Harness V2：新 P0–P5

状态：设计稿，尚未声明实现完成  
日期：2026-07-31  
依据：[Picode 与 grok-build Harness 对比](research/grok-build-harness-comparison-2026-07-31.md)

## 1. 产品目标

Picode 是面向软件和游戏开发者的轻量桌面开发 Agent。它使用 Pi 作为 Agent 内核，提供可选的完整开发 Harness，但不强迫所有任务工程化。

- **Simple Task**：不要求 workspace；只有基础对话和 Pi 核心能力；不自动扫描仓库、不启动 LSP/MCP/DAP/扩展进程。
- **Harness Task**：绑定 workspace；可以启用计划、代码智能、Git 隔离、Gate、证据、后台任务和子代理。
- **三层能力**：Resident Core、Discoverable Lazy Capability、Disabled User Module。后两层都不得因创建 Harness Task 而自动常驻。
- **验证原则**：Gate 变绿不等于有效；必须有受控红探针证明同一 Gate 能拒绝错误候选。
- **开发角色**：Picode 帮开发者完成本地设计、实现、测试和交付证据；CI 服务器提供权威复验，main 审核者/提交者仍在外部。

旧的 [P0–P5 backlog](P0-P5-BACKLOG.md) 保留为 Picode 0.3 的历史实施记录。本文件是下一轮 Harness V2，不重写旧任务的完成状态。

## 2. 架构主线：八个深模块

每个模块只公开一个稳定 Interface；复杂实现和内部 Adapter 留在模块内部。GUI、headless、ACP 和测试都通过相同 Interface，避免多套状态机。

| 模块 | 小 Interface | 隐藏的复杂度 |
|---|---|---|
| `RuntimeSpine` | 开始/记录/结束 session 与 work，申请完成 | 生命周期顺序、事件持久化、恢复、归属、通知 |
| `SessionKernel` | create/load/list/fork/rewind | ID、事件重放、迁移、索引、损坏尾部恢复、会话来源 |
| `WorkManager` | start/status/wait/cancel | command/subagent/server/monitor、进程树、输出限制、资源采样、重启对账 |
| `CompletionEngine` | evaluate(candidate, harness) → decision | Gate、红探针、重试、flaky、Evidence Ledger、local/CI authority |
| `ContextEngine` | prepare_turn/compact/fetch_artifact | token 预算、工具结果裁剪、摘要、artifact 引用、压缩 checkpoint |
| `CodeIntelligence` | navigate/diagnose/shutdown | 本地索引、LSP 路由、文档版本、诊断等待、server 重启与回收 |
| `DelegationEngine` | dispatch/control/collect | pi-subagents、模型策略、persona、worktree、预算、父子证据和取消 |
| `ExtensionManager` | discover/configure/invoke/inspect | 分层、启用、信任、进程、manifest、来源、SHA、MCP/LSP/DAP/插件 |

真实 seam：

- `SessionTransport`：GUI broker、ACP stdio/WebSocket、headless 是不同 Adapter。
- `ProcessAdapter`：Windows Job Object 与 Linux/macOS process group 是不同 Adapter。
- `VerificationAdapter`：本地执行与远程 CI 是不同 Adapter。
- `CredentialResolver`：密码本路径、环境变量、OS credential store 是不同 Adapter；Interface 永不返回可持久化明文。

## 3. 全阶段共同 Gate

任何 P 级别只有同时满足以下条件才可标记完成：

1. 功能 Gate 在正常 fixture 上为绿；
2. 同一 Gate 在受控故障 fixture 上必须为红；
3. crash、cancel、restart 和 timeout 至少覆盖与该阶段相关的路径；
4. Simple Task 的启动、空闲内存和首次消息延迟没有超过冻结基线的允许回归；
5. Disabled User Module 没有进程、模型目录项或隐式网络连接；
6. 中英文 UI 与错误信息均有自动化检查；
7. 旧账号、聊天、provider、模型来源和 Picot/Pi 基础聊天路径保持兼容；
8. Gate 产出机器可读 artifact，记录命令、输入指纹、环境、耗时、退出状态和红探针结果。

“测试文件存在”“命令退出 0”“模型说完成了”都不能单独作为验收证据。

---

## P0 — 可信运行脊柱

### 目标

把当前散落在 broker、Rust command、Pi extension、runtime monitor、background job 和 subagent bridge 中的生命周期收进 `RuntimeSpine` 与 `WorkManager`。P0 不增加重型功能，只建立后续所有功能共用的真相源。

### P0-01 冻结兼容与性能基线

- 记录 Windows 冷启动、空闲内存、首次 token、长聊天滚动、Simple/Harness 创建、broker 重连、10/50/100 个后台记录的基线。
- 固定 Codex/Cursor/Claude/custom API、聊天导入、备份、语言包、模型来源显示和现有 Pi 工具测试。
- 性能阈值根据测量结果设定，不预先编造数字。

### P0-02 定义 Runtime Event v2

- 统一 `SessionStarted`、`PromptSubmitted`、`BeforeTool`、`ToolFinished`、`ToolFailed`、`PermissionDenied`、`WorkStarted`、`WorkUpdated`、`WorkFinished`、`BeforeComplete`、`CompactionStarted/Finished`、`SessionEnded`。
- 每个事件包含稳定 ID、session/task/work/parent 归属、时间、来源、bounded payload 和 schema version。
- reasoning、secret、完整工具输出默认不进入事件摘要；全文只进入受策略控制的 artifact。

### P0-03 实现 RuntimeSpine

- 保证事件顺序、幂等写入、订阅和重放。
- GUI 通知、Evidence、资源监控和后续 ACP 都从这里消费，不允许各自推导另一套状态。
- 中途崩溃留下的 `running` 状态在恢复时必须进入 `reconciling`，不能伪装成仍在运行。

### P0-04 收拢执行授权

- `BeforeTool` 必须经过现有统一授权层；Task Override、Skill、Hook、Subagent 都不能扩大底层工具权限。
- 允许内置 Gate/Hook 进一步拒绝，但不允许“allow”覆盖底层 deny。
- secret reference 只在实际进程启动前 JIT 解析，并在工作完成时删除临时副本。

### P0-05 实现 WorkManager v2

- command、persistent shell/eval、server、monitor、subagent 都映射为统一 `WorkHandle`。
- 支持 status、bounded output、wait、cancel、timeout、resource snapshot 和 owner 查询。
- 旧 background-job 和 runtime registry 通过内部 Adapter 迁移，不在 GUI 暴露两套任务。

### P0-06 可验证的进程树所有权

- Windows 使用 Job Object；Linux/macOS 使用 process group/session。
- cancel/kill 只有确认所有归属子进程退出后才能返回 `terminated`。
- 无法确认时返回 `termination_unknown`，保留诊断信息，不报告成功。

### P0-07 崩溃与重启对账

- 启动时检查 PID 身份、启动时间、父子归属和控制通道，拒绝接管不属于 Picode 的端口或进程。
- 断开的 provider 连接与仍存活的本地任务分开处理。
- 账号 A 断开只停止关联工作；切到 B 后仍必须由用户输入“继续”才恢复任务。

### P0-08 Runtime Monitor 迁移

- GUI 只显示 RuntimeSpine/WorkManager 的真实状态。
- CPU、内存、PID、uptime、stall、token/cost 明确区分 measured、provider-reported、estimated、shared、unavailable。
- 空闲面板关闭不停止底层资源限制。

### P0-09 P0 可红 Gate

- 故意制造乱序事件、重复事件、僵尸子进程、拒绝终止、PID 重用、broker 中断和损坏恢复记录。
- Gate 必须拒绝假完成、假终止、跨 task 归属和权限扩张。

### P0 完成定义

所有运行状态只有一个权威来源；旧聊天功能不回归；进程终止和恢复不再依赖“看起来成功”。

---

## P1 — 标准会话与 ACP/headless

### 目标

以 `SessionKernel` 为会话真相源，通过不同 `SessionTransport` Adapter 同时服务 Picode GUI、ACP 和 headless。Pi 内核保持不变。

### P1-01 Session Store v2

- SQLite 保存索引、关系和查询；append-only event chunks/artifacts 保存完整更新。
- 保存 stable conversation ID、session ID、task ID、workspace identity、provider/account/model 来源、父会话和 fork 来源。
- 提供 transactional migration；旧 Picode 聊天无需重新导入。

### P1-02 SessionKernel Interface

- create/load/list/fork/rename/archive/delete/rewind 通过一个 Interface 完成。
- delete 使用软删除与回收站期限；永久删除二次确认。
- load/replay 对损坏尾部、重复事件和缺失 artifact 给出明确降级结果。

### P1-03 ACP 核心 Adapter

- 实现 initialize、session/new、session/load、session/list、session/prompt、session/cancel 和结构化 session/update。
- 流式区分 text、thought、tool call、tool result、plan、usage；thought 默认折叠且摘要不显示。
- 权限请求、用户提问和取消都通过协议返回，不走隐藏旁路。

### P1-04 Picode ACP 扩展

- 以 `picode/*` 暴露账号/模型来源、Harness Task、workspace binding、Gate status、Evidence、WorkHandle、资源快照和聊天备份。
- 扩展必须版本化并可以 capability discovery；客户端不得猜测支持项。

### P1-05 Headless CLI

- 支持新建/恢复/继续/fork、cwd、模型来源、Simple/Harness、JSON 与 streaming JSON、最大 turns、工具过滤、退出码。
- stdout 保持机器可读；日志只到 stderr。
- 中断保存到最后一个已完成事件，不承诺回滚尚未纳入 Git checkpoint 的文件。

### P1-06 GUI 迁移到同一 Transport

- GUI 逐页面迁移，期间保留兼容 Adapter，但同一命令不能同时写两套状态。
- broker 仅承担 transport，不拥有 session 业务状态。
- 重连后按 event cursor 增量恢复，不重新推送整段聊天。

### P1-07 幂等、背压与断线恢复

- prompt、tool result、permission reply 使用 request/event ID 去重。
- 慢客户端不能使模型无限堆积内存；流式队列有上限和磁盘回放。
- ACP/GUI 断开不自动取消任务；明确 stop/close 才取消归属工作。

### P1-08 会话搜索与导入统一

- Codex/Cursor/Claude 导入结果转成同一标准 session 事件，不把 reasoning/tool log 当聊天正文。
- 标题、最后一条可见聊天、时间、大小、来源、归档、workspace 分组和去重统一由 SessionKernel 索引。
- 导入仍是副本，不持有外部文件指针。

### P1-09 P1 可红 Gate

- 断开流式连接、重复 prompt、重放旧 permission、损坏事件尾部、跨 workspace load、旧数据库迁移中断。
- Gate 必须证明不重复执行工具、不丢失已确认消息、不串会话，并能从最后安全事件恢复。

### P1 完成定义

GUI、headless 和 ACP 能操作同一个 session；未来编辑器、CI 和手机端不再需要绕过 Picode 会话内核。

---

## P2 — 单 Agent 完整开发闭环

### 目标

先让一个主 Agent 在长会话和大型工程中稳定完成“理解—计划—修改—诊断—测试—证明—交付”，再扩展并行能力。

### P2-01 ContextEngine

- 每轮计算真实 token 预算，区分系统规则、最近对话、任务状态、代码片段、工具结果和预留输出。
- 工具全文进入 artifact store，模型默认只得到有界预览和引用。
- context decision 可观测，但不暴露 chain-of-thought。

### P2-02 分层压缩

- 固定顺序：保留可容纳原文 → 丢弃最旧非关键历史 → 裁剪超大工具结果 → 压缩旧步骤 → 紧急保留最新任务状态。
- 压缩前保存 checkpoint，压缩后重新注入目标、plan、todo、workspace、未决问题、Gate 和账号接管状态。
- 记录 tokens before/after、裁剪项、摘要模型和来源引用。

### P2-03 Artifact Store v2

- 内容寻址、加密/不加密策略、retention、redaction 和缺失检测。
- 模型通过显式 fetch 获取全文；大型日志和构建输出不重新塞回聊天。
- 聊天备份可选择全文或压缩上下文，但不打包项目文件。

### P2-04 持久 Lazy LSP

- `CodeIntelligence` 按 workspace/language 懒启动 server；Simple Task 不自动启动。
- 文档版本与诊断版本绑定，旧诊断不得覆盖新编辑。
- 错误优先、每文件和每轮有界；server crash/restart/timeout 可观测并归 WorkManager 管理。

### P2-05 本地导航与结构化编辑

- 本地索引、文本搜索、符号/引用、safe patch、stale-write precondition 统一由 CodeIntelligence 路由。
- 大型仓库按 workspace scope 增量索引，不全盘扫描用户目录。
- AST 能力继续作为可搜索的第二层能力，不进入 Resident Core。

### P2-06 可选 Plan Mode

- Harness Task 可进入只读计划状态；Simple Task 不强制。
- 计划保存 context、关键文件、复用点、风险和验证方式；用户可批准、要求修改或退出。
- Skill 或用户命令明确覆盖流程时，记录 Task Override，并服从底层权限。

### P2-07 CompletionEngine 接入 BeforeComplete

- 主 Agent 请求完成时自动评估适用 Gate，而不是依赖模型记得调用命令。
- Gate 结果分为 `candidate`、`locally_verified`、`harness_verified`、`ci_verified`；没有红探针不能到 `harness_verified`。
- Stop Gate 有有限继续次数；连续无法修复后必须告知用户，不能无限消耗 token。

### P2-08 Git checkpoint、rewind 与交付包

- Harness 工程优先使用 Git tree/index/commit 管理 checkpoint，不复制整个游戏工程。
- rewind 必须预览影响、保护未跟踪/未纳入 checkpoint 的用户修改，并二次确认。
- Handoff Package 包含变更摘要、diff/commit/worktree 引用、测试、红探针、Evidence、未解决问题和恢复指令。

### P2-09 本地与 CI 权威分离

- 本地执行可以完成 developer Gate，但不能伪装成 CI 结果。
- `VerificationAdapter` 先实现 Local Adapter；Remote CI Adapter 留到 P5。
- UI 明确显示“本机通过，等待 CI”而不是统一绿色。

### P2-10 P2 可红 Gate

- 超大工具输出、接近 context limit、错误摘要、过期 LSP 诊断、LSP crash、脏 Git 工作区、失败测试、伪造 JSON 报告、绿但红探针不红。
- Gate 必须证明上下文关键状态不丢、过期诊断不采用、用户修改不被 rewind 覆盖、假绿不能升级证据等级。

### P2 完成定义

单个主 Agent 能在大型工程的长任务中稳定开发、恢复和交付，且完成状态有可复验依据。

---

## P3 — 合格并行、子代理与隔离工作

### 目标

不重新实现 pi-subagents；由 `DelegationEngine` 把 pi-subagents、Picode 模型策略、WorkManager、Safe Worktree、Evidence 和 GUI 组合成一个深模块。

### P3-01 Delegation Contract v2

- 每次派发包含 goal、scope、method、inputs、tools、permissions、model policy、budget、isolation、stop conditions、expected result/evidence。
- 子代理是主 Agent 的忠实执行者；不得自行扩大范围、权限或尝试突破阻塞。
- 默认最大深度为一；只有用户明确设置深度与预算时才开放嵌套。

### P3-02 pi-subagents Adapter

- 使用现有托管 `pi-subagents` 的 chain、parallel、fresh/fork、resume、structured output、acceptance 和 workflow。
- Picode 原生 `task` 保留为简单、GUI 模型策略驱动的有界委派。
- 两条路径都写入统一 parent/child WorkHandle 和 Evidence 候选结果。

### P3-03 Agent、Persona 与模型策略 GUI

- 候选模型使用与聊天相同的“来源/账号/模型”行，不按模型名合并。
- 支持 role/persona、effort、capability mode、timeout、turn/tool/spawn budget。
- 自动便宜模型只用于简单、有界、独立、低风险、小上下文、可独立验证任务；搜索不是唯一判断条件。

### P3-04 Capability Mode 与工具继承

- read-only、read-write、execute、all 映射到真实工具 allowlist。
- Skills、MCP、任务扩展按声明继承；缺失或无权使用时 spawn 前失败。
- B 账号接管 A 任务时继承上下文、plan、todo、workspace 和证据，但只有 B 输入“继续”才开始执行。

### P3-05 Worktree 隔离策略

- 并行写任务默认要求独立 worktree；并行只读任务可共享 workspace。
- 不自动 merge、push 或删除失败 worktree；主 Agent/用户明确审核后 apply。
- 保存 base ref、dirty state、patch、冲突和清理证据。

### P3-06 子代理控制与恢复

- GUI 支持 transcript、status、wait、steer、interrupt、stop、resume。
- 子代理完整 reasoning 默认折叠；父会话只接收有来源的结构化总结/候选 artifact。
- 父任务取消或账号登出时，只级联取消相关 children，并验证进程树结束。

### P3-07 主 Agent 审核与 Gate

- 子代理完成只产生 candidate；主 Agent 必须检查 diff/artifact，再由 CompletionEngine 跑有效 Harness Gate。
- reviewer 子代理的绿色意见不是 Gate 证据；可作为 advisory 保存。
- 写入冲突、证据不足或模型降级必须回到主 Agent/用户决策。

### P3-08 Fleet 与资源监看

- GUI 展示父子树、模型来源、状态、最近活动、elapsed、CPU、RAM、token/cost、worktree 和 Gate 状态。
- 能识别 blocked、stalled、waiting-user、waiting-work、orphaned、termination-unknown。
- 资源采样有上限，不因折叠/关闭面板停止生命周期管理。

### P3-09 Monitor 与 Scheduler

- monitor、一次性后台任务和可选 scheduler 都使用 WorkManager。
- scheduler 默认关闭，属于第二层可搜索能力；durable scheduler 必须显式启用。
- 高频/高噪声 monitor 自动限流，并要求过滤后才能恢复。

### P3-10 P3 可红 Gate

- 并行写冲突、错误 base ref、worktree 创建失败、child 越权、预算耗尽、parent crash、账号切换、模型 fallback、假 terminate、子代理伪造验证结果。
- Gate 必须证明无共享写竞争、无自动执行接管、无静默模型切换、无未审核子结果进入 verified。

### P3 完成定义

多 Agent 能并行但不会牺牲上下文、Git 安全、权限和证据真实性；用户能在 GUI 中完整观察和控制。

---

## P4 — 扩展生态、信任与统一观测

### 目标

让专业能力可发现、可安装、可检查、按需运行，但 Disabled 模块保持零进程、零模型可见性。`ExtensionManager` 取代设置页、Pi extension、MCP/DAP 和外部工具各自维护状态的做法。

### P4-01 扩展四态模型

- `Discovered`：只有 manifest，设置页可见。
- `Enabled`：用户允许模型搜索/手动调用，但不启动进程。
- `Trusted`：允许该来源的 hooks/MCP/LSP/native helper 执行。
- `Running`：某 task/session 已启动具体工作并归 WorkManager 管理。

### P4-02 Extension Manifest v2

- 描述 name/version/source/commit/license/tier/components/tools/permissions/platforms/runtime/data/health。
- components 支持 Skills、commands、agents、hooks、MCP、LSP、DAP 和 GUI entry。
- manifest 版本迁移可回滚；未知字段和不支持语义明确报告。

### P4-03 来源、固定版本与 Capability Source Review

- 远程扩展支持完整 commit SHA 固定；更新先展示 diff/权限变化。
- 实现能力前自动要求 per-capability CSR：Pi 插件 → OMP → Claude/OpenCode/同类开源 → 自研。
- 许可证、NOTICE 和修改来源进入扩展详情和仓库检查。

### P4-04 Skills/规则/命令兼容层

- 发现 Picode、Pi、Claude、Cursor 的用户/项目 skills，但导入仍由用户手动选择。
- skills collection（如 mattpocock-skills）默认在 GUI 聚合成一个集合，可展开子项。
- 显式调用的用户 Skill 可覆盖 Picode 工作流策略，但不能突破工具权限、OS 限制或 provider Interface。

### P4-05 Hooks 作为第三级能力

- 支持生命周期事件的 command/HTTP hook、matcher、timeout、结果和来源。
- 用户 hook 默认关闭；项目 hook 需要 folder trust；全局 hook 显示明确风险。
- hook 出错不能扩大权限。若采用 fail-open，UI 必须显示该 Gate 没有执行成功，不能把任务标 verified。

### P4-06 MCP/LSP/DAP 统一进程 Adapter

- 所有外部 server 都由 ExtensionManager 配置、WorkManager 运行、Runtime Monitor 观察。
- secret JIT 注入；日志有界；取消、crash 和 reload 使用同一生命周期。
- task-scoped 与 global-enabled 只表示可调用，不表示常驻内存。

### P4-07 Firstmate GUI 入口

- Firstmate 保持 Disabled User Module。
- 启用后顶部出现明确的 Firstmate 工作入口；聊天通过 Picode session 展示，但外部 worker/worktree/PR 结果仍是未验证候选。
- 不自动 merge/push；必须回到 Picode/CI Gate。

### P4-08 专业扩展面板

- 列出第二层和第三层全部能力，显示 tier、enabled、trusted、running、来源、版本、进程、权限和最近错误。
- 中文模式下名称以外的说明完整翻译；空列表、加载失败和过滤结果不可混为一谈。
- 从聊天模型菜单、工具搜索结果可跳转到同一详情页。

### P4-09 统一观测 Schema

- 记录 session、turn、tool、permission、work、subagent、gate、compaction、model switch、extension lifecycle。
- 默认不含 prompt、代码、绝对路径、命令、reasoning 或 secret。
- 本机事件有界保留；可选 OTEL 必须双重 opt-in，凭证只从环境/secret reference 获取。

### P4-10 回归 Harness 与零驻留 Gate

- 比较 startup、idle memory、first token、tool latency、长聊天渲染、LSP/扩展首次启动、取消和资源回收。
- 对每个 Disabled 模块证明：无进程、无端口、无网络、无模型工具项、无依赖自动安装。
- 对 malicious manifest、SHA 变化、未信任 project hook、MCP crash、DAP hang 和扩展越权做红测试。

### P4 完成定义

专业扩展不再是空白设置页或散落配置，而是统一、可审计、按需运行的生态；轻量目标得到自动化证明。

---

## P5 — 外部权威、远程控制与专业 Adapter

### 目标

P5 只包含需要额外信任、外部基础设施或平台特化的能力，默认全部关闭。它们不能反向污染 P0–P4 Resident Core。

### P5-01 Remote CI VerificationAdapter

- 支持触发 CI、查询状态、读取结构化结果和 artifact，但不把 CI 机器塞入本地核心。
- 绑定 commit/tree、Harness fingerprint、平台和 toolchain；过期结果不能验证新候选。
- `ci_verified` 只能由受信任 CI Adapter 写入。

### P5-02 交叉模型 Gate Challenger

- 用户在设置中选择目标 provider/account/model 作为只读 reviewer/tester。
- 既测试候选能否通过 Gate，也检查受控坏候选能否使 Gate 变红。
- 输出是 advisory/red-probe evidence；不能直接修改项目或自行升级完成状态。

### P5-03 手机远程控制

- 基于 P1 ACP/SessionTransport，不另建聊天内核。
- 支持配对、端到端加密、session scope、撤销、审计、后台/锁屏策略和 LAN/Internet 区分。
- 默认只能观察和回复；授权工具执行、secret 和破坏性操作需要单独策略。

### P5-04 可选 OS Sandbox Profiles

- Windows：评估 restricted token、AppContainer、Job Object、ACL/网络策略组合。
- Linux：Landlock/bwrap/seccomp Adapter；macOS：Seatbelt Adapter。
- profile 与 session 绑定，恢复时不得静默放宽；无法保证声明限制时 fail closed。

### P5-05 游戏工程验证 Adapter

- Unity/Unreal/Godot 等只做开发验证：资源引用、GUID/import、编译、Cook/build、headless test、日志和平台矩阵。
- 不做通用艺术生成产品；引擎只在相关 task 显式启用时启动。
- 每个 Adapter 自带可控坏 fixture，证明 Gate 能发现断引用、导入失败和构建错误。

### P5-06 安全与供应链 Adapter

- secret scanning、dependency audit、license、SBOM、SAST 作为 Disabled User Module。
- 扫描结果是结构化诊断和 Evidence，不自动上传源码。
- 工具/规则版本固定，误报抑制可审计。

### P5-07 可选 Durable Memory

- 与 P2 的任务 checkpoint 严格分离；默认关闭。
- global preference、workspace knowledge、session summary 分库/分 scope；写入可预览、删除可验证。
- 检索带来源、时间、staleness 和权重；记忆不能覆盖当前仓库事实或 Gate 结果。

### P5-08 Remote Worker Pool 评估

- 定义 worker identity、capability、workspace/artifact transfer、isolation、budget、cancel、failure recovery 和 trust。
- 默认不启用云 Agent 池；只有两个真实 Adapter（本地测试与远端生产）后才建立稳定 seam。
- 远端修改只能以 patch/worktree/PR 候选返回。

### P5-09 实验能力晋级规则

- 只有证明用户价值、可靠性、红能力、安全、资源预算、跨平台和可卸载性后，能力才可从 P5 晋级 P4。
- 晋级不自动改变默认 tier；是否默认启用需要单独 ADR 和性能证据。

### P5-10 P5 可红 Gate

- 伪造 CI 回调、过期 commit、配对密钥撤销、网络中断、sandbox 逃逸 fixture、错误引擎引用、恶意 dependency、过期 memory、远端 worker 丢失。
- Gate 必须证明外部失败不会伪装本地完成，也不会让远端能力扩大本地权限。

### P5 完成定义

外部 CI、手机、平台 sandbox、游戏 Adapter 和长期记忆可以按需加入，但关闭后 Picode 仍保持 P0–P4 的轻量完整开发闭环。

## 4. 阶段依赖

```text
P0 RuntimeSpine + WorkManager
 └─ P1 SessionKernel + ACP/headless
     └─ P2 Context + LSP + Completion + Git delivery
         └─ P3 Delegation + pi-subagents + isolated concurrency
             └─ P4 ExtensionManager + trust + observability
                 └─ P5 CI/mobile/sandbox/game/memory/remote workers
```

- P0–P2 完成后，Picode 才具备“单 Agent 完整 Harness V2”。
- P3 完成后，具备可信并行开发。
- P4 完成后，具备不破坏轻量目标的扩展生态。
- P5 不是发布 P0–P4 的前置条件。

## 5. 建议交付批次

| 批次 | 内容 | 用户可见结果 |
|---|---|---|
| A | P0-01～P0-09 | 所有运行、资源、取消和恢复状态可信 |
| B | P1-01～P1-09 | GUI/headless/ACP 共用会话，可稳定重连恢复 |
| C | P2-01～P2-10 | 单 Agent 可完成大型工程长任务并提供可信交付包 |
| D | P3-01～P3-10 | 子代理、模型策略、worktree 和 Fleet 在 GUI 完整可控 |
| E | P4-01～P4-10 | 专业扩展完整显示、按需启动、可审计、零驻留可证明 |
| F | 逐项选择 P5 | CI、手机、sandbox、游戏验证等按实际需要启用 |

## 6. 明确不做

- 不用 grok-build、OMP、Claude Code 或 OpenCode 替换 Pi 内核。
- 不复制 grok-build TUI；只学习状态和生命周期设计。
- 不把 Picode 变成 IDE、CI 服务器、科研 Agent、写作工具或艺术生成套件。
- 不默认启动 LSP、MCP、DAP、浏览器、memory、scheduler、firstmate 或远程 worker。
- 不自动 merge、push、删除 worktree、接管账号或在账号切换后继续执行。
- 不用 Hook/Skill 绕过底层授权与平台安全限制。

## 7. 下一步决策

开始实现时从 P0-01 建立新基线，然后先做 `RuntimeSpine` 和 `WorkManager` 的 Interface/测试，不直接重写 GUI。旧调用者逐个换成 Adapter；新 Interface 测试建立后，删除被替代的浅层状态测试，避免永久维护两套逻辑。
