# Picode 与 grok-build Harness 对比（2026-07-31）

## 核验范围

- grok-build：`main` 提交 [`dd04f397`](https://github.com/xai-org/grok-build/tree/dd04f397b1d02f2272b092555669dfba1f01bc85)，提交时间 2026-07-30，Apache-2.0。
- Picode：本地 `feature/p0-p4-complete` 分支；以现有 [开发 Harness 审计](picode-development-harness-audit-2026-07-31.md)、[P0-P4 验收记录](../verification/P0-P4-ACCEPTANCE.md)、[pi-subagents 对比](pi-subagents-comparison.md)及当前源码为准。
- grok-build 的结论同时核对了官方用户指南和关键 Rust 实现。文档入口、crate 划分和构建状态见其固定提交的 [README](https://github.com/xai-org/grok-build/blob/dd04f397b1d02f2272b092555669dfba1f01bc85/README.md)。

## 结论

grok-build 当前是更成熟、更一体化的通用开发 Harness；Picode 已有真正的 P0-P4 开发闭环，但不少能力仍是“后端契约已经有、GUI 和统一生命周期还未完全收口”。

Picode 不应改成 grok-build 的 GUI 外壳，也不应复制它的整套运行时。最值得学习的是它把会话、工具、子代理、后台任务、LSP、扩展、安全和自动化接成了一个统一生命周期。Picode 应保留 Pi 内核、轻量 GUI、多账号/多供应商、Simple/Harness 双模式和三层按需能力模型，再有选择地补齐生命周期与协议层。

## 同颗粒度对比

| 维度 | grok-build | Picode 当前 | 判断 |
|---|---|---|---|
| 产品入口 | Rust 全屏 TUI、headless、ACP stdio/WebSocket | Tauri GUI + Pi broker/RPC | grok-build 自动化/嵌入更强；Picode 桌面可用性更强 |
| 基础工具 | 文件、搜索、编辑、终端、Web、LSP 等形成统一工具注册表 | Pi 基础工具 + Picode Rust/TS 扩展 | 都可开发；grok-build 生命周期整合更成熟 |
| 任务模式 | Normal、Plan、Always-approve；Plan 有独立只读状态机 | Simple Task 与 Harness Task 明确分流 | Picode 的产品边界更适合“轻对话/完整工程”双场景 |
| Harness/Gate | hooks 可在 `PreToolUse` 阻止工具，也可在 `Stop`/`SubagentStop` 阻止结束并反馈原因 | 类型化 Harness Action、Gate、结构化结果、Evidence Ledger、显式红探针 | Picode 的“Gate 必须能红”更严格；缺少通用生命周期 hook 总线 |
| 会话 | 持久 session、TODO、工具事件、子代理、rewind 快照、compact checkpoint、fork | 持久聊天、任务图、checkpoint、账号接管、迁移/备份 | grok-build 的可逆文件历史和上下文恢复更完整；Picode 的跨来源迁移/接管更强 |
| 上下文压缩 | token 预算驱动的多阶段压缩、工具结果裁剪、压缩 checkpoint | 有聊天压缩/备份与任务 checkpoint，但未形成同等级统一推理上下文管线 | grok-build 明显领先 |
| 长期记忆 | 可选且默认关闭；Markdown + SQLite FTS5/vector；首轮/压缩后检索；Dream 去重整理 | durable memory 仍属于第三层/P5 | grok-build 可作为第三层参考，不能放入常驻核心 |
| 子代理 | 独立上下文、角色/persona、能力模式、模型覆盖、后台、resume、MCP 继承、worktree、GUI/TUI 观察；默认一层深度 | 原生 `task` + 已托管 `pi-subagents`；有模型策略、父子运行、结果回注和监看 | 可用能力接近，但 Picode GUI、模型路由、恢复和证据尚未统一 |
| 后台任务 | command/subagent/monitor/loop/scheduler 统一 ID、wait/kill/通知与 Tasks Pane | background jobs、运行注册表、资源/卡死监看 | Picode 有资源监控优势；grok-build 的统一任务协议与唤醒语义更成熟 |
| Git 隔离 | session fork/subagent worktree、apply、resume rehydrate、rewind 文件快照 | Safe Worktree、Git snapshot、写入租约/授权 | 方向一致；Picode 还需把 worktree 证据和子代理 GUI 合并 |
| LSP | 多 server manager、文件版本对应诊断、pending policy、有界摘要、进程树回收 | lazy scoped LSP 基线/one-shot mappings | grok-build 明显领先，值得优先学习 |
| 插件/Skills | plugin 可捆绑 skills、commands、agents、hooks、MCP、LSP；marketplace、SHA pin、启用/信任分离、`inspect` | 三层能力目录、skills 导入、专业扩展开关、MCP/DAP/firstmate 路径 | Picode 分层目标更轻；grok-build 的包模型、来源/信任/检查体验更完整 |
| 兼容迁移 | 原生读取 Claude/Cursor skills、rules、hooks、settings，并允许按 vendor 关闭 | 手动导入 Codex/Cursor/Claude 账号、聊天、Skills、配置 | 两者侧重点不同；Picode 更适合个人多 Agent 迁移 |
| 模型/供应商 | 默认 xAI；也支持 OpenAI Chat Completions、Responses、Anthropic Messages 和自定义 endpoint | GUI 管理 Codex/Cursor/Claude/OpenAI/Anthropic/反代及来源区分 | 都支持自定义模型；Picode 的账号导入与来源可视化更强 |
| 权限/隔离 | allow/ask/deny、模式、项目级规则、folder trust、Linux Landlock/bwrap、macOS Seatbelt | 统一授权契约、secret reference、workspace/safe-write 边界 | grok-build 的 OS 沙箱更成熟，但不覆盖 Picode 的 Windows-first 重点 |
| 可观测性 | Dashboard、任务 Pane、token/cost、可选外部 OTEL，默认不含内容且双重 opt-in | GUI Runtime Monitor，父子树、PID、CPU、内存、stall、token/cost 可用性标记 | 各有优势；Picode 本机资源视图更贴近个人桌面，缺统一事件 schema |
| CI/外部集成 | headless JSON/streaming JSON、明确退出码、ACP，天然适合 CI/eval | 本地 P0-P4 Gate 完整；CI 权威回传 adapter 尚缺 | grok-build 明显领先 |
| Windows | 发布 Windows 二进制，但仓库说明 Windows 构建为 best-effort、当前树不测试 | Windows-first Tauri GUI | Picode 不应照搬其平台实现假设 |

## 官方文档与源码交叉验证

以下能力不只是 README 宣传：

1. **ACP 与 headless 是正式入口。** headless 支持 session ID、resume/fork、工具 allowlist/denylist、最大 turn、JSON 与流式事件；ACP 暴露 session、工具流、权限请求和 `x.ai/*` 扩展方法。[Headless](https://github.com/xai-org/grok-build/blob/dd04f397b1d02f2272b092555669dfba1f01bc85/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md) · [ACP](https://github.com/xai-org/grok-build/blob/dd04f397b1d02f2272b092555669dfba1f01bc85/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md)
2. **子代理是真实独立 session。** 文档定义 capability mode、resume、MCP 继承和 worktree；实现中确有 resume source 校验、worktree 重建、能力交集和深度控制。[文档](https://github.com/xai-org/grok-build/blob/dd04f397b1d02f2272b092555669dfba1f01bc85/crates/codegen/xai-grok-pager/docs/user-guide/16-subagents.md) · [实现](https://github.com/xai-org/grok-build/blob/dd04f397b1d02f2272b092555669dfba1f01bc85/crates/codegen/xai-grok-shell/src/agent/subagent/handle_request.rs)
3. **会话以事件流为权威记录。** session 包含更新流、原始模型历史、plan、rewind、signals、compaction checkpoint 和子代理元数据，并用 SQLite FTS5 加速标题/提示词搜索。[Sessions](https://github.com/xai-org/grok-build/blob/dd04f397b1d02f2272b092555669dfba1f01bc85/crates/codegen/xai-grok-pager/docs/user-guide/17-sessions.md)
4. **压缩是显式 token 预算算法。** 源码按固定阶梯执行：保留原文、丢弃最旧历史、裁剪超大工具结果、丢弃旧步骤、最后紧急缩减最新项，并记录原始/压缩 token 和采取的 rung。[实现](https://github.com/xai-org/grok-build/blob/dd04f397b1d02f2272b092555669dfba1f01bc85/crates/common/xai-grok-compaction/src/intra_compaction/fit.rs)
5. **hooks 能参与控制流。** `PreToolUse` 的显式 deny 会阻止工具；`Stop`/`SubagentStop` 会聚合继续工作原因。hook 自身出错是 fail-open，因此它适合工作流 Gate，不应被当作唯一安全边界。[文档](https://github.com/xai-org/grok-build/blob/dd04f397b1d02f2272b092555669dfba1f01bc85/crates/codegen/xai-grok-pager/docs/user-guide/10-hooks.md) · [实现](https://github.com/xai-org/grok-build/blob/dd04f397b1d02f2272b092555669dfba1f01bc85/crates/codegen/xai-grok-hooks/src/dispatcher.rs)
6. **LSP 是有生命周期的服务。** manager 按扩展名路由多个 server、以文档版本判定诊断是否过期、限制错误摘要数量，并把 server 进程纳入 session process scope 回收。[实现](https://github.com/xai-org/grok-build/blob/dd04f397b1d02f2272b092555669dfba1f01bc85/crates/codegen/xai-grok-tools/src/implementations/lsp/manager.rs)
7. **扩展有明确的分发与信任模型。** plugin 可包含 skills/commands/agents/hooks/MCP/LSP；安装、启用和允许代码执行不是同一个状态；marketplace 可要求固定完整 SHA。[Plugins](https://github.com/xai-org/grok-build/blob/dd04f397b1d02f2272b092555669dfba1f01bc85/crates/codegen/xai-grok-pager/docs/user-guide/09-plugins.md)
8. **后台任务有统一调度语义。** 后台 command 与 subagent 共用查询/等待/终止界面，另有 monitor、循环任务和 scheduler；后台 registry 是 per-session 且有并发上限。[文档](https://github.com/xai-org/grok-build/blob/dd04f397b1d02f2272b092555669dfba1f01bc85/crates/codegen/xai-grok-pager/docs/user-guide/20-background-tasks.md) · [实现](https://github.com/xai-org/grok-build/blob/dd04f397b1d02f2272b092555669dfba1f01bc85/crates/codegen/xai-grok-shell/src/terminal/background_task.rs)
9. **安全是权限判断与 OS 隔离两层。** permission 约束模型请求，sandbox 约束获批后的真实进程；Linux/macOS 使用内核机制，文档同时明确网络限制和平台缺口。[Permissions](https://github.com/xai-org/grok-build/blob/dd04f397b1d02f2272b092555669dfba1f01bc85/crates/codegen/xai-grok-pager/docs/user-guide/22-permissions-and-safety.md) · [Sandbox](https://github.com/xai-org/grok-build/blob/dd04f397b1d02f2272b092555669dfba1f01bc85/crates/codegen/xai-grok-pager/docs/user-guide/18-sandbox.md)
10. **观测数据有隐私 schema。** 外部 OTEL 默认关闭、需要双重 opt-in，默认不传 prompt、代码、路径、工具参数或命令，且定义封闭字段和导出前校验。[Monitoring](https://github.com/xai-org/grok-build/blob/dd04f397b1d02f2272b092555669dfba1f01bc85/crates/codegen/xai-grok-pager/docs/user-guide/24-monitoring-usage.md)

## 最值得 Picode 学习的内容

### P0：统一生命周期事件总线 + Completion Gate

这是最高价值项。Picode 已有 Harness Gate、红探针和 Evidence Ledger，但这些能力主要由显式命令触发；grok-build 把 `SessionStart`、提交提示、工具前后、工具失败、权限拒绝、停止、子代理开始/停止、压缩前后、SessionEnd 都统一成事件。

建议 Picode 增加内部 `HarnessEventBus`，先只服务内置 Rust/受信任适配器：

- `BeforeTool`：调用现有授权层，不允许 hook 扩权；
- `AfterTool`/`ToolFailed`：写入有界 evidence；
- `BeforeComplete`：运行声明的 Completion Gates；
- `BeforeCompact`/`AfterCompact`：保存/恢复任务关键状态；
- `SubagentStarted`/`SubagentFinished`：统一父子用量、候选结果和取消；
- `SessionEnd`：完成 checkpoint 和临时 secret 清理。

用户脚本 hook 可以之后作为第三级能力加入。必须保留 Picode 的原则：安全授权由底层 API 强制；hook 只能进一步拒绝，不能提高权限。对于 Completion Gate，不能只学“阻止 Stop”，还必须保留 Picode 的红探针和证据等级。

### P0：稳定的 headless/ACP 控制面

Picode 当前 GUI 与 Pi 通过自定义 broker/RPC 控制，已经能工作，但外部自动化、CI adapter、编辑器嵌入和未来手机遥控都会重复造协议。ACP 适合作为标准会话层：session create/load/list、prompt、流式 text/thought/tool/plan、权限、取消；Picode 特有能力再放在 `picode/*` 扩展方法。

实施时应把 ACP 做成现有 Pi/Picode Runtime 的适配器，而不是换掉 Pi。这样 GUI、headless、CI、手机端都使用同一个 session/control contract，也能消除 broker 心跳、重连和端口所有权上多套状态机。

### P1：会话事件日志、Git checkpoint 与可恢复 rewind

Picode 已有数据库、聊天副本、任务图和 checkpoint，但还缺一个明确的、追加式、可重放的 session 事件源。建议采用：

- SQLite 保存索引、关系和查询；
- append-only 事件表/分块 artifact 保存完整更新；
- Git 管理的 Harness Task 以 commit/tree/index 状态形成 rewind point；
- 非 Git Simple Task 只做聊天 rewind，不隐式恢复项目文件；
- 每次 rewind 都预览影响并二次确认，不覆盖用户未纳入 checkpoint 的修改。

这比照搬 grok-build 的全文件快照更符合用户已确定的“开发工程必须严格使用本地 Git”原则，也可避免大型游戏工程快照膨胀。

### P1：统一后台工作协议

将 command、subagent、monitor、scheduled check 都映射到同一 `WorkHandle`：owner task/session、PID/process tree、状态、开始/结束时间、bounded output、resource attribution、wait/cancel/kill、重启恢复策略、唤醒原因。Picode 已有大部分底层字段，主要差在统一 API 和 GUI 操作。

应特别学习 grok-build 最近强化的“真实终止”：不能因为发送 kill 就显示成功，必须确认进程树退出；Windows 用 Job Object 收拢整个进程树，Linux/macOS 用 process group/session。Picode 的 CPU/内存/stall 监测继续保留，这是我们的优势。

### P1：把 pi-subagents 与 Picode GUI 真正合并

不再重复实现编排器。继续使用 `pi-subagents` 的 chain/parallel/fork/resume/acceptance/worktree，Picode 增加：

- Agent/persona、候选模型、effort 和 capability mode 的 GUI 配置；
- 子代理完整 transcript、当前活动、token/cost/CPU/RAM；
- resume/steer/interrupt/stop 的图形入口；
- 子代理 worktree、patch、主 Agent 审核和 Picode Gate evidence 的同屏关系；
- 父任务取消时，对相关子代理和进程执行可验证的级联取消。

grok-build 默认只允许一层子代理，这一点与 Picode 的默认策略一致，应保留；pi-subagents 的嵌套能力只能在用户明确配置预算与深度时开放。

### P2：长上下文的分层压缩

引入与 grok-build 同类的确定性步骤，而不是只依赖模型总结：先保留近端回合，再裁剪超大工具输出，再选择需要总结的旧回合，最后才调用总结模型；记录压缩前后 token、被裁剪 artifact 的引用和摘要来源。工具原始全文留在 artifact store，默认不再回灌模型。

长期记忆保持第三级、默认关闭。项目事实、用户偏好、session 摘要分开存储；写入必须可审阅，检索结果带来源和时间衰减。不要让“自动记忆”污染 Harness 事实或 Gate 证据。

### P2：持久、版本感知且有界的 LSP

Picode 的 one-shot/lazy LSP 应升级为每 workspace/language 的懒启动服务：

- 按文件类型与 workspace 路由；
- 文档版本与诊断版本绑定，拒绝过期诊断；
- 编辑后等待有界时间，超时明确标未知；
- 错误优先、每文件/每次结果有上限；
- server 崩溃可重启，task/session 结束必须回收进程树；
- Simple Task 不自动启动，Harness Task 也只在使用代码能力时启动。

### P2：扩展状态拆成“发现、启用、信任、运行”

Picode 的三层能力模型继续作为主轴，再学习 grok-build 的可审计包模型：

1. `Discovered`：只读 manifest，可在设置中看到；
2. `Enabled`：模型可以搜索/用户可以调用，但没有进程常驻；
3. `Trusted`：允许 hooks/MCP/LSP/native code 启动；
4. `Running`：当前 task/session 有实际进程和资源归属。

专业扩展详情应显示来源、版本/commit、组件清单、权限、task scope、进程、数据目录和最后错误。远程插件应支持 commit SHA 锁定；“启用”不能自动代表信任所有可执行组件。

### P3：隐私优先的统一观测 schema

Picode Runtime Monitor 继续面向本机个人开发者；同时把 session/turn/tool/subagent/gate/compaction/model-switch 等事件定义成封闭 schema。默认不含 prompt、代码、绝对路径、命令和 secret；若未来接 OTEL，使用独立双重 opt-in。这样既支持本机性能诊断，也给未来 CI/回归 harness 一套可比较的数据。

## 不应照搬的部分

1. **不要替换 Pi 内核。** grok-build 的 agent runtime、TUI、session 和工具高度一体化，整体移植会破坏 Picode 的轻量目标，并重复已有 Pi/pi-subagents 能力。
2. **不要把所有能力放进 Resident Core。** plugins、MCP、LSP、memory、browser、DAP、firstmate、供应链扫描仍遵守 Picode 的二/三级加载规则。
3. **不要照搬 TUI/Dashboard UI。** 学它的状态模型与交互语义，使用 Picode 原生 GUI 重新呈现。
4. **不要把 fail-open hook 当安全边界。** Picode 的底层授权、workspace 边界、secret reference 和破坏性操作限制必须保持强制；hook 只做工作流控制和额外拒绝。
5. **不要照搬 Linux/macOS sandbox 代码解决 Windows。** grok-build 的核心隔离依赖 Landlock/bwrap/Seatbelt；Picode 需要 Windows Job Object、受限 token/AppContainer/ACL 等单独设计，并为跨平台实现分别做可红测试。
6. **不要默认启用长期记忆、远程 telemetry 或调度器。** 这些都属于用户明确开启的第三级能力；本地 checkpoint 不等于长期个性记忆。
7. **不要复制 grok-build 已从 Codex/OpenCode 移植的代码而忽略来源链。** grok-build 第一方为 Apache-2.0，但仓库也包含保留原许可证的第三方移植。若未来引用实现，必须按具体文件检查 `THIRD-PARTY-NOTICES`，记录原始项目、许可证和改动。

## 建议的执行顺序

| 顺序 | 项目 | 预期收益 | 常驻成本 |
|---|---|---|---|
| 1 | `HarnessEventBus` + `BeforeComplete` Gate | 把现有 Gate/证据接入每次真实任务完成 | 很低 |
| 2 | ACP/headless adapter | 打通 GUI、CI、编辑器和未来手机端 | 低；仅使用时启动 |
| 3 | 统一 `WorkHandle` + 可验证进程树终止 | 修复后台任务、子代理、服务监看碎片化 | 低 |
| 4 | pi-subagents GUI/Fleet/模型/证据整合 | 让已安装能力真正可控可见 | 按需 |
| 5 | 事件源 session + Git rewind | 长任务恢复与安全回退 | 磁盘按任务增长，可限额 |
| 6 | token 预算压缩 + artifact 引用 | 大型工程长对话稳定性 | 低/按压缩触发 |
| 7 | 持久 lazy LSP | 减少错误编辑与无效测试循环 | 按语言/工作区启动 |
| 8 | 扩展四态与 SHA/信任审计 | 专业扩展可用且不破坏轻量边界 | manifest 常驻，进程按需 |
| 9 | 观测 schema/可选 OTEL | 回归、成本、质量与性能可比较 | 本地有界；外部默认关闭 |

## 最终判断

如果按“能否独立完成中型软件/游戏项目中开发者负责的本地闭环”衡量，Picode 已达到可用基线，但 grok-build 在长期任务工程化成熟度上仍领先一档。差距的核心不是再加几个工具，而是把已有工具纳入同一套 session、事件、权限、进程、上下文、证据和恢复协议。

最优路线是借鉴 grok-build 的控制面设计，而不是复制它的产品：Picode 继续做轻量、多账号、多模型、Windows-first 的 Pi GUI；用统一生命周期、ACP、可恢复 session、后台工作协议和 lazy LSP，把现有 P0-P4 能力真正收成一个完整 Harness。
