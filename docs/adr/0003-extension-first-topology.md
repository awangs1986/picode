# ADR-0003: Extension-first 拓扑——Picode 是 pi 发行版，不是独立 Backend

- 状态：Accepted
- 日期：2026-08-07
- 决策人：作者
- 取代：R2 稿 D1（统一 Backend 是产品本体）、D3（自建 TUI 为首选界面）、D6（Simple 档也走 Backend）、R2 §1/§4 拓扑；修订 ADR-0001 中"自建 TUI 优先复用 pi-tui"与 ADR-0002 第 3 条"Backend 单实例单写者使并发写不成立"的前提
- 修订记录（2026-08-07，Q10 独立 pi）：决策 1 的"不 fork"收窄——pi 以 **vendored + pin** 方式随 Picode 分发（V2 模式：目录里有自己的 pi），与系统安装的 pi 互不相干；源码补丁**允许但仅作最后手段**；启动器不读写系统 `~/.pi/`。代价：上游 pi 更新走自有合并流程（vendor 税），pinned + latest-compatible 双轨 CI 继续强制

## 背景

自建 TUI 的动机只剩两个交互小功能（鼠标、图片内联显示），为此重写整个
TUI 与客户端协议的代价与"最小架构风险"的代价函数冲突。同时 ADR-0001
（TS-first）与 ADR-0002（文件权威）已经消灭了"独立 Backend 进程"存在的
两个理由：跨语言边界与集中式存储权威。保留 pi TUI 意味着用户直接运行
pi，进而"包在 pi 外面的 Backend"失去了立足点。

## 决策

**Picode V3 = pi 发行版：pi + Picode 扩展套件 + 伴生 CLI + 独立导入工具。**

1. `picode` 命令启动预装 Picode 扩展套件的 pi；pi TUI、Agent Loop、JSONL
   持久化保持原版零改动，不 fork。
2. 四个领域模块（Store / Engine / Guard / Devloop）是普通 TS 库，由
   Adapter Extension 在 pi 进程内加载；模块不感知宿主形态。
3. TUI 增强以 pi 扩展 API 能画什么为上限：缓存命中率状态部件进 Spike
   验证；鼠标与图片内联放弃，图片维持外部查看器。
4. CLI 是 P0–P4 唯一公开自动化契约；HTTP+SSE 只作显式启用的内部诊断传输，详见 ADR-0006；
   实例锁只决定"哪个 pi 进程是当前 API 宿主"，不再禁止多实例。
5. 统一 Backend 降格为 P5 的 `picode serve`：无头会话宿主进程，服务手机
   /GUI 远程端；复用同一批模块，P0–P4 不实现。
6. 多进程纪律：允许多个 pi 进程并存，各自持有自己的实时会话；共享产品
   状态（tasks/、catalog/、accounts.json 等）的一切写入必须"文件锁 +
   原子写"，纳入 Guard 可红 Gate。

## 后果

- 消灭自建 TUI、TUI 客户端协议、TUI 断线恢复三块最大工作量；Simple 档
  与原版 pi 的等价性由"就是原版 pi"直接保证。
- 界面能力天花板等于 pi TUI 扩展 API；未来交互增强只能等上游或走 P5
  远程端。
- "三端信息统一"从 P0 架构承诺降格为：本地各端读同一份文件权威（即时
  成立），远程端由 P5 serve 模式承接。
- 上游耦合面加深：从"SDK API 稳定性"扩大为"SDK + 扩展 API + TUI 部件
  API 稳定性"；pinned + latest-compatible 双轨 CI 由建议升级为强制。
- 并发从"单写者假设"变为"多进程文件协调"，锁纪律成为存储层的长期税。
