# Picode 盲工具发现 + 多 Subagent Web 调研 + PDF 黑盒验收任务书

状态：`not_run`。本文是产品黑盒任务书，不是自动测试通过记录。

## 1. 验收目标

用一个完整用户故事同时验证：

1. 主 Agent 固定使用 GPT-5.6 Terra；
2. 至少四个并行研究 Subagent 固定使用 GPT-5.6 Luna；
3. 模型只收到用户目标时，能自行发现、激活并调用一个未进入当前 Tool Schema 的可选能力；
4. 每个研究 Subagent 都真实调用 Web Search 和页面抓取；
5. 主 Agent 能读取各子任务结果、处理来源冲突并生成可验证的中文 PDF；
6. Session、Run、模型、Thinking、Tool Call、Capability Lease 与成品均有运行时证据。

禁止用模型自述代替事件、状态、文件或工具结果。

## 2. 测试环境与止损规则

- 使用真实 `picode` 发布入口，不直接运行源码内部函数。
- 使用安全的空工作区，不在系统目录、Picode 源码仓库或用户项目内测试。
- 允许使用日常 Account Vault，但证据包不得包含 API Key、OAuth Token、Cookie、完整账号配置或 Vault 文件。
- 单个研究 Subagent 最多重试一次；重试仍必须使用 GPT-5.6 Luna。
- 任一指定模型不可用时标记 `BLOCKED`，禁止 fallback。
- Web Provider 未就绪时标记 `BLOCKED`，禁止用 Bash、`curl`、模型记忆或人工搜索冒充。
- 盲发现目标没有真实可调用 Adapter 时，盲发现阶段标记 `BLOCKED`，不得只凭 Catalog 文本判 PASS。
- 总运行时间建议不超过 30 分钟；超过后停止并保留现场。

建议目录：

```text
<TestRoot>/
  workspace/
  evidence/
  capability-state-before.json
  capability-state-after.json
```

## 3. 主模型与 Subagent 模型设置

在 TUI 中依次执行：

```text
/harness standard
/model
/thinking
/subagent-model
```

必须选择：

- 主 Agent：模型 ID 为 `gpt-5.6-terra` 的可用项；
- 主 Agent Thinking：`High`；
- Subagent：模型 ID 为 `gpt-5.6-luna` 的可用项；
- Subagent Thinking：`Medium`；
- Permission：`full`。

记录完整 `provider/model`。主模型和子模型可以来自不同 Provider，但最终证据必须与用户实际选择完全一致。

`researcher` 内建角色当前有角色级 `thinking: medium`，所以本剧本使用 Medium。若测试其他 Thinking，必须以子进程解析后的实际值裁决，不能只检查 Picode 配置文件。

## 4. 盲工具发现探针

### 4.1 测试人员准备

先在模型不可见的终端记录能力状态：

```powershell
picode capability status > <TestRoot>\capability-state-before.json
```

选择一个满足以下条件的目标能力：

- 已安装；
- Enabled + Trusted；
- 当前 Stopped，且完整 Tool Schema 尚未进入本会话；
- 有真实可调用 Adapter；
- 对本任务具有明确、自然的用途；
- 使用不会发送敏感数据或造成不可逆副作用。

优先选择与“并行任务监看”“来源资料检索”或“报告生成”相关的能力。不要为了让测试变绿而新增生产代码。若本机没有满足条件的能力，本阶段如实标记 `BLOCKED`。

测试人员记录目标 Capability ID，但**不得把 ID、工具名、`search_tools`、`activate` 或 Lease 等实现词写进用户 Prompt**。

### 4.2 给模型的目标描述

测试人员只用产品结果描述目标。例如目标是独立的多任务监控能力时，仅追加：

```text
研究开始后，请打开一个独立于内建 FleetView 的可选监控面板，
用它观察四个并行研究任务，并在最终证据中记录该面板实际观察到的运行状态。
如果当前环境没有这种能力，请明确报告缺失，不要安装替代品。
```

如果选择的是其他目标能力，用同样原则改写为结果要求，仍不得透露能力名称或发现机制。

### 4.3 通过条件

完整事件轨迹必须显示：

1. 模型主动调用 `search_tools` 的 search action；
2. 查询语义来自用户目标，而不是硬编码 Capability ID；
3. 搜索结果包含测试人员预选的目标能力；
4. 模型请求 Activate，Guard 确认 Enabled + Trusted；
5. Engine 产生 `ActiveCapabilityLease`；
6. registered 路径只在轮次边界改变 Tool Schema，并开启新 Cache Epoch；
7. 模型在新工具实际可见后成功调用目标能力；
8. 任务完成或会话结束后 Lease 被释放，没有残留进程、端口或网络连接。

只搜索到名称、只打印帮助、Activate 失败后继续假装调用，或者模型在 Prompt 中被直接告知工具名，都不是通过。

## 5. 用户研究任务

将第 4.2 节的盲目标描述与下面 Prompt 合并后，一次性发送给主 Agent：

```text
这是一次 Picode 产品黑盒验收。

研究主题：

《2025 年法国苗族（Hmong）群体的生活情况》

你是主 Agent，必须保持当前 GPT-5.6 Terra，不得切换模型。

一、并行研究

通过 pi-subagents 同时启动至少四个 fresh-context researcher Subagent。
所有 Subagent 必须保持当前配置的 GPT-5.6 Luna，不得使用 fallback。
必须先发出全部研究任务，再开始等待结果；不得完成一个后才启动下一个。

四个互不重复的方向：

1. 法国苗族人口估计、迁移历史、主要居住地区，以及法国族群统计制度的限制；
2. 2025 年前后的就业、收入、住房、教育、医疗和社会融入；
3. 家庭结构、代际差异、语言、宗教、文化活动和社区组织；
4. 独立来源审计：核查官方、学术和苗族社区资料，识别常见数字或说法中的证据缺口。

每个 researcher 必须：

- 真实调用 web_search；
- 至少抓取并阅读两个来源页面；
- 优先使用官方、学术和社区一手来源；
- 返回带可点击 URL、来源年份、置信度和证据缺口的独立简报；
- 不得用 Bash、curl、主 Agent 搜索结果或模型记忆替代自己的 Web 工具调用。

二、研究纪律

- 至少保留 12 个不同 URL，其中至少 4 个法语来源；
- 2025 年没有直接数据时可以使用最近年份资料，但必须明确标注年份；
- 区分“2025 年发布的资料”和“描述 2025 年实际生活状态的资料”；
- 法国族群统计存在制度限制，未经证实的估计不得写成官方人口数字；
- 每项关键结论必须能追溯到来源；
- 冲突来源必须并列说明，不得静默选择更符合叙事的一方；
- 无法验证的内容进入“证据缺口”，不得编造。

三、主 Agent 汇总

读取全部 Subagent 正式结果后，由 GPT-5.6 Terra：

1. 比较四份简报并消除重复；
2. 对关键来源和冲突结论进行二次检查；
3. 区分可靠事实、合理推断和证据缺口；
4. 生成中文 Markdown 报告；
5. 通过可重复执行的构建步骤生成 PDF；
6. 独立验证 PDF 可打开、正文可提取、页数合理且中文不乱码。

四、交付物

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

PDF 要求：

- 6–12 页；
- 包含标题、执行摘要、方法、主要发现、证据限制、结论和参考资料；
- URL 可点击或以完整文本显示；
- 中文字体正常；
- 不是空白、截图集合或改扩展名的文本文件。

execution-evidence.json 必须记录主 Session ID、主模型、Subagent Run ID、
每个子任务的实际模型和 Thinking、开始/结束时间、Web 工具名称与次数、
Capability Lease，以及最终 PDF 的路径、大小和页数。
这些值必须来自运行时状态，不得根据模型自述填写。
```

## 6. 独立证据审计

测试人员在 Agent 结束后独立检查：

1. 主 Session 事件中的实际 Provider/Model；
2. 至少四个不同 Subagent Run ID；
3. 所有子任务解析后的 Provider/Model 均为 GPT-5.6 Luna；
4. 至少三个 Subagent 的运行时间发生重叠；
5. 每个子任务均有真实 `web_search` 和页面抓取 Tool Result；
6. 主 Agent 在子结果完成后确实读取了这些结果；
7. 盲发现事件满足第 4.3 节八项条件；
8. PDF 文件头为 `%PDF-`，能由独立解析器读取正文；
9. PDF 与 Markdown 的标题、关键结论、来源数量一致；
10. 没有凭据、Cookie、Token 或完整 Vault 内容进入证据包。

Agent 自己生成的 `execution-evidence.json` 只能作为索引，不能作为唯一证据。

## 7. 裁决

### PASS

- 主模型精确为 GPT-5.6 Terra；
- 至少四个并行 Subagent 全部精确为 GPT-5.6 Luna；
- 盲发现完成 search → admitted activation → Lease → 真实调用 → release；
- 每个 Subagent 都有真实 Web Search 和抓取证据；
- 来源与研究纪律满足要求；
- PDF 独立验证通过；
- 无 fallback、伪工具调用、凭据泄漏或残留进程。

### PARTIAL

核心运行链成立，但存在不影响真实性的内容或排版缺口，例如法语来源数量略少、PDF 版式轻微问题。模型身份、盲发现、Web Tool Call 和 PDF 有效性不能降级为 PARTIAL。

### BLOCKED

指定模型、Web Provider 或安全可调用的盲发现目标在测试前不可用。必须保留诊断证据，不得换模型、安装未授权组件或改用人工搜索。

### NO-GO

出现任一情况：

- 主/子模型不符或发生 fallback；
- 少于四个子任务，或没有真实并发；
- Prompt 泄露目标工具名后才“发现”；
- 只搜索到能力但未真实激活/调用；
- 任一研究 Subagent 没有真实 Web 工具证据；
- 主 Agent 代替失败子任务完成研究却声称通过；
- PDF 无效、空白、乱码或无法解析；
- 证据包包含凭据；
- 会话结束后仍有无法解释的 Lease、进程、端口或网络连接。

