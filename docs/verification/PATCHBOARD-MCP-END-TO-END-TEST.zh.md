# Picode PatchBoard + MCP 端到端黑盒验收任务书

状态：待执行  
测试类型：真实产品黑盒、CLI/RPC 为主、少量 TUI 交互检查  
目标：用 Picode 从零开发一个小型控制台软件，再由 Picode 通过该软件的 MCP Server 操作同一份业务数据，覆盖当前仍需验证的核心产品链路。

## 1. 本轮范围

本轮明确**不测试**：

- 账号登录、账号导入、账号迁移；
- Claude/Codex/Cursor 聊天导入；
- Slice/Capsule 生成、接续和漂移度量；
- 手机端、GUI、Windows 强沙箱等 P5 能力；
- macOS/Linux 发布裁决（同一故事以后可以在对应平台复跑）。

本轮必须覆盖：

- 原版 Pi TUI 启动和会话；
- `simple / standard / tdd` 三档 Harness 及状态持久化；
- `/harness-prompt none|lean|full` 与 Harness 相互独立；
- 原生文件、搜索、Shell、Todo 与结构化 Git 工具；
- `readonly / auto / full`、一次允许、会话允许、拒绝、命令变化重新询问；
- TDD 的 pre-RED 阻止、RED、GREEN、Gate、Review、Integration；
- TypeScript LSP 的真实诊断和修复复查；
- Subagent 的模型、spawn/status/wait/output/stop/resume；
- `search_tools`、二级/三级能力可见性和 readiness；
- Web Search / Web Fetch；
- MCP discover/describe/call、读写审批、lazy 生命周期、崩溃恢复和禁用；
- Worktree 写入所有权与 Git 用户确认；
- CLI/RPC 取消、超时、迟到结果与死亡 Lease 恢复；
- 会话 resume/branch/compact、Cache Epoch 和缓存遥测；
- 全新目录安装后的启动、构建和运行。

## 2. 测试故事：PatchBoard

开发一个名为 **PatchBoard** 的本地发布任务板。它是 TypeScript/Node.js 控制台软件，不包含网页和数据库服务。

### 2.1 CLI

生成以下产物：

```text
dist/cli.js
dist/mcp-server.js
```

CLI 至少支持：

```text
patchboard init --file <path>
patchboard add --file <path> --title <text> --owner <text>
patchboard list --file <path> --json
patchboard complete --file <path> --id <id>
patchboard stats --file <path> --json
patchboard export --file <path> --out <path>
```

业务约束：

- 数据格式有显式 `schemaVersion`；
- ID 稳定且不重复；
- 空标题、未知 ID 和损坏 JSON 返回非零退出码与明确错误；
- 失败操作不能留下半截 JSON；
- 写入采用同目录临时文件 + 原子替换；
- JSON 输出可被机器解析，不夹杂日志；
- Unicode 标题、中文路径和空格路径必须工作；
- `npm test`、`npm run typecheck`、`npm run build`、`npm run smoke` 全部存在并可独立运行。

### 2.2 TDD 增量功能

基础 CLI 完成后，切到 TDD Harness 增加“阻塞关系”：

```text
patchboard block --file <path> --id <id> --by <id>
patchboard ready --file <path> --json
```

规则：

- 任务不能阻塞自己；
- 不允许形成环；
- 只有未完成且所有 blocker 已完成的任务才出现在 `ready`；
- CLI、Domain、Store 与 MCP 必须共享同一套业务实现，禁止复制规则。

这个功能必须取得真实 RED 后才能修改生产模块，并最终通过单元、CLI 集成和 MCP 集成 Gate。

### 2.3 MCP Server

使用固定版本的 `@modelcontextprotocol/sdk` 实现 stdio MCP Server，至少暴露：

| MCP Tool | 类型 | 作用 |
|---|---|---|
| `list` | 只读 | 返回任务列表 |
| `stats` | 只读 | 返回统计信息 |
| `ready` | 只读 | 返回可开始任务 |
| `add` | 写入 | 新建任务 |
| `complete` | 写入 | 完成任务 |
| `block` | 写入 | 建立阻塞关系 |
| `test_crash` | 测试专用 | 仅在 `PATCHBOARD_TEST_MODE=1` 时终止 Server，用于验证重连 |

MCP 与 CLI 必须读取同一份数据文件。MCP 参数使用严格 JSON Schema，错误返回结构化信息，不把异常堆栈当正常结果。Server 名为 `patchboard`，因此 pi-mcp-adapter 暴露给模型的规范名应为 `patchboard_list`、`patchboard_add` 等；Server 内工具名不要再次加 `patchboard_`，避免双前缀。

## 3. 测试纪律

1. 测试者不能手工修改 PatchBoard 项目文件；产品代码、测试、配置和修复均由 Picode 完成。
2. 不修改 `D:\otherproject\picode\v3` 源码；发现 Picode Bug 只写报告。
3. 所有测试产物进入新的临时根目录；不得复用上一轮 PatchBoard。
4. 使用现有已配置账号作为外部前置条件，但不得复制或打包 API Key、OAuth Token、Vault、账号 JSON 或环境秘密。
5. MCP 必须通过 Picode 的 `pi-mcp-adapter` 调用。用 Bash、curl 或手写 JSON-RPC 直连只能用于调试，不能记为 MCP PASS。
6. LSP 必须有真实 LSP 请求和诊断结果；`tsc` 通过不能替代 LSP PASS。
7. Subagent 必须有独立 run ID、模型、生命周期和输出；主 Agent 自称“独立审查”不算。
8. 工具调用必须在 Pi Session Events / Picode RPC Events 中有记录。只在最终回答声称调用过不算证据。
9. 每项只允许 `PASS / FAIL / PARTIAL / BLOCKED / NOT RUN`。外部依赖缺失用 `BLOCKED`，产品已配置却不可用用 `FAIL`。
10. 每个模型阶段最多两次修复，不允许为了追求全绿无限循环。

## 4. 环境与证据目录

建议建立：

```text
<TestRoot>/workspace/patchboard
<TestRoot>/state
<TestRoot>/evidence
<TestRoot>/package-smoke
```

记录但不泄露秘密：

```powershell
picode --version
picode --help
picode doctor
picode doctor tools --cwd <workspace>
node --version
npm --version
git --version
typescript-language-server --version
```

报告必须记录 Picode Commit/版本、模型名称、操作系统、Node 版本、TestRoot、开始结束时间和每阶段 Session ID。

## 5. 阶段 A：启动、上下文与 Simple

1. 在工作区写入测试专用 `AGENTS.md`，包含三个无害 marker 和“不要自动 commit/push”。
2. 运行 `picode`，确认进入原版 Pi TUI，而不是状态转储页。
3. 新建 Simple 会话，要求只读复述 marker、列目录、读取规则文件并报告 Git 状态。
4. 验证 Simple 没有 Picode Harness 行为核、TDD Gate、Todo Nudge 或额外工具强行介入。
5. 在 TUI 中依次执行 `/harness-prompt`、`/harness-prompt lean`、`/harness-prompt none`，确认只改变提示词引导，不改变 Harness、权限或工具集合。

通过条件：TUI 正常；marker 来自项目规则而非模型猜测；`read/ls/find/grep/git status` 有真实成功事件；Simple 仍保持上游 Pi 的精简语义。

## 6. 阶段 B：Standard 开发基础软件

新建独立 Standard 会话，以若干短回合完成基础 PatchBoard，禁止给一个 300 秒“大包办”Prompt。

要求 Agent：

1. 使用 Todo 列出基础 CLI、Store、测试、构建和 Smoke；
2. 用 `ls/find/grep/read` 探索；
3. 用 `write/edit` 创建和修改文件；
4. 用 Shell 运行 npm、测试和构建；
5. 使用结构化 Git 查看 status/diff/log；
6. 不 commit、不 push；
7. 最终执行四条项目命令并报告精确退出码。

验收以下原生工具都有有效事件和有效结果：

| 能力 | 必要证据 |
|---|---|
| `read` | 读到真实文件内容 |
| `write` | 产生预期文件 |
| `edit/search_replace` | 只修改目标片段 |
| `grep` | 返回已知符号位置 |
| `find` | 返回符合 glob 的文件 |
| `ls/list_dir` | 返回目录条目 |
| `bash/run_terminal_command` | 真实命令、cwd、exit code、中文输出 |
| `todo_write` | 创建、更新、完成状态 |
| 结构化 Git | status/diff/log 的结构化结果 |

通过条件：四条 npm 命令全绿，CLI 的 Unicode、无效输入和原子写入测试全绿，事件矩阵没有用单一 Bash 冒充其他工具。

## 7. 阶段 C：Harness、权限与审批矩阵

每个用例使用独立 Session 和唯一 marker，优先通过 `picode rpc` 取得请求 ID、审批和终态证据。

1. `readonly` 请求写文件：出现审批或被拒；无批准时文件不存在。
2. `auto` 执行一个**确定会触发 ask** 的 Shell 或 MCP 写操作；只有在 RPC 收到真实 approval request ID 后才回复 `deny`。副作用必须不存在，run 有明确拒绝终态。普通工作区 `write/edit` 在 `auto` 下可被策略直接允许，`approvals=0` 时不能伪装成 deny 测试。
3. 相同命令“一次允许”：只允许当前精确请求；第二次重新询问。
4. “会话允许”：同一会话、同一允许范围内不重复询问。
5. 批准后修改命令文本、cwd 或被调用脚本内容：旧批准失效并重新询问。
6. `full` 执行普通工作区写入：不逐步骚扰；请求 `git commit` 仍必须询问。
7. 对 commit 回复 deny：HEAD 不变；明确批准一次本地 commit 后才允许 HEAD 变化。
8. `git push/merge/rebase/reset --hard` 不执行，只验证请求仍被上限拦截或要求单独用户确认。
9. 错误参数 `--permission full` 必须立即报 usage error，不能静默回退。

通过条件：任何 deny 都没有对应副作用；Grant 不越范围；普通 full 模式不会每一步都询问；Git 所有权仍由用户掌握。

## 8. 阶段 D：TDD 严格闭环

在基础 CLI 已绿的 Snapshot 上切换 TDD，并查询 Session 与 Task，二者必须同时显示 `tdd`，恢复会话后仍一致。

执行阻塞关系功能：

1. 调用 `harness_result begin` 建立 TDD 阶段；
2. 在尚无 RED Evidence 时，故意要求先编辑生产 Domain 文件，Host/Guard 必须拒绝；
3. 只写测试；
4. 调用 `harness_result prove_red` 运行目标测试并记录真实失败；
5. 再修改生产代码取得 GREEN；
6. 重构后重跑测试；
7. 调用 `harness_result run_gate`，同时包含单元、CLI 集成、MCP 集成和 `npm run smoke`；
8. 使用独立 Reviewer/Subagent 做一次只读 Review；
9. 运行 Integration Smoke；
10. Completion Label 必须与 Evidence 一致。

零测试匹配、跳过测试、超时、只跑单元不跑集成均不能判绿。没有真实 `prove_red` 就写生产代码为本轮 P1 FAIL。

## 9. 阶段 E：LSP 真实诊断

1. `picode doctor tools --cwd <workspace>` 必须识别 TypeScript LSP；
2. 通过 Picode/pi-lens 对一个生产文件发起真实诊断；
3. 在独立 probe 文件中制造明确类型错误；
4. LSP 必须返回该错误的位置和消息；
5. 使用 edit 修正；
6. 再次调用 LSP，错误消失；
7. 删除 probe 或把它纳入正常测试，最终工作树不能遗留无用文件。

## 10. 阶段 F：Subagent 生命周期

1. 查询并记录用户设置的 Subagent 模型，确认可与主模型不同；
2. spawn 一个只读 Reviewer，返回 run ID；
3. 主 Agent 在 Reviewer 运行时继续做另一个只读检查；
4. status → wait → output，主 Agent 明确读取并处理发现；
5. spawn 一个可持续运行的有界任务，取得 running 状态后 stop；
6. 验证停止后不再产生结果或副作用；
7. 按产品契约 resume，同一任务身份或明确的新 run 关系可追踪；
8. 所有 Subagent 退出后无遗留进程。

若没有独立模型或扩展未配置，记 `BLOCKED`；若 doctor Ready 但实际 bridge unavailable，记 `FAIL`。

## 11. 阶段 G：创建并接入 PatchBoard MCP

### 11.1 配置

由 Picode 在项目根创建 `.mcp.json`，使用绝对路径，避免不同 cwd 解析错误。结构示例：

```json
{
  "mcpServers": {
    "patchboard": {
      "command": "node",
      "args": ["<ABSOLUTE_WORKSPACE>/dist/mcp-server.js"],
      "env": {
        "PATCHBOARD_DATA": "<ABSOLUTE_WORKSPACE>/.patchboard/board.json",
        "PATCHBOARD_TEST_MODE": "1"
      },
      "lifecycle": "lazy",
      "idleTimeout": 10,
      "requestTimeoutMs": 30000
    }
  }
}
```

配置中不得写入账号密钥。重新加载或启动新会话后，`doctor tools` 必须显示 MCP Ready。

### 11.2 Lazy 与发现

1. 调用前确认没有 `dist/mcp-server.js` 进程；
2. 通过 Picode MCP 工具 discover/list Server；
3. describe `patchboard_list` 和 `patchboard_add`；
4. 确认 Tool Schema 与实现一致；
5. 只读发现不能启动不必要的常驻 Server；实际 call 才允许 lazy 启动。

### 11.3 读写闭环

1. MCP 调用 `patchboard_add` 新建两条任务；
2. CLI `list --json` 必须看到同样数据；
3. CLI 新建第三条任务；
4. MCP `patchboard_list` 必须看到第三条；
5. MCP 建立 blocker，CLI `ready` 验证结果；
6. MCP 完成 blocker，再由 MCP `ready/stats` 验证状态变化。

必须保留 MCP server、tool name、request/call ID、参数摘要、结果和对应 CLI 交叉验证。不得用 Bash 直连 JSON-RPC 冒充。

### 11.4 MCP 权限、崩溃与禁用

1. 对一个 MCP 写操作回复 deny，数据文件 digest 不变；
2. 批准一次精确 MCP 写调用，仅该请求生效；
3. 调用 `patchboard_test_crash` 使连接中断，Pi 主循环不得崩溃；
4. 下一次 `patchboard_stats` 应自动重连或给出可操作恢复路径，不能永久卡死；
5. 空闲超过 `idleTimeout` 后 Server 进程退出；
6. `/mcp disable patchboard` + reload 后，模型不可调用该 Server，且零进程；
7. `/mcp enable patchboard` + reload 后恢复 discover/describe/call。

## 12. 阶段 H：能力驻留、Skills 与 Web

### 12.1 二级/三级能力

1. 临时把测试能力设为 Disabled；
2. `search_tools` 不得返回 Disabled 能力；
3. 用户重新 Enable + Trust 当前 digest；
4. `search_tools` 可发现，但仅发现不能等于 Running；
5. 实际 Activate 后才允许出现运行态；release 后零进程。

测试顺序应先做可见性，再恢复 pi-lens/MCP，避免影响前面功能阶段。

### 12.2 `/plan`

运行 `/plan`：

- 使用随包的 mattpocock `grill-with-docs` 依赖闭包；
- 未物化时按需物化并提示；
- 不加载独立 `pi-plan-mode` 或 `pi-goal`；
- 不通过 MCP/Subagent 搜索 Skill；
- 不自动继续执行计划。

### 12.3 Web

要求 Agent 使用 Picode Web Search 找到 MCP 官方规范页面，再使用 Web Fetch 读取同一官方页面，提取版本/标题和三条与 Tool Schema 有关的事实，写入 `docs/mcp-reference.md`。

必须有 Search 和 Fetch 两种产品事件、最终 URL 和来源；模型凭记忆回答或只用 Shell 下载不算 PASS。

## 13. 阶段 I：会话、Prompt、缓存与压缩

1. 创建会话并记录 ID；
2. resume 后继续同一上下文；
3. 使用 `picode session branch --from <session-id>` 建立分支，父会话不被子分支改写；运行前先以当前 `--help` 为准，不得把不存在的 `--session` 参数误报成产品 Bug；
4. Standard 下切 `/harness-prompt none → lean → full`，每次说明只改变引导，不改变 Harness；
5. 再切 Harness，提示必须说明工具、权限、验证等实际变化，并把 prompt 恢复到该 Harness 默认；
6. 记录切换前后的 Cache Epoch；
7. 在有足够历史时执行 `/compact`，成功或明确 `Nothing to compact`，不能把命令发给模型；
8. 真正 compact 时必须开启新 Cache Epoch；
9. Provider 不提供缓存 telemetry 时显示 unavailable，而不是 0%；提供时记录 hit rate。

本阶段明确不执行 `/slice`，也不创建、seal 或注入 Capsule。

## 14. 阶段 J：Worktree、取消与恢复

1. Task A claim 当前 Worktree；
2. Task B 尝试 claim 同一 Worktree，必须被拒；
3. A release 后 B 才能接管；
4. 启动一个延迟写 marker 的 RPC run，在写入前 cancel；
5. run 进入明确取消终态，等待超过原延迟后 marker 仍不存在；
6. 对一个短 timeout 重复测试，不能出现取消后的迟到副作用；
7. 强制终止持有 Lease 的 Picode 子进程；新进程确认 PID 已死后可以回收 Lease，不得永久锁死；
8. 损坏隔离状态中的非秘密配置副本，验证 quarantine/known-good 或明确 fail-closed；
9. 所有进程退出后检查无遗留 Picode、Subagent、MCP 和测试 Shell 进程。

## 15. 阶段 K：全新安装 Smoke

从当前 Picode 源 Commit 生成安装产物，在 `<TestRoot>/package-smoke` 的全新目录安装。禁止引用源码工作区中的隐式 node_modules。

至少验证：

- `picode --version`，输出必须精确等于安装包 `package.json` 的 Picode 版本；vendored Pi 版本通过 doctor/依赖元数据单独记录；
- `picode --help`；
- `picode doctor`；
- 启动原版 Pi TUI；
- 一次只读无头回合；
- 能发现随包 Extension、Skill、MCP Adapter 和 Subagent Adapter；
- 没有打包账号文件、密钥、历史聊天和本机绝对私人路径。

## 16. 工具强制矩阵

报告必须逐项填写：

| 工具/能力 | Session/Run ID | 调用事件 | 结果事件 | 状态 |
|---|---|---|---|---|
| read | | | | |
| write | | | | |
| edit/search_replace | | | | |
| grep | | | | |
| find | | | | |
| ls/list_dir | | | | |
| bash/run_terminal_command | | | | |
| todo_write | | | | |
| structured git | | | | |
| harness_result begin/prove_red/run_gate | | | | |
| LSP diagnostic | | | | |
| search_tools | | | | |
| web_search | | | | |
| web_fetch | | | | |
| subagent spawn/status/wait/output | | | | |
| subagent stop/resume | | | | |
| MCP discover/describe/call | | | | |

没有真实 Tool Call 与 Tool Result 的行只能是 `FAIL` 或 `BLOCKED`。

## 17. 总体验收裁决

### GO

- TDD pre-RED、deny 无副作用、Harness/Task 一致、MCP 真实调用、核心 CLI 四件套、Worktree 所有权和取消无迟到副作用全部 PASS；
- 工具强制矩阵没有核心项 FAIL；
- 没有秘密进入证据包。

### CONDITIONAL GO

- 所有核心开发闭环 PASS；
- 仅独立外部 Provider、非当前平台或明确可选 Adapter 为 BLOCKED/PARTIAL；
- 每个例外都有可复现证据和不影响核心闭环的理由。

### NO-GO

出现任一情况：

- deny 后仍有副作用；
- TDD 未经真实 RED 修改生产代码；
- Session/Task Harness 状态分裂；
- MCP 由 Bash 伪造或配置 Ready 但产品不能调用；
- 取消后出现迟到写入；
- 死亡 Lease 永久阻塞；
- Agent 未确认就 commit/merge/push；
- Gate/Completion Label 与 Evidence 矛盾；
- 证据包含账号或密钥。

### INCOMPLETE

账号、模型、Node、LSP Server 或测试平台等前置条件导致必须项无法开始。`INCOMPLETE` 不等于产品 FAIL，也不能包装成 GO。

## 18. 报告交付物

测试者交付：

1. `PATCHBOARD-MCP-ACCEPTANCE-REPORT.md`；
2. `results.json`；
3. Session/Run/审批/Gate/MCP/LSP/Subagent 事件；
4. PatchBoard 最终 Git diff、测试输出和构建输出；
5. MCP 配置的脱敏副本、Server 日志与进程生命周期证据；
6. 证据目录 ZIP 与 SHA-256；
7. 一份按 P1/P2/P3 排序的 Picode Bug 清单。

证据包不得包含账号文件、API Key、OAuth Token、Vault、完整环境变量或私人聊天记录。
