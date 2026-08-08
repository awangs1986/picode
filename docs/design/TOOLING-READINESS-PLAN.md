# Picode V3 下一步工具完善计划

> 状态：Implemented P0–P4（2026-08-08；真实 Windows 已验证，Linux/macOS 进入 CI 矩阵）
> 范围：P0–P4；不启动 P5，也不在本计划中实现代码。
> 目标：补齐结构化 Git，并让模型只看到真正可工作的能力，而不是“已安装但未配置”的空工具。全部验收优先通过 `HEADLESS-FIRST-PLAN.md` 的 Control Interface 执行。

## 1. 已确认问题

1. Picode 已有 Git 权限、Candidate Snapshot、Managed Worktree 等内部能力，
   但模型只能经 `bash` 调 Git，缺少结构化的一等 Git Interface。
2. 当前扩展状态只表达设置轴（Enabled/Trusted）和运行轴
   （Stopped/Running），没有表达运行前置条件是否满足。
3. pi-lens、MCP 与 Web 的部分能力依赖外部程序、Server、认证或 Provider；
   “扩展已加载”不等于“能力可用”。
4. 无效 Tool Schema 进入模型上下文，会增加缓存前缀、误导工具选择并制造
   无意义失败。

## 2. 架构裁决

### 2.1 Git：一个深 `git` Module

Standard/TDD 增加一个一级 `git` 工具；Simple 保持上游 Pi，不增加工具。
模型只学习一个 Interface，Implementation 直接调用 Git 可执行文件的参数数组，
不拼接 Shell 字符串。

| Action 组 | Actions | 默认权限 |
|---|---|---|
| Inspect | `status`、`diff`、`log`、`show`、`branches`、`worktrees` | 自动允许 |
| Local edit | `stage`、`unstage`、`switch`、`create_branch`、`restore` | 服从 Permission Tier |
| Managed Worktree | `create_worktree`、`claim_worktree`、`release_worktree`、`remove_worktree` | Engine 安全检查 + Permission Tier |
| Ownership | `commit`、`merge`、`rebase`、`push`、`delete_branch` | 始终要求用户确认 |

Interface 必须返回结构化结果、截断标记和稳定错误码。`restore`、Worktree 删除等
可能丢失工作的动作必须先检查目标状态；不提供任意 Git 参数逃生口，复杂命令仍
可由用户明确批准后走 `bash`。

### 2.2 Readiness：独立于生命周期的正交事实

保留现有两条轴：

```text
设置轴：Disabled / Enabled + TrustedDigest
运行轴：Stopped / Running
```

新增 Engine 权威的运行条件投影：

```text
Ready | Degraded | NeedsSetup | Unavailable
```

- `Ready`：当前 Task Context 下前置条件满足。
- `Degraded`：部分能力可工作，必须列明缺失子能力。
- `NeedsSetup`：用户可修复，但尚缺程序、Server、认证或配置。
- `Unavailable`：当前平台、项目或版本无法使用。

Readiness 不写回 Enabled/Trusted，不自动启动进程，也不提高权限。Store 可保存
诊断缓存，但不得成为 Readiness 权威；Guard 继续唯一拥有启用、信任与授权；
Devloop 只负责渲染。

### 2.3 小 Interface

```ts
interface CapabilityReadiness {
  inspect(capabilityId, taskContext): Promise<ReadinessReport>;
  prepare(capabilityId, taskContext): Promise<SetupPlan>;
}
```

- `inspect` 必须只读、可取消、有超时；不得联网试消费、安装程序或发起付费请求。
- `prepare` 只生成 Setup Plan；安装、写配置、OAuth 或密钥录入必须由用户确认。
- Adapter 内部可各自探测，调用者只认识统一的 `ReadinessReport`。

## 3. 各能力的就绪语义

| 能力 | Ready | Degraded / NeedsSetup |
|---|---|---|
| Git | Git 可执行文件存在且当前目录可解析 | 非 Git 工作区为 `NeedsSetup`；Git 缺失为 `Unavailable` |
| pi-lens | 项目语言对应 LSP/Runner 可用 | AST/索引可用但 LSP 缺失为 `Degraded`；不得在探测时自动安装 |
| MCP | 至少一个启用 Server 已配置；lazy 未连接仍可 Ready | 无 Server 为 `NeedsSetup`，提示 `/mcp setup`；连接后失败显示具体 Server 错误 |
| Web Fetch | 直接抓取路径可用 | 仅高级提取 Provider 缺失时为 `Degraded` |
| Web Search | pi-web-access 的零配置 Exa 路径、可复用 Pi 认证或显式 Provider 任一可用 | 显式禁用全部搜索路径才为 `NeedsSetup`；探测不得实际发起搜索或付费请求 |

Web Fetch 与 Web Search 必须分开报告，不能因为搜索没密钥而把无密钥 Fetch 也
判为不可用。

## 4. 模型可见性与缓存纪律

- `Ready`：正常注册并可调用。
- `Degraded`：只注册可工作的子工具，并向模型提供简短缺失说明。
- `NeedsSetup`：`search_tools` 可显示名称、原因和用户操作，但不注入无效 Tool Schema。
- `Unavailable`：模型不可调用；用户诊断面仍可见原因。
- Readiness 在会话启动、Harness 切换和用户完成 Setup 后探测；同一轮中不改变
  Tool Schema。可见工具集合改变时，在轮次边界开启新 Cache Epoch。
- 模型只能建议或请求 Setup，不能自行录入密钥、安装外部程序或启用收费 Provider。

## 5. 用户入口

新增：

```text
/doctor tools
```

输出 Git、LSP、MCP、Web Fetch、Web Search 的状态、来源、缺失项和下一步。
`search_tools` 同步返回 Readiness 摘要；不得只返回“已启用”。

## 6. 实施阶段

| 阶段 | 工作 | Gate |
|---|---|---|
| P0 | 冻结 Git action schema、ReadinessReport、稳定错误码和 Adapter 一致性 fixture | Interface 测试可红；权限分类无遗漏 |
| P1 | 实现一级 `git` 工具和 Managed Worktree 接线 | Inspect 结构化；Simple 不出现；Ownership 在 full 下仍 ask |
| P2 | 实现 Git/pi-lens/MCP/Web Readiness Adapter | 探测零安装、零付费请求、零秘密输出 |
| P3 | 接入 `search_tools`、Tool Schema 过滤、`/doctor tools`、Cache Epoch | NeedsSetup 工具对模型不可调用；Setup 后只在轮次边界出现 |
| P4 | 真实 Windows/Linux/macOS 与故障矩阵 | 缺 Git、缺 LSP、空 MCP、坏 Server、无 Web Provider、Provider 失效均诚实降级 |

## 7. 必须可红的验收

1. Simple 模式若出现 Picode `git` 工具，Gate 必须红。
2. `full` 权限下 commit/merge/rebase/push 不询问，Gate 必须红。
3. 无 MCP Server 时模型仍能调用 MCP 业务工具，Gate 必须红。
4. pi-web-access 零配置搜索路径被移除或禁用后仍显示 Ready，Gate 必须红。
5. Readiness 探针触发安装、OAuth、网络搜索或付费请求，Gate 必须红。
6. 缺 LSP 时 pi-lens 被显示为完整 Ready，Gate 必须红。
7. Web Search 不可用导致 Web Fetch 一并隐藏，Gate 必须红。
8. Tool Schema 在同一模型轮次中变化，Gate 必须红。

## 8. 非目标

- 不重写 Git、LSP、MCP 或 Web Provider。
- 不把 Readiness 混入扩展启用/信任/运行状态。
- 不为每个插件暴露不同的诊断 Interface。
- 不自动安装外部依赖，不自动选择收费 Provider，不保存用户密钥明文。

## 9. 实现位置

- 结构化 Git 深模块：`src/engine/git.ts`，Standard/TDD 通过单一 `git` Tool 暴露；
  Simple 在轮次边界移除该 Schema。
- Readiness 权威与 Schema 过滤：`src/engine/readiness.ts`；探针只读，Setup 仅返回计划。
- CLI/RPC 诊断：`picode tools doctor`、`picode doctor tools`、`picode tools search`。
- 无头和安装产物 Gate：`scripts/headless-conformance.mjs`、`scripts/package-smoke.mjs`。

Windows 已运行真实 Git/Agent Loop/package Gate；Linux/macOS 的真实可执行文件和路径
差异由同一个 GitHub Actions matrix 执行，合并前不得把未运行状态等同为 passed。
