#!/usr/bin/env node
/**
 * probe_api.mjs: Anthropic Messages API 流式合规性与首包 Token 探针
 * 
 * 功能：
 * 1. 自动从 CLI 参数、环境变量或 ~/.claude/settings.json 读取中转配置。
 * 2. 向 /v1/messages 发送 stream=true 测试请求。
 * 3. 逐帧解析 SSE 数据流，重点验证：
 *    - 首包是否为 event: message_start
 *    - message_start 中是否包含 usage.input_tokens 且 > 0 (Claude HUD 激活核心条件)
 *    - 是否包含 Cache-Control / X-Accel-Buffering 响应头
 *    - 尾包 message_delta 是否存在 output_tokens 及双保 input_tokens
 * 4. 给出 PASS / WARN / FAIL 诊断裁决与优化方案。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

// ANSI 颜色辅助
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

const pass = `${c.green}[PASS]${c.reset}`;
const warn = `${c.yellow}[WARN]${c.reset}`;
const fail = `${c.red}[FAIL]${c.reset}`;
const info = `${c.cyan}[INFO]${c.reset}`;

// 参数解析
const args = process.argv.slice(2);
let baseUrl = null;
let apiKey = null;
let model = null;
let timeoutMs = 30000;
let isJson = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--base-url' || arg === '-b') {
    baseUrl = args[++i];
  } else if (arg === '--api-key' || arg === '-k') {
    apiKey = args[++i];
  } else if (arg === '--model' || arg === '-m') {
    model = args[++i];
  } else if (arg === '--timeout' || arg === '-t') {
    timeoutMs = Number.parseInt(args[++i], 10) || 30000;
  } else if (arg === '--json') {
    isJson = true;
  } else if (arg === '--help' || arg === '-h') {
    console.log(`
${c.bold}Claude HUD API 流式探针 (probe_api)${c.reset}

用法:
  node probe_api.mjs [选项]

选项:
  -b, --base-url <url>    中转 API 基础地址 (例如 https://api.openai.com 或 http://127.0.0.1:8080)
  -k, --api-key <key>     API 密钥 (Auth Token)
  -m, --model <name>      测试模型名称 (默认从配置读取，或 claude-3-7-sonnet)
  -t, --timeout <ms>      请求超时时间 (默认 30000ms)
  --json                  输出机器可读的 JSON 格式
  -h, --help              显示帮助信息

说明:
  若未显式提供 --base-url 与 --api-key，探针将自动读取 ~/.claude/settings.json 中的 env 配置。
`);
    process.exit(0);
  }
}

// 自动探测本地 settings.json
let autoLoadedFromSettings = false;
if (!baseUrl || !apiKey) {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (parsed.env) {
        if (!baseUrl && parsed.env.ANTHROPIC_BASE_URL) {
          baseUrl = parsed.env.ANTHROPIC_BASE_URL;
          autoLoadedFromSettings = true;
        }
        if (!apiKey && (parsed.env.ANTHROPIC_AUTH_TOKEN || parsed.env.ANTHROPIC_API_KEY)) {
          apiKey = parsed.env.ANTHROPIC_AUTH_TOKEN || parsed.env.ANTHROPIC_API_KEY;
          autoLoadedFromSettings = true;
        }
      }
      if (!model && parsed.model) {
        model = parsed.model;
      }
    } catch {}
  }
}

// 环境变量降级
baseUrl = baseUrl || process.env.ANTHROPIC_BASE_URL;
apiKey = apiKey || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
model = model || 'claude-3-7-sonnet';

if (!baseUrl) {
  console.error(`${fail} 错误: 未指定 API 地址。请通过 --base-url 传入，或在 ~/.claude/settings.json 中配置 ANTHROPIC_BASE_URL。`);
  process.exit(1);
}

// 规范化 URL
let targetUrlStr = baseUrl.replace(/\/+$/, '');
if (!targetUrlStr.endsWith('/v1/messages')) {
  targetUrlStr = `${targetUrlStr}/v1/messages`;
}

// 探针结果记录
const probeReport = {
  targetUrl: targetUrlStr,
  model,
  autoLoadedFromSettings,
  timestamp: new Date().toISOString(),
  http: {
    status: null,
    statusText: null,
    headers: {},
    ttfbMs: null,
    totalDurationMs: null,
  },
  sse: {
    isStream: false,
    eventCount: 0,
    events: [],
    firstEvent: null,
    firstEventName: null,
    hasMessageStart: false,
    messageStartUsage: null,
    inputTokens: null,
    outputTokens: null,
    cacheCreationTokens: null,
    cacheReadTokens: null,
    hasHeartbeatPing: false,
    hasMessageDelta: false,
    messageDeltaUsage: null,
  },
  verdict: 'FAIL',
  verdictReason: '',
  recommendations: [],
};

// 发送探针请求
async function runProbe() {
  const urlObj = new URL(targetUrlStr);
  const isHttps = urlObj.protocol === 'https:';
  const transport = isHttps ? https : http;

  const payload = JSON.stringify({
    model,
    max_tokens: 16,
    messages: [
      { role: 'user', content: 'Say hello in 2 words.' },
    ],
    stream: true,
  });

  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'User-Agent': 'claude-hud-gateway-probe/1.0.0',
    'Content-Length': Buffer.byteLength(payload),
  };

  if (apiKey) {
    headers['x-api-key'] = apiKey;
    headers['anthropic-auth-token'] = apiKey;
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const startTime = Date.now();

  return new Promise((resolve) => {
    const req = transport.request(
      urlObj,
      {
        method: 'POST',
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        probeReport.http.ttfbMs = Date.now() - startTime;
        probeReport.http.status = res.statusCode;
        probeReport.http.statusText = res.statusMessage;
        probeReport.http.headers = res.headers;

        const contentType = res.headers['content-type'] || '';
        probeReport.sse.isStream = contentType.includes('text/event-stream');

        let rawBuffer = '';

        res.on('data', (chunk) => {
          rawBuffer += chunk.toString('utf-8');

          // 按连续双换行解析 SSE 事件
          let boundaryIndex;
          while ((boundaryIndex = rawBuffer.indexOf('\n\n')) !== -1) {
            const rawEvent = rawBuffer.slice(0, boundaryIndex).trim();
            rawBuffer = rawBuffer.slice(boundaryIndex + 2);

            if (!rawEvent) continue;
            processSseEvent(rawEvent);
          }
        });

        res.on('end', () => {
          if (rawBuffer.trim()) {
            processSseEvent(rawBuffer.trim());
          }
          probeReport.http.totalDurationMs = Date.now() - startTime;
          finalizeVerdict();
          resolve();
        });

        res.on('error', (err) => {
          probeReport.verdict = 'FAIL';
          probeReport.verdictReason = `流式传输中断: ${err.message}`;
          resolve();
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      probeReport.verdict = 'FAIL';
      probeReport.verdictReason = `请求超时 (超过 ${timeoutMs}ms 未完成)`;
      probeReport.recommendations.push('上游服务响应过慢或卡顿，若使用推理思考模型，可能触发了 30s 崩溃机制。');
      resolve();
    });

    req.on('error', (err) => {
      probeReport.verdict = 'FAIL';
      probeReport.verdictReason = `网络请求失败: ${err.message}`;
      probeReport.recommendations.push('请检查目标 BASE_URL 是否可通，或网络防火墙设置。');
      resolve();
    });

    req.write(payload);
    req.end();
  });
}

function processSseEvent(rawBlock) {
  probeReport.sse.eventCount++;
  const lines = rawBlock.split(/\r?\n/);
  let eventName = 'message';
  let dataStr = '';

  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataStr += (dataStr ? '\n' : '') + line.slice(5).trim();
    }
  }

  if (probeReport.sse.firstEvent === null) {
    probeReport.sse.firstEvent = rawBlock;
    probeReport.sse.firstEventName = eventName;
  }

  let parsedData = null;
  try {
    parsedData = JSON.parse(dataStr);
  } catch {}

  const eventRecord = { event: eventName, data: parsedData };
  if (probeReport.sse.events.length < 10) {
    probeReport.sse.events.push(eventRecord);
  }

  if (eventName === 'ping') {
    probeReport.sse.hasHeartbeatPing = true;
  }

  if (eventName === 'message_start' || parsedData?.type === 'message_start') {
    probeReport.sse.hasMessageStart = true;
    const msg = parsedData?.message || parsedData;
    const usage = msg?.usage;
    if (usage) {
      probeReport.sse.messageStartUsage = usage;
      if (typeof usage.input_tokens === 'number') {
        probeReport.sse.inputTokens = usage.input_tokens;
      }
      if (typeof usage.cache_creation_input_tokens === 'number') {
        probeReport.sse.cacheCreationTokens = usage.cache_creation_input_tokens;
      }
      if (typeof usage.cache_read_input_tokens === 'number') {
        probeReport.sse.cacheReadTokens = usage.cache_read_input_tokens;
      }
    }
  }

  if (eventName === 'message_delta' || parsedData?.type === 'message_delta') {
    probeReport.sse.hasMessageDelta = true;
    const usage = parsedData?.usage;
    if (usage) {
      probeReport.sse.messageDeltaUsage = usage;
      if (typeof usage.output_tokens === 'number') {
        probeReport.sse.outputTokens = usage.output_tokens;
      }
      if (typeof usage.input_tokens === 'number' && probeReport.sse.inputTokens === null) {
        probeReport.sse.inputTokens = usage.input_tokens;
      }
    }
  }
}

function finalizeVerdict() {
  const status = probeReport.http.status;

  if (status !== 200) {
    probeReport.verdict = 'FAIL';
    probeReport.verdictReason = `HTTP 响应状态码异常: ${status} ${probeReport.http.statusText || ''}`;
    probeReport.recommendations.push('请检查 API_KEY 是否有效、中转是否欠费或模型名称是否正确。');
    return;
  }

  if (!probeReport.sse.isStream) {
    probeReport.verdict = 'FAIL';
    probeReport.verdictReason = `返回内容不是标准流式 text/event-stream (Content-Type: ${probeReport.http.headers['content-type']})`;
    probeReport.recommendations.push('该端点未以 SSE 流式格式返回，可能是返回了普通 JSON 错误。');
    return;
  }

  const inputTokens = probeReport.sse.inputTokens;

  // 完美合规：首包含 input_tokens > 0
  if (probeReport.sse.hasMessageStart && inputTokens !== null && inputTokens > 0) {
    probeReport.verdict = 'PASS';
    probeReport.verdictReason = `首包 message_start 包含合规的 usage.input_tokens = ${inputTokens}，Claude HUD 能够 100% 正常激活！`;
    return;
  }

  // 双保救赎：首包没有，但尾包提供了 input_tokens > 0
  if (probeReport.sse.messageDeltaUsage?.input_tokens > 0) {
    probeReport.verdict = 'WARN';
    probeReport.verdictReason = `首包缺失 input_tokens，但尾包 message_delta 提供了真实 input_tokens (${probeReport.sse.messageDeltaUsage.input_tokens})。Claude HUD 会在流结束时自愈，但首包可能短暂显示 0%。`;
    probeReport.recommendations.push('推荐使用本项目内置的 Sidecar 网关 (proxy.mjs) 自动为首包打补丁，消除 0% 迟滞感。');
    return;
  }

  // 完全无法激活：首包与尾包均为 0 或缺失
  probeReport.verdict = 'FAIL';
  probeReport.verdictReason = `首包 message_start 中缺失 input_tokens 字段或值为 0 (实际: ${inputTokens ?? 'null'})，导致 Claude Code 累加器 the() 拒绝更新，HUD 进度条将永久锁定在 0%！`;
  probeReport.recommendations.push('根本原因：该中转底层使用 OpenAI 格式粗暴转译，首包未计算 Prompt Tokens。');
  probeReport.recommendations.push('解决方案：启动本地 claude-hud-gateway Sidecar 网关 (npm run proxy)，它将透明补齐首包 Token 并下发保活心跳。');
}

// 主入口
async function main() {
  if (!isJson) {
    console.log(`\n${c.bold}======================================================${c.reset}`);
    console.log(`${c.bold}       Claude HUD API 流式探针 (API Probe)            ${c.reset}`);
    console.log(`${c.bold}======================================================${c.reset}\n`);

    console.log(`${c.bold}探测目标:${c.reset} ${targetUrlStr}`);
    console.log(`${c.bold}测试模型:${c.reset} ${model}`);
    if (autoLoadedFromSettings) {
      console.log(`${info} 配置来源: 自动自 ~/.claude/settings.json 载入\n`);
    } else {
      console.log(`${info} 配置来源: 命令行/环境变量\n`);
    }

    process.stdout.write(`正在向 API 发送测试流请求... `);
  }

  await runProbe();

  if (isJson) {
    console.log(JSON.stringify(probeReport, null, 2));
    return;
  }

  console.log(`完成！(耗时: ${probeReport.http.ttfbMs}ms 首字 / ${probeReport.http.totalDurationMs}ms 全程)\n`);

  // 1. HTTP 传输层
  console.log(`${c.bold}1. HTTP 传输与响应头${c.reset}`);
  console.log(`   状态码    : ${probeReport.http.status === 200 ? pass : fail} ${probeReport.http.status} ${probeReport.http.statusText || ''}`);
  console.log(`   流式类型  : ${probeReport.sse.isStream ? pass : fail} Content-Type: ${probeReport.http.headers['content-type'] || '无'}`);

  const accel = probeReport.http.headers['x-accel-buffering'];
  if (accel === 'no') {
    console.log(`   缓冲抑制  : ${pass} X-Accel-Buffering: no (流响应无代理延迟)`);
  } else {
    console.log(`   缓冲抑制  : ${warn} X-Accel-Buffering 未设置 (若前端存在 Nginx 可能产生积攒卡顿)`);
  }

  // 2. 首包 SSE 检测
  console.log(`\n${c.bold}2. SSE 首包检测 (关键门禁)${c.reset}`);
  console.log(`   首事件名称: ${probeReport.sse.firstEventName === 'message_start' ? pass : warn} ${probeReport.sse.firstEventName || '无'}`);
  
  const inTokens = probeReport.sse.inputTokens;
  if (inTokens !== null && inTokens > 0) {
    console.log(`   首包 Token: ${pass} usage.input_tokens = ${inTokens} (> 0，合规！)`);
  } else if (inTokens === 0) {
    console.log(`   首包 Token: ${fail} usage.input_tokens = 0 (触发 the() 守卫拦截，导致进度条卡 0%)`);
  } else {
    console.log(`   首包 Token: ${fail} 缺失 usage.input_tokens (导致进度条卡 0%)`);
  }

  // 3. 尾包检测
  console.log(`\n${c.bold}3. SSE 尾包与结算检测${c.reset}`);
  if (probeReport.sse.hasMessageDelta) {
    console.log(`   尾包到达  : ${pass} message_delta 正常`);
    console.log(`   输出 Token: ${info} output_tokens = ${probeReport.sse.outputTokens ?? '未提供'}`);
    if (probeReport.sse.messageDeltaUsage?.input_tokens > 0) {
      console.log(`   尾包双保  : ${pass} message_delta 补录了 input_tokens = ${probeReport.sse.messageDeltaUsage.input_tokens}`);
    }
  } else {
    console.log(`   尾包到达  : ${warn} 未检测到 message_delta 事件`);
  }

  // 4. 最终裁决
  console.log(`\n${c.bold}======================================================${c.reset}`);
  if (probeReport.verdict === 'PASS') {
    console.log(`${c.green}${c.bold}探针裁决: [PASS 完美支持]${c.reset}`);
    console.log(`原因: ${probeReport.verdictReason}`);
  } else if (probeReport.verdict === 'WARN') {
    console.log(`${c.yellow}${c.bold}探针裁决: [WARN 延迟自愈]${c.reset}`);
    console.log(`原因: ${probeReport.verdictReason}`);
  } else {
    console.log(`${c.red}${c.bold}探针裁决: [FAIL 不兼容 / 进度条将失效]${c.reset}`);
    console.log(`原因: ${probeReport.verdictReason}`);
  }

  if (probeReport.recommendations.length > 0) {
    console.log(`\n${c.bold}行动建议:${c.reset}`);
    for (const rec of probeReport.recommendations) {
      console.log(`  ${c.cyan}→${c.reset} ${rec}`);
    }
  }
  console.log(`======================================================\n`);
}

main().catch((err) => {
  console.error(`${fail} probe 异常:`, err);
  process.exit(1);
});
