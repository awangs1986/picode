# Picode 微信 iLink 插件

该插件把当前一个已持久化的 Pi 对话连接到腾讯 iLink Bot 私聊。它是第三级能力：
出厂随 Picode 提供，但默认 Disabled，不注册模型工具、不启动进程、不开端口，也不产生网络请求。

## 使用

在 Picode TUI 的目标对话中依次执行：

```text
/weixin enable
/weixin login
/weixin start
```

`/weixin login` 会在终端显示二维码。用微信扫码并确认后，凭据进入 Picode Account Vault；
token 不会显示在状态、日志或模型上下文中。`/weixin start` 只绑定执行命令时的当前对话。
微信消息通过现有 Pi TUI Authority 产生一个正常模型回合，最终文本回复再发回微信。
如果 iLink 实际发送者 ID 与扫码响应中的 ID 不同，第一条消息会在 PC TUI 弹出一次
发送者配对确认；确认后该条消息继续执行，以后不再重复询问。

其他命令：

```text
/weixin status
/weixin stop
/weixin disable
/weixin allow <ilink-user-id>
```

- 切换 Pi 对话或关闭 TUI 会自动停止长轮询。
- `disable` 会先停止传输，再保存 Disabled；之后保持零网络活动。
- 同一传输按顺序处理消息；Pi 正在运行其他回合时不会创建第二个 Runtime。
- 当前版本只支持 iLink Bot 私聊文本。它不是个人微信号自动化，普通微信群也不在支持范围。
- iLink 不支持编辑已发消息，因此 Picode 只发送模型的最终文本，不发送流式中间片段。

## 验证范围

自动测试覆盖能力不可见性、QR 协议、Tencent 主机白名单、长轮询、去重、允许列表、
`context_token`、Vault 引用、单对话绑定、停止和禁用。真实扫码仍需要用户自己的微信做一次手工 Gate。

协议实现参考了 MIT 许可的
[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) 微信 iLink Adapter；
Picode 只移植了文本私聊所需的窄协议面，没有引入 Hermes Gateway 或第二套 Agent Runtime。
