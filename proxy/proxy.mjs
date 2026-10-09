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
 *    流式请求若上游响应头迟滞超过 TTFB 宽限期，网关先承诺 200 SSE 并立即启动心跳，
 *    让保护窗口覆盖“响应头未落地”阶段；上游 TTFB 超时可配置，黑洞上游不再永久挂死。
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
import { StringDecoder } from 'node:string_decoder';

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

// 心跳周期护栏：非法值（NaN/负数/过小/过大）回退默认 8000ms，防止高频空转或击穿 Claude Code 30s 看门狗
export function sanitizeHeartbeatIntervalMs(value, fallback = 8000) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 200 && parsed <= 25000 ? parsed : fallback;
}

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
  const heartbeatIntervalMs = sanitizeHeartbeatIntervalMs(process.env.HEARTBEAT_INTERVAL_MS || fileConfig.heartbeatIntervalMs || '8000');
  const autoEstimateTokens = process.env.AUTO_ESTIMATE_TOKENS !== 'false' && (fileConfig.autoEstimateTokens !== false);
  const tokenEstimateRatio = Number.parseFloat(process.env.TOKEN_ESTIMATE_RATIO || fileConfig.tokenEstimateRatio || '2.5');
  const upstreamTimeoutMs = Number.parseInt(process.env.UPSTREAM_TIMEOUT_MS || fileConfig.upstreamTimeoutMs || '60000', 10);
  const ttfbGraceMs = Number.parseInt(process.env.TTFB_GRACE_MS || fileConfig.ttfbGraceMs || '10000', 10);

  return {
    port,
    host,
    targetBaseUrl: targetBaseUrl.replace(/\/+$/, ''),
    targetApiKey,
    heartbeatIntervalMs,
    autoEstimateTokens,
    tokenEstimateRatio: Number.isNaN(tokenEstimateRatio) ? 2.5 : tokenEstimateRatio,
    upstreamTimeoutMs: Number.isNaN(upstreamTimeoutMs) ? 60000 : upstreamTimeoutMs,
    ttfbGraceMs: Number.isNaN(ttfbGraceMs) ? 10000 : ttfbGraceMs,
  };
}

const config = loadConfig();

// 2. 启发式 Prompt Token 估算算法（多语言与代码自适应）
export function estimateTokens(payload, ratio = 2.5) {
  if (!payload) return 50;
  let text = '';
  // 多模态附件（图片/文档）无法按字符折算，按 Anthropic 官方经验值每附件计 1600 Token
  let extraTokens = 0;

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
          if (block?.text) {
            text += block.text;
          } else if (block?.type === 'tool_result') {
            if (typeof block.content === 'string') {
              text += block.content;
            } else if (Array.isArray(block.content)) {
              for (const sub of block.content) {
                if (sub?.text) text += sub.text;
                else if (typeof sub === 'string') text += sub;
                else if (sub?.type === 'image' || sub?.type === 'document') extraTokens += 1600;
              }
            } else if (block.content) {
              text += JSON.stringify(block.content);
            }
          } else if (block?.type === 'tool_use') {
            text += JSON.stringify(block.input || {});
          } else if (block?.type === 'image' || block?.type === 'document') {
            extraTokens += 1600;
          }
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

  // 经验分词系数：依据 ratio 参数做自适应调整
  const charDivisor = Math.max(1, ratio);
  const estimated = Math.ceil((cjkCount * 1.5) + (otherCount / charDivisor));
  return Math.max(12, estimated + extraTokens);
}

function appendQueryParams(pathname, targetUrlObj, reqObj) {
  const targetParams = targetUrlObj.searchParams;
  const reqParams = reqObj.searchParams;

  if ((!targetParams || targetParams.size === 0) && (!reqParams || reqParams.size === 0)) {
    return pathname;
  }

  const mergedParams = new URLSearchParams(targetParams);
  for (const [key, val] of reqParams.entries()) {
    mergedParams.set(key, val);
  }
  const queryStr = mergedParams.toString();
  return queryStr ? `${pathname}?${queryStr}` : pathname;
}

// 目标路径智能规范化（兼容裸主机、/v1 后缀与完整 /v1/messages 端点，规避 /v1/v1/messages 404 故障）
export function resolveTargetPath(targetUrlObj, reqUrl) {
  const normBase = targetUrlObj.pathname.replace(/\/+/g, '/').replace(/\/+$/, '');
  const reqObj = new URL(reqUrl, 'http://127.0.0.1');
  let reqPath = reqObj.pathname.replace(/\/+/g, '/');

  if (normBase.endsWith('/v1/messages')) {
    if (reqPath === '/v1/messages' || reqPath === '/messages') {
      reqPath = '';
    } else if (reqPath.startsWith('/v1/')) {
      // 客户端请求非 messages 端点（如 /v1/models），剥离 Base URL 中的 /messages 后缀
      const basePrefix = normBase.slice(0, -'/messages'.length);
      const merged = (basePrefix + reqPath.slice(3)).replace(/\/+/g, '/');
      return appendQueryParams(merged || '/', targetUrlObj, reqObj);
    }
  } else if (normBase.endsWith('/v1')) {
    if (reqPath === '/v1') {
      reqPath = '';
    } else if (reqPath.startsWith('/v1/') || reqPath.startsWith('/v1?')) {
      reqPath = reqPath.slice(3);
    }
  }

  const mergedPath = ((normBase + reqPath).replace(/\/+/g, '/')) || '/';
  return appendQueryParams(mergedPath, targetUrlObj, reqObj);
}

// SSE 事件块边界查找器（全面兼容 \r\n\r\n 与 \n\n 两种标准终止符）
export function findSseBoundary(buffer) {
  const crlf = buffer.indexOf('\r\n\r\n');
  const lf = buffer.indexOf('\n\n');
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return { index: crlf, length: 4 };
  }
  if (lf !== -1) {
    return { index: lf, length: 2 };
  }
  return null;
}

// 3. 构建 HTTP 代理服务器
export function createProxyServer(customConfig = {}) {
  const mergedConfig = {
    ...config,
    ...customConfig,
    heartbeatIntervalMs: sanitizeHeartbeatIntervalMs(
      customConfig.heartbeatIntervalMs ?? config.heartbeatIntervalMs
    ),
  };
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
    // P1-1: 客户端中途掐断上传等入站错误就地消化，防止升级为进程级未捕获异常
    req.on('error', (err) => {
      console.warn(`${c.yellow}[WARN #${requestId}]${c.reset} 客户端请求流异常: ${err.message}`);
    });
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
        ? estimateTokens(parsedPayload, mergedConfig.tokenEstimateRatio)
        : 100;

      // 准备转发请求的目标 URL 与 Headers
      const targetPath = resolveTargetPath(targetUrlObj, req.url);
      const forwardHeaders = { ...req.headers };

      forwardHeaders.host = targetUrlObj.host;
      if (mergedConfig.targetApiKey) {
        forwardHeaders['x-api-key'] = mergedConfig.targetApiKey;
        forwardHeaders['anthropic-auth-token'] = mergedConfig.targetApiKey;
        forwardHeaders['authorization'] = `Bearer ${mergedConfig.targetApiKey}`;
      }

      // 禁用上游 gzip/br 压缩以确保代理能稳定透明解析 SSE 文本与 JSON
      delete forwardHeaders['accept-encoding'];
      forwardHeaders['accept-encoding'] = 'identity';

      delete forwardHeaders['content-length'];
      if (rawBody.length > 0) {
        forwardHeaders['content-length'] = Buffer.byteLength(rawBody);
      }

      let clientClosed = false;
      let streamClosed = false;
      let streamCounted = false;
      let headersCommitted = false;
      let upstreamResponded = false;
      let streamFailed = false;
      let heartbeatTimer = null;
      let graceTimer = null;
      let lastChunkTime = Date.now();
      let sseBuffer = '';
      const patchState = { startPatched: false };

      const checkInterval = Math.min(1000, Math.max(200, Math.floor(mergedConfig.heartbeatIntervalMs / 2)));

      // 流级清理（幂等）：停止心跳/宽限计时器，并归还活跃流计数
      const cleanupStream = () => {
        if (streamClosed) return;
        streamClosed = true;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        if (graceTimer) {
          clearTimeout(graceTimer);
          graceTimer = null;
        }
        if (streamCounted) {
          stats.activeStreams = Math.max(0, stats.activeStreams - 1);
          streamCounted = false;
        }
      };

      // 【功能 2：30s 看门狗保活心跳定时器】
      // 自 SSE 响应承诺一刻启动，同时覆盖“上游响应头迟滞”与“长思考静默”两个无字节窗口
      const startHeartbeat = () => {
        lastChunkTime = Date.now();
        heartbeatTimer = setInterval(() => {
          if (clientClosed || res.writableEnded) {
            cleanupStream();
            return;
          }
          const idleMs = Date.now() - lastChunkTime;
          if (idleMs >= mergedConfig.heartbeatIntervalMs) {
            res.write('event: ping\ndata: {"type":"ping"}\n\n');
            lastChunkTime = Date.now();
            stats.heartbeatsSentTotal++;
            console.log(`${c.magenta}[HEARTBEAT #${requestId}]${c.reset} 长静默期，已下发保活心跳 event: ping (防 30s 崩溃)`);
          }
        }, checkInterval);
      };

      // 向客户端承诺 SSE 响应头（合并上游头或使用标准头），并立即启动心跳
      const commitSseResponse = (status, upstreamHeaders = {}) => {
        headersCommitted = true;
        if (!streamCounted) {
          streamCounted = true;
          stats.activeStreams++;
        }
        const responseHeaders = {
          ...upstreamHeaders,
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        };
        delete responseHeaders['content-length'];
        delete responseHeaders['transfer-encoding'];
        res.writeHead(status, responseHeaders);
        startHeartbeat();
      };

      // 统一的流终局错误路径（幂等）：已承诺 SSE 则回写 SSE error 事件；未承诺则按 502/504 JSON 收尾
      const failStreamGracefully = (err) => {
        if (streamFailed) return;
        streamFailed = true;
        if (clientClosed) {
          cleanupStream();
          return;
        }
        console.error(`${c.red}[ERR #${requestId}]${c.reset} 上游流异常: ${err.message}`);
        if (headersCommitted && !res.writableEnded) {
          res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'gateway_error', message: `claude-hud-gateway 上游流中断: ${err.message}` } })}\n\n`);
          res.end();
        } else if (!res.headersSent) {
          const statusCode = err.code === 'GATEWAY_TTFB_TIMEOUT' ? 504 : 502;
          res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            error: {
              type: 'gateway_error',
              message: `claude-hud-gateway 无法连接到目标上游 (${mergedConfig.targetBaseUrl}) 或上游中断: ${err.message}`,
            },
          }));
        } else if (!res.writableEnded) {
          res.destroy();
        }
        cleanupStream();
      };

      // P0-2: 流式请求 TTFB 保护 —— 上游迟迟不返回响应头时，先向客户端承诺 200 SSE 并启动心跳，
      // 让 Claude Code 的 30s 看门狗在“响应头未落地”阶段也被心跳覆盖
      if (isStreaming) {
        graceTimer = setTimeout(() => {
          graceTimer = null;
          if (upstreamResponded || headersCommitted || clientClosed || res.writableEnded) return;
          console.log(`${c.yellow}[TTFB #${requestId}]${c.reset} 上游 ${mergedConfig.ttfbGraceMs}ms 未返回响应头，提前承诺 200 SSE 并启用心跳保护`);
          commitSseResponse(200);
        }, mergedConfig.ttfbGraceMs);
      }

      // 创建向上游的请求
      const upstreamReq = transport.request(
        {
          protocol: targetUrlObj.protocol,
          hostname: targetUrlObj.hostname,
          port: targetUrlObj.port || (isHttps ? 443 : 80),
          path: targetPath,
          method: req.method,
          headers: forwardHeaders,
          timeout: mergedConfig.upstreamTimeoutMs,
        },
        (upstreamRes) => {
          upstreamResponded = true;
          if (graceTimer) {
            clearTimeout(graceTimer);
            graceTimer = null;
          }
          const ttfbMs = Date.now() - startTime;
          const status = upstreamRes.statusCode;
          const isUpstreamSse = (upstreamRes.headers['content-type'] || '').includes('text/event-stream');

          // 【场景 A】：流式请求（stream=true 且上游返回成功 SSE）
          if (isStreaming && isUpstreamSse && status === 200) {
            if (!headersCommitted) {
              console.log(`${c.blue}[REQ #${requestId}]${c.reset} ${req.method} ${req.url} -> SSE 流开启 (TTFB: ${ttfbMs}ms, 预估 Token: ${promptTokenEstimate})`);
              commitSseResponse(status, upstreamRes.headers);
            } else {
              console.log(`${c.blue}[REQ #${requestId}]${c.reset} 上游响应头延迟到达 (TTFB: ${ttfbMs}ms)，继续透传 SSE 流`);
            }

            const decoder = new StringDecoder('utf-8');

            upstreamRes.on('data', (chunk) => {
              lastChunkTime = Date.now();
              sseBuffer += decoder.write(chunk);

              // 分割出完整 SSE 事件块（支持 \r\n\r\n 与 \n\n 边界）
              let boundary;
              while ((boundary = findSseBoundary(sseBuffer)) !== null) {
                const eventBlock = sseBuffer.slice(0, boundary.index);
                sseBuffer = sseBuffer.slice(boundary.index + boundary.length);

                if (!eventBlock.trim()) continue;

                // 检验与修补 SSE 事件
                const transformedBlock = processSseEventBlock(eventBlock, promptTokenEstimate, requestId, patchState);
                res.write(transformedBlock + '\n\n');
              }
            });

            upstreamRes.on('end', () => {
              cleanupStream();
              sseBuffer += decoder.end();

              if (sseBuffer.trim()) {
                const finalBlock = processSseEventBlock(sseBuffer.trim(), promptTokenEstimate, requestId, patchState);
                res.write(finalBlock + '\n\n');
              }

              if (!res.writableEnded) {
                res.end();
              }
              const totalMs = Date.now() - startTime;
              console.log(`${c.green}[DONE #${requestId}]${c.reset} 流传输完成 (总耗时: ${totalMs}ms)`);
            });

            // P1-1: 上游流错误就地消化；部分运行时 FIN 提前断开不会触发 'error'，再以 close + complete 兜底
            upstreamRes.on('error', (err) => {
              failStreamGracefully(err);
            });
            upstreamRes.on('close', () => {
              if (!upstreamRes.complete) {
                failStreamGracefully(new Error('上游连接在 SSE 流完成前断开 (premature close)'));
              }
            });

            return;
          }

          // 【场景 B】：非流式请求 或 错误响应
          const chunks = [];
          upstreamRes.on('data', (c) => chunks.push(c));

          // P1-1: 上游响应流错误（ECONNRESET 等）必须就地消化，杜绝进程级未捕获异常
          upstreamRes.on('error', (err) => {
            failStreamGracefully(err);
          });
          // P1-1 补充：FIN 提前断开时部分运行时不会触发 'error'，用 close + complete 兜底防挂死
          upstreamRes.on('close', () => {
            if (!upstreamRes.complete) {
              failStreamGracefully(new Error('上游连接在响应完成前断开 (premature close)'));
            }
          });

          upstreamRes.on('end', () => {
            const resBuffer = Buffer.concat(chunks);
            let finalBuffer = resBuffer;

            // 已提前承诺 SSE，但上游最终返回非 SSE 响应（错误页/JSON）：转为 SSE error 事件优雅收尾
            if (headersCommitted) {
              const ct = upstreamRes.headers['content-type'] || 'unknown';
              const snippet = resBuffer.length > 0 ? resBuffer.toString('utf-8').slice(0, 300) : '';
              failStreamGracefully(new Error(`提前承诺 SSE 后上游返回非流式响应 (HTTP ${status}, Content-Type: ${ct})${snippet ? `: ${snippet}` : ''}`));
              return;
            }

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
            if (!res.headersSent) {
              res.writeHead(status, resHeaders);
            }
            res.end(finalBuffer);
            cleanupStream();

            const totalMs = Date.now() - startTime;
            console.log(`${c.cyan}[RESP #${requestId}]${c.reset} ${req.method} ${req.url} -> ${status} (耗时: ${totalMs}ms)`);
          });
        }
      );

      // TTFB 超时保护：仅在响应头未到达阶段生效；已进入响应阶段的静默思考由心跳覆盖，绝不掐断
      upstreamReq.on('timeout', () => {
        if (upstreamResponded) return;
        const err = new Error(`上游 TTFB 超时 (${mergedConfig.upstreamTimeoutMs}ms 未返回响应头)`);
        err.code = 'GATEWAY_TTFB_TIMEOUT';
        upstreamReq.destroy(err);
      });

      upstreamReq.on('error', (err) => {
        console.error(`${c.red}[ERROR #${requestId}]${c.reset} 转发到上游失败: ${err.message}`);
        failStreamGracefully(err);
      });

      // P1-1: 客户端连接异常（断开后的残余写入等）就地消化，防止进程崩溃
      res.on('error', (err) => {
        clientClosed = true;
        console.warn(`${c.yellow}[WARN #${requestId}]${c.reset} 客户端响应流异常: ${err.message}`);
        cleanupStream();
      });

      // 客户端如果提前掐断连接（非正常完成），立刻销毁上游请求以节省 Token 与连接
      res.on('close', () => {
        clientClosed = true;
        if (!res.writableEnded && !upstreamReq.destroyed) {
          upstreamReq.destroy();
        }
        cleanupStream();
      });

      // 写入请求体并发送
      if (rawBody.length > 0) {
        upstreamReq.write(rawBody);
      }
      upstreamReq.end();
    });
  });

  server.stats = stats;
  server.config = mergedConfig;
  return server;
}

// 【功能 1：首包 / 尾包 SSE 事件检查与 Token 注入器】
// patchState: 记录本流首包是否被注入过估算 Token；尾包仅在首包被补过（估算口径一致）时才做
// 双保注入，避免用启发式估算值污染合规上游在 message_start 里给出的真实 input_tokens (P0-1)
function processSseEventBlock(rawBlock, estimatedTokens, requestId, patchState) {
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
    if (!parsedData.message) {
      parsedData.message = {
        id: parsedData.id || `msg_gen_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: parsedData.model || 'unknown',
        content: [],
        usage: {},
      };
    }
    const msg = parsedData.message;
    msg.usage = msg.usage || {};

    const currentInput = msg.usage.input_tokens;
    if (typeof currentInput !== 'number' || currentInput <= 0) {
      msg.usage.input_tokens = estimatedTokens;
      stats.tokensPatchedTotal++;
      if (patchState) patchState.startPatched = true;
      console.log(
        `${c.green}[PATCH #${requestId}]${c.reset} 上游首包缺失 input_tokens，已注入估算值: ${c.bold}${estimatedTokens}${c.reset} (进度条点亮！)`
      );
      return `event: message_start\ndata: ${JSON.stringify(parsedData)}`;
    }
  }

  // 2. 拦截 message_delta (双保救赎)
  // 仅当首包也被补丁过才注入估算值；合规上游（首包带真实 input_tokens）的尾包必须原样透传，
  // 否则会经 Claude Code “input_tokens != null 即覆写” 的补录通道污染真实 Token (P0-1)
  if (eventName === 'message_delta' || parsedData?.type === 'message_delta') {
    if (!patchState?.startPatched) {
      return rawBlock;
    }
    parsedData.usage = parsedData.usage || {};
    const currentInput = parsedData.usage.input_tokens;
    if (typeof currentInput !== 'number' || currentInput <= 0) {
      parsedData.usage.input_tokens = estimatedTokens;
      return `event: message_delta\ndata: ${JSON.stringify(parsedData)}`;
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
  * TTFB 保护   : ${c.magenta}上游 ${config.ttfbGraceMs}ms 未回响应头则提前承诺 SSE 并启用心跳${c.reset}
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
