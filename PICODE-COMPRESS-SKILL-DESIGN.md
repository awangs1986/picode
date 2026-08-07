# Picode Context Compression & Correction 设计（/pi-compress + /pi-correct）

> 状态：设计稿 v1（可执行开发）  
> 日期：2026-08-04  
> 交付形态：Pi Extension（TypeScript）+ Role Prompt 集 + 存储契约。可先在原版 Pi 上独立运行（模式 A），后接入 Picode Rust Module 权威（模式 B）  
> 上位设计：[PICODE-NEXT-MASTER-ARCHITECTURE.md](PICODE-NEXT-MASTER-ARCHITECTURE.md)、[PICODE-HARNESS-PROMPT-DESIGN.md](PICODE-HARNESS-PROMPT-DESIGN.md)  
> 业界参照：Anthropic context editing / tool-result clearing；ACM（lossless offload + on-demand retrieval）；CAT/SWE-Compressor（里程碑处主动折叠）；CoMem（解耦异步压缩模型）；Self-Compacting Agents（时机优于方法）

---

## 0. 结论

本功能不是"把上下文变短"，而是**把上下文变成可审计的投影**。六条不可妥协原则：

1. **搬走 + 留引用，不销毁**。被压缩的内容完整落盘并编入索引，模型和用户随时可以按引用取回原文。压缩产物是视图，原文是权威。
2. **确定性变换先行**。截断大工具输出、折叠重复运行、保持 tool call/result 成对——这些由代码完成，零失真、零 token。模型只处理确定性规则处理不了的剩余部分。
3. **分类决定策略**。逐字保留 / 结构化归约 / 叙事摘要 / 折叠计数 / 提取后丢弃，五类五策。理解式重写只作用于叙事类。
4. **逐字事实永不改写**。目标、验收条件、用户决策、报错原文、标识符、数字：只允许复制。
5. **世代 ≤ 1**。压缩产物永不被再次压缩；重压必须回原文重建。
6. **修正只追加，不改历史**。/pi-correct 的产出是 append-only 的 supersede 块，配合索引标记失效，不原地重写 transcript。

模型分配原则：**省钱省在抽取和分类上，不省在理解上**。分类/抽取/校验用低级模型（抽取式操作无幻觉空间），叙事重写和纠偏调查用主力级模型（误解即漂移，正是本功能要消灭的成本）。

---

## 1. 目标与非目标

### 1.1 目标

- 用户主动 `/pi-compress` 触发，多级压缩前咨询确认。
- 压缩后原文全量备份、可索引、可检索、可展开。
- 压缩产物经过可红的保真 Gate 才允许换入。
- 用户发现语义漂移时用 `/pi-correct <描述>` 触发纠偏：subagent 对比备份与当前上下文 → 差异报告 → grill 式多轮问答对齐 → 用户确认后修正。
- 为模型提供 `compress_search` / `compress_expand` 工具，实现按需取回（ACM 路线）。

### 1.2 非目标

- 不做自动触发压缩（Picode 原生 compaction 兜底仍在；本功能只在用户或 Nudge 建议下主动执行）。
- 不替代 Task Capsule / Slice 机制；Slice 边界仍是首选压缩时机，本功能覆盖 Slice 内部的主动压缩。
- 不训练专用压缩模型（P5 之后按积累数据评估蒸馏）。
- v1 不做后台持续异步维护（CoMem 模式）；接口预留，见 §14。

---

## 2. 术语与唯一权威

| 术语 | 定义 | 唯一权威 |
|---|---|---|
| Compress Run | 一次 /pi-compress 的完整执行，产生一个 compress_id | 本 Extension（模式 B：Context & Memory） |
| Original Store | 被替换消息的逐字备份（JSONL）+ 大输出 Artifact | Original Store 目录，只追加 |
| Compress Index | compress_id → 源消息范围、digest、级别、世代、失效标记的索引 | `index.json`，只追加 + 标记 |
| Compact Package | 换入上下文的结构化压缩产物 | Compress Run 生成，保真 Gate 放行 |
| Inventory | 压缩前从原文提取的"必须存活清单" | Inventory pass 生成，保真 Gate 消费 |
| Fidelity Gate | 逐项核对 Inventory 是否在 Package 中存活的可红检查 | Fidelity Checker（模式 B：Verification） |
| Correction Block | /pi-correct 确认后追加的 supersede 块 | 用户确认 + Extension 写入 |
| Generation | 压缩世代；Package 恒为 1，禁止对 Package 再压缩 | Compress Index |

与 Picode 词汇的对接：Package 中的逐字事实区等价于 Task Capsule 的 Verbatim Facts；若压缩范围覆盖 Slice Contract / Capsule 内容，相应字段必须从 Task Control 权威源复制，不得从 transcript 推断（模式 A 无 Task Control 时，从 `<task_slice_contract>` 块原样复制）。

---

## 3. 交付形态与部署模式

### 3.1 模式 A：独立 Pi Extension（先行开发）

TypeScript Extension，注册命令、工具与 Role Prompt，子任务通过 `pi -p --no-session --no-extensions` 派生一次性 subagent。所有状态落在 workspace 的 `.picode/compress/`。可在原版 Pi 上完整运行，作为 Bridge Spike 的实弹验证之一。

### 3.2 模式 B：Picode 集成

命令入口迁移到 Command Registry；权威归位：Original Store/Index → Context & Memory；Fidelity Gate → Verification（产生 Evidence）；subagent → Work & Sandbox（WorkHandle、预算、取消）；涉及 Capsule 的修正 → Task Control revision。Prompt 与存储契约两模式完全一致，迁移只换宿主。

### 3.3 组件清单

```text
commands:   /pi-compress [safe|aggressive|structural|status]
            /pi-correct <free text>
            /expand <ref>
tools:      compress_search(query) -> bounded hits with refs
            compress_expand(ref)   -> bounded original excerpt
subagents:  classifier(low) | inventory(low) | compressor(high)
            fidelity(mid) | investigator(high)
storage:    .picode/compress/
config:     models per role, thresholds, token budgets
```

### 3.4 存储布局

```text
.picode/compress/
  index.json                  # 全局索引，只追加 + supersede 标记
  <compress_id>/
    manifest.json             # level, session, source range, digests,
                              # generation, models, timestamps, budgets
    original.jsonl            # 被替换消息的逐字副本
    artifacts/                # 截断的大工具输出全文
    inventory.json            # 必须存活清单 + 逐项核对结果
    package.md                # 换入的 Compact Package 正文
    corrections/<n>.json      # /pi-correct 产生的修正记录
```

`index.json` 条目：

```json
{
  "compress_id": "cmp_2026...",
  "session_id": "...",
  "source_range": {"from_msg": 41, "to_msg": 187},
  "level": "safe",
  "generation": 1,
  "package_digest": "sha256:...",
  "original_digest": "sha256:...",
  "created_at": "...",
  "superseded_blocks": [],
  "keywords": ["save system", "migration", "gate:save_v2_red"]
}
```

---

## 4. 压缩管线

```text
/pi-compress
  → S0 咨询与级别确认（用户）
  → S1 结构清理（确定性，零模型）
  → S2 分类打标（低级模型）
  → S3 Inventory 提取（低级模型，抽取式）
  → S4 分类转换（结构化归约=代码；叙事重写=主力模型）
  → S5 组装 Compact Package（代码，固定 schema）
  → S6 Fidelity Gate（中级模型逐项核对，可红）
  → S7 换入 + 落盘 + 索引（代码）
```

任何一步失败：中止，报告原因，上下文保持原状。**绝不换入未通过 S6 的产物。**

### 4.1 压缩级别

| 级别 | 包含步骤 | 策略差异 | 典型收益 |
|---|---|---|---|
| `structural` | S1+S5(仅归约)+S7 | 零模型：截断大输出存 Artifact、折叠重复运行、去重 | 工具密集对话 30–60% |
| `safe`（默认） | 全管线 | 闲聊提取后保留一行注记；叙事摘要保守（≤3:1）；失败循环折叠但保留每次错误签名 | 60–80% |
| `aggressive` | 全管线 | 闲聊提取后丢弃；失败循环折叠为"签名+次数+放弃原因"；叙事重写激进（≤6:1）；更早的已完成阶段降为 Capsule 引用 | 80–95% |

**任何级别下不可降级的三类**：用户决策与偏好、Gate/测试终态与错误签名、未决项。Inventory 对这三类要求 100% 存活，safe 与 aggressive 无差别。

### 4.2 内容五分类

| class | 判据 | 转换 |
|---|---|---|
| `verbatim` | 目标、验收条件、用户决策/偏好、契约、关键报错、标识符、数字 | 原文复制进 Package 事实区 |
| `evidence` | 测试/Gate/构建/lint 输出 | 结构化归约成证据表行 + Artifact 引用（代码完成） |
| `loop` | 同一命令/Gate 的重复执行序列 | 折叠："N 次，签名集合，终态，放弃/通过原因" |
| `narrative` | 探索、推理、方案讨论、实现过程叙述 | 主力模型理解式重写，带来源引用 |
| `chatter` | 与任务无关的对话 | 先抽取决策/偏好（进 verbatim），残余 safe 保留一行注记 / aggressive 丢弃 |

### 4.3 时机建议（非强制）

依据 Self-Compacting 的结论，Extension 在以下时点通过一次性 Nudge **建议**（不自动执行）`/pi-compress`：Slice/阶段刚完成、一个大调试循环刚收敛、context 占用超过配置阈值（默认 65%）且当前无进行中的原子操作。正在推理/修改中途不建议。

---

## 5. Compact Package Schema

换入上下文的唯一产物，固定结构，空节省略：

```text
<picode_compact_package id="{compress_id}" level="{level}" generation="1"
  source="msgs {from}-{to}" original="{index_ref}">

<facts>            # verbatim 类，逐字复制，禁止改写
- [decision] {原文}  (src: msg#{n})
- [acceptance] {原文} (src: msg#{n})
- [constraint] {原文} (src: msg#{n})
</facts>

<evidence>         # 证据表
| gate/check | runs | final | error signature | artifact |
|---|---|---|---|---|
| {id} | {n} | RED/GREEN/FLAKY | {sig} | {ref} |
</evidence>

<attempts>         # 失败尝试，防止重蹈
- tried {approach} x{n}; failed: {sig}; abandoned because {reason} (src: msg#{n}-{m})
</attempts>

<narrative>        # 理解式重写产物，每段带来源
{compressed narrative}  (src: msg#{n}-{m})
</narrative>

<open_items>       # 未决项，100% 存活
- {item} (src: msg#{n})
</open_items>

<retrieval>
Use compress_search("{keyword}") or compress_expand("msg#{n}") to retrieve
verbatim originals. Do not guess content that can be retrieved.
</retrieval>
</picode_compact_package>
```

预算：Package 总量默认 ≤ 源内容 token 的 25%（safe）/ 10%（aggressive），且绝对上限可配（默认 8k tokens）。

---

## 6. /pi-compress 交互流程

### 6.1 咨询（S0）

`/pi-compress` 不带参数时，先跑 S1+S2 的**估算版**（只统计不转换），向用户呈现：

```text
Context: {total} tokens | 可压缩范围: msg#{from}-#{to}（保护近 {k} 条与当前原子操作）
分类估算: verbatim {a}% | evidence {b}% | loop {c}% | narrative {d}% | chatter {e}%
预计收益: structural ~{x}% | safe ~{y}% | aggressive ~{z}%
建议级别: {recommendation}（理由: {one line}）
选择: [safe] [aggressive] [structural] [取消]
```

推荐规则：evidence+loop 占比高 → structural 或 safe 即够；narrative 占比高且任务仍在同一目标内 → safe；跨越多个已完成阶段 → aggressive。

保护区：最近 K 条消息（默认 10）与未闭合的 tool call/result 对永不进入压缩范围。

### 6.2 已含 Package 的上下文再压缩

世代规则强制：压缩范围若含既有 Package，先经 index 取回其 original.jsonl 展开为原文参与本次压缩，新 Package 世代仍为 1；旧 compress_id 在 index 中标记 superseded_by。

---

## 7. 压缩侧提示词全文

规范英文正文（缓存与执行质量），按 PICODE-HARNESS-PROMPT-DESIGN §4.1 惯例。`{...}` 由 Extension 渲染。

### 7.1 Classifier（低级模型，S2）

```text
<picode_role role="compress_classifier" version="1">
You label transcript segments for compression. You do not rewrite anything.

Input: numbered transcript segments. For each segment output exactly one JSON
line: {"seg": n, "class": "...", "salience": 0-3, "keywords": [...]}

Classes:
- verbatim: user decisions or preferences, task goals, acceptance criteria,
  contracts, exact error messages worth keeping, identifiers, numbers, paths.
- evidence: test/gate/build/lint tool outputs and their invocations.
- loop: a repeated run of the same command or gate within this range.
- narrative: exploration, reasoning, design discussion, implementation talk.
- chatter: content unrelated to the project task.

Rules:
- When one segment mixes classes, split it: output multiple lines with "span"
  char ranges. Prefer over-marking verbatim: if unsure between verbatim and
  narrative, choose verbatim.
- salience: 3 = load-bearing for future work; 0 = safely discardable.
- keywords: 1-4 retrieval keywords per segment, lowercase.
- Output JSON lines only. No commentary.
</picode_role>
```

### 7.2 Inventory Extractor（低级模型，S3）

```text
<picode_role role="compress_inventory" version="1">
You extract the survival checklist for a compression run. Extraction only:
every item must be a copy or near-copy of source text with its message number.
Do not infer, merge, or rephrase beyond trimming.

From the supplied transcript range, list exhaustively:
1. decisions: every user decision, preference, or explicit approval.
2. gate_finals: every test/gate/check with its final status and, if failed,
   the exact error signature.
3. open_items: every unresolved question, TODO, known risk, or deferred task.
4. constraints: every stated constraint on scope, style, or approach.
5. artifacts: every file path, identifier, or number that later steps depend on.

Output JSON: {"decisions":[{"text","src"}], "gate_finals":[...],
"open_items":[...], "constraints":[...], "artifacts":[...]}

Completeness beats precision: when unsure whether something qualifies,
include it. Output JSON only.
</picode_role>
```

### 7.3 Narrative Compressor（主力模型，S4）

```text
<picode_role role="compress_narrative" version="1">
You rewrite the narrative portions of a development transcript into a shorter
faithful account for a future agent that will continue this work with no other
memory of these events.

You receive: (a) narrative segments with message numbers, (b) protected spans
that must be copied exactly if referenced, (c) a target length budget.

Rules:
- Preserve meaning, not wording; but copy protected spans (identifiers, error
  messages, numbers, quoted decisions) character-for-character.
- Preserve epistemic status exactly: keep "probably", "seems", "untested",
  "assumed" distinctions. Never upgrade a hypothesis into a fact or an open
  question into a conclusion.
- Preserve causality: why approaches were chosen, why they were abandoned.
- Every paragraph ends with its source reference: (src: msg#n-m).
- Do not include content already covered by the facts/evidence/attempts
  sections supplied to you; reference them instead.
- If the budget forces dropping something, drop detail, never drop the
  existence of an event. Prefer "X was also tried (src: msg#n)" over silence.
- Write plain factual prose. No headers, no bullet-point explosion, no
  meta-commentary about compression.
</picode_role>
```

### 7.4 Fidelity Checker（中级模型，S6）

```text
<picode_role role="compress_fidelity" version="1">
You verify a compression did not lose or distort load-bearing content.
You are a gate, not an editor.

You receive: (a) the inventory checklist with source quotes, (b) the candidate
compact package, (c) access to original excerpts via provided lookups.

For every inventory item, judge exactly one verdict:
- survived: present in the package, meaning intact (verbatim classes must be
  character-identical).
- weakened: present but with altered meaning, dropped qualifier, changed
  status, or lost precision. Quote both versions.
- missing: absent from the package.

Then scan the package for unsupported claims: statements not entailed by the
original transcript. Quote each.

Output JSON: {"items":[{"id","verdict","detail"}],
"unsupported":[{"package_quote","reason"}], "pass": true|false}

pass=true only if zero missing, zero weakened in decisions/gate_finals/
open_items, and zero unsupported claims. Judge strictly; a false pass here
becomes silent context drift later. Output JSON only.
</picode_role>
```

S6 失败处理：将 `weakened/missing/unsupported` 清单回灌 Compressor 自动修复**一次**；再失败则中止本次压缩并向用户报告明细。

---

## 8. /pi-correct 纠偏流程

用户在执行中发现语义变了或行为偏差：

```text
/pi-correct 存档迁移的版本号规则好像和我们之前定的不一样
```

```text
S1 调查: investigator subagent（只读）检索 Original Store + 当前上下文
S2 报告: 差异表（原文说 X / 当前上下文呈现为 Y / 来源引用）
S3 对齐: grill 式多轮问答，逐项确认正确语义
S4 应用: 用户确认后追加 Correction Block + 更新 index supersede 标记
S5 复检: 修正涉及 Capsule/Slice Contract 时升级到 Task Control revision
```

### 8.1 Investigator（主力模型，只读）

```text
<picode_role role="correct_investigator" version="1">
The user reports that the current working context seems semantically wrong or
drifted. Your job is to find where the current context diverges from the
original record. You are read-only; you never edit anything.

You receive: (a) the user's complaint, (b) the current effective context
including compact packages, (c) search and expand tools over the original
transcript store (compress_search, compress_expand).

Method:
1. Extract the topics and claims implied by the complaint.
2. Retrieve the original passages for those topics from the store. Quote them.
3. Locate how the same topics are represented in the current context
   (package sections, capsule facts, recent messages). Quote them.
4. Compare. Classify each finding:
   - drift: current context states something the original record contradicts.
   - loss: original contains a decision/constraint absent from current context.
   - fabrication: current context contains a claim with no support in the
     original record.
   - no_issue: representations match; say so honestly.

Output a bounded report (max {n} findings, ordered by severity):
for each finding: {type, original_quote+src, current_quote+location,
one_sentence_impact}. If the complaint itself appears mistaken, report
no_issue findings with the evidence. Do not propose fixes yet.
</picode_role>
```

### 8.2 对齐问答（grill 模式，主对话内执行）

调查报告返回后，主 Agent 按以下规则与用户对齐（作为一次性 Role 指令注入）：

```text
<picode_role role="correct_alignment" version="1">
Align the true semantics with the user before any fix is applied.

Rules:
- One question at a time. Never bundle questions.
- Ground every question in a specific finding: quote the original and the
  current version, then ask which is correct — or neither.
- Prefer closed options: [original is right] [current is right]
  [neither, let me restate]. Free text always allowed.
- When the user restates, read it back in your own words and ask for
  confirmation before recording it.
- Do not defend the compression, do not explain why drift happened, do not
  editorialize. Collect verdicts.
- Stop when: all findings have verdicts, or the user says stop, or {k}
  questions were asked (then summarize remaining findings and ask whether
  to continue).
- Finish by listing the confirmed corrections verbatim and asking for one
  final approval to apply.
</picode_role>
```

### 8.3 Correction Block（S4，用户批准后由代码追加）

不改写历史，append-only：

```text
<picode_context_correction id="{correction_id}" supersedes="{compress_id}#{section}"
  confirmed_by="user" at="{ts}">
The following corrected facts supersede any conflicting earlier statement or
summary in this context:
- {corrected fact, verbatim as confirmed}  (was: "{superseded quote}")
- ...
Treat superseded versions as void. Corrected facts are authoritative.
</picode_context_correction>
```

同时：`corrections/<n>.json` 落盘（findings、问答记录、最终确认文本、涉及的 package sections）；index 中对应 section 标记 superseded；Package 的 facts 区若被修正，下次 recompress 必须从 correction 记录 + 原文重建。

### 8.4 升级规则

- 修正内容命中 Capsule Verbatim Facts / Slice Contract / Gate 终态 → 模式 B 下必须走 Task Control / Verification 的 revision，不允许 Extension 私改；模式 A 下在 Correction Block 中显式标注 `escalation: slice_contract`，并提示用户更新对应块。
- 修正后若同一 compress_id 已累计 ≥2 次修正，建议用户对该范围执行一次 recompress（从原文 + corrections 重建，开新 Cache Epoch），避免"补丁摞补丁"。

---

## 9. 检索工具（模型侧）

```text
compress_search(query: string, limit?: number)
  → [{ref: "msg#123", compress_id, excerpt: "...", keywords: [...]}]
     检索范围 = Original Store 全文 + Package 正文 + keywords 索引。

compress_expand(ref: string, radius?: number)
  → 该消息原文及前后 radius 条的有界摘录（默认上限 2k tokens）。
```

工具 description 中写明（进 schema，不进 system prompt）：

```text
compress_search: Search the verbatim originals of previously compressed
context. Use when a compact package references something you need in full,
or when the user disputes what was said earlier. Never guess content that
can be retrieved.
```

`/expand <ref>` 是同能力的用户手动入口。

---

## 10. 与 Picode 的集成点

| 集成点 | 内容 |
|---|---|
| Event Nudge | 新增 `compress.suggest`（§4.3 时机建议，一次性）；复用 `compact.notice` 防冲突：本 Extension 触发的压缩期间抑制原生 compaction |
| Prompt Composer | Package 与 Correction Block 作为 append-only context event 注入，遵循 §3.1 注入顺序，不重写 system prompt |
| Cache | 换入 Package = 开新 Cache Epoch（一次 miss，随后稳定）；Correction Block 为尾部追加，不破坏前缀 |
| Evidence | 模式 B：Fidelity Gate 结果进 Evidence Ledger；/pi-correct 的确认记录作为 Context Revision 证据 |
| Observability | §13 指标并入 Picode 观测面 |

---

## 11. 模型与预算配置

```json
{
  "models": {
    "classifier": "low",        
    "inventory": "low",
    "compressor": "primary",    
    "fidelity": "mid",
    "investigator": "primary"
  },
  "budgets": {
    "package_ratio_safe": 0.25,
    "package_ratio_aggressive": 0.10,
    "package_abs_max_tokens": 8000,
    "protected_recent_messages": 10,
    "fidelity_repair_rounds": 1,
    "grill_max_questions": 7,
    "expand_excerpt_max_tokens": 2000
  },
  "triggers": { "suggest_at_context_pct": 65 }
}
```

`low/mid/primary` 映射到用户模型 Catalog 中的相对档位；subagent 全部走 `pi -p` 一次性会话（模式 B：Work Spec）。

---

## 12. 验证 Gate（可红）

单元：

1. S1 结构清理保持 tool call/result 成对；截断内容与 Artifact 逐字节一致。
2. 分类混合段拆分正确；verbatim 偏向规则生效（构造模糊样例）。
3. Package 组装：空节省略、预算超限即失败、来源引用全覆盖。
4. 世代规则：对含 Package 的范围压缩时强制展开原文；直接压缩 Package 文本必须被代码路径阻止。
5. index supersede 链无环、可追溯到每个 correction。

集成（红灯设计——每条先证明能红）：

6. 构造"摘要弱化限定词"样本（"大概能跑"→"能跑"），Fidelity Gate 必须 `weakened` 拦截。
7. 构造 Inventory 项在 Package 缺失，S6 必须 `missing` 拦截且不换入。
8. Fidelity 自动修复超过 1 轮必须中止并保持原上下文。
9. /pi-correct 全流程：预埋一个已知漂移的 Package，investigator 必须检出 `drift`，且未经用户最终批准时上下文零变化。
10. 修正命中 Slice Contract 时必须出现 escalation 标记（模式 B：Task Control revision）。

行为评估（对齐 PICODE-HARNESS-PROMPT-DESIGN §18.3）：固定任务集上，新会话分别加载压缩前 / safe / aggressive 上下文继续任务，对比：续作正确率、compress_expand 调用率（过高=压过头，趋零=可更激进）、/pi-correct 触发率、总 token。

---

## 13. 观测指标

- 各级别压缩比（按 class 分解）、S6 一次通过率、自动修复率、中止率；
- Package token 占比与 Cache Epoch 成本；
- `compress_search`/`compress_expand` 命中率（核心调参信号）；
- /pi-correct 触发次数、finding 类型分布（drift/loss/fabrication）——这是项目级**漂移 KPI**；
- 同一 compress_id 的修正次数分布（≥2 触发 recompress 建议）。

日志不记录 Secret Value；Package 与 original 落盘前过既有脱敏管线。

---

## 14. 实施切面

**M1（模式 A 可用）**：存储布局 + /pi-compress structural + safe（S1–S7 全管线）+ /expand + compress_search。  
**M2**：aggressive 级别 + 咨询估算（S0 统计版）+ compress.suggest Nudge。  
**M3**：/pi-correct 全流程（investigator + grill + Correction Block + supersede）。  
**M4（模式 B）**：权威迁移（Context & Memory / Verification / Work & Sandbox / Task Control），Fidelity 进 Evidence。  
**预留**：后台异步维护 worker（CoMem 模式）——S1–S4 在空闲时持续预计算，/pi-compress 时只执行 S5–S7；接口已按此切分，无需重构。

---

## 15. 最终判断

这个功能的价值排序是：**可取回（index/expand）> 可验证（Fidelity Gate）> 可纠偏（/pi-correct）> 压缩比**。压缩比是最不重要的指标——任何时候在压缩比和保真之间取舍，选保真；用户要更多空间时，答案是 aggressive 级别 + 按需检索，而不是放松 Gate。
