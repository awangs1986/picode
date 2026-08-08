# Picode CLI 无头产品黑盒验收（2026-08-08）

## 测试口径

- 只把已安装的 `picode` 当成产品使用，通过 `run/session/task/gate/harness/permissions/account/tools/doctor` 和真实模型工具调用验收。
- 本报告不以源码检查、单元测试或内部函数调用代替产品功能。
- 平台为 Windows；使用隔离的 `PICODE_DIR`、Pi agent 目录和一次性 Git 工作区，不修改日常会话与账号数据。
- 状态含义：`PASS` 为实际产品路径闭环；`PARTIAL` 为入口或部分链路通过；`FAIL` 为实际复现失败；`UNAVAILABLE` 为当前公开 CLI 或测试环境不具备入口/依赖。

测试工作区：`C:\Users\awang\Documents\Codex\2026-07-28\za\picode-cli-blackbox-20260808`

## 结论

本轮按 1–7 顺序完成了剩余 Windows 无头缺口：账号 Wizard 不再被浏览器启动阻塞；
只读能力发现不再误审批；`/plan` 直接注入已安装的 `grill-with-docs`；TUN/fake-IP
只对 RFC 2544 的 `198.18.0.0/15` 启用 vendor 官方 SSRF 例外；Session branch/switch、
Subagent 控制、Slice/Capsule、Worktree 写入租约、Tier-3 设置和聊天选择导入均有公开 CLI。

仍不能标为全平台发布完成：Linux/macOS 尚未实测；Windows 强 OS 沙箱属于 P5；
MCP 仍需用户配置 Server；Subagent stop/resume 需要真实运行中的异步任务样本做最终破坏性 smoke。

## 整体功能矩阵

| 模块 | 结果 | 真实产品测试结果 |
|---|---|---|
| 启动 | PARTIAL | `picode --help`、`doctor` 和真实无头 Agent Loop 正常；按本轮“只用无头”口径，原版 Pi TUI 的交互画面未验收。 |
| 会话 | PASS | 新建、列表、恢复、切换、继续发送、事件读取均通过；实际从用户消息创建独立上游 Pi 分支会话；`/compact` 走 Pi RPC。 |
| Harness | PASS | `simple/standard/tdd` 均能真实创建并写入会话，恢复后档位正确；TDD 完整闭环通过。 |
| 权限 | PASS | `readonly` 实际阻止写文件；`auto` 可执行只读操作并对风险能力请求批准；`full` 可写文件，但 Git/破坏性操作仍要求确认；恢复后档位保留。 |
| 原生工具 | PASS | 模型实际调用并验证 `read/write/edit/bash/grep/find/ls`；其中 bash 的 cwd/外部程序问题单列为 Windows Shell 失败。 |
| Windows Shell | PASS | PowerShell 从任务工作区启动，实际返回正确 cwd；`node v24.18.0`、`npm 11.16.0` 和测试命令均可运行。Windows 强 OS 沙箱延期 P5，当前明确告警并由 Guard 控权。 |
| 项目上下文 | PASS | 自动注入根目录 `AGENTS.md`、`CLAUDE.md` 和 `.cursor/rules/*.mdc`，顺序为 repo root 到 cwd、深层优先。 |
| Todo | PASS | 模型实际创建、更新并完成 Todo 列表。 |
| TDD | PASS | 真实模型完成 `begin → recorded RED → 生产修改 → fresh reviewer → target Gate → integration Gate → same-snapshot confirm`；`gate status/evidence` 可查询 `tdd.red` 与 `tdd.completed`。 |
| Slice/Capsule | PASS | `slice create` 实际封存带 digest 的 Capsule、写入任务目录、创建 fresh Pi session 并注入继续上下文；`capsule list/read` 可检查。 |
| Worktree | PASS | 显式持久 claim 成功；第二个 Task 抢同一目录被拒绝；原 Task release 后恢复可用。结构化 Git 的创建/删除审批仍保留。 |
| Subagent | PARTIAL | 实际 spawn/status/wait/output 与新的无模型 `subagent status` 通过；stop/resume 已接 pi-subagents 公开 RPC 并有契约测试，尚缺真实运行中任务的破坏性 smoke。 |
| MCP | UNAVAILABLE | 产品实际报告 0 server/0 tool 和 `NeedsSetup`；当前没有 server，不能把 MCP 调用标为通过。 |
| 扩展发现 | PARTIAL | 只读 `search_tools` 不再请求审批；TUN/fake-IP 已按 vendor `ssrf.allowRanges` 精确加入 `198.18.0.0/15`，仍待真实网络 fetch 复验。 |
| LSP / pi-lens | PASS | Standard 下诚实显示为未启用；TDD 中实际激活成功，注册 6 个 AST/LSP 工具，并显示 `LSP Active: typescript`。 |
| 三级能力 | PASS | `capability status/set` 实际完成 Herdr disabled → trusted 持久化；disabled 仍对模型搜索不可见。 |
| Skills | PASS | `/plan` 不再让模型自行寻找 Skill，而是直接读取已物化 `grill-with-docs/SKILL.md` 并按 Pi 原生 skill block 注入。 |
| 缓存 | PARTIAL | 真实运行状态显示 DeepSeek/Picode cache 命中率约 92%–99% 和 Epoch；由于 `/compact` 失效，未验证压缩后新 Epoch。 |
| 账号 | PARTIAL | `account list`、`account use` 实际通过，真实模型可调用；登录、刷新和完整导入未闭环。 |
| Web 导入 | PASS | Wizard 启动与浏览器 launcher 解耦；即使 URL handler 挂起，`account.import.ready` 仍立即产生一次性 loopback URL。 |
| 模型 | PARTIAL | 主 Agent 事件显示实际 provider/model，Subagent 也显示独立模型；公开 CLI 没有完整的模型列出/选择/切换闭环。 |
| 聊天导入 | PASS | Codex fixture 实际预览标题/末条内容/大小并按 `selectionId` 选择；只对选中项复制、绑定工作区、建 Task 与 Pi 会话；Claude/Cursor 共用已测试 Adapter。 |
| 工具兼容 | PASS | 选择导入经过 ImportCompiler、兼容报告和 Foreign Resume Capsule；外来 system/tool 历史不作为可执行当前契约。 |
| CLI 自动化 | PASS | `run/session/subagent/slice/capsule/worktree/capability/chat/task/gate/harness/permissions/account/tools/doctor` 已具公开命令。 |
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

`auto` 现已把 `search_tools action=search` 归为只读能力查询；真正 Activate、进程启动、
Git 所有权和破坏性操作继续保持审批。这样减少逐步骚扰但不扩大副作用权限。

## 测试隔离与清理

- 所有账号、配置和会话均在隔离状态目录内运行；没有改动用户日常 Picode 数据。
- 创建的外部 worktree 已移除；测试仓库、会话和打包目录保留作为复现证据。
- 本报告刻意不引用单元测试数字作为上述功能的通过证据。
