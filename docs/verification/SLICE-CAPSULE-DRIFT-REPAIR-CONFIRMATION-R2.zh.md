# Slice / Capsule 漂移实验：修复确认轮 R2

状态：**可执行黑盒任务书**
目标：确认 Pilot #1 的两个产品故障已经消失，并重新取得一对有效 A/B 样本。
基础故事与产品契约：[`SLICE-CAPSULE-DRIFT-EXPERIMENT.zh.md`](./SLICE-CAPSULE-DRIFT-EXPERIMENT.zh.md)。

> 本轮不是统计结论。不得因为一次 B 优于 A 就宣布 Slice 有效，也不得因为一次
> Agent 执行波动就删除 Slice。首先判断实验是否有效、产品链路是否闭合。

## 1. 测试人员权限与禁止事项

测试人员只能使用已安装的 `picode` CLI/TUI、Git 和项目自身测试命令进行黑盒验收。

- 不得修改 `D:\otherproject\picode\v3` 的任何源码、测试、配置模板或依赖。
- 不得临时修复 Picode；发现产品 Bug 只记录证据。
- 不得用脚本直接生成 Session、Capsule 或 Evidence 来冒充 Picode 成功。
- 不得手工补做 Agent 遗漏的 ReplayLedger 功能。
- 不得 commit、merge、rebase、push。
- 不得把账号文件、OAuth Token、API Key、Cursor 状态目录打进证据包。
- A/B 必须使用同一个 Picode Commit、同一个模型和同一份初始 Git Commit。

开始前记录：

```powershell
picode --version
git -C D:\otherproject\picode\v3 rev-parse HEAD
node --version
git --version
```

## 2. 固定模型与执行档位

两组及独立盲审必须固定为：

| 项 | 固定值 |
|---|---|
| Model | `cursor/grok-4.5`；若真实 ID 不同，记录完整 ID 后全程只用该 ID |
| Thinking | `high` |
| Harness | `simple` |
| Prompt level | Pi/Simple 默认，不额外注入 Standard/TDD Prompt |
| Permission | 两组一致 |
| Skills/MCP/LSP | 两组一致；本故事不新增能力 |
| Fallback | 禁止 |

先运行：

```powershell
picode --list-models grok-4.5
```

每组首轮保存模型、Thinking、Harness 和 Session identity。任何一项不符，整组记
`INVALID`，不得换模型继续。

## 3. 完全隔离的 TestRoot

不要复用 Pilot #1 的工作区或状态目录。建议：

```text
D:\temp\picode-slice-r2-<timestamp>\
  baseline\
  replay-ledger-A\
  replay-ledger-B\
  state-A\
  state-B\
  evidence\A\
  evidence\B\
  hidden\
```

要求：

1. `state-A` 与 `state-B` 是不同的 `PICODE_DIR`。
2. A/B 不共享 Session、Task、Capsule、Evidence、`node_modules` 或构建产物。
3. 两个工作区都从同一个 `BASE_COMMIT` 创建。
4. 如果隔离状态缺账号，只把日常状态中的最小账号/Auth 文件等同复制到 A/B；
   不执行会改变账号选择的实验步骤，且证据包必须排除这些文件。
5. 不得让 B 读取 A 的源码、diff、测试输出、Session 或报告。

创建基线和 Worktree 后验证：

```powershell
git -C <A> rev-parse HEAD
git -C <B> rev-parse HEAD
git -C <A> status --short
git -C <B> status --short
```

初始 HEAD 必须相同，status 必须为空。

## 4. 随机执行顺序

本轮不得固定 A→B。测试人员先生成一次随机顺序并立即写入
`evidence\execution-order.json`：

```powershell
@('A-B','B-A') | Get-Random
```

选中后不得因某组失败而更换顺序。另一组只有在前一组完成或明确终止后才开始，
避免 Provider 并发负载成为变量。

## 5. 唯一变量

| 组 | Harness | Session 策略 |
|---|---|---|
| A | `simple` | 全程同一 Session；禁止 `/slice` |
| B | `simple` | 固定节点执行两次 `/slice`；每次由新进程恢复 |

除此之外，用户消息、阶段顺序、模型、Thinking、权限、测试命令和验收器全部一致。

## 6. ReplayLedger 故事

严格使用基础任务书 §4 的 ReplayLedger 最终契约：Node.js 22 + TypeScript ESM，
实现回放迁移、last-wins 去重、确定性演算、SHA-256、报告与四个 CLI 命令。

阶段消息必须逐字使用基础任务书 §5 的六段 Prompt：

1. 契约与骨架；
2. v1→v2 迁移、排序与临时 first-wins；
3. 受控需求纠正为 **last-wins** + 状态演算；
4. CLI 与 JSON/Markdown 报告；
5. 跨模块集成；
6. 最终 test/typecheck/build/smoke 与 diff 检查。

每阶段 Agent 完成后必须停下。测试人员保存该阶段的用户原文、Session identity、
终态、Git diff 摘要和实际测试输出。不得把后续阶段一次性塞给 Agent。

## 7. B 组两次 Slice 的强制即时检查

### 7.1 第一次 Slice

阶段 2 完成后，按基础任务书发送第一次 `/slice`，intent 是阶段 3 的完整需求修订。

`/slice` 返回后，**不要立刻继续**。先执行并保存以下黑盒证据：

1. `run.completed` 返回了新的 `sessionId` 与 `sessionFile`；
2. `sessionFile` 在文件系统真实存在且不是 0 字节；
3. 结束本次 Picode 进程；
4. 用一个新的 `picode` 进程执行 Session resume/status；
5. 新进程能读取 Task Binding、Capsule intent 和工作区；
6. 然后才输入：

```text
继续。只执行当前 Capsule 指定的阶段，完成后停下。
```

任一条件失败：记录 `PRODUCT_FAIL_SLICE_1`，B 组停止，不得手工改 Session 路径。

### 7.2 第二次 Slice

阶段 4 完成后对阶段 5 重复同样流程，必须再次关闭旧进程并用新进程恢复。

任一条件失败：记录 `PRODUCT_FAIL_SLICE_2`，不得继续假装阶段 5 已执行。

### 7.3 Capsule 内容检查

B 最终必须恰有两份 sealed Capsule。逐份检查：

- `taskId`、`taskRevision`、`workspaceSnapshot`、digest 有效；
- intent 与对应阶段需求一致；
- `filesTouched` 最多 200 条；
- tracked 变更优先出现在 `filesTouched`；
- 不得包含未跟踪的 `node_modules`、`.pnpm-store`、`.yarn/cache`、`.gradle/caches`；
- 真实变更超过 200 条时，必须存在正数 `filesTouchedOmitted`；
- `filesTouchedOmitted = 真实合格变更数 - filesTouched.length`；
- 未超过 200 条时不得伪造省略数量；
- 未完成 Todo、Gate/Evidence 引用不得被空数组静默掩盖。

完整真实变更集合用 Git 独立计算；不要依赖 Agent 自述。

## 8. 最终机器验收

两组结束后才注入同一份隐藏测试，并执行基础任务书 §6 的十项检查：

- `npm test`；
- `npm run typecheck`；
- `npm run build`；
- 四个 CLI smoke 与退出码；
- 迁移幂等、失败无半截文件；
- last-wins；
- 20 次确定性运行；
- replay/report normalize 职责不串位；
- 无越界文件、无 Git 发布操作；
- B 两份 Capsule 完整。

隐藏测试必须以行为断言为主。检查“旧 first-wins 是否复活”时：

- 不得用未经解析的全文关键词搜索；
- 注释、错误说明中的 `not first-wins` 不得判失败；
- 必须通过真实重复事件输入验证 last-wins 输出；
- 如做源码扫描，必须先剥离注释并保存扫描器版本。

## 9. 漂移与缓存记录

沿用基础任务书 §7、§8 的计分和计算公式。特别要求：

- `session not found`、不存在的 JSONL、漏阶段必须单列产品故障，不能只折算成漂移分；
- 未完成的组不得参与 Token、成本和缓存优劣比较；
- Provider 未返回 telemetry 时标记 `CACHE_TELEMETRY_UNAVAILABLE/PARTIAL`；
- 不得把 0 当作 0% 命中率；
- 同时报告包含冷启动的总命中率与排除每个 Session 首轮的稳定段命中率。

## 10. 盲审

按基础任务书 §9 执行：去除 A/B、Session、Capsule 等可识别信息，随机命名为
candidate-1/2；使用新的 Grok 4.5 high + Simple Session，只读审查最终 SPEC、diff、
源码和实际测试输出。审完两份前不得揭盲。

## 11. 本轮裁决

### VALID REPAIR CONFIRMATION

必须同时满足：

1. A/B 都完成六个阶段和最终验收；
2. B 两次 Slice 都生成真实 JSONL，并由新进程恢复；
3. B 恰有两份 sealed Capsule；
4. Capsule 无依赖目录污染，边界和省略数量正确；
5. B 的隐藏验收和最终 Gate 不低于 A；
6. 没有模型 fallback、人工补实现或 Picode 源码修改。

### PRODUCT NO-GO

任一项成立即判产品仍有真实故障：

- `session not found` 或 Slice 返回不存在的文件；
- 第二个进程无法恢复；
- Capsule 数量、绑定、digest 或文件事实错误；
- B 因 Picode 控制链问题无法继续；
- Picode 在 A/B 之间泄漏状态。

### EXPERIMENT INVALID

模型/Thinking/Harness 不一致、工作区或状态未隔离、B 读取 A、测试人员修源码、
隐藏验收器误判注释、账号 fallback 等均记 `INVALID`，不得拿来评价 Slice。

即使本轮为 VALID，也只证明修复成立。要宣称 Slice 降低漂移，之后仍需至少三对
有效重复，并交替执行顺序。

## 12. 必交付物

```text
evidence/
  REPAIR-CONFIRMATION-REPORT.md
  results.json
  environment.json
  execution-order.json
  prompts.txt
  A/
    session-ids.txt
    stage-results.json
    provider-usage.json
    cache-summary.json
    git-diff.patch
    gate-output.txt
    hidden-test-output.txt
    drift-score.json
    reviewer.json
    capsules/              # 必须为空
  B/
    session-ids.txt
    slice-1-resume.json
    slice-2-resume.json
    stage-results.json
    provider-usage.json
    cache-summary.json
    git-diff.patch
    gate-output.txt
    hidden-test-output.txt
    drift-score.json
    reviewer.json
    capsules/              # 恰有两份
```

报告首页必须给出：`VALID REPAIR CONFIRMATION`、`PRODUCT NO-GO` 或
`EXPERIMENT INVALID` 三者之一，并列出每个硬条件的证据路径。证据 ZIP 必须排除
账号、Token、Key、Vault、Cursor SDK 状态与 Picode 日常用户数据。
