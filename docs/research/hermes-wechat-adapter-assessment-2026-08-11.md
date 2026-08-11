# Hermes Weixin → Picode 适配评估

> 日期：2026-08-11
> 核对基线：NousResearch/hermes-agent `a1bfbccc02d5bfdaef1568facfca2cc1456c59f0`
> 范围：仅设计评估，不包含实现。

## 结论

可以提取，但应提取 **iLink 协议能力和测试语料**，不应把 Hermes Gateway 整体搬进 Picode。

- 目标为“微信私聊 Picode，发送文本/图片并收到最终回复”：**中等难度**。
- 目标为与 Hermes 当前 Weixin 功能大致等价（登录、长轮询、可靠性、媒体、限流、上下文 token）：**中高难度**。
- 目标为控制一个普通个人微信身份、加入普通微信群并接收群 `@`：**Hermes 当前实现也不满足**，不应将它包装成可交付承诺。

Hermes 官方文档明确说明：二维码登录得到的是 iLink bot 身份（例如 `...@im.bot`），普通微信群事件通常不会投递；多数部署中可靠的是给 bot 的私信。[Hermes Weixin 文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/weixin.md)

## Hermes 实际实现

Hermes 的 `gateway/platforms/weixin.py` 是约 2,400 行的 Python Adapter，核心包括：

1. 腾讯 iLink QR 登录，取得 `account_id`、bot token 和 base URL。
2. `getupdates` 长轮询接收入站消息，无需公网 webhook。
3. `sendmessage` 发送文本；每个对话方需要保存并回传最新 `context_token`。
4. typing ticket、消息去重、sync buffer 持久化、失败退避、频率限制熔断。
5. 图片、文件、视频、语音的 CDN 下载/上传和 AES-128-ECB 加解密。
6. 文本分块、Markdown 保留、快速连续消息合并。
7. DM allowlist/pairing 与默认禁用的 group policy。

一手来源：[Weixin Adapter 源码](https://github.com/NousResearch/hermes-agent/blob/main/gateway/platforms/weixin.py)、[Gateway internals](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/gateway-internals.md)、[依赖定义](https://github.com/NousResearch/hermes-agent/blob/main/pyproject.toml)。Hermes 使用 MIT 许可证，允许复制和修改，但复制的重要代码必须保留许可证声明。[Hermes LICENSE](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE)

Hermes 仓库还包含约 40 KB 的 Weixin 单元测试，覆盖协议、typing 和 secret scope。这些测试比直接复制 Gateway 框架更有复用价值：[Weixin tests](https://github.com/NousResearch/hermes-agent/tree/main/tests/gateway)。

## 与 Picode 的正确接缝

Weixin 应是第三层、默认禁用的 Remote Transport Adapter：

```text
Tencent iLink long poll
        ↓
Weixin Transport Adapter
  - QR/token/context-token
  - allowlist/dedupe/rate limit
        ↓
现有 Serve / Control Interface
  - session mapping
  - Writer Lease
  - run / steer / cancel
        ↓
当前 Pi TUI Authority
```

它不能拥有第二套 Agent、Chat、Task、账号或权限权威。入站微信消息必须映射到一个 PC 已授权、已存在的 Chat；出站只发送现有 Control 事件的最终助手文本。Picode 当前已完成的 TUI-bound `TuiControlDriver` 和 Serve/Control seam 显著降低了集成难度。

凭据进入 Picode Account Vault；`context_token`、sync buffer 和消息去重游标进入单独的 Transport State 文件。Adapter 只有用户启用时才启动长轮询，禁用时应为零进程、零连接。

## 不应直接复制的部分

- Hermes `BasePlatformAdapter`、Gateway session routing、cron、工具集和 Agent Loop。
- Python 全套 Gateway Runtime；Picode 是 TypeScript-first，自带第二套 Python 生命周期会制造新的权威和部署负担。
- Hermes 的配置/secret scope 抽象；只保留 iLink 所需字段，接入 Picode Vault。
- 面向十几个消息平台的通用抽象；当前只实现 Weixin Transport Interface。

建议以 Hermes 的协议常量、请求/响应结构、媒体算法和测试 fixture 为证据，用 TypeScript 写一个窄 Adapter。项目原则要求先检查现有依赖能力；如果没有维护良好的 iLink TypeScript 库，再移植这部分代码。

## 交付切片与工作量

| 切片 | 内容 | 单人工作量估计 |
|---|---|---:|
| Spike | QR 登录、长轮询、文本收发，验证当前账号可获得 iLink bot | 2–4 天 |
| P1 | Vault、allowlist、去重、context token、Chat 显式绑定 | 3–5 天 |
| P2 | Control/Writer Lease、取消、失败恢复、限流、状态展示 | 3–6 天 |
| P3 | 图片/文件/语音、AES CDN、大小限制与清理 | 4–8 天 |
| Gate | 协议 mock、断线/重复/过期 token、真实微信长时 smoke | 3–5 天 |

- **可长期试用的文本私聊版：约 7–12 个开发日。**
- **接近 Hermes 完整 Weixin Adapter：约 3–5 周。**
- 普通个人号/普通群桥接不在以上估算内。Hermes 仓库中的相关请求本身也把“本地个人微信桥”与现有 iLink Adapter 区分开：[wechat-bridge feature request](https://github.com/NousResearch/hermes-agent/issues/14421)。

## 主要风险

1. **产品能力误解**：扫码用的是个人微信，但远端身份是 iLink bot，不是任意操纵个人账号。
2. **群聊限制**：普通群邀请和群事件通常不可用。
3. **接口稳定性**：Hermes 实现包含大量 stale session、redirect host、频率限制和恢复逻辑，说明不能只实现 happy path。
4. **账号与条款**：虽然端点属于腾讯域名，公开、稳定的开发者契约仍需在真实账号 Spike 阶段确认；上线前需接受接口变化或账号限制风险。
5. **远程写入安全**：微信消息必须服从 Picode Writer Lease 和 PC 工作区/权限边界，不能直接调用 Pi 或 shell。

## 建议裁决

**适合纳入候选，但先做有界 Spike，不直接承诺完整群聊。**

验收标准应是：用户扫码得到 iLink bot；白名单微信用户可绑定一个现有 Picode Chat；连续完成 100 次文本往返、断线恢复和重复消息测试；所有消息都由当前 TUI Authority 执行；关闭能力后没有长轮询连接。Spike 成功后再决定是否实现媒体。
