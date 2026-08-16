# Picode 多 Subagent Web 调研、PDF 与控制面 R2 黑盒复测任务书

状态：`not_run`。本文件是独立复测任务书，不是通过记录，也不得复用上一轮证据冒充本轮结果。

## 1. 本轮目标

本轮同时复测上一轮被前置检查阻断的业务链，以及随后修复的三条控制链：

1. 主 Agent 固定使用 `openai/gpt-5.6-terra`、Thinking `High`；
2. 至少四个并行 `researcher` Subagent 固定使用 `openai/gpt-5.6-luna`、Thinking `High`；
3. 用户在 `/subagent-model` 中的显式选择必须覆盖角色文件自带的 `thinking: medium`；
4. 主 Agent 与 Subagent 使用同一套已登录、当前可用的模型来源，不得使用过期列表或 fallback；
5. 每个 Subagent 真实调用 Web Search 与页面抓取，主 Agent 汇总后生成可独立验证的中文 PDF；
6. `search_tools` 完成一次不泄露工具名的语义发现；
7. 真实失败前置条件通过 `task_outcome` 落成 `run.failed`，CLI 返回退出码 `1`；
8. 模型声称完成的 Todo 在没有 Devloop 证据时只能是 `unverified`，不得伪装成已验证。

所有裁决以运行事件、Task 状态、Subagent 运行状态、Tool Call/Result 和文件证据为准。模型文字说明与模型自己生成的 `execution-evidence.json` 只能作为索引。

## 2. 测试边界

- 使用当前全局 `picode` 发布入口，不直接调用仓库内部函数。
- 不修改 `D:\otherproject\picode\v3` 的任何源码、配置或测试。
- 工作产物只写入新的临时目录；不要在 Picode 仓库、系统目录或真实项目里运行。
- 使用本机现有 Picode 账号状态，避免隔离 `PICODE_DIR` 导致真实模型被误判为不可用。
- 证据包不得包含 API Key、OAuth Token、Cookie、设备令牌、完整 Account Vault 或完整认证配置。
- 不允许改模型、不允许降低 Thinking、不允许用主 Agent 代替失败的 Subagent。
- 不允许用 Bash、PowerShell、`curl`、人工浏览器或模型记忆冒充 Picode Web 工具调用。
- 每个模型回合最多重试一次；同类失败第二次出现后停止该阶段并保留现场。
- 总时限 60 分钟。到时立即停止，不得靠无限重试换取绿色。

建议目录：

```text
<TestRoot>/
  workspace/
  evidence/
  outputs/
```

## 3. 建立现场

在 PowerShell 中建立唯一临时根，并保存当前入口信息：

```powershell
$TestRoot = Join-Path $env:TEMP ("picode-multi-subagent-r2-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
$Workspace = Join-Path $TestRoot "workspace"
$Evidence = Join-Path $TestRoot "evidence"
New-Item -ItemType Directory -Force -Path $Workspace, $Evidence | Out-Null
where.exe picode | Tee-Object -FilePath (Join-Path $Evidence "picode-path.txt")
picode doctor | Tee-Object -FilePath (Join-Path $Evidence "doctor.json")
picode account list | Tee-Object -FilePath (Join-Path $Evidence "accounts-local-only.json")
picode capability status | Tee-Object -FilePath (Join-Path $Evidence "capabilities-before.json")
picode tools doctor --cwd $Workspace --harness standard | Tee-Object -FilePath (Join-Path $Evidence "tools-doctor-before.json")
```

`accounts-local-only.json` 只供本机核对，脱敏前不得放入 ZIP。

完成标准：`where.exe picode` 指向本轮要验收的版本；工作区为空；账号列表包含当前可用的 Terra 与 Luna 来源。

## 4. 模型与角色前置检查

### 4.1 普通 Agent 模型来源探针

启动 `picode`，新建一个临时会话：

1. 选择 `openai/gpt-5.6-luna`；
2. 选择 Thinking `High`；
3. 发送“只回复 `LUNA_AUTH_OK`，不要调用工具”；
4. 得到成功回复后，在同一会话切回 `openai/gpt-5.6-terra`；
5. 保持 Thinking `High`；
6. 设置 Harness 为 `standard`，Permission 为 `full`；
7. 运行 `/subagent-model`，选择 `openai/gpt-5.6-luna`、Thinking `High`；
8. 记录当前 Session ID。

完成标准：Luna 能作为普通 Agent 真正完成一轮，随后当前主模型为 Terra/High，Subagent 选择为 Luna/High。若 Luna 普通回合失败，本轮标记 `BLOCKED_ENVIRONMENT`，不要继续制造 Subagent 假失败。

### 4.2 运行时角色解析硬门

向 Terra 主 Agent 发送：

```text
这是黑盒复测的运行时前置检查。

请通过 pi-subagents 读取 researcher 与 reviewer 两个内建角色的最终解析配置，
但现在不要启动子代理。最终值必须同时满足：

- provider/model = openai/gpt-5.6-luna
- thinking = high

必须检查运行时解析结果，不能只读取 Picode 配置文件。
如果任一角色不符合，调用 task_outcome：
outcome=failed_preflight，说明实际解析结果，然后立即停止。
如果两者都符合，只报告解析结果并结束本回合。
```

独立保存本会话事件：

```powershell
picode session events --session <MainSessionId> | Tee-Object -FilePath (Join-Path $Evidence "role-preflight-events.ndjson")
picode subagent status --session <MainSessionId> | Tee-Object -FilePath (Join-Path $Evidence "role-preflight-subagents.json")
```

硬门：`researcher` 和 `reviewer` 的运行时结果必须都是 Luna/High。配置文件写着 High、运行时仍为 Medium，直接判 `NO-GO`。硬门失败后不得继续研究阶段。

## 5. 工具发现探针

### 5.1 测试人员预选目标

测试人员先在模型不可见的终端检查当前能力。预选一个同时满足以下条件的二级能力：

- Enabled + Trusted；
- 当前未运行；
- 有真实可调用 Adapter；
- 对资料检索、并行监看或报告生成有自然用途；
- 完整工具 Schema 尚未进入当前回合。

可以使用：

```powershell
picode capability status
picode tools search --query "并行任务监看 资料检索 报告生成"
```

记录目标 Capability ID，但不要把 ID、工具名、`search_tools`、Activate 或 Lease 等实现词写进用户 Prompt。

若环境没有合格目标，本阶段标记 `BLOCKED_ENVIRONMENT`；不得临时改生产代码或安装无关组件制造 PASS。

### 5.2 只描述产品目标

把下面一段附加到正式研究 Prompt，按预选能力的真实用途微调，但仍不透露名称：

```text
开始并行研究后，请自行查找当前环境中尚未进入工具列表、但能帮助观察并行任务
或核查资料来源的可选能力。若找到合适能力，请临时启用、实际调用一次并在任务结束时释放；
若确实不存在，请明确报告缺失，不得假装调用或安装替代品。
```

通过标准：事件显示语义 search → 命中预选能力 → Guard 准入 → ActiveCapabilityLease → 工具真实调用 → Lease 释放。只有搜索文本、帮助输出或“没有匹配能力”不能算正向发现 PASS；若预检确认有目标而模型仍找不到，判 `NO-GO`。

## 6. 正式业务故事

在同一个 Terra/High、Standard/Full 会话中发送以下任务。先附加第 5.2 节的盲发现目标，再附加正文：

```text
这是一次 Picode 产品黑盒复测。

研究主题：《2025 年法国苗族（Hmong）群体的生活情况》

你是主 Agent，必须保持当前 openai/gpt-5.6-terra、Thinking High。

开始前再次读取 researcher 的最终运行时配置。只有它精确等于
openai/gpt-5.6-luna + thinking high 才能继续；否则调用 task_outcome
报告 failed_preflight 并停止，禁止 fallback。

一、并行研究

通过 pi-subagents 一次性启动至少四个 fresh-context researcher。
先发出全部任务，再等待任何结果；不得串行完成一个再启动下一个。

四个方向：

1. 人口估计、迁移历史、主要居住地区，以及法国族群统计制度的限制；
2. 2025 年前后的就业、收入、住房、教育、医疗与社会融入；
3. 家庭结构、代际差异、语言、宗教、文化活动与社区组织；
4. 独立来源审计：交叉核查官方、学术与苗族社区资料，标出证据缺口。

每个 researcher 必须：

- 最终运行时模型为 openai/gpt-5.6-luna，Thinking High；
- 真实调用 Web Search；
- 至少抓取并阅读两个独立页面；
- 优先使用官方、学术和社区一手来源；
- 返回带 URL、资料年份、置信度与证据缺口的独立简报；
- 不得使用 Bash、curl、主 Agent 的搜索结果或模型记忆代替自己的 Web 工具。

二、研究纪律

- 至少 12 个不同 URL，其中至少 4 个法语来源；
- 2025 年无直接数据时使用最近资料，并明确标注资料年份；
- 区分“2025 年发布”与“描述 2025 年实际生活状态”；
- 不把未经证实的人口估计写成法国官方族群统计；
- 关键结论可追溯到来源；
- 冲突来源并列呈现；
- 无法核实的内容进入“证据缺口”。

三、主 Agent 汇总

读取全部 Subagent 正式结果后：

1. 比较四份简报、去重并核查冲突；
2. 区分可靠事实、合理推断与证据缺口；
3. 生成中文 Markdown；
4. 通过可重复执行的构建步骤生成 PDF；
5. 独立验证 PDF 可打开、正文可提取、页数合理、中文不乱码；
6. 若关键前置条件或交付失败，调用 task_outcome 记录结构化失败，不得只在文字中声称失败。

交付目录：

outputs/
  subagents/
    population-and-migration.md
    daily-life.md
    culture-and-community.md
    source-audit.md
  france-hmong-life-2025.md
  france-hmong-life-2025.pdf
  sources.json
  execution-evidence.json

PDF 要求：6–12 页；包含标题、执行摘要、方法、主要发现、证据限制、结论和参考资料；
URL 可点击或完整显示；PDF 不是空白、截图集合或改扩展名的文本。

建立 Todo 跟踪研究、汇总、PDF 构建与独立验证。Todo 的 completed 只表示进度；
没有 Devloop 证据时不得把它表述为 verified。
```

完成标准：主回合成功时产生 `run.completed` 且退出码为 `0`；失败时必须产生 `run.failed` 且退出码为 `1`，不能出现“正文说失败但自动化看到成功”。

## 7. 结构化失败与 Todo 真实性探针

此阶段使用新的空目录和新的独立会话，不复用正式研究 Task。

确认工作区不存在 `required-preflight/missing-license.token`，然后执行一个 Standard/Full 无头回合：

```powershell
$FailureWorkspace = Join-Path $TestRoot "failure-probe"
New-Item -ItemType Directory -Force -Path $FailureWorkspace | Out-Null
$FailurePrompt = @'
这是结构化失败探针。
先建立 Todo：检查必需的授权文件。
检查 required-preflight/missing-license.token 是否存在；该文件缺失时不得创建它。
检查动作完成后可以把“检查”这一个 Todo 标为 completed，但不能声称业务前置条件通过。
随后必须调用 task_outcome，参数为：
outcome=failed_preflight；summary=Required license token is missing；
evidenceRefs 包含实际检查路径。调用后立即结束，不执行其他写入。
'@
picode run --prompt $FailurePrompt --cwd $FailureWorkspace --harness standard --permissions full --non-interactive --timeout-ms 120000 |
  Tee-Object -FilePath (Join-Path $Evidence "failure-probe.ndjson")
$LASTEXITCODE | Set-Content -LiteralPath (Join-Path $Evidence "failure-probe-exit-code.txt")
```

从事件中提取 Session ID 与 Task ID，再运行：

```powershell
picode task status --task <FailureTaskId> | Tee-Object -FilePath (Join-Path $Evidence "failure-task-status.json")
picode session resume --session <FailureSessionId> | Tee-Object -FilePath (Join-Path $Evidence "failure-session-resume.json")
picode task status --task <FailureTaskId> | Tee-Object -FilePath (Join-Path $Evidence "failure-task-status-after-resume.json")
picode session events --session <FailureSessionId> | Tee-Object -FilePath (Join-Path $Evidence "failure-session-events.ndjson")
```

必须同时满足：

1. 终态为 `run.failed`，`outcome=failed_preflight`；
2. CLI 退出码为 `1`；
3. Task 状态为 `failed`，摘要与 evidenceRefs 可读；
4. 单纯 resume 不得把失败状态重置为成功或运行中；
5. 缺失文件未被创建；
6. 若“检查”Todo 被标 completed，其 verification 必须为 `unverified`；
7. 不得出现没有真实 Gate/Evidence 却标为 `verified` 的 Todo。

任一不满足均判 `NO-GO`。

## 8. 独立证据审计

正式研究结束后保存：

```powershell
picode session events --session <MainSessionId> | Tee-Object -FilePath (Join-Path $Evidence "main-session-events.ndjson")
picode subagent status --session <MainSessionId> | Tee-Object -FilePath (Join-Path $Evidence "subagents-final.json")
picode task status --task <MainTaskId> | Tee-Object -FilePath (Join-Path $Evidence "main-task-status.json")
picode capability status | Tee-Object -FilePath (Join-Path $Evidence "capabilities-after.json")
picode worktree status | Tee-Object -FilePath (Join-Path $Evidence "worktrees-after.json")
```

测试人员逐项核对：

1. 主 Agent 实际为 Terra/High；
2. `researcher` 最终解析值为 Luna/High，而不是 Medium；
3. 至少四个不同 Subagent Run ID；
4. 至少三个 Subagent 的运行时间发生重叠；
5. 每个 Subagent 均有真实 Web Search 和至少两个页面抓取 Tool Result；
6. 子代理认证使用与普通 Agent 相同的可用模型来源；普通 Luna 成功而 Subagent Luna 认证失败，判产品 `NO-GO`；
7. 主 Agent 在子任务完成后读取了正式结果；
8. 正向工具发现满足第 5 节的完整链；
9. PDF 文件头为 `%PDF-`，独立解析器可提取中文正文，页数为 6–12；
10. Markdown、PDF、sources.json 的标题、关键结论和来源数量一致；
11. 无无法解释的 Lease、Subagent、Writer Lease、进程或端口残留；
12. 证据包中无认证材料。

`execution-evidence.json` 与模型最终回答不得代替上述独立检查。

## 9. 裁决规则

### GO

以下硬项全部通过：

- 角色运行时覆盖：Luna/High；
- 至少四个真实并行 Subagent；
- 每个 Subagent 都有真实 Web Search/Fetch；
- Terra 主 Agent 完成来源审计与有效 PDF；
- 有合格目标时，盲发现完成 search → activation → Lease → call → release；
- 失败探针得到 `run.failed` + exit `1`；
- Todo verification 没有假绿；
- 无 fallback、凭据泄漏和运行时残留。

### BLOCKED

仅用于测试前已不存在的外部前置条件：指定模型不可登录、Web Provider 不可用，或环境没有任何合格的二级发现目标。必须说明是哪个前置条件，并附诊断证据。不得把产品运行中暴露的认证分裂、Thinking 覆盖失败或工具失效降级成 BLOCKED。

### NO-GO

出现任一项即为 NO-GO：

- `researcher` 或实际子进程不是 Luna/High；
- 普通 Agent 能用 Luna，但 Subagent 不能使用同一来源；
- 子任务少于四个、没有真实并发或发生 fallback；
- Web 调用由主 Agent、Shell 或人工搜索代替；
- 前置失败只写在文字/JSON 中，却仍输出 `run.completed` 或退出码 `0`；
- 模型完成 Todo 被无证据标为 `verified`；
- PDF 无效、空白、乱码或无法解析；
- 证据包泄露凭据；
- 会话结束后存在无法解释的运行时残留。

### PARTIAL

仅限不影响真实性的内容或排版缺口，例如个别法语来源不足、PDF 版式轻微瑕疵。模型身份、Thinking、Subagent 并发、真实 Web Tool Call、结构化失败、Todo verification 和 PDF 有效性都不能降级为 PARTIAL。

## 10. 交付格式

交付：

```text
<TestRoot>/evidence/INDEPENDENT-AUDIT-R2.zh.md
<TestRoot>/evidence/results.json
<TestRoot>/evidence/PICODE-MULTI-SUBAGENT-R2-EVIDENCE.zip
<TestRoot>/evidence/PICODE-MULTI-SUBAGENT-R2-EVIDENCE.zip.sha256
```

报告必须列出每个硬门的 `PASS / FAIL / BLOCKED`、对应证据路径、Session ID、Task ID、Subagent Run ID、实际模型与 Thinking。ZIP 前必须删除或脱敏账号、Token、Cookie、Vault、环境变量转储和完整请求头。

最终只允许给出 `GO`、`BLOCKED` 或 `NO-GO`；存在任何硬失败时不得用“总体可用”冲淡结论。
