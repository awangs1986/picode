# ADR-0006: 自动化采用 CLI-first，MCP 仅作未来兼容 Adapter

- 状态：Accepted
- 日期：2026-08-07

## 决策

1. CLI 是 P0–P4 唯一公开自动化契约；同一 `picode` executable 提供 TUI、
   `run`、`session`、`task`、`gate`、`harness`、`account` 和 `doctor`。
2. CLI 不解析 TUI 输出，而是调用同一 Control Interface；该 Interface 只编排
   Store / Engine / Guard / Devloop，不拥有领域事实。
3. 无头命令自己启动并持有 vendored Pi Runtime，不依赖 TUI 或常驻 Core。
4. stdout 使用版本化 JSON/JSONL，stderr 只放诊断；退出码稳定区分完成、Gate
   失败、授权需要、超时、取消、输入错误和内部错误。
5. 非交互 ask 一律 fail-closed。CLI 与 TUI 共用 Guard、Envelope Admission、
   TaskIngress、Pi Session、账号配置、能力目录和 Evidence Ledger。
6. HTTP+SSE 仅是内部诊断 Adapter，不是产品兼容面，正常启动不开放端口。
7. P0–P4 不实现 Picode 对外 MCP Server。P5 仅在 CLI 无法覆盖目标宿主时允许
   添加无状态 Control MCP Adapter，并复用同一 conformance fixture。

## 后果

Picode 保持前台进程所有权与轻量拓扑；TUI、CLI 和未来 Adapter 只有一套
Workflow。旧 `picode-ctl` 只保留为内部 HTTP 诊断客户端，不再代表公共 API。
