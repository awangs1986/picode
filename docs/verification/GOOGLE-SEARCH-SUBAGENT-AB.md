# Google Search Subagent A/B 验收协议

## 目的

验证启用 Google Search Subagent 后，真实联网研究质量是否优于默认 pi-web-access。该实验不以“模型说自己搜过”或单次成功作为证据。

## 固定变量

- 同一 Picode Commit、主模型、Thinking、权限、Harness 档位与工作区；
- 同一组任务、同一当地时间窗；A/B 顺序交替，避免一组总是先跑；
- 每个任务每组重复 3 次；
- A 组：`/pico-webagent off`，使用普通 pi-web-access；
- B 组：配置直接 Google 账号与 Gemini 模型后 `/pico-webagent on`；
- B 组发生回退必须单独标注，不能伪装成 Google Grounding 成功。

建议至少覆盖：当天新闻/版本变化、官方文档事实、冷门地区多语言信息、需要多个独立来源交叉核验的问题，以及一个容易被旧资料误导的问题。

## 评分（100）

| 维度 | 分值 | 判据 |
|---|---:|---|
| 事实正确性 | 35 | 与预先保存的权威答案/原始来源一致 |
| 引用支撑 | 25 | 每个关键主张可由所引 URL 直接支撑；不得出现 Metadata 外 URL |
| 时效性 | 15 | 采用任务时间点可获得的最新资料，不混入失效版本 |
| 冷门与多语言覆盖 | 15 | 能发现非英语、低流量但可信的一手资料 |
| 来源多样性 | 10 | 关键结论不依赖单一转载链或同源镜像 |

延迟、Token、真实查询数、成本与回退次数必须记录，但只作诊断，不参与质量分。

## 必须保存的证据

- 脱敏的任务输入、运行时间、Picode Commit、模型/Thinking 与档位；
- A 组 Web 工具轨迹；
- B 组 ResearchPacket、实际 Provider、Grounding 查询、引用 URL、Subagent run id 与 Artifact 摘要；
- 每次评分明细和盲评理由；
- 进程/网络/工具面前后快照，证明 Disabled 为零资源且 `web_search` 已恢复；
- 取消测试：父请求取消后 child 全部终止、无最终 Artifact、无迟到写入。

不得打包 API Key、OAuth Token、浏览器配置或完整 Account Vault。

## 裁决

- 若 B 组在多数任务的三次中位数上提高总分，且事实正确性和引用支撑均不下降，则保留为可选能力；
- 若质量持平，只能以用户偏好保留，继续默认 Disabled；
- 若 B 组更差、引用不可核验、经常回退或产生明显成本失控，则判定 NO-GO，不得改成默认启用；
- 任何 Disabled 网络活动、密钥泄漏、Metadata 外引用或取消后迟到写入均为安全红灯，直接 NO-GO。
