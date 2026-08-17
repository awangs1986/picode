# Picode V3 最终设计（Extension-first）

> 状态：设计基线候选 · 2026-08-07。R3 审核（五项契约修正 + 缓存两处校正 + 首次引导回归）已并入，待团队复核冻结。本文是 V3 的单一设计入口，取代 R2 作为入口稿。
> 已拍板决策见 ADR-0001～0005；模块细节见 `docs/design/MODULES.md`；
> 提示词体系、压缩技能、导入契约分别见三份专项文档（仍然有效）；下一步工具
> 完善见 `docs/design/TOOLING-READINESS-PLAN.md`。当前最高实施优先级是
> `docs/design/HEADLESS-FIRST-PLAN.md`。

---

## 1. 一句话架构

**Picode V3 = 自包含 pi 发行版：vendored + pin 的专属 pi（可带补丁，最后手段）+ 一组 pin 版本的扩展套件（生态现货 + Picode 自有扩展）+ 伴生 CLI + 独立导入工具。** 四个领域模块（Store / Engine / Guard / Devloop）作为 TS 库活在 pi 进程内，由 Adapter Extension 组合；文件是一切权威，索引只是缓存；`~/.picode/` 完全自包含，与系统 pi 互不相干；没有独立 Backend 进程，远程端与显式压缩模块都在 P5。

```text
picode 命令 = 启动自带的 pi（预装扩展套件，PI_CODING_AGENT_DIR=~/.picode/agent）
  ├─ pi TUI / Agent Loop / JSONL（pin 版本，补丁仅最后手段）
  └─ Picode 扩展套件
      ├─ 生态现货（pin）：pi-landstrip（纯沙箱，maxSubagents=0）、
      │   pi-mcp-adapter（MCP）、pi-subagents（委派/编排/watchdog）、
      │   pi-web-access（Simple 档默认工具）、
      │   pi-cache-optimizer（provider 兼容面，关闭提示词重写）、
      │   pi-lens（TDD 档 LSP/诊断，按 Readiness 暴露可用子能力）
      └─ picode 自有扩展（Adapter Extension，组合根）
          ├─ store / engine / guard / devloop（TS 库）
          ├─ 状态部件：缓存命中率
          ├─ 工具：search_tools（能力目录两阶段发现）
          ├─ 命令：/harness /pico-account /plan …
          └─ Control Interface（TUI 与无头 CLI 共用；HTTP 仅内部调试传输）
```

## 2. 决策索引

| 决策 | 结论 | 出处 |
|---|---|---|
| 语言 | TypeScript-first，进程内集成 pi | ADR-0001 |
| pi 本体 | vendored + pin 随 Picode 分发（V2 模式），与系统 pi 无关；源码补丁仅最后手段 | ADR-0003 修订 |
| 存储 | 文件权威（JSON/JSONL），索引可重建；`~/.picode/` 完全自包含（含专属 pi agent 目录与会话池） | ADR-0002 及修订 |
| 拓扑 | Extension-first，无独立 Backend；多 pi 进程并存，共享状态走文件锁+原子写 | ADR-0003 |
| 沙箱 | Guard 政策权威 + Sandbox Provider 窄接口；Linux/macOS 由 pi-landstrip 强制执行。Windows P0–P4 保留 Guard + PowerShell Provider 并明确标记无 OS 沙箱，强沙箱推迟到 P5，避免 AppContainer 破坏普通开发工作区。 | ADR-0004 及修订 |
| MCP | pi-mcp-adapter 全包；Guard 经仲裁事件接管权限；Trusted 门自持 | ADR-0005 |
| Subagent/编排 | **pi-subagents**：RPC v1、context fork/fresh、每写手 worktree、生命周期工件 v3、watchdog；子进程各自加载 landstrip 获得沙箱 | ADR-0004 修订、MODULES.md §3 |
| Harness 档位 | **挂在会话**，`/harness` 随时切换；Task 记录所处档位供审计 | Q1（2026-08-07） |
| Simple 档 | 接近原生 pi 体验：不加载沙箱/MCP/扩展工具，**唯一默认工具 = pi-web-access**；零污染不做逐字节严格验收 | Q2/Q12（2026-08-07） |
| AI Review | pi-subagents watchdog 收编：二档 = watchdog 普通配置；三档 = 强模型对抗审查 + scope 监控 + LSP；Completion Label 仍由 Devloop verify/ 签发 | Q13（2026-08-07） |
| 抗失真（P0–P4） | Slice/Capsule + **Picode Context Governor 请求前硬预算** + pi 原生 auto-compact 持久化 + watchdog scope-drift 监测 | Q11（2026-08-07）；019ff330 红证据（2026-08-12） |
| 缓存 | **全局策略（含 Simple 档）**，方案 v2 = Reasonix 结构/诊断 + pi-cache-optimizer 兼容面（关闭提示词重写）；归因信号集六项、缓存未复用/未缓存 Token 五类（含 unknown/provider-side）；auto-compact 也开新 Cache Epoch | Q5 + §3.3 v2（R3 校正） |
| `/plan` | Picode 自有兼容入口；首次使用时从随包固定快照按需物化 `grill-with-docs` 及其依赖，然后重载当前 Pi 会话并交给该工作流 | 不联网、不弹外部安装提示；不再加载 pi-plan-mode/pi-goal |
| LSP/诊断 | pi-lens 只在 TDD 档进入候选工具面，并按 Readiness 暴露可用子能力（待核 C#/GDScript）；Standard 使用 watchdog 内置 LSP 诊断兜底 | Q23（2026-08-07）+ 工具完善计划 |
| 三级工具发现 | 持久设置用两个正交事实 `enabled` 与 `trustedDigest`，运行轴另记 Activate/Running；二级 = 已启用且当前 manifest digest 已信任，可搜但未运行；`activate() → ActiveCapabilityLease` 深模块，激活路径由 Engine 确定性选择 | §3.4（R4 确认） |
| 工具就绪与 Git | Standard/TDD 增加一个结构化一级 `git` 工具；Engine 统一投影 `Ready/Degraded/NeedsSetup/Unavailable`，无效 Schema 不进入模型上下文；`/doctor tools` 统一诊断 | `docs/design/TOOLING-READINESS-PLAN.md` |
| 无头优先 | 先完善 `picode --help/run/rpc/session/task/gate/harness/permissions/account/tools/doctor` 与无密钥 Scripted Model fixture；公共 CLI 不依赖 TUI/Core/Debug HTTP；Git/Readiness 随 P3 接入同一协议 | `docs/design/HEADLESS-FIRST-PLAN.md` |
| 导入工具契约 | 权威流水线：来源 Adapter（解析）→ Import Contract（IR+签名）→ Store ImportCompiler（语义映射）→ Guard Catalog（live 解析）→ Devloop（渲染）→ Engine（追加）；Bridge Note 白名单事实；**不做同名 stub** | §3.5（R3 修正） |
| 首次引导 | 仅两项运行时推荐（Herdr、CodebaseMemoryProvider）逐项 Y/N、本地化介绍、跳过不重复打扰、设置可重开；mattpocock/skills 不进入首次引导 | §3.7 |
| Herdr / code-by-wire | Herdr 保留为可选多任务终端 Runtime；code-by-wire 不作替代，只进入未来桌面 cockpit 候选池，**不属于 P0–P5 开发计划**；若未来立项，只能走 Control Interface Adapter | `research/code-by-wire-vs-herdr-for-picode-2026-08-07.md` |
| 账号 | V2/cockpit-tools 模式：JSON+OAuth（0600）；同 Provider 多账号存储、单账号活跃；切换不动上下文，只记新 Execution Epoch；TUI `/pico-import` 打开本机临时 Web Wizard | Q4/Q14 + §3.1（2026-08-07） |
| 模块 | 四模块 Store/Engine/Guard/Devloop + 两条保留条款 | MODULES.md |
| TUI | 不自建；pi TUI + 扩展部件；鼠标/图片内联放弃 | ADR-0003 |
| 配置 | JSON（读取兼容 JSONC）；全局 `~/.picode/config.json` + 项目 `.picode/`；MCP 用生态标准 `.mcp.json` | ADR-0002 修订、ADR-0005 |
| 提示词 | Simple **零注入**；Standard 追加稳定 Lean 行为核；TDD 追加自包含 Developer-TDD 行为核。两者都保留 Pi Base Prompt；Task/Capsule/Gate 事实只走受控 Context Event，不写入静态行为核 | `prompts/README.md`（2026-08-07 最终接入）；PICODE-HARNESS-PROMPT-DESIGN.md 仅作历史设计参考 |
| Devloop 契约 | Capsule v1 外壳（schemaVersion/taskRevision/workspaceSnapshot/SourceRef/verificationRefs/digest + sealed/superseded 生命周期）+ 封存前来源摘要/逐字事实证明 + 强制分节模板、Slice 三通道输入与软/硬阈值确定性裁决、TDD 状态机 `spec→red→green→refactor→gate→done` + 预算、Evidence 双层格式 | MODULES.md §3（Q15–Q18 + R3） |
| 显式压缩/纠偏 | 用户命令 `/pi-compress`、`/pi-correct` 仍推迟到 P5；防止 Provider 超限的 Context Governor 属于 P0 运行时安全，不可关闭 | Q3（2026-08-07）、019ff330 红证据（2026-08-12）、PICODE-COMPRESS-SKILL-DESIGN.md |
| 开发方式 | 不做迭代式 MVP：设计完毕 → 一次搭齐基础架构 → 作者自行完成实现 | Q7（2026-08-07） |
| 导入 | Import Contract（manifest + 会话 IR + 工具痕迹五级判定）；转换器住核心外 | PICODE-FOREIGN-TOOL-CONTRACT-COMPATIBILITY.md |
| 安全细节 | 会话级 `/permissions readonly|auto|full`、Guard 唯一事前授权、approval_fingerprint（成分/重算点/Grant 分级）、Git 所有权、秘密禁区；landstrip 只承接 OS 沙箱，不重复询问 | MODULES.md §2 |
| Worktree | R0 §13.2/13.3 原样沿用；pi-subagents 的 worktree 生命周期为 Subagent 隔离实现；沙箱与 Worktree 叠加 | Q8（2026-08-07） |
| 仓库 | 单包 + 目录边界 + 边界检查脚本 | Q9（2026-08-07） |
| V3 Git 落点 | 保留旧 V2 dirty worktree 不动；实施获授权后，从旧仓库建立独立 `v3-rewrite` 分支和新 Git worktree，再迁入 V3 资产 | 2026-08-07 接手确认 |
| V2 P1-02～P1-05 复用审计 | 不接收“已完成”声明；P1-03 错误处理行为可优先移植，Agent Inbox 双权威、Protocol Envelope 迟到隔离、Gate 假绿和静态 package smoke 必须按 §5.1 分期修正；只移植行为/fixture，不复活 Rust Core | 2026-08-07 同事代码复核 |

## 3. 本文新增设计（此前未定的六块）

### 3.1 账号统一管理（需求 1，2026-08-07 按 Q4/Q14 修订）

V2/cockpit-tools 模式：**Picode 自己管理 OAuth 流与凭据**，存 `~/.picode/accounts.json`（0600）。因为 pi 是 vendored 专属实例，其认证存储也归 Picode 环境所有，无双权威问题。

- 同一 Provider 可**存多个账号**，同时**只有一个活跃**；`/pico-account` 列出、切换活跃、打标签，`/pico-login` 与 `/pico-logout` 管理 Picode Vault 认证。
- `/pico-import` 启动本机 **Account Import Wizard**：默认自动打开系统浏览器，同时在 TUI 打印可复制的回退链接；浏览器打开失败不阻断导入。Pi 原生 `/import` 不被占用。
- **切换不影响上下文**：无缝换活跃账号继续当前会话；Devloop 只记新 **Execution Epoch**，缓存部件显式另起 Cache Epoch（前缀失效可见化）。
- 不支持同 Provider 双账号同时在线（避免配额与身份混淆）。
- Web Wizard 支持本机 Codex/Cursor/Claude 配置扫描、用户选择 JSON、官方 OAuth、OpenAI Compatible、Anthropic 与自定义 Base URL/API Key；先预览候选、冲突和激活影响，再由用户逐项应用。
- 浏览器只负责交互，不拥有账号或凭据事实：本机扫描和来源解析在 Picode 侧完成，最终写入只经过 Store 的单一 Account Vault Interface；网页状态不得成为第二权威。
- Wizard 由 Adapter Extension 托管为**临时深模块**，不是独立 Backend，也不是提前建设 GUI：仅绑定 loopback；每次运行创建一次性 bootstrap token，交换为 `HttpOnly`/`SameSite=Strict` 临时 cookie 后清理 URL；完成、取消、超时或 TUI 退出即销毁会话和临时状态。
- Wizard 不复用持久调试面 API Token；OAuth callback、JSON 与 API Key 不写浏览器持久存储、不出现在 URL、日志或 TUI 输出。静态 HTML/CSS + 少量原生脚本即可，不引入 Web GUI 框架。
- 外部 Agent 账号"导入"优先走各家官方 OAuth；明确选择 JSON/本机扫描时沿用 V2 的兼容与警告规则，一次导入后由 Picode 管理；合规审查（R0 开放决策 6）随每家 Provider 单独过。

### 3.2 CLI-first Control Interface（需求 9，2026-08-07 修订）

**CLI 是 P0–P4 唯一公开、稳定的自动化契约。** 它不解析 TUI 输出，而是调用与
Adapter Extension 相同的 Store / Engine / Guard / Devloop 组合根，不形成第二套
Workflow、状态或权限入口。

```text
picode                                  启动增强后的原版 Pi TUI
picode run                              无头执行一次任务
picode session create|resume|send|events
picode task status|cancel|wait
picode gate status|evidence
picode harness get|set
picode account import                   打开本机临时 Web Wizard
picode doctor
```

- 无头命令由调用进程启动并持有 vendored Pi Runtime，不依赖活跃 TUI 或常驻 Core；
  进程退出时终止其拥有的未完成 Work。
- CLI 与 TUI 共用文件权威、账号、能力目录、Pi Session、Task、Guard、Gate 和
  Evidence Ledger。
- `--json`/`--jsonl` 只向 stdout 输出版本化结构；诊断只进 stderr。退出码稳定区分
  完成、Gate 失败、授权需要、超时、取消、输入错误和内部错误。
- `--non-interactive` 遇到 ask 必须 fail-closed，不能暗自批准或无限等待。
- HTTP+SSE 仅在 `PICODE_DEBUG_API=1` 时作为内部诊断 Transport 启动，不是公共契约；
  测试不得依赖其端口、路由或 token。
- P0–P4 不提供 Picode Control MCP Server。P5 如确有 CLI 无法覆盖的宿主，才允许
  增加只翻译同一 Control Interface 的无状态 MCP Adapter。

### 3.3 缓存方案 v2（2026-08-07 整合 Reasonix + pi-cache-optimizer，已确认）

**结构层（Reasonix 三区制 → Harness 纪律）**：Immutable Prefix（pi 系统提示 + 档位提示词 + 冻结工具 schema；换档/换账号 = 显式缓存重置点，Epoch +1）；Append-Only Log（Context Package 只追加不重排，全局纪律含 Simple 档）；Volatile Scratch（计划草稿和临时推理保存在模型上下文外，不引入独立的 goal 状态机）。

**度量层（Reasonix 诊断 + optimizer 计数，R3 校正版）**：
- 数据源：pi SDK 每轮 usage（cache read/write/input/output），扩展累计；会话/当日/进程三范围。
- **归因信号集**（仅哈希 system+schema 不足以识别日志改写）：`systemDigest`、`toolSchemaDigest`、`retainedHistoryAnchorDigest`（保留历史锚点）、`provider/model/baseUrl`、`promptCacheKeyHash`、`cacheRetention`。
- **缓存未复用/未缓存 Token 归因五类**：system 漂移 / 工具 schema 漂移 / 历史锚点改写（压缩、重排）/ `uncachedTailTokens`（新追加 token 本就不可命中，不等于整次请求 miss，前缀仍可命中）/ **`unknown/provider-side`**（缓存是 Provider 侧 best-effort，不强迫归入已知类）。
- **Cache Epoch 递增条件**：稳定前缀或历史锚点发生替换即递增——包括换档/换账号等刻意重置，**也包括 pi auto-compact 等非用户触发的历史重写**。
- 真实性规则：Provider 未返回 cache 字段时显示 `Cache telemetry unavailable / Reported cached tokens: 0`，不显示裸 `0%`（避免误读为确定未命中）。落盘 `~/.picode/metrics/cache-YYYYMM.jsonl`（非权威）。

**供应商层**：pin 采用 **pi-cache-optimizer**（provider 兼容面：OpenAI 系 `prompt_cache_key` 兜底、代理 session affinity、Anthropic TTL 顺序守卫、compat doctor/fix、持久化计数）；**关闭其提示词重写**（`PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE=1`），前缀结构由 Picode 套件纪律控制。Spike：其 footer 与 Picode 部件的显示整合。

**压缩经济学**：Reasonix 分层压缩（60% 软提醒 → 剪陈旧工具结果 → 占位符 → 付费摘要 → 强制）与固定尾部预算防循环，仍是 P5 显式压缩模块实现参考。P0 另有不可关闭的 **Context Governor**：在 Pi 的每次 `context` 事件（即每次 Provider 调用前，包括工具结果追加后的同一 Agent loop）计算完整预算；预算包含 system prompt、活动工具 schema、消息/Reasoning、工具结果、上一轮 `totalTokens`（含 cacheRead）之后的新尾部，以及输出预留和安全边际。达到阈值时必须先编译有界活动上下文，原始超预算请求不得发送；持久 JSONL 不改写，Agent settle 后再请求 pi durable compaction。普通 auto-compact 设置可关闭，但这道防卡死保护不可关闭。

**上下文变换审计**：Retention、Governor、Durable Compaction 与 Capsule 共用一份按会话 append-only 的 Context Ledger；每条记录以确定性事件 ID 去重，绑定层、动作、session revision、输入/输出摘要、Token 变化与 Artifact 指针。Ledger 只用于识别重复压缩、恢复链和缓存税，不保存会话正文，也不成为第二权威。

**P0–P3 落地切面**：工具结果在 `tool_result` 缝先语义化；超过 64 KiB 的纯文本
完整值由 Store 内容寻址外置，活动历史只保留有界预览和取回指针。预算度量优先使用
Provider usage 锚点 + replay tail，缺失时才保守估算；每次 compact/blocked 生成
Context Compilation Manifest。Endpoint Profile 把模型声明窗口与真实路由证据分开。
旧叙事可以折叠，但 Task/TDD/Capsule 事实受保护。pi-subagents 的直接委派默认
`fresh`，并只附带当前任务最新且通过 revision/digest/snapshot 校验的 sealed Capsule；
显式 `fork` 保留完整父上下文。

未经验证的第三方 OpenAI Responses endpoint 不得直接以模型卡片声明的 1M 作为有效窗口。P0 默认使用保守的 320K effective window；后续只有 endpoint 级验证证据才能提高。官方 endpoint 或已有验证值使用各自有效窗口。

#### 3.3.1 Auto Slice / Capsule（2026-08-16 P0–P3 落地）

最高裁决标准不是 Capsule 字段是否完整，而是：**在尽可能小的体积下，开启
Slice 时的真实任务漂移必须低于关闭时。** 任何新增字段都必须由成对 A/B 样本
证明有净收益；没有真实数据前 Auto Slice 保持实验性、逐 Task opt-in。

- Simple 不参与；Standard/TDD 首次进入 Task 时可选择，命令为
  `/pico-slice-auto on|off|status`。
- Provider/Endpoint 窗口只表示容量，不表示可靠注意力。Picode 的
  **Reliable Working Context Ceiling** 固定为 `min(Endpoint 实测窗口, 400K)`；
  Auto Slice 在该可靠上限的 80% 启动，因此大窗口模型最迟在 `320K` 打包，
  小于 400K 的模型仍按自身窗口 80% 启动。Context Governor 同样按该上限
  预留输出与安全边际，原始请求不得越过 400K。真正换会话只在 Agent settled
  后执行，不打断当前工具链。
- Host 提供 Task/Revision、精确验收、Todo、Git Snapshot/changed files、
  Gate/Evidence；当前主模型以当前 Thinking、**无工具**提议 decisions、
  failed approaches、next steps 和最短 narrative。不得委派 Subagent 打包。
- Capsule 目标约 2–6K Token、硬上限 8K；先舍弃 narrative，必要事实仍超限则
  失败并回退。不得放入完整旧聊天、reasoning、tool log、diff、Skill 正文或秘密。
- 新会话使用 Pi 原生 `parentSession` 形成 `slice-continuation` 父子链；旧 JSONL
  完整保留，child 持久化后自动继续并通知 old ID → new ID。
- 自动路径要求 workspace HEAD 与 content digest 均可验证；缺失时不静默降级，
  而是在调用模型前回退 Pi compaction。手动 `/slice` 可诚实标记 DEGRADED。
- Task Revision 由标题/验收编辑、工作区重绑、成功 rewind/tree change 等确定性
  事件递增。新 child 已持久化后才 supersede 上一 Capsule；确定性 ID 支持重试。
- Auto Slice 只取代 Pi threshold compaction。Pi manual/overflow、Context
  Governor 和 durable compaction 继续作为失败/溢出 fallback。

P0 效果 Gate 至少需要 3 对同模型、同 Thinking 的观测，Slice-on 改善占多数且
产品质量不得退化。P4 才执行真实中型项目 A/B；单元测试不得冒充效果验证。

### 3.4 三级工具与 search_tools 发现（2026-08-07 已确认，R4 收敛持久状态）

沿用 V2 三级驻留设计（ADR-0021 / 游戏 Agent 讨论 #28），映射到 pi 现状。**驻留层级与扩展生命周期是两个正交轴**：

**用户设置轴（持久化，仅用户可改）**不是线性状态机，而是两个正交事实：

```ts
type CapabilitySetting = {
  enabled: boolean;
  trustedDigest?: string;
};
```

`enabled` 只决定能力是否进入可发现集合；`trustedDigest` 只表明用户信任过哪一份固定 manifest 内容。禁用时保留信任摘要，重新启用同一摘要无需重复信任；manifest 摘要变化后旧信任自动失效。`Enabled ≠ Running`，`Trusted ≠ 获得操作权限`；模型不能修改这两个事实。

**会话运行轴（临时，模型可请求）**：

```text
模型 search_tools → 请求 Activate
→ Guard 检查 enabled=true 且 trustedDigest 匹配当前 manifest digest
→ 裁决本次调用权限（三档预设 + Grant）
→ Engine 临时激活（会话内，Running 状态）
```

模型只能请求 `Activate`；`Running` 只描述进程或当前会话激活状态，不改动持久配置。

**三级定义（修正版）**：
- **一级（常驻核心）**：pi 内置工具 + 套件启动注册的工具；schema 稳定进上下文，构成 Immutable Prefix 成分。
- **二级（可发现懒加载）**：`enabled=true` 且当前 manifest digest 已被 `trustedDigest` 固定，manifest 可被 search_tools 搜到但未运行。MCP 类走 pi-mcp-adapter 代理模式（search → describe → call，server 懒连接，零自研）；pi 扩展类走 Picode 自有 `search_tools`（约 200 token 常驻）。TOOLS.md 任务绑定扩展在任务开始/恢复/接管时解析、注入紧凑摘要，同走此链。
- **三级（默认 `enabled=false`）**：模型完全不可见——不注册、搜索结果过滤、零进程。用户启用且信任当前摘要后实际进入二级。

**发现入口裁决**：自有 `search_tools`，不复用 mcp-adapter 的 search（后者只索引已注册工具，覆盖不了未加载的二级 manifest，且目录权威不外泄给三方包）。

**激活路径经济学（R3 修正：确定性策略，不交给模型）**：模型只表达"我要使用这个能力"，Engine 选择最经济的调用路径；"注册将重置缓存"仅作诊断信息显示，不进入模型决策。深模块接口：

```text
activate(capabilityId, taskContext) → ActiveCapabilityLease
```

调用者不感知 registerTool/setActiveTools/代理调用/缓存重置。Engine 内部确定性规则：① 能代理调用时默认代理调用；② 必须进入原生 Tool Schema 的能力才临时激活；③ 用户明确固定为常用工具时按会话/项目常驻；④ 连续多次调用由确定性阈值**建议**晋升，不自动修改持久配置。激活收敛到轮次边界，Cache Epoch +1 并归因显示。Engine 经 **Active Tool Adapter** 激活/停用能力；具体用 `registerTool/unregisterTool`、`setActiveTools` 还是 reload，由 pin 版本一致性测试决定（mcp-adapter 同款兼容策略），上游接口变化不影响调用者。

### 3.5 导入上下文的工具契约映射（2026-08-07 已确认，R3 修正权威归属）

前提：导入的历史是**冻结的、永不重放执行的文本**；问题不是"外来工具调用怎么执行"，而是"别让模型误以为那些工具存在"。

**权威流水线（R3 修正：语义映射集中在 Picode 内部，外部导入器只理解来源格式）**：

| 阶段 | 权威 |
|---|---|
| 来源文件解析、call/result 配对 | 外部来源 Adapter（核心外） |
| 输出 `Foreign Transcript IR` + `SourceToolSignature` | Import Contract（交换格式） |
| 历史工具 → `Tool Semantic Operation` | **Store 内部 `ImportCompiler`**（导入时懒加载，不增加正常聊天开销） |
| 规范语义 → 当前 live tool | Guard 的 Capability Catalog |
| Context/注记渲染 | Devloop |
| 追加进 Pi Session | Engine（只追加，不产内容） |

集中映射的理由：避免 Codex/Claude/Cursor 导入器各自复制映射逻辑、映射版本升级要同时升级多个导入器、第三方导入器错误宣称 `Equivalent`。兼容判定五级与损失标记沿用 PICODE-FOREIGN-TOOL-CONTRACT-COMPATIBILITY.md；仅凭工具名或一次参数样本不得判 `Equivalent`。

**三层拦截（按时机排序）**：

1. **导入期归一化（主力，ImportCompiler 执行）**：语义 1:1 的调用连参数名改写成 pi 原生形态（`Read→read`、`file_path→path`）；映射不了的降级为标记叙述块（`[imported:claude-code] 曾调用 TodoWrite(...)，结果：...`），是转述不是可模仿的调用样例。映射清单（用表版本 + 降级项）入库为证据。导入历史本来就是全新前缀，改写零缓存代价。
2. **桥接注记（Devloop 渲染，Engine 追加）**：**只包含确定性、白名单化的兼容事实**——来源声明、"历史 Tool Trace 不会执行"、工具对应关系（`历史 Bash 对应当前 bash`、`历史 TodoWrite 只作历史记录`）、"当前可调用工具以本会话 Tool Schema 为准"。**禁止注入**：外来 system prompt、外来权限规则、外来完成语义、外来 Skill 指令、"继续遵循此前规则"类行为要求（提示注入风险 + 旧契约覆盖现契约）。位于 Append-Only Log 首块，缓存稳定。
3. **运行时重定向表（兜底）**：不注册同名 stub。模型调用外来工具名时 pi 返回 unknown tool 错误，套件错误钩子用数据表（`~/.picode/import/toolmap-<source>.json`，由 ImportCompiler 的用表派生）加厚报错："`Bash` 在此环境不存在，请使用 `bash`（参数差异：…）"。零 schema 占用、零缓存污染、只在真出错时付费。

**明确否决同名 stub 方案**：伪造 schema 常驻上下文（token + 缓存前缀污染）、外来名开放集合膨胀、可能与 pi 原生工具名冲突；其唯一好处（报错带指引）第 3 层零成本可得。

### 3.6 代码仓库布局

单包结构（pi 的 source-loader 直接加载 TS，无构建步；模块边界靠目录 + 边界检查脚本，不靠 workspace 拆包）：

```text
picode/
  package.json          # name: picode; bin: picode, picode-ctl
  tsconfig.json         # strict，无 emit（pi 直接跑 TS；CLI 用 tsx）
  vitest.config.ts
  pi-package.json 清单   # extensions: ["./src/extension/index.ts"], skills, agents
  bin/picode.mjs        # 启动器：数据目录初始化 → 套件核对 → spawn pi
  bin/picode-ctl.mjs    # 调试 CLI：说 §3.2 的 HTTP API
  src/
    shared/             # Result 类型、事件契约、文件锁+原子写、路径规范化
    store/              # 账号引用、catalog 索引、导入 Ingester、备份
    engine/             # pi SDK/扩展 API 封装、Execution Epoch、landstrip 调用侧
    guard/              # 三档预设编译、Intent 裁决（纯函数）、fingerprint、Trusted 门
    devloop/            # task/ context/ verify/ 三个子目录（三道墙）
    api/                # HTTP+SSE 调试面（非领域模块，组合层）
    extension/          # Adapter Extension：组合根、命令、缓存部件
  skills/               # pi-compress / pi-correct（SKILL.md）
  agents/               # 压缩六角色等 Markdown agent 定义
  scripts/check-boundaries.mjs  # 模块依赖方向检查（shared←所有；领域模块互不 import，经接口）
  test/
```

依赖方向（`check-boundaries.mjs` 强制）：`shared` 被所有人依赖；四个领域模块互相**不直接 import**，跨模块协作经 `shared` 里的接口类型 + 组合根注入；`extension/` 与 `api/` 是唯一允许 import 全部模块的组合层。

### 3.7 首次启动引导与随包 Skills（V3 修订）

首次进入 Picode 只推荐两个需要用户决定是否启用的运行时组件，**分别独立询问两次 Y/N**，不提供"一键全部启用"：

| 推荐组件 | 默认建议 | 作用 |
|---|---|---|
| Herdr | 是 | 多任务与多 Agent 编排；只有实际使用时才启动 |
| CodebaseMemoryProvider | 是 | Picode 内建稳定 Provider Interface/Adapter；可选安装外部 `codebase-memory-mcp` 运行时，提供代码库级长期记忆、结构索引与跨会话检索 |

规则：
- 两项分别介绍，介绍文字跟随当前界面语言（中/英）。
- 不选择不影响原版 pi 基础能力；以后可在"专业扩展"中重新启用或停用。
- **启用 ≠ 常驻运行**：只进入二级驻留（`enabled=true` 且当前 manifest digest 已信任），需要时才 Activate（§3.4 语义）。
- Codebase Memory 的稳定 Interface/Adapter 随 Picode 内建；实际 `codebase-memory-mcp` 进程属于 External Extension。回答 Y 表示安装固定版本、启用并信任当前摘要，不把第三方进程伪装成 Built-in Feature。
- 跳过向导后不在每次启动重复打扰；可在设置中重新打开向导。
- 启用三项不污染 Simple Task（Simple 档不加载扩展工具的纪律优先）。
- **Herdr 不替代 pi-subagents**：pi-subagents 是套件内委派/编排底座，Herdr 是用户可选的上层多任务编排。

`mattpocock/skills` 作为随 Picode 分发的固定快照，不再参与首次引导，也不在启动时整体加载：

- `vendor/mattpocock/manifest.json` 固定来源、Commit、许可证、文件数和 bundle digest；随 Picode 一起分发。
- 用户第一次显式使用 `/plan` 时，Picode 只把 `grill-with-docs` 的依赖闭包（`grill-with-docs`、`grilling`、`domain-modeling`）物化到 Picode 私有 Pi skill root，随后重载当前会话并自动提交规划请求。
- 其它内置 Skills 采用相同的按需物化接口；不把整套 Skills 注入上下文，不污染项目目录，也不自动访问网络。
- 已存在的用户技能目录不覆盖；快照损坏或物化失败只报告可定位错误，不退回外部安装命令。

## 4. Spike 清单（实现期第一批要证明的）

### 4.1 Bridge 可行性 Gate（最先执行）

以下四项必须早于四模块的生产实现。任一项无法通过公开扩展接口闭合，都要先
修订 Adapter Seam 或重新评估最小 Pi Patch，不能靠提示词或旁路状态掩盖：

1. 能否观察并请求 Pi compaction，使 Cache Epoch 与 Capsule 切片时机有确定性事件；
2. 能否观察 rewind / fork / resume 生命周期，使 Task Narrative Revision 不会与会话历史脱节；
3. Picode 启动器包裹 Pi TUI 时，stdin/stdout、signal、terminal resize 与退出码的所有权是否完整且跨平台一致；
4. 每次 Tool Intent 经过 Guard/Bridge 的关键路径延迟与抖动；若需 IPC 或异步仲裁，必须证明不会显著拖慢交互。

Bridge 可行性 Gate 通过后，再执行下面的供应商与平台 Spike：

1. pi TUI 部件 API 能否承载缓存命中率显示（ADR-0003）；
2. pi SDK usage 事件里 cache token 字段在目标 Provider 上的可得性；
3. landstrip `prepareProcess()` 政策下发与 Guard 包装的执行顺序（ADR-0004）；
4. Windows AppContainer 下 node/git/构建器兼容性抽样（ADR-0004）；
5. landstrip agent 与 pi-mcp-adapter `mcp:server-name` frontmatter 互通（MODULES.md）；
6. landstrip build 流程与三档 Harness 提示词的共存方式；
7. 启动器向 pi 注入扩展套件的正确姿势（settings 合并 vs 启动参数）；
8. 多 pi 进程并发写共享文件的锁实测（Windows 语义优先）；
9. pi-lens 的 C#/GDScript 语言覆盖核实（游戏开发目标语言）；
10. pi-cache-optimizer footer 与 Picode 缓存部件的显示整合（避免重复渲染）；
11. Picode `/plan` 提示入口、mattpocock/skills 与 pi-web-access 的常驻 token 成本测量；
12. unknown tool 错误路径可否被扩展钩子拦截加厚（§3.5 第 3 层；补丁仅作 Spike 失败后的最后手段）；
13. Active Tool Adapter 一致性测试：pin 版本上 `registerTool/unregisterTool`、`setActiveTools`、reload 的可用组合与轮次边界收敛（§3.4）；
14. pi auto-compact 触发点的可观测性（§3.3 要求 compact 后递增 Cache Epoch，需要事件或锚点哈希探测）。

## 5. P0–P5 分期（2026-08-07 订立）

> 性质：**范围分期，不是迭代 MVP**（Q7 纪律不变：设计冻结 → 一次搭齐基础架构 → 作者自行完成实现）。P0 骨架由本轮协作产出，P1 起由作者实施；每期有验收界碑，界碑不过不进下期。

| 期 | 主题 | 范围 | 验收界碑 |
|---|---|---|---|
| **P0** | 骨架与地基 | **先完成 §4.1 Bridge 可行性 Gate**；再建单包仓库 + 边界检查脚本；vendored pi 启动器；四模块空壳 + 接口 + 组合根注入；供应商与平台 Spike；**Context Governor 在每次 Provider 请求前执行完整预算并强制缩减，原超预算请求不得发送**；建立严格 GateRunner，并把 V2 failure fixtures 移入共享契约语料 | `picode` 能启动 vendored pi；Bridge 有真实原型证据；019ff330 类工具结果突增会在请求前被缩减到有效窗口内；即使普通 auto-compact 关闭也不会把已知超预算请求送给 Provider；GateRunner 自证红测通过 |
| **P1** | 单人可用核心 | Adapter Extension 组合根实装；在任何 observer、状态投影或 UI 消费前完成统一 Envelope 解码与 Admission，以 `executionEpoch + runId/requestId + terminal state` 隔离 cancel 后迟到结果；账号管理（单一 Account Vault + OAuth + `/pico-account`、`/pico-login`、`/pico-logout`）；`/pico-import` 临时 Web Wizard（自动打开浏览器 + TUI 链接回退 + 本机扫描/JSON/自定义 API，Pi `/import` 保持原生）；Execution Epoch 记账；Guard 三档预设 + approval_fingerprint + Grant 分级；缓存方案 v2 全量（部件 + 六信号归因 + pi-cache-optimizer 集成）；Simple 档（pi-web-access）；首次启动引导（§3.7）；固定工具语义 ID vocabulary（契约文档 P1）；能力目录 + search_tools + 三级驻留（含 ActiveCapabilityLease）；Capability 持久格式采用 `{enabled, trustedDigest?}`；移植 V2 P1-03 的可定位错误/锁毒化恢复行为，不保留 Rust owner | 日常单会话开发可用：从 TUI 打开 Wizard 完成账号导入/登录/切号、Simple 档聊天、缓存部件真数据、search_tools 全链路（搜→Activate→Guard→租约）；坏 frame 可记录/重放但不污染状态；重复终态和 cancel 后任意迟到结果均不能到达 observer；Wizard 认证、超时、取消与浏览器打开失败 Gate 全绿 |
| **P2** | 二档 Harness 与执行治理 | `/harness` 换档；landstrip、pi-mcp-adapter、pi-subagents；Picode `/plan` 兼容入口（委托 mattpocock/skills）；Slice/Capsule v1 + 实验性 Auto Slice（§3.3.1）；Worktree 规则；§3.2 第一方无头 CLI；TaskIngress 唯一任务入口；扩展/MCP/Subagent 返回统一走 Envelope/Admission | 二档全链路；外部 Agent 只经 CLI 创建/恢复会话、发送并等待回复、观察 Tool/Gate/Evidence、处理授权失败与取消；CLI 不依赖 TUI 且不解析终端输出；自动切片形成可 resume 的 Pi 父子 JSONL，失败可回退且不丢父会话 |
| **P3-A** | TDD 三档 | 三档提示词（Claude Code 移植 + 语义适配）；TDD 状态机 + 预算（**数值本期定稿**）+ Gate/Evidence + Completion Label（verify/ 唯一签发）；pi-lens 接入（三档默认）+ 对抗审查（watchdog 强配置） | TDD 档跑通一个真实小项目（recorded RED → green → gate → Completion Label）；Flaky 不制造无限修复循环 |
| **P3-B** | 导入编译核心 | Store ImportCompiler（历史映射 + 归一化投影）+ Guard Catalog `resolveLive`；兼容报告与重编译判据 | 契约级 fixture Gate 全绿；不加载来源 Adapter 也能独立测试编译核心 |
| **P3-C** | 来源 Adapter | Claude/Codex/Cursor 来源 Adapter、桥接注记（Devloop 渲染）、重定向表错误钩子 | 三个来源各自用真实历史样本完成导入 + 继续会话；单一 Adapter 延期不阻塞其他来源和 P3-A/B |
| **P4** | 整合与验收 | 导入预览/兼容报告 TUI 呈现；真实迁移样本的性能与失真验收；**同一 Picode/Provider/模型/Thinking 的 Auto Slice on/off 成对长任务实验**；缓存命中率实测调优（归因数据驱动）；跨平台矩阵完整过（Windows AppContainer 全面版、mac/Linux）；TOOLS.md 任务绑定扩展；真实 pi TUI boot/navigation smoke；固定版本与摘要校验后的安装产物启动 smoke（与 package metadata contract 分开）；全量 typecheck/lint/test/红探针；文档 + 发布打包 | 三平台发布件；真实安装产物在三平台启动并完成一轮会话；package smoke 不能用静态正则或 `skipped=true, passed=true` 代替；至少 3 对实验中 Slice-on 改善占多数且质量不退化；缓存命中率与抗失真有实测报告；旧 Master 遗留需求清点归零 |
| **P5** | 远期扩展 | 显式压缩/纠偏模块（/pi-compress、/pi-correct，PICODE-COMPRESS-SKILL-DESIGN.md 为规格）；`picode serve` + 手机/桌面远程端（复用 §3.2 同一 surface，且只能调用 P2 `TaskIngress`、P1 Envelope/Admission 和既有 Store 权威，禁止第二会话/任务数据库与 legacy fallback）；导入 hardening（恶意 payload fuzzing、签名 Adapter）；approval_fingerprint 白名单式 env 摘要评估 | 各件独立验收，互不阻塞；远程端断连、重试和旧客户端事件不能复活已取消任务或绕过唯一 Task 权威 |

跨期纪律：抗失真组合（实验性 Auto Slice/Capsule + Context Governor + Pi
compaction fallback）在 P2 成型、P3 加固；watchdog 不以模型自述驱动硬边界；
缓存全局策略从 P1 部件上线起对所有档位生效；每期结束把"已决/未决"清单回写本文决策索引。

### 5.2 当前实施状态（2026-08-07）

P1–P4 的可代码化范围已经按 Extension-first V3 接入真实 Pi 0.84.0；Windows
开发态 RPC 与真实 npm 安装产物均能加载 Picode 命令并新建会话。实现没有引入
Rust Core 或自研 TUI。详细证据见
`docs/verification/P0-P4-ACCEPTANCE.md`。

以下项目必须保持 `not_run`，不因代码完成而冒充验收通过：Linux/macOS 发布件、
Windows AppContainer 破坏性探针、真实 Provider 缓存命中率、中型仓库模型驱动
Slice 漂移实验、用户选择的真实 Claude/Codex/Cursor 历史迁移。三平台 workflow
只是可执行合同，运行结果才是证据。

### 5.1 V2 P1-02～P1-05 审计债的分期归属

| 审计发现 | 旧代码如何处理 | V3 唯一落点 | 完成 Gate |
|---|---|---|---|
| Agent Inbox 失败后回退旧 dispatch，形成双任务权威 | 保留真实迁移 fixture、确定性 ID、备份/回滚思想；拒绝 legacy writer、直接 prompt 和 best-effort fallback | P2 Devloop `TaskIngress` + Store `StateFile<T>` | 同一输入重试不重复建 Task；tombstone 损坏必须红；TaskIngress 失败不得产生孤儿运行 |
| 运行期 `unwrap/expect` 与锁毒化 | 优先翻译可定位错误、poison recovery 和崩溃隔离测试；不迁 Rust Core | P0 Shared Result/StateFile，P1 Adapter/Engine | 非法 URL、锁持有者崩溃、端口占用和子进程死亡均成为结构化错误，pi TUI 不因单一扩展失败退出 |
| Protocol Envelope 只接了一部分通道，且 cancel fence 方向错误 | 保留畸形输入与重复终态 fixture；重写 Admission，不照搬 `seq <= cancelSeq` | P0 事件契约，P1 Pi 入口，P2 Extension/MCP/Subagent 入口 | 所有生产入口共享 fixture；Admission 在 observer 前；不同 epoch/run 的迟到事件不可进入状态、Evidence 或 UI |
| failure-domain Gate 对零测试匹配返回绿色 | 保留分桶与环境 provenance 结构；重写执行器 | P0 GateRunner，P3 Verification 消费 | 每个过滤器至少匹配一项；红探针被移除/重命名时 Gate 自身失败；`not_run/skipped` 永不折算为 passed |
| boot/package smoke 只是静态文本检查 | 静态检查降名为 metadata contract；真实运行另建 Gate | P1 开发态 TUI boot，P4 安装产物 smoke | 真实加载入口、导航、启动 pi、建立会话；固定版本/摘要不符时红，缺 runtime 时是 `not_run` 而不是绿 |

这些条目是 V3 主路线的验收债，不授权继续修补旧 V2 产品拓扑。旧代码仅作为
行为与测试语料来源；任何复用都必须跨越上述 V3 Interface，而不是复制旧调用链。

### 开发计划外候选池

- **code-by-wire fork**：未来可选桌面观测端候选；当前不分配 P 阶段、依赖、
  验收 Gate 或开发资源，也不影响 Herdr 与 Picode 核心路线。只有用户以后单独
  决定立项时，才依据
  `research/code-by-wire-vs-herdr-for-picode-2026-08-07.md` 重新制定实施计划。

## 6. 旧文档地位

| 文档 | 地位 |
|---|---|
| 本文 | 设计入口（最终） |
| ADR-0001～0005、MODULES.md | 决策权威 |
| PICODE-HARNESS-PROMPT-DESIGN.md / PICODE-COMPRESS-SKILL-DESIGN.md / PICODE-FOREIGN-TOOL-CONTRACT-COMPATIBILITY.md | 有效的组件规格 |
| docs/design/PICODE-V3-IMPLEMENTATION-TAKEOVER-AUDIT.md | 2026-08-07 实现盘点、复用分类与迁移顺序；不是设计权威 |
| R2 / R1 / R0（MASTER） | 历史评审稿：三档 Harness×权限（R2 §5）、TDD/Gate 细节（R0 §11）、Verification Budget 等仍是 Devloop 实现时的参考规格；拓扑/语言/存储章节以 ADR 为准 |
| CONTEXT.md | 领域词汇权威，持续维护 |
