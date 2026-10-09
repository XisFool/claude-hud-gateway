# Claude HUD Gateway Sidecar (本地流式增强代理)

> **极简、轻量、高性能的 Node.js 原生透明反向代理**  
> 专为解决中转 API 下 **Claude HUD 进度条卡 0%** 与 **深度思考模型 (DeepSeek-R1 / o1) 30s 超时崩溃** 而生。

---

## 核心特性

1. **首包 Token 实时自动修补 (HUD 100% 激活)**
   - 绝大多数第三方中转（如基于 OpenAI 格式转译的网关）在首包 `message_start` 中缺失 `usage.input_tokens` 或返回 `0`。
   - Claude Code 累加器存在严格的 `input_tokens > 0` 守卫，导致 HUD 进度条永久锁定在 `0%`。
   - 本网关在收到请求时，利用高效算法实时估算 Prompt Tokens，在第一帧 SSE 数据流中无缝注入合规的 `input_tokens`，立即点亮 HUD 进度条！

2. **30 秒超时防崩心跳 (Watchdog Ping)**
   - Claude Code 内置 30 秒空闲超时看门狗（`Jk = 30000ms`）。
   - 接入 DeepSeek-R1、OpenAI o1 等深度思考模型时，模型思考等待往往超过 30 秒，导致客户端直接崩溃报错 `Streaming idle timeout`。
   - 网关在等待上游首字期间，每 8 秒自动向客户端注入原生 `event: ping` 心跳帧，重置看门狗，平稳支撑 1~10 分钟超长推理！
   - 流式请求若上游响应头迟滞（如中转排队），超过 TTFB 宽限期（默认 10s）后网关先承诺 200 SSE 并立即启动心跳，保护窗口覆盖“响应头未落地”阶段；上游 TTFB 整体超时（默认 60s）快速失败，不再无限挂起。

3. **响应头工业级规范化**
   - 强制追加 `Cache-Control: no-cache, no-transform` 与 `X-Accel-Buffering: no`，杜绝 Nginx、Cloudflare 等前端反代造成的 TCP chunk 积攒与延迟卡顿。

4. **零沉重依赖与高并发**
   - 纯 Node.js 原生 HTTP/HTTPS 管道构建，无 Express/Koa 沉重依赖，内存占用仅 ~25MB，吞吐损耗 < 1ms。

---

## 快速上手

### 1. 启动代理服务

在 `proxy` 目录或项目根目录下执行：

```bash
# 方式 A：使用 npm 脚本
npm run proxy

# 方式 B：直接用 node 启动
node proxy/proxy.mjs
```

### 2. 配置目标中转地址

网关支持通过 `config.json` 或环境变量指定目标上游地址。

复制示例配置：
```bash
cp proxy/config.example.json proxy/config.json
```

编辑 `proxy/config.json`：
```json
{
  "port": 8080,
  "host": "127.0.0.1",
  "targetBaseUrl": "https://api.your-relay.com",
  "targetApiKey": "",
  "heartbeatIntervalMs": 8000,
  "autoEstimateTokens": true,
  "upstreamTimeoutMs": 60000,
  "ttfbGraceMs": 10000
}
```

> **注意**：如果 `targetApiKey` 留空，网关会自动透传 Claude Code 客户端传来的当前 API Key，无需重复配置！
>
> **TTFB 保护与心跳参数**：`ttfbGraceMs` 是“上游响应头迟迟不落地”时的提前应答宽限期（默认 10000ms，需小于 Claude Code 的 30s 看门狗）；`heartbeatIntervalMs` 心跳周期（默认 8000ms，内置 200ms~25000ms 强护栏，防止配置过大反向击穿看门狗）；`upstreamTimeoutMs` 是上游 TTFB 总超时（默认 60000ms），超时后非流式请求返回 504 JSON、流式请求下发 SSE error 事件。

也可以直接通过环境变量启动：
```bash
# PowerShell
$env:PORT="8080"
$env:TARGET_BASE_URL="https://api.your-relay.com"
node proxy/proxy.mjs

# Bash / Linux / macOS
PORT=8080 TARGET_BASE_URL="https://api.your-relay.com" node proxy/proxy.mjs
```

### 3. 将 Claude Code 指向本地代理

修改 `~/.claude/settings.json`：
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8080",
    "ANTHROPIC_AUTH_TOKEN": "sk-your-actual-key"
  }
}
```

现在打开 Claude Code，你的 Claude HUD 进度条将 100% 点亮，长思考模型也将拥有丝滑稳定的体验！

---

## 运行为系统后台服务

### 使用 PM2 (推荐，跨平台)
```bash
npm install -g pm2
pm2 start proxy/proxy.mjs --name claude-hud-gateway
pm2 save
pm2 startup
```

### Windows 后台启动 (PowerShell)
```powershell
# 在项目根目录执行（$PWD 即仓库克隆位置，无需手工改绝对路径）
Start-Process node -ArgumentList "$PWD\proxy\proxy.mjs" -WindowStyle Hidden
```

### Linux (Systemd 单元示例)
`/etc/systemd/system/claude-hud-gateway.service`:
```ini
[Unit]
Description=Claude HUD Gateway Sidecar
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/path/to/claude-hud-gateway/proxy
ExecStart=/usr/bin/node proxy.mjs
Restart=always
Environment=PORT=8080
Environment=TARGET_BASE_URL=https://api.your-relay.com

[Install]
WantedBy=multi-user.target
```

---

## 健康检查与统计端点

网关内置实时监控端点：
```bash
curl http://127.0.0.1:8080/health
```

返回示例：
```json
{
  "status": "healthy",
  "service": "claude-hud-gateway",
  "version": "1.0.0",
  "uptimeSeconds": 1420,
  "targetBaseUrl": "https://api.your-relay.com",
  "stats": {
    "requestsTotal": 38,
    "activeStreams": 1,
    "tokensPatchedTotal": 38,
    "heartbeatsSentTotal": 12
  }
}
```
