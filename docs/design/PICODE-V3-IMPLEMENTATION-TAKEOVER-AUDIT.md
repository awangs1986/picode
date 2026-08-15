# Picode V3 实现接手与代码复用审计

> 日期：2026-08-07  
> 性质：实现盘点与迁移建议，不高于 `PICODE-V3-DESIGN.md`、ADR、
> `docs/design/MODULES.md` 与 `CONTEXT.md`。  
> 审计对象：当前 TypeScript V3 骨架
> `C:/Users/awang/Documents/Codex/2026-07-28/za/work/picode-v3`，以及旧
> Rust/Tauri 实现 `D:/otherproject/picode/v4`。

> **状态更新（2026-08-07 13:10）**：本报告第 2 节是接手时快照，不能继续当作
> 当前完成度。Vendored Pi 0.84.0、真实 Adapter、Active Tool Adapter、供应商
> 套件、HTTP steer、TDD/Slice/Import 和安装产物 smoke 已在后续工作中接通。
> 当前事实以 `docs/verification/P0-P4-ACCEPTANCE.md` 和测试输出为准。

## 1. 结论先行

1. **V3 TypeScript 代码应成为新实现主线。** 它已经按 Store / Engine /
   Guard / Devloop 划出 Module，模块依赖 Gate 可运行，远比继续加厚旧 Rust
   Core 更符合当前 Extension-first 设计。
2. **现有 V3 代码不是废稿。** 45 个源码文件、约 3,773 行源码；42 个测试
   文件、约 3,695 行测试。2026-08-07 执行 `npm run check`：TypeScript、
   Module 边界与 **290 项测试全部通过**。
3. **“测试全绿”只证明纯逻辑骨架，不证明产品闭环。** vendored Pi 尚未 pin，
   Active Tool Adapter 仍为 Noop，扩展套件没有真实装载，HTTP steer 只发布
   内部事件；所以当前不能启动完整 Picode 工作流。
4. **旧 V2 不整体迁移。** Rust/Tauri Core、Broker、重复 Runtime owner 与 GUI
   壳不进入 V3 主线；账号/聊天解析、损坏恢复、协议防御和相关测试夹具应按新
   Interface 移植。
5. **先证 Bridge，再做生产接线。** 新设计已经把 compaction、rewind/fork、
   TUI 终端所有权和 Tool Intent 延迟列为首要可行性 Gate。公开 Pi 扩展接口
   能闭合则保持零 Patch；不能闭合时只为确定的 Seam 做最小 Patch。

## 2. 当前 V3 的真实完成度

下面的百分比是“可在新架构中保留的实现价值”工程估计，不是功能完成率或测试
覆盖率。

| Module / Surface | 已有实现 | 复用判断 | 主要缺口 |
|---|---|---:|---|
| Shared | Result、事件总线、路径、语义 ID、文件锁、原子写、跨 Module 类型 | 70% | Capsule 类型已落后于契约；文件状态恢复弱于 V2；锁的 stale 判定需跨平台实测 |
| Store | config、账号 OAuth Seam、ImportCompiler、Claude/Codex 简化 Adapter、兼容报告 | 50% | `accounts.json` 有两个不兼容权威；真实来源解析不足；无 Cursor；无 known-good/quarantine |
| Guard | policy 纯函数、fingerprint、Grant、能力目录、沙箱政策编译、MCP 仲裁模型 | 70% | 尚未接 landstrip/MCP 真实事件；Capability 状态模型待统一；裁决 Evidence 未接线 |
| Engine | Execution Epoch、激活路径、Lease、Subagent RPC 契约、Worktree 注册表 | 40% | Active Tool Adapter 为 Noop；无真实 Pi、landstrip、pi-subagents 生命周期接线 |
| Devloop | Slice、Capsule、TDD 状态机、Gate/Flaky、Evidence、Completion Label、Foreign Resume | 60% | Capsule v1 契约过期；Slice 只有软提醒；预算部分未完整参与状态机；缺真实生命周期驱动 |
| Adapter Extension | 组合根、档位、suite 表、search_tools、onboarding、缓存指标、命令表 | 35% | 套件只登记 manifest；未向 Pi 注册；档位与目录过滤未闭合；首次推荐 manifest 未在生产组合根注册 |
| HTTP+SSE 调试面 | loopback、token、实例锁、health、SSE、命令白名单 | 45% | session 只扫单层目录；消息 POST 未 steer Pi；没有真实 Tool/Task/Approval 自动化闭环 |

### 2.1 可原样保留的深实现

- Module 目录和依赖方向检查；
- `Result`、事件信封与 EventBus；
- Guard 的纯裁决、fingerprint 与 Grant 基础逻辑；
- ImportCompiler 的“历史工具签名 → 稳定语义 ID”权威位置；
- ActivationManager 的 proxy / registered / resident 路径决策；
- Gate 绑定 Candidate Snapshot、Imported Evidence 不算当前 Gate 的原则；
- 缓存 telemetry unavailable 与六项归因信号；
- HTTP loopback + token + SSE + 命令白名单的调试面形状。

这些实现的 Interface 与当前设计一致，后续应增量修订，不应重写。

### 2.2 可保留结构、但必须先修契约的实现

1. **账号单一权威**  
   `Store.listAccounts/saveAccounts()` 把 `accounts.json` 当成 `AccountRef[]`；
   `AccountsManager` 又把同一文件当成 `{version, accounts: StoredAccount[]}`。
   两套测试使用隔离目录，因此全绿但无法互操作。应让 Store 内部只有一个
   Account Vault 深模块；所有无秘密列表都是该 Vault 的投影。
2. **Capsule v1 同步**  
   代码缺 `schemaVersion`、sealed `digest`、SourceRef `sourceDigest`；
   `workspaceSnapshot` 只比较 HEAD；字段仍是 `supersededBy`，与文档当前
   `supersedes` 不一致。`DevloopPort.canInjectCapsule()` 还把当前 taskId 取自
   Capsule 本身，导致跨任务检查在该 Interface 上无法真正变红。
3. **Slice 强制边界**  
   当前只有 `advise: boolean` 与单一软阈值。需保留现有纯函数，再增加软提醒、
   硬切片、用户一次显式推迟和 Evidence。
4. **Capability 目录与档位**  
   组合根把全部 suite manifest 一次性标为 trusted，搜索本体不感知当前
   Harness Tier；如果 `search_tools` 暴露给 Simple，可能看到并激活本档不该
   出现的能力。需要由组合根提供当前档位可见集合，不能只靠 suite 表测试。
5. **首次引导登记**  
   onboarding 只登记 Herdr 和 CodebaseMemoryProvider 两个运行时组件；
   mattpocock/skills 改为随包固定快照，由显式 `/plan` 按需物化，不进入首次引导。
   生产 `createRuntime()` 必须确保这两个 manifest 与持久化设置一致，且回答 Y 的错误可见。
6. **文件状态纪律**  
   当前是 temp + rename 与 30 秒 stale lock。旧 V2 已实现 fsync、known-good、
   quarantine、schema 校验和损坏降级。应把这些行为移植成 Store 内一个
   `StateFile<T>` 深模块；不要为每种 JSON 文件复制恢复逻辑。

### 2.3 目前只是契约或占位、不能计为已完成功能

- vendored Pi 包与版本锁；
- Picode Adapter Extension 的真实 Pi 入口；
- Active Tool Adapter 注册/停用；
- pi-landstrip、pi-mcp-adapter、pi-subagents、pi-cache-optimizer、pi-lens 的真实加载；
- Picode `/plan` 对随包 mattpocock/skills 的按需物化、会话重载和规划委托；
- Pi usage → CacheMeter；
- Pi compaction / rewind / fork / resume 事件；
- `/v1/sessions/:id/messages` → Pi steer；
- TUI 状态部件；
- 真实 OAuth Provider 流；
- 三来源完整聊天迁移、选择预览、归档/推理/工作区绑定；
- 跨平台发布与真实性能 Gate。

## 3. 旧 V2 的复用分类

### A. 行为与测试夹具优先移植（高价值）

| 旧实现 | 已积累能力 | V3 落点 | 复用方式 |
|---|---|---|---|
| `state_store.rs` | fsync、原子替换、known-good、quarantine、schema/类型失败降级 | Store `StateFile<T>` | 移植行为与红灯测试；用 TS 重写，不引入 Rust Host |
| `account_import.rs` | Codex 官方 OAuth/反代、Base URL、Cursor SDK Key/OAuth 备份限制、Claude JSON、多账号激活规则 | Store 外的 Account Source Adapter + Account Vault | 端口解析规则和 fixture；凭据形状重新映射到单一 Vault schema |
| `chat_migration.rs` | 边缘预览、标题/最后消息、内部会话过滤、去重、归档、reasoning、Cursor SQLite 索引查询、Windows 路径归一化、分页、删除回滚 | 来源 Adapter + Import Contract + Store ImportCompiler | 端口解析与性能策略；保留测试语料，不复制旧 Pi Session 写入路径 |
| `protocol_envelope.rs` | 大帧、坏 UTF-8、坏 JSON、重复终止事件、cancel fence、畸形日志 | Adapter Extension 的 Pi 事件入口 | 移植 Admission/Envelope 测试；按 Pi 实际事件 schema 定型 |
| `runtime_watch.rs` | known wait、stall、unresponsive、restart budget | Engine Work 监督 | 可直接翻译成小型纯函数，并由真实生命周期事件驱动 |
| `compatibility_registry.rs` | 旧环境变量、路径、事件名和 Runtime 残留的删除条件 | 迁移登记文档/测试 | 保留清单思想；不要把旧标识重新做成运行时权威 |

`chat_migration.rs` 是旧实现中价值最高的资产之一：约 3,400 行，已经覆盖
“工具日志遮住聊天、空 Cursor 会话、斜杠 Windows 路径被拆分、内部审批会话、
重复源会话、只读文件边缘避免超时、reasoning 折叠、删除越界”等真实故障。
V3 当前的两个简化 JSONL Adapter 不能替代这些经验。

### B. 可选择性复用的 TypeScript 工具

旧 `extensions/` 下的 session-search、shell/eval/browser runtime、project-trust
及其测试可以作为二/三级能力候选。但必须先逐个经过当前能力来源阶梯与
Capability Manifest，不得因为代码已经存在就重新塞进基础工具面。

### C. 仅作行为参考，不进入 V3 主线

- Rust `PiManager`、Broker WS、RuntimeCoordinator、WorkManager、
  SessionKernel、ExtensionManager；
- Tauri 命令层与当前 Web GUI；
- `embedded-server.ts` 六千行单体服务器；
- 旧 `super-agent/tasks.json` 双 Task 权威；
- Picot/Pi Studio 遗留 app id、环境变量和事件命名；
- `native_pi_manager` 等平行 Runtime owner。

这些代码证明过产品行为，但直接复用会把 V2 的双语言、双 Runtime 与重复生命周期
重新带回 V3。GUI 阶段可复用交互规则、XML 文案和前端测试，不复用旧 Core 拓扑。

## 4. 接手后建议的实施顺序

### P0-A：保存资产与建立可红基线

1. 为 V3 选定 Git 主仓库/工作树；当前设计目录和 `work/picode-v3` 都不在
   Git 中，不能在无版本管理状态下继续大改。
2. 把现有 290 项测试作为迁移基线；新增一个跨 `Store` +
   `AccountsManager` 的失败测试，固定重复权威问题。
3. 把 V2 的高价值测试语料按来源复制到独立 fixture 目录；先固定输入输出，
   暂不搬实现。

### P0-B：Bridge 可行性 Gate

按 `PICODE-V3-DESIGN.md §4.1` 依次证明 compaction、rewind/fork、TUI 终端
所有权、Tool Intent 延迟；同时完成真实扩展入口、工具注册/停用和 usage 事件
Spike。结论必须写回 Adapter Interface 与兼容矩阵。

### P0-C：收敛已有代码的单一权威

1. 合并 Account Vault；
2. 同步 Capsule v1 与 Slice 硬边界；
3. 收敛 Capability 设置/信任模型、Tier 可见性和 onboarding；
4. 用 V2 行为加深 `StateFile<T>`；
5. 将 Suite manifest 与“实际已安装/可加载”分开，禁止目录虚报能力。

### P1：只接通一条真实纵向链路

`picode` 启动 pin 版 Pi → Adapter Extension 加载 → Simple 原生提示词 →
真实账号/模型 → 原生工具 → Guard 观察 → JSONL 会话 → Cache telemetry。
这不是 Mini 产品，而是完整路线中的第一条生产 Seam；它通过后再并行接入二档
扩展和导入。

### P2/P3：优先搬 V2 已证明的行为

- P2：landstrip、MCP、pi-subagents、Slice/Capsule、Worktree、HTTP 自动化；
- P3：先 TDD 三档，再 ImportCompiler，最后逐来源迁移 Claude/Codex/Cursor
  Adapter；每个来源独立 Gate，不做“大一统解析器”。

## 5. 当前必须保留的 Gate

1. `npm run check`：类型、Module 边界、单元/契约测试；
2. Bridge Conformance：每种副作用入口至少有一个可红样例；
3. Account Vault 跨 Interface round-trip；
4. Capsule 未知 major、digest 漂移、task/revision/snapshot/sourceDigest 不符均红；
5. Simple 档看不到或启动不了 Standard/TDD 能力；
6. Disabled 能力零进程、零端口、零网络、模型不可见；
7. Source Adapter fixture：标题、最后消息、归档、reasoning、去重、工作区路径、
   大文件边缘扫描；
8. HTTP 自动化必须真正驱动 Pi，而不是只发布内部事件后返回 202。

## 6. 已确认的三个设计颗粒

### 已确认补充：TUI 账号导入入口

账号导入采用 `/pico-import` → 本机临时 Web Wizard；默认自动打开系统
浏览器并在 TUI 打印链接回退。Wizard 复用 loopback HTTP 实现但使用独立
一次性认证和临时生命周期，不建设完整 GUI，不成为 Account Vault 之外的权威。
该决策已写入 V3 主设计 §3.1、P1 与 MODULES.md §1.1。

### D1. 新实现的 Git 落点

当前 TypeScript V3 骨架不在 Git；旧 `D:/otherproject/picode/v4` 是 Git 仓库但
有大量未提交的 V2 修改。推荐：**保留旧工作树不动，从该仓库建立独立的
`v3-rewrite` 分支和新 Git worktree，再迁入 V3 骨架与设计文档。** 不建议直接
覆盖旧 dirty tree，也不建议继续在无 Git 的 `work/picode-v3` 长期开发。

**裁决：已确认采用。** 当前只记录设计；待用户明确开始实施后再建立分支和
worktree，不在设计讨论阶段改动旧仓库。

### D2. Capability 设置与信任是否正交

采用 Enabled/Disabled 与 Trusted/Untrusted 两个持久化维度：禁用一个已
信任扩展时可保留信任记录，重新启用不等于重新授予工具权限；运行态仍独立为
Stopped/Running。数据结构建议 `{enabled: boolean, trustedDigest?: string}`。

**裁决：已确认采用。** V3 骨架现有三态实现属于待迁移代码，不再反向修改文档。

### D3. CodebaseMemoryProvider 的归类

推荐 Picode 内建稳定的 Provider Interface/Adapter（本身无需信任），实际
`codebase-memory-mcp` 进程视为 External Extension；首次引导回答 Y = 安装 +
启用 + 对当前固定版本/摘要做首次信任。这样功能入口稳定，第三方运行时仍可停用、
升级和重新信任，也不会把外部进程伪装成无信任流程的 Built-in Feature。

**裁决：已确认采用。**

## 7. 接手判定

**可以接手，而且应优先使用已写代码。** 当前最合理的资产策略是：

- 保留 V3 的 Module、Interface、纯逻辑和测试；
- 先修重复权威与过期契约；
- 用 Bridge Spike 决定唯一 Adapter Seam；
- 把 V2 真实故障经验转换为 V3 fixture/Gate，再移植最小实现；
- 不复活 Rust Core，不把旧 GUI/服务器单体拖回 TUI 第一阶段。

D1–D3 已确认并写回主设计。仓库迁移和 Capability 持久格式修改仍等待用户明确
进入实施阶段；本轮只做设计与源码复用审计。

## 8. 旧 V2 同事代码专项复核（04:31～06:23）

复核范围为旧 `D:/otherproject/picode/v4` 基线 `17f44a0` 之后、用户按创建时间与
会话记录归因的 P1-02～P1-05。部分文件在 08:25 左右又被修改，因此以下结论区分
“当前代码事实”和“能够归因到该时间窗的实现”，不把后续 P2～P4 问题归责于本窗。

| 项目 | 裁决 | V3 处理 |
|---|---|---|
| P1-02 Agent Inbox 收敛 | **不接收完成声明**。实现仍把 Task Control 注册设为 best-effort，失败后继续旧 `tasks.json` 和直接 prompt；migration tombstone 写入后，新旧任务可永久分叉 | 保留迁移 fixture/确定性 ID/备份思想；P2 重做为 Devloop `TaskIngress`，禁止 fallback 与双写 |
| P1-03 panic/锁毒化 | **有条件接收，复用价值高**。大量外部路径 `unwrap` 已移除，锁恢复方向正确；启动路径仍有旧债 | 将错误模型和红灯 fixture 翻译到 TS Shared/Store/Adapter，不迁 Rust owner |
| P1-04 Protocol Envelope | **只接收骨架**。Extension/Evidence 等枚举未接生产入口；cancel 后更大 seq 或无 seq 的结果仍可通过；Admission 晚于 Rust observer | P0 移 fixture/契约，P1 以 epoch+run/request 重写 Admission 并前置，P2 扩到 MCP/Extension/Subagent |
| P1-05 Fresh-checkout/Gate | **不接收为验收证据**。Cargo filter 零匹配仍返回 0；所谓 package smoke 只检查文本/版本且 runtime 缺失仍 passed | P0 重写 GateRunner；P4 分离 metadata contract 与固定摘要的真实安装产物 smoke |

专项验证结果：相关 Biome 与 `git diff --check` 通过；聚焦 JS 50 项、Envelope 24
项、Agent Inbox migration 2 项测试通过。但其中测试明确把 legacy fallback、
cancel 后部分结果继续接收写成预期，因此“测试绿”不能覆盖规格违背。当前整个旧
工作树的 `cargo clippy --all-targets -- -D warnings` 仍失败，主要错误位于本时间窗
之后的代码，只能用于说明旧树不是可直接接收的绿色基线。

这些债务已经写入 `PICODE-V3-DESIGN.md §5/§5.1`。执行时不得另开“修旧 V2 Core”
支线；只优先复用上述可保留行为与 fixture，并在 V3 Interface 上重新闭环。
