# ADR-0004: 沙箱采用 Guard 政策权威 + Sandbox Provider 接口

- 状态：Accepted（同日修订：默认 Provider 改为 pi-landstrip）
- 修订记录（2026-08-07，Q9 补充）：landstrip 收窄为**纯沙箱供应商**——`landstrip.maxSubagents: 0` 禁用其 task 工具与自带 agent；Subagent/委派供应商改为 **pi-subagents**（评估与兼容路径见 MODULES.md §3）。子进程沙箱覆盖 = 每个 pi 子进程自行加载 landstrip（环境级扩展发现），以 `subagent:acknowledge-extension` 协议验证加载事实
- 修订记录（2026-08-08，Windows shell）：`pi-landstrip@0.18.26` 的 POSIX Provider 在标准 AppContainer 下先因 launcher 环境缺失触发 error 203，补齐环境后 Git Bash 仍因 MSYS `BaseNamedObjects` 权限失败。Picode 因此通过公开 `provideLandstripShell()` 接口注册 Windows PowerShell Provider；Guard/landstrip 政策和 AppContainer 保持不变，Linux/macOS 继续使用上游 POSIX Provider。
- 修订记录（2026-08-08，授权去重）：真实会话证明 Guard 与 landstrip 的默认 agent permission 会对同一工具重复询问。Picode 将 landstrip agent permission 固定为 `allow`，由 Guard 单独负责事前 allow/ask/deny；landstrip 仍负责 OS 隔离与沙箱运行时升级。新增会话级 `/permissions readonly|auto|full`，其中 `full` 不越过破坏性与 Git 所有权确认。
- 修订记录（2026-08-08，Windows P0–P4 降级）：真实 Documents 工作区复测证明标准 AppContainer 会拒绝进入工作区或长期挂起，无法满足开发工具的正确性。Windows P0–P4 因此只保留 Guard 事前授权与 PowerShell Provider，明确显示“无 OS 沙箱”；Windows 强沙箱整体回到 P5。Linux/macOS 的 landstrip 强制不变。本条取代下文较早的 Windows AppContainer 基线描述。
- 日期：2026-08-07
- 决策人：作者
- 取代：R0 稿 §10.2 第 8 条"复用 Grok Build 沙盒实现"、R0 开放决策第 5 条（Grok Build 采用范围）；R0 开放决策第 3 条（Windows 沙箱选型）的 P0–P4 基线由"无"升级为 AppContainer 标准模式，"强沙箱"仍属 P5

## 背景

Q11 评估确认：安全防线的主体是 Guard 的 Operation Intent 政策层（三档权限、
Grant、approval_fingerprint、Worktree、Git 所有权、秘密禁区），OS 级沙箱是
纵深防御层。候选 Provider 两个：

- **pi-landstrip**（0.18.26，Apache-2.0，捆绑 landstrip 含 LGPL-2.1 组件）：
  Linux/macOS/Windows 三平台原生二进制（bubblewrap 系 / Seatbelt /
  AppContainer 标准模式）；提供正经 Plugin API（`prepareProcess()`、
  `registerShellProvider()`、生命周期事件）；其"Agent permission（事前
  派发）× Sandbox policy（事中隔离）"双层模型与 Guard/Provider 分层逐字
  吻合；附赠进程级 Subagent（另行评估，见需求 5）。要求 pi ≥ 0.82、
  Node ≥ 22.19。
- **pi-sandbox**（0.6.2，MIT）：仅 Linux/macOS，底层为 Anthropic
  experimental sandbox-runtime 的个人 fork，无程序化 API，需 vendor 拆包。

两者都明确"pi 进程内文件工具跑在 OS 沙箱外"，进程内拦截必须由 Guard 自
己承担——与本 ADR 分层一致。

## 决策

1. **政策权威唯一属于 Guard**。三档权限预设、Grant 记录、deny 清单、
   approval_fingerprint 均为 Picode 自有数据结构；政策词汇表用 Picode 自己
   的语言（路径范围 / 网络范围 / 秘密禁区），不采用任何 Provider 的配置
   形状。
2. **Sandbox Provider 窄接口**：声明能力 → 编译政策 → 包装命令 → 升级回调。
   Provider 只负责 bash/子进程的 OS 级隔离；read/write/edit 的进程内拦截
   属于 Guard 本体，不走 Provider。
3. **默认 Provider = pi-landstrip，经其 Plugin API 接入**（pin 版本，不
   vendor）：Guard 的 OS 政策编译后经 `prepareProcess()` 下发；事前工具
   授权统一走 Guard，landstrip agent permission 固定 allow，避免双重审批。
   运行时沙箱访问升级仍由 Provider 执行并受沙箱政策约束。pi-sandbox 降为
   参考实现 / 备胎。
4. **Windows P0–P4 = Guard + PowerShell Provider，无 OS 沙箱**：标准
   AppContainer 无法可靠进入普通开发工作区，不能用“安全”换取错误 cwd、
   构建器失效或任务挂起。产品必须显式显示降级状态；Windows 强沙箱及
   restricted-user/其他 Provider 的一致性验证统一属于 P5。
5. **能力证明 + 一致性测试套件**：Provider 声明可强制项，Guard 据此标注；
   金标场景套件（秘密硬阻断、工作区外读升级、denied 域断网等）定义合格
   Provider。替换方案 = 新 Provider 通过该套件。本次 pi-sandbox →
   landstrip 的设计期换件即为该 seam 的首个验证案例。
6. Spike 新增：验证 landstrip Plugin API 的政策下发与 Guard 拦截在 pi 扩展
   套件内的执行顺序；Windows AppContainer 下常用工具链（node/git/构建器）
   的兼容性抽样。

## 后果

- 策略层照抄原设计（约八成沙箱设计原样成立），OS 层零自研，三平台全覆盖；
  Grok Build 许可证审查工程消失。
- Windows P0–P4 维持 Intent/Guard 拦截并明确标注没有 OS 沙箱；不得把
  PowerShell Provider 或权限提示包装成 AppContainer 已启用。
- 供应链：pin + 一致性套件对冲；LGPL-2.1 捆绑组件需在发行版许可证合规
  Gate 中复查一次。
- Worker 可读 pi 认证凭据与继承环境变量；Subagent 场景需配合凭据裁剪，
  归 Guard 的秘密禁区条目管理。
- 替换成本被限定为"实现窄接口 + 跑绿套件"；代价是政策编译层要为每个
  Provider 写一次翻译。
