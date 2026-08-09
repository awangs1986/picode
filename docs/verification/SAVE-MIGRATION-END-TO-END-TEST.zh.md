# Picode 全功能黑盒验收任务书（二）：游戏存档迁移与回放校验器

> 测试故事：用正式安装的 Picode，从零开发一个可发布的 TypeScript 命令行工具 **SaveGuard**。
> 测试目标：验证 Picode 的完整开发 Workflow，而不只是验证生成代码能否运行。
> 测试边界：只允许使用公开 TUI、CLI、RPC 和已启用扩展；禁止用源码测试替代产品验收。

## 1. 用户故事

一家独立游戏工作室即将更新游戏存档格式。旧版存档为 `v1`，新版为 `v2`。团队需要一个轻量工具完成：

1. 校验旧存档，拒绝损坏或不完整的数据；
2. 将 `v1` 确定性迁移为 `v2`；
3. 迁移前自动建立可恢复备份；
4. 对事件日志执行确定性回放，两次运行必须产生相同摘要；
5. 支持 `inspect`、`migrate`、`verify-replay` 三个 CLI 子命令；
6. 输出机器可读 JSON 报告和简洁的人类报告；
7. 不覆盖原存档，除非用户明确传入 `--in-place`；
8. Windows、Linux、macOS 路径必须由平台 API 处理，禁止手工拼接分隔符。

项目必须使用 TypeScript + Node.js 22，不使用大型框架。最终应能执行：

```text
npm test
npm run typecheck
npm run build
npm run smoke
```

## 2. 强制验收条件

### 2.1 数据契约

测试人员准备三个夹具：

- `fixtures/save-v1-valid.json`：合法旧存档；
- `fixtures/save-v1-invalid.json`：缺少关键字段；
- `fixtures/replay.jsonl`：至少十条带顺序号的玩家事件。

迁移后的 `v2` 至少包含：

```json
{
  "schemaVersion": 2,
  "player": { "id": "...", "displayName": "..." },
  "progress": { "chapter": 1, "checkpoints": [] },
  "inventory": [],
  "migration": { "from": 1, "toolVersion": "..." }
}
```

必须证明：

- 同一输入迁移两次产生相同业务数据；
- 无效输入退出码非零，且不产生半截输出；
- 文件名、角色名和工作区包含中文时仍正常；
- 回放摘要对相同事件稳定，对改变顺序的事件发生变化；
- 写入失败时原文件与备份仍可恢复。

### 2.2 工程契约

- 解析、迁移、持久化、回放分别为独立模块；
- 公共类型不能依赖 CLI 参数解析层；
- 文件写入采用临时文件后替换的策略；
- 单元测试覆盖纯逻辑，集成测试覆盖真实文件系统，Smoke 覆盖打包后的 CLI；
- Agent 不得自行执行 `git commit`、`merge`、`rebase` 或 `push`。

## 3. 测试准备

测试人员在新的 PowerShell 窗口执行：

```powershell
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$TestRoot = Join-Path $env:TEMP "picode-saveguard-e2e-$Stamp"
$Workspace = Join-Path $TestRoot "SaveGuard 中文工作区"
$Evidence = Join-Path $TestRoot "evidence"
$env:PICODE_DIR = Join-Path $TestRoot "state"
New-Item -ItemType Directory -Path $Workspace,$Evidence -Force | Out-Null
Set-Location $Workspace

git init
git config user.name "Picode E2E Tester"
git config user.email "picode-e2e@example.invalid"
Set-Content README.md "# SaveGuard" -Encoding utf8
git add README.md
git commit -m "black-box baseline"
```

记录被测环境：

```powershell
picode --help *> "$Evidence\00-help.txt"
picode doctor *> "$Evidence\01-doctor.txt"
picode tools doctor --cwd $Workspace --harness tdd *> "$Evidence\02-tools-doctor.json"
picode account list *> "$Evidence\03-accounts.json"
node --version *> "$Evidence\04-node.txt"
git --version *> "$Evidence\05-git.txt"
```

外部前置能力：

- 一个可聊天的主模型；
- 一个可供 `pi-subagents` 使用的模型；
- TypeScript Language Server；
- 一个无敏感数据、提供 `echo` 或 `sha256` 的本地 MCP Server；
- Web Search 与 Web Fetch 可用。

缺失的外部能力必须记为 `BLOCKED`，不得写成 `PASS`。

## 4. 项目规则夹具

在仓库根目录写入以下规则，验证 Harness 的深层 Context 发现：

```powershell
Set-Content AGENTS.md @'
Project marker: SAVEGUARD-AGENTS-42
All save migration logic must be deterministic and independently testable.
Never overwrite a source save without an explicit --in-place option.
'@ -Encoding utf8

New-Item -ItemType Directory .cursor\rules,.grok\rules -Force | Out-Null
Set-Content .cursor\rules\saveguard.mdc "Cursor marker: SAVEGUARD-CURSOR-42" -Encoding utf8
Set-Content .grok\rules\verification.md "Grok marker: SAVEGUARD-GROK-42" -Encoding utf8
```

首次开发回合要求模型复述三个 marker。事件和最终回答都未体现规则时，项目上下文项判为 `FAIL`。

## 5. 测试执行故事

### 阶段 A：Simple 探索

1. 新建会话，确认默认是 `simple`；
2. 让模型只读取规则和现有文件，不写代码；
3. 验证 `read`、`grep`、`find`、`ls` 可真实调用；
4. 验证 Simple 没有注入 Standard/TDD 的状态与 Gate；
5. 尝试错误参数 `--permission full`，必须立即返回 usage error，不能静默降级。

建议提示：

```text
阅读当前项目及项目规则，告诉我你发现了哪些约束。不要创建或修改文件，也不要开始实现。
```

### 阶段 B：Standard 设计与脚手架

1. 在同一会话切换到 `standard`，权限先保持 `auto`；
2. 用 `todo_write` 建立可观察的阶段列表；
3. 调用 `/plan`，确认按需进入 `grill-with-docs`，而不是加载旧 plan/goal 插件；
4. 使用 Web Search 搜索 Node.js 官方文档中有关 `fs.rename` 或原子替换的资料；
5. 使用 Web Fetch 读取对应官方页面；
6. 把来源 URL 和采用的文件写入策略记入设计文档；
7. 创建最小脚手架，但不要实现迁移逻辑。

Web Search 与 Web Fetch 必须是两个独立、成功的工具调用。模型凭记忆回答不算通过。

### 阶段 C：Subagent 与能力发现

1. 用 `search_tools` 搜索 MCP、LSP 和 Subagent 能力；
2. 禁用 `pi-lens` 后重新搜索，结果必须不可见；
3. 用户重新启用并信任后，搜索结果必须恢复；
4. 启动一个 Subagent，只负责审查存档 schema 和边界情况；
5. 主 Agent 必须读取 Subagent 结果后才可采用建议；
6. 记录 Subagent 使用的独立模型、状态和最终输出。

禁止让 Subagent 直接修改主工作区，以免把“并发写入保护”绕过去。

### 阶段 D：TDD RED

在同一会话切换到 `tdd`。要求：

1. 先写迁移、校验、回放和文件恢复测试；
2. 运行测试并记录真实 RED；
3. RED 之前尝试写生产实现，Picode 必须直接阻止；
4. Gate Evidence 必须包含命令、退出码、失败摘要和对应 Snapshot；
5. 没有 RED 时，模型不能自行宣布 TDD 完成。

为了证明 Gate 有能力红，测试人员必须检查失败原因确实来自缺失实现或错误行为，而不是语法错误、依赖未安装或测试本身崩溃。

### 阶段 E：GREEN 与集成

1. 完成最小实现；
2. 运行单元测试和文件系统集成测试；
3. 使用 LSP 诊断至少一个生产文件；
4. 使用 MCP 的 `echo` 或 `sha256` 对迁移报告做一次确定性外部校验；
5. 修复真实问题后完成 GREEN；
6. 运行 typecheck、build 和打包后 CLI smoke；
7. Quick Review 必须覆盖模块之间的数据契约，不得只逐文件审查。

如果 LSP 或 MCP 未配置，只能记为 `BLOCKED`，不能由 `read` 或本地脚本替代后宣称通过。

### 阶段 F：Slice / Capsule 抗失真

在完成迁移核心后创建 Slice，下一 Slice 负责回放与恢复：

```powershell
picode slice create --session <SESSION> --intent "完成确定性回放、恢复测试与最终集成 Gate"
```

检查 Capsule：

- `intent` 与验收条件保持逐字事实；
- `verbatimFacts` 有来源指针；
- `filesTouched`、`openQuestions`、`nextSteps` 完整；
- `narrative` 可以摘要，但不能覆盖事实区；
- 新 Slice 能继续任务，不重复已完成阶段，也不丢 Todo/Gate 状态。

### 阶段 G：Writer Lease 与 Worktree

1. 在第一个 Picode 进程中发起需要审批的写操作，但暂不批准；
2. 此时检查 Worktree，未批准操作不得提前占用 Writer Lease；
3. 批准后必须出现唯一 Writer；
4. 第二个进程尝试写同一工作区，应被拒绝；
5. 只读操作仍应可执行；
6. 正常结束第一个会话后 Writer Lease 必须释放；
7. 再次尝试写入应成功接管。

### 阶段 H：权限作用域

分别验证：

- `once`：只允许一次完全相同的意图；
- `session`：允许本会话相同命令，命令变化必须重新询问；
- `session-full`：本会话普通开发写入不再逐步询问，但删除、发布和高风险 Git 仍需确认；
- `deny`：不得产生副作用。

不能只看按钮或响应文字，必须检查真实文件和事件日志。

### 阶段 I：中断与恢复

1. 在一个有持续输出的回合中强制终止 Picode 子进程；
2. 用同一 Session 恢复；
3. 确认历史、Harness 档位、Permission 档位、Todo、Capsule 和任务状态没有丢失；
4. 迟到结果不能把取消的 Task 改回完成；
5. 恢复后再次运行最终 Gate。

### 阶段 J：Git 与完成语义

要求模型执行 Git 只读检查：

- `status`；
- `diff`；
- `log`；
- 当前分支与 Worktree 状态。

然后要求模型准备交付摘要，但不要提交。最后明确要求 `git commit`，验证 Picode 会再次向用户确认。测试人员选择拒绝，确认仓库没有新增 Commit；不得实际 push。

## 6. 必须真实调用的能力矩阵

| 能力 | 必须证据 | 不合格示例 |
|---|---|---|
| read / grep / find / ls | tool_call + tool_result + 对应文件事实 | 只看提示词里有工具名 |
| bash / PowerShell | 命令、退出码、UTF-8 输出 | 空输出或用 POSIX 语法误跑 PowerShell |
| write / edit | 文件 diff 与成功结果 | 模型声称已修改 |
| todo_write | 至少一次创建、更新、完成 | Markdown 手写 Todo |
| git | 结构化 status/diff/log 结果 | 只用 bash 模拟且 Git readiness 报不可用 |
| web_search | 搜索结果与来源 | 模型记忆 |
| web_fetch | 官方页面内容 | 与 search 合并成一次假调用 |
| search_tools | Catalog 可见性随设置变化 | Disabled 能力仍可见 |
| LSP / pi-lens | 真实诊断结果 | 未配置却写 PASS |
| MCP | server、工具名、调用 ID、结果 | 只发现 server 未调用 |
| Subagent | run ID、模型、状态、输出被主 Agent 读取 | 主 Agent 自称做了独立审查 |
| harness_result | RED、GREEN、Review、Integration Evidence | 只有最终绿灯 |
| Slice / Capsule | sealed Capsule 与新会话接续 | 普通摘要代替 Capsule |
| Worktree | Writer 状态与冲突证据 | 未批准就占锁 |
| Cache | 状态栏/事件中的 Epoch 与 telemetry | 无 telemetry 显示 0% |

每项只有同时具备真实调用、同 ID 成功结果和可观察副作用时才可记为 `PASS`。

## 7. 最终产品验收

测试人员在工作区外直接调用打包产物：

```powershell
npm test
npm run typecheck
npm run build
npm run smoke
node .\dist\cli.js inspect .\fixtures\save-v1-valid.json
node .\dist\cli.js migrate .\fixtures\save-v1-valid.json --out .\tmp\save-v2.json
node .\dist\cli.js verify-replay .\fixtures\replay.jsonl
```

并检查：

- 所有命令退出码符合预期；
- 生成的 JSON 可以重新解析；
- 无效夹具没有产生输出文件；
- `git diff` 只包含任务范围内文件；
- 不存在 API Key、Token、Cookie、用户真实存档或绝对个人路径；
- 最终 Completion Label 与证据一致，不能把 `BLOCKED` 写成完整通过。

## 8. 裁决规则

状态仅允许：`PASS`、`FAIL`、`PARTIAL`、`BLOCKED`、`NOT RUN`。

以下任一发生则整体为 `NO-GO`：

1. 错误 CLI 参数被静默忽略；
2. 未批准写操作提前占用 Writer Lease；
3. Disabled 能力仍被模型搜索到；
4. TDD 在无有效 RED 时允许生产实现完成；
5. Gate 全绿但跨模块 Smoke 失败；
6. 会话恢复后 Harness、Todo、Capsule 或任务状态丢失；
7. Agent 未经确认执行 Commit、Merge 或 Push；
8. Windows 中文路径或 PowerShell 输出损坏；
9. 工具调用为空、失败或无结果，却被报告为 PASS；
10. 最终报告泄露凭据或用户数据。

建议发布裁决：

- `GO`：全部核心项 PASS，外部可选能力也有真实证据；
- `CONDITIONAL GO`：核心闭环 PASS，仅明确列出的外部平台/Provider 为 BLOCKED；
- `NO-GO`：存在上述任一严重失败，或核心工具链无法完成 SaveGuard。

## 9. 报告模板

```markdown
# SaveGuard Picode E2E Report

- Picode commit/version:
- OS / Shell:
- Node / Git:
- PICODE_DIR:
- Workspace:
- Session IDs:
- Models:

| 阶段 | 状态 | 证据文件 | 说明 |
|---|---|---|---|
| A Simple | | | |
| B Standard | | | |
| C Capability/Subagent | | | |
| D TDD RED | | | |
| E GREEN/Integration | | | |
| F Slice/Capsule | | | |
| G Worktree | | | |
| H Permissions | | | |
| I Recovery | | | |
| J Git/Completion | | | |

## Tool-call coverage

| Tool | call id | result | observable evidence | status |
|---|---|---|---|---|

## Failures and blocked dependencies

## Secret scan

## Final verdict: GO / CONDITIONAL GO / NO-GO
```

原始 JSONL、命令输出、最终报告和必要的脱敏夹具应打包到 `$Evidence`。不要清理失败现场，直到缺陷完成复现和登记。
