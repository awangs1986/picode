# Picode V3 P0–P4 验收记录

> 更新：2026-08-08
> 工作区：`D:/otherproject/picode/v3`  
> 规则：`passed` 只表示命令真实运行成功；`not_run` 不折算为绿色。

## 已通过

| Gate | 证据 | 状态 |
|---|---|---|
| TypeScript | `npm run typecheck` | passed |
| 四模块边界 | `npm run check:boundaries` | passed |
| 固定依赖与摘要 | `npm run check:package-metadata`；所有 runtime dependency 精确版本且 lock integrity 存在 | passed |
| 全量自动测试 | `npm run check`：75 files / 443 tests | passed |
| Pi 开发态启动 | `npm run smoke:pi-rpc`；真实 vendored Pi 0.84.0，加载 Picode Extension，执行 `get_state/get_commands/new_session` | passed |
| 安装产物 | `npm run smoke:package`；真实 `npm pack`、临时安装、CLI doctor、启动 vendored Pi、RPC 新会话 | passed (Windows) |
| CLI/RPC Control Interface | 产品帮助、一次性 CLI、版本化 NDJSON RPC、审批响应、取消/超时、Session/Harness/Permission/Account/Gate/Tools；正常启动零调试端口 | passed (Windows) |
| 无密钥真实 Agent Loop | 测试 Provider 经 vendored Pi + Picode Extension 触发 Tool Call、Guard 审批、结果回灌与完成；发布包断言 Provider 不可见 | passed |
| Headless Conformance | `npm run gate:headless`：帮助、稳定退出码、协议版本拒绝、4 并发诊断 | passed (Windows) |
| 结构化 Git/Readiness | 固定 Git actions、Worktree 管理入口、Ownership 始终 ask；Git/LSP/MCP/Web 分项 readiness 与 Tool Schema 过滤 | passed (Windows) |
| TDD 真循环 | `test/extension/tdd-real-loop.test.ts`；真实 Vitest RED → Target Gate → fresh Reviewer → Integration Smoke → 同 Snapshot 确认重跑 → Completion Label | passed |
| RED Gate 自证 | GateRunner 对零匹配、skipped/not_run 和移除红探针保持红灯 | passed |
| TOOLS.md | 任务级解析、文件夹信任、紧凑注入、切任务清理 | passed |
| 缓存诊断 | 真实 Pi usage 投影；system/schema/history/provider/model/baseUrl 摘要；JSONL 不落提示词明文 | passed (structural) |
| 分档提示词 | Simple 零增量；Standard Lean 与 TDD 自包含行为核经 Pi `before_agent_start` 追加并保留 Base Prompt；作者注释剥离、占位符完整解析 | passed (automated seam) |

## P1–P4 功能闭环

- P1：Account Vault/OAuth、Web Import Wizard、Execution/Cache Epoch、三档权限、
  能力两轴与 `search_tools`、首次引导、坏帧隔离已接真实 Pi Adapter。
- P2：Harness 会话档位、landstrip 配置、MCP 审批桥、pi-subagents 模型与 Envelope、
  Worktree 单写入者、Slice 软/硬边界、带 digest 的 Capsule、TaskIngress、CLI/RPC Control Interface 已接线；HTTP+SSE 仅显式诊断模式。
- P3：真实 TDD 工具/状态恢复/Gate、Cursor/Claude/Codex ImportCompiler、Foreign
  Resume、unknown-tool 兼容提示已接线。
- P4：任务 `TOOLS.md`、任务 Todo 权威、缓存指标、Pi RPC navigation、真实 tarball
  smoke、三平台 CI 合同和当前文档已完成。

## 尚未运行（不能声明 P4 产品发布完成）

| Gate | 原因 | 状态 |
|---|---|---|
| Linux 安装产物与会话 | 当前主机为 Windows；workflow 已配置 | not_run |
| macOS 安装产物与会话 | 当前主机为 Windows；workflow 已配置 | not_run |
| Windows AppContainer 实际隔离探针 | landstrip 配置已生成，但缺独立破坏性沙箱环境 | not_run |
| Provider 缓存命中率 | 当前环境无测试 API Key；结构与归因已验证，不能虚构命中率 | not_run |
| 中型仓库模型驱动 Slice 漂移实验 | 当前环境无测试 Provider；Capsule/换会话结构已验证 | not_run |
| 三来源真实用户历史性能/失真 | 契约 fixture 已通过，尚未由用户选择真实样本执行 | not_run |

因此，结论是：**P1–P4 可代码化范围已经闭合；Windows 开发态与安装产物通过；
跨平台、真实 Provider 和真实历史样本属于待执行验收，不能提前标绿。**
