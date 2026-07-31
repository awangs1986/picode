# Picode 开发 Harness 评估（2026-07-31）

## 结论先行

Picode 已经具备一个可运行的 Pi 桌面 Agent 和可复现的 P0–P4 工程闭环。当前 Gate 证明仓库级检查通过；项目自己的 Gate 仍必须声明红探针，才能获得 Harness verified，而不是仅凭本机命令退出码。

- **Simple Task**：基础对话、文件/进程操作、账户和工作区安全、聊天迁移等能力已达到可用基线。
- **Harness Task**：任务种类、模板、工作区绑定、Gate 执行、结构化结果、红探针、证据和子代理接口已有运行路径；CI 权威回传和项目专属引擎/Issue 连接仍属于外部集成边界。
- **专业扩展**：扩展主机、MCP、真实 DAP adapter 进程、项目适配器、诊断、advisory 和回归记录已有隔离运行路径；引擎内容验证、供应链扫描属于 P5/项目适配器。
- **能力分层**：三层能力已经有 Rust 持久化注册表、设置面板和命令；`eval`/`browser` 不再因创建 Harness 任务自动加载，只有被 Agent 搜索后才激活。
- **来源阶梯**：ADR 和通用 CSR 已存在，近期 Pi/OMP/pi-subagents 工作也有来源记录；但没有自动或强制的“每个能力先查 Pi，再查 OMP，再查 Claude/OpenCode，最后才自研”的实现门禁，因此目前是**部分执行**，不是已证明完全执行。

## 从开发者角度的闭环核对

| 环节 | 当前判断 | 证据/缺口 |
|---|---|---|
| 明确目标、任务类型 | 已实现基线 | Simple/Harness 分流和继续/接管语义已有 schema 与测试 |
| 工作区与 Git | 基本可用 | 绑定、路径迁移、safe write/worktree 有实现；还缺统一交付包中的变更快照 |
| 代码搜索、读取、编辑、Shell | 已实现基线 | 核心工具和持久任务接口存在；PTY 仍是已知差距 |
| 计划、Todo、后台任务监看 | 已实现基线/部分 UI | 任务运行和资源快照有基础；模块级预算展示仍需补强 |
| Harness 发现与确认 | 部分实现 | `harness_service` 主要扫描 `package.json`，确认后生成 shell 动作，缺少类型化参数/平台变体/依赖图 |
| Gate 设计与执行 | 已补齐契约 | 能运行动作、记录退出码和加密证据；现在支持结构化结果和显式 `harness_validate_gate` 红探针，未声明探针会明确标为未验证 |
| 测试结果解析 | 已有通用契约 | `StructuredTestResult` 支持 JSON 行和退出码回退；具体 Vitest/Cargo/引擎格式仍由项目适配器提供 |
| CI 权威回传 | 缺失 | 当前 gate 是本机验证；没有 CI trigger/status/artifact adapter |
| 开发者交付 | 部分实现 | ledger/checkpoint 存在；没有固定的 Handoff Package schema 和导出路径 |
| 调试 | 已有隔离运行路径 | 当前控制面通过 `ExtensionService`/后台 Job 启动真实 DAP adapter 进程并记录有界事件；旧 `extension_host` 数据模型仍保留作兼容测试，不是主运行路径 |
| Unity/Unreal/Godot 内容管线 | 未实现 | `ProjectAdapter` 目前是 markers/action ids 注册表，没有实际 GUID/引用/导入/Cook/runtime 验证 |
| 安全与供应链 | 核心边界有，扫描模块无 | secrets 只存引用、权限和 redaction 有；secret/dependency/license/SBOM/SAST 扫描尚未接入 |
| 平台矩阵 | 部分模型 | profile 可表达目标，但没有独立 OS/arch/device gate 的运行编排 |
| 子代理 | 已有可用基线 | `pi-subagents` 已接入 Harness；Picode 的候选模型策略、证据和 GUI Fleet 仍需统一 |

## 三层能力模型的实态

| 层级 | 目标 | 当前状态 |
|---|---|---|
| Resident Core | 轻量控制面和最基础的 Pi 工具 | 大体符合；仍需持续检查 startup/idle 预算 |
| Discoverable Lazy Capability | 用户已启用、可搜索，选中才加载 | Pi extension/MCP/LSP 的目录和搜索已有基础，但运行时激活条件仍有硬编码路径 |
| Disabled User Module | 设置中关闭、Agent 不可搜索、零进程 | 已补齐核心契约。`CapabilityTier` 和 `module_tiers` 已持久化；firstmate 以 Disabled manifest 注册，禁用时搜索/加载都会拒绝；Professional Extensions 面板消费 `capability_set_tier` |

特别需要修正的是 `setCapabilitySearchActive()`：Harness 任务当前会直接把 `eval`、`browser`、后台/子代理相关工具加入活动集合。它不应把“选择 Harness”解释为“启用所有专业模块”。

## Gate 的诚实状态

当前 P0–P4 gate 文档和 JSON 证明了本分支的测试命令可以通过；新增的 Gate Validity API 使项目 Gate 可以单独证明可控红路径。应把“绿”拆成：

1. 命令在当前候选上成功；
2. Gate 定义、输入、环境和 artifact 可复现；
3. 受控坏 fixture、mutation、断言或依赖故障能让同一 Gate 明确失败；
4. CI 在固定环境再次执行并成为权威结果。

在第 3 项缺失时，只能标记 `implemented with incomplete Harness verification`，不能标记 Harness verified；当前默认自动发现的 profile 没有红探针，因此仍会得到这个诚实标签，项目需要在 Harness Profile 中声明 probe 后才能升级。

## 来源阶梯执行审计

目前有 `docs/adr/0023-follow-a-capability-source-ladder.md`、`docs/capability-source-reviews/P0-P4-2026-07-30.md` 和 issue 模板要求，说明**规则已经写下**。但检查实现流程后发现：

- 没有脚本或 issue 状态门禁强制 CSR 在实现前完成；
- P0–P4 文档是一次总览，不等同于每个新能力的 Pi/OMP/比较项目逐项检索；
- `pi-subagents` 的引入有单独研究记录，符合“先找 Pi 插件”的原则；
- `firstmate` 已完成本次单独评估，但它不是 Pi 插件，故只能作为第三层外部编排组件候选；
- 未来 CI、引擎内容和供应链模块必须先生成 per-capability CSR，若前三层都不合适才允许自研；Gate Validity 和 DAP 的本地运行契约已补齐。

因此本项结论是：**策略已在实现规范和当前新增能力上执行，但旧历史提交没有机器化追溯；后续能力必须按 per-capability CSR 门禁推进**。

## 重新定位 P0–P5

现有 backlog 可以保留为历史执行记录。P0–P4 的仓库级闭环已完成；下一轮优先级应是：

1. P0/P1：继续把红探针接入项目 Harness Profile，并让 Settings/UI 消费三层能力命令；
2. P2/P3：把 Pi-native 子代理、模型策略、资源监控和 Git worktree 证据统一进 GUI；
3. P4：继续扩展 DAP adapter、平台矩阵和 adapter process contract；
4. P5：firstmate 第三层适配器、游戏内容管线、安全/供应链扫描、Issue/CI 外部连接、交叉 Gate 验证。

## 不属于当前产品边界

Picode 不承诺替代完整 IDE/游戏引擎，不把 CI 服务器或主代码审核者塞进本地核心，不默认建立云端 Agent 池，不做科研/通用写作/艺术生产。Simple Task 仍可用于个人小作品；Harness Task 才启用可选的工程模板和验证闭环。
