#!/usr/bin/env node
/**
 * claude-hud-gateway: 本地极简 Sidecar 透明流式增强网关
 * 
 * 核心功能：
 * 1. 【首包 Token 自动修补】：
 *    拦截 /v1/messages 流式首包 message_start，若上游缺失 input_tokens 或为 0，
 *    在流中即时注入本地估算的 Prompt Tokens，确保 Claude HUD 进度条 100% 激活！
 * 2. 【30s 超时防崩心跳保活】：
 *    当接入 DeepSeek-R1、o1 等深度思考模型时，超过 8 秒未吐字自动下发
 *    event: ping 心跳帧，重置 Claude Code 内部 30s 看门狗，杜绝断流崩溃。
 * 3. 【响应头工业级规范化】：
 *    补齐 Cache-Control: no-cache, no-transform 与 X-Accel-Buffering: no，消除反向代理积攒延迟。
 * 4. 【零依赖与高性能】：
 *    基于 Node.js 原生 HTTP/HTTPS 模块构建，极低 CPU 与内存占用。
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ANSI 颜色
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  magenta: '\x1b[35m',
};

// 运行时统计
const stats = {
  startedAt: new Date().toISOString(),
  requestsTotal: 0,
  activeStreams: 0,
  tokensPatchedTotal: 0,
  heartbeatsSentTotal: 0,
};

// 1. 读取配置文件或环境变量
function loadConfig() {
  const configFiles = [
    path.join(process.cwd(), 'config.json'),
    path.join(__dirname, 'config.json'),
  ];

  let fileConfig = {};
  for (const f of configFiles) {
    if (fs.existsSync(f)) {
      try {
        fileConfig = JSON.parse(fs.readFileSync(f, 'utf-8'));
        break;
      } catch (e) {
        console.warn(`${c.yellow}[WARN] 读取配置文件 ${f} 失败: ${e.message}${c.reset}`);
      }
    }
  }

  // 若未指定目标 URL，尝试从 ~/.claude/settings.json 自动提取当前生效的中转
  let fallbackTargetUrl = '';
  try {
    const claudeDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
    const settingsPath = path.join(claudeDir, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (parsed.env?.ANTHROPIC_BASE_URL) {
        // 防止自循环（如果 settings.json 已经被改为了 127.0.0.1）
        if (!parsed.env.ANTHROPIC_BASE_URL.includes('127.0.0.1') && !parsed.env.ANTHROPIC_BASE_URL.includes('localhost')) {
          fallbackTargetUrl = parsed.env.ANTHROPIC_BASE_URL;
        }
      }
    }
  } catch {}

  const port = Number.parseInt(process.env.PORT || fileConfig.port || '8080', 10);
  const host = process.env.HOST || fileConfig.host || '127.0.0.1';
  const targetBaseUrl = process.env.TARGET_BASE_URL || fileConfig.targetBaseUrl || fallbackTargetUrl || 'https://api.anthropic.com';
  const targetApiKey = process.env.TARGET_API_KEY || fileConfig.targetApiKey || '';
  const heartbeatIntervalMs = Number.parseInt(process.env.HEARTBEAT_INTERVAL_MS || fileConfig.heartbeatIntervalMs || '8000', 10);
  const autoEstimateTokens = process.env.AUTO_ESTIMATE_TOKENS !== 'false' && (fileConfig.autoEstimateTokens !== false);

  return {
    port,
    host,
    targetBaseUrl: targetBaseUrl.replace(/\/+$/, ''),
    targetApiKey,
    heartbeatIntervalMs,
    autoEstimateTokens,
  };
}

const config = loadConfig();

// 2. 启发式 Prompt Token 估算算法（多语言与代码自适应）
export function estimateTokens(payload) {
  if (!payload) return 50;
  let text = '';

  // 统计 system prompt
  if (typeof payload.system === 'string') {
    text += payload.system;
  } else if (Array.isArray(payload.system)) {
    for (const item of payload.system) {
      if (typeof item === 'string') text += item;
      else if (item?.text) text += item.text;
    }
  }

  // 统计 messages 历史
  if (Array.isArray(payload.messages)) {
    for (const msg of payload.messages) {
      if (typeof msg.content === 'string') {
        text += msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block?.text) text += block.text;
          else if (block?.type === 'tool_result' && typeof block.content === 'string') text += block.content;
          else if (block?.type === 'tool_use') text += JSON.stringify(block.input || {});
        }
      }
    }
  }

  // 统计 tools 定义
  if (Array.isArray(payload.tools)) {
    text += JSON.stringify(payload.tools);
  }

  // 字符分词权重：区分 CJK 汉字与西文字符
  let cjkCount = 0;
  let otherCount = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // CJK 统一表意文字区
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0xf900 && code <= 0xfaff)) {
      cjkCount++;
    } else {
      otherCount++;
    }
  }

  // 经验分词系数：中文约 1.5 tokens/字，英文/符号约 0.28 tokens/字 (3.5 字符/Token)
  const estimated = Math.ceil((cjkCount * 1.5) + (otherCount / 3.5));
  return Math.max(12, estimated);
}

// 3. 构建 HTTP 代理服务器
export function createProxyServer(customConfig = {}) {
  const mergedConfig = { ...config, ...customConfig };
  const targetUrlObj = new URL(mergedConfig.targetBaseUrl);
  const isHttps = targetUrlObj.protocol === 'https:';
  const transport = isHttps ? https : http;

  const server = http.createServer((req, res) => {
    stats.requestsTotal++;
    const requestId = stats.requestsTotal;
    const startTime = Date.now();

    // 健康检查与指标端点
    if (req.url === '/health' || req.url === '/_health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        status: 'healthy',
        service: 'claude-hud-gateway',
        version: '1.0.0',
        uptimeSeconds: Math.floor(process.uptime()),
        targetBaseUrl: mergedConfig.targetBaseUrl,
        stats,
      }, null, 2));
      return;
    }

    // 收集客户端请求体
    const bodyChunks = [];
    req.on('data', (chunk) => bodyChunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(bodyChunks);
      let parsedPayload = null;
      let isStreaming = false;

      if (rawBody.length > 0 && req.headers['content-type']?.includes('application/json')) {
        try {
          parsedPayload = JSON.parse(rawBody.toString('utf-8'));
          if (parsedPayload && parsedPayload.stream === true) {
            isStreaming = true;
          }
        } catch {}
      }

      const isMessagesEndpoint = req.url.startsWith('/v1/messages');

      // 计算本轮预估 Token
      const promptTokenEstimate = (isMessagesEndpoint && mergedConfig.autoEstimateTokens)
        ? estimateTokens(parsedPayload)
        : 100;

      // 准备转发请求的目标 URL 与 Headers
      const targetPath = `${targetUrlObj.pathname.replace(/\/+$/, '')}${req.url}`;
      const forwardHeaders = { ...req.headers };

      forwardHeaders.host = targetUrlObj.host;
      if (mergedConfig.targetApiKey) {
        forwardHeaders['x-api-key'] = mergedConfig.targetApiKey;
        forwardHeaders['anthropic-auth-token'] = mergedConfig.targetApiKey;
        forwardHeaders['authorization'] = `Bearer ${mergedConfig.targetApiKey}`;
      }
      delete forwardHeaders['content-length'];
      forwardHeaders['content-length'] = Buffer.byteLength(rawBody);

      // 创建向上游的请求
      const upstreamReq = transport.request(
        {
          protocol: targetUrlObj.protocol,
          hostname: targetUrlObj.hostname,
          port: targetUrlObj.port || (isHttps ? 443 : 80),
          path: targetPath,
          method: req.method,
          headers: forwardHeaders,
        },
        (upstreamRes) => {
          const ttfbMs = Date.now() - startTime;
          const status = upstreamRes.statusCode;
          const isUpstreamSse = (upstreamRes.headers['content-type'] || '').includes('text/event-stream');

          // 【场景 A】：流式请求（stream=true 且上游返回 SSE）
          if (isStreaming && isUpstreamSse) {
            stats.activeStreams++;
            console.log(`${c.blue}[REQ #${requestId}]${c.reset} ${req.method} ${req.url} -> SSE 流开启 (TTFB: ${ttfbMs}ms, 预估 Token: ${promptTokenEstimate})`);

            // 规范化响应头：强制注入禁用缓存与缓冲抑制
            const responseHeaders = {
              ...upstreamRes.headers,
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache, no-transform',
              'Connection': 'keep-alive',
              'X-Accel-Buffering': 'no',
            };
            delete responseHeaders['content-length'];
            delete responseHeaders['transfer-encoding'];

            res.writeHead(status, responseHeaders);

            let lastChunkTime = Date.now();
            let sseBuffer = '';
            let messageStartSeen = false;

            // 【功能 2：30s 看门狗保活心跳定时器】
            const heartbeatTimer = setInterval(() => {
              const idleMs = Date.now() - lastChunkTime;
              if (idleMs >= mergedConfig.heartbeatIntervalMs - 200) {
                res.write('event: ping\ndata: {"type":"ping"}\n\n');
                lastChunkTime = Date.now();
                stats.heartbeatsSentTotal++;
                console.log(`${c.magenta}[HEARTBEAT #${requestId}]${c.reset} 模型长思考中，已下发保活心跳 event: ping (防 30s 崩溃)`);
              }
            }, mergedConfig.heartbeatIntervalMs);

            upstreamRes.on('data', (chunk) => {
              lastChunkTime = Date.now();
              sseBuffer += chunk.toString('utf-8');

              // 分割出完整 SSE 事件块
              let boundary;
              while ((boundary = sseBuffer.indexOf('\n\n')) !== -1) {
                const eventBlock = sseBuffer.slice(0, boundary);
                sseBuffer = sseBuffer.slice(boundary + 2);

                if (!eventBlock.trim()) continue;

                // 检验与修补 SSE 事件
                const transformedBlock = processSseEventBlock(
                  eventBlock,
                  promptTokenEstimate,
                  requestId,
                  () => { messageStartSeen = true; }
                );

                res.write(transformedBlock + '\n\n');
              }
            });

            upstreamRes.on('end', () => {
              clearInterval(heartbeatTimer);
              stats.activeStreams--;

              if (sseBuffer.trim()) {
                const finalBlock = processSseEventBlock(
                  sseBuffer.trim(),
                  promptTokenEstimate,
                  requestId,
                  () => { messageStartSeen = true; }
                );
                res.write(finalBlock + '\n\n');
              }

              res.end();
              const totalMs = Date.now() - startTime;
              console.log(`${c.green}[DONE #${requestId}]${c.reset} 流传输完成 (总耗时: ${totalMs}ms)`);
            });

            upstreamRes.on('error', (err) => {
              clearInterval(heartbeatTimer);
              stats.activeStreams--;
              console.error(`${c.red}[ERR #${requestId}]${c.reset} 上游流中断: ${err.message}`);
              res.end();
            });

            // 客户端如果主动掐断连接，立刻销毁上游请求以节省 Token
            req.on('close', () => {
              clearInterval(heartbeatTimer);
              if (!upstreamRes.complete) {
                upstreamReq.destroy();
                stats.activeStreams = Math.max(0, stats.activeStreams - 1);
              }
            });

            return;
          }

          // 【场景 B】：非流式请求
          const chunks = [];
          upstreamRes.on('data', (c) => chunks.push(c));
          upstreamRes.on('end', () => {
            const resBuffer = Buffer.concat(chunks);
            let finalBuffer = resBuffer;

            // 若是非流式 /v1/messages，同样检查并修补 usage.input_tokens
            if (isMessagesEndpoint && status === 200 && upstreamRes.headers['content-type']?.includes('application/json')) {
              try {
                const json = JSON.parse(resBuffer.toString('utf-8'));
                if (json && json.usage) {
                  if (!json.usage.input_tokens || json.usage.input_tokens <= 0) {
                    json.usage.input_tokens = promptTokenEstimate;
                    stats.tokensPatchedTotal++;
                    finalBuffer = Buffer.from(JSON.stringify(json));
                    console.log(`${c.yellow}[PATCH #${requestId}]${c.reset} 非流式响应缺失 Token，已补齐 input_tokens: ${promptTokenEstimate}`);
                  }
                }
              } catch {}
            }

            const resHeaders = { ...upstreamRes.headers };
            delete resHeaders['transfer-encoding'];
            resHeaders['content-length'] = Buffer.byteLength(finalBuffer);
            res.writeHead(status, resHeaders);
            res.end(finalBuffer);

            const totalMs = Date.now() - startTime;
            console.log(`${c.cyan}[RESP #${requestId}]${c.reset} ${req.method} ${req.url} -> ${status} (耗时: ${totalMs}ms)`);
          });
        }
      );

      upstreamReq.on('error', (err) => {
        console.error(`${c.red}[ERROR #${requestId}]${c.reset} 转发到上游失败: ${err.message}`);
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          error: {
            type: 'gateway_error',
            message: `claude-hud-gateway 无法连接到目标上游 (${mergedConfig.targetBaseUrl}): ${err.message}`,
          },
        }));
      });

      // 写入请求体并发送
      if (rawBody.length > 0) {
        upstreamReq.write(rawBody);
      }
      upstreamReq.end();
    });
  });

  return server;
}

// 【功能 1：首包 / 尾包 SSE 事件检查与 Token 注入器】
function processSseEventBlock(rawBlock, estimatedTokens, requestId, onMessageStart) {
  const lines = rawBlock.split(/\r?\n/);
  let eventName = '';
  let dataStr = '';

  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataStr += (dataStr ? '\n' : '') + line.slice(5).trim();
    }
  }

  let parsedData = null;
  try {
    parsedData = JSON.parse(dataStr);
  } catch {
    return rawBlock; // 非 JSON 格式原样透传
  }

  // 1. 拦截 message_start
  if (eventName === 'message_start' || parsedData?.type === 'message_start') {
    onMessageStart?.();
    const msg = parsedData.message || parsedData;
    msg.usage = msg.usage || {};

    const currentInput = msg.usage.input_tokens;
    if (typeof currentInput !== 'number' || currentInput <= 0) {
      msg.usage.input_tokens = estimatedTokens;
      stats.tokensPatchedTotal++;
      console.log(
        `${c.green}[PATCH #${requestId}]${c.reset} 上游首包缺失 input_tokens，已注入估算值: ${c.bold}${estimatedTokens}${c.reset} (进度条点亮！)`
      );
      return `event: message_start\ndata: ${JSON.stringify(parsedData)}`;
    }
  }

  // 2. 拦截 message_delta (双保救赎)
  if (eventName === 'message_delta' || parsedData?.type === 'message_delta') {
    if (parsedData.usage) {
      const currentInput = parsedData.usage.input_tokens;
      if (typeof currentInput !== 'number' || currentInput <= 0) {
        parsedData.usage.input_tokens = estimatedTokens;
        return `event: message_delta\ndata: ${JSON.stringify(parsedData)}`;
      }
    }
  }

  return rawBlock;
}

// 独立运行时启动监听
if (process.argv[1] && process.argv[1].endsWith('proxy.mjs')) {
  const server = createProxyServer();
  server.listen(config.port, config.host, () => {
    console.log(`
${c.bold}======================================================${c.reset}
${c.green}${c.bold}   Claude HUD Gateway (Sidecar 流式增强网关已启动)   ${c.reset}
${c.bold}======================================================${c.reset}
  * 本地监听地址 : ${c.cyan}http://${config.host}:${config.port}${c.reset}
  * 目标上游 API : ${c.yellow}${config.targetBaseUrl}${c.reset}
  * 首包补丁功能 : ${config.autoEstimateTokens ? `${c.green}已启用 (自动注入 input_tokens)${c.reset}` : '未启用'}
  * 心跳保活周期 : ${c.magenta}每 ${config.heartbeatIntervalMs}ms 下发 event: ping (防 30s 崩溃)${c.reset}
  * 健康检查端点 : ${c.cyan}http://${config.host}:${config.port}/health${c.reset}

${c.bold}在 Claude Code 中一键使用本网关:${c.reset}
  将 ~/.claude/settings.json 中的 ${c.yellow}ANTHROPIC_BASE_URL${c.reset} 改为:
  ${c.green}"ANTHROPIC_BASE_URL": "http://${config.host}:${config.port}"${c.reset}
${c.bold}======================================================${c.reset}
`);
  });

  process.on('SIGINT', () => {
    console.log(`\n${c.yellow}正在关闭 Sidecar 网关...${c.reset}`);
    server.close(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
  });
}
