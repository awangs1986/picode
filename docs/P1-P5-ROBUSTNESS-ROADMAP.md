# Picode 健壮性收口与 P1–P5 路线图

> 日期：2026-08-01（Asia/Taipei）  
> 状态：当前权威改进队列；旧 P0–P4 文档继续保留实现历史，但不再代表“没有剩余工程债”  
> Picode 审计基线：`6f2e56a26e1df9a803b895a42ceaa280eca1b475`（`main`）  
> Oh My Pi 对比基线：[`80627462b4e91f46795ba87f3678174bd3c0b907`](https://github.com/can1357/oh-my-pi/commit/80627462b4e91f46795ba87f3678174bd3c0b907)

## 1. 结论

Picode 当前不是“功能已经坏掉”，也不需要推倒重来。补齐本机 Git 忽略的 Pi 运行时以后，完整 P0–P4 Gate 全绿：92 个前端测试文件、366 个前端测试、205 个 Rust 主程序测试和 3 个 headless 测试通过，Clippy、格式、性能契约、P4 扩展红灯 Gate、设计、权限、扩展打包和 Biome 也全部通过。

但是，Gate 全绿不等于升级残留已经清零。本轮源码审计发现四个必须先处理的高风险事实：

1. Agent Inbox 仍把任务写入 `~/.pi/agent/super-agent/tasks.json` 并直接向子端口发送 prompt；新的 TaskExperience/TaskControl 则维护另一套 ExecutionState、AgentRun 和 SessionKernel。两套任务生命周期同时存在。
2. 多个核心状态服务遇到一个损坏 JSON 或 session descriptor 会让整个应用启动失败，没有统一的备份、隔离和降级启动协议。
3. 生产路径仍有 70 个 `unwrap`/`expect`；其中 BrokerWs 32 个、PiManager 18 个主要是共享锁。一次持锁线程 panic 可能通过 mutex poisoning 扩散成桌面级故障。
4. 部分“已实现”能力仍是浅闭环：HookPoint 声明了未自动触发的边界；LSP/MCP 每次请求启动进程；DAP 目前主要是启动、超时和事件记录；ExtensionManager 仍通过 `Deref` 暴露整个 ExtensionService。

所以本轮优先级不是继续堆工具，而是先把已有能力变成：**单一状态源、可恢复、可取消、可重放、可测红、按需驻留。**

## 2. 审计证据

### 2.1 已确认健康

| 检查 | 结果 | 含义 |
|---|---:|---|
| 前端 `_control` 命令到 Rust handler | 102 / 102 有处理器 | 没有发现悬空 GUI 控制命令 |
| 已调用 transport 方法 | 79 / 79 存在 | 没有发现调用不存在的方法 |
| `app.js` 静态 DOM id | 115 个引用；5 个未在静态 HTML 中出现，但均为动态创建或显式判空 | 没有复现静态空引用 |
| 前端测试 | 92 files / 366 tests 通过 | 当前主要 GUI/扩展契约可运行 |
| Rust 测试 | 205 + 3 通过，12 个 fixture 忽略 | 当前核心状态机和红灯 fixture 可运行 |
| P4 扩展红灯 Gate | 通过 | 恶意 manifest、SHA 漂移、未信任能力、MCP/DAP 故障和禁用零驻留已有基础证据 |
| Clippy / fmt / Biome / 设计 / 权限 | 通过 | 当前提交没有已知静态检查失败 |

### 2.2 需要收口的真实风险

| 风险 | 源码事实 | 可能后果 | 优先级 |
|---|---|---|---:|
| 双任务状态源 | `public/super-agent/*`、`embedded-server.ts` 的 `tasks.json` 与 Rust TaskControl 并存；`ExecutionStore::migrate_legacy` 只在测试中调用，而且测试源名是 `super-agent.json` | 任务状态、账号接管、取消、Gate、监控和恢复互相看不到 | P1 |
| 状态文件损坏会阻止启动 | TaskControl、CapabilityService、OrchestrationService、ExtensionService 和 SessionKernel 在 open 阶段直接返回错误 | 一次断电、旧 schema 或手工损坏可能让整个 GUI 无法启动 | P1 |
| panic/锁毒化 | 生产代码 70 个 unwrap/expect；BrokerWs 32、PiManager 18 | 一个线程 panic 后大量命令连续失败，甚至进程退出 | P1 |
| fresh-checkout Gate 隐式依赖 | 首次 Gate 因 `src-tauri/resources/pi` 不存在而失败；`build.rs` 在 debug return 前已触发 Tauri resource 校验 | 新仓库、CI 或 IDE 无法直接运行 Rust Gate；历史 artifact 容易被误认为当前证据 | P1 |
| 性能“契约通过”不等于性能测量 | 当前 performance Gate 的 `metrics` 为空，`metricGate` 为 `not_requested` | 无法发现 idle RAM、CPU、端口、首次激活和回收回归 | P1/P4 |
| 外部结果没有一个统一 decoder | Broker、Pi event、扩展、MCP/LSP/DAP 和 GUI 各自解析 JSON | `null`、缺字段、迟到终态和截断 frame 可能形成难复现状态污染 | P1 |
| Hook 公开面大于生产接线 | `BeforeTool` 和 `before_complete` 有真实入口；`AfterTool`、`Stop`、`SubagentStop` 只有类型/手动调用 | 用户看到“支持”但实际工作流不会触发 | P2 |
| LSP/MCP/DAP 仍浅 | LSP/MCP 每请求启动并结束；DAP 没有完整的 initialize/breakpoint/stack/variables/step 协议工具 | 大项目中诊断陈旧、启动开销高、无法完成真实调试闭环 | P2 |
| 名义 Manager 不是深模块 | `ExtensionManager: Deref<ExtensionService>`；`main.rs` 仍理解所有扩展细节 | 新能力继续堆入一个 3983 行 service，升级更易产生残留 | P2/P4 |
| 大文件与死代码豁免 | `main.rs` 3989 行、`extension_service.rs` 3983 行、`app.js` 4769 行、`embedded-server.ts` 6079 行；24 个 Rust 模块对 production `allow(dead_code)` | 老入口和新入口可以长期共存而不被编译器提示 | P4 |

### 2.3 Gate 的准确解释

第一次运行完整 Gate 时，Pi 运行时没有随仓库移动，Rust、Clippy、性能契约和 P4 Gate 都因 Tauri resource path 校验失败。把已经存在的 Pi 0.83.0 运行时复制到 Git 忽略的 `src-tauri/resources/pi` 后，第二次完整 Gate 全绿。

因此当前结论必须同时保留两点：

- **代码基线通过当前本机完整 Gate。**
- **Gate 尚不具备 fresh-checkout 自举能力，性能也只有契约测试，没有真实指标。**

不能再只写“P0–P4 已完成”，而不记录运行时 pin、Git commit、环境和实际性能指标。

## 3. 与 Oh My Pi 的差距：只学窄而深的部分

完整源码证据与固定提交链接见 [Picode 与 Oh My Pi 差距复核](research/picode-oh-my-pi-gap-review-2026-08-01.md)。

### 3.1 特别值得学习

| OMP 成熟点 | Picode 应采用的最小形态 | 不应照搬的部分 |
|---|---|---|
| 不可信 tool result 中央归一化 | 统一 Tool/RPC/Event decoder；缺字段、null、超大结果、迟到结果都变成 typed error | 不复制整个 OMP agent loop |
| failure-domain CI | 单列状态迁移、重启、取消竞态、安装产物、singleton/global state 测试桶 | 不复制所有原生平台与发布矩阵 |
| 版本化 LSP 与诊断去陈旧 | workspace/language 复用、document version、取消旧请求、idle TTL | 不追完整 IDE 操作目录 |
| compaction/retry 恢复状态机 | 保持 tool-call/result 配对，恢复 task/Gate/evidence，Pi 继续负责压缩 | 不实现第二套 compactor |
| 有界子代理 | 复用 pi-subagents，统一 WorkHandle、Evidence、父取消和并发上限 | 不做 swarm、递归自治和自动合并 |
| Shell 结构化 outcome 与 PTY 独占 | 在现有 runtime 上补 ConPTY/Unix PTY、进程树取消和 artifact spill | 不移植 OMP Rust shell 栈 |
| provider/model/account 切换边界 | idle 时切换、身份显式、fallback 原因可见 | 不做静默账号轮换 |
| 乐观编辑并发 | 继续深化已有 SafeFileStore：digest、全批次预检、原子写 | 不复制模糊三方合并和私有 patch 方言 |

### 3.2 有差距但不需要在意

以下差距不进入路线图：

- OMP 的 TUI、终端主题、命令和交互 1:1 还原；
- 40+ provider、32+ 工具和完整 role/fallback 配置宽度；
- 所有语言的 Eval、全部 LSP/DAP 操作和全功能 IDE 替代；
- Rust 原生 Shell/N-API、FUSE/ProjFS 等多种隔离后端；
- swarm、IRC、递归子代理、自动 commit/push/merge；
- 进程内无隔离扩展和默认 `yolo` 授权；
- 科研、写作、艺术、通用抓取、PDF/vision 工作台；
- 在没有真实收益证据前建设远程 worker 池。

这些能力会明显增加进程、模型工具噪声、平台维护和安全面，却不直接加强 Picode 的中小型软件/游戏开发闭环。

## 4. 新 P1–P5 执行队列

这里的 P1–P5 是本轮审计后的**新优先级**，不是旧里程碑的重命名。每项 Gate 都必须同时证明正常 fixture 为绿、受控坏 fixture 能红。

## P1 — 消除升级残留和桌面级故障传播

### P1-01 统一版本化 StateStore

- 为 TaskControl、AgentRun、Capability、Orchestration、Extension 和 Session descriptor 建立同一持久化契约：schema version、唯一临时文件、flush/fsync、原子替换、最近已知良好备份、损坏文件 quarantine。
- 单个非核心状态损坏时应用以安全降级模式启动，UI 显示具体文件、备份和恢复选择；不能直接白屏或退出。
- 为每个已经发布过的 schema 保存 fixture，并测试 Windows/Linux/macOS 路径迁移、未知字段、新版本只读和回滚。
- 红灯：截断 JSON、尾部半写、错误类型、future schema、只读目录、迁移中断。

### P1-02 Agent Inbox 收敛到 TaskExperience

- 保留 Agent Inbox/Telegram/远程入口的用户价值，但把它变成 TaskExperience 的输入 Adapter。
- 新任务、状态、取消、账号接管、工作区、AgentRun、Evidence 和 Gate 全部只写 TaskControl/SessionKernel；删除直接 prompt dispatch 和 `tasks.json` 的运行期真相源角色。
- 从真实路径 `~/.pi/agent/super-agent/tasks.json` 做幂等、事务式、可回滚迁移；旧文件保留备份并写 migration tombstone。
- 红灯：并发更新、重复导入、迁移中断、子端口死亡、账号退出、用户未输入“继续”。

### P1-03 清除外部可达 panic 和锁毒化扩散

- BrokerWs、PiManager、RuntimeCoordinator、URL 解析和 RuntimeLifecycle 邮箱不再对运行期状态使用 `unwrap`/`expect`。
- 共享锁采用明确的 poison recovery 或返回 owner/module 可定位的错误；单一 Pi/扩展崩溃不能毒化桌面控制面。
- 编译期常量和已经证明的不变量可以保留 expect，但要通过类型构造把它们移出外部输入路径。
- 红灯：持锁 worker panic、非法 URL、重复 terminal event、进程表突变、broker reconnect 中 shutdown。

### P1-04 统一 Tool/RPC/Event Decoder

- 给 Broker frame、Pi event、control command、扩展/MCP/LSP/DAP 返回和 Evidence 建立版本化 typed envelope。
- 统一处理 null、缺字段、未知字段、非法枚举、超大 frame、重复终态、cancel 后迟到结果和部分 UTF-8。
- malformed result 必须可显示、可持久化、可重放，绝不能复活任务、污染下一轮或制造 JS 空引用。
- 增加真实 `index.html` boot/navigation smoke，而不只测试理想化组件 fixture。

### P1-05 Fresh-checkout 与 failure-domain Gate

- Rust unit/Clippy Gate 不应隐式要求 111 MB Pi 发布资源；安装包 smoke 才要求固定 SHA 的 Pi runtime。若仍需资源，Gate 必须自举或给出一个明确 preflight。
- Gate artifact 写入当前 branch、commit、Pi pin、OS/arch 和命令，不再硬编码旧分支。
- 新增 state migration、fresh process、重复启动/停止、账号切换、late event、打包资源、禁用零驻留测试桶。
- 性能结果把 `contract_passed` 与 `measured_passed` 分开；`metrics: []` 不能代表性能已验证。

## P2 — 把基础开发工具补成真实闭环

### P2-01 持久懒启动 LSP

- 按 task/workspace/language 复用 WorkManager 所有的 server；实现 didOpen/didChange/didSave version、取消旧请求、诊断 ledger、失败负缓存和 idle TTL。
- 第一阶段只保留 hover、definition、references、symbols；稳定后才增加 rename/code action，并复用 SafeFileStore digest/preflight。
- Simple/disabled 为零进程；server 崩溃可降级并有界重启。

### P2-02 真实 PTY

- 在现有 persistent shell 上增加 Windows ConPTY 与 Unix PTY Adapter，仅 `pty:true` 时启动并在 GUI 显示轻量 terminal surface。
- PTY 独占、普通 shell 共享；输入、resize、timeout、abort、进程树取消和输出 artifact 走同一 CommandOutcome。
- 不引入 OMP Rust shell，不让 terminal 常驻。

### P2-03 显式激活的 MCP Connection Manager

- 用户或 Harness 绑定后才建立 per-task 连接；缓存 tool schema，有限重连、熔断、notifications/resources/prompts 和 idle shutdown。
- 禁用时零 discovery、零网络、零进程、模型不可见；连续失败不能无限刷日志。

### P2-04 最小可操作 DAP

- 复用现有授权、WorkManager、资源限制和事件队列，实现 initialize、launch/attach、source breakpoint、continue/pause/step、stack/scopes/variables、evaluate、output、disconnect。
- memory/disassembly/data breakpoint/custom request 不做；目标是完成一次真实“停住 → 看变量 → step → 修复 → Gate”。

### P2-05 Hook 公开面与真实生命周期一致

- 自动接线 BeforeTool、AfterTool、Stop、SubagentStop 和 BeforeComplete；如果某个 HookPoint 不属于产品，就从公开 schema 和 GUI 删除。
- Hook 仍是第三层能力，默认关闭、显式信任、超时有界、不能获得 Completion 权威。

### P2-06 深化 ExtensionManager

- 移除 `Deref<ExtensionService>`，只暴露 discover/configure/trust/activate/invoke/inspect/stop 这些产品接口。
- MCP、LSP、DAP、Hook、Skill、Firstmate 的实现细节留在内部 Adapter；调用者不能自己维护生命周期状态。

## P3 — 长任务、上下文和子代理闭环

### P3-01 ContextEngine 进入真实 turn/replay

- Pi 继续作为 canonical compactor；ContextEngine 负责预算、artifact reference、tool-call/result 配对、重试/压缩状态和 task/Gate/evidence 最小恢复集。
- Shell/LSP/DAP/MCP/Browser 大输出统一存 artifact，模型只拿有界 preview 并可按需取回。
- 账号/模型切换和任务接管前写 checkpoint，切换后不丢计划、未完成项和验证状态。

### P3-02 DelegationEngine 成为真正 owner

- 把目前 `main.rs` 中的 policy recheck、账号/模型解析、worktree、spawn、health、task activation、prompt、rollback、collect 移入 DelegationEngine。
- 继续复用 pi-subagents；统一 wait/steer/interrupt/resume、typed result、transcript、WorkHandle、Evidence、acceptance 和 Safe Worktree review。
- 全局/任务并发上限、父取消传播、默认只读、写入显式隔离；子代理绝不自行扩大主 Agent 指令边界。

### P3-03 Git checkpoint 与开发者交付

- 统一 checkpoint、diff、测试/Gate evidence、未完成项、账号/模型 epoch 和 handoff package。
- 本地开发者可以交给 CI/主审查者，但 Picode 不自动 push、merge 或拥有 main。

### P3-04 重启、卡死和资源监看

- RuntimeSpine/WorkManager 对 Pi、Subagent、MCP/LSP/DAP/Hook/Browser 建立同一 stall、cancel、restart reconciliation 规则。
- GUI 显示真实 PID、CPU/RAM、owner task/run、最后进度、最近错误和终止原因；不能通过打开监控面板才执行资源限制。

## P4 — 平台、性能和架构瘦身

### P4-01 跨平台路径与工作区矩阵

- Windows drive/UNC、Linux/macOS 绝对路径、大小写、symlink、workspace relocate 和 Git worktree 使用同一 WorkspaceIdentity 绑定协议。
- 默认工作区永远不能落到 system32、`/`、用户根或不可写目录；跨系统导入必须重新绑定。

### P4-02 真实性能预算

- 记录 cold start、idle RSS/CPU/线程/端口/网络、首 token、10k 会话列表和长对话滚动。
- 分别测 Simple、Harness idle、首次 LSP、MCP、DAP、Browser 和 Subagent；任务结束/禁用后验证资源回落。
- 只有实测回归再做 Rust/native hot-path 优化，不因 OMP 使用 Rust 就重写现有 runtime。

### P4-03 清理兼容残留和巨型组合根

- 给 `pistudio` key、`picot` app id、旧 Super Agent、native debug runtime 等建立 compatibility registry：owner、来源版本、读取路径、迁移完成条件和删除版本。
- 逐步拆分 `main.rs`、`extension_service.rs`、`app.js`、`embedded-server.ts` 的责任；删除 24 个 blanket `allow(dead_code)`，仅对有原因的单项豁免。
- release 资源不打包测试文件、prototype 和只用于 debug 的 native surface；保持行为不变后再删除旧入口。

### P4-04 发布与能力来源 Gate

- CI 按 storage/replay、runtime/process、frontend boot、extension red、package smoke、platform path 分桶，再聚合为发布 Gate。
- 每个新能力必须有 per-capability source review：先 Pi 插件，再 OMP，再 Claude/OpenCode 等同类开源项目，最后才自研。

## P5 — 仅按需安装的外部权威与专业 Adapter

P5 全部属于第三层，默认停用；关闭后不得污染 P0–P4 Resident Core。

### P5-01 Remote CI VerificationAdapter 与交叉模型 Gate

- 外部 CI 才能产生 `ci_verified`；Picode 只提交 provider-neutral request 并接收包含 run/build/commit 身份的 attestation。
- 设置中可选择一个目标模型作为 Gate Challenger，验证 Gate 是否能绿、也能红；LLM 结论只作为 advisory，不能替代确定性 Gate。

### P5-02 手机远程控制

- 基于 ACP/SessionTransport 和现有任务/会话内核提供手机端监看、输入、继续、取消和状态通知，不创建第二套聊天或任务状态。
- 默认仅本机；远程开启必须显式认证和可撤销绑定。

### P5-03 一个真实游戏项目 Adapter

- 只按当前真实项目选择 Unity、Godot 或 Unreal 其中一个，提供 import/build/runtime log/reference/GUID 的最小确定性 Gate。
- 引擎、SDK、profiler 不打包进 Resident Core；第二个引擎由真实需求触发。

### P5-04 Firstmate 可选入口

- 保留 Firstmate 的独立顶部入口和第三层开关，统一纳入 ExtensionManager/WorkManager 状态、权限、资源和卸载协议。
- 不把 Firstmate 的 TUI 或第二套任务状态塞进核心聊天。

### P5-05 可选安全、供应链和 OS Sandbox Adapter

- SBOM/license/dependency/secret/SAST、平台 sandbox 和 durable memory 分别作为可卸载 Adapter；按项目显式启用。
- durable memory 必须可检查、可删除，并与任务 checkpoint 分离。

### 明确删除的旧候选

- Remote Worker Pool 不进入承诺，除非以后出现单机无法满足的真实项目证据。
- 不做默认 AI commit/push/merge、swarm、全功能 IDE、科研/写作/艺术工作台。

## 5. 以前剩余工作的归并结果

| 以前的事项 | 本轮状态 |
|---|---|
| Runtime lifecycle ingestion | 主模块已经落地；转为 P1 的入口覆盖、乱序/重放和双状态收口，不再重建模块 |
| Browser automation | 已有可用懒启动基线；只进入 P3/P4 的统一资源、恢复和性能 Gate |
| Persistent Shell / Eval | 已有基线；剩余 PTY 进入 P2，完整 OMP runtime 不移植 |
| pi-subagents | 已接入 `0.37.2`；剩余 GUI/证据/控制/隔离归 P3 |
| eval/browser 自动常驻问题 | 已修正：当前通过 capability search 按需激活，不重复立项 |
| Extension 四态与红灯 Gate | 已有基础；Manager 深化和真实 unload 归 P2/P4 |
| LSP / MCP / DAP | 从“存在接口”改为 P2 的真实闭环，不再按功能名判完成 |
| Hooks | 第三层定位保留；未自动触发的 HookPoint 归 P2 收口 |
| Context / compaction | 不另写压缩器；实际 turn/replay 接线归 P3 |
| Firstmate | 保留为 P5 可选入口，不进入核心编排 |
| CI / 交叉模型 / 手机遥控 / 游戏 Adapter | 统一放 P5，不阻塞本地开发 Harness 发布 |
| 供应链 / sandbox / durable memory | P5 可安装组件，不进入默认产品 |
| Remote Worker Pool | 从路线图删除，等待真实需求 |

## 6. 完成定义

一个任务只有同时满足下列条件才算完成：

1. 正常 fixture 能绿；受控坏 fixture 能让同一 Gate 红。
2. 重启、取消、超时、乱序和重复事件不会改变最终真相。
3. 状态损坏不会静默丢数据，也不会因为一个可选模块让整个应用无法启动。
4. 禁用模块零进程、零端口、零网络、零模型可见性；启用不等于运行。
5. Simple Task 不继承 Harness 的 workspace、工具、MCP/LSP/DAP 或子代理状态。
6. Harness 本地结果最多是 `locally_verified`；CI 和 main 审查权仍在外部。
7. 真实资源和性能指标不回归，而不是只靠 mock、UI 存在或“测试是绿的”。

这条路线会让 Picode 吸收 Oh My Pi 最值得学习的工程韧性，同时保持自己的优势：GUI、多账号任务连续性、轻量按需能力、显式开发流和外部 CI/主审查权威。
