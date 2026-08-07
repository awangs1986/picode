# ADR-0001: Backend 采用 TypeScript-first，进程内嵌 pi SDK

- 状态：Accepted
- 日期：2026-08-06
- 决策人：作者
- 取代：R2 稿 D2（C#/.NET Host）、九条需求中第 8 条的"使用 C# 开发"

## 背景

R2 稿确定统一 Backend 拓扑后，原方案为 C# Backend 通过 RPC 驱动无头 pi（TypeScript）。
本轮以"最小架构风险"为最高代价函数重审：该方案的三大风险源（跨语言 RPC 协议、
SQLite→Pi Session 物化保真、从零自建 TUI）中，前两者由跨语言边界直接导致。

## 决策

Backend 使用 TypeScript/Node，与 pi SDK 同进程集成：

- 七类权威、SQLite、HTTP/SSE/CLI 接口面全部在同一 Node 进程内实现；
- pi 的 session、compaction、分支语义经 SDK 对象直接访问，不经序列化协议；
- 工具意图治理为进程内调用，无跨进程延迟预算问题；
- 自建 TUI 优先复用 `pi-tui` 库；
- C# 不出现在 P0–P4；P5 的手机/GUI 客户端可自由选择语言（走 HTTP API）。

## 后果

- 消灭 RPC 协议设计/版本化/双进程监督三类风险；物化 Seam 收窄为
  "SQLite ↔ 进程内 pi session 对象"的同步问题。
- 放弃 C# 的既有熟练度与 .NET 生态；业务代码依赖 Node 生态成熟度。
- 上游 pi 升级的兼容面从"RPC 协议稳定性"变为"SDK API 稳定性"，
  仍需 pinned + latest-compatible 双轨 CI。
