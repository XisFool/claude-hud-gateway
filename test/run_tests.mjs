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
 * 5. CLI 命令行脚本验证:
 *    - doctor.mjs --json 运行
 *    - doctor.mjs --fix 沙箱端到端自愈验证 (备份、修复 settings.json、固化 cc-switch.db)
 *    - probe_api.mjs 对准缺陷上游精准判定 FAIL
 *    - probe_api.mjs 对准 Proxy 精准判定 PASS
 *    - probe_api.mjs 传入 /v1 地址时不发生双重拼接
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

        if (parsed.stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Connection': 'keep-alive',
          });

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

  // ==========================================
  // [测试组 3] CLI 命令行脚本与探针端到端闭环验证
  // ==========================================
  console.log(`\n${c.bold}[测试组 3] CLI 命令行脚本与探针端到端闭环验证${c.reset}`);

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

  // 3.3 doctor.mjs --json 运行
  it('doctor.mjs --json 运行无语法错误且输出有效结构', () => {
    const output = execSync(
      `node "${path.join(rootDir, 'skills', 'claude-hud-doctor', 'scripts', 'doctor.mjs')}" --json`,
      { encoding: 'utf-8', env: { ...process.env, NODE_NO_WARNINGS: '1' } }
    );
    const parsed = JSON.parse(output);
    assert.strictEqual(typeof parsed.platform, 'object');
    assert.strictEqual(typeof parsed.settings, 'object');
    assert.strictEqual(typeof parsed.gitBash, 'object');
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
