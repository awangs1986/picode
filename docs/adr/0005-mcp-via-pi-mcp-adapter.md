# ADR-0005: MCP 能力采用 pi-mcp-adapter，确立"生态现货优先"原则

- 状态：Accepted
- 日期：2026-08-07
- 决策人：作者
- 取代：R0 稿 §9.4 中"MCP Adapter 由 Picode 自研"的隐含假设；R0 §18-7 相关
  的"MCP 大上下文自研缓解"路径收窄为配置项

## 背景

pi 无内置 MCP 支持。生态调研发现 pi-mcp-adapter（2.20.1，MIT，月下载
28.5 万）已实现 R0 §9.4 MCP Adapter 章节的全部运行时要求：三种 transport、
per-server 生命周期（lazy/eager/keep-alive）、OS 密码库存储 OAuth 凭据、
`!command` 运行时取秘密、fail-closed；并额外提供两个治理接口：
`MCP_TOOL_APPROVAL_REQUEST_EVENT`（权限仲裁 claim API）与
`MCP_STATUS_EVENT`（版本化状态快照事件总线）。其代理工具模式（单工具
约 200 token + 按需发现）、Output Guard（超限输出落盘）与
`freezeDirectTools`（工具面冻结保前缀缓存）直接服务需求 6 的
"MCP 大上下文"与缓存命中目标。

## 决策

1. **pi-mcp-adapter 是 MCP 能力的唯一供应商**（pin 版本），Picode 不自研
   MCP 运行时。
2. **Guard 经仲裁事件接管权限**：订阅 approval-request 事件，按三档权限
   预设与 Grant 记录裁决 allow/deny，并写入 Evidence；不使用其自带对话框
   作为最终权威。
3. **能力目录订阅状态事件**：Discovered/Enabled/Running 状态以
   `MCP_STATUS_EVENT` 快照为来源；**Trusted 门由目录自持**（装什么、信
   什么），adapter 只管运行时。
4. **配置采用生态标准 `.mcp.json`** 优先级链（共享全局 → Pi 全局覆盖 →
   项目 → Pi 项目覆盖），Picode 不发明第二种 MCP 配置格式；档位预设通过
   写 adapter 的 `approveTools`/`includeTools` 等字段表达。
5. **缓存策略默认值**：默认代理模式；直连工具按需少量开启且开
   `freezeDirectTools`；Output Guard 保持默认开。
6. **生态现货优先原则**（本轮第三次验证：landstrip、pi-mcp-adapter、
   pi-sandbox）：Picode 遇到能力缺口时先查 pi 生态，采用条件 = 许可证
   兼容 + pin 版本 + 有程序化接口可被 Guard/目录收编 + 可替换（窄 seam +
   一致性验收）。供应商登记：沙箱 = pi-landstrip（ADR-0004）、MCP =
   pi-mcp-adapter（本 ADR）。

## 后果

- MCP 运行时、OAuth、transport 兼容、上下文膨胀缓解全部外包；Picode 在
  MCP 上的自研面收窄为：Trusted 门、档位→adapter 配置编译、仲裁回调、
  Evidence 记录。
- 已知限制入台账：跨会话 server 进程不共享（每会话各起各的）；需要共享
  时配 rmcp-mux，P0 不做。
- 供应链依赖加深一个包；对冲同 ADR-0004（pin + 一致性验收 + 事件接口
  窄面）。
- adapter 的 approveTools 会话内批准存内存、headless fail-closed，与
  Guard 语义一致，无需改造。
