# Picode Linux 原生环境黑盒验收任务书

状态：**可执行任务书**  
目标：验证同一 Picode Commit 在原生 Linux 上可以安装、启动、开发、治理、恢复和
卸载；Windows 通过的结果不得代替本轮证据。

通用产品步骤以
[`HEADLESS-FULL-PRODUCT-TEST-GUIDE.zh.md`](./HEADLESS-FULL-PRODUCT-TEST-GUIDE.zh.md)
为唯一来源。本任务书只规定 Linux 环境、执行顺序、平台增量和最终裁决，避免复制
一份会过期的功能清单。

## 1. 测试纪律

- 使用任务书指定的远程 Git Commit；不得修改 Picode 源码、测试或依赖。
- 所有夹具、状态和测试产物放在本轮 TestRoot。
- 可安装系统运行依赖，但必须记录命令和版本。
- 产品失败只保存证据，不现场补丁后继续冒充同一轮通过。
- 不得 commit、merge、rebase、push。
- Agent 自述不算证据；以 CLI JSON/JSONL、Pi Session、进程、文件、Git diff 和
  真实命令结果为准。
- 证据包排除 API Key、OAuth Token、账号文件、Cookie、Host 私钥和完整环境变量。
- WSL、容器和原生 Linux 分开标记。只有实体机或 Linux VM 可以签发
  `NATIVE_LINUX_PASS`；WSL 只能签发 `WSL_PASS`。

## 2. 固定平台

最低主矩阵：

| 项 | 要求 |
|---|---|
| Distribution | Ubuntu 24.04 LTS x86_64；其他发行版只能作为附加样本 |
| Kernel | 保存 `uname -a` |
| libc | 保存 `ldd --version`；musl 不冒充 glibc 通过 |
| Node.js | `>=22.19.0` |
| Git | 当前发行版稳定版本 |
| Shell | `/bin/bash`；同时记录默认登录 Shell |
| Terminal | 支持 UTF-8 与 TTY resize |
| Network | 能访问 npm、GitHub 和测试 Provider |

开始前保存：

```bash
cat /etc/os-release
uname -a
uname -m
ldd --version
node --version
npm --version
git --version
printf '%s\n' "$SHELL" "$LANG" "$LC_ALL"
```

如果运行在 WSL，额外保存 `/proc/version` 和 `wsl.exe --status` 的宿主证据，并将
最终平台标签写成 `WSL2`。

## 3. 隔离目录

```text
/tmp/picode-linux-<timestamp>/
  source/
  npm-prefix/
  state/
  workspaces/
    basic/
    unicode-项目/
    path with spaces/
    outside-denied/
  mcp-fixture/
  evidence/
  report/
```

设置本轮专用环境：

```bash
export PICODE_TEST_ROOT=/tmp/picode-linux-<timestamp>
export PICODE_DIR="$PICODE_TEST_ROOT/state"
export npm_config_prefix="$PICODE_TEST_ROOT/npm-prefix"
export PATH="$npm_config_prefix/bin:$PATH"
```

认证材料只能按最小集合复制进隔离状态；打包证据前删除/排除。不得让测试使用日常
`~/.picode`。

## 4. L01：全新安装产物

1. 克隆指定 Commit 到 `source/`，保存 HEAD 和 `git status --short`；
2. 执行 `npm ci`；
3. 执行 `npm run check`；
4. 执行 `npm pack`；
5. 从生成的 `.tgz` 安装到隔离 npm prefix；
6. 离开源码目录，在 `/tmp` 执行 `picode --version`、`picode --help`、
   `picode doctor`；
7. 检查 `command -v picode` 指向隔离 prefix，而不是源码链接或系统旧版本。

PASS：安装包可独立启动，版本与 Commit 对应，`npm run check` 全绿，运行时不依赖
源码目录。source-linked、`npm link` 或直接运行 `bin/picode.mjs` 只算 FAIL。

## 5. L02：原版 Pi TUI

在真实交互终端执行 `picode`：

1. TUI 正常绘制，无 CRLF、乱码或 raw escape sequence；
2. 调整终端尺寸，布局正常重排；
3. 输入英文、中文、路径和多行文本；
4. 输入框等待时光标按 Picode 规则闪烁，Agent working 且输入为空时停止闪烁；
5. 打开模型、Thinking、Session 选择器并退出；
6. 有任务运行时退出，必须出现中断确认；
7. 正常退出后没有遗留 Picode/Pi/Node 子进程。

保存终端录屏或截图。无 TTY 的 SSH 管道不能替代本项。

## 6. L03：CLI 与 POSIX Shell

按通用指南执行 H01–H06，并追加 Linux 探针：

- `picode run` 在 Simple、Standard、TDD 三档各创建一次真实 Session；
- 新进程恢复后 Harness、Permission、模型和 Thinking 不变；
- bash 工具真实使用 `/bin/bash` 或系统 POSIX Shell，不调用 PowerShell；
- `pwd`、管道、重定向、单/双引号、空格路径和中文路径均正确；
- 可执行文件权限与 shebang 正确，不出现 `ENOEXEC` 或 `^M: bad interpreter`；
- Session、Task、Capsule 和 Artifact 路径不包含 `C:\`、反斜杠拼接或
  `C:\WINDOWS\system32`；
- 大小写不同的 Linux 路径不得被错误合并为同一 Workspace。

至少保存一次结构化 Tool Call/Result，证明使用了真实 `read`、`write/edit`、`bash`、
`grep`、`find/ls` 和结构化 Git，而不是模型口头描述。

## 7. L04：权限与 Linux Sandbox

在 TestRoot 内准备允许写目录和 `outside-denied/` 标记目录。按通用指南执行
readonly、auto、full、danger-full-access；重点验证：

1. readonly 与显式 deny 不产生目标文件；
2. full 仍受 Workspace Fence、TDD pre-RED 和 Git 发布确认限制；
3. Standard/TDD 加载 `pi-landstrip`，状态明确为 `enabled`，不是
   `unavailable/disabled`；
4. 沙箱内写工作区成功，写 TestRoot 外的探针路径失败；
5. 默认直接网络访问被沙箱阻止，获准的代理/Web 路径按政策工作；
6. `danger-full-access` 只能由用户显式选择，且状态明确说明 OS 沙箱关闭；
7. Simple 不加载 landstrip，也搜不到 Standard/TDD 专属能力。

所有破坏性探针只指向 TestRoot。不得尝试修改 `/etc`、`$HOME` 的真实文件或系统
服务。Landstrip 报 unsupported/unavailable 时，本项 FAIL；记录架构、glibc 和原生
二进制加载错误。

## 8. L05：Workspace、Worktree 与故障恢复

按通用指南执行 Worktree 单写手、接管、释放和并发写保护，并追加：

- symlink 指向同一目录时不能绕过单写手；
- `..`、相对路径、大小写和末尾 `/` 不能绕过 Workspace Fence；
- 强杀写手进程后，死亡 PID 可恢复，活跃 PID 不得被抢；
- 损坏 `workspace-fence.json` 和 `worktrees.json` 的**隔离副本**，验证从
  `.known-good` 恢复并生成 quarantine；无有效 known-good 时必须拒绝写入；
- 恢复后不能同时存在两个写手；
- 状态文件、known-good 和凭据类文件不得是 group/world-writable。

完成标准：恢复语义与 Windows 一致，同时符合 Linux symlink、权限位和大小写语义。

## 9. L06：MCP、LSP、Subagent

1. 在 `mcp-fixture/` 创建最小本地 MCP Server，提供一个只读查询和一个写
   TestRoot 的操作；
2. 未启用时模型不可调用；启用、信任并配置后可发现、审批和调用；再次禁用后不能
   懒启动或调用；
3. MCP 崩溃后状态可见，可按产品策略重连，最终无孤儿进程；
4. 安装并配置 TypeScript LSP，要求 `pi-lens` 产生一条真实诊断并在修复后消失；
5. `tools doctor` 的 Git、MCP、LSP 状态必须和系统事实一致；
6. `pi-subagents` 真实执行 spawn/status/wait/stop；子代理模型选择可见；
7. 子代理执行写操作时同样受 landstrip 和 Worktree 规则约束；
8. Session 结束后 MCP、LSP、Subagent 无孤儿进程。

用 bash 直接调用 MCP JSON-RPC、手工运行语言服务器或主 Agent 代替子代理均不能算
产品 PASS。

## 10. L07：TDD、Slice/Capsule 与 Context Ledger

在中文路径工作区实现一个很小的 TypeScript CLI，要求：

1. TDD 档先取得真实 RED；
2. RED 前生产写入被 Host 阻止；
3. GREEN 后运行 Gate、Quick/Independent Review、Integration Smoke；
4. 产生诚实 Completion Label；
5. 执行 `/slice`，关闭进程，再由新进程恢复新 Session；
6. Capsule 的 intent、filesTouched、openQuestions、verificationRefs 和
   workspaceSnapshot 与 Git 事实一致；
7. Capsule sealed 前的来源摘要与逐字事实可以对应到权威来源；
8. Context Ledger 至少包含 `capsule/sealed`，事件 ID 无重复，Ledger 不包含会话全文
   或凭据。

本项只做正常规模上下文。长上下文极限另执行
[`P3-CONTEXT-GOVERNOR-ACCEPTANCE.zh.md`](./P3-CONTEXT-GOVERNOR-ACCEPTANCE.zh.md)，
不得在 Linux 平台验收中重复消耗大量 Token。

## 11. L08：打包、重启与清理

1. 完全退出 Picode 后再次从 `/tmp` 启动安装产物；
2. 恢复 L07 Session，确认模型、Thinking、Harness、Task 和 Todo；
3. 运行 `picode doctor` 与 package smoke；
4. 检查无 serve.lock、Writer Lease、MCP/LSP/Subagent 孤儿；
5. 卸载隔离 prefix 中的 Picode；
6. 删除 TestRoot 后不得残留系统级服务、端口或配置；
7. Picode 源码仓库 HEAD/status 与开始时一致。

## 12. 证据和报告

```text
evidence/
  environment.txt
  install.log
  npm-check.log
  package-smoke.log
  tui/
  cli/
  permissions/
  sandbox/
  worktree/
  mcp-lsp-subagent/
  tdd-slice/
  process-snapshots/
  results.json
  PICODE-LINUX-ACCEPTANCE-REPORT.md
```

`results.json` 每项使用：

```json
{
  "id": "L04-SANDBOX-WRITE-FENCE",
  "status": "PASS|PARTIAL|FAIL|BLOCKED",
  "summary": "one sentence",
  "evidence": ["relative/path"],
  "productBug": true
}
```

报告必须区分：产品 Bug、环境缺依赖、Provider/网络阻塞、测试未执行。`blocked`、
`skipped`、`not_run` 均不能折算为 PASS。

## 13. 最终裁决

### NATIVE_LINUX_PASS

L01–L08 全部 PASS，使用原生 Linux/VM，安装产物独立运行，Sandbox、TDD、Worktree、
MCP/LSP/Subagent 和 Slice 恢复均有真实证据。

### CONDITIONAL_GO

只允许真实 Provider 或外部网络不可用导致的非核心 BLOCKED；本地安装、TUI、Shell、
权限、Sandbox、Worktree、TDD 和恢复必须全部 PASS。必须列出未验项目。

### NO-GO

任一核心 FAIL、源码链接冒充安装包、Windows 路径泄漏、Sandbox 不可用、deny 有副
作用、TDD pre-RED 可写、并发双写、Slice 无法恢复、孤儿进程或敏感信息泄漏，均为
NO-GO。

测试人员最终交付报告、`results.json`、脱敏证据 ZIP 和 SHA-256；不提交 Picode
代码。
