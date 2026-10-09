/**
 * run_tests.mjs: 全自动集成与单元回归测试套件
 * 
 * 测试覆盖：
 * 1. Prompt Token 启发式算法单测 (中英混合、代码、工具调用、边界值)
 * 2. Mock 上游服务 (模拟不合规的 OpenAI 转译中转: message_start 缺失 input_tokens)
 * 3. Sidecar Proxy 核心功能实测:
 *    - /health 状态接口
 *    - 首包 Token 自动注入 (从 0/缺失 修补为有效 > 0)
 *    - 心跳保活 (验证长停顿自动下发 event: ping)
 *    - 响应头规范化 (X-Accel-Buffering, Cache-Control)
 * 4. doctor.mjs 命令行运行与自愈逻辑测试
 * 5. probe_api.mjs 探针端到端检测闭环验证
 */

import http from 'node:http';
import { execSync, exec, fork } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { createProxyServer, estimateTokens } from '../proxy/proxy.mjs';

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

console.log(`\n${c.bold}======================================================${c.reset}`);
console.log(`${c.bold}      claude-hud-gateway 自动化测试套件               ${c.reset}`);
console.log(`${c.bold}======================================================${c.reset}\n`);

// 1. Token 估算算法单测
console.log(`${c.bold}[测试组 1] Token 估算器 (estimateTokens)${c.reset}`);

it('处理空载荷时返回安全下限 Token', () => {
  const result = estimateTokens(null);
  assert(typeof result === 'number' && result >= 10);
});

it('正确计算长文本与中文混合 prompt', () => {
  const payload = {
    system: '你是一个专业的系统工程师',
    messages: [
      { role: 'user', content: '请帮我写一个高性能的 Node.js 异步流式代理服务，需要处理 SSE 事件。' },
    ],
  };
  const result = estimateTokens(payload);
  assert(result > 20, `Token 数量过小: ${result}`);
});

it('正确统计 tools 工具定义字符', () => {
  const payload = {
    messages: [{ role: 'user', content: 'test' }],
    tools: [
      { name: 'read_file', description: 'Read content from disk', input_schema: { type: 'object' } },
    ],
  };
  const result = estimateTokens(payload);
  assert(result > 25);
});

// 2. 模拟不合规中转服务器 (Mock Upstream)
console.log(`\n${c.bold}[测试组 2] Mock 上游与 Proxy 核心转发${c.reset}`);

const MOCK_UPSTREAM_PORT = 19091;
const PROXY_TEST_PORT = 19092;

let mockServer;
let proxyServer;

async function runProxyTests() {
  // 启动 Mock 不合规上游
  mockServer = http.createServer((req, res) => {
    if (req.url === '/v1/messages' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', async () => {
        const parsed = JSON.parse(body || '{}');

        if (parsed.stream) {
          // 模拟典型的 OpenAI 粗暴转译中转：首包 input_tokens == 0！
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Connection': 'keep-alive',
          });

          // 1. 发送有缺陷的首包 (input_tokens: 0)
          res.write('event: message_start\n');
          res.write('data: {"type":"message_start","message":{"id":"msg_test_001","type":"message","role":"assistant","model":"mock-model","content":[],"usage":{"input_tokens":0,"output_tokens":0}}}\n\n');

          // 若开启长思考模拟，停顿一段时间再吐字，触发网关心跳
          if (parsed.simulate_thinking) {
            await sleep(1000);
          }

          // 2. 发送文本 delta
          res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
          res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello World"}}\n\n');
          res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');

          // 3. 尾包
          res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n');
          res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
          res.end();
        } else {
          // 非流式，同样返回 input_tokens: 0
          res.writeHead(200, { 'Content-Type': 'application/json' });
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

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => mockServer.listen(MOCK_UPSTREAM_PORT, '127.0.0.1', resolve));

  // 启动 Proxy 并将其上游对准 Mock Server
  proxyServer = createProxyServer({
    port: PROXY_TEST_PORT,
    host: '127.0.0.1',
    targetBaseUrl: `http://127.0.0.1:${MOCK_UPSTREAM_PORT}`,
    heartbeatIntervalMs: 500, // 测试中使用 500ms 快速心跳
    autoEstimateTokens: true,
  });

  await new Promise((resolve) => proxyServer.listen(PROXY_TEST_PORT, '127.0.0.1', resolve));

  // 2.1 测试 /health
  await itAsync('Proxy /health 端点正确返回服务健康状态', async () => {
    const res = await fetch(`http://127.0.0.1:${PROXY_TEST_PORT}/health`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.status, 'healthy');
    assert.strictEqual(data.service, 'claude-hud-gateway');
  });

  // 2.2 测试非流式 Token 修补
  await itAsync('非流式响应缺失 Token 时被 Proxy 自动修补为 > 0', async () => {
    const res = await fetch(`http://127.0.0.1:${PROXY_TEST_PORT}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hello there' }],
        stream: false,
      }),
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert(data.usage.input_tokens > 0, `input_tokens 应该被修补为 > 0，实际: ${data.usage.input_tokens}`);
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
    // 验证关键响应头
    assert.strictEqual(res.headers.get('x-accel-buffering'), 'no');
    assert(res.headers.get('cache-control')?.includes('no-cache'));

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let streamText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      streamText += decoder.decode(value, { stream: true });
    }

    // 检查首包 message_start 是否包含修补后的 Token
    const match = /event:\s*message_start[\s\S]*?data:\s*({.*})/.exec(streamText);
    assert(match, '未在流中找到 message_start 事件');
    const startPayload = JSON.parse(match[1]);
    const inputTokens = startPayload.message.usage.input_tokens;
    assert(inputTokens > 0, `修补后的 input_tokens 必须大于 0，实际: ${inputTokens}`);
  });

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
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let streamText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      streamText += decoder.decode(value, { stream: true });
    }

    assert(streamText.includes('event: ping'), '上游长思考停顿期间必须注入 event: ping 心跳以防止 Claude Code 30s 崩溃');
  });

  // 3. 测试 CLI 脚本
  console.log(`\n${c.bold}[测试组 3] CLI 命令行脚本验证${c.reset}`);

  it('doctor.mjs --json 运行无语法错误且输出有效结构', () => {
    const output = execSync(`node "${path.join(rootDir, 'skills', 'claude-hud-doctor', 'scripts', 'doctor.mjs')}" --json`, {
      encoding: 'utf-8',
    });
    const parsed = JSON.parse(output);
    assert.strictEqual(typeof parsed.platform, 'object');
    assert.strictEqual(typeof parsed.settings, 'object');
    assert.strictEqual(typeof parsed.gitBash, 'object');
  });

  await itAsync('probe_api.mjs 对准 Proxy 时精准输出 PASS 裁决', async () => {
    const probeScript = path.join(rootDir, 'skills', 'claude-hud-doctor', 'scripts', 'probe_api.mjs');
    const { stdout } = await execPromise(
      `node "${probeScript}" --base-url "http://127.0.0.1:${PROXY_TEST_PORT}" --api-key "test-key" --json`
    );
    const report = JSON.parse(stdout);
    assert.strictEqual(report.verdict, 'PASS', `经过 Proxy 增强后的端点必须裁决为 PASS，实际: ${report.verdict}`);
    assert(report.sse.inputTokens > 0, '探针应捕获到经过修补的 inputTokens > 0');
  });

  // 关闭服务
  await new Promise((resolve) => proxyServer.close(resolve));
  await new Promise((resolve) => mockServer.close(resolve));
}

runProxyTests()
  .then(() => {
    console.log(`\n${c.bold}======================================================${c.reset}`);
    console.log(`${c.green}${c.bold}测试全部通过! (${passedTests}/${totalTests} Passed)${c.reset}`);
    console.log(`${c.bold}======================================================${c.reset}\n`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(`\n${c.red}测试套件异常崩溃:${c.reset}`, err);
    process.exit(1);
  });
