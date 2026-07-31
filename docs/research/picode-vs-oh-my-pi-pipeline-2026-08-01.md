# Picode 与 oh-my-pi 开发管线源码复评

日期：2026-08-01

## 核验范围

- oh-my-pi：固定到 `main` 提交 [`80627462b4e91f46795ba87f3678174bd3c0b907`](https://github.com/can1357/oh-my-pi/tree/80627462b4e91f46795ba87f3678174bd3c0b907)（2026-07-31），以源码、仓库内架构文档和测试为准。
- Picode：当前工作区源码，包括本轮完成的 ExtensionManager、Manifest v2、WorkManager 进程 Adapter、专业扩展 GUI 和 P4 红灯 Gate；最终 `P0-P4` Gate 已通过。
- “优秀”不按功能数量判断，而按五项判断：核心路径长度、模型实际可用能力、任务完成闭环、恢复与治理、默认运行成本。

## 结论

**如果问题是“今天把一个中型软件或游戏交给谁开发，哪个 coding harness 更强”，oh-my-pi 仍然胜出。** 它的基础工具、持久执行、上下文压缩、LSP、DAP、子代理和浏览器已经形成一个经过长期整合的执行面；Picode 虽然这些类别基本都有入口，但不少仍是第一版或受限子集。

**如果问题是“哪个更适合做个人电脑上的多账号、长期项目、可恢复、可治理的 GUI 开发工作站”，Picode 的产品管线更符合目标。** Picode 的 Simple/Harness 双入口、账号接管必须输入“继续”、跨账号上下文保持、聊天迁移、统一扩展四态、任务绑定、资源监看和严格 Gate，是 oh-my-pi 没有试图解决的控制面。

因此当前总评不是“Picode 已全面超过 OMP”，而是：

- 核心 coding harness 与即时开发生产力：**oh-my-pi 优秀**。
- 桌面工作站、长期工程治理与扩展安全：**Picode 优秀**。
- 按用户定义的最终产品目标：**Picode 方向更正确，但当前成熟度仍是 oh-my-pi 更高。**

## 两条真实主路径

### oh-my-pi

```text
用户输入
  → AgentSession
  → Session context / compaction
  → Agent core
  → 同一 Tool Registry
  → read/edit/bash/eval/LSP/DAP/task/browser/MCP
  → tool result
  → append-only Session JSONL
  → 下一轮或完成
```

其启动路径明确收敛为 `argv → command adapter → runRootCommand → createAgentSession → Interactive/Print/RPC`，[DEVELOPMENT.md](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/packages/coding-agent/DEVELOPMENT.md#L30-L49)。工具由一个 `BUILTIN_TOOLS` 注册表创建，[tools/index.ts](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/packages/coding-agent/src/tools/index.ts#L402-L445)。这是短而连续的模型执行路径。

### Picode Harness

```text
用户在 GUI 创建 Harness Task
  → TaskExperience / TaskControl / SessionKernel
  → 启动并绑定 Pi Agent Run
  → embedded-server Tool
  → Broker control
  → Rust WorkManager / ExtensionManager / native adapter
  → Runtime Lifecycle 统一摄取事件
  → CompletionCoordinator 执行 Gate + 红探针
  → 通过、继续或等待用户接管
```

Picode 的路径更长，但额外层不是纯粹浪费：它们承载账号、工作区、任务、Agent Run、进程、证据和恢复的持久身份。统一入口见 [`task_experience_service.rs`](../../src-tauri/src/task_experience_service.rs#L37)，事件投影见 [`runtime_lifecycle/mod.rs`](../../src-tauri/src/runtime_lifecycle/mod.rs#L157)，完成判断见 [`completion_coordinator.rs`](../../src-tauri/src/completion_coordinator.rs#L123)。

## 分项比较

| 维度 | 当前更优 | 源码判断 |
|---|---|---|
| 核心 Agent 回路 | oh-my-pi | 一个 AgentSession 后接统一工具注册表；Picode 多一次 WebView/Broker/Rust/Pi 往返。 |
| 用户心智模型 | oh-my-pi | 默认就是会话、模型、工具；Picode Harness 还要理解 Task、Run、Profile、Gate、Extension 状态。Picode Simple 缓解了这一点。 |
| 基础文件与搜索工具 | oh-my-pi | read/edit/AST/search/glob 等是成熟的统一工具面，部分热路径有 Rust native 实现。 |
| Shell 与持久代码执行 | oh-my-pi | 两者都有持久 shell、后台 Job、Python/JS；OMP 还具备更成熟的 PTY、输出最小化、工具回调和 Ruby/Julia 可选内核。 |
| LSP | oh-my-pi，大幅领先 | OMP 复用 `command:cwd` 客户端，支持取消、诊断、rename、code action、raw request 等；Picode 当前每次请求启动一次 server，只有 hover/definition/references/documentSymbols。 |
| DAP | oh-my-pi，大幅领先 | OMP 已形成模型可调用的完整调试会话；Picode 当前主要是 GUI 启动/附加、事件记录和进程治理，尚没有完整模型 Debug Tool。 |
| 子代理 | oh-my-pi | OMP 有批量 fan-out、并发限制、独立/隔离工作区、typed yield、revive、递归深度和生命周期；Picode 已接入 pi-subagents 和用户模型策略，但统一结果/恢复/隔离仍较薄。 |
| 上下文与长会话 | oh-my-pi | append-only session tree、branch、compaction、tool pruning、artifact/internal URL 已深度结合。Picode 强在聊天导入、备份、跨账号接管和跨系统路径绑定。 |
| MCP 实际能力 | oh-my-pi | OMP 有连接缓存、250ms 启动门、延迟工具、通知、资源/提示、自动重连和熔断。Picode 目前以有界单次 stdio 请求为主。 |
| 扩展安全与治理 | Picode，大幅领先 | Picode 有 Manifest v2、来源/Commit/SHA、权限、平台、资源限制、四态与任务绑定；OMP Extension 是进程内 JS，官方文档明确说明没有隔离。 |
| Disabled 零成本语义 | Picode | P4 Gate 证明 Disabled 模块零进程、零端口、零网络、模型不可见；OMP 的工具可隐藏，但 MCP、Extension、LSP、DAP 各有自己的生命周期模型。 |
| 完成验证闭环 | Picode | Picode 把 Gate、红探针、Evidence、完成状态建模为正式管线；OMP 有 `/review`、`/ci-green`、Advisor 和 Hooks，但更多是工具/命令组合，不是每个工程任务的统一完成协议。 |
| 多账号与任务接管 | Picode，大幅领先 | 账号断开只停止关联任务，切换后需用户输入“继续”，并保留上下文/任务关系；这是 Picode 的核心产品能力。 |
| 可观测性 | Picode | GUI 直接展示 Agent/子 Agent/Job/扩展进程、CPU、内存、错误和任务归属。OMP 有状态和统计能力，但不是同等桌面控制台体验。 |
| 热路径性能 | oh-my-pi | OMP 把搜索、shell、AST、PTY 等放进 Rust N-API/native 热路径；Picode 的扩展是 lazy，但 GUI/Broker/Pi/native adapter 的跨层往返更重。 |
| 可扩展能力强度 | oh-my-pi | Extension API、Hooks、MCP、Skill、Plugin、Provider 注册更成熟、更灵活。 |
| 可扩展能力隔离性 | Picode | OMP 灵活性以 in-process 风险换取；Picode 将可执行组件交给 WorkManager，状态与权限交给 ExtensionManager。 |

## oh-my-pi 当前明显领先的地方

### 1. LSP 是编辑闭环，不只是导航请求

OMP 按 `command:cwd` 复用语言服务器，完成 initialize 后再发布客户端；请求支持超时、Abort 和 `$/cancelRequest`，[client.ts](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/packages/coding-agent/src/lsp/client.ts#L704-L844) 与 [tools/lsp.md](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/docs/tools/lsp.md#L45-L57)。它还把 rename、rename-file、diagnostics 和 code actions 纳入工具。

Picode 当前语言映射和操作表位于 [`code_intelligence.rs`](../../src-tauri/src/code_intelligence.rs#L205)，实际只有四种操作；每次请求启动并结束一个 server。新 WorkManager 路径解决了“谁拥有进程”的问题，却没有解决“语言智能是否足够深”的问题。

### 2. DAP 已经是真正由模型驾驶的调试器

OMP 的 `debug` 工具维护 session、breakpoint、thread、stack、variables、evaluate、step/continue，并处理 reverse `runInTerminal`，[tools/debug.md](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/docs/tools/debug.md#L121-L133)。Picode 的 [`launch_dap`](../../src-tauri/src/extension_service.rs#L2146) 已具备显式授权、超时和进程归属，但模型工具面尚未对齐。

### 3. 子代理是一条完整的工作管线

OMP 的 `task` 不只负责 spawn：它包含 batch、semaphore、隔离工作区、模型/effort 路由、递归限制、typed schema、强制 `yield`、后台投递和 idle/parked/revive，[tools/task.md](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/docs/tools/task.md#L78-L103)。

Picode 的优势是策略更保守：便宜模型只接收有界、可独立验证的任务，不能扩张父 Agent 工具和权限，[`delegation_engine.rs`](../../src-tauri/src/delegation_engine.rs#L55)。但当前的策略控制面比实际执行面成熟。

### 4. 上下文系统更成熟

OMP SessionManager 是 append-only conversation journal，并明确提供软件崩溃级持久性，[session-manager.ts](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/packages/coding-agent/src/session/session-manager.ts#L402-L414)。其 active branch、compaction、branch summary、tool-output pruning 和 artifact URL 已进入实际模型上下文重建。

Picode 的 [`SessionKernel`](../../src-tauri/src/session_kernel.rs#L86) 已有追加日志、游标恢复、归档、软删除、二次确认 purge 和非破坏 rewind；更适合跨账号/跨系统工作站，但上下文压缩与分支模型还没有 OMP 深。

## Picode 当前真正领先的地方

### 1. 扩展生命周期已经比 OMP 更干净

Picode 现在以 [`ExtensionManager`](../../src-tauri/src/extension_manager.rs#L31) 为权威状态源，统一投影 `Discovered → Enabled → Trusted → Running`。Manifest v2 位于 [`extension_service.rs`](../../src-tauri/src/extension_service.rs#L57)，记录来源、固定版本/SHA、许可证、平台、权限、组件、健康检查和资源限制。

OMP 的 Extension API 更强，但扩展在同一进程运行；官方文档明确说明错误的裸定时器/Promise 可能让整个 session 退出，[extensions.md](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/docs/extensions.md#L169-L179)。这一项 Picode 的治理模型更适合桌面长期运行。

### 2. WorkManager 形成统一执行归属

Picode 的 [`StartProcess`](../../src-tauri/src/work_manager.rs#L72) 是 extension/Hook/stdio MCP/LSP/DAP 的统一进程 Adapter；取消、超时、崩溃、输出和 component/task/run identity 由一个管理器处理。专业扩展页面只消费统一快照，并显示 PID、错误和 task binding，[`professional-extensions.js`](../../public/components/professional-extensions.js#L80)。

OMP 各子系统本身往往更成熟，但 LSP、DAP、MCP、Extension 和 AsyncJob 仍各自拥有生命周期状态。它追求的是子系统局部效率，不是统一桌面治理。

### 3. Gate 是“可证明完成”，不是绿色文字

Picode 的 [`CompletionCoordinator`](../../src-tauri/src/completion_coordinator.rs#L123) 将 Gate 结果、Hook 和重试纳入 Agent Run 完成转换，并要求 Gate 有能力被红探针打红。本轮 P4 还实际验证恶意 Manifest、SHA 漂移、未信任 Hook、MCP crash、DAP hang、权限扩张和 Disabled 零活动。

OMP 的 `/review`、`/ci-green` 和 Advisor 更成熟好用，但属于可调用工作流；它们没有统一要求每个任务完成状态必须引用一次可复核 Gate 执行。

### 4. 多账号长期工作站是独特优势

Picode 的 [`TaskControl`](../../src-tauri/src/task_control.rs#L694) 明确区分账号 handoff 与继续执行：旧账号中断后可以换账号，但任务不会自行重新开始，必须由用户输入“继续”。这与聊天导入、归档、备份、工作区重新绑定一起，解决的是 OMP 单一终端 session 之外的问题。

## Picode 管线仍不够优雅的地方

1. **执行一次工具需要跨更多 seam。** GUI、Broker、Pi Extension、Rust Manager、native child、Runtime Lifecycle 都可能参与。每层都有价值，但调试成本高于 OMP 的 AgentSession → Tool。
2. **ExtensionManager 的实现边界仍偏浅。** 当前通过 `Deref<Target = ExtensionService>` 暴露底层全部方法，[`extension_manager.rs`](../../src-tauri/src/extension_manager.rs#L42)。状态已经唯一，但 API 还没有成为真正窄而深的模块。
3. **工具“有入口”不等于与 OMP 对齐。** 当前 Browser 主要是 open/run/close；LSP 四个动作；DAP 主要是 GUI；MCP stdio 是有界单次进程。它们满足基础可用，不等于 OMP 的长期 session 功能深度。
4. **Simple/Harness 双模式虽然合理，但 Harness 概念较多。** 强模型执行一个清晰改动时，Task/Run/Gate/Extension/Capability 的所有概念不应全部进入模型上下文；当前设计已开始做 lazy projection，仍需继续缩短模型热路径。

## 最终评价

### 今天谁更优秀

**oh-my-pi。** 理由不是功能更多，而是其核心开发循环更短，且 read/edit/bash/eval/LSP/DAP/task/browser/context 已经互相形成真实闭环。对于“马上完成一个中型代码工程”，它目前成功概率更高。

### 哪个架构更适合 Picode 的最终目标

**Picode。** 用户的目标不是再造一个更重的 OMP，而是低常驻、多账号、长期任务、GUI 可观测、账号断点接管、可证明 Gate 和可安全卸载扩展的个人开发工作站。OMP 的单 session、in-process extension 设计不天然覆盖这些要求。

### 正确策略

不要把 OMP 整体塞进 Picode。继续保留 Picode 的控制面，只学习 OMP 已验证成熟的执行面：

1. 将 Picode LSP 从单次四操作升级为可复用、可取消、与 edit/write 联动的客户端。
2. 把 DAP 做成模型可调用的完整调试会话，而不只是 GUI 启动器。
3. 深化 pi-subagents 的 typed result、revive、隔离工作区和后台投递，同时保留 Picode 的用户模型策略与权限收缩。
4. 将 session compaction、branch、artifact retrieval 深化到实际模型上下文，而不是只做聊天备份。
5. 缩短 Broker 热路径：状态治理继续留在 Rust，纯模型工具执行尽量通过稳定而窄的 Adapter，避免重复投影。

当以上五项完成后，Picode 才有充分依据说：它不仅在桌面治理上优于 OMP，在完整中型工程开发 harness 上也整体优于 OMP。
