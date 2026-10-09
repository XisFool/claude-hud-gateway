---
name: claude-hud-doctor
description: Claude Code 终端状态栏 (Claude HUD) 环境诊断、一键自愈与中转 API 流式合规性探针。当用户遇到 Claude HUD 不亮、底部空白、进度条卡 0%、cc-switch 切换后状态栏丢失，或需要检测中转 API 是否支持 Claude HUD 时使用。
---

# Claude HUD 诊断与自愈专家技能 (claude-hud-doctor)

本技能为 AI Agent 提供一套工业级的 Claude HUD 故障诊断、配置自愈与 API 协议探测工作流。

---

## 适用场景与触发词

当用户提出以下任一问题时触发本技能：
- “我的 Claude HUD 不亮了 / 底部什么都不显示 / 终端底部空白”
- “换了一个中转模型后，HUD 进度条一直卡在 0%”
- “用 cc-switch 切换供应商后，状态栏就消失了”
- “在 Windows 上报 `cols=$(stty size...` 语法错误或反斜杠路径错误”
- “帮我测一下这个中转 API 支不支持 Claude HUD / 首包有没有 input_tokens”
- “如何配置一个本地代理解决中转 HUD 无法激活的问题”

---

## 诊断排查心智模型 (Decision Tree)

```text
               用户反馈状态栏异常
                      │
        ┌─────────────┴─────────────┐
        ▼                           ▼
  【现象 A: 底部完全空白】      【现象 B: 出现 HUD 但卡 0%】
        │                           │
  原因: 本地客户端配置丢失      原因: API 首包 input_tokens 缺失
  - settings.json 缺 statusLine  - 中转为 OpenAI 转译格式
  - cc-switch 覆写抹除           - 首包 input_tokens == 0
  - Windows 执行器语法报错      
        │                           │
  解决方案:                     解决方案:
  执行 doctor.mjs --fix         执行 probe_api.mjs 探针确认
                                启动 proxy.mjs 本地 Sidecar 网关
```

---

## 工作流程 (Agent Workflow)

### 步骤 1：执行本地环境深度体检
在项目根目录或脚本所在目录运行：
```bash
node skills/claude-hud-doctor/scripts/doctor.mjs
```
该工具将自动检查：
1. `~/.claude/settings.json` 是否存在，以及 `statusLine` 是否配置正确。
2. Windows 平台下的执行器适配（Git for Windows / PowerShell / CMD）。
3. `statusLine.command` 中是否存在导致 MSYS / Git Bash 转义损坏的反斜杠。
4. `~/.cc-switch/cc-switch.db`（若安装了 cc-switch）：扫描所有 Claude Provider 档案，检查其 `settings_config` 是否包含 `statusLine`，防止切换后被洗白。

### 步骤 2：执行一键自愈修复
若体检报告提示存在故障（如 `statusLine` 丢失、cc-switch 未固化、反斜杠路径不安全）：
向用户说明修复项，并执行：
```bash
node skills/claude-hud-doctor/scripts/doctor.mjs --fix
```
修复工具会自动完成：
- 备份原文件（生成 `.bak` 备份）；
- 自动写入/规范化 `~/.claude/settings.json` 的 `statusLine` 配置（使用全平台通用的正斜杠路径与轻量 `statusline.mjs` 入口）；
- 批量修补 `~/.cc-switch/cc-switch.db` 中所有 Claude Provider 档案和全局默认配置，永久杜绝切换后状态栏被覆写抹除的问题。

### 步骤 3：中转 API 流式探针检测
若客户端配置完好，但进度条依然卡死在 0%，表明问题在上游 API。运行探针工具发送真实测试请求：
```bash
# 自动读取当前 ~/.claude/settings.json 中的 API_BASE 和 AUTH_TOKEN
node skills/claude-hud-doctor/scripts/probe_api.mjs

# 或手动指定中转地址与 Key
node skills/claude-hud-doctor/scripts/probe_api.mjs --base-url "https://api.example.com" --api-key "sk-xxxx" --model "claude-3-7-sonnet"
```
探针将输出：
- HTTP 响应头合规性（`Content-Type`, `Cache-Control`, `X-Accel-Buffering`）；
- 首包 `message_start` 解析结果（是否包含 `usage.input_tokens > 0`）；
- 首字延迟 (TTFT) 与流式完整性；
- 综合判定：`PASS`（原生支持）、`WARN`（可降级恢复）、`FAIL`（完全不兼容）。

### 步骤 4：部署本地 Sidecar 网关
若探针判定 API 为 `FAIL`（首包缺失 Token）或用户使用的是长思考模型（思考超 30s 断流）：
指导用户启动本项目内置的纯 Node.js 极简透明网关：
```bash
cd proxy
npm run start
```
网关将自动完成：
- **首包 Token 补丁**：实时估算 Prompt Tokens 注入首帧，确保进度条 100% 激活；
- **30s 心跳保活**：模型思考超过 8 秒自动下发 `event: ping`，杜绝 Claude Code 断流崩溃；
- **透明直通转发**：零外部依赖，极低内存与 CPU 开销。
