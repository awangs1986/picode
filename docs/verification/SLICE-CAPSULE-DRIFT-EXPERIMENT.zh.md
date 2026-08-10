# Slice / Capsule 中型项目双组漂移实验任务书

状态：**可执行试验稿**

测试故事：使用 Picode 从同一 Git 基线开发 `ReplayLedger`——一个跨平台、确定性的游戏回放验证 CLI。

目的：只改变 Slice/Capsule 这一项，测量它对长任务漂移、真实 Provider 缓存和总成本的影响。

## 1. 唯一变量

本实验只有两组，二者都使用同一版本 Picode：

| 组别 | Harness | Slice/Capsule |
|---|---|---|
| A：连续会话 | `simple` | 关闭；全程保持同一会话，不执行 `/slice` |
| B：Slice 会话 | `simple` | 开启；在固定节点执行两次 `/slice`，由 sealed Capsule 接续 |

不设置“原版 Pi”执行组。本文中的 Pi runtime 均指 Picode 内 vendored Pi；Simple 模式负责提供接近原版 Pi 的薄执行面。

两组必须完全一致：

- Picode Commit；
- 初始 Git Commit；
- Provider、账号和模型；
- 系统提示词等级；
- Harness、权限和 Thinking；
- 用户指令及其顺序；
- Node 版本、操作系统和测试命令；
- 最终评分器与盲审 Prompt。

禁止一组安装另一组没有的 Skill、MCP、LSP 或扩展。禁止在实验中临时修复 Picode。

## 2. 模型硬约束

执行端和独立盲审端都必须满足：

- 模型：**Grok 4.5**；
- Thinking：**high**；
- Harness：**simple**；
- 不允许模型 fallback。

先发现本机实际模型 ID：

```powershell
picode --list-models grok-4.5
```

从输出中选定唯一的 Grok 4.5，记录完整 `provider/model-id`。两组以及盲审端都使用这个精确 ID：

```powershell
picode --model "<provider>/<grok-4.5-model-id>" --thinking high
```

进入后执行：

```text
/harness simple
/session
```

保存 `/session` 证据。若显示的模型不是选定的 Grok 4.5、Thinking 不是 `high`、Harness 不是 `simple`，该轮记为 `INVALID`，不得换模型继续。

## 3. 仓库与隔离

建立一个只含任务书、fixtures 和空源码目录的基线仓库：

```text
replay-ledger-baseline/
  SPEC.md
  package.json
  tsconfig.json
  fixtures/
    v1-basic/
    v2-duplicate-events/
    invalid-negative-tick/
  src/
  test/
```

冻结为 `BASE_COMMIT`，然后从同一 Commit 创建两个目录或 Worktree：

```powershell
git worktree add ..\replay-ledger-A -b experiment/no-slice <BASE_COMMIT>
git worktree add ..\replay-ledger-B -b experiment/with-slice <BASE_COMMIT>
```

两组不得共享 `node_modules`、构建产物、会话文件或未提交修改。Agent 永远不能 commit、merge、rebase 或 push。

## 4. ReplayLedger 最终契约

实现 Node.js 22 + TypeScript ESM CLI，不使用数据库和网络。除测试工具外不增加运行时依赖。

### 4.1 输入

一个回放包由 `manifest.json` 与 `events.jsonl` 构成。

`manifest.json`：

```json
{
  "schemaVersion": 2,
  "seed": 12345,
  "fixedStepMs": 16,
  "playerId": "p1"
}
```

每个事件至少包含：

```json
{"eventId":"e1","tick":0,"type":"move","payload":{"dx":1,"dy":-1}}
```

支持事件：

- `move`：整数 `dx/dy`；
- `damage`：整数 `amount`，生命最低为 0；
- `heal`：整数 `amount`，生命最高为 100；
- `checkpoint`：记录当前状态，不改变状态。

初始状态固定为 `{x:0,y:0,hp:100}`。禁止浮点累计；相同输入必须产生字节一致的规范化 JSON。

### 4.2 迁移

- v1 的 `frame` 迁移为 v2 的 `tick`；
- v1 的 `player` 迁移为 `playerId`；
- 输入文件只读；输出使用临时文件 + 原子 rename；
- 任一步失败不得留下半截目标文件；
- 已是 v2 的输入重复迁移必须幂等。

### 4.3 排序与校验

- 事件按 `tick` 升序，再按 `eventId` 字典序排序；
- `tick`、位移和数值必须是整数；负数 `tick` 为错误；
- 未知事件类型为错误；
- 每个 tick 后生成规范状态 SHA-256；
- 错误输出必须包含稳定的错误代码，不依赖自然语言匹配。

### 4.4 CLI

必须提供：

```text
replay-ledger inspect <bundle>
replay-ledger migrate <bundle> --out <dir>
replay-ledger verify <bundle>
replay-ledger report <bundle> --format json|markdown --out <file>
```

退出码：成功 `0`，输入/校验错误 `2`，内部错误 `3`。`--out` 必须真正生效。

### 4.5 结构边界

至少保持这些职责分离：

```text
src/domain/        schema 与稳定错误
src/migration/     v1 → v2，不负责报告格式
src/replay/        排序、归一化与状态演算
src/report/        JSON/Markdown 投影
src/cli/           参数与退出码
```

特别注意：`src/replay/normalize.ts` 与 `src/report/normalize.ts` 名称相似，但前者处理领域事件，后者只处理展示格式，禁止互相替代。

## 5. 固定执行阶段

测试人员必须逐阶段发送下列指令。Agent 每阶段完成后必须停下，不得预做后续阶段。

### 阶段 1：契约与骨架

两组发送完全相同的消息：

```text
阅读 SPEC.md 和 fixtures。只完成阶段1：建立 TypeScript ESM 工程骨架、领域类型、稳定错误类型和输入解析。补对应测试并实际运行。不要实现迁移、模拟、报告和 CLI；完成后停下，汇报实际测试结果与未完成项。严禁 commit、merge、rebase、push。
```

### 阶段 2：迁移与规范化

```text
只完成阶段2：实现 v1→v2 原子迁移、幂等迁移、事件排序与基础校验。此阶段重复 eventId 的临时规则是“第一次出现者生效，后续重复项产生 warning”。补单元测试和迁移失败无半截文件测试；完成后停下。
```

阶段 2 完成后保存 Git diff、测试输出、会话 ID 和 Provider usage。这是第一个固定切片点。

### 阶段 3：受控需求纠正 + 演算

最终需求在此处发生一次明确修订，旧规则从此作废。

A 组直接发送：

```text
需求修订：重复 eventId 改为“events.jsonl 中最后一次出现者生效”，仍须产生 warning；“第一次出现者生效”立即废弃，后续代码、测试和文档不得恢复旧规则。只完成阶段3：更新上述契约并实现确定性状态演算、每 tick SHA-256 与 checkpoint。补测试，完成后停下。
```

B 组执行：

```text
/slice 需求修订：重复 eventId 改为“events.jsonl 中最后一次出现者生效”，仍须产生 warning；“第一次出现者生效”立即废弃，后续代码、测试和文档不得恢复旧规则。下一阶段只实现确定性状态演算、每 tick SHA-256 与 checkpoint，并补测试。
```

新会话出现后，B 组只输入：

```text
继续。只执行当前 Capsule 指定的阶段，完成后停下。
```

### 阶段 4：CLI 与报告

两组下一阶段 intent 相同：

```text
只完成阶段4：实现 inspect/migrate/verify/report 四个 CLI 命令、稳定退出码、--out、JSON 与 Markdown 报告。保持 replay normalize 与 report normalize 的边界。补 CLI 集成测试，完成后停下。
```

A 组作为普通消息发送；B 组也作为普通消息发送。本阶段完成后保存证据，这是第二个固定切片点。

### 阶段 5：跨模块集成

A 组直接发送：

```text
只完成阶段5：增加覆盖 v1迁移→去重→排序→演算→报告→CLI 退出码的跨模块集成测试；修复真实失败，但不得削弱断言或恢复已废弃的“首次重复项生效”规则。完成后停下。
```

B 组执行：

```text
/slice 只完成阶段5：增加覆盖 v1迁移→去重→排序→演算→报告→CLI 退出码的跨模块集成测试；修复真实失败，但不得削弱断言或恢复已废弃的“首次重复项生效”规则。
```

新会话出现后输入：

```text
继续。只执行当前 Capsule 指定的阶段，完成后停下。
```

### 阶段 6：最终交付检查

两组发送相同消息：

```text
只完成阶段6：对照 SPEC.md 逐项检查最终实现，运行 test、typecheck、build 和 CLI smoke；检查 Git diff、越界文件、旧需求复活和未完成项。不得 commit、merge、rebase、push。不得只声称通过，必须给出实际命令、退出码和失败项。
```

## 6. 机器验收

最终评分不得以 Agent 自述为准。测试人员或固定脚本检查：

1. `npm test`、`npm run typecheck`、`npm run build` 全绿；
2. 四个 CLI 命令及三类退出码符合契约；
3. v1 迁移幂等且失败无半截文件；
4. 重复 `eventId` 是**最后一次出现者生效**；
5. 旧的“第一次出现者生效”没有残留在实现、测试或文档；
6. 负 tick、未知事件、非法整数返回稳定错误代码；
7. 同一回放连续运行 20 次，规范 JSON 和 SHA-256 完全一致；
8. `replay/normalize` 与 `report/normalize` 没有职责串位；
9. 无范围外文件，无 Agent commit/push；
10. B 组恰有两份 sealed Capsule，且 Task/Revision/Snapshot 绑定正确。

为两个结果使用同一份隐藏验收测试。隐藏测试只能在两组结束后同时注入。

## 7. 漂移计分

| 事件 | 分值 |
|---|---:|
| 关键验收事实丢失 | 5 |
| 已废弃的“首次重复项生效”复活 | 8 |
| 漏掉一个跨模块契约 | 5 |
| 错改相似名称模块职责 | 5 |
| 错误宣称完成/测试通过 | 5 |
| 重复实现已完成阶段 | 3 |
| 修改范围外文件 | 3 |
| 需要用户纠正一次 | 2 |
| Capsule 的 `filesTouched` 漏真实文件 | 每个 1 |
| Capsule 遗漏红灯 Gate/未决项 | 每项 3 |

总分越低越好。另记录隐藏测试通过数，不能用低漂移分掩盖产品未完成。

## 8. 真实 Provider 缓存统计

从每个 Pi 会话 JSONL 的 assistant usage 汇总：

- `input`；
- `cacheRead`；
- `cacheWrite`；
- `output`；
- cost；
- 每轮 provider/model；
- Cache Epoch 数量；
- 总耗时。

统一计算：

```text
promptVolume = input + cacheRead + cacheWrite
cacheHitRate = cacheRead / promptVolume
uncachedRate = (input + cacheWrite) / promptVolume
```

必须同时报告：

1. **实际总命中率**：包含每个会话首轮，反映 Slice 的真实冷启动成本；
2. **稳定段命中率**：排除每个会话第一条 assistant response，用于判断固定前缀是否稳定；
3. A/B 总输入、总输出、总成本与完成时间；
4. B 组两次 Slice 前后各自的 Cache Epoch 和首轮 miss。

若 Provider 没返回 cache telemetry，标记 `CACHE_TELEMETRY_UNAVAILABLE`，不得把 0 当作 0% 命中率。

## 9. 独立盲审

将两组分别复制为 `candidate-1`、`candidate-2`，删除会话 ID、组名、Capsule 路径等可识别信息。使用一个全新 Picode Simple 会话，模型仍为同一 Grok 4.5、Thinking high，只读审查：

```text
你是独立验收者。只依据最终 SPEC、Git diff、源码和真实测试输出审查，不修改文件，不相信候选 Agent 的自述。输出 JSON：criticalFactsMissing、obsoleteDecisionRevived、crossModuleDefects、scopeViolations、falseCompletionClaims、duplicateWork、testEvidenceProblems、summary。不得猜测候选使用了哪种上下文策略。
```

候选顺序由随机数决定并保存；完成两份审查前不得揭盲。

## 10. 结果裁决

首轮只算 **pilot pair**，不能据一次运行宣布统计结论。若流程有效，再做至少 3 个配对重复，并交替执行顺序：A→B、B→A、A→B。

Slice/Capsule 值得保留需同时满足：

- B 组严重漂移事件不高于 A 组，且配对总漂移分中位数至少下降 30%；
- B 组隐藏测试与最终 Gate 不低于 A 组；
- B 组没有错误 Capsule 注入、旧要求复活或红灯 Gate 丢失；
- B 组总 Token 增幅不超过 20%；
- B 组总耗时增幅不超过 25%；
- 稳定段缓存命中率没有出现无法解释的系统性退化。

如果 B 只提高正确率但成本超限，应调低切片频率，而不是立即否定 Capsule；如果 B 的 Capsule 自身携带错误事实，则优先修 Capsule 权威生成与校验。

## 11. 必交证据

每组单独保存：

```text
evidence/
  environment.json
  model-session.txt
  prompts.txt
  session-ids.txt
  provider-usage.json
  cache-summary.json
  git-diff.patch
  gate-output.txt
  hidden-test-output.txt
  drift-score.json
  reviewer.json
  capsules/          # A 组必须为空；B 组恰有两份
```

最终报告必须明确列出无效轮次、模型 fallback、人工介入和 telemetry 缺失，禁止只交一个 PASS/FAIL。
