# AGENTS.md — claude-hud-gateway 项目架构与维护指南

> 本文件是专为 AI Coding Agent（如 Claude Code, Antigravity, Cursor 等）编写的架构定义与工作约定。修改代码前请完整阅读。

---

## 1. 项目核心定位与存在意义 (Purpose & Mission)

`claude-hud-gateway` 是专为 **Claude Code CLI**（`@anthropic-ai/claude-code`）与 **Claude HUD**（`claude-hud` 终端状态栏看板）打造的**流式协议增强网关、环境诊断与自愈工具集**。

### 核心解决的四大硬核痛点：
1. **终端底部完全空白**：多模型中转切换工具（如 `cc-switch`）在切换 Provider 时全量覆写 `~/.claude/settings.json`，抹除未配置该字段的厂商档案，导致 HUD 启动命令物理丢失。
2. **Windows Git Bash 反斜杠吞噬报错**：在 Windows 上，Claude Code 检测到 Git for Windows 时默认使用 `/usr/bin/bash` 执行状态栏命令；若配置了 CMD 反斜杠路径（如 `C:\Windows\...`），反斜杠被转义吞噬，报错 `command not found` 导致 HUD 静默崩溃。
3. **HUD 进度条死锁在 0%**：劣质中转粗暴转译 OpenAI 格式，在流式首包 `message_start` 中缺失 `input_tokens` 或值为 0；Claude Code 内部 Token 累加器 `the()` 存在 `input_tokens > 0` 严格守卫，导致整轮对话上下文断流，HUD 进度条永远为 0%。
4. **深度推理模型 30 秒看门狗崩溃**：DeepSeek-R1、o1 等模型深度思考超过 30 秒未输出正文字符时，Claude Code 内置 30 秒看门狗强行掐断流并抛出 `Streaming idle timeout` 闪退。

---

## 2. 仓库架构与模块职责 (Architecture)

```text
claude-hud-gateway/
├── proxy/                         # 核心运行时：极简本地透明 Sidecar 流式代理
│   ├── proxy.mjs                  # 零第三方生产依赖的 Node.js 反向代理服务
│   ├── config.example.json        # 代理服务配置文件示例
│   ├── package.json               # 代理模块元数据
│   └── README.md                  # 代理独立运行与守护进程文档
├── skills/claude-hud-doctor/      # Agent 技能包：供 AI Agent 自主调用的诊断自愈中心
│   ├── SKILL.md                   # 标准 Agent Skill 声明与操作指南
│   └── scripts/
│       ├── doctor.mjs             # 环境扫描、反斜杠检测与安全自愈 CLI 脚本 (--fix)
│       └── probe_api.mjs          # API 流式首包协议检测探针与合规裁决器
├── docs/                          # 核心理论与协议规范资产
│   ├── reverse_analysis.md        # Claude Code 2.1.295 与 HUD 底层逆向终审报告
│   └── sse_specification.md       # Anthropic Messages API SSE 流式协议标准规范
├── test/                          # 自动化集成测试套件
│   └── run_tests.mjs              # 36 项全场景自动化回归测试（Mock 服务 + SQLite 沙箱）
├── README.md                      # 项目中英文文档
├── LICENSE                        # MIT 开源协议
└── package.json                   # 根工作区脚本编排
```

---

## 3. 核心协议与算法契约 (Protocol Contracts)

### 3.1 首包 Token 注入与尾包防污染守卫 (P0-1 核心)
- **首包处理**：拦截 `event: message_start`，若 `usage.input_tokens <= 0` 或不存在，基于请求体内的 Prompt 文本与 Tools 定义计算估算值（`charDivisor: 2.5`，下限 12 Token），注入首包并标记 `patchState.startPatched = true`。
- **尾包防污染规则**：拦截 `event: message_delta` 时，**仅当 `patchState.startPatched === true` 时才允许补齐尾包**！若首包本身合规（带有上游真实的精确 input_tokens），尾包**必须原样透传**，严禁以估算值覆写，防止破坏健康上游的统计精度。

### 3.2 TTFB 承诺与心跳保活机制 (P0-2 核心)
- **TTFB 宽限承诺**：客户端发起流式请求后，启动 `ttfbGraceMs` 计时器（默认 10s）。若上游 10 秒未返回响应头，网关**主动向客户端提前发送 200 OK SSE 响应头并启动心跳**，使看门狗在响应头落地前即被覆盖。
- **8 秒保活心跳与护栏**：静默期间每隔 `heartbeatIntervalMs`（默认 8s）推送 `event: ping\ndata: {"type":"ping"}\n\n`。收到上游数据块时立即重置空闲计时器。`sanitizeHeartbeatIntervalMs` 施加 `[200ms, 25000ms]` 强护栏，上限 25s 预留 5 秒余量，彻底杜绝配置过大反向击穿 30s 看门狗。
- **黑洞超时保护**：上游超过 `upstreamTimeoutMs`（默认 60s）未回包时主动销毁连接，回写 504（非流式）或 `event: error`（已承诺 SSE 流），杜绝挂死。

### 3.3 路径智能去重
- `resolveTargetPath` 必须兼容裸主机、`/v1` 后缀与完整 `/v1/messages` 端点配置，严禁出现 `/v1/v1/messages` 404 故障；同时支持非 messages 端点（如 `/v1/models`）智能互斥解析，并完整保留 Base URL 与请求所携带的 Query 查询参数。

### 3.4 探针安全防护 (P1-5 核心)
- `probe_api.mjs` 遇到 301/302/307/308 重定向时，若目标 `origin` 与原地址不同，**必须强制剥离 `Authorization`、`x-api-key` 与 `anthropic-auth-token`**，严防恶意中转钓鱼窃取凭证。

### 3.5 探针全局总超时熔断 (P2 核心)
- `--timeout`（`timeoutMs`）语义为**全局总超时**：模块级 `probeDeadlineAt` 绝对截止时间必须覆盖 TTFB、全部重定向跳转与整个流式接收生命周期。
- 严禁仅依赖 socket 空闲超时——慢速滴包（间隔小于空闲阈值）可无限绕过；每跳必须挂载硬性计时器到期熔断（错误码 `PROBE_DEADLINE`），所有终态路径清空计时器，重定向前 `res.resume()` 排空响应体，`res` close 不完整时兜底收尾。

### 3.6 doctor CLI 降级链路安全 (P2 核心)
- `doctor.mjs` 的 sqlite3 CLI 链路：读取必须优先 `-json` 精确模式（多行 JSON 不再被管道分隔解析误判损坏），写入必须走 `execFileSync` 免 Shell + SQL stdin 通道，严禁将配置内容拼入 shell 命令串（会被双引号剥离 / `$` 展开破坏）。
- 反斜杠检测必须使用状态机配对扫描（`hasUnescapedBackslash`），支持 Bash 单引号 `'...'` 转义抑制与合法转义字符白名单（`\ `、`\"`），杜绝误报合法语法，严禁 `includes('\\') && !includes('\\\\')` 式启发式（会漏判"既有转义对又有孤立反斜杠"的混合命令）。

---

## 4. 编码规范与工作约定 (Agent Working Agreement)

### 4.1 技术栈与依赖红线
- **纯原生 Node.js (ESM)**：主代码与测试**严禁引入沉重的外部 npm 生产依赖**，一律使用 Node.js 原生模块（`node:http`, `node:https`, `node:sqlite`, `node:string_decoder`, `node:fs`, `node:path`, `node:os`）。
- **Node.js 兼容性基线**：Node.js `>= 18.0.0`。
- **多字节 UTF-8 处理**：流式字节分块解码必须始终使用 `StringDecoder('utf-8')`，严禁直接对 Buffer 切片调用 `toString('utf-8')`。

### 4.2 自愈脚本安全红线 (`doctor.mjs`)
- **备份不可覆盖原则**：首次修复生成 `<file>.bak` 永久原始快照；后续修复必须以 `<file>.bak-YYYYMMDD-HHMMSS` 时间戳增量备份，绝不得覆盖 `.bak`。
- **外科手术式修复**：仅修复诊断出反斜杠/缺失隐患的 Provider 档案，健康已自定义的 `statusLine` 绝不得覆写。
- **解析熔断**：遇到 JSON 语法损坏时立即中止并大字报错，绝不得回退为空对象写入以防清空用户的 API Key。

### 4.3 变更验证红线 (Verification)
- 任何代码改动后，**必须在根目录执行并通过测试**：
  ```bash
  npm test
  # 即 node --no-warnings test/run_tests.mjs
  ```
  **必须确保 36/36 项测试全部通过**，严禁引入回归缺陷。
- Git Commit Message 必须使用中文规范（如 `fix: 修复...`、`feat: 新增...`）。
