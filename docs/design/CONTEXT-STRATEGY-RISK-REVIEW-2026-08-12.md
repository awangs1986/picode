# Picode 上下文策略风险预评估

状态：019ff330 已成为运行时修复裁决；其余优化仍待参照组验证
日期：2026-08-12
范围：Picode V3 的上下文组装、工具结果回灌、Reasoning 保留、自动压缩、缓存前缀和 Slice/Capsule 接续。

## 1. 结论摘要

当前没有证据证明 Picode 注入了恶意或格式错误的 system prompt；但已有证据表明，长会话的有效请求可能被以下内容共同放大：

```text
历史消息
+ 完整 function_call_output
+ Android/UI XML 和构建日志
+ reasoning 项目
+ 压缩摘要
+ 工具 schema
+ 输出 token 预留
```

因此当前主要风险不是“错误提示词注入”，而是“合法但不应长期保留的工具轨迹没有及时降级为摘要”。这会造成：

- 输入 token 增长速度超过用户可见聊天内容增长速度；
- 自动压缩触发过晚，或者压缩请求自身先超限；
- 压缩失败后仍继续沿用旧历史，下一轮再次失败；
- 真实模型支持的上下文窗口与反代实际可接受窗口不一致；
- `max_output_tokens` 的大额预留挤压有效输入预算。

019ff330 已证明请求前预算与工具结果生命周期治理是 P0 缺口，因此这两项不再等待参照组；其余摘要质量、动态输出额度和 endpoint 学习策略仍等待对照数据。

### 1.1 2026-08-12 已实施的最小闭环

- `Devloop/context` 新增 Context Governor；
- 复用 Pi 0.84 原生 `context` event，在**每次** LLM 调用前运行，不只在用户新回合开始时运行；
- 完整预算包含 system、活动工具 schema、消息/Reasoning/Tool Result、上一轮 provider totalTokens 及新增尾部、输出预留与安全边际；
- 未验证第三方 Responses endpoint 的 effective window 暂按 320K 保守上限；
- trigger 后确定性 envelope 大型工具结果、移除旧 reasoning、折叠旧叙事；原 transcript 不改；
- 原请求超限时由 replacement active context 取代；仍不合格则 abort，禁止原请求送出；
- Agent settle 后触发 durable compaction，失败保留 retry pending；即使普通 compaction 被用户关闭，请求边界保护仍然启用。

## 2. 当前已观察到的证据

来自一次 claude-tap 成功请求的本地副本：

- HTTP 200，`status=completed`；
- `input_tokens=110174`，`output_tokens=2659`；
- `input` 有 161 个条目；
- 20 个 function call、15 个 function call output；
- 119 个 blob；
- 9 个工具 schema，工具 schema 不是主要体积来源；
- `max_output_tokens=128000`；
- `truncation=disabled`；
- 50 个 reasoning blob，约 111k 字符；
- function output blob 约 331k 字符；
- 多个 Android UI XML、ADB、Gradle 和 PowerShell 输出单条达到约 20–27k 字符。

该请求不是 300k 失败请求，不能单独证明 `context_too_large` 的触发点。另需注意：用户提供的 SHA-256 与当前磁盘副本的 SHA-256 不一致，后续报告必须把“原始文件”和“本地副本”分开标识。

### 2.1 失败请求补充证据（019ff330）

后续取得的失败现场：

```text
D:\temp\picode-context-tap-20260812-081000\traces\captured-019ff330.ctap.json
D:\temp\picode-context-tap-20260812-081000\traces\full-context-request-019ff330.json
```

本地 capture SHA-256：

```text
211EE8062B535CAD65D6692B2E359239720995CAE7160DA65F6BD5A07C593B66
```

抓包只保存了流式响应的初始 `HTTP 200 / in_progress` 事件，没有保存后续 SSE 中的 `context_too_large` 终态；因此错误终态来自用户现场观察，输入构成来自完整请求文件。该限制不影响请求体积分析，但意味着当前 claude-tap 导出不能独立证明最终 HTTP/SSE 错误。

完整请求的静态构成：

| 项目 | 数值 |
|---|---:|
| 序列化请求体 | 约 1.59 MB |
| Input items | 404 |
| Message | 84 |
| Reasoning | 52 |
| Function call | 134 |
| Function call output | 134 |
| Function output 原始文本 | 约 1.11M 字符 |
| Reasoning JSON | 约 117k 字符 |
| Message JSON | 约 57k 字符 |
| Tool schema | 9 个，约 12.6k 字符 |
| `max_output_tokens` | 128000 |
| `truncation` | disabled |

工具结果按工具归因：

| 工具 | 次数 | 结果文本字符 |
|---|---:|---:|
| bash | 72 | 约 642k |
| read | 41 | 约 341k |
| fetch_content | 14 | 约 120k |
| web_search | 4 | 约 7k |

具体低价值大对象包括：

- 多份 20–27k 字符的 Android UI XML；
- 两份约 51k 字符、内容高度接近的彩色 diff；
- 多次约 33k 字符的完整测试输出；
- node_modules/文件搜索清单；
- 将 PNG 当文本读取后产生的约 27k 字符二进制乱码。

与前一份 110174 input tokens 的成功请求相比，Reasoning 体积仅从约 111k 增至约 117k，工具 schema 仍约 12.6k；而 function output 从约 331k 字符增至约 1.11M 字符。新增体积主要来自工具结果，而不是 system prompt、tool schema 或 Reasoning 重复。

本次实验中，用户明确要求关闭上下文压缩，以便快速把会话推到上限；随后 Agent 写入：

```json
{
  "compaction": {
    "enabled": false
  }
}
```

磁盘上的 `D:\otherproject\picode\v3andorid\.pi\settings.json` 与该记录一致。这个设置是本次测试的有意实验条件，不应被解释为产品误配置。由此得到目前最强的实验观察链：

```text
实验性关闭项目级自动压缩
→ 工具结果无界追加
→ 工具结果增长约 3.4 倍
→ 请求达到约 1.59 MB / 约 300k token 量级
→ Provider 拒绝；本次实验不具备自动压缩恢复路径
```

### 2.2 对实验结论的修正

关闭压缩本身不是待修复的 bug，它只是加速触发上限的测试手段。该实验真正验证的是两个独立问题：

1. 当自动压缩关闭、延迟或失败时，工具结果是否仍有单项和累计预算保护；
2. 发生 `context_too_large` 时，Picode 是否能在不丢失任务事实的前提下，主动建立可恢复的缩减请求。

因此不能简单得出“重新打开自动压缩即可修复”的结论。正常开启压缩时仍需测试：压缩触发是否早于 provider 拒绝、压缩请求自身是否受预算约束，以及压缩失败后的下一轮是否会继续携带同一批超大工具结果。

### 2.3 与参照诊断的交叉裁决

参照诊断提出的核心结论成立，并将本文件的置信度从“工具输出膨胀假设”提升为“已观测的产品级失败链”：

1. 会话 JSONL 在失败前记录了 `gpt-5.6-luna` 的成功回合：

   ```text
   input=18005, cacheRead=328192, output=417, totalTokens=346614
   ```

   随后的工具结果追加后，下一模型回合记录为 `stopReason=error`，错误为 `context_too_large`。同一会话后来对 `gpt-5.6-sol` 也记录了相同错误。

2. 因而可以确认：这条 Picode → 私有 Responses 代理链的有效可接受窗口低于继续追加后的请求规模。不能仅凭该 trace 把阈值精确命名为 350K、384K 或 400K，也不能据此推断官方 GPT 模型的理论窗口。

3. `cacheRead=328192` 与 `input=18005` 的算术和正好参与 `totalTokens=346614`。因此缓存命中是成本/传输优化，不是上下文预算豁免。任何只展示 `input` 而忽略 `cacheRead` 的上下文健康判断都是错误的。

4. Picode 的账号/模型元数据把该代理模型声明为 `contextWindow=1000000`。在本次实验中，自动压缩被有意关闭，所以不能把“压缩未触发”单独归因于错误元数据；但在正常开启压缩的长会话中，如果触发器继续信任这个未经验证的 1M 值，就会把压缩推迟到代理已经拒绝之后。这是需要修复的设计风险，而不是本次实验变量本身。

5. `truncation=disabled` 确实使 Responses 端不能替 Picode 自动删除旧 input；但它不是唯一根因。真正缺失的是发送前的有效预算 preflight，以及工具结果追加后对 active context 的强制重建。

据此，根因优先级修正为：

```text
P0  未验证的 endpoint/model 有效窗口参与压缩阈值
P0  工具结果追加后缺少发送前 context preflight
P0  cacheRead 未纳入面向用户/调度器的上下文预算投影
P1  持久 transcript 与 active context 没有成为两个明确的运行时对象
P1  历史 function output/reasoning 没有按生命周期降级
P1  context_too_large 后缺少“标记失效 → 强制压缩 → 缩减重试”的确定性恢复链
```

1. 当自动压缩关闭、延迟或失败时，工具结果是否仍有单项和累计预算保护；
2. 发生 `context_too_large` 时，Picode 是否能在不丢失任务事实的前提下，主动建立可恢复的缩减请求。

因此不能简单得出“重新打开自动压缩即可修复”的结论。正常开启压缩时仍需测试：压缩触发是否早于 provider 拒绝、压缩请求自身是否受预算约束，以及压缩失败后的下一轮是否会继续携带同一批超大工具结果。

## 3. 风险假设

### H-01：工具结果没有按生命周期降级

工具结果进入 Pi 会话历史后，可能长期以完整文本保留。尤其是 UI XML、构建日志、进程列表、网络状态和重复读取结果，通常只需要保留摘要、错误、关键路径和验证结论。

风险：上下文中出现大量合法但低价值的日志，导致长会话失真或超限。

### H-02：压缩触发点晚于“压缩请求可承受点”

当前第三方 Responses 压缩路径把消息分块到约 48k estimated tokens，但总请求还包含 system prompt、工具 schema、历史摘要和输出预留。分块预算并不等于 provider 的完整请求预算。

风险：压缩本身返回 400，随后原会话仍然携带旧历史，形成重复失败。

### H-03：`max_output_tokens` 过大造成有效预算误判

部分反代会按“输入 + 输出预留”检查窗口。即使输入尚未达到模型标称上限，`max_output_tokens=128000` 也可能让请求提前被拒绝。

风险：Picode 误以为模型支持 1M，就把过大的输出上限传给实际只接受较小窗口的反代。

### H-04：Reasoning 历史的保留策略过于昂贵

Responses API 的 reasoning 项目可能包含较大的加密内容。它们对恢复语义有价值，但不一定需要在每一轮都完整重放。

风险：reasoning token 与工具输出叠加，用户可见对话很短但输入 token 已很大。

### H-05：摘要与原始历史可能发生重复保留

压缩后如果同时保留旧工具结果、旧 reasoning、旧 summary 和新 Capsule，模型会看到相同事实的多份表达。

风险：上下文浪费、事实冲突和模型优先级判断不稳定。

### H-06：Context Header / 事件追加造成隐性增长

Picode 使用 append-only context event 注入任务状态、项目规则和工具摘要。这符合缓存纪律，但需要确认同一事实是否只追加一次，以及长间隔重申是否受 token 预算约束。

风险：状态头、TOOLS.md、项目规则和 Capsule 在多次恢复后重复出现。

### H-07：导入/恢复内容未充分区分“事实”和“轨迹”

外部聊天导入、Foreign Resume 和 Capsule 可能把原 agent 的工具名、日志或 reasoning 作为普通上下文重新注入。

风险：历史工具契约或旧 system 内容被误认为当前会话指令。

### H-08：缓存命中率指标不能代表上下文健康度

稳定前缀命中并不意味着请求短或内容干净。工具结果追加在尾部时，缓存可能仍然命中，但总输入持续膨胀。

风险：状态栏显示高命中率，掩盖了 uncached tail 和历史体积问题。

## 4. 当前实现中需要重点验证的边界

1. `session_before_compact` 触发时，`messagesToSummarize` 是否已经接近 provider 上限。
2. 自定义分块的 48k 预算是否包含 system、tools、previous summary 和 output reserve。
3. 压缩失败后，是否明确标记本轮历史为“待压缩”，而不是继续无限重试原请求。
4. 工具结果是否存在单项大小上限、重复结果去重和 XML/日志专用摘要策略。
5. `max_output_tokens` 是否根据剩余上下文预算动态收缩。
6. reasoning 项目在正常续聊、自动压缩、分支恢复和跨客户端恢复时分别保留多少。
7. Capsule 注入后，旧会话内容是否真的从新会话请求中移除。
8. `prompt_cache_key` 相同但历史锚点改变时，是否正确递增 Cache Epoch 并标记缓存归因。

## 5. 参照组实验设计

参照组不修改 Picode 代码，只改变上下文策略：

### A 组：当前 Picode 默认策略

- 自动压缩开启；
- 当前工具结果回灌方式；
- 当前模型和反代；
- 记录每轮请求前后的上下文指标。

### B 组：工具结果限额

- 同一任务和同一模型；
- 对 XML、构建日志、进程列表、网络状态设定固定输出上限；
- 超限结果只保留摘要、错误和路径。

### C 组：关闭旧 reasoning/工具轨迹重放

- 保留用户消息、助手结论、文件事实和失败证据；
- 不重放已完成的旧 reasoning 和完整工具输出；
- 对比恢复质量和 token 量。

### D 组：动态输出预算

- 根据估算剩余上下文动态设置 `max_output_tokens`；
- 不改变聊天内容和工具策略；
- 观察是否减少 400/context overflow。

每组至少运行同一长任务三次，不能只依据一次会话下结论。

## 6. 必须收集的指标

每轮请求只记录计数和摘要，不记录密钥及完整 prompt：

```text
input_tokens / output_tokens
serialized_request_bytes
input_item_count
message_count
reasoning_item_count / reasoning_chars
function_call_count
function_call_output_count / output_chars_by_tool
tool_schema_bytes
summary_bytes
capsule_bytes
max_output_tokens
context_window_claimed / context_window_observed
compact_triggered / compact_succeeded
cache_epoch / cache_hit_rate
```

## 7. 暂不修改的内容

在参照组完成前，暂不：

- 改动 Pi 原生 session 语义；
- 删除 reasoning 历史；
- 改变默认自动压缩阈值；
- 强行把模型上下文窗口改成 1M；
- 把所有工具结果一律截断；
- 用单次抓包结果认定某一模块为根因。

## 8. 预期裁决规则

- 如果 B 组明显降低输入 token 且不降低任务完成率：优先实现工具结果限额和摘要化。
- 如果 C 组降低 token 但恢复质量明显下降：保留 Capsule/事实区，减少 reasoning 和低价值轨迹。
- 如果 D 组有效：加入动态输出预算，而不是继续扩大模型标称窗口。
- 如果 A–D 差异很小：优先检查反代实际上下文限制、模型别名和请求头，而不是继续改 Picode 历史策略。
- 只有在失败请求的原始抓包确认存在重复 system/tool schema 后，才处理“提示词重复注入”问题。

## 9. 当前阶段结论

当前最可信的工作假设是：

> Picode 的长会话问题更像“工具轨迹和 reasoning 的保留策略过重”，而不是“错误提示词把上下文污染”。

该结论仍是预评估，等待参照组和真正 `context_too_large` 请求抓包后修订。
