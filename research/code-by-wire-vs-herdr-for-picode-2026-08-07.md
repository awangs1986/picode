# code-by-wire 能否替代 Herdr：Picode 二次开发评估

> 日期：2026-08-07  
> 结论类型：源码级设计评估，不授权启动 fork 或产品开发。  
> 快照：code-by-wire `9c047d1`（v0.1.48）；Herdr `69a07fd`（v0.8.0）。

## 1. 结论

**不建议用 code-by-wire 替代 Herdr。它可以作为未来二次开发 Picode/Linux
支持的桌面观测端（cockpit）候选，但当前不列入 P0–P5 开发计划，也不是
Picode 的多任务运行时。**

原因不是 code-by-wire 不够优秀，而是两者占据不同 Seam：

- Herdr 是长期存活的终端 Runtime：后台 server 拥有 PTY、支持 detach/reattach、
  workspace/tab/pane/worktree、CLI/Socket 自动化和 Agent 状态上报。
- code-by-wire 是 Electron 观测台：读取 Claude/Codex 会话文件、展示 transcript、
  telemetry 和统计，并管理由自己启动的 PTY；窗口与 PTY 生命周期仍紧密相关。

因此二者在“同时看多个 Agent 会话”上相似，但核心契约并不等价。把 code-by-wire
扩成 Herdr 的完整替代，需要再实现后台终端 server、持久会话、重连协议、Socket
控制、workspace/worktree 和 Pi 生命周期集成，实质上是在 Electron 项目里重造
Herdr 的深 Module，既不精简，也不符合 Picode 当前 TUI-first 路线。

## 2. 源码事实

### 2.1 code-by-wire

code-by-wire 是 Electron + React 桌面应用，main 进程负责 Claude/Codex transcript、
SQLite analytics、PTY、Git 和设置；解析工作放进按需启动的 utility process，整体
采用 renderer 轮询而不是 `fs.watch` 或后台 timer。其 Agent Registry 当前只有
`claude`、`codex`，新增 Agent 需要 descriptor、Provider、spawn 分支、CLI probe、
设置项和图标。[架构说明](https://github.com/luojiahai/code-by-wire/blob/main/CLAUDE.md)
[Agent Registry](https://github.com/luojiahai/code-by-wire/blob/main/src/shared/agents.ts)

Provider Interface 已经把 transcript、activity、telemetry、resume 等能力抽象出来，
所以加入 Picode 有清晰 Adapter Seam；但该 Interface 同时包含大量 Agent 专属查询，
对 Picode 来说偏宽，二开时应拆为 lifecycle / transcript / activity / telemetry 四组
能力，而不是大量空实现。[Provider Interface](https://github.com/luojiahai/code-by-wire/blob/main/src/main/provider/types.ts)

项目使用 Electron 41、React 19、`node-pty` 和 `better-sqlite3`；后两者需要针对
Electron ABI 重编译。当前正式打包配置只有 macOS 与 Windows，README 下载项也
没有 Linux；CI 虽在 Ubuntu 和 Windows 跑测试，但不是 Linux 打包后的 Electron
端到端验收。[package.json](https://github.com/luojiahai/code-by-wire/blob/main/package.json)
[打包配置](https://github.com/luojiahai/code-by-wire/blob/main/electron-builder.yml)
[CI](https://github.com/luojiahai/code-by-wire/blob/main/.github/workflows/ci.yml)

项目是 MIT 许可证，可以 fork、修改和分发，但必须保留许可证与版权声明。上游
贡献说明明确当前不接收外部 PR，因此 Picode/Linux 适配应走独立 fork，而不是
把合并上游当作计划前提。[许可证](https://github.com/luojiahai/code-by-wire/blob/main/LICENSE)
[贡献说明](https://github.com/luojiahai/code-by-wire/blob/main/CONTRIBUTING.md)

### 2.2 Herdr

Herdr 自称 coding agents 的 Runtime：后台 server 拥有终端，支持断开/重连、
Agent working/blocked/idle 状态、CLI 与 Socket API、插件、workspace 和 worktree。
它是单个 Rust 二进制，无 Electron。[README](https://github.com/herdrdev/herdr/blob/master/README.md)

Herdr 已自带 Pi Adapter Extension，监听 `session_start`、`agent_start`、
`agent_settled`，通过 Unix socket 或 Windows named pipe 上报会话与 Agent 状态。
这意味着 Picode 只需在现有 Adapter 上增加 Picode task/harness 元数据，不必重造
多任务 Runtime。[Pi 集成](https://github.com/herdrdev/herdr/blob/master/src/integration/assets/pi/herdr-agent-state.ts)

其 Socket Interface 已覆盖 workspace、pane、worktree 和插件控制，插件也能声明
Linux、macOS、Windows 平台。Windows 当前是 ConPTY beta，但 Linux/macOS 是原生
主路径。[Socket Interface](https://github.com/herdrdev/herdr/blob/master/docs/next/website/src/content/docs/socket-api.mdx)
[插件](https://github.com/herdrdev/herdr/blob/master/docs/next/website/src/content/docs/plugins.mdx)
[Windows beta](https://github.com/herdrdev/herdr/blob/master/docs/next/website/src/content/docs/windows-beta.mdx)

当前许可证是 Apache-2.0，同样允许 Picode 集成和二次开发，只需遵守 notice 等
条款。[许可证](https://github.com/herdrdev/herdr/blob/master/LICENSE)

## 3. 能力交叉对比

| 判断面 | Herdr | code-by-wire | 对 Picode 的含义 |
|---|---|---|---|
| 核心 Module | 后台终端 Runtime | 桌面观测与会话阅读 | 不可直接互换 |
| PTY 生命周期 | server 持有，detach/reattach | 应用内 managed PTY | 关闭桌面端后的语义不同 |
| 多任务控制 | workspace/tab/pane + CLI/Socket | session rail + spawn/fork/resume/observe | 前者适合作为 TUI 多任务底座 |
| Pi 集成 | 已有生命周期 Adapter | 当前只有 Claude/Codex Provider | Picode 接 Herdr成本更低 |
| Transcript/Telemetry | 不是核心优势 | 深且成熟 | code-by-wire 最值得复用的部分 |
| Worktree | 一等 Interface | 主要是 Git 展示/调用 | Herdr更贴近 Picode Harness |
| Linux | 主路径 | 源码部分兼容，未正式打包 | 可补，但需产品级验证 |
| 资源模型 | 单 Rust 二进制 | Electron + React + native Node modules | code-by-wire 不应进入精简 TUI 基础层 |
| 许可证 | Apache-2.0 | MIT | 都没有替代动机 |

## 4. Linux 支持可行性

**可行，难度中等；不是简单加一行打包目标。**

已有利好：

- terminal command 已有 POSIX shell 路径；
- 平台类型和路径代码已考虑 Linux；
- Ubuntu CI 已执行测试；
- Electron、node-pty、better-sqlite3 都可在 Linux 工作。

仍需完成：

1. electron-builder 增加 AppImage + deb（首期至少 AppImage）及 Linux 图标、desktop
   file、协议处理和 updater 策略；
2. 为 `node-pty`、`better-sqlite3` 建立 Linux/Electron ABI 打包 Gate；
3. 实测 X11 与 Wayland 下窗口、托盘、剪贴板、终端 resize、IME 和系统浏览器；
4. 校准 keychain/凭据、文件管理器打开、shell 探测与 PATH 登录语义；
5. 新增“安装产物启动 → 创建 PTY → 读 Picode 会话 → 退出”的真实 smoke，而不只
   依赖单元测试。

因此“Linux 可运行”是中等工作量，“Linux 可长期发布维护”是中高工作量。

## 5. Picode 支持的正确 Adapter

不建议像 Claude/Codex Provider 那样直接解析 `~/.picode` 内部文件。Picode 已设计
loopback HTTP+SSE Interface，它应成为 code-by-wire fork 唯一稳定集成 Seam：

```text
Picode / vendored Pi
  ├─ JSONL、Task、Evidence、Account：仍由 Picode 拥有
  ├─ Herdr Adapter：可选终端 Runtime / 多任务编排
  └─ HTTP+SSE Adapter
       └─ code-by-wire fork：可选桌面 cockpit
```

Picode Provider 只做协议翻译：

- discovery：`GET /v1/sessions`；
- transcript/task/evidence：读版本化 Picode Interface；
- live update：SSE；
- steer/commands：写端点，仍由 Picode Guard 裁决；
- spawn/resume：调用 `picode` CLI 或未来明确的 lifecycle 端点；
- capabilities：只为真正实现的能力置位，禁止假装支持 Claude 专属 telemetry。

这样 Account、Task、Session 和权限事实仍只有 Picode 一个权威；code-by-wire 不会
变成第二个会话数据库，也不会因 Picode 内部文件布局改变而失效。

## 6. 推荐裁决

### 采用

1. **保留 Herdr 为首次引导中的可选多任务 Runtime。**
2. **把 code-by-wire fork 记录在开发计划外的候选池，不分配阶段或资源。**
3. 如果以后单独立项，优先增加 Picode Provider 和 Linux 发布，不修改 Picode Core 权威。
4. 未来可借鉴并复用其 transcript/telemetry/统计 UI、Provider capability gating、解析
   worker 和大规模测试方式。

### 不采用

1. 不把 code-by-wire 作为 Herdr 的同义替代；
2. 不让 Electron 进程成为 Picode Task/Session/Account 权威；
3. 不为迎合 cockpit 重写 Pi TUI 或 Picode JSONL；
4. 不在 P0–P4 引入 Electron 作为必装依赖；
5. 不在没有后台持久 PTY、detach/reattach、Socket 控制和 worktree 等价契约前，
   对用户宣称它“替代了 Herdr”。

## 7. 最终难度评级

| 工作 | 难度 | 裁决 |
|---|---:|---|
| 增加只读 Picode Provider | 中 | 值得做，走 HTTP+SSE |
| 增加 Picode steer/spawn/resume | 中高 | 若未来立项，再单独分期 |
| 增加 Linux 正式包 | 中高 | 可做，需真机/Wayland Gate |
| 做成 Picode 可选桌面 cockpit | 中高 | 合理候选，当前不规划 |
| 完整替代 Herdr | 很高 | 不建议，重复建设 Runtime |

**最终建议：Herdr 与 code-by-wire 不是二选一。Herdr 管“任务在哪里活着”，
code-by-wire fork 管“人如何看见并操作这些任务”。Picode 通过两个窄 Adapter
同时兼容它们，核心仍保持 Pi 的简洁。**
