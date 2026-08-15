# Picode 无头模式使用手册

> 适用版本：Picode V3 开发版
> 无头模式直接启动并持有 vendored Pi，不需要先启动 TUI、Core 或调试服务器。

## 1. 快速检查

```powershell
picode --help
picode doctor
picode doctor tools
```

`doctor tools` 会分别报告 Git、pi-lens/LSP、MCP、Web Fetch 和 Web Search。默认按
当前目录与 Standard 检查；验证 pi-lens 时必须显式传入真实项目目录和 `--harness tdd`：

```powershell
picode tools doctor --cwd D:\repo --harness tdd
```

- `Ready`：当前工作区可以使用。
- `Degraded`：部分功能可用，输出会说明缺失部分。
- `NeedsSetup`：功能已存在，但需要用户配置。
- `Unavailable`：当前机器或平台不能使用。

可选能力处于 `NeedsSetup` 不代表 Picode 本身损坏。例如未配置 MCP Server 时，
整体 `healthy` 仍可为 `true`，同时 `needsSetup` 会列出 `mcp`。

## 2. 一次性无头运行

日常 CI、脚本和手工测试优先使用：

```powershell
picode run `
  --cwd D:\repo `
  --harness standard `
  --permissions auto `
  --prompt "检查项目并运行最相关的测试" `
  --non-interactive
```

可用参数：

| 参数 | 说明 |
|---|---|
| `--prompt <文本>` | 必填，发送给 Agent 的任务 |
| `--cwd <路径>` | 工作区；建议始终显式提供 |
| `--harness simple\|standard\|tdd` | 本次新会话的 Harness 档位 |
| `--permissions readonly\|auto\|full\|danger-full-access` | 本次新会话的权限档位 |
| `--provider <id>` | 指定 Provider |
| `--model <id>` | 指定模型 |
| `--session <id或jsonl路径>` | 在已有 Pi 会话上继续 |
| `--timeout-ms <毫秒>` | 最长执行时间 |
| `--non-interactive` | 遇到审批时 fail-closed，不等待终端交互 |

一次性命令没有审批回复通道，自动化时必须使用 `--non-interactive`。如果任务需要
在执行过程中批准命令，请使用后文的 `picode rpc`。

stdout 只输出版本化 JSONL。PowerShell 可逐行读取：

```powershell
picode run --cwd D:\repo --prompt "只检查状态" --non-interactive |
  ForEach-Object { $_ | ConvertFrom-Json }
```

典型终态事件：

- `run.completed`
- `approval.required`
- `gate.failed`
- `run.timeout`
- `run.cancelled`
- `run.error`

## 3. Harness 与权限选择

### Simple

```powershell
picode run --cwd D:\repo --harness simple --prompt "解释这个文件" --non-interactive
```

接近原版 Pi，不加载工程治理工具；适合只读分析和小任务。

### Standard

```powershell
picode run --cwd D:\repo --harness standard --permissions auto `
  --prompt "修复构建错误并运行测试" --non-interactive
```

适合日常开发，启用权限、沙箱、Todo、Subagent、Slice、结构化 Git 等能力。

### TDD

```powershell
picode run --cwd D:\repo --harness tdd --permissions auto `
  --prompt "先证明测试为红，再实现功能并完成集成验证" --non-interactive
```

要求 RED 证据后才允许生产实现写入，并经过目标 Gate、Review、Integration Smoke
和同快照确认。需要审批的 TDD 任务更适合使用 `picode rpc`。

权限档位：

- `readonly`：读取自动允许，副作用请求审批。
- `auto`：工作区内常规操作自动允许，Shell、网络等风险操作请求审批。
- `full`：常规操作放行，但破坏性操作和 Git 所有权操作仍必须确认。
- `danger-full-access`：对齐 Codex 完全访问；不询问审批并关闭 OS 沙箱，
  破坏性操作和 Git 所有权操作也直接放行。TDD Gate 与显式工作区 fence 不变。

`commit`、`merge`、`rebase`、`push`、删除分支不会因为 `full` 而自动放行；只有
用户明确选择 `danger-full-access` 才会无审批执行。

## 4. 会话管理

创建会话：

```powershell
picode session create --cwd D:\repo
```

列出会话：

```powershell
picode session list
```

验证会话身份：

```powershell
picode session resume --session <session-id>
```

无状态切换（校验并返回后续命令应使用的 Pi 会话身份）：

```powershell
picode session switch --session <session-id>
```

从某条用户消息创建独立 Pi 分支会话：

```powershell
picode session branch --session <session-id> --from <entry-id>
```

继续对话：

```powershell
picode session send --session <session-id> --message "继续" --non-interactive
```

读取追加式事件：

```powershell
picode session events --session <session-id>
picode session events --session <session-id> --since <entry-id>
```

会话也可使用绝对 `.jsonl` 路径；短 ID 必须能唯一匹配。

## 5. 修改已有会话的档位

```powershell
picode harness get --session <session-id>
picode harness set --session <session-id> --tier tdd

picode permissions get --session <session-id>
picode permissions set --session <session-id> --tier full
```

这些设置写入同一个 Pi Session append-only 日志，TUI 与 CLI 恢复时读取同一事实，
不会创建独立的无头配置副本。

## 6. Slice、Capsule 与并发写入权

```powershell
picode slice create --session <session-id> --intent "继续实现下一模块"
picode capsule list --task <task-id>
picode capsule read --task <task-id> --capsule <capsule-id>

picode worktree status
picode worktree claim --workspace D:\repo --task <task-id>
picode worktree release --workspace D:\repo --task <task-id>
```

`slice create` 直接执行 Picode `/slice`，封存 Capsule 并创建新的上游 Pi 会话，不调用模型。
显式 CLI claim 是持久写入租约，必须显式 release；第二个 Task 不能抢占仍有效的租约。

三级能力由用户控制，模型不可自行启用或信任：

```powershell
picode capability status
picode capability set --id herdr --state enabled
picode capability set --id herdr --state trusted
picode capability set --id herdr --state disabled
```

## 7. Task、Gate 与 Evidence

```powershell
picode task status --task <task-id>
picode task wait --task <task-id> --timeout-ms 60000
picode task cancel --task <task-id>

picode gate status --task <task-id>
picode gate evidence --task <task-id>
```

`task cancel` 写入取消请求；运行时通过受控事件进入终态。取消后的迟到 Tool Result
不能重新进入 Observer 或 Evidence。

## 8. 账号管理

列出账号：

```powershell
picode account list
```

切换同 Provider 的活动账号：

```powershell
picode account use --account <account-id>
```

启动本机 Web Import Wizard：

```powershell
picode account import
```

Wizard 只绑定 loopback，并使用一次性认证 URL。浏览器负责交互，账号事实仍写入
Picode Account Vault；它不是常驻 Web 后端。

## 9. Subagent 控制

```powershell
picode subagent status --session <session-id>
picode subagent status --session <session-id> --run <run-id>
picode subagent stop --session <session-id> --run <run-id>
picode subagent resume --session <session-id> --run <run-id> --message "继续"
```

这些命令通过 `pi-subagents` 的版本化控制协议执行，不要求模型代为调用工具。

## 10. 外部聊天预览与选择导入

```powershell
picode chat preview --source codex --path D:\history
picode chat import --source codex --path D:\history --select <selection-id>[,<selection-id>] --workspace D:\repo
```

`--source` 支持 `claude-code`（也接受 `claude`）、`codex`、`cursor`。目录预览只读直接子文件，
返回标题、最后一条对话截取、时间（来源具备时）、文件大小和 `selectionId`；预览不会落导入副本。
只有 `--select` 明确列出的聊天才会持久化、按当前工作区绑定并创建新的 Pi 会话；默认非归档。

## 11. 工具搜索与诊断

```powershell
picode tools search
picode tools search --query mcp
picode tools doctor
# 同义入口
picode doctor tools
# 按真实 TDD 工作区检查匹配的 LSP
picode tools doctor --cwd D:\repo --harness tdd
```

当前约定：

- Git：必须存在 Git；非 Git 目录显示 `NeedsSetup`。
- pi-lens：按项目语言匹配 Server；只有 TypeScript+typescript-language-server 或
  Rust+rust-analyzer 等匹配组合才是 `Ready`，不匹配或缺失时显示 `Degraded`。
- MCP：没有任何 Server 配置时显示 `NeedsSetup`，建议在 TUI 运行 `/mcp setup`。
- Web Fetch：可独立工作。
- Web Search：pi-web-access 带零配置 Exa fallback；配置其他 Provider 是可选增强。

探针不会安装程序、执行 OAuth、发起真实搜索或消费付费 API。

## 12. 长生命周期 NDJSON RPC

启动：

```powershell
picode rpc
```

协议规则：

- stdin：每行一个 JSON 请求。
- stdout：每行一个 JSON 响应或事件。
- stderr：诊断信息。
- 当前协议版本为 `1`。
- `id` 由客户端生成，用来关联流式事件与请求。

启动任务：

```json
{"version":1,"id":"run-1","method":"run.start","params":{"prompt":"运行测试","cwd":"D:/repo","provider":"openai","model":"gpt-model","timeoutMs":120000}}
```

运行开始后会收到包含真实身份的事件：

```json
{"version":1,"id":"run-1","event":"run.started","payload":{"runId":"...","executionEpoch":1,"sessionId":"...","sessionFile":"..."}}
```

审批请求：

```json
{"version":1,"id":"run-1","event":"approval.required","payload":{"id":"approval-id","method":"select","title":"..."}}
```

回复审批：

```json
{"version":1,"id":"approval-1","method":"approval.respond","params":{"requestId":"approval-id","action":"once"}}
```

`action` 可为：

- `once`
- `session`
- `session-full`
- `session-unrestricted`（本会话不再产生 Operation Intent 审批；等同 `danger-full-access`）
- `deny`

取消运行时使用 `run.started.payload.runId`，不要使用请求 `id`：

```json
{"version":1,"id":"cancel-1","method":"run.cancel","params":{"runId":"运行ID"}}
```

RPC 也能执行全部普通 CLI 命令：

```json
{"version":1,"id":"cmd-1","method":"command.execute","params":{"argv":["permissions","get","--session","会话ID"]}}
```

返回值中包含 `exitCode`、解析后的 `stdout` 数组和 `stderr` 数组。

RPC 客户端必须持续读取 stdout，并在收到 `approval.required` 后再发送响应。静态管道
无法预先知道动态 `requestId`，因此需要 Node、Python、C# 或其他能够双向保持子进程
stdin/stdout 的程序。

## 13. 稳定退出码

| 退出码 | 含义 |
|---:|---|
| `0` | 完成 |
| `2` | Gate 失败 |
| `3` | 非交互模式需要审批 |
| `4` | 超时 |
| `5` | 已取消 |
| `64` | 命令或参数用法错误 |
| `70` | 内部错误 |

PowerShell 示例：

```powershell
picode run --cwd D:\repo --prompt "运行检查" --non-interactive
switch ($LASTEXITCODE) {
  0  { "完成" }
  2  { "Gate 失败" }
  3  { "需要审批；改用 picode rpc" }
  4  { "超时" }
  5  { "任务已取消" }
  64 { "参数错误" }
  default { "内部错误：$LASTEXITCODE" }
}
```

## 11. 数据与安全边界

- Picode 数据默认在 `~/.picode/`，与系统 Pi 隔离。
- 可用 `PICODE_DIR` 指向测试目录。
- 正常 CLI/RPC 不打开 Debug HTTP 端口。
- `PICODE_DEBUG_API=1` 只用于内部诊断，不是公共自动化接口。
- stdout 不应混入 TUI 颜色、日志或普通文本；自动化只解析 JSON/JSONL。
- 无头进程退出时，它拥有的未完成 Work 会停止；P0–P4 没有常驻 Core。

隔离测试数据：

```powershell
$env:PICODE_DIR = "$env:TEMP\picode-headless-test"
picode doctor
```

## 12. 常见问题

### 返回退出码 3

任务请求了必须确认的操作。一次性无头命令按设计拒绝；改用 `picode rpc` 并响应
`approval.required`，或在确认风险后调整 Permission Tier。

### MCP 是 NeedsSetup

代表尚未配置 Server，不是 Picode 损坏。在 TUI 中运行 `/mcp setup`，完成后重新
启动会话或再次运行 `picode doctor tools`。

### Git 是 NeedsSetup

当前 `--cwd` 不是 Git 仓库。选择正确工作区或由用户明确初始化仓库。

### 找不到模型

先运行 `picode account list`，确认账号处于 `active`，或在 `run` 中显式指定
`--provider` 与 `--model`。模型与 Provider 的可用性仍以 vendored Pi Registry 为准。

### 需要查看原版 Pi TUI

```powershell
picode
# 或显式写法
picode tui
```
