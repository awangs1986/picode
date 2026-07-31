# Picode 与 Oh My Pi 差距复核：先守住开发流，再选择性学习

> 日期：2026-08-01（Asia/Taipei）  
> 性质：源码级只读研究；本报告不修改产品代码  
> Picode 源码基线：[`6f2e56a26e1df9a803b895a42ceaa280eca1b475`](https://github.com/awangs1986/picode/tree/6f2e56a26e1df9a803b895a42ceaa280eca1b475)（`D:\otherproject\picode`）  
> Oh My Pi 官方基线：[`80627462b4e91f46795ba87f3678174bd3c0b907`](https://github.com/can1357/oh-my-pi/commit/80627462b4e91f46795ba87f3678174bd3c0b907)，2026-08-01 经 `git ls-remote` 固定官方 `main` HEAD  
> 同时复核：[P0–P5 Harness V2](../P0-P5-HARNESS-V2.md)、[领域模型](../../CONTEXT.md)、[上一版流水线对比](./picode-vs-oh-my-pi-pipeline-2026-08-01.md)、[开发 Harness 审计](./picode-development-harness-audit-2026-07-31.md) 与 [pi-subagents 对比](./pi-subagents-comparison.md)

## 结论先行

Picode 当前最需要的不是继续增加功能，而是把已经快速接入的 P0–P4 能力变成一个**可重放、可取消、可恢复、可验证、不会因旧状态或异常返回而崩溃**的开发闭环。

1. **真正应追的差距只有少数几项**：不可信结果边界、运行时生命周期归一、压缩/重试恢复、持久懒启动 LSP、子代理 GUI 与证据闭环、最小模型调试会话、显式激活后的 MCP 稳定性、外部 CI 证明。
2. **浏览器、Shell/Eval、会话持久化、ACP/headless、扩展生命周期、pi-subagents 高级编排底层已经不是主要功能缺口**。旧报告对浏览器和会话能力的判断应按当前源码更新，不能重复立项。
3. **Oh My Pi 的优势不是“功能多”，而是若干故障边界很成熟**：malformed tool result 归一化、版本化诊断、压缩恢复、并发取消、输出上限、failure-domain CI。Picode 应吸收这些窄而深的契约，不复制其终端产品形态和能力宽度。
4. **Picode 的产品方向仍然更清楚**：Simple Task 保持轻，Harness Task 才按需启用开发能力；本地负责开发闭环，远程 CI 和主审查者保持外部权威；禁用模块必须零进程、零模型可见性、零网络。
5. **当前最高风险是“完成声明比可复验证据更快”**。本次审计中，clean checkout 因缺少 `src-tauri/resources/pi` 导致 P0–P4 Gate 失败；补齐该隐式资源后，同一 Gate 的 92 个前端测试文件（366 tests）、205 个 Rust tests、Clippy、fmt、P4 红门和扩展构建均通过。这个对照证明主路径已有大量有效实现，也证明 Gate 仍依赖未被声明的本机/构建前置。并且当前性能结果仍为 `metrics: []`、`metricGate: "not_requested"`，所以“全绿”不能解释成已经测量了冷启动、RAM 或首 token。
6. **本轮源码硬证据支持“先清残留”**：Agent Inbox 仍直接读写 `~/.pi/agent/super-agent/tasks.json`，同时 Rust `TaskControl` 又维护自己的持久任务状态；非测试 Rust 生产路径约有 70 处 `unwrap/expect`，其中 `broker_ws.rs` 32 处、`pi_manager.rs` 18 处；损坏的 TaskControl/AgentRun 等状态会沿启动 `?` 返回，可能让应用初始化整体失败；`AfterTool`、`Stop`、`SubagentStop` 虽已列为 HookPoint，却没有生产生命周期自动触发。

一句话定位：**Picode 应成为轻量桌面入口上的可组合开发 Harness，不是桌面版 Oh My Pi，也不是把所有工具都常驻的 IDE。**

## 评估护栏

本报告只接受同时满足以下条件的改进：

- 直接增强“理解需求 → 检查工作区 → 实现 → 构建/测试/调试 → 审查 → 证据交付”的开发流；
- Simple Task 不扫描工作区、不启动 LSP/MCP/DAP/扩展；
- Harness 能力由任务绑定并按需激活，禁用后不留进程、模型工具或网络连接；
- Pi 内核已有的压缩、Shell、工具执行、子代理编排优先复用或上游修复，不在 Picode 再造第二套；
- 本地验证只产生 `locally_verified`，远程 Provider 的证明才产生 `ci_verified`；Picode 不自动推送、合并或拥有 `main`；
- 每项收益必须高于它带来的常驻内存、并发状态、平台维护和安全面。

这与 Picode 自己定义的 Resident Core / Discoverable Lazy Capability / Disabled User Module 三层架构一致，也避免用“功能数量”代替产品完成度。

## 以前工作如何整合

| 领域 | 当前判断 | 本次处理 |
|---|---|---|
| RuntimeSpine、WorkManager、ACP/headless、SessionKernel、扩展四态 | 核心结构和生产路由已经存在 | 不重复造模块；转向跨入口状态一致性、重启恢复和真实 Gate |
| SessionKernel | 已有 SQLite/WAL 索引、append-only JSONL、`sync_data`、原子重写、截断尾恢复与 committed corruption 拒绝 | 不复制 OMP 会话树；只补跨 Runtime/Context/Task 的恢复 fixture |
| Browser | 当前 `browser-runtime.ts` 已有懒启动 Chromium/CDP、恢复/回收、ARIA、点击/输入、截图、等待、截止时间 | 撤销“仅 open/run/close”的旧缺口；只保留进程所有权、资源上限和崩溃恢复检查 |
| Shell / Eval | 已有持久 shell pool 和 JS/Python kernel，Pi 也有原生工具执行 | 不移植 OMP Rust shell；只统一 outcome、取消、进程树和大输出 artifact 契约 |
| pi-subagents | 托管 `pi-subagents@0.37.2` 已提供 chain/parallel/fresh/fork/resume/structured output/acceptance/workflow | 不重写 runtime；剩余工作是 GUI、账号/模型策略、WorkHandle/Evidence、Safe Worktree 审查 |
| LSP | 每次请求启动一个 server，initialize/didOpen 后执行单操作再取消；操作面很小 | 保留为真实差距，升级为任务绑定的持久、版本化、可取消客户端 |
| DAP | 有授权、WorkManager、事件上限、超时和 GUI launch/attach | 保留为“模型不可操作会话”的差距；只做最小开发调试闭环 |
| ContextEngine | 有预算计划、artifact 与 Pi compaction 事件观察，但没有成为实际 turn 构造的统一边界 | 不另写 compactor；补 replay/compaction/retry 的配对与状态恢复 |
| Agent Inbox / TaskControl | Agent Inbox 的 `tasks.json` 与 Rust TaskControl 同时保存任务状态，通知路径还直接改前者 | 仍未解决；必须确定单一权威并以 Adapter 兼容旧 Inbox，禁止双写漂移 |
| Hooks | `BeforeTool` 有生产调用；`AfterTool`、`Stop`、`SubagentStop` 只有枚举/手工 invoke 或测试，没有生命周期自动触发 | 仍未解决；接到统一 Runtime Lifecycle，补顺序、超时、fail-open/closed 红测 |
| MCP | `request_mcp_stdio` 每次请求都会 start/initialize/cancel 新进程，尚无跨请求会话、缓存、重连和熔断 | 只在任务显式激活后补可靠性；禁止应用启动即 discovery/connect |
| ExtensionManager | 四态、manifest、SHA、信任、WorkManager 所有权是优势；`Deref` 仍暴露整个 Service | 保留“收窄接口、清理旧入口”的架构债，不增加扩展种类 |
| P5 | Remote CI、交叉模型 Gate、手机遥控、Firstmate、游戏验证、供应链等仍是候选 | 全部保持第三层、默认关闭；按已确认的产品需求保留在 [健壮性路线图](../P1-P5-ROBUSTNESS-ROADMAP.md)，不因 OMP 功能宽度提前常驻 |

当前 Picode 证据可见于 [`code_intelligence.rs`](https://github.com/awangs1986/picode/blob/6f2e56a26e1df9a803b895a42ceaa280eca1b475/src-tauri/src/code_intelligence.rs#L53-L123)、[`extension_service.rs`](https://github.com/awangs1986/picode/blob/6f2e56a26e1df9a803b895a42ceaa280eca1b475/src-tauri/src/extension_service.rs#L2146-L2260)、[`context_engine.rs`](https://github.com/awangs1986/picode/blob/6f2e56a26e1df9a803b895a42ceaa280eca1b475/src-tauri/src/context_engine.rs#L140-L218)、[`session_kernel.rs`](https://github.com/awangs1986/picode/blob/6f2e56a26e1df9a803b895a42ceaa280eca1b475/src-tauri/src/session_kernel.rs#L182-L225)、[`browser-runtime.ts`](https://github.com/awangs1986/picode/blob/6f2e56a26e1df9a803b895a42ceaa280eca1b475/extensions/runtime/browser-runtime.ts#L598-L840) 与 [`extension_manager.rs`](https://github.com/awangs1986/picode/blob/6f2e56a26e1df9a803b895a42ceaa280eca1b475/src-tauri/src/extension_manager.rs#L20-L49)。

### 本轮健壮性硬证据

以下是“已有声明”和“生产真实路径”之间最需要优先处理的差异：

| 证据 | 影响 | 判断 |
|---|---|---|
| [`embedded-server.ts`](https://github.com/awangs1986/picode/blob/6f2e56a26e1df9a803b895a42ceaa280eca1b475/extensions/embedded-server.ts#L4744-L4780) 直接 GET/PUT `super-agent/tasks.json`；[`public/app.js`](https://github.com/awangs1986/picode/blob/6f2e56a26e1df9a803b895a42ceaa280eca1b475/public/app.js#L1407-L1426) 完成时再直接改它；Rust [`TaskControl`](https://github.com/awangs1986/picode/blob/6f2e56a26e1df9a803b895a42ceaa280eca1b475/src-tauri/src/task_control.rs#L55-L94) 同时有独立持久状态 | crash、重试或部分写入后两个状态源可能互相矛盾，旧 Inbox 可复活已终止任务 | P1 单一权威问题，不是普通 UI 技术债 |
| 对非测试 Rust 路径计数约 70 个 `unwrap/expect`；[`broker_ws.rs`](https://github.com/awangs1986/picode/blob/6f2e56a26e1df9a803b895a42ceaa280eca1b475/src-tauri/src/broker_ws.rs#L89-L205) 主要是 32 个 poisoned mutex unwrap，[`pi_manager.rs`](https://github.com/awangs1986/picode/blob/6f2e56a26e1df9a803b895a42ceaa280eca1b475/src-tauri/src/pi_manager.rs#L821-L946) 有 18 个配置/锁 unwrap 或 expect | 一个 panic 可 poison lock，后续调用继续 panic；缺失或损坏资源也可能直接中止 | 不能机械替换全部，但 Broker、启动、持久化边界必须先去 panic 化 |
| `TaskControl::open` 对损坏 `agent-runs.json` 返回错误；Tauri setup 用 `?` 向上传递，[`main.rs`](https://github.com/awangs1986/picode/blob/6f2e56a26e1df9a803b895a42ceaa280eca1b475/src-tauri/src/main.rs#L3585-L3610) 会终止初始化 | 单个损坏状态文件可能让整个应用无法启动，也缺少可见的隔离/修复入口 | P1 增加 quarantine、只读恢复模式、用户可见诊断和不可逆操作确认 |
| [`HookPoint`](https://github.com/awangs1986/picode/blob/6f2e56a26e1df9a803b895a42ceaa280eca1b475/src-tauri/src/hook_manager.rs#L35-L50) 声明四个点；源码搜索只看到 BeforeTool 的生产自动调用，其他三点没有相应 lifecycle 调用 | 文档/界面看似支持，真实停止、子代理停止和工具完成却不执行策略 | P1 要么接通并 Gate，要么从公开能力中降级，不能保留“幽灵功能” |
| [`request_lsp`](https://github.com/awangs1986/picode/blob/6f2e56a26e1df9a803b895a42ceaa280eca1b475/src-tauri/src/code_intelligence.rs#L76-L154) 每请求启动、初始化、didOpen(version=1)，随后取消；[`request_mcp_stdio`](https://github.com/awangs1986/picode/blob/6f2e56a26e1df9a803b895a42ceaa280eca1b475/src-tauri/src/extension_service.rs#L1886-L1930) 也每请求启动、initialize、取消 | 资源抖动、上下文丢失、诊断陈旧与不可复用，属于生命周期未完成 | LSP 列 P2；MCP 列 P4，且都保持 Harness 懒启动 |
| [`launch_dap`](https://github.com/awangs1986/picode/blob/6f2e56a26e1df9a803b895a42ceaa280eca1b475/src-tauri/src/extension_service.rs#L2146-L2200) 只启动 Adapter 并建记录；随后只有 [`record_dap_event`](https://github.com/awangs1986/picode/blob/6f2e56a26e1df9a803b895a42ceaa280eca1b475/src-tauri/src/extension_service.rs#L2201-L2240)，没有 DAP initialize/launch/breakpoint/stack/variables 的协议请求闭环 | 当前应表述为“受控进程与事件壳”，不是完整 DAP 实现 | 保留既有安全基础，P3 最小协议闭环，不追完整操作面 |

这几项也给“代码健壮性检查”一个更诚实的解释：现有测试全绿说明许多局部不变量有效，但无法自动消除双状态源、未触发能力、隐式打包资源、panic 热点和一次请求一次进程这类系统级残留。

## 刻意不学：有差距，但不需要在意

这些能力不是“做不到”，而是当前不应进入产品路线。

| OMP 的宽度 | 为什么不适合当前 Picode | 正确处置 |
|---|---|---|
| TUI/终端交互、终端会话细节 | Picode 的差异化是桌面入口与显式开发 Harness，不需要同时维护第二个交互产品 | 不做 |
| 40+ provider、role model、fallback chain、静默账号轮换 | 会显著扩大凭证、会话状态和故障组合；还削弱“任务属于哪个账号/模型”的可解释性 | 只保留明确的 provider/model/account 身份、idle boundary 切换和可见 fallback |
| 32+ 工具、完整 LSP/DAP 操作目录 | 工具数量会增加模型选择噪声、协议维护和测试面，不等于开发闭环更好 | 只上闭环必需的最小操作集 |
| Rust 嵌入式 Shell、N-API、完整原生产物矩阵 | Picode 已有 Pi Shell 与自己的 runtime；复制会增加二进制、CVE、Windows/Unix 差异和发布体积 | 不移植；缺失的取消/输出契约在现有 seam 上补 |
| PNG/vision snapcompact、多套压缩策略、branch summary | Pi 已是 canonical compactor；第二套上下文真相源会制造恢复冲突 | 不做；只补桥接层恢复不变量 |
| FUSE/ProjFS/worktree 隔离后端动物园 | Picode 已确定 Safe Worktree 与人工审查语义，多后端收益未被项目需求证明 | 保持一个安全路径 |
| Swarm、IRC、递归 spawn、AI commit、自动 merge/push | 与 Picode 的外部主审查/主分支权威冲突，也会放大并发和权限风险 | 不做 |
| Live relay、远程协作房间 | 不是当前本地开发闭环的瓶颈 | 不立项；已经确认的个人手机遥控只复用现有 SessionTransport，不复制 OMP 协作系统 |
| Durable memory、Firstmate、远程 worker 池、跨模型 challenger | 都只能是第三层可选组件 | Firstmate 与 challenger 按既有决定保留；durable memory 继续实验；remote worker 池从承诺删除 |
| 全量网页搜索、PDF/抓取/vision/computer provider | 会把 Picode 推向通用 Agent 平台并增加网络、隐私、依赖常驻面 | 保持可安装能力，不进入 Resident Core |
| OMP 扩展的进程内执行模型 | OMP 官方文档明确扩展在进程内、没有隔离，未受控异常可结束会话 | 保留 Picode 的信任、SHA、WorkManager、零驻留设计，不照搬 |
| 默认 `yolo` approval | OMP 的默认与 Picode 的显式授权、未知操作 fail-closed 定位不一致 | 明确拒绝照搬 |

OMP 的功能宽度可由其固定版本的 [README](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/README.md)、[工具注册表](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/packages/coding-agent/src/tools/index.ts) 与 [开发说明](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/packages/coding-agent/DEVELOPMENT.md) 交叉确认。更重要的是，OMP 的 [扩展文档](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/docs/extensions.md#L171-L179) 明确说明进程内扩展没有隔离；[approval 文档](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/docs/approval-mode.md#L3-L74) 也显示默认 `yolo`。这些是 Picode 不应模仿的设计取舍。

## 特别值得学习

### 1. 把所有外部结果当作不可信输入

OMP 的 agent loop 用中央 `coerceToolResult(raw: unknown)` 处理 MCP、扩展与用户工具的异常返回，并把 deadline、AbortSignal 和迟到结果纳入同一执行边界；源码还直接说明缺失内容会让会话 reload 崩溃。[固定源码](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/packages/agent/src/agent-loop.ts#L423-L491) [deadline/cancel](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/packages/agent/src/agent-loop.ts#L925-L986)

**Picode 最小适配**：不碰 Pi agent loop；在 Broker/RPC、native Adapter、扩展返回和持久化入口统一做版本化 schema 校验。`null`、缺字段、未知字段、重复终态、截断 frame、迟到结果都必须归一为可持久化的错误结果，不能 panic、空引用或毒化下一次重放。若问题属于 Pi 核心，则提交上游并升级 pin。

**风险**：运行和内存成本低；主要复杂度在跨 Rust/TypeScript/JSON 的 schema 兼容和终态竞态。照搬整个 OMP agent loop 会引入大量无关策略，因此禁止。

### 2. 把压缩、重试、恢复写成状态机，而不是“成功/失败”二值

OMP 区分 context overflow、incomplete output、threshold/manual/mid-turn/idle compaction；裁剪不会从 tool result 中间切断，并保持 tool-call/tool-result 配对。[compaction 设计](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/docs/compaction.md#L179-L205) [失败恢复](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/docs/compaction.md#L393-L401) [实现不变量](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/packages/agent/src/compaction/compaction.ts#L534-L548)

**Picode 最小适配**：Pi 继续负责压缩；Picode 只保证 replay/resume 不拆散调用与结果，compacting/retrying 不提前标记任务失败或完成，大输出保存 artifact 引用，压缩后重新注入 task/handoff/verification 的最小状态。

**风险**：不增加常驻进程，内存成本低；状态机与崩溃时序测试复杂度中等。若再实现第二个 summarizer，会出现双 context 真相源，禁止。

### 3. 持久、版本化、可取消的懒启动 LSP

OMP 每 workspace/language 复用客户端，维护已打开文件与内容同步，转发 `$/cancelRequest`，有失败负缓存和 idle teardown；诊断按 mutation/version 防陈旧并只注入新增问题。[client 生命周期](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/packages/coding-agent/src/lsp/client.ts#L704-L745) [文件同步与取消](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/packages/coding-agent/src/lsp/client.ts#L903-L987) [诊断实现](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/packages/coding-agent/src/lsp/deferred-diagnostics.ts) [diagnostics ledger](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/packages/coding-agent/src/lsp/diagnostics-ledger.ts)

**Picode 最小适配**：只在 Harness 首次调用时，为 workspace/language 建一个 WorkManager 所有的客户端；实现 didOpen/didChange/didSave 版本、超时/取消、诊断 version gate、失败降级和 idle TTL。第一阶段只保留 hover/definition/references/symbols，稳定后再加安全 rename/code action。

**风险**：每个 language server 可能占用数十到数百 MB；并发、stale result 和进程泄漏风险高。必须限制每 workspace server 数、空闲回收、输出上限，并验证 Simple/disabled 为零进程。

### 4. 复用子代理 runtime，只补统一控制与证据

OMP 的 task 模块展示了 bounded concurrency、父取消传播、typed result、structured yield、持久恢复和隔离结果的完整契约；但其 child 实际可以同进程运行，不能视为 OS 隔离。[task 入口](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/packages/coding-agent/src/task/index.ts) [并发与取消](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/packages/coding-agent/src/task/parallel.ts) [恢复](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/packages/coding-agent/src/task/persisted-revive.ts) [结构化结果](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/packages/coding-agent/src/task/structured-subagent.ts)

**Picode 最小适配**：继续使用现有 pi-subagents；把 async-started/complete、wait/steer/interrupt/resume、transcript、模型/账号、Safe Worktree 和 acceptance 统一映射成 WorkHandle + Evidence，并在 GUI 中可观察、可控制。默认只读，写入代理必须显式隔离，合并所有权仍属于主任务/用户。

**风险**：每个子代理都会放大模型、内存、MCP 与工具负载；必须有全局和任务级并发上限。复杂度主要在生命周期与证据映射，不应通过重写编排器扩大范围。

### 5. 最小模型可操作 DAP，而不是完整调试器平台

OMP 把 launch/attach、breakpoint、continue/step、stack/scopes/variables/evaluate、output/terminate 作为可取消的会话工具，支持 idle timeout 与明确状态。[DAP 工具](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/packages/coding-agent/src/tools/debug.ts#L721-L820) [生命周期](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/docs/tools/debug.md#L121-L133) [取消与空闲回收](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/docs/tools/debug.md#L254-L270)

**Picode 最小适配**：复用现有 `launch_dap`、授权、WorkManager 和事件队列，只加一个 task-bound root session 的模型工具：launch/attach 明确确认、源码断点、continue/pause/step、stack/scopes/variables/evaluate、output、terminate。memory/disassembly/data breakpoint/custom request 暂不做。

**风险**：adapter 和 debuggee 都占内存，状态机、Windows/引擎差异和僵尸进程风险中高；因此晚于 LSP，并保持可完全卸载。

### 6. MCP 只在显式激活后持久化

OMP 的 MCP manager 有工具定义缓存、deferred discovery、通知、重连、退避、熔断和 teardown。[manager](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/packages/coding-agent/src/mcp/manager.ts#L198-L226) [运行生命周期](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/docs/mcp-runtime-lifecycle.md#L7-L16) [重连/熔断](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/docs/mcp-runtime-lifecycle.md#L164-L180)

**Picode 最小适配**：用户或 Harness 显式绑定某 MCP 后，才创建 per-task connection manager；缓存 tool definitions，有限退避，连续失败熔断，转发 resources/prompts/notifications，任务结束或 idle TTL 到期即关闭。

**风险**：stdio 子进程和 HTTP 连接会增加句柄、内存、凭证及供应链面；复杂度中高。严禁把 OMP 的 startup discovery 直接搬到 Picode 正常启动路径。

### 7. 按 failure domain 设计健壮性 Gate

OMP 的 CI 不只按包分桶，还单列 singleton/global-state、runtime/session、CLI/install smoke、native/integration，并通过聚合 Gate 控制发布；其 reviewer 契约要求只读、证据化并追到 consumer。[CI 固定版本](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/.github/workflows/ci.yml#L294-L462) [reviewer 契约](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/packages/coding-agent/src/prompts/agents/reviewer.md#L57-L99)

**Picode 最小适配**：增加 fresh process、重复启动/停止、迁移后重放、取消竞态、late event、null/unknown payload、打包后资源存在、Simple 零驻留等 failure-domain 测试；产生机器可读 finding/attestation，由外部 reviewer 和 CI 保持权威。

**风险**：运行成本在 CI 而非常驻内存；复杂度主要是 fixture 和分桶维护。不要复制 OMP 的巨型 native/platform matrix，也不要把 LLM review 当确定性 Gate。

## P1–P5 改进任务

以下优先级不是原 P0–P5 里程碑的重命名，而是本次复核后的执行队列。P1 最高；每一级都以前一级证据稳定为前提。

### P1 — 先消除空引用、旧状态和“假通过”

#### P1-01 Fresh-checkout Gate 与真实性能基线

- 修复 `src-tauri/resources/pi` 的生成/获取/打包前置契约，使全新 clone 在没有隐式本机残留时也能运行 P0–P4 Gate。
- 保留本轮“缺资源失败、补资源后全绿”的双份证据；Gate 缺少资源或指标时必须明确 `failed`/`not_measured`，不能沿用旧 artifact 或把 `metrics: []` 当性能通过。
- 冻结 Simple Task 的冷启动、idle RAM、首 token、长列表滚动基线；Harness 另测首次 LSP/MCP/DAP 激活成本。
- 验收：干净目录连续两次结果一致；构建产物 smoke 能找到 Pi 资源；失败后不污染下一次运行。

#### P1-02 版本化 Tool/RPC/Event 边界

- 为 Broker frame、native command、extension result、WorkHandle/Evidence event 定义可迁移 schema 与集中 decoder。
- 统一 `null`、缺字段、未知字段、非法枚举、超大 frame、重复终态、迟到结果、取消/截止时间。
- 先处理 70 个生产 `unwrap/expect` 中的高风险边界：Broker poisoned lock、Pi 资源解析、启动状态读取和持久化恢复；普通内部不变量不做无差别机械替换。
- 验收：fuzz/property tests 不 panic；malformed tool result 可持久化、可重放；cancel 后的 late result 不复活任务；单个 broker handler panic 不造成全局锁毒化连锁崩溃。

#### P1-03 单一 Runtime Lifecycle 入口

- 把 Pi、ACP、headless、extension、subagent 的事件先翻译成统一 lifecycle event，再由一个 reducer 更新 RuntimeSpine、WorkManager、SessionKernel、ContextEngine、Completion 与 Evidence。
- TaskControl 成为任务运行状态的单一权威；旧 Agent Inbox `tasks.json` 只能通过兼容 Adapter 投影，停止由 GUI/embedded server 双写。
- 去除 `main.rs` 中各自写状态、某些 runtime event 没有 `work_id`、终态顺序不一致的残留路径。
- 验收：每个 run 只有一个 authoritative terminal transition；重复/乱序/进程重启重放保持幂等；Inbox 和主任务状态不能分叉或复活旧任务。

#### P1-04 Compaction/Retry/Replay 恢复不变量

- 不实现新 compactor；补 tool-call/result 配对、compacting/retrying 非终态、artifact 引用、任务状态再注入。
- 红测：overflow、incomplete output、compaction 中取消、写入一半崩溃、截断 JSONL tail、旧 schema、无结果 tool call。
- 验收：恢复后不会空引用，不会重复执行已经有副作用的工具，不会把中间态显示为完成。

#### P1-05 残留状态专项测试桶

- 新增 singleton/global-state、fresh-process、重复 enable/disable、连续切账号/模型、任务 A → Simple Task → 任务 B、安装包资源 smoke。
- 每个测试必须验证句柄、子进程、监听器、定时器、连接、模型工具列表与内存基线回落。
- 验收：可生成机器可读 finding，并能定位 owner/module，而不是只报 UI 超时。

#### P1-06 HookPoint 生产接线或降级

- 把 `AfterTool`、`Stop`、`SubagentStop` 接到统一 Runtime Lifecycle 的确定边界；定义一次性、顺序、超时、取消和 fail-open/fail-closed。
- 若当前无法保证某 HookPoint 的自动触发，就从公开 capability/文档中降级，不能继续呈现为可用功能。
- 验收：真实工具成功/失败、用户停止、崩溃停止、子代理完成/取消都有 end-to-end 测试；重复事件不会重复执行有副作用 Hook。

### P2 — 加深代码理解闭环

#### P2-01 任务绑定的持久懒启动 LSP

- 按 workspace/language 复用 server；版本化 didOpen/didChange/didSave；取消旧请求与旧诊断；失败负缓存；idle TTL。
- 第一阶段只做 hover/definition/references/symbols；稳定后才开放 rename/code action，并要求文件 digest/preflight。
- 验收：连续编辑不会注入旧诊断；server 崩溃可降级/重启；Simple/disabled 时进程数为零；任务结束后按 TTL 回收。

#### P2-02 ContextEngine 接入真实 turn/replay 路径

- 让现有预算与 artifact 计划成为 Pi 事件桥接的约束，而不是一条只可单独调用的旁路。
- Shell、LSP、DAP、MCP、Browser 的大输出使用统一 artifact reference 与 preview 上限。
- 验收：模型上下文、显示 transcript、Session replay 三者各有明确真相源；长任务压缩后仍知道当前任务、改动、Gate 与未完成工作。

### P3 — 完成并发代理和调试的最小闭环

#### P3-01 深化 DelegationEngine，完成 pi-subagents GUI/证据接线

- DelegationEngine 统一 dispatch/control/collect/rollback，不再让 GUI 和 `main.rs` 理解整个生成顺序。
- 映射 typed result、wait/steer/interrupt/resume、transcript、账号/模型、WorkHandle/Evidence、acceptance 和 Safe Worktree review。
- 验收：父取消传播；并发有全局/任务上限；写代理默认隔离；重启后可解释 parked/aborted/completed；不重写 pi-subagents runtime。

#### P3-02 最小模型 DAP Session

- 当前实现只是 Adapter 进程启动、事件记录与清理壳；在此基础上实现 DAP initialize、launch/attach、request/response/event correlation，再开放前述最小操作集。launch/attach 与 evaluate 按 effect tier 授权。
- 所有 adapter/debuggee 都归 WorkManager，事件和变量树有界，任务/idle 结束自动 terminate。
- 验收：至少一个软件项目和一个已选择的游戏项目完成“断点 → 停止 → 读变量 → step → 修复 → Gate”；未安装 adapter 时明确降级，不崩溃。

### P4 — 收窄可选能力，清掉升级残留

#### P4-01 显式激活的 MCP Connection Manager

- per-task 连接、tool schema cache、有限重连、熔断、notifications/resources/prompts、idle shutdown。
- 验收：Simple 启动无 discovery/网络/子进程；服务断开不会无限重连；禁用/任务结束后资源归零；repo MCP 配置仍需信任和执行确认。

#### P4-02 深化或删除浅 façade

- 移除 `ExtensionManager: Deref<ExtensionService>` 的全表面暴露，按安装/信任/激活/运行/停止分窄接口；迁移 caller 后删除旧入口和重复状态。
- 同样审查 CodeIntelligence 的 Rust façade、旧 LSP framing、Harness router 与 GUI 直连旁路：每个 seam 必须只有一个 owner，否则删除名义模块。
- 验收：调用者不依赖实现细节；disable 后 process/listener/tool/network 都归零；旧路径有编译期或测试保护，不能静默回流。

### P5 — 接外部权威与游戏项目特化，不扩张为平台

#### P5-01 Remote CI VerificationAdapter

- 把本地 Gate artifact 映射为 provider-neutral request；接收不可伪造的 provider run/build/commit 身份和 attestation。
- 状态严格区分 `locally_verified`、`ci_pending`、`ci_failed`、`ci_verified`；外部 reviewer/主分支保持最终权威。
- 验收：本地不能自行产生 `ci_verified`；远程失败/取消/过期能回放；Picode 不 push、merge、占有 `main`。

#### P5-02 一个由真实项目选择的游戏验证 Adapter

- 只为当前实际使用的 Unity、Godot 或 Unreal 其中一个实现 import/build/runtime log/reference/GUID 的最小 Gate。
- 引擎、SDK、profiler 仍是外部 capability，不打包进 Resident Core；第二个引擎必须由真实项目需求触发。
- 验收：未配置引擎时零进程、零扫描；配置后能输出确定性 evidence，并与 DAP/CI Adapter 复用同一 Verification 接口。

## 明确不列为任务

- 不重写 Pi compaction、agent loop、Shell 或 pi-subagents；边界缺陷优先上游修复与版本升级。
- 不追 OMP 的 provider/tool 数量、完整 DAP 操作面、Rust native 栈、FUSE/ProjFS、swarm、IRC、live relay、snapcompact、durable memory。
- 不做默认 `yolo`、advisor 写权限、静默账号轮换、项目配置无确认执行。
- 不在启动时加载 LSP/MCP/DAP/Browser/Extensions；不让 Simple Task 继承上一个 Harness 的工具、进程或 workspace 状态。
- Firstmate、手机遥控、跨模型 challenger 与供应链扫描器不进入 Resident Core，但按既有产品决定保留为 P5 第三层 Adapter；远程 worker 池不进入当前承诺。

## 最终判断

Oh My Pi 更像一个能力宽、终端优先、把许多开发设施内建进去的 Agent 系统；Picode 应坚持“轻桌面核心 + 任务绑定 Harness + 外部开发工具/CI 权威”的路线。两者最有价值的交集不是复制功能，而是把每个异步边界都变成清楚的契约：**谁拥有进程、谁能改变状态、如何取消、怎样限制输出、怎样重放、怎样证明完成。**

因此，本轮应按 P1 → P5 顺序推进：先让现有能力经得住空引用、旧状态、崩溃恢复和 fresh-checkout Gate，再补持久 LSP、子代理 GUI 和最小 DAP；MCP 稳定性、外部 CI 与游戏 Adapter 后置。这样既能吸收 OMP 最成熟的工程经验，也不会把 Picode 做成另一个 Oh My Pi。
