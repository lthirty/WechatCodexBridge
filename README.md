# WeChat Codex Bridge

本项目用于在本机把微信消息路由到多个 Codex 项目线程。

当前版本支持 `文件传输助手` GUI 交互适配器：可以在微信窗口输入 `/ls`、`/list`、`/ent 创意设计及验证`、`/exit` 等命令，由本地桥服务处理并把 `[WCB]` 回复发回文件传输助手。

`/ls` / `/list` 会动态读取 Codex Desktop 当前侧边栏可见的本地项目和线程，不再把 SQLite 历史线程或同一 thread 的旧别名全部列出。开启本地 `config.json` 中 `dryRun=false` 且 `codex.mode=resume` 后，普通消息会通过 `codex exec resume <session_id>` 真实进入对应 Codex session。

## Quick Start

```powershell
cd F:\01.AI\20.WechatCodexBridge
npm run check
.\启动-WechatCodexBridge.cmd
```

启动后会同时启动本地 HTTP 桥服务和 `FileHelper GUI adapter`；适配器只监听和回复微信 `文件传输助手` 窗口。

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:18731/health
```

一键关闭：

```powershell
.\关闭-WechatCodexBridge.cmd
```

模拟微信消息：

```powershell
Invoke-RestMethod http://127.0.0.1:18731/wechat/message -Method Post -ContentType 'application/json' -Body (@{
  sessionId = 'filehelper'
  displayName = '文件传输助手'
  text = '/bind edu-main F:\01.AI\18.EduEntry 019e3449-ef5c-7442-bcce-60798383209a F:\01.AI\18.EduEntry\outputs'
} | ConvertTo-Json)
```

完整说明见 [WechatCodexBridge.md](docs/WechatCodexBridge.md)。
