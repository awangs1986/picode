# Picode 300k 上下文溢出：claude-tap 抓包诊断任务书

状态：**可执行黑盒诊断任务**
目标会话：`019fe7c8-7f1c-7877-ad4c-9e8894133296`

> 本任务只诊断，不修改 Picode 源码，不修改会话内容，不修复反代。
> 任务名称是 `claude-tap`，不是 Clash 的 TUN/TAP 抓包功能。

## 1. 诊断问题

验证以下错误发生时，真正发送给反代的请求包含多少内容：

```text
Error Code context_too_large
Context overflow recovery failed
Summarization failed: OpenAI API error (400)
```

必须区分：

1. Picode 估算的上下文过大；
2. Picode 额外注入了过多 system/context/tool 内容；
3. 压缩请求自身携带了过多历史；
4. 反代实际路由或有效限制与模型声明不一致。

## 2. 安全与禁止事项

- 不修改 `D:\otherproject\picode\v3` 源码、配置模板或会话 JSONL。
- 不执行 `git commit`、`merge`、`rebase`、`push`。
- 不把 API Key、OAuth Token、Cookie、Authorization header、账号文件或完整私密会话打进证据包。
- 不把完整 request body 上传到第三方；证据只保存在本机。
- 只允许复现一次目标长上下文请求；避免重复消耗模型费用。
- 如果工具捕获内容未自动脱敏，立即停止并删除该捕获文件，不得提交。

## 3. 环境记录

在隔离目录 `$TestRoot` 下执行并保存：

```powershell
$TestRoot = "D:\temp\picode-context-tap-$(Get-Date -Format yyyyMMdd-HHmmss)"
New-Item -ItemType Directory -Force $TestRoot, "$TestRoot\traces" | Out-Null

picode --version
python --version
claude-tap --version
git -C D:\otherproject\picode\v3 rev-parse HEAD
```

记录：

- Picode 版本和 Git commit；
- 当前模型完整 provider/model ID；
- Picode 显示的 `contextWindow`；
- 当前 Harness 档位、权限档位、thinking 等级；
- 反代 Base URL（域名可保留，API Key 必须隐藏）；
- 当前会话 ID 和 session 文件路径。

## 4. 启动 claude-tap

优先使用隔离 Python 环境安装：

```powershell
uv tool install claude-tap
```

如果机器没有 `uv`，才使用：

```powershell
python -m pip install --user claude-tap
```

先查看当前版本支持的参数：

```powershell
claude-tap --help
```

启动只代理模式。两条先决规则（已对照 claude-tap 0.1.142 源码核实）：

1. **`--tap-target` 不能带 `/v1` 后缀**。上游 URL = `--tap-target` 路径 + Picode 实际发送的路径；Picode 指向 `http://127.0.0.1:8787/v1` 时，若 target 也带 `/v1`，会拼出 `/v1/v1/chat/completions`（404）。例如账号 Base URL 是 `https://api.deepseek.com/v1`，则 `--tap-target` 传 `https://api.deepseek.com`。
2. **新捕获的 trace 写入本地 SQLite 数据库，不是 `--tap-output-dir`**（该参数只是 legacy 导入目录，live 模式下是空操作，不会保存新 trace）。默认位置 `%USERPROFILE%\.local\share\claude-tap\traces.sqlite3`，用环境变量 `CLOUDTAP_DB` 指到测试目录：

```powershell
$env:CLOUDTAP_DB = "$TestRoot\traces.sqlite3"
claude-tap `
  --tap-no-launch `
  --tap-no-open `
  --tap-proxy-mode reverse `
  --tap-target "<REAL_BASE_URL_WITHOUT_V1_SUFFIX>" `
  --tap-port 8787
```

启动输出会打印 `📁 Trace session: <uuid>`，记下该 uuid（后续用 `claude-tap export <uuid> -o ...` 导出）。

保持该窗口运行。不要使用 `claude-tap --tap-client pi` 代替 Picode，因为那会启动独立的原版 Pi，不能证明 Picode 的请求内容。

### Picode 指向本地 tap

在隔离账号或临时 API 配置中，把 Base URL 临时指向：

```text
http://127.0.0.1:8787/v1
```

API Key 仍使用原配置，但不能写入报告。保持组合一致：Picode Base URL 带 `/v1` 时 `--tap-target` 不带；反之若 `--tap-target` 带 `/v1`，Picode Base URL 就不带 `/v1`（`http://127.0.0.1:8787`）。

确认 Picode 的请求确实经过本地 tap 后，再开始长上下文复现。tap 日志对每条请求会打印 `→ POST /v1/chat/completions (model=..., upstream=<真实上游 URL>)`，这条 upstream URL 是“反代实际收到内容”的直接证据，必须记录。

`--tap-no-launch` 下监听地址默认是 `0.0.0.0`，不影响 127.0.0.1 访问；live 看板默认端口 19527（`--tap-no-open` 只是不自动开浏览器，可手动访问 `http://127.0.0.1:19527`）。若实际端口/路径不同，以 `claude-tap --help` 和启动输出为准，并记录实际值。

## 5. 抓包前基线

在 Picode 目标会话中先记录：

```text
/status
/model
/thinking
/harness
/permissions
```

保存脱敏后的输出。不要先执行 `/compact`，不要切换模型，不要切换 Harness。

然后发送一次最小探针，确认请求已被捕获：

```text
只回复 TAP-BASELINE，不调用工具，不修改文件。
```

在 claude-tap trace viewer（手动打开 `http://127.0.0.1:19527`，或用 `claude-tap export <uuid> --format json -o "$TestRoot\traces\baseline.jsonl"` 导出）中确认出现一条 Picode 请求。记录该请求的：

- endpoint/path；
- model；
- input token（如果 provider 返回）；
- cached input token；
- output token；
- system/message/tool 数量；
- 是否包含 `reasoning`、`include` 或工具 schema。

## 6. 目标长上下文复现

在目标会话 `019fe7c8-7f1c-7877-ad4c-9e8894133296` 中，执行一次会触发同类请求的继续操作。注意：Picode 会话与创建它的工作目录绑定，必须从该会话所属目录启动 Picode 并续接该会话（本任务中该会话属于 `D:\otherproject\picode\v3andorid`，以本机 session 文件路径为准）。优先使用原来导致错误的用户输入；如果无法恢复原输入，使用下面的替代指令：

```text
请继续当前任务。先完整回顾当前会话的目标、最近决策、未完成事项和当前工作区状态，然后只输出下一步计划，不要修改文件，不要调用工具。
```

只发送一次。等待请求完成或明确出现 `context_too_large` / `Summarization failed`。如果第一次请求已经触发自动压缩，必须继续收集压缩请求和压缩后的重试请求，直到本轮结束。

## 7. 必须采集的请求序列

按时间顺序给每条请求编号：

| 序号 | 类型 | 必须记录 |
|---|---|---|
| 1 | 正常继续请求 | input、system、tools、messages、usage、错误 |
| 2 | overflow 触发后的压缩请求 | 输入 token、摘要模型、压缩 prompt 长度 |
| 3 | 压缩后重试请求 | 压缩后的 input token、是否成功 |
| 4 | 失败重试/错误请求 | HTTP 状态、错误类型、是否有 response body |

若没有出现某一类请求，标记 `NOT_OBSERVED`，不得伪造。

## 8. 统计方法

对每条请求记录以下分项。若工具无法提供精确 token，记录字符数/字节数并标记估算：

```json
{
  "requestKind": "normal|compaction|retry",
  "model": "<provider/model>",
  "inputTokens": null,
  "cachedInputTokens": null,
  "outputTokens": null,
  "systemChars": 0,
  "conversationChars": 0,
  "toolSchemaChars": 0,
  "toolResultChars": 0,
  "reasoningChars": 0,
  "taskStateChars": 0,
  "skillsChars": 0,
  "projectContextChars": 0,
  "error": null
}
```

至少计算：

```text
Picode 估算上下文
反代实际 input tokens
非会话额外内容 = 实际 input - 会话历史估算
压缩请求 input tokens
工具 schema 占比
```

## 9. 结论规则

### Picode 上下文组装问题

满足任一条件即可登记为 Picode 侧问题：

- Picode 报告约 300k，但 tap 捕获超过 300k 很多；
- Simple 模式仍注入 Standard/TDD 的 Task、Gate、Capsule、Skills 内容；
- Tool schema 或 tool result 占据异常比例；
- 压缩请求再次携带接近完整 300k 历史；
- 压缩后重试仍包含未被压缩的旧历史。

### 反代/路由问题

满足以下条件时，优先登记为反代或模型路由问题：

- Picode 发送的实际 input 明显低于有效模型容量；
- 请求中没有异常额外注入；
- 反代将模型名路由到较小上下文模型；
- 反代在请求未超限时仍返回 `context_too_large`。

### 统计/估算问题

如果 Picode 的 `contextUsage` 与 tap 的实际 input 相差超过 10%，但请求内容本身没有异常，登记为 token 估算或 usage 映射问题。

## 10. 交付物

目录结构：

```text
$TestRoot/
  environment.json
  baseline.json
  target-session.json
  request-sequence.json
  component-breakdown.json
  verdict.md
  traces.sqlite3           # CLOUDTAP_DB 指向的 tap 原始库，仅本机保留
  traces/                  # claude-tap export 导出的 JSONL/bundle（含脱敏统计）
  redacted-trace.zip       # 可交付脱敏证据
```

`verdict.md` 第一行必须是以下之一：

```text
PICODE-CONTEXT-ASSEMBLY-BUG
PICODE-CONTEXT-ESTIMATION-BUG
UPSTREAM-OR-PROXY-LIMIT
INCONCLUSIVE
```

报告必须附：

- 目标会话 ID；
- Picode 版本和 commit；
- 实际模型 ID；
- 每条请求的 token/字节统计；
- 正常请求、压缩请求、重试请求的区别；
- 是否发现 Picode 注入内容过多；
- 是否发现压缩请求本身超限；
- 反代返回的 HTTP 状态和脱敏错误；
- 完整证据 SHA-256。

## 11. 清理

测试结束后：

1. 停止 claude-tap；
2. 恢复 Picode 原来的 Base URL；
3. 确认没有残留本地代理环境变量；
4. 删除包含 Authorization、API Key、OAuth 或完整私密 prompt 的文件；
5. 只保留脱敏后的统计和必要 trace 片段。
