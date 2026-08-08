# ADR-0007: 以随包 Skills 工作流取代独立 Plan/Goal 插件

- 状态：Accepted
- 日期：2026-08-07

## 背景

原方案把第三方 Plan Mode 和 Goal 插件作为 Standard/TDD 套件的一部分。这会在 Pi 原生 Agent Loop 之外再引入一套规划状态和自动推进语义，与 Picode 的用户显式继续、Slice/Capsule 和 TDD Gate 形成重复权威。

Pi 核心本身保持最小，计划能力应由 Skills 或扩展提供，而不是被误认为原生能力。

## 决策

1. 从 Picode 依赖、套件登记和默认加载路径中移除 `pi-plan-mode` 与 `pi-goal`。
2. 将 `mattpocock/skills` 作为随 Picode 分发的固定快照：manifest 固定来源、Commit、许可证、文件数和 bundle digest；启动时不整体加载，避免增加上下文和常驻开销。
3. 保留 Picode 自有 `/plan` 兼容命令，作为用户入口而不是新的 Plan Runtime：
   - 第一次显式执行 `/plan` 时，按需物化 `grill-with-docs`、`grilling`、`domain-modeling` 依赖闭包到 Picode 私有 Pi skill root；
   - 物化使用 staging + 原子 rename，不覆盖已有用户技能目录；完成后重载当前 Pi 会话并自动提交规划请求；
   - 不联网、不执行外部安装命令、不在首次启动向导中询问 mattpocock，也不自动续跑任务；
   - 其它随包 Skills 使用相同的按需物化接口，用户必须显式使用对应指令才会进入当前 Pi 的发现路径。
4. `Task Objective`、验收条件、Next Steps 和 Task Capsule 继续作为任务事实保留，但不构成 Goal Mode。
5. TDD 的推进权只属于 Devloop/verify：记录 RED、运行 Gate、Review、集成验证和 Completion Label；`/plan` 不能签发完成，也不能绕过用户的“继续”指令。
6. 历史会话中出现的 `/plan`、`/goal` 只作为历史文本导入，不重新激活已移除的插件。

## 后果

- Standard/TDD 不再增加两套插件 schema、命令和生命周期状态，减少上下文与维护成本。
- 计划体验依赖用户选择的 Skills 内容，但权限、TDD、Slice 和完成语义仍由 Picode 确定性模块负责。
- 规划工作流无需额外网络安装；只有用户显式执行 `/plan` 或其它已随包技能指令时，对应固定快照才进入私有 Pi skill root。
- 固定快照损坏或物化失败会报告可定位错误，不静默退回外部安装，也不伪装成已加载。
- 旧配置可能包含已移除的包名；启动时应将其视为停用历史配置，而不是静默加载。
