# ADR-0002: 存储采用纯文件权威，索引只是可重建缓存

- 状态：Accepted
- 日期：2026-08-06
- 决策人：作者
- 取代：R2 稿 D5（SQLite 为产品权威 + JSONL 工作副本）、九条需求第 7 条中"使用 SQLite 储存上下文"
- 修订记录：第 3 条"单实例单写者"前提被 ADR-0003 修订为"多进程 + 文件锁 + 原子写"
- 修订记录（2026-08-07，Q12 共用池决策）：~~会话留在 pi 默认位置，两入口共用~~（已被下一条撤销）。配置格式跟随 pi 用 JSON（读取兼容 JSONC 注释）仍有效
- 修订记录（2026-08-07，Q10 独立 pi）：共用池前提消失——Picode 自带 vendored + pin 的专属 pi（与系统 pi 互不相干，见 ADR-0003 修订），数据目录回归**完全自包含**：会话池在 Picode 专属的 pi agent 目录内
- 修订记录（2026-08-07，Q14 账号）：第 5 条"秘密只存引用、不落明文"放宽——账号凭据按 V2/cockpit-tools 模式以 JSON+OAuth 管理（文件 0600；同 Provider 可存多账号、同时只有一个活跃），不强制系统密码库

## 背景

TS-first（ADR-0001）后曾计划"SQLite 单存储"。事实核查发现上游 pi 的
`SessionManager` 持久化为硬编码文件系统调用（private 构造器，无存储注入点；
SessionStorage 抽象只存在于 oh-my-pi fork），单存储需要上游 PR 或维护 Patch。
同时，参照产品（pi、Claude Code、OpenCode）全部采用文件存储，证明该数据
规模下文件方案成熟。

## 决策

1. **文件是权威，索引是可丢弃的缓存。**
2. 会话：pi 原生 JSONL 是唯一会话存储，sessionDir 指向 Picode 数据目录（受管）。
   零同步、零镜像、零 Patch。
3. 产品状态（账号引用、Task/Slice/Capsule、Evidence、能力状态）：独立 JSON/JSONL
   文件，原子写（临时文件 + rename）。Backend 单实例单写者（实例锁）使并发写不成立。
4. 目录/检索：`catalog/` 下的派生索引，增量维护，可全量重建；永不进入权威表。
   未来性能不足时可将索引缓存升级为 SQLite 实现——仅更换缓存载体，不改变权威。
5. 秘密只存引用（系统密码库/密码本路径），不落明文文件。

## 数据目录

```text
~/.picode/           # 完全自包含（Q10 修订后）
  pi/                # vendored + pin 的专属 pi（可带补丁；与系统 pi 无关）
  agent/             # Picode 专属 pi agent dir（PI_CODING_AGENT_DIR 指向此处）
    sessions/        # pi 原生 JSONL（唯一会话权威）
    settings.json    # 扩展套件预装于此，不触碰系统 ~/.pi/
  config.json        # 全局配置（JSON，读取兼容 JSONC）
  accounts.json      # JSON+OAuth 凭据（0600；多账号存储/单活跃）
  imports/<source>/  # 不可变外部快照 + Import Contract 包
  tasks/             # Task/Slice/Capsule
  evidence/          # append-only JSONL
  catalog/           # 可重建索引缓存（非权威，含会话索引）
  artifacts/
  metrics/           # 缓存命中等指标（非权威）

<project>/.picode/   # 项目级配置与 Harness 档位
```

## 后果

- 消灭 SQLite schema 迁移、native 依赖、双写一致性三类工程；会话层与上游 pi 零摩擦。
- 全文检索为扫描级性能，接受；慢则升级索引缓存，架构不变。
- 跨实体引用无外键，靠约定 + 启动校验修复。
- 上下文压缩与抗失真机制不受影响（其存储本就是文件形态）。
