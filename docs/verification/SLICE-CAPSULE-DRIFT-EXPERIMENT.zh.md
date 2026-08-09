# Slice / Capsule 长任务漂移度量实验

状态：**已设计，暂缓执行**  
目的：验证 Picode 的 Slice / Capsule 是否能在中型项目长任务中降低目标、事实、决策与完成状态的漂移，同时避免不可接受的 Token 和时间成本。

## 1. 核心原则

不能让 Agent 自己评价“是否漂移”。实验必须以权威任务契约、Git diff、Evidence、Gate 结果和最终产品行为为主要裁判。

必须分别验证：

1. Capsule 是否忠实保存权威事实。
2. 新会话能否依靠 Capsule、当前工作区和 Required Context Set 正确继续任务。
3. Slice / Capsule 是否真正改善最终产品结果。
4. 改善是否值得付出的 Token、缓存与交接成本。

切片时机和 Capsule 质量不得在第一轮实验中同时调整，否则失败时无法归因。

## 2. 完整对照设计

同一个仓库、任务、模型、权限与初始 Git Snapshot 运行三组：

| 组别 | 接续方式 |
|---|---|
| A：长会话基线 | 单一长会话持续执行，不切 Slice |
| B：普通摘要 | 切换新会话，只传模型自由摘要 |
| C：Capsule | 切换新会话，注入 sealed Capsule，并从权威文件重建 Required Context Set |

正式统计实验每组至少重复五次。开始阶段不直接运行完整统计实验，先按第 7 节的低成本路径验证。

## 3. 测试任务

使用真实中型项目中的跨模块功能，覆盖五至八个模块，例如：

1. 修改数据模型。
2. 增加旧版本迁移。
3. 修改 CLI 或对外接口。
4. 修改 UI/Adapter。
5. 增加单元测试。
6. 增加跨模块集成测试。
7. 更新设计文档。
8. 执行最终 Gate。

任务中应受控地加入漂移诱因：

- 中途修改一次验收标准。
- 推翻一个早期决策。
- 保留一个持续为红的 Gate。
- 设置两个名称相似但职责不同的模块。
- 保留未提交的工作区修改。
- 在后续 Slice 中加入用户纠正。
- Capsule 生成后改变 Task Revision 或 Workspace Snapshot，验证旧 Capsule 被拒绝。

## 4. 四层验收

### 4.1 Capsule 忠实度

使用机器生成的 Oracle 对比 Capsule：

- `intent` 是否保留最新目标。
- 验收条件、路径、命令和错误串是否逐字保存并带来源。
- 已废弃决策是否不会重新出现。
- `filesTouched` 是否覆盖真实 Git diff。
- 红灯 Gate 是否进入 `verificationRefs`。
- `openQuestions` 是否包含未解决事项。
- `nextSteps` 是否没有已完成或越界工作。

关键事实遗漏、错误改写和旧要求复活均计为严重漂移。

### 4.2 新会话接续能力

启动全新 Pi 会话，不提供旧 transcript，只提供：

- sealed Capsule；
- 当前工作区；
- Required Context Set；
- Capsule 引用的 Evidence。

要求新 Agent 首轮识别：当前目标、已完成工作、红灯 Gate、正确下一步以及禁止事项。随后继续完成剩余的小阶段，不能只做问答测试。

### 4.3 最终产品结果

以确定性证据判断：

- 单元测试和跨模块集成测试结果。
- 是否漏改模块间契约。
- 是否修改范围外文件。
- 是否错误宣称完成。
- 是否重复已完成工作。
- 是否恢复已废弃方案。
- 最终 Git diff 是否符合设计文档。

### 4.4 成本与效率

记录：

- 总输入/输出 Token。
- Cache 命中率与 Cache Epoch。
- 接续后的重复读取量。
- 完成总时间。
- 重做次数与用户纠正次数。
- Slice 次数与 Capsule 大小。

## 5. 建议通过标准

| 指标 | 门槛 |
|---|---:|
| 关键验收事实丢失 | 0 |
| 已废弃要求复活 | 0 |
| 错误 Task/Revision/Snapshot Capsule 被注入 | 0 |
| 红灯 Gate 被遗忘或错误宣称完成 | 0 |
| `filesTouched` 对真实 diff 的覆盖率 | ≥ 95% |
| 接续后下一步判断正确率 | ≥ 90% |
| C 组相对普通摘要的漂移事件下降 | ≥ 50% |
| C 组相对长会话的总 Token 增幅 | ≤ 15% |
| 跨模块集成 Gate 通过率 | 不低于基线组 |

阈值是首轮验收基线；取得真实数据后可以修订，但必须保留修订理由和原始结果。

## 6. Slice 阈值校准

第一轮固定在明确任务边界强制切片，只测试 Capsule 的质量和接续效果。

第二轮才校准当前软阈值（上下文 60% 或 40 轮）和硬阈值（上下文 82% 或 64 轮），分别观察过早切片、过晚切片、缓存 miss 和交接开销。

## 7. Token 受控执行路线

| 阶段 | 内容 | 模型成本 |
|---|---|---|
| L0 契约测试 | 固定事件与 Git diff 校验 Capsule 字段、绑定、拒绝逻辑 | 几乎为零 |
| L1 接续探针 | 标准 Capsule 注入新会话，完成状态问答和一个很小的继续动作 | 约 5k–15k Token/次 |
| L2 单任务对照 | 普通摘要与 Capsule 各接续一次，只完成一个剩余阶段 | 合计约 30k–100k Token |
| L3 完整实验 | A/B/C 三组、多任务、每组多次重复 | 可能达到数百万 Token |

当前建议只执行 L0–L2：

1. 程序自动验证 `filesTouched`、Gate、Revision、Snapshot 和 Evidence 引用。
2. 选择一个已完成约 60% 的真实任务。
3. 在同一节点分别生成普通摘要和 Capsule。
4. 启动两个新会话，各完成一个剩余的小阶段。
5. 比较遗漏、返工、错误修改和 Token。

只有 L2 显示 Capsule 明显优于普通摘要后，才批准 L3。事实核验和状态问答可以使用便宜模型，主模型只负责真实代码接续。

## 8. 实施前缺口

当前 Capsule v1 已具备 digest、Task Revision、Workspace Snapshot、sealed 生命周期和注入校验，但这些只能证明绑定与不可篡改，不能证明内容完整。

正式实验前必须增加基于以下权威源的自动交叉校验：

- Git diff → `filesTouched`；
- Task 状态 → `intent`、`nextSteps`、`openQuestions`；
- Evidence Ledger / Gate 状态 → `verificationRefs`；
- 当前 Task Revision 与 Workspace Snapshot → 注入资格。

不得完全相信模型自行填写 Capsule 字段。

