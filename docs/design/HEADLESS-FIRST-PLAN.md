# Picode V3 无头模式优先计划

> 状态：Implemented P0–P4（2026-08-08；Windows 本机实测，Linux/macOS 由 CI Gate 执行）
> 目的：先把 Picode 变成可稳定驱动、重放和断言的 CLI 产品，再继续 Git 与
> Capability Readiness。无头模式不是第二套 Runtime，必须复用同一个 vendored
> Pi、Picode Extension、Control Interface、Guard、Session 和 Evidence。

## 1. 当前差距

当前底层已有 Pi RPC 和 `picode run/session/task/gate/harness/account/doctor`，但
产品闭环尚未成立：

1. `picode --help` 直接显示上游 Pi 帮助，没有暴露 Picode Control 命令。
2. `picode-ctl --help` 会访问内部调试 HTTP 并返回 404；它不是可用的公共 CLI。
3. `run` 能输出 JSONL，但审批只能 fail-closed，自动化客户端不能在同一协议内
   响应一次/会话批准。
4. `doctor` 只检查文件存在，不检查工具 Readiness。
5. 没有无密钥、确定性的模型 Fixture，完整 Agent Loop 测试仍依赖真实 Provider。
6. CLI 的 Task/Gate/Account/Session 能力不完整，帮助、错误 Schema 和跨平台
   package conformance 也没有形成单一 Gate。

## 2. 产品入口

```text
picode                          启动原版 Pi TUI
picode --help                   显示 Picode 产品帮助
picode tui [pi options]         显式进入上游 Pi TUI/CLI 兼容面
picode run ...                  一次无头任务
picode rpc                      长生命周期 stdin/stdout JSONL Control Interface
picode session ...              会话生命周期
picode task ...                 Task 查询、等待、取消
picode gate ...                 Gate/Evidence
picode harness ...              Harness 档位
picode permissions ...          Permission Tier
picode account ...              账号管理与 Web Import Wizard
picode tools ...                工具搜索、Readiness 与诊断
picode doctor [tools]           总体或工具诊断
```

旧 `picode-ctl` 明确标记为内部 Debug HTTP 客户端，移出用户文档；未来可以删除，
但不能承担公共自动化契约。

## 3. 一个深 Control Interface

TUI Adapter、一次性 CLI 和长生命周期 RPC 都调用同一个 Control Interface。
RPC 使用版本化 NDJSON：

```json
{"version":1,"id":"r1","method":"run.start","params":{}}
{"version":1,"id":"r1","event":"approval.required","payload":{}}
{"version":1,"id":"a1","method":"approval.respond","params":{"requestId":"...","action":"once"}}
{"version":1,"id":"r1","event":"run.completed","payload":{}}
```

Interface 必须覆盖：

- request id、execution epoch、session/task/run identity；
- 流式文本、thinking 元数据（默认折叠）、Tool Intent/Result、Gate/Evidence；
- cancel、timeout、进程退出和 cancel-late 事件隔离；
- `once/session/session-full/session-unrestricted/deny` 审批响应；
- stable error code 与进程退出码；
- stdout 只有协议，诊断只进 stderr。

## 4. 无头权限

- 默认 `--non-interactive` 遇到 ask 返回 `approval.required` 并以退出码 3 结束。
- `--permissions readonly|auto|full|danger-full-access` 是本次 Run 的显式用户授权；`full` 仍不能
  自动越过破坏性操作和 Git 所有权。
- `danger-full-access` 是与 Codex 完全访问对等的显式危险档位：审批策略为 never，
  OS 沙箱关闭；TDD Gate 和用户设置的 Workspace Fence 仍是独立契约。
- 长生命周期 `picode rpc` 可响应审批；模型不能伪造 `approval.respond`，只有
  协议客户端输入通道可提交。
- 不从提示词文本推断授权；完全访问只能由用户通过结构化参数或 `/permissions`
  明确选择。

## 5. 确定性无密钥测试

建立仅测试使用的 Scripted Model Adapter：

- 本地启动，不访问外网，不读取真实账号；
- Fixture 明确返回文本或 Tool Call 序列；
- 通过真实 Pi Agent Loop、真实 Picode Extension 和真实 Control Interface；
- 能稳定触发 read/write/edit/grep/find/ls/bash、审批、取消、Gate、Session resume；
- 发布包不得注册该 Provider，package Gate 必须验证它不可见。

真实 Provider 测试保留为单独的 opt-in smoke，不作为日常回归前置条件。

## 6. 实施阶段

| 阶段 | 工作 | Gate |
|---|---|---|
| P0 | 冻结 CLI/RPC Schema、帮助、退出码；修正 `picode --help`；隔离 `picode-ctl` | fresh install 下帮助可发现；坏参数稳定退出 64；无 HTTP 依赖 |
| P1 | `picode rpc`、审批响应、取消/超时、Session identity；Scripted Model Adapter | 无密钥跑真实 Agent Loop；approval/cancel-late 可红 |
| P2 | 补齐 session/task/gate/harness/permissions/account 命令及同一 conformance fixture | TUI 与 CLI 读取同一 Session/Harness/Permission/Evidence |
| P3 | 接入结构化 Git、Capability Readiness、`tools doctor` | `TOOLING-READINESS-PLAN.md` 全部通过无头协议验收 |
| P4 | npm pack 后 Windows/Linux/macOS 矩阵、并发与故障恢复 | 安装产物运行同一 fixture；零调试端口；无平台路径漂移 |

实现证据：`test/control/` 覆盖 CLI/RPC、真实无密钥 Agent Loop 与审批往返；
`scripts/headless-conformance.mjs` 覆盖帮助、稳定退出码、协议版本和并发诊断；
`scripts/package-smoke.mjs` 对 `npm pack` 后的安装产物重跑产品帮助、Control
doctor、产品 RPC 与上游 Pi RPC，并断言测试 Provider 不可见；三平台执行入口为
`.github/workflows/p0-p4.yml`。本地未伪造 Linux/macOS 已运行证据。

## 7. 第一批用户级场景

```powershell
picode run --cwd D:\repo --harness standard --permissions auto --prompt "检查项目"
picode session create --cwd D:\repo
picode session send --session <id> --message "继续"
picode harness set --session <id> --tier tdd
picode permissions set --session <id> --tier full
picode doctor tools
```

每条命令都必须可由 PowerShell/Bash/CI 直接断言 JSON，不解析终端颜色或 TUI。

## 8. 必须可红

1. `picode --help` 未列出 Control 命令。
2. 任一公共命令依赖已启动 TUI、Core 或 Debug HTTP。
3. stdout 混入日志、颜色或非 JSON 文本。
4. 非交互 ask 被静默允许。
5. 模型消息能伪造审批响应。
6. cancel 后迟到 Tool Result 进入 observer/Evidence。
7. Fixture Provider 出现在发布包可选模型中。
8. CLI 与 TUI 对同一 Session 的 Harness/Permission 读出不同事实。
9. Windows/Linux/macOS 对同一 fixture 产生不同协议语义。
