# ADR-0008: Google Search Subagent 作为第三级可选能力

- 状态：Accepted
- 日期：2026-08-19

## 背景

pi-web-access 是轻量、通用的 Web 搜索/抓取入口，但商业模型的原生 Grounding 在时效性、冷门多语言查询和引用元数据上可能更强。仅把 Gemini 模型交给普通 Subagent 并不会自动获得 Google Search：搜索能力属于 Provider 工具链，不只属于模型权重。

Picode 需要增强联网研究，但不能因此给 Simple 常驻新的肥 Schema、第二套 Agent Runtime、第二份账号库或不可审计的浏览器登录路径。

## 决策

1. 新增 `google-search-subagent`，作为默认 Disabled 的第三级 Capability，不进入首次启动引导。
2. 只支持 Account Vault 中直接 Google API 账号与 `google/<Gemini model>`；不支持浏览器 Cookie、OAuth 绕行或独立密钥文件。
3. 固定版本 pi-web-access 提供 Gemini API-only Grounding seam；失败时单个查询最多回退一次普通 pi-web-access，记录实际 Provider 与原因，禁止递归。
4. 主 Agent 生成 1–10 个 ResearchBrief；同一计划规范化去重，默认并发 3、最大 10。
5. 每个分支先取得 Provider Grounding Metadata，再由 pi-subagents 启动 fresh、零工具的 researcher 综合。搜索和 researcher 使用同一用户所选 Gemini 模型与 Thinking。
6. researcher 的引用只能来自 Provider Grounding Metadata。完整 ResearchPacket 原子写入 Artifact，主会话只接收有界紧凑视图。
7. 启用期间只替代 `web_search`，保留 fetch 工具。父任务取消传播到所有 child；取消后不写最终 Artifact，不自动恢复。
8. 设置、信任、运行和权限保持正交。Disabled 时模型不可见、零进程、零端口、零网络、零密钥读取。
9. `/pico-webagent doctor` 不联网、不付费；`test` 明确执行一次付费真实查询。

## 后果

- Picode 能利用 Gemini 原生 Google Grounding，而不用复制 Google 客户端或 Subagent Runtime。
- 该能力不会增加默认上下文和后台资源；代价是首次启用必须有直接 Google API 账号，并明确选择模型。
- 搜索质量是否优于 pi-web-access 不预设结论，必须通过固定 A/B 协议实测；若不能稳定改善质量，保持默认 Disabled。
- 升级 pi-web-access 时必须重新审计兼容 seam，版本不匹配安装应 fail-closed。
