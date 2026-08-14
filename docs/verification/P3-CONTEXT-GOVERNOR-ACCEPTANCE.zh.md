# P3 上下文治理与抗失真黑盒验收任务书

状态：**可执行任务书**  
适用范围：完成 P1–P2 后的 Picode V3  
裁决对象：Context Governor、近期证据保护、CJK 预算、Context Ledger、Durable
Compaction、Slice/Capsule 接续

本轮只回答一个问题：Picode 在接近真实上下文上限时，能否在不丢失当前工作证据的
前提下收敛上下文，并留下可审计、可恢复的交接链。

本轮不是 P4 统计结论。一次 Slice 样本不能证明机制普遍有效，但产品链路失败可以
直接判定为 Bug。

## 1. 范围

### 必测

1. 最近一个用户回合之后产生的 Tool Result 和必要 Thinking 不被 Governor 过早删除；
2. 中文/混合代码上下文估算不会危险地低估真实 Provider Token；
3. 小窗口模型同样受硬预算保护；
4. Retention、Governor、Durable Compaction、Capsule 四层都写入同一 Context Ledger；
5. 四层不会对同一材料形成无界重复压缩；
6. Durable Compaction 成功后，会话能够继续并保持关键事实；
7. 一对 A/B Slice 样本都能完成，B 组能从新进程恢复。

### 本轮不测

- 账号、OAuth、聊天导入；
- 微信、Remote Serve、手机端；
- Linux/macOS 发布矩阵；
- 缓存命中率的最终经济学结论；
- 多 Provider 统计显著性。

这些属于独立测试或 P4，不得混入本轮裁决。

## 2. 测试纪律

- 只使用已安装 Picode、公开 CLI/RPC、Git、文件系统和网络抓包工具。
- 不修改 `D:\otherproject\picode\v3` 的源码、测试、依赖和产品配置模板。
- 辅助脚本只能写在本轮 TestRoot，用于生成输入、统计 JSONL 和打包证据。
- 不得直接生成或修改 Session、Capsule、Manifest、Ledger 来冒充产品成功。
- 不得 commit、merge、rebase、push。
- 不得把账号文件、Authorization Header、API Key、OAuth Token、Cookie 或完整凭据
  放入报告和证据包。
- Agent 自述不算证据；以 Provider usage、抓包、Pi JSONL、Manifest、Ledger、Git diff
  和实际 Gate 输出为准。
- 发生产品错误时保留现场，不临时修改 Picode 后继续。

## 3. 固定环境

主测试模型固定为：

| 项 | 值 |
|---|---|
| Model | `cursor/grok-4.5`；真实 ID 不同时记录完整 ID，之后不得更换 |
| Thinking | `high` |
| Harness | `simple` |
| Prompt level | Simple 默认，不附加 Standard/TDD Prompt |
| Permission | `full`；不得使用 `danger-full-access` |
| Fallback | 禁止 |
| Skills/MCP/LSP | 本轮不新增，所有组保持一致 |

如该模型当前不可用，整轮记 `BLOCKED_MODEL`，不得用其他模型得出等价结论。

开始前保存：

```powershell
picode --version
git -C D:\otherproject\picode\v3 rev-parse HEAD
node --version
git --version
picode doctor
```

## 4. 隔离目录

创建：

```text
D:\temp\picode-p3-context-<timestamp>\
  fixture\
  state-main\
  state-small-window\
  drift-A\
  drift-B\
  state-drift-A\
  state-drift-B\
  traces\
  evidence\
  report\
```

规则：

1. 每个 `state-*` 都是独立 `PICODE_DIR`；
2. 只复制运行真实模型所需的最小认证材料，证据打包时排除；
3. 测试工作区从同一个干净 Git Commit 创建；
4. TestRoot 外不得产生测试项目文件；
5. 开始和结束都记录 Picode 仓库 `git status --short`，必须一致。

## 5. 第一阶段：基础链路

使用 `picode run` 或长连接 `picode rpc` 创建一条 Simple 会话。记录：

- Session ID 与 Session JSONL；
- Task ID；
- 完整模型 ID、Thinking、Harness、Permission；
- Provider 声明的 context window；
- `PICODE_DIR`；
- 初始 Cache Epoch。

随后进行一次小回合，要求 Agent 只读取 fixture 的一个短文件并原样返回其中的随机
Nonce。必须出现真实 `read` Tool Call/Result，且 Provider 返回成功。

完成标准：Session 可恢复，模型和档位未漂移，短回合成功。否则停止，裁决
`NO-GO/BASELINE`。

## 6. 第二阶段：接近上限时的近期证据保护

### 6.1 生成旧历史载荷

在 TestRoot 生成一份包含中文、英文、路径、TypeScript 片段和重复普通叙事的混合
载荷。载荷中放置 12 个随机 Fact，另存一份不交给 Agent 的 `expected-facts.json`。

通过 RPC 发送载荷，避免命令行长度上限。载荷目标为主模型有效窗口的
`72%–77%`，不得直接超过 80%。本步骤只要求 Agent 确认收到，不要求做代码工作。

如 Provider usage 表明已超过 80%，该样本无效，缩小载荷后从新 Session 重做；不得
在原 Session 中删除历史。

### 6.2 制造当前回合关键证据

在同一会话要求 Agent 调用一个只读终端命令，输出 16–32 KiB 文本。随机
`CURRENT_NONCE` 必须位于输出中间 40%–60% 区间，不能出现在 head/tail 预览内。
Tool Result 追加后，总预算应越过 Governor trigger。

同一 Agent 回合的下一次模型请求必须完成：

1. 从当前 Tool Result 取得 `CURRENT_NONCE`；
2. 对 Nonce 做任务书指定的确定性 SHA-256；
3. 写入回复，不得再次调用 read/bash 获取同一结果。

### 6.3 裁决

PASS 必须同时满足：

- 抓包或 Manifest 证明 Governor 在 Tool Result 后参与了请求；
- Provider 收到的请求低于 hard budget；
- 当前 Tool Result 未被替换为只剩 head/tail 的信封；
- Agent 返回正确 SHA-256；
- 取得 Nonce 后没有第二次工具调用；
- 当前回合若包含 Provider 必需的 Thinking 块，没有因剥离造成 API 错误。

以下任一项为 `P3-RECENCY-FAIL`：当前结果被当成旧历史压掉、Agent 猜测 Nonce、
重新读取才成功、Provider 因 Thinking 缺失报错、原始超预算请求被发送。

## 7. 第三阶段：CJK Token 安全校准

从真实 Session JSONL、Provider usage/抓包和 Context Compilation Manifest 取得同一
请求的三个值：

```text
provider_total_input = input + cacheRead + cacheWrite（按 Provider 实际字段归一化）
picode_before_tokens = Manifest.beforeTokens
picode_after_tokens  = Manifest.afterTokens
```

同时统计请求中 ASCII、CJK、代码和 Tool Result 的 UTF-8 字节数。不得用字符数除以
4 代替真实 usage。

计算：

```text
underestimate = max(0, provider_total_input - picode_before_tokens)
underestimate_rate = underestimate / provider_total_input
overestimate_rate = max(0, picode_before_tokens - provider_total_input) / provider_total_input
```

裁决：

- `underestimate_rate <= 5%`：PASS；
- `5% < underestimate_rate <= 10%`：PARTIAL，必须提高安全边际；
- `underestimate_rate > 10%`：FAIL；
- `overestimate_rate > 25%`：PARTIAL，属于成本/过早压缩问题，不是安全失败；
- usage 或 Manifest 缺失：`OBSERVABILITY_FAIL`，不得填写估算值冒充实测。

报告要给出本会话实际的 bytes-per-token，不能据一次样本宣称全语言通用系数。

## 8. 第四阶段：Context Ledger 四层闭环

继续使用同一会话：

1. 再产生一次大于 64 KiB 的纯文本 Tool Result，触发 Retention Artifact；
2. 等待当前 Agent Run settle；
3. 等待 Durable Compaction 产生终态；
4. 执行一次 `/slice`，创建 sealed Capsule 并进入新 Session；
5. 关闭进程，用新的 Picode 进程恢复新 Session；
6. 输入“继续”，要求复述 12 个 Fact、当前任务目标和最后一个未完成步骤。

从 `<PICODE_DIR>\metrics\context-ledger\*.jsonl` 读取本会话记录。必须观察到：

| Layer | 必需动作 |
|---|---|
| `retention` | `externalized`，带 Artifact 指针和前后体积 |
| `governor` | `compiled` 或明确的 `blocked` |
| `durable-compaction` | `scheduled` 后有 `completed`；失败可重试，但不能永久孤儿 |
| `capsule` | `sealed`，指向真实 Capsule 文件 |

账本规则：

- `eventId` 全局无重复；
- 同一确定性变换重放不能追加第二条；
- `sourceDigest → outputDigest` 能形成有向链；
- 不存在超过 60 秒仍无 `completed/failed` 的 scheduled 项；
- Ledger 不含完整 Tool Result、完整对话或密钥；
- Pi JSONL 仍是完整会话权威，Ledger 不能替代 transcript；
- Durable Compaction 后的下一请求不能同时重复注入旧紧急折叠通知和等价 compact
  摘要；
- 80% 以上连续请求超过 2 次仍未完成 durable compaction，记
  `P3-COMPACTION-LOOP`。

恢复后的 12 个 Fact：逐字事实必须 12/12；叙事允许转述。任何验收条件、路径、错误
串或待办状态被改写，记抗失真失败。

## 9. 第五阶段：小窗口模型无旁路

选择一个真实声明窗口不大于 32K 的模型/Endpoint，在独立 `PICODE_DIR` 重复一个
缩小版载荷测试：

1. 先达到声明窗口约 70%；
2. 再追加可使其越过 80% 的 Tool Result；
3. 观察 Governor compact 或 blocked；
4. 确认原始超预算请求没有到达 Provider。

没有合适 Endpoint 时记 `BLOCKED_SMALL_WINDOW`。这不是产品功能失败，但 P3 不得标为
完整通过。若小窗口模型直接绕过 Governor，则为 `P3-SMALL-WINDOW-FAIL`。

测试用的 Picode 内置 scripted provider 不可用于本项，因为它是明确的测试例外。

## 10. 第六阶段：一对 Slice 漂移确认样本

只有第 1–5 阶段没有 FAIL 才执行，避免在基础机制已坏时浪费 Token。

执行现有任务书：

- [`SLICE-CAPSULE-DRIFT-EXPERIMENT.zh.md`](./SLICE-CAPSULE-DRIFT-EXPERIMENT.zh.md)
- 修复确认规则：[`SLICE-CAPSULE-DRIFT-REPAIR-CONFIRMATION-R2.zh.md`](./SLICE-CAPSULE-DRIFT-REPAIR-CONFIRMATION-R2.zh.md)

本轮只跑一对 A/B：

- A：Simple、同一 Session、不使用 Slice；
- B：Simple、固定两次 Slice、每次从新进程恢复；
- 两组同 Commit、同模型、同 Thinking、同消息、同 Gate；
- 执行顺序随机化；
- B 必须恰有两份 Capsule，不得因为命令重试产生 3–4 份；
- `run.timeout` 但后台创建 Capsule 仍属于产品失败；
- `session not found`、空 Session、无法由新进程恢复均直接判产品失败。

这对样本用于确认链路和暴露回归。报告可以给漂移分，但不得从单对样本声称“下降
30% 已获统计证明”。

## 11. 证据

证据目录至少包含：

```text
evidence/
  environment.json
  commands.jsonl
  session-events/
  provider-usage/
  sanitized-traces/
  context-compilations/
  context-ledger/
  capsules/
  artifacts-index.json
  drift-A/
  drift-B/
  results.json
  P3-CONTEXT-GOVERNOR-ACCEPTANCE-REPORT.md
```

抓包必须先去除 Authorization、Cookie、Token、账号邮箱和完整 Base URL 凭据。完整
Tool Result Artifact 可以保留在 TestRoot，但证据包只放摘要、字节数、SHA-256 与
无敏感信息的必要片段。

`results.json` 每项使用：

```json
{
  "id": "P3-RECENCY",
  "status": "PASS|PARTIAL|FAIL|BLOCKED",
  "summary": "one sentence",
  "evidence": ["relative/path"],
  "productBug": true
}
```

## 12. 最终裁决

### GO

必须同时满足：

1. 基础链路通过；
2. 近期证据保护通过；
3. CJK 低估不超过 5%；
4. Context Ledger 四层闭合、无重复和孤儿；
5. Durable Compaction 完成且恢复事实 12/12；
6. 小窗口模型通过；
7. A/B 都完成，B 两次 Slice 均由新进程恢复；
8. 无 fallback、人工补实现、源码修改和敏感信息泄露。

### CONDITIONAL GO

只允许以下情况：小窗口 Endpoint 无法取得，或 Provider 不返回缓存 telemetry；其他
项目全部通过。报告必须明确缺失证据，不能写“视为通过”。

### NO-GO

任一真实 FAIL、上下文超限卡死、近期证据丢失、CJK 危险低估、压缩循环、Ledger
重复/孤儿、Capsule 无法恢复、A/B 任一组不完整，均为 NO-GO。

测试人员只提交报告、`results.json`、脱敏证据 ZIP 与 SHA-256，不修改 Picode。
