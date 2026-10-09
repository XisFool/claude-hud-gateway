/**
 * run_tests.mjs: 全自动集成与单元回归测试套件 (深度覆盖与攻击性测试)
 * 
 * 测试覆盖：
 * 1. Prompt Token 启发式算法单测 (中英混合、代码、复杂工具调用、自定义比例)
 * 2. 目标路径智能规范化单测 (resolveTargetPath 杜绝 /v1/v1/messages 404 故障)
 * 3. SSE 边界查找单测 (findSseBoundary 覆盖 \n\n 与 \r\n\r\n)
 * 4. Mock 上游服务 + Sidecar Proxy 核心转发实测:
 *    - /health 状态接口
 *    - 上游 BASE_URL 包含 /v1 时的智能去重转发
 *    - 非流式响应 Token 补齐
 *    - 标准 \n\n SSE 流式首包 Token 注入
 *    - CRLF \r\n\r\n SSE 流式即时分块与 Token 注入 (防整流积压)
 *    - 跨 TCP 分块的多字节 UTF-8 中文字符流式拼接 (防乱码)
 *    - 模型长思考时自动注入 event: ping 心跳保活 (防 30s 崩溃)
 *    - 响应头规范化与上游压缩抑制 (Accept-Encoding: identity)
 *    - 上游连接异常 502 错误优雅处理
 *    - 合规上游首包真实 input_tokens 不被尾包估算值污染 (P0-1)
 *    - TTFB 迟滞时提前承诺 SSE 并前置心跳 / 黑洞上游超时快速失败 (P0-2)
 *    - 上游中途断开 (FIN / SSE abort) 优雅收尾，杜绝挂死 (P1-1)
 * 5. CLI 命令行脚本验证:
 *    - doctor.mjs --json 运行
 *    - doctor.mjs --fix 沙箱端到端自愈验证 (备份、修复 settings.json、固化 cc-switch.db)
 *    - doctor --fix 备份永不覆盖 / 仅修问题档案 / 解析失败中止 (P1-2/3/4)
 *    - probe_api.mjs 对准缺陷上游精准判定 FAIL
 *    - probe_api.mjs 对准 Proxy 精准判定 PASS
 *    - probe_api.mjs 传入 /v1 地址时不发生双重拼接
 *    - probe 跨域重定向剥离认证头、同源重定向保留 (P1-5)
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { exec, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import {
  createProxyServer,
  estimateTokens,
  resolveTargetPath,
  sanitizeHeartbeatIntervalMs,
  findSseBoundary,
} from '../proxy/proxy.mjs';

const execPromise = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const c = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let totalTests = 0;
let passedTests = 0;

function it(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ${c.green}✔ PASS${c.reset} ${name}`);
  } catch (err) {
    console.error(`  ${c.red}✘ FAIL${c.reset} ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

async function itAsync(name, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ${c.green}✔ PASS${c.reset} ${name}`);
  } catch (err) {
    console.error(`  ${c.red}✘ FAIL${c.reset} ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// 从 SSE 响应文本中提取指定事件的数据 JSON（用于断言首包/尾包字段）
function extractEventData(streamText, eventName) {
  const re = new RegExp(`event:\\s*${eventName}\\s*\\r?\\n(data:[^\\n]+)`);
  const m = re.exec(streamText);
  if (!m) return null;
  try {
    return JSON.parse(m[1].replace(/^data:\s*/, ''));
  } catch {
    return null;
  }
}

console.log(`\n${c.bold}======================================================${c.reset}`);
console.log(`${c.bold}      claude-hud-gateway 自动化深度测试套件           ${c.reset}`);
console.log(`${c.bold}======================================================${c.reset}\n`);

// ==========================================
// [测试组 1] 核心辅助算法与分词器单测
// ==========================================
console.log(`${c.bold}[测试组 1] 算法与路径辅助函数单测${c.reset}`);

it('estimateTokens: 处理空载荷时返回安全下限 Token', () => {
  const result = estimateTokens(null);
  assert(typeof result === 'number' && result >= 10);
});

it('estimateTokens: 正确计算长文本与中文混合 prompt', () => {
  const payload = {
    system: '你是一个专业的系统工程师',
    messages: [
      { role: 'user', content: '请帮我写一个高性能的 Node.js 异步流式代理服务，需要处理 SSE 事件。' },
    ],
  };
  const result = estimateTokens(payload);
  assert(result > 20, `Token 数量过小: ${result}`);
});

it('estimateTokens: 正确统计 tools 工具定义与复杂 tool_result 结构', () => {
  const payload = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'call tool' },
          {
            type: 'tool_result',
            content: [{ type: 'text', text: 'long tool output data '.repeat(20) }],
          },
        ],
      },
    ],
    tools: [
      { name: 'read_file', description: 'Read content from disk', input_schema: { type: 'object' } },
    ],
  };
  const result = estimateTokens(payload);
  assert(result > 80, `复合成载 Token 估算偏低: ${result}`);
});

it('estimateTokens: 支持自定义 ratio 比例参数调整', () => {
  const payload = { messages: [{ role: 'user', content: 'a'.repeat(100) }] };
  const valDefault = estimateTokens(payload, 2.5);
  const valLoose = estimateTokens(payload, 5.0);
  assert(valDefault > valLoose, '宽松分词比率计算出的 Token 数应当更小');
});

it('estimateTokens: 图片/文档附件按 1600 Token 经验值计入（含 tool_result 内嵌附件）', () => {
  // 基线文本取 100 字符（约 40 Token），确保高于 12 Token 下限，使增量断言精确成立
  const baseText = 'a'.repeat(100);
  const textOnly = estimateTokens({
    messages: [{ role: 'user', content: [{ type: 'text', text: baseText }] }],
  });
  const withImage = estimateTokens({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: baseText },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
      ],
    }],
  });
  assert(withImage - textOnly >= 1600, `顶层图片附件应至少折算 1600 Token（实际增量 ${withImage - textOnly}）`);

  const withDoc = estimateTokens({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: baseText },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'aGVsbG8=' } },
      ],
    }],
  });
  assert(withDoc - textOnly >= 1600, `顶层文档附件应至少折算 1600 Token（实际增量 ${withDoc - textOnly}）`);

  const toolResultBaseline = estimateTokens({
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 't1',
        content: [{ type: 'text', text: baseText }],
      }],
    }],
  });
  const toolResultWithImage = estimateTokens({
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 't1',
        content: [
          { type: 'text', text: baseText },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
        ],
      }],
    }],
  });
  assert(toolResultWithImage - toolResultBaseline >= 1600, `tool_result 内嵌图片同样必须计入估算（实际增量 ${toolResultWithImage - toolResultBaseline}）`);
});

it('resolveTargetPath: 智能处理 /v1 避免双重拼接 /v1/v1/messages', () => {
  assert.strictEqual(
    resolveTargetPath(new URL('https://api.anthropic.com'), '/v1/messages'),
    '/v1/messages'
  );
  assert.strictEqual(
    resolveTargetPath(new URL('https://api.relay.com/v1'), '/v1/messages'),
    '/v1/messages'
  );
  assert.strictEqual(
    resolveTargetPath(new URL('https://api.relay.com/api/v1'), '/v1/messages'),
    '/api/v1/messages'
  );
  assert.strictEqual(
    resolveTargetPath(new URL('https://api.relay.com/api'), '/v1/messages'),
    '/api/v1/messages'
  );
});

it('resolveTargetPath: 兼容完整 /v1/messages 端点配置（含查询参数边界，杜绝 /v1/messages/v1/messages）', () => {
  assert.strictEqual(
    resolveTargetPath(new URL('https://api.relay.com/v1/messages'), '/v1/messages'),
    '/v1/messages'
  );
  assert.strictEqual(
    resolveTargetPath(new URL('https://api.relay.com/v1/messages'), '/v1/messages?beta=true'),
    '/v1/messages?beta=true'
  );
  assert.strictEqual(
    resolveTargetPath(new URL('https://api.relay.com/api/v1/messages'), '/v1/messages'),
    '/api/v1/messages'
  );
  // 边界防护：/v1messages 这类形似前缀不得被误剥
  assert.strictEqual(
    resolveTargetPath(new URL('https://api.relay.com/v1'), '/v1messages'),
    '/v1/v1messages'
  );
  // 非 messages 端点访问兼容（如 /v1/models）与 query 参数保留
  assert.strictEqual(
    resolveTargetPath(new URL('https://api.relay.com/v1/messages'), '/v1/models'),
    '/v1/models'
  );
  assert.strictEqual(
    resolveTargetPath(new URL('https://api.relay.com/v1?custom=1'), '/v1/messages'),
    '/v1/messages?custom=1'
  );
});

it('sanitizeHeartbeatIntervalMs: 非法心跳周期回退 8000ms，合法值原样保留', () => {
  assert.strictEqual(sanitizeHeartbeatIntervalMs(-500), 8000);
  assert.strictEqual(sanitizeHeartbeatIntervalMs(0), 8000);
  assert.strictEqual(sanitizeHeartbeatIntervalMs('abc'), 8000);
  assert.strictEqual(sanitizeHeartbeatIntervalMs(undefined), 8000);
  assert.strictEqual(sanitizeHeartbeatIntervalMs(50), 8000);
  assert.strictEqual(sanitizeHeartbeatIntervalMs(300), 300);
  assert.strictEqual(sanitizeHeartbeatIntervalMs('500'), 500);
  assert.strictEqual(sanitizeHeartbeatIntervalMs(8000), 8000);
  assert.strictEqual(sanitizeHeartbeatIntervalMs(25000), 25000);
  assert.strictEqual(sanitizeHeartbeatIntervalMs(30000), 8000, '超过 25000ms 的心跳周期必须回退默认值以防 30s 看门狗超时闪退');
  assert.strictEqual(sanitizeHeartbeatIntervalMs(60000), 8000);
});

it('findSseBoundary: 能够精确识别 LF (\\n\\n) 与 CRLF (\\r\\n\\r\\n) 两种标准分隔符', () => {
  const lfMatch = findSseBoundary('event: message_start\ndata: {}\n\nnext');
  assert.deepStrictEqual(lfMatch, { index: 29, length: 2 });

  const crlfMatch = findSseBoundary('event: message_start\r\ndata: {}\r\n\r\nnext');
  assert.deepStrictEqual(crlfMatch, { index: 30, length: 4 });

  const noneMatch = findSseBoundary('partial chunk');
  assert.strictEqual(noneMatch, null);
});

// ==========================================
// [测试组 2] Mock 上游与 Sidecar Proxy 核心转发
// ==========================================
console.log(`\n${c.bold}[测试组 2] Mock 上游与 Proxy 核心转发实测${c.reset}`);

const MOCK_UPSTREAM_PORT = 19191;
const PROXY_TEST_PORT = 19192;

let mockServer;
let proxyServer;
let lastUpstreamHeaders = null;

async function runProxyTests() {
  // 启动 Mock 不合规上游
  mockServer = http.createServer((req, res) => {
    lastUpstreamHeaders = req.headers;

    if (req.url === '/v1/messages' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', async () => {
        const parsed = JSON.parse(body || '{}');

        // 黑洞模式：故意永不返回任何响应（测试上游 TTFB 超时保护）
        if (parsed.black_hole_mode) {
          return;
        }

        if (parsed.stream) {
          // TTFB 迟滞模式：响应头前静默 1500ms（测试提前承诺 SSE + 心跳前置）
          if (parsed.ttfb_stall_mode) {
            await sleep(1500);
          }
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Connection': 'keep-alive',
          });

          // 合规上游模式：首包携带真实 input_tokens，尾包不含 input_tokens (P0-1)
          if (parsed.compliant_tail_mode) {
            res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_compliant","type":"message","role":"assistant","model":"mock-model","content":[],"usage":{"input_tokens":4871,"output_tokens":1}}}\n\n');
            res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n');
            res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n');
            res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
            res.end();
            return;
          }

          // SSE 中途断开模式：已透传部分事件后 FIN 断开，无 message_stop (P1-1)
          if (parsed.sse_abort_mode) {
            res.on('error', () => {});
            res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_abort","type":"message","role":"assistant","usage":{"input_tokens":0}}}\n\n');
            res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n');
            await sleep(50);
            res.socket?.end(); // 中途 FIN 断开
            return;
          }

          // 场景 1：CRLF 测试流
          if (parsed.crlf_mode) {
            res.write('event: message_start\r\ndata: {"type":"message_start","message":{"id":"msg_crlf","type":"message","role":"assistant","usage":{"input_tokens":0}}}\r\n\r\n');
            res.write('event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"crlf test"}}\r\n\r\n');
            res.write('event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n');
            res.end();
            return;
          }

          // 场景 2：多字节字符拆包测试 (例如中文 '文' 对应 UTF-8: 0xE6 0x96 0x87)
          if (parsed.split_multibyte_mode) {
            res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_utf8","type":"message","role":"assistant","usage":{"input_tokens":0}}}\n\n');
            // 故意分包发送截断的 UTF-8 字节
            const prefix = Buffer.from('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"');
            const byte1 = Buffer.from([0xe6]);
            const byte23 = Buffer.from([0x96, 0x87]);
            const suffix = Buffer.from('"}}\n\n');

            res.write(Buffer.concat([prefix, byte1]));
            await sleep(50);
            res.write(Buffer.concat([byte23, suffix]));
            res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
            res.end();
            return;
          }

          // 场景 3：常规首包缺失 Token 测试
          res.write('event: message_start\n');
          res.write('data: {"type":"message_start","message":{"id":"msg_test_001","type":"message","role":"assistant","model":"mock-model","content":[],"usage":{"input_tokens":0,"output_tokens":0}}}\n\n');

          // 若开启长思考模拟，停顿一段时间再吐字，触发网关心跳
          if (parsed.simulate_thinking) {
            await sleep(1000);
          }

          res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
          res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello World"}}\n\n');
          res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');

          res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n');
          res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
          res.end();
        } else {
          // 非流式中途断开模式：已发送部分 body 后 FIN 断开 (P1-1)
          if (parsed.abort_mid_body_mode) {
            res.on('error', () => {});
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.write('{"id":"msg_partial","usage":{"input_tokens":5,');
            await sleep(50);
            res.socket?.end(); // 中途 FIN 断开
            return;
          }
          // 非流式
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            id: 'msg_test_non_stream',
            model: 'mock-model',
            content: [{ type: 'text', text: 'Hello' }],
            usage: { input_tokens: 0, output_tokens: 2 },
          }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise((resolve) => mockServer.listen(MOCK_UPSTREAM_PORT, '127.0.0.1', resolve));

  // 启动 Proxy 并将其上游对准带 /v1 后缀的 Mock 地址，同时测试 /v1 去重能力
  proxyServer = createProxyServer({
    port: PROXY_TEST_PORT,
    host: '127.0.0.1',
    targetBaseUrl: `http://127.0.0.1:${MOCK_UPSTREAM_PORT}/v1`,
    heartbeatIntervalMs: 500, // 500ms 快速心跳便于单测
    autoEstimateTokens: true,
    ttfbGraceMs: 300, // TTFB 宽限期缩短便于单测
  });

  await new Promise((resolve) => proxyServer.listen(PROXY_TEST_PORT, '127.0.0.1', resolve));

  // 2.1 测试 /health
  await itAsync('Proxy /health 端点正确返回服务健康状态与指标', async () => {
    const res = await fetch(`http://127.0.0.1:${PROXY_TEST_PORT}/health`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.status, 'healthy');
    assert.strictEqual(data.service, 'claude-hud-gateway');
  });

  // 2.2 测试非流式 Token 修补与上游压缩抑制头
  await itAsync('非流式响应缺失 Token 时被 Proxy 自动修补为 > 0 且上游收到 Accept-Encoding: identity', async () => {
    const res = await fetch(`http://127.0.0.1:${PROXY_TEST_PORT}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      body: JSON.stringify({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hello there' }],
        stream: false,
      }),
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert(data.usage.input_tokens > 0, `input_tokens 应该被修补为 > 0，实际: ${data.usage.input_tokens}`);
    assert.strictEqual(lastUpstreamHeaders['accept-encoding'], 'identity', '网关必须抑制上游压缩以防乱码');
  });

  // 2.3 测试流式首包 Token 修补与响应头
  await itAsync('流式首包 message_start 的 input_tokens: 0 被成功修补为有效值', async () => {
    const res = await fetch(`http://127.0.0.1:${PROXY_TEST_PORT}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Please output streaming response for HUD test.' }],
        stream: true,
      }),
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-accel-buffering'), 'no');
    assert(res.headers.get('cache-control')?.includes('no-cache'));

    const streamText = await res.text();
    const match = /event:\s*message_start[\s\S]*?data:\s*({.*})/.exec(streamText);
    assert(match, '未在流中找到 message_start 事件');
    const startPayload = JSON.parse(match[1]);
    const inputTokens = startPayload.message.usage.input_tokens;
    assert(inputTokens > 0, `修补后的 input_tokens 必须大于 0，实际: ${inputTokens}`);
  });

  // 2.4 测试 CRLF \r\n\r\n 换行符的即时解析与修补
  await itAsync('Proxy 完美支持 CRLF (\\r\\n\\r\\n) 换行符的流式即时解析', async () => {
    const res = await fetch(`http://127.0.0.1:${PROXY_TEST_PORT}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'CRLF test' }],
        stream: true,
        crlf_mode: true,
      }),
    });

    assert.strictEqual(res.status, 200);
    const streamText = await res.text();
    assert(streamText.includes('event: message_start'), 'CRLF 模式下必须正确识别 message_start');
    assert(streamText.includes('crlf test'), 'CRLF 模式下必须正确输出正文 delta');
    const startMatch = streamText.match(/data:\s*({.*"type":"message_start".*})/);
    assert(startMatch, 'CRLF 流中必须包含可解析的 message_start');
    const startPayload = JSON.parse(startMatch[1]);
    const inputTokens = startPayload.message.usage.input_tokens;
    assert(inputTokens > 0, `CRLF 模式下修补后的 input_tokens 必须大于 0，实际: ${inputTokens}`);
  });

  // 2.5 测试跨 TCP 分包的多字节 UTF-8 字符解码无乱码
  await itAsync('跨分块拆包的 UTF-8 中文字符在流式代理中被无损合并', async () => {
    const res = await fetch(`http://127.0.0.1:${PROXY_TEST_PORT}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'UTF8 test' }],
        stream: true,
        split_multibyte_mode: true,
      }),
    });

    assert.strictEqual(res.status, 200);
    const streamText = await res.text();
    assert(streamText.includes('文'), '多字节分包字符必须正确拼装还原为完整汉字');
    assert(!streamText.includes('\uFFFD'), '流中绝不能产生 UTF-8 截断乱码替换符');
  });

  // 2.6 测试模型长思考保活心跳
  await itAsync('模型长思考阶段自动下发 event: ping 保活心跳帧', async () => {
    const res = await fetch(`http://127.0.0.1:${PROXY_TEST_PORT}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Simulate long thinking' }],
        stream: true,
        simulate_thinking: true,
      }),
    });

    assert.strictEqual(res.status, 200);
    const streamText = await res.text();
    assert(streamText.includes('event: ping'), '长思考停顿期间必须注入 event: ping 心跳以防止客户端 30s 崩溃');
  });

  // 2.7 测试上游宕机时返回标准 502 JSON 错误且不崩溃服务
  await itAsync('上游端口不可达时 Proxy 优雅返回 502 错误而进程不崩溃', async () => {
    const deadPortProxy = createProxyServer({
      port: 19199,
      host: '127.0.0.1',
      targetBaseUrl: 'http://127.0.0.1:19198',
    });
    await new Promise((resolve) => deadPortProxy.listen(19199, '127.0.0.1', resolve));

    const res = await fetch('http://127.0.0.1:19199/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: false }),
    });

    assert.strictEqual(res.status, 502);
    const json = await res.json();
    assert.strictEqual(json.error.type, 'gateway_error');

    await new Promise((resolve) => deadPortProxy.close(resolve));
  });

  // 2.8 P0-1：合规上游（首包带真实 input_tokens）的尾包不得被估算值污染
  await itAsync('合规上游首包真实 input_tokens 原样透传，尾包不被注入估算值 (P0-1)', async () => {
    const res = await fetch(`http://127.0.0.1:${PROXY_TEST_PORT}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'compliant test' }],
        stream: true,
        compliant_tail_mode: true,
      }),
    });

    assert.strictEqual(res.status, 200);
    const streamText = await res.text();
    assert(streamText.includes('"input_tokens":4871'), '合规首包的真实 input_tokens 必须原样透传');

    const count = (streamText.match(/"input_tokens"/g) || []).length;
    assert.strictEqual(count, 1, `合规流中 input_tokens 只应出现在首包一次，实际出现 ${count} 次`);

    const delta = extractEventData(streamText, 'message_delta');
    assert(delta, '必须能解析出 message_delta 事件');
    assert(delta.usage && delta.usage.input_tokens === undefined, '合规上游尾包不得被注入估算 input_tokens');
    assert.strictEqual(delta.usage.output_tokens, 5, '尾包其余字段必须原样保留');
  });

  // 2.9 P0-1：不合规上游（首包缺失）的尾包双保注入依然生效
  await itAsync('不合规上游的尾包双保注入依然生效（与首包估算值一致）(P0-1)', async () => {
    const res = await fetch(`http://127.0.0.1:${PROXY_TEST_PORT}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'fallback test' }],
        stream: true,
      }),
    });

    assert.strictEqual(res.status, 200);
    const streamText = await res.text();
    const start = extractEventData(streamText, 'message_start');
    const delta = extractEventData(streamText, 'message_delta');
    assert(start && delta, '必须能解析出首包与尾包');
    assert(start.message.usage.input_tokens > 0, '首包应被补丁为 > 0');
    assert.strictEqual(
      delta.usage?.input_tokens,
      start.message.usage.input_tokens,
      '尾包应注入与首包一致的估算值（估算口径一致）'
    );
  });

  // 2.10 P0-2：上游 TTFB 迟滞时提前承诺 SSE 并前置心跳
  await itAsync('上游 TTFB 迟滞时提前承诺 200 SSE，ping 先于 message_start 下发 (P0-2)', async () => {
    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:${PROXY_TEST_PORT}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'ttfb stall' }],
        stream: true,
        ttfb_stall_mode: true,
      }),
    });
    const headerMs = Date.now() - t0;

    assert.strictEqual(res.status, 200);
    const streamText = await res.text();
    const pingIdx = streamText.indexOf('event: ping');
    const startIdx = streamText.indexOf('event: message_start');
    assert(pingIdx !== -1, 'TTFB 迟滞期必须有保活心跳下发');
    assert(startIdx !== -1, '迟滞结束后仍须完整透传 message_start');
    assert(pingIdx < startIdx, `心跳必须先于上游首包到达（ping@${pingIdx}, message_start@${startIdx}）`);
    assert(headerMs < 1400, `响应头必须在上游 1500ms 迟滞结束前提前落地，实际 ${headerMs}ms`);
  });

  // 2.11 / 2.12 P0-2：黑洞上游（永不响应）的快速失败
  const ttfbProxy = createProxyServer({
    port: 19197,
    host: '127.0.0.1',
    targetBaseUrl: `http://127.0.0.1:${MOCK_UPSTREAM_PORT}`,
    upstreamTimeoutMs: 700, // 短超时便于单测
    ttfbGraceMs: 200,
    heartbeatIntervalMs: 300,
  });
  await new Promise((resolve) => ttfbProxy.listen(19197, '127.0.0.1', resolve));

  await itAsync('上游黑洞时非流式请求快速失败为 504 而非永久挂死 (P0-2)', async () => {
    const t0 = Date.now();
    const res = await fetch('http://127.0.0.1:19197/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mock', messages: [], stream: false, black_hole_mode: true }),
      signal: AbortSignal.timeout(5000),
    });
    assert.strictEqual(res.status, 504, `黑洞上游必须快速返回 504，实际 ${res.status}`);
    const json = await res.json();
    assert.strictEqual(json.error.type, 'gateway_error');
    assert(Date.now() - t0 < 3000, '必须在超时保护内快速返回');
  });

  await itAsync('上游黑洞时流式请求以下发 SSE error 事件优雅收尾 (P0-2)', async () => {
    const res = await fetch('http://127.0.0.1:19197/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mock', messages: [], stream: true, black_hole_mode: true }),
      signal: AbortSignal.timeout(5000),
    });
    assert.strictEqual(res.status, 200, '流式请求已提前承诺 200 SSE');
    const text = await res.text();
    assert(text.includes('event: error'), '黑洞上游必须以 SSE error 事件收尾而非挂死');
  });

  await new Promise((resolve) => ttfbProxy.close(resolve));

  // 2.13 / 2.14 P1-1：上游中途断开（FIN）的优雅收尾
  await itAsync('场景 B 上游中途断开（FIN）时客户端快速收到 502 而非挂死 (P1-1)', async () => {
    const res = await fetch(`http://127.0.0.1:${PROXY_TEST_PORT}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mock', messages: [], stream: false, abort_mid_body_mode: true }),
      signal: AbortSignal.timeout(5000),
    });
    assert.strictEqual(res.status, 502, `上游中途断开必须快速 502，实际 ${res.status}`);
    const json = await res.json();
    assert.strictEqual(json.error.type, 'gateway_error');
  });

  await itAsync('SSE 流中途断开时以下发 event: error 优雅收尾 (P1-1)', async () => {
    const res = await fetch(`http://127.0.0.1:${PROXY_TEST_PORT}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mock', messages: [], stream: true, sse_abort_mode: true }),
      signal: AbortSignal.timeout(5000),
    });
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert(text.includes('event: error'), 'SSE 中途断开必须以 error 事件收尾而非挂死');
    assert(text.includes('msg_abort'), '中断前已透传的事件必须保留');
  });

  // ==========================================
  // [测试组 3] CLI 命令行脚本与探针端到端闭环验证
  // ==========================================
  console.log(`\n${c.bold}[测试组 3] CLI 命令行脚本与探针端到端闭环验证${c.reset}`);

  // P1-5 重定向测试专用 Mock：跨域目标服务器 + 同源/跨域重定向源服务器
  const PROBE_REDIRECT_PORT = 19193;
  const PROBE_REDIRECT_TARGET_PORT = 19194;
  let crossOriginCapturedHeaders = null;
  let sameOriginCapturedHeaders = null;

  const writeCompliantSse = (res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_redir","type":"message","role":"assistant","model":"mock","content":[],"usage":{"input_tokens":321,"output_tokens":1}}}\n\n');
    res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n');
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    res.end();
  };

  const redirectTargetServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      crossOriginCapturedHeaders = req.headers;
      writeCompliantSse(res);
    });
  });
  await new Promise((resolve) => redirectTargetServer.listen(PROBE_REDIRECT_TARGET_PORT, '127.0.0.1', resolve));

  const redirectSourceServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url.startsWith('/same/')) {
        if (req.url.includes('hop=2')) {
          sameOriginCapturedHeaders = req.headers;
          writeCompliantSse(res);
          return;
        }
        res.writeHead(302, { Location: '/same/v1/messages?hop=2' });
        res.end();
        return;
      }
      if (req.url.startsWith('/cross/')) {
        res.writeHead(302, { Location: `http://127.0.0.1:${PROBE_REDIRECT_TARGET_PORT}/v1/messages` });
        res.end();
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"not_found"}');
    });
  });
  await new Promise((resolve) => redirectSourceServer.listen(PROBE_REDIRECT_PORT, '127.0.0.1', resolve));

  // 3.1 探针直接针对缺陷上游测试 (必须判决为 FAIL)
  await itAsync('probe_api.mjs 对准缺陷上游时精准裁决为 FAIL 并指出 input_tokens: 0', async () => {
    const probeScript = path.join(rootDir, 'skills', 'claude-hud-doctor', 'scripts', 'probe_api.mjs');
    const { stdout } = await execPromise(
      `node "${probeScript}" --base-url "http://127.0.0.1:${MOCK_UPSTREAM_PORT}" --api-key "test-key" --json`
    );
    const report = JSON.parse(stdout);
    assert.strictEqual(report.verdict, 'FAIL', `未增强的缺陷上游必须裁决为 FAIL，实际: ${report.verdict}`);
    assert.strictEqual(report.sse.inputTokens, 0, '探针应精准探测出缺陷上游 input_tokens 为 0');
  });

  // 3.2 探针针对 Sidecar Proxy 测试 (必须判决为 PASS)
  await itAsync('probe_api.mjs 对准 Proxy 时精准输出 PASS 裁决', async () => {
    const probeScript = path.join(rootDir, 'skills', 'claude-hud-doctor', 'scripts', 'probe_api.mjs');
    const { stdout } = await execPromise(
      `node "${probeScript}" --base-url "http://127.0.0.1:${PROXY_TEST_PORT}" --api-key "test-key" --json`
    );
    const report = JSON.parse(stdout);
    assert.strictEqual(report.verdict, 'PASS', `经过 Proxy 增强后的端点必须裁决为 PASS，实际: ${report.verdict}`);
    assert(report.sse.inputTokens > 0, '探针应捕获到经过修补的 inputTokens > 0');
  });

  // 3.3 探针传入带 /v1 后缀的 base-url 时不发生双重拼接
  await itAsync('probe_api.mjs 传入带 /v1 后缀的 base-url 时精准命中目标并裁决为 PASS', async () => {
    const probeScript = path.join(rootDir, 'skills', 'claude-hud-doctor', 'scripts', 'probe_api.mjs');
    const { stdout } = await execPromise(
      `node "${probeScript}" --base-url "http://127.0.0.1:${PROXY_TEST_PORT}/v1" --api-key "test-key" --json`
    );
    const report = JSON.parse(stdout);
    assert.strictEqual(report.verdict, 'PASS', `带 /v1 的 base-url 必须裁决为 PASS，实际: ${report.verdict}`);
    assert(report.targetUrl.endsWith('/v1/messages'), `目标 URL 不能出现 /v1/v1/messages，实际: ${report.targetUrl}`);
  });

  // 3.4 P1-5：跨域重定向必须剥离认证头，同源重定向必须保留
  await itAsync('probe_api.mjs 跨域重定向时剥离认证头，防止 API Key 泄漏 (P1-5)', async () => {
    const probeScript = path.join(rootDir, 'skills', 'claude-hud-doctor', 'scripts', 'probe_api.mjs');
    const { stdout } = await execPromise(
      `node "${probeScript}" --base-url "http://127.0.0.1:${PROBE_REDIRECT_PORT}/cross" --api-key "leak-test-key" --json`
    );
    const report = JSON.parse(stdout);
    assert.strictEqual(report.verdict, 'PASS', `重定向到合规 SSE 后仍应正常裁决，实际: ${report.verdict}`);
    assert(crossOriginCapturedHeaders, '跨域目标服务器必须收到重定向后的请求');
    assert.strictEqual(crossOriginCapturedHeaders['x-api-key'], undefined, '跨域重定向不得携带 x-api-key');
    assert.strictEqual(crossOriginCapturedHeaders['authorization'], undefined, '跨域重定向不得携带 authorization');
    assert.strictEqual(crossOriginCapturedHeaders['anthropic-auth-token'], undefined, '跨域重定向不得携带 anthropic-auth-token');
    assert(report.recommendations.some((r) => r.includes('跨域')), '报告中必须提示跨域重定向已剥离凭证');
  });

  await itAsync('probe_api.mjs 同源重定向时保留认证头 (P1-5)', async () => {
    const probeScript = path.join(rootDir, 'skills', 'claude-hud-doctor', 'scripts', 'probe_api.mjs');
    const { stdout } = await execPromise(
      `node "${probeScript}" --base-url "http://127.0.0.1:${PROBE_REDIRECT_PORT}/same" --api-key "keep-test-key" --json`
    );
    const report = JSON.parse(stdout);
    assert.strictEqual(report.verdict, 'PASS', `同源重定向后必须正常裁决，实际: ${report.verdict}`);
    assert(sameOriginCapturedHeaders, '同源目标必须收到重定向后的请求');
    assert.strictEqual(sameOriginCapturedHeaders['x-api-key'], 'keep-test-key', '同源重定向必须保留认证头');
  });

  // 3.4b P2：探针全局总超时熔断——慢速滴包（间隔小于空闲阈值）无法再无限延长探针生命周期
  await itAsync('probe_api.mjs 全局总超时熔断：慢速滴包绕过空闲超时也会被硬熔断 (P2)', async () => {
    const DRIP_PORT = 19196;
    const dripServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      // 每 250ms 滴一个 ping 持续 4 秒：间隔远小于 socket 空闲超时，专打旧实现的套接字超时漏洞
      let pings = 0;
      const timer = setInterval(() => {
        if (res.writableEnded) return;
        res.write('event: ping\ndata: {"type":"ping"}\n\n');
        pings++;
        if (pings >= 16) {
          clearInterval(timer);
          res.end();
        }
      }, 250);
      res.on('close', () => clearInterval(timer));
    });
    await new Promise((resolve) => dripServer.listen(DRIP_PORT, '127.0.0.1', resolve));

    try {
      const probeScript = path.join(rootDir, 'skills', 'claude-hud-doctor', 'scripts', 'probe_api.mjs');
      const start = Date.now();
      const { stdout } = await execPromise(
        `node "${probeScript}" --base-url "http://127.0.0.1:${DRIP_PORT}" --api-key "sk-drip" --timeout 800 --json`
      );
      const wallMs = Date.now() - start;
      const report = JSON.parse(stdout);
      assert.strictEqual(report.verdict, 'FAIL', '慢滴保活的流必须被裁决为 FAIL');
      assert(
        report.verdictReason.includes('全局超时'),
        `裁决理由必须指出全局超时熔断，实际: ${report.verdictReason}`
      );
      assert(
        wallMs < 3000,
        `探针必须在全局时限附近结束（实际 ${wallMs}ms，旧实现会等慢滴自然结束接近 4000ms+）`
      );
    } finally {
      await new Promise((resolve) => dripServer.close(resolve));
    }
  });

  // 3.3 doctor.mjs --json 运行（P2: 注入沙箱环境变量，与宿主机真实配置完全隔离）
  it('doctor.mjs --json 运行无语法错误且输出有效结构（沙箱隔离）', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hud-test-'));
    try {
      const output = execSync(
        `node "${path.join(rootDir, 'skills', 'claude-hud-doctor', 'scripts', 'doctor.mjs')}" --json`,
        {
          encoding: 'utf-8',
          env: {
            ...process.env,
            CLAUDE_CONFIG_DIR: path.join(tmpDir, '.claude'),
            CC_SWITCH_DB_PATH: path.join(tmpDir, 'no-such.db'),
            NODE_NO_WARNINGS: '1',
          },
        }
      );
      const parsed = JSON.parse(output);
      assert.strictEqual(typeof parsed.platform, 'object');
      assert.strictEqual(typeof parsed.settings, 'object');
      assert.strictEqual(typeof parsed.gitBash, 'object');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 3.4 doctor.mjs --fix 沙箱端到端自愈实测
  await itAsync('doctor.mjs --fix 在沙箱环境中正确备份并修复 settings.json 与 cc-switch.db', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hud-test-'));
    const mockClaudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(mockClaudeDir, { recursive: true });

    // 写入一个有问题的 settings.json (包含破坏性的 unescaped 反斜杠)
    const mockSettingsPath = path.join(mockClaudeDir, 'settings.json');
    fs.writeFileSync(
      mockSettingsPath,
      JSON.stringify({
        statusLine: {
          type: 'command',
          command: 'C:\\Program Files\\nodejs\\node.exe C:\\broken\\statusline.mjs',
        },
      }),
      'utf-8'
    );

    // 写入一个有问题的 mock cc-switch.db
    const mockCcSwitchDbPath = path.join(tmpDir, 'mock-cc-switch.db');
    let sqliteModule;
    try {
      sqliteModule = await import('node:sqlite');
    } catch {}

    if (sqliteModule?.DatabaseSync) {
      const db = new sqliteModule.DatabaseSync(mockCcSwitchDbPath);
      db.exec(`
        CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, app_type TEXT, settings_config TEXT);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      `);
      db.prepare(`
        INSERT INTO providers (id, name, app_type, settings_config) VALUES 
        ('p1', 'Bad Provider 1', 'claude', '{"env":{}}'),
        ('p2', 'Bad Provider 2', 'claude', '{"statusLine":{"type":"command","command":"cmd.exe /c node C:\\\\foo\\\\bar.mjs"}}');
      `).run();
      db.close();

      // 执行 --fix
      const doctorScript = path.join(rootDir, 'skills', 'claude-hud-doctor', 'scripts', 'doctor.mjs');
      await execPromise(`node "${doctorScript}" --fix`, {
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: mockClaudeDir,
          CC_SWITCH_DB_PATH: mockCcSwitchDbPath,
          NODE_NO_WARNINGS: '1',
        },
      });

      // 验证备份文件是否创建
      assert(fs.existsSync(`${mockSettingsPath}.bak`), '原 settings.json 必须生成 .bak 备份文件');
      assert(fs.existsSync(`${mockCcSwitchDbPath}.bak`), '原 cc-switch.db 必须生成 .bak 备份文件');

      // 验证修复后的 settings.json
      const fixedSettings = JSON.parse(fs.readFileSync(mockSettingsPath, 'utf-8'));
      assert(fixedSettings.statusLine.command.includes('node "'), 'settings.json 必须注入安全 command');
      assert(!fixedSettings.statusLine.command.includes('\\'), 'command 路径必须使用正斜杠');

      // 验证修复后的 cc-switch.db
      const verifyDb = new sqliteModule.DatabaseSync(mockCcSwitchDbPath);
      const rows = verifyDb.prepare("SELECT settings_config FROM providers WHERE app_type='claude'").all();
      for (const row of rows) {
        const parsedCfg = JSON.parse(row.settings_config);
        assert(parsedCfg.statusLine?.command, '所有 Provider 必须成功固化 statusLine');
      }
      verifyDb.close();

      // 验证再次运行 doctor --json 时 issuesFound 为空
      const { stdout: checkJson } = await execPromise(`node "${doctorScript}" --json`, {
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: mockClaudeDir,
          CC_SWITCH_DB_PATH: mockCcSwitchDbPath,
          NODE_NO_WARNINGS: '1',
        },
      });
      const checkReport = JSON.parse(checkJson);
      assert.strictEqual(checkReport.issuesFound.length, 0, '自愈后诊断报告中的问题列表必须清空');
    }

    // 清理沙箱临时目录
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 3.5 P1-2：备份永不覆盖（首轮 .bak 保存最初快照，后续修复带时间戳另存）
  await itAsync('doctor.mjs --fix 二次运行时最初 .bak 不被覆盖，并生成时间戳备份 (P1-2)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hud-test-'));
    const mockClaudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(mockClaudeDir, { recursive: true });
    const mockSettingsPath = path.join(mockClaudeDir, 'settings.json');
    const v1 = JSON.stringify({ statusLine: { type: 'command', command: 'C:\\broken\\v1.mjs' } });
    fs.writeFileSync(mockSettingsPath, v1, 'utf-8');

    const doctorScript = path.join(rootDir, 'skills', 'claude-hud-doctor', 'scripts', 'doctor.mjs');
    const sandboxEnv = {
      ...process.env,
      CLAUDE_CONFIG_DIR: mockClaudeDir,
      CC_SWITCH_DB_PATH: path.join(tmpDir, 'no-such.db'),
      NODE_NO_WARNINGS: '1',
    };

    await execPromise(`node "${doctorScript}" --fix`, { env: sandboxEnv });
    assert.strictEqual(fs.readFileSync(`${mockSettingsPath}.bak`, 'utf-8'), v1, '首轮 .bak 必须等于最初原始内容');

    // 第二轮前再次改坏（模拟用户再次手工修改配置）
    const v2 = JSON.stringify({ statusLine: { type: 'command', command: 'cmd.exe /c C:\\bad\\v2.mjs' } });
    fs.writeFileSync(mockSettingsPath, v2, 'utf-8');
    await execPromise(`node "${doctorScript}" --fix`, { env: sandboxEnv });

    assert.strictEqual(fs.readFileSync(`${mockSettingsPath}.bak`, 'utf-8'), v1, '第二轮不得用新内容覆盖最初 .bak');
    const tsBackups = fs.readdirSync(mockClaudeDir).filter((f) => f.startsWith('settings.json.bak-'));
    assert(tsBackups.length >= 1, '第二轮修复必须生成带时间戳的新备份');
    assert.strictEqual(
      fs.readFileSync(path.join(mockClaudeDir, tsBackups[0]), 'utf-8'),
      v2,
      '时间戳备份内容应为第二轮修复前的当前文件'
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 3.6 P1-3：仅修复问题档案，健康的自定义 statusLine 不被覆写
  await itAsync('doctor.mjs --fix 不覆写健康的自定义 statusLine（settings 与 Provider 双保险）(P1-3)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hud-test-'));
    const mockClaudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(mockClaudeDir, { recursive: true });
    const mockSettingsPath = path.join(mockClaudeDir, 'settings.json');
    const healthyCustomCmd = 'node "C:/custom/my-statusline.js"';
    fs.writeFileSync(
      mockSettingsPath,
      JSON.stringify({
        env: { ANTHROPIC_BASE_URL: 'https://relay.example.com' },
        statusLine: { type: 'command', command: healthyCustomCmd },
      }),
      'utf-8'
    );

    const dbPath = path.join(tmpDir, 'mock-cc-switch.db');
    let sqliteModule;
    try {
      sqliteModule = await import('node:sqlite');
    } catch {}

    if (sqliteModule?.DatabaseSync) {
      const healthyProviderCfg = '{"env":{},"statusLine":{"type":"command","command":"node \\"C:/custom/other-statusline.js\\""}}';
      const db = new sqliteModule.DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, app_type TEXT, settings_config TEXT);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      `);
      db.prepare(`
        INSERT INTO providers (id, name, app_type, settings_config) VALUES 
        ('p1', 'Missing Provider', 'claude', '{"env":{}}'),
        ('p2', 'Risky Provider', 'claude', '{"statusLine":{"type":"command","command":"cmd.exe /c node C:\\\\foo\\\\bar.mjs"}}')
      `).run();
      db.prepare('INSERT INTO providers (id, name, app_type, settings_config) VALUES (?, ?, ?, ?)').run('p3', 'Healthy Custom', 'claude', healthyProviderCfg);
      db.close();

      const doctorScript = path.join(rootDir, 'skills', 'claude-hud-doctor', 'scripts', 'doctor.mjs');
      await execPromise(`node "${doctorScript}" --fix`, {
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: mockClaudeDir,
          CC_SWITCH_DB_PATH: dbPath,
          NODE_NO_WARNINGS: '1',
        },
      });

      // settings.json：健康的自定义 statusLine 与其余配置都不能被动
      const fixedSettings = JSON.parse(fs.readFileSync(mockSettingsPath, 'utf-8'));
      assert.strictEqual(fixedSettings.statusLine.command, healthyCustomCmd, '健康自定义 statusLine 不得被覆写');
      assert.strictEqual(fixedSettings.env.ANTHROPIC_BASE_URL, 'https://relay.example.com', '其余配置必须保留');

      // cc-switch.db：p3 原样保留，p1/p2 被修复
      const verifyDb = new sqliteModule.DatabaseSync(dbPath);
      const rows = Object.fromEntries(
        verifyDb.prepare("SELECT id, settings_config FROM providers WHERE app_type='claude'").all().map((r) => [r.id, r.settings_config])
      );
      verifyDb.close();
      assert.strictEqual(rows.p3, healthyProviderCfg, '健康档案必须原样保留（不得被 UPDATE 覆写）');
      assert(JSON.parse(rows.p1).statusLine?.command.includes('statusline.mjs'), '缺失档案必须被修复');
      assert(JSON.parse(rows.p2).statusLine?.command.includes('statusline.mjs'), '风险档案必须被修复');
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 3.7 P1-4：损坏的 settings.json 必须中止修复而非清空重写
  await itAsync('doctor.mjs --fix 遇损坏 settings.json 时中止修复，其余配置不被清空 (P1-4)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hud-test-'));
    const mockClaudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(mockClaudeDir, { recursive: true });
    const mockSettingsPath = path.join(mockClaudeDir, 'settings.json');
    // 尾逗号导致 JSON 非法（JSONC 风格），doctor 必须中止而不是覆写成空对象
    const brokenContent = '{\n  "env": { "ANTHROPIC_BASE_URL": "https://relay.example.com", },\n}';
    fs.writeFileSync(mockSettingsPath, brokenContent, 'utf-8');

    const doctorScript = path.join(rootDir, 'skills', 'claude-hud-doctor', 'scripts', 'doctor.mjs');
    const { stdout } = await execPromise(`node "${doctorScript}" --fix --json`, {
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: mockClaudeDir,
        CC_SWITCH_DB_PATH: path.join(tmpDir, 'no-such.db'),
        NODE_NO_WARNINGS: '1',
      },
    });
    const report = JSON.parse(stdout);
    assert.strictEqual(fs.readFileSync(mockSettingsPath, 'utf-8'), brokenContent, '损坏的 settings.json 必须原样保留，绝不能被清空重写');
    assert(report.fixesApplied.some((s) => s.includes('解析失败')), '报告必须明确提示解析失败并已跳过修复');
    assert(fs.existsSync(`${mockSettingsPath}.bak`), '中止前仍须保留备份');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 3.8 P2：sqlite3 CLI 降级链路（FORCE_CLI 强制）-json 精确读取 + stdin 安全写入
  await itAsync('doctor.mjs 在 sqlite3 CLI 降级链路下精确诊断并安全修复含引号/换行的多行 JSON', async () => {
    let hasCli = false;
    try {
      execSync('sqlite3 -version', { stdio: 'ignore' });
      hasCli = true;
    } catch {}
    let sqliteModule;
    try {
      sqliteModule = await import('node:sqlite');
    } catch {}
    if (!hasCli || !sqliteModule?.DatabaseSync) return; // 无 sqlite3 CLI 或无 node:sqlite 的环境跳过

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hud-test-'));
    const mockClaudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(mockClaudeDir, { recursive: true });
    const dbPath = path.join(tmpDir, 'mock-cc-switch.db');

    // 构造 pretty-print 多行 JSON 且含 ' " $ 与真实换行的供应商，专门打击管道分隔解析与 Shell 引号转义
    const trickyNote = `it's "quoted" $HOME\nsecond line`;
    const trickySettingsConfig = JSON.stringify({ env: { NOTE: trickyNote } }, null, 2);
    {
      const db = new sqliteModule.DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, app_type TEXT, settings_config TEXT);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      `);
      db.prepare('INSERT INTO providers (id, name, app_type, settings_config) VALUES (?, ?, ?, ?)').run('p1', 'Tricky', 'claude', trickySettingsConfig);
      db.prepare('INSERT INTO providers (id, name, app_type, settings_config) VALUES (?, ?, ?, ?)').run('p2', 'Plain', 'claude', '{"env":{}}');
      db.close();
    }

    const doctorScript = path.join(rootDir, 'skills', 'claude-hud-doctor', 'scripts', 'doctor.mjs');
    const cliEnv = {
      ...process.env,
      CLAUDE_CONFIG_DIR: mockClaudeDir,
      CC_SWITCH_DB_PATH: dbPath,
      CC_SWITCH_FORCE_CLI: '1',
      NODE_NO_WARNINGS: '1',
    };

    // 诊断：多行 JSON 必须被精确解析为"缺失 statusLine"，而非误判"配置损坏无法解析"
    const { stdout: diagOut } = await execPromise(`node "${doctorScript}" --json`, { env: cliEnv });
    const diag = JSON.parse(diagOut);
    assert.strictEqual(diag.ccSwitch.claudeProviders, 2, 'CLI 链路必须正确数出 2 个 Claude 供应商');
    assert(
      diag.ccSwitch.missingStatusLineProviders.some((p) => p.id === 'p1' && p.reason === '缺失 statusLine 配置'),
      '多行 JSON 供应商必须精确诊断为缺失 statusLine（管道分隔解析会误判为配置损坏）'
    );

    // 修复：stdin 安全写入，引号/$/换行必须原样保留
    await execPromise(`node "${doctorScript}" --fix`, { env: cliEnv });
    const verifyDb = new sqliteModule.DatabaseSync(dbPath);
    const rows = Object.fromEntries(
      verifyDb.prepare("SELECT id, settings_config FROM providers WHERE app_type='claude'").all().map((r) => [r.id, r.settings_config])
    );
    verifyDb.close();

    const p1Fixed = JSON.parse(rows.p1);
    assert(p1Fixed.statusLine?.command.includes('statusline.mjs'), 'CLI 链路必须为多行 JSON 档案注入 statusLine');
    assert.strictEqual(p1Fixed.env.NOTE, trickyNote, '包含引号/$/换行的环境变量必须原样保留（stdin 安全通道）');
    assert(JSON.parse(rows.p2).statusLine?.command.includes('statusline.mjs'), 'CLI 链路必须修复普通问题档案');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 3.9 P2：混合反斜杠不漏判 + 通用 MSYS node 绝对路径识别（替代硬编码 /d/NodeJs/node 字面量）
  await itAsync('doctor.mjs 反斜杠混合命令不漏判，且通用 MSYS node 绝对路径被标记为脆弱', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hud-test-'));
    const mockClaudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(mockClaudeDir, { recursive: true });
    const mockSettingsPath = path.join(mockClaudeDir, 'settings.json');
    const doctorScript = path.join(rootDir, 'skills', 'claude-hud-doctor', 'scripts', 'doctor.mjs');
    const sandboxEnv = {
      ...process.env,
      CLAUDE_CONFIG_DIR: mockClaudeDir,
      CC_SWITCH_DB_PATH: path.join(tmpDir, 'no-such.db'),
      NODE_NO_WARNINGS: '1',
    };

    // 场景 A：同时含转义对 \\ 与孤立 \ —— 旧启发式 includes('\\\\') 短路会漏判
    fs.writeFileSync(
      mockSettingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: 'node "C:\\\\shared\\\\sl.mjs" C:\\legacy' } }),
      'utf-8'
    );
    const { stdout: outA } = await execPromise(`node "${doctorScript}" --json`, { env: sandboxEnv });
    const reportA = JSON.parse(outA);
    if (process.platform === 'win32') {
      assert.strictEqual(reportA.settings.issue, 'contains_unescaped_backslashes', '混合转义的反斜杠命令必须被标记');
    }

    // 场景 B：无任何反斜杠，但硬编码了非标准 MSYS node 绝对路径（旧版仅识别 /d/NodeJs/node 字面量，会漏判）
    fs.writeFileSync(
      mockSettingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: 'node /c/custom/bin/node.exe "/c/custom/statusline.mjs"' } }),
      'utf-8'
    );
    const { stdout: outB } = await execPromise(`node "${doctorScript}" --json`, { env: sandboxEnv });
    const reportB = JSON.parse(outB);
    if (process.platform === 'win32') {
      assert.strictEqual(reportB.settings.issue, 'legacy_fragile_statusline', '通用 MSYS node 绝对路径必须被识别为脆弱配置');
    }

    // 场景 C：Bash 合法转义空格或单引号路径，不应误报反斜杠缺陷
    fs.writeFileSync(
      mockSettingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: 'node /c/Program\\ Files/statusline.mjs' } }),
      'utf-8'
    );
    const { stdout: outC } = await execPromise(`node "${doctorScript}" --json`, { env: sandboxEnv });
    const reportC = JSON.parse(outC);
    if (process.platform === 'win32') {
      assert.notStrictEqual(reportC.settings.issue, 'contains_unescaped_backslashes', 'Bash 转义空格不得误报反斜杠缺陷');
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 关闭服务
  await new Promise((resolve) => proxyServer.close(resolve));
  await new Promise((resolve) => mockServer.close(resolve));
  await new Promise((resolve) => redirectSourceServer.close(resolve));
  await new Promise((resolve) => redirectTargetServer.close(resolve));
}

runProxyTests()
  .then(() => {
    // P2: 失败用例只在 it()/itAsync() 内置了过程级 exitCode，必须以判定结果显式收尾，
    // 否则 process.exit(0) 会覆盖失败信号，导致 CI 流水线永远假绿
    const allPassed = passedTests === totalTests && totalTests > 0;
    console.log(`\n${c.bold}======================================================${c.reset}`);
    if (allPassed) {
      console.log(`${c.green}${c.bold}测试全部通过! (${passedTests}/${totalTests} Passed)${c.reset}`);
    } else {
      console.log(`${c.red}${c.bold}测试存在失败! (${passedTests}/${totalTests} Passed)${c.reset}`);
    }
    console.log(`${c.bold}======================================================${c.reset}\n`);
    process.exit(allPassed ? 0 : 1);
  })
  .catch((err) => {
    console.error(`\n${c.red}测试套件异常崩溃:${c.reset}`, err);
    process.exit(1);
  });
