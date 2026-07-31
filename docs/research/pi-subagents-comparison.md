# Picode 与 `nicobailon/pi-subagents` 子代理能力对比

核对日期：2026-07-31

上游版本：`pi-subagents` 0.37.2，提交 [`d2496f5`](https://github.com/nicobailon/pi-subagents/tree/d2496f5f92492b5e5764623974de445d01fa5c0b)，MIT License。Picode 本地版本为 0.3.0；本次集成已将 Pi Coding Agent 与内嵌 CLI 从 0.80.10 升至 0.83.0，并固定安装 `pi-subagents` 0.37.2。[上游 package.json](https://github.com/nicobailon/pi-subagents/blob/d2496f5f92492b5e5764623974de445d01fa5c0b/package.json)

## 结论

Picode 已有真正的子代理执行链路：独立 Pi 进程、独立模型、并发批量派发、工具范围、父子运行归属、完成结果回注父会话、运行监看和终止。它不是占位实现。

若只计算 Picode 自研的 `task` 工具，把 `pi-subagents` 视为 100%，原生覆盖约为 30%–40%。本次采用兼容扩展集成后，Harness Task 可直接使用上游的完整编排器，因此从用户可用能力看，chain、parallel、fresh/fork、后台控制、恢复、结构化输出、验收、worktree 和保存工作流等能力不再是缺失项；Picode 自研工具与上游工具仍保持职责分离。

## 接入后的产品边界

- `task`：Picode 原生的有界单次/批量委派，继续使用 GUI 中配置的候选模型、账号路由、任务接管与结果回注策略。
- `subagent` / `subagent_wait`：`pi-subagents` 0.37.2 的高级编排与控制面，仅在 Harness Task 暴露；Simple Task 保持最小 Pi 能力。
- `/subagents`、`/chain`、`/parallel`、`/subagents-fleet`：上游命令随托管包加载。
- 后台生命周期：启动和完成事件已桥接到 Picode“运行监看”，显示 run ID、PID、Agent、模式、目标与状态；管理操作仍由上游命令/工具负责。
- 子进程内核：无论标准桌面路径还是 Native RPC 路径，均通过 `PI_SUBAGENT_PI_BINARY` 强制使用 Picode 内嵌的 Pi 0.83.0，避免调用系统 PATH 中的旧版 Pi。

## 接入前的逐项对比（保留用于说明自研 `task` 与上游编排器的边界）

| 能力 | Picode 当前 | `pi-subagents` | 差距 |
|---|---|---|---|
| 真子进程/独立上下文 | 为每个子代理启动独立 Pi RPC 进程，并在运行注册表中记录父子关系 | 每个子代理为独立 child Pi session | 接近 |
| 单个派发 | `task` 支持 scout/reviewer/tester/task 四个固定 profile | 内置 scout/researcher/planner/worker/reviewer/context-builder/oracle/delegate，另可创建用户和项目 Agent | 中等 |
| 并行派发 | `tasks` 通过 `Promise.all` 并发，1–16 项 | parallel、每项 count、并发上限、fail-fast、静态组和动态 fan-out/fan-in | 较大 |
| 顺序链 | 无 | chain 将前一步输出作为 `{previous}` 传给下一步，支持平行组和命名输出 | 缺失 |
| 上下文模式 | 注入 Picode Task Context 和精确任务信封；不复制完整父会话 | fresh 或真实 fork parent session，可按 Agent 设置默认值 | 较大 |
| 结果回传 | 子代理结束后以 `follow_up` 候选结果回注父 Agent | 前台流式结果、后台通知、结构化结果、链式结果、文件输出 | 中等 |
| 运行中控制 | GUI 可观察父子运行并取消；没有模型可调用的子代理控制面 | status、transcript、steer、interrupt、stop、resume、wait、append-step | 很大 |
| 后台运行 | 子代理默认异步运行，父 Agent 收到完成回注 | 前台/后台可选，detached async、恢复、自动 drain、completion batching | 中等偏大 |
| 子代理继续/恢复 | 无子代理专用 resume；账号接管是 Picode 任务级机制 | 可 revive paused/completed/failed child；stopped 明确不可恢复 | 缺失 |
| 嵌套子代理 | 默认禁止 | 通过显式 `tools: subagent` 和最大深度/生成预算受控开启 | 缺失但当前限制合理 |
| 模型策略 | GUI 候选模型、健康度、成本/能力评分、fallback；每次可设 effort | 默认/角色/单次模型、thinking、fallback models、model scope、provider catalog/profile 和 live probe | 中等 |
| 工具/扩展权限 | profile 工具类别映射为精确工具 allowlist；Harness 才可用 | tools、extensions、subagentOnlyExtensions、skills、MCP direct tools、capability ceiling、可选 permission system | 很大 |
| Skills | 继承 Picode Harness 能力，但无每个子 Agent 的技能选择 | 每 Agent/每步骤选择、独立 skillPath、继承开关、缺失提示 | 较大 |
| 工作区隔离 | 已有 Picode Safe Worktree 服务，但 `task` 不自动创建；隔离写入会要求先授权创建 | parallel/workflow 可自动建立独立 Git worktree、捕获 patch、清理和保留故障证据 | 较大 |
| 结构化输出 | 只有文本 expectedResult 和候选结果包装 | JSON Schema 校验、`structured_output` 强制终止、命名结构化输出和动态展开 | 缺失 |
| 验收门禁 | 父 Agent 被提示自行核验候选结果 | acceptance report、证据级别、验证命令、独立 review gate、失败阻断链路 | 很大 |
| 长任务预算 | Picode 有运行超时和用户策略，但没有 turn/tool/spawn 三层预算 | timeout、turn budget、tool budget、spawn budget、long-running guard | 较大 |
| 监督通信 | 子 Agent 遇到问题只能结束/在结果中报告 | child 可 `contact_supervisor`，parent 可 reply，另有 steer/interrupt | 缺失 |
| 可观测性 | GUI runtime monitor 显示父子树、状态、动作和资源 | FleetView、完整 transcript、token/cost、异步 artifacts/events、终止证明 | 中等偏大 |
| Watchdog | 无专门子代理 watchdog | 写入触发的独立模型审查、增量 LSP 诊断、主/子不同模型 | 缺失 |
| Agent 持久记忆 | 无角色级记忆 | 每 Agent 可选 project/user `MEMORY.md` | 缺失 |
| 保存工作流 | 无 | `.chain.md`/`.chain.json`、slash commands、prompt workflows | 缺失 |
| 对外 API | Picode 主要通过内部 broker/Rust RPC | 有 delegation v1/v2、preflight、capability ceiling、background-work provider 和事件 RPC | 较大 |

## 上游源码证据

- 单个、并行、链、动态 fan-out、上下文 fork、后台、预算、工作树和结构化输出都暴露在同一工具 schema 中：[schemas.ts](https://github.com/nicobailon/pi-subagents/blob/d2496f5f92492b5e5764623974de445d01fa5c0b/src/extension/schemas.ts#L115-L350)。
- 后台状态、FleetView、transcript、嵌套运行树和生命周期 artifacts：[README.md](https://github.com/nicobailon/pi-subagents/blob/d2496f5f92492b5e5764623974de445d01fa5c0b/README.md#L285-L339)。
- 顺序链、并行组、fail-fast、worktree 和 per-step 配置：[README.md](https://github.com/nicobailon/pi-subagents/blob/d2496f5f92492b5e5764623974de445d01fa5c0b/README.md#L476-L650)。
- Agent frontmatter 支持工具、扩展、Skills、上下文、预算和持久记忆：[README.md](https://github.com/nicobailon/pi-subagents/blob/d2496f5f92492b5e5764623974de445d01fa5c0b/README.md#L670-L864)。
- Supervisor 双向通信：[README.md](https://github.com/nicobailon/pi-subagents/blob/d2496f5f92492b5e5764623974de445d01fa5c0b/README.md#L371-L400)。
- JSON Schema 结构化输出实现：[structured-output.ts](https://github.com/nicobailon/pi-subagents/blob/d2496f5f92492b5e5764623974de445d01fa5c0b/src/runs/shared/structured-output.ts)。
- 验收证据、结构检查、验证命令和 review gate：[acceptance.ts](https://github.com/nicobailon/pi-subagents/blob/d2496f5f92492b5e5764623974de445d01fa5c0b/src/runs/shared/acceptance.ts)。
- Git worktree 建立、patch 捕获和清理：[worktree.ts](https://github.com/nicobailon/pi-subagents/blob/d2496f5f92492b5e5764623974de445d01fa5c0b/src/runs/shared/worktree.ts)。

## Picode 本地证据

- `extensions/runtime/subagent-runtime.ts`：四种 profile、1–16 项批量任务、精确任务信封和工具类别限制。
- `extensions/embedded-server.ts`：`task` 模型工具、并行启动、effort 到 thinking level 的映射。
- `src-tauri/src/main.rs`：独立 Pi 进程启动、父子运行绑定、结果通过 `follow_up` 回注父 Agent。
- `src-tauri/src/task_control.rs`：父子运行注册、运行状态和默认禁止嵌套。
- `src-tauri/src/orchestration_service.rs`：用户模型候选策略、健康度、fallback、工作类别资格和持久化。
- `public/components/runtime-monitor.js`：GUI 父子运行树和资源监看。

## 后续建议

不建议继续从零复制 `pi-subagents` 的全部编排器。Picode 与它同属 Pi 扩展生态，且上游是 MIT；最快路径是把它作为可选/内置扩展能力接入 Picode GUI，同时由 Picode 保留账号、模型来源、任务接管、GUI 运行监看和安全工作区这些差异化能力。

上述高级能力已经由托管的 `pi-subagents` 提供，后续不应在 Picode 中重复实现。下一步应集中在 GUI 集成：为 Fleet/状态/恢复提供图形入口、将 Picode 的账号与候选模型策略映射给上游 Agent 配置，并把 Safe Worktree 的授权和证据展示统一到 Picode 任务面板。

本次采用扩展集成而不是复制上游运行时代码：Picode 保留现有 `task` 作为 GUI 模型策略驱动的有界单次/批量委派，同时在 Harness Task 中开放 `subagent` 与 `subagent_wait` 处理高级编排。Simple Task 不开放这两个工具。
