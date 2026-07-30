# Picode

[English](./README.md) | **简体中文**

Picode 是一个面向 [Pi coding agent](https://github.com/earendil-works/pi) 的轻量桌面工作台，也是 [Picot](https://github.com/shixin-guo/picot) 的持续维护 fork。它在 Picot 的基础上，重点扩展了多 AI 服务接入、长项目任务状态、聊天迁移备份和结构化 Agent 工作流。

Picode 保留 Pi 作为 Agent 内核，桌面宿主采用 Tauri 2 与 Rust。项目目标是在 Windows、Linux 和 macOS 上提供接近原生应用的体验，同时尽量保持 Pi 小巧、快速的核心优势。

> Picode 目前仍在积极开发中。用于重要工程前，请备份聊天记录，并审查 Agent 即将执行的操作。

## 为什么开发 Picode

许多官方 Agent 客户端能力很强，但运行开销较大，而且账号、聊天和项目通常彼此隔离。Picode 希望为个人开发者提供一个统一且低开销的本地入口：

- 在 Pi 中使用 Codex、Claude、Cursor 和自定义兼容 API；
- 同时管理多个聊天和项目，并持续保留任务上下文；
- 按需选择导入本机聊天，而不是盲目导入全部内容；
- 更换服务账号时保留聊天、计划和任务状态；
- 可以选择极简对话，也可以选择结构化开发 Harness；
- 查看主 Agent、子 Agent、资源消耗、等待状态和疑似卡死情况。

## 当前能力

### 账号与模型

- 手动导入受支持的本机 Codex、Claude 和 Cursor 账号配置。
- 手动选择 JSON 凭据文件，并在激活前进行预览确认。
- 支持 Codex 官方 OAuth 和 OpenAI 兼容反代配置。
- 支持自定义 OpenAI 兼容与 Anthropic 兼容 API。
- 模型选择会显示所属服务，同名模型不会被错误合并。
- 可以保存多个账号，但同一服务同时只激活一个账号。
- 更换账号后保留聊天和任务状态，只有用户明确输入“继续”才会恢复执行。
- Cursor Desktop/CLI OAuth 实验通道与官方 Cursor SDK API Key 通道彼此独立。

Picode 不会自动扫描或导入凭据。导入后的密钥进入受保护的 Account Vault，不会把原始 JSON 文件当作凭据仓库保存。

### 聊天迁移与备份

- 按需扫描本机 Codex、Cursor 和 Claude 聊天记录。
- 导入列表显示标题、最近聊天摘要、时间、大小、来源和归档状态，并支持筛选排序。
- 对来源聊天去重，并规范 Windows、Linux、macOS 的工作区路径。
- 新导入聊天必须先绑定当前电脑上真实存在的工作区，才能执行工具。
- 可以选择全量导入思考过程；摘要默认不显示，完整浏览时默认折叠。
- 提供只读完整上下文浏览器，兼容 Codex、Cursor 和 Claude。
- 支持无损聊天备份，可选加密且默认启用加密。
- 支持生成适合长项目迁移的压缩上下文包。

聊天备份不会打包项目文件。

### 任务与 Agent 工作流

- **Simple Task**：无需选择项目即可创建，使用 Picode 管理的安全 Scratch Space。
- **Harness Task**：绑定真实工作区，并加入结构化计划、证据、验证和可选 Git 隔离。
- 持久保存任务状态和账号接管状态。
- 用户可以配置适合简单、边界明确工作的子 Agent 模型。
- Runtime Monitor 可查看 Agent、子 Agent、资源使用、等待原因和疑似停滞。
- 全局扩展和任务绑定扩展均采用延迟发现、按需加载。
- 用户明确调用的 Skill 可以覆盖当前任务的默认 Picode 工作流。

Picode 不会把启动程序时继承的目录作为默认工作区。空白启动会进入应用自有 Scratch Space，从而避开 `C:\Windows\System32` 等危险位置。

### 桌面体验

- Rust 宿主管理内置的 `pi --mode rpc` 运行时。
- 多聊天、多项目以及隔离的 Pi 进程。
- 流式 Markdown、工具调用、Diff、思考块、附件和消息队列。
- 聊天搜索、改名、收藏、标签、归档和费用信息。
- XML 语言包，内置英语和简体中文。
- Pi 包管理与扩展兼容能力。
- 继承自 Picot 的局域网和移动端访问能力，并计划以扩展形式提供远程控制。

## 架构

```text
Picode 桌面端
├─ Tauri 2 / Rust 宿主
│  ├─ Pi 进程与聊天生命周期
│  ├─ Account Vault 与服务激活
│  ├─ 任务、Harness、扩展和运行监控服务
│  └─ 聊天迁移、备份与工作区安全
├─ WebView 界面
│  ├─ 聊天、设置、账号、模型和导入
│  └─ 任务与 Runtime Monitor 面板
└─ 内置 Pi 运行时
   ├─ pi --mode rpc
   ├─ Picode Bridge 扩展
   └─ 用户与项目 Pi 扩展
```

桌面界面通过本地 RPC/WebSocket Bridge 与 Pi 通信，Agent 的实际执行仍留在运行 Picode 的本机。

## 从源代码构建

### 环境要求

- [Rust](https://www.rust-lang.org/tools/install)
- [Bun](https://bun.sh/)
- 当前操作系统对应的 Tauri 2 构建依赖
- Git

```bash
git clone https://github.com/awangs1986/picode.git
cd picode
bun install --frozen-lockfile
bun run dev
```

构建桌面安装包：

```bash
bun run build
```

运行主要检查：

```bash
bun test
cd src-tauri
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt -- --check
```

## 项目状态

Picode 当前主要面向个人开发使用，并优先在 Windows 上验证。Linux 与 macOS 的可移植性是架构要求，但在稳定发布前仍需要更多平台测试。

实现路线和架构决策记录在 [`docs/`](./docs/) 中。

## 上游与致谢

Picode 是 [Picot](https://github.com/shixin-guo/picot) 的 fork 和衍生项目。Picot 提供了桌面交互模型、Tauri 基础、聊天界面，以及大量让本项目得以成立的早期集成工作。在此真诚感谢 Picot 的维护者和所有贡献者。

Picode 由 [Pi coding agent](https://github.com/earendil-works/pi) 驱动。Pi 提供了本项目核心的轻量 Agent 运行时、RPC 模式、聊天格式、模型/服务接入和扩展生态。在此同样真诚感谢 Pi 的维护者和所有贡献者。

在条件允许时，Picode 会尽量保持改动边界清晰并记录设计决定，以便继续吸收 Picot 上游的有用改进。

Picode 是独立的社区项目，与 OpenAI、Anthropic 或 Cursor 不存在官方隶属或背书关系。

## 许可证

Picode 按照 [MIT License](./LICENSE) 发布，与 Picot 的许可证保持一致。第三方组件和随附依赖继续遵守各自的许可证与声明。
