# Picode CLI 无头产品黑盒验收（2026-08-08）

## 测试口径

- 只把已安装的 `picode` 当成产品使用，通过 `run/session/task/gate/harness/permissions/account/tools/doctor` 和真实模型工具调用验收。
- 本报告不以源码检查、单元测试或内部函数调用代替产品功能。
- 平台为 Windows；使用隔离的 `PICODE_DIR`、Pi agent 目录和一次性 Git 工作区，不修改日常会话与账号数据。
- 状态含义：`PASS` 为实际产品路径闭环；`PARTIAL` 为入口或部分链路通过；`FAIL` 为实际复现失败；`UNAVAILABLE` 为当前公开 CLI 或测试环境不具备入口/依赖。

测试工作区：`C:\Users\awang\Documents\Codex\2026-07-28\za\picode-cli-blackbox-20260808`

## 结论

Picode 的无头基础 Agent Loop、项目规则、原生文件工具、Windows Shell、严格 TDD、Todo、权限拦截、Subagent、Worktree 基础操作、会话恢复、缓存展示和 Windows 安装包已能实际工作；但目前还不能称为“整体功能全部通过”。P0/P1 修复后剩余的主要缺口是：

1. Web fetch 在本机 TUN/fake-IP 下被 SSRF 拒绝；MCP 没有 server；公开 CLI 没有聊天导入入口。
2. `account import --json` 没有输出可操作 URL，在等待后超时。
3. Slice/Capsule、并发 Worktree 抢占以及三级能力的完整产品路径尚未黑盒闭环。
4. Linux/macOS 尚未实测；Windows 强 OS 沙箱按产品裁决延期到 P5，P0–P4 使用 Guard + 主机 PowerShell 并明确告警。

## 整体功能矩阵

| 模块 | 结果 | 真实产品测试结果 |
|---|---|---|
| 启动 | PARTIAL | `picode --help`、`doctor` 和真实无头 Agent Loop 正常；按本轮“只用无头”口径，原版 Pi TUI 的交互画面未验收。 |
| 会话 | PARTIAL | 新建、列表、恢复、继续发送、事件读取均通过；`session send '/compact'` 已实际触发 `pi.compaction_start`，小会话诚实返回 Nothing to compact；没有公开 branch/switch 命令。 |
| Harness | PASS | `simple/standard/tdd` 均能真实创建并写入会话，恢复后档位正确；TDD 完整闭环通过。 |
| 权限 | PASS | `readonly` 实际阻止写文件；`auto` 可执行只读操作并对风险能力请求批准；`full` 可写文件，但 Git/破坏性操作仍要求确认；恢复后档位保留。 |
| 原生工具 | PASS | 模型实际调用并验证 `read/write/edit/bash/grep/find/ls`；其中 bash 的 cwd/外部程序问题单列为 Windows Shell 失败。 |
| Windows Shell | PASS | PowerShell 从任务工作区启动，实际返回正确 cwd；`node v24.18.0`、`npm 11.16.0` 和测试命令均可运行。Windows 强 OS 沙箱延期 P5，当前明确告警并由 Guard 控权。 |
| 项目上下文 | PASS | 自动注入根目录 `AGENTS.md`、`CLAUDE.md` 和 `.cursor/rules/*.mdc`，顺序为 repo root 到 cwd、深层优先。 |
| Todo | PASS | 模型实际创建、更新并完成 Todo 列表。 |
| TDD | PASS | 真实模型完成 `begin → recorded RED → 生产修改 → fresh reviewer → target Gate → integration Gate → same-snapshot confirm`；`gate status/evidence` 可查询 `tdd.red` 与 `tdd.completed`。 |
| Slice/Capsule | PARTIAL | 会话注入了 taskId、revision、sliceId 和任务状态；未通过公开 CLI 强制切片或观察 sealed Capsule 的生成/接续。 |
| Worktree | PARTIAL | 结构化 Git 工具实际创建 worktree、查询并释放 claim；删除正确触发二次授权。未完成并发抢占、接管冲突测试。测试 worktree 已安全清理。 |
| Subagent | PARTIAL | 实际完成 list/get/spawn/status/wait/output，子代理读取项目 marker 并返回，独立模型信息可见；resume/stop 仅确认接口存在，未实际执行。 |
| MCP | UNAVAILABLE | 产品实际报告 0 server/0 tool 和 `NeedsSetup`；当前没有 server，不能把 MCP 调用标为通过。 |
| 扩展发现 | PARTIAL | `search_tools` 能发现并激活 `pi-web-access`；实际 `fetch_content` 被 SSRF/TUN 地址阻止，release 未完成。 |
| LSP / pi-lens | PASS | Standard 下诚实显示为未启用；TDD 中实际激活成功，注册 6 个 AST/LSP 工具，并显示 `LSP Active: typescript`。 |
| 三级能力 | UNAVAILABLE | 当前无头 CLI 没有完成“Disabled 对模型不可见 → 用户启用并信任 → 可发现”的完整交互验收。 |
| Skills | PARTIAL | `/plan` 被重写为使用 mattpocock `grill-with-docs` 的指导；模型随后寻找/启用 Skill 时触发审批，非交互运行中止，未完成按需安装与实际 workflow。 |
| 缓存 | PARTIAL | 真实运行状态显示 DeepSeek/Picode cache 命中率约 92%–99% 和 Epoch；由于 `/compact` 失效，未验证压缩后新 Epoch。 |
| 账号 | PARTIAL | `account list`、`account use` 实际通过，真实模型可调用；登录、刷新和完整导入未闭环。 |
| Web 导入 | FAIL | `picode account import --json` 没有输出 URL 或结构化进度，等待约 19 秒后超时。 |
| 模型 | PARTIAL | 主 Agent 事件显示实际 provider/model，Subagent 也显示独立模型；公开 CLI 没有完整的模型列出/选择/切换闭环。 |
| 聊天导入 | UNAVAILABLE | 公开无头 CLI 未提供 Claude/Codex/Cursor 聊天预览与选择导入命令。 |
| 工具兼容 | UNAVAILABLE | 没有可从公开 CLI 导入并恢复的外部聊天样本入口，因此历史工具名重定向未做产品级验收。 |
| CLI 自动化 | PARTIAL | `run/session/task/gate/harness/permissions/account/tools/doctor` 均实际运行；部分功能仍缺公开命令或只返回空投影。 |
| 安全底线 | PASS | 实际验证 readonly 写入、`git commit`、worktree remove 都被 Guard 拦截并要求用户确认；非交互模式没有绕过。 |
| 故障恢复 | PARTIAL | 实际破坏 `config.json` 后，产品生成 quarantine、从 known-good 恢复原配置并继续运行；坏事件、重复终态、取消后迟到结果尚无公开黑盒 fixture。 |
| 跨平台 | UNAVAILABLE | 本轮只有 Windows；Linux/macOS 的路径、shell、沙箱未实测。Windows 还明确提示标准 AppContainer 弱于 LPAC。 |
| 打包 | PASS | `npm pack` 后安装到全新目录，直接运行包内 `picode doctor --json`，vendored Pi、扩展和 agent 目录均健康。 |

## 关键真实会话证据

| 用途 | Session ID | 证据摘要 |
|---|---|---|
| Standard 综合工具/上下文/Todo | `019fdde6-011c-74dd-b28d-1c8801ec7ecb` | 实际调用 ls/grep/read/bash/edit/write/todo；续聊恢复上下文；暴露 cwd=`C:\` 和 `/compact` 失效。 |
| TDD | `019fddeb-7251-785b-a8a2-9e380bb2016e` | 进入 RED；Windows 环境找不到 node/npm；超时，Gate evidence 为空。 |
| Web capability | `019fddef-b744-7de5-ba61-890869aca127` | 发现/激活 pi-web-access；fetch_content 被 SSRF/TUN 地址拒绝。 |
| Subagent | `019fddf2-17fb-7df3-8c85-2ab81a986662` | 子代理异步启动、等待、完成并返回项目 marker。 |
| Worktree | `019fddf4-31be-75be-8e8d-b0eb234b6287` | 创建、状态、release；remove 触发破坏性审批。 |
| LSP 旧失败样本 | `019fddfe-1765-7763-a5a4-08bc8c2b80ab` | 修复前复现 readiness 假阳性与 hook-only 激活失败，保留作回归来源。 |

## P0/P1 修复复验

| 项目 | 最新证据 |
|---|---|
| Windows cwd / node / npm | Session `019fded6-746f-7522-b3cb-5d105a64926d`：cwd 为测试工作区，Node 与 npm 均返回版本。 |
| TDD 全闭环 | Session `019fdee5-c957-74ba-bae9-a4972010f3c2`，Task `d37de93edae3ad22f1906f4e`：`node-counter` 与 `node-counter:integration` 通过，Completion Label 已签发。 |
| pi-lens | Session `019fdee7-6974-7010-af8d-77d1176e04ab`：激活成功，`ast_grep_*`、`lsp_navigation`、`lens_diagnostic_mark` 注册。 |
| 配置恢复 | 故意写入坏 JSON 后生成 `config.json.quarantine-1786151170679`，自动恢复 157-byte known-good，并成功完成真实模型调用。 |
| `/compact` | Session `019fdee0-1ed0-71b7-bcf1-611b8d42d57d`：产生 `pi.compaction_start/end`；因会话太小返回 Nothing to compact，未发送给模型。 |

## 权限体验的额外发现

`auto` 档把 `search_tools` 的搜索/激活链路判为风险操作并要求确认；在 `--non-interactive` 下会立刻终止。这解释了“几乎每一步都要批准”的一部分体验问题。切到 `full` 后普通发现与调用可以继续，但 Git 所有权和破坏性操作仍被正确保留为显式确认。建议后续把纯搜索与只读 readiness 查询从风险操作中拆出，激活/进程启动再单独审批。

## 测试隔离与清理

- 所有账号、配置和会话均在隔离状态目录内运行；没有改动用户日常 Picode 数据。
- 创建的外部 worktree 已移除；测试仓库、会话和打包目录保留作为复现证据。
- 本报告刻意不引用单元测试数字作为上述功能的通过证据。
