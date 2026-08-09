# Picode V3 无头完整产品测试指南

> 适用对象：独立测试人员、同事或外部 Agent。
> 测试口径：把 Picode 当成已交付产品，只通过公开 CLI/RPC 使用；源码测试不能替代产品验收。
> 当前重点：Windows；Linux/macOS 应使用同一清单复测平台相关项目。

## 1. 判定规则

每项只能记录以下状态：

| 状态 | 含义 |
|---|---|
| `PASS` | 公开产品入口实际运行，结果和副作用均符合预期 |
| `FAIL` | 实际运行失败、卡死、错误副作用或结果不符 |
| `PARTIAL` | 部分链路通过，但缺少必要终点或证据 |
| `BLOCKED` | 缺账号、API、MCP Server、LSP、平台或其他外部条件 |
| `NOT RUN` | 尚未执行；不能折算为通过 |

必须遵守：

1. 不以 `bun run test`、Vitest 或源码检查替代产品测试。
2. 每项保留原始命令、退出码、JSON/JSONL 输出和生成文件。
3. 遇到失败先保留现场，不要立即清空隔离目录。
4. 不把 API Key、OAuth Token、Cookie 或密码写入报告。
5. `commit/merge/rebase/push` 只验证会要求确认；不要真的发布远程代码。

## 2. 测试准备

### 2.1 确认被测版本

在仓库根目录或正式安装目录运行：

```powershell
picode --help
picode doctor
picode doctor tools
```

如果尚未全局安装，可将后文所有 `picode` 替换为：

```powershell
node D:\otherproject\picode\v3\bin\picode.mjs
```

记录以下信息：

```powershell
node --version
npm --version
git --version
$PSVersionTable.PSVersion
Get-Command picode | Format-List Source
```

### 2.2 建立完全隔离的状态和工作区

PowerShell：

```powershell
$TestStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$PicodeTestRoot = Join-Path $env:TEMP "picode-product-test-$TestStamp"
$PicodeWorkspace = Join-Path $PicodeTestRoot "workspace"
$PicodeEvidence = Join-Path $PicodeTestRoot "evidence"
New-Item -ItemType Directory -Path $PicodeWorkspace,$PicodeEvidence | Out-Null
$env:PICODE_DIR = Join-Path $PicodeTestRoot "state"

Set-Location $PicodeWorkspace
git init
git config user.name "Picode Product Test"
git config user.email "picode-test@example.invalid"
Set-Content -LiteralPath README.md -Value "# Picode black-box fixture" -Encoding utf8
git add README.md
git commit -m "test fixture baseline"
```

测试期间始终保留同一个 PowerShell 窗口，避免丢失 `$env:PICODE_DIR`。确认隔离：

```powershell
picode doctor
picode session list
```

输出中的 agent/session 路径必须位于 `$PicodeTestRoot`，不能写入日常 `~/.picode`。

### 2.3 准备项目规则

```powershell
Set-Content AGENTS.md "When testing, mention marker AGENTS-ROOT-42." -Encoding utf8
Set-Content CLAUDE.md "Mention marker COMPAT-CLAUDE-42." -Encoding utf8
New-Item -ItemType Directory .cursor\rules | Out-Null
Set-Content .cursor\rules\test.mdc "Mention marker CURSOR-RULE-42." -Encoding utf8
```

## 3. 基础启动与诊断

### H01 — 启动和产品帮助

```powershell
picode --help 2>&1 | Tee-Object "$PicodeEvidence\H01-help.txt"
picode doctor 2>&1 | Tee-Object "$PicodeEvidence\H01-doctor.json"
picode doctor tools 2>&1 | Tee-Object "$PicodeEvidence\H01-tools.json"
```

通过条件：

- 帮助列出 `run/session/subagent/slice/capsule/worktree/capability/chat`。
- `doctor` 中 vendored Pi、Picode Extension、agent-dir 健康。
- 未配置的 MCP/LSP 可以是 `NeedsSetup/Degraded`，但不能伪报 Ready。
- 普通启动不打开常驻 Debug HTTP 端口。

### H02 — 三档 Harness 和权限持久化

```powershell
$Created = picode session create --id product-test --cwd $PicodeWorkspace | ConvertFrom-Json
$Session = $Created.payload.sessionFile
picode harness set --session $Session --tier standard
picode permissions set --session $Session --tier auto
picode harness get --session product-test
picode permissions get --session product-test
```

关闭当前命令后再次执行 get。通过条件：档位仍为 `standard/auto`，且写入同一 Pi JSONL 会话。

## 4. Agent Loop、上下文和原生工具

以下项目需要一个可用账号/Provider。先执行：

```powershell
picode account list
```

如为空，执行 `picode account import`，在打开的本机网页中完成导入。命令应先输出
`account.import.ready` 和一次性 loopback URL，不能等待浏览器关闭后才输出。

### H03 — Standard 完整基础工具

```powershell
picode run --cwd $PicodeWorkspace --harness standard --permissions auto --non-interactive `
  --prompt "读取项目规则；列目录；搜索 marker；读取 README；创建 test-a.txt，写入 alpha，再编辑为 beta；运行 PowerShell 输出当前目录、中文测试和 node --version；最后报告三个规则 marker。" `
  2>&1 | Tee-Object "$PicodeEvidence\H03-standard.jsonl"
```

若返回 `approval.required`，记录请求是否确实有副作用。纯 `read/grep/find/ls/search_tools search`
不应要求批准；写文件或 Shell 可以按策略要求批准。需要交互批准时改用第 12 节 RPC。

通过条件：

- 模型实际调用 `read/write/edit/bash/grep/find/ls` 中相关工具。
- `test-a.txt` 最终为 `beta`。
- PowerShell cwd 等于 `$PicodeWorkspace`，中文不乱码。
- 回答包含三个规则 marker。

### H04 — Readonly 和 Full 权限边界

```powershell
picode run --cwd $PicodeWorkspace --harness standard --permissions readonly --non-interactive `
  --prompt "创建 readonly-must-not-exist.txt" `
  2>&1 | Tee-Object "$PicodeEvidence\H04-readonly.jsonl"
Test-Path readonly-must-not-exist.txt

picode run --cwd $PicodeWorkspace --harness standard --permissions full --non-interactive `
  --prompt "创建 full-write.txt，随后尝试 git commit，但不要绕过任何确认。" `
  2>&1 | Tee-Object "$PicodeEvidence\H04-full.jsonl"
```

通过条件：readonly 不产生文件；full 可进行普通写入；Git commit 仍要求显式确认且没有自动提交。

### H05 — Todo

```powershell
picode run --cwd $PicodeWorkspace --harness standard --permissions auto --non-interactive `
  --prompt "建立三项 Todo：读取 README、检查 git status、总结结果；逐项执行并更新为完成。" `
  2>&1 | Tee-Object "$PicodeEvidence\H05-todo.jsonl"
```

通过条件：过程输出可看到 Todo 状态变化，最终没有虚假的未完成项。

## 5. 会话生命周期

### H06 — 列表、恢复、发送和事件

从 H03 的 `run.started.payload` 取得 `sessionId/sessionFile`：

```powershell
picode session list
picode session resume --session <session-id>
picode session switch --session <session-id>
picode session send --session <session-id> --message "只回答：此前创建的文件名是什么？" --non-interactive
picode session events --session <session-id>
```

通过条件：恢复后保留上下文；switch 返回同一 Pi 身份；events 是追加式条目。

### H07 — 分支

从 `session events` 选择一条用户消息的 `entryId`：

```powershell
picode session branch --session <session-id> --from <user-entry-id>
```

通过条件：返回新的 `sessionId/sessionFile`；原会话仍存在；新会话具有正确 parent/分支上下文。

### H08 — 压缩

```powershell
picode session send --session <session-id> --message "/compact 保留目标、未完成事项和测试证据" --non-interactive
```

通过条件：产生 Pi compaction 事件；短会话可以诚实返回 Nothing to compact；不得把 `/compact` 发给模型当普通问题。

## 6. Slice、Capsule 和抗失真

### H09 — 手动切片

```powershell
picode slice create --session <session-id> --intent "继续下一阶段：验证缓存模块"
```

记录返回的新 `sessionId` 及消息中的 `capsuleId/taskId`：

```powershell
picode capsule list --task <task-id>
picode capsule read --task <task-id> --capsule <capsule-id>
```

通过条件：

- Capsule 为 `picode.capsule/v1`、`sealed` 且有 digest。
- 事实区包含任务、工作区和来源指针。
- 创建 fresh Pi session，并注入同一 Capsule。
- 新会话不会自动开始工作，需用户输入“继续”。

## 7. Worktree 与 Git 所有权

### H10 — 并发写入拒绝

```powershell
picode worktree claim --workspace $PicodeWorkspace --task task-a
picode worktree claim --workspace $PicodeWorkspace --task task-b
picode worktree status
picode worktree release --workspace $PicodeWorkspace --task task-a
picode worktree claim --workspace $PicodeWorkspace --task task-b
picode worktree release --workspace $PicodeWorkspace --task task-b
```

通过条件：第一次成功；第二个 Task 被拒绝；释放后 task-b 才能接管。不要把冲突退出码 70 误报成崩溃，必须结合 stderr 的 ownership 原因判断。

### H11 — 结构化 Git

让 Standard Agent 执行 status/diff/log、建安全分支或 managed worktree。通过条件：读取类操作正常；
commit/merge/rebase/push/delete branch 始终需要用户确认；程序不自动 push/merge。

## 8. TDD 完整闭环

准备一个最小但真实的跨文件功能：

```powershell
Set-Content package.json '{"scripts":{"test":"node --test"},"type":"module"}' -Encoding utf8
New-Item -ItemType Directory src,test -Force | Out-Null
Set-Content test\counter.test.js @'
import test from "node:test";
import assert from "node:assert/strict";
import { increment } from "../src/counter.js";
test("increments", () => assert.equal(increment(1), 2));
'@ -Encoding utf8
git add .
git commit -m "add red gate fixture"
```

### H12 — RED → GREEN → Review → Integration

```powershell
picode run --cwd $PicodeWorkspace --harness tdd --permissions auto `
  --prompt "完成 counter 功能。必须先运行并记录现有 RED，再做最小实现，运行目标 Gate、fresh review、integration smoke 和同快照确认；不要 commit。" `
  2>&1 | Tee-Object "$PicodeEvidence\H12-tdd.jsonl"
```

通过条件：

- 在生产代码写入前存在真实失败证据。
- RED Gate 有能力红，不接受零匹配、skipped 或 not-run。
- GREEN 后有目标 Gate、Review、Integration 和同快照确认。
- `picode gate status --task <task-id>` 与 `gate evidence` 可查到证据。
- 达到预算上限时诚实 QA Handoff，不无限循环。

## 9. Subagent

### H13 — 启动、状态、等待和结果

```powershell
picode run --cwd $PicodeWorkspace --harness standard --permissions auto `
  --prompt "启动一个最小只读子代理，读取 AGENTS.md 的 marker 后返回；报告 run-id、子代理模型和结果。" `
  2>&1 | Tee-Object "$PicodeEvidence\H13-subagent.jsonl"
```

记录 run-id：

```powershell
picode subagent status --session <session-id>
picode subagent status --session <session-id> --run <run-id>
```

通过条件：独立模型/角色可见，结果回到主会话，主上下文没有被后台输出无条件抢占。

### H14 — Stop/Resume

启动一个足够长的异步子任务，然后：

```powershell
picode subagent stop --session <session-id> --run <run-id>
picode subagent status --session <session-id> --run <run-id>
picode subagent resume --session <session-id> --run <run-id> --message "从当前 transcript 继续，只完成原目标"
```

通过条件：命令直接走 pi-subagents 控制协议，不让模型代操作；stop 有明确终态；仅可恢复的状态允许 resume；上下文和模型选择正确。

## 10. 能力、Skills、Web、LSP 和 MCP

### H15 — 三级能力

```powershell
picode capability status
picode capability set --id herdr --state enabled
picode capability status
picode capability set --id herdr --state trusted
picode capability status
picode capability set --id herdr --state disabled
```

通过条件：状态按 Disabled → Enabled → Trusted 变化并持久化；Disabled 对模型搜索不可见；模型不能自行 Trust。

### H16 — `/plan` 与 grill-with-docs

```powershell
picode session send --session <session-id> --message "/plan 设计一个小型存档模块" --non-interactive
```

通过条件：直接注入已携带的 `grill-with-docs` skill block；不加载独立 pi-plan-mode/pi-goal；不让模型通过 MCP/Subagent 搜索 Skill。

### H17 — Web

让 Agent 搜索一个公开页面并抓取正文。通过条件：

- 普通网络可用。
- 使用 TUN/fake-IP 时只自动允许 `198.18.0.0/15`。
- localhost、私网和 metadata 地址仍被 SSRF 拒绝。
- 未配置搜索 Provider 时 readiness 诚实展示 fallback/NeedsSetup。

### H18 — LSP

在安装了对应语言服务器的 TypeScript/C#/Rust 项目中运行 TDD 会话并触发诊断。通过条件：真实 LSP Ready、诊断可见；缺 Server 时是 Degraded/NeedsSetup，不是假 Ready。

先用产品入口验证工作区与档位匹配，不要用默认 Standard 结果代替 TDD：

```powershell
picode tools doctor --cwd $PicodeWorkspace --harness tdd `
  2>&1 | Tee-Object "$PicodeEvidence\H18-tools-doctor.json"
```

TypeScript 项目必须存在 `tsconfig.json` 或 `package.json`，Rust 项目必须存在
`Cargo.toml`；安装了不匹配语言的 Server 仍应报告 `Degraded`。

### H19 — MCP

先由测试人员配置一个无敏感数据的测试 MCP Server，再运行：

```powershell
picode doctor tools
picode tools search --query mcp
```

让 Agent 完成 discover → describe → call。通过条件：无 Server 时 `NeedsSetup`；有 Server 时懒连接；调用经过 Guard 审批；Server 崩溃不会拖垮 Pi 主循环。

## 11. 账号、模型和聊天导入

### H20 — 账号

```powershell
picode account list
picode account import
picode account use --account <account-id>
```

分别验证官方 OAuth、自定义 OpenAI-compatible 和反代配置。报告只记录 provider、label、模型与是否可聊天，禁止记录密钥。

### H21 — 聊天轻量预览

使用真实或脱敏的 Claude Code/Codex/Cursor JSONL 目录：

```powershell
picode chat preview --source codex --path D:\safe-history
```

通过条件：递归扫描但不跟随符号链接；每项显示标题、最近消息截取、时间（来源有时）、大小和 selectionId；默认非归档；大量文件时不全文扫描、不长时间卡死。

### H22 — 选择导入和工作区绑定

```powershell
picode chat import --source codex --path D:\safe-history `
  --select <id-1>,<id-2> --workspace $PicodeWorkspace
```

通过条件：只导入被选项；导入后是 Picode 自有副本；创建 Task 和 Pi session；历史 system/tool/思考不直接执行；重复导入同一工作区复用已有会话，不制造重复项；换工作区不会静默覆盖原绑定。

对 `claude-code` 和 `cursor` 重复 H21/H22。

## 12. 长生命周期 RPC 审批

运行：

```powershell
picode rpc
```

客户端按行发送：

```json
{"version":1,"id":"run-1","method":"run.start","params":{"cwd":"D:/repo","prompt":"运行只读检查后创建 rpc.txt","harnessTier":"standard","permissionTier":"auto"}}
```

收到 `approval.required` 后，以动态 requestId 回复：

```json
{"version":1,"id":"approve-1","method":"approval.respond","params":{"requestId":"动态ID","action":"once"}}
```

依次验证 `once`、`session`、`session-full`、`deny`。通过条件：

- once 只放行一次。
- session 只放行同一命令指纹。
- session-full 放行本会话常规操作，但不放行 Git 所有权/破坏性操作。
- 修改已批准命令内容后必须重新询问。
- deny 不产生副作用。

矩阵的每个 action 必须使用全新的 `PICODE_DIR` 子目录、唯一目标文件和独立 RPC
进程；运行前断言目标文件不存在。禁止复用前一项的 Grant、Session 或副作用文件。
连续执行两个相同命令时，`once` 应询问两次，`session` 和 `session-full` 应只询问一次。

## 13. 故障恢复

### H23 — 配置损坏

只允许操作隔离目录：

```powershell
$ConfigPath = Join-Path $env:PICODE_DIR "config.json"
if (-not $ConfigPath.StartsWith($PicodeTestRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to modify a non-test config path"
}
if (Test-Path $ConfigPath) { Copy-Item $ConfigPath "$ConfigPath.before-corruption" }
Set-Content -LiteralPath $ConfigPath -Value '{broken-json' -Encoding utf8
picode doctor
Get-ChildItem $env:PICODE_DIR -Filter 'config.json*'
```

通过条件：坏文件被 quarantine；known-good 或安全默认值恢复；程序不崩溃；不读取日常配置。

### H24 — 超时、取消和迟到结果

用 RPC 启动长任务，分别测试 `--timeout-ms` 和 `run.cancel`。通过条件：只有一个终态；取消后的迟到 Tool Result 不得恢复任务或写 Evidence。

### H25 — 重启恢复

在任务中途终止 Picode 进程，再用 session/task 命令恢复。通过条件：append-only JSONL 可读；损坏尾行被隔离或诚实报告；不会重复执行已经完成的副作用。

## 14. 打包与跨平台

### H26 — 全新安装

在全新目录安装正式 tarball/包，而不是仓库 node_modules，然后重复 H01、H02、H03、H06。通过条件：vendored Pi 和 Extension 随包存在，不依赖开发仓库路径。

### H27 — Linux/macOS

在 Linux 和 macOS 重复 H01–H26 中适用项，重点记录：

- `/` 路径和 Windows 路径不会互相污染。
- Shell provider、中文、空格路径、Git worktree 正常。
- Linux bubblewrap/macOS sandbox 策略符合档位。
- 从 Windows 导入的 workspace 必须重新绑定，不写入不存在的盘符。

Windows 强 OS 沙箱属于 P5；当前测试应验证 Guard 权限和明确告警，不能将其误报为强沙箱通过。

## 15. 最终报告模板

```markdown
# Picode 无头产品验收报告

- 测试人：
- 日期：
- Git commit/版本：
- OS/版本：
- Node/npm/Git：
- Provider/模型（不含秘密）：
- PICODE_DIR：隔离路径

| ID | 状态 | 耗时 | 证据文件 | 备注/复现命令 |
|---|---|---:|---|---|
| H01 | PASS | | | |
| H02 | | | | |
...
| H27 | | | | |

## 严重问题

### P0
- 数据丢失、越权写入、安全边界绕过、所有聊天不可用、无法启动。

### P1
- 核心 Harness/TDD/会话/账号/工具主路径失败，无安全替代路径。

### P2
- 局部功能失败、明显性能问题、错误提示导致无法恢复。

## 未运行与阻塞

- 项目：
- 原因：
- 所需环境：

## 总结

- PASS：
- FAIL：
- PARTIAL：
- BLOCKED：
- NOT RUN：
- 发布建议：Go / Conditional Go / No-Go
```

## 16. 清理

确认报告和证据已复制后：

```powershell
picode worktree status
```

释放所有本轮 claim。然后只删除第 2.2 节明确创建的 `$PicodeTestRoot`；不要删除日常
`~/.picode`、其他工作区或未确认的 Git worktree。若测试发现 P0/P1 问题，应先保留整个目录供复现。
