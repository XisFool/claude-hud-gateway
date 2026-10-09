#!/usr/bin/env node
/**
 * claude-hud-doctor: Claude Code 终端状态栏全环境诊断与一键自愈工具
 * 
 * 功能：
 * 1. 扫描 ~/.claude/settings.json 是否遗失 statusLine。
 * 2. 诊断 Windows 平台 Git for Windows (bash.exe) 与执行器路径反斜杠转义问题。
 * 3. 扫描 ~/.cc-switch/cc-switch.db 中所有 Claude Provider 档案是否缺失 statusLine。
 * 4. 支持 --fix 参数执行一键自愈，对配置文件与数据库自动备份并写入持久化防护。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';

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

// 命令行参数
const args = process.argv.slice(2);
const isFix = args.includes('--fix') || args.includes('-f');
const isJson = args.includes('--json');
const isHelp = args.includes('--help') || args.includes('-h');

if (isHelp) {
  console.log(`
${c.bold}Claude HUD Doctor (环境诊断与一键自愈工具)${c.reset}

用法:
  node doctor.mjs [选项]

选项:
  -f, --fix     一键自动修复发现的配置缺失、反斜杠损坏与 cc-switch 覆盖隐患
  --json        以 JSON 格式输出体检报告
  -h, --help    显示帮助信息
`);
  process.exit(0);
}

// 基础路径计算
const homeDir = os.homedir();
const claudeDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(homeDir, '.claude');
const settingsPath = path.join(claudeDir, 'settings.json');
const ccSwitchDbPath = process.env.CC_SWITCH_DB_PATH?.trim() || path.join(homeDir, '.cc-switch', 'cc-switch.db');
const pluginsDir = path.join(claudeDir, 'plugins');
const hudPluginDir = path.join(pluginsDir, 'claude-hud');
const statuslineMjsPath = path.join(hudPluginDir, 'statusline.mjs');

// 标准跨平台 statusLine 执行命令（使用正斜杠，兼容 CMD、PowerShell 与 Git Bash）
function getStandardStatusLineCommand() {
  const normPath = statuslineMjsPath.replace(/\\/g, '/');
  return {
    type: 'command',
    command: `node "${normPath}"`,
  };
}

// 生成永不覆盖的备份 (P1-2)：首轮生成 <file>.bak 作为最初快照；
// 此后每次修复按时间戳另存新备份，绝不用"已修复的文件"覆盖历史备份
function createBackup(srcPath) {
  const baseBakPath = `${srcPath}.bak`;
  if (!fs.existsSync(baseBakPath)) {
    fs.copyFileSync(srcPath, baseBakPath);
    return baseBakPath;
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  let bakPath = `${srcPath}.bak-${stamp}`;
  let seq = 1;
  while (fs.existsSync(bakPath)) {
    bakPath = `${srcPath}.bak-${stamp}-${seq++}`;
  }
  fs.copyFileSync(srcPath, bakPath);
  return bakPath;
}

// 未转义反斜杠扫描：
// 1. Bash 单引号 '...' 内不发生反斜杠转义，内部反斜杠安全（字面量原样传递）；
// 2. 成对反斜杠 \\ 属安全转义；
// 3. Bash 合法转义字符（如转义空格 \ 、转义引号 \"）属合法转义；
// 4. 其余孤立 \ 即为 Git Bash 吞噬风险（如 Windows 路径 C:\foo\bar）。
function hasUnescapedBackslash(cmd) {
  const s = String(cmd || '');
  let inSingleQuote = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (inSingleQuote) continue;

    if (ch === '\\') {
      const next = s[i + 1];
      if (next === '\\') { i++; continue; }
      if (next === ' ' || next === '"') { i++; continue; }
      return true;
    }
  }
  return false;
}

// 加载 node:sqlite 内置驱动（Node >= 22.5）；CC_SWITCH_FORCE_CLI=1 强制走 sqlite3 CLI 降级链路（测试专用）
async function loadNodeSqlite() {
  if (process.env.CC_SWITCH_FORCE_CLI === '1') return null;
  try {
    const sqlite = await import('node:sqlite');
    return sqlite.DatabaseSync || null;
  } catch {
    return null;
  }
}

// sqlite3 CLI 读取 Claude 供应商：优先 -json 模式，正确处理含换行/引号的多行 JSON；
// 旧版 CLI 不支持 -json 时报错回退，再以管道分隔解析（仅适用于单行 JSON）
function readClaudeProvidersViaCli(dbPath) {
  const sql = "SELECT id, name, settings_config FROM providers WHERE app_type='claude';";
  const opts = { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] };
  let raw = '';
  try {
    raw = execFileSync('sqlite3', ['-json', dbPath, sql], opts);
  } catch {
    raw = execFileSync('sqlite3', [dbPath, sql], opts);
    return raw.trim().split(/\r?\n/).filter(Boolean).map((line) => {
      const parts = line.split('|');
      return { id: parts[0], name: parts[1], settings_config: parts.slice(2).join('|') };
    });
  }
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    return JSON.parse(trimmed);
  } catch {
    return [];
  }
}

// sqlite3 CLI 写入：免 Shell 的 execFileSync + SQL 经 stdin 通道，彻底绕开引号/反斜杠/$ 转义破坏
function execSqliteViaStdin(dbPath, sql) {
  execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf-8' });
}

// 标准 statusline.mjs 脚本内容模板（若本地缺失可直接重建）
const STATUSLINE_MJS_TEMPLATE = `// Runs the newest installed claude-hud.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const columns = Number.parseInt(process.env.COLUMNS ?? '', 10);
if (columns > 0) process.env.COLUMNS = String(Math.max(1, columns - 4));

const envDir = process.env.CLAUDE_CONFIG_DIR?.trim();
const configDir = !envDir
  ? path.join(os.homedir(), '.claude')
  : envDir === '~' || envDir.startsWith('~/') ? path.join(os.homedir(), envDir.slice(1)) : envDir;
const cacheDir = path.join(configDir, 'plugins', 'cache');
const entry = process.versions.bun ? path.join('src', 'index.ts') : path.join('dist', 'index.js');

const list = (dir) => {
  try { return fs.readdirSync(dir); } catch { return []; }
};
const parseVersion = (name) => /^(\\d+)\\.(\\d+)\\.(\\d+)(?:[-+].*)?$/.exec(name)?.slice(1).map(Number);
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

let latest;
for (const marketplace of list(cacheDir)) {
  const pluginDir = path.join(cacheDir, marketplace, 'claude-hud');
  for (const name of list(pluginDir)) {
    const version = parseVersion(name);
    const file = path.join(pluginDir, name, entry);
    if (version && (!latest || compare(version, latest.version) > 0) && fs.existsSync(file)) {
      latest = { version, file };
    }
  }
}

if (latest) {
  const hud = await import(pathToFileURL(latest.file).href);
  await hud.main();
}
`;

// 探测 Windows 下的 Git Bash
function detectGitBash() {
  if (process.platform !== 'win32') return { present: true, path: '/bin/bash' };

  if (process.env.CLAUDE_CODE_GIT_BASH_PATH && fs.existsSync(process.env.CLAUDE_CODE_GIT_BASH_PATH)) {
    return { present: true, path: process.env.CLAUDE_CODE_GIT_BASH_PATH };
  }

  const standardPaths = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  for (const p of standardPaths) {
    if (fs.existsSync(p)) return { present: true, path: p };
  }

  try {
    const gitOut = execSync('where.exe git', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    if (gitOut) {
      const firstGit = gitOut.split(/\r?\n/)[0];
      const bashCandidate = path.join(firstGit, '..', '..', 'bin', 'bash.exe');
      if (fs.existsSync(bashCandidate)) {
        return { present: true, path: bashCandidate };
      }
    }
  } catch {}

  return { present: false, path: null };
}

// 诊断对象
const report = {
  platform: {
    os: process.platform,
    nodeVersion: process.version,
    homeDir,
    claudeDir,
  },
  gitBash: detectGitBash(),
  settings: {
    exists: false,
    hasStatusLine: false,
    command: null,
    issue: null,
  },
  statuslineScript: {
    exists: false,
    path: statuslineMjsPath,
  },
  ccSwitch: {
    installed: false,
    dbPath: ccSwitchDbPath,
    totalProviders: 0,
    claudeProviders: 0,
    missingStatusLineProviders: [],
    commonConfigHasStatusLine: false,
  },
  issuesFound: [],
  fixesApplied: [],
};

// 1. 检查 statusline.mjs 脚本
report.statuslineScript.exists = fs.existsSync(statuslineMjsPath);

// 2. 检查 ~/.claude/settings.json
if (fs.existsSync(settingsPath)) {
  report.settings.exists = true;
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.statusLine && parsed.statusLine.type === 'command') {
      report.settings.hasStatusLine = true;
      report.settings.command = parsed.statusLine.command;

      // 检查命令语法风险
      if (process.platform === 'win32') {
        const cmd = parsed.statusLine.command || '';
        // 检查是否使用了会导致 Git Bash 吞掉的反斜杠
        if (hasUnescapedBackslash(cmd)) {
          report.settings.issue = 'contains_unescaped_backslashes';
          report.issuesFound.push('settings.json 中的 statusLine.command 包含未转义反斜杠，在 Git Bash 中会导致路径解析破坏');
        } else if (cmd.includes('cols=$(stty') && !report.gitBash.present) {
          report.settings.issue = 'bash_syntax_without_git_bash';
          report.issuesFound.push('statusLine.command 包含 Bash 命令语法，但系统未检测到 Git for Windows，PowerShell 执行将报语法错误');
        } else if (cmd.includes('cols=$(stty') || cmd.includes('cmd.exe') || /\/[a-z]\/(?:[^"'\s]+\/)*node(?:\.exe)?\b/i.test(cmd)) {
          report.settings.issue = 'legacy_fragile_statusline';
          report.issuesFound.push('settings.json 中的 statusLine.command 包含硬编码路径或脆弱的 Shell 脚本，建议一键升级为跨平台标准 statusline.mjs 入口');
        }
      }
    } else {
      report.settings.hasStatusLine = false;
      report.issuesFound.push('settings.json 中缺失 statusLine 配置（终端底部将完全空白）');
    }
  } catch (err) {
    report.issuesFound.push(`settings.json 解析失败: ${err.message}`);
  }
} else {
  report.issuesFound.push(`未找到 Claude 配置文件: ${settingsPath}`);
}

// 3. 检查 cc-switch 数据库
async function inspectCcSwitch() {
  if (!fs.existsSync(ccSwitchDbPath)) {
    return;
  }
  report.ccSwitch.installed = true;

  try {
    const DatabaseSync = await loadNodeSqlite();

    if (DatabaseSync) {
      const db = new DatabaseSync(ccSwitchDbPath);
      
      // 查询所有 claude 供应商
      const providers = db.prepare("SELECT id, name, settings_config FROM providers WHERE app_type = 'claude'").all();
      report.ccSwitch.claudeProviders = providers.length;

      for (const p of providers) {
        try {
          const cfg = JSON.parse(p.settings_config || '{}');
          if (!cfg.statusLine || !cfg.statusLine.command) {
            report.ccSwitch.missingStatusLineProviders.push({ id: p.id, name: p.name, reason: '缺失 statusLine 配置' });
          } else {
            const cmd = cfg.statusLine.command;
            if (hasUnescapedBackslash(cmd) || cmd.includes('cmd.exe') || (cmd.includes('cols=$(stty') && !report.gitBash.present)) {
              report.ccSwitch.missingStatusLineProviders.push({ id: p.id, name: p.name, reason: '包含不兼容的命令语法或未转义反斜杠' });
            }
          }
        } catch {
          report.ccSwitch.missingStatusLineProviders.push({ id: p.id, name: p.name, reason: '配置损坏无法解析' });
        }
      }

      // 查询全局 common_config_claude
      try {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'common_config_claude'").get();
        if (row && row.value) {
          const common = JSON.parse(row.value);
          if (common.statusLine && common.statusLine.command) {
            report.ccSwitch.commonConfigHasStatusLine = true;
          }
        }
      } catch {}

      db.close();
    } else {
      // 降级尝试 sqlite3 CLI（-json 精确读取，杜绝多行 JSON 被管道解析误判损坏）
      try {
        const providers = readClaudeProvidersViaCli(ccSwitchDbPath);
        report.ccSwitch.claudeProviders = providers.length;
        for (const p of providers) {
          const { id, name } = p;
          try {
            const cfg = JSON.parse(p.settings_config || '{}');
            if (!cfg.statusLine || !cfg.statusLine.command) {
              report.ccSwitch.missingStatusLineProviders.push({ id, name, reason: '缺失 statusLine 配置' });
            } else {
              const cmd = cfg.statusLine.command;
              if (hasUnescapedBackslash(cmd) || cmd.includes('cmd.exe') || (cmd.includes('cols=$(stty') && !report.gitBash.present)) {
                report.ccSwitch.missingStatusLineProviders.push({ id, name, reason: '包含不兼容的命令语法或未转义反斜杠' });
              }
            }
          } catch {
            report.ccSwitch.missingStatusLineProviders.push({ id, name, reason: '配置损坏无法解析' });
          }
        }
      } catch {}
    }

    if (report.ccSwitch.missingStatusLineProviders.length > 0) {
      report.issuesFound.push(
        `cc-switch 中有 ${report.ccSwitch.missingStatusLineProviders.length} 个 Claude 供应商存在 statusLine 缺失或兼容性隐患，切换至这些供应商会导致 HUD 失效！`
      );
    }
  } catch (err) {
    report.issuesFound.push(`cc-switch 数据库检测异常: ${err.message}`);
  }
}

// 4. 执行自动修复
async function applyFixes() {
  // 4.1 确保 statusline.mjs 存在
  if (!report.statuslineScript.exists) {
    fs.mkdirSync(hudPluginDir, { recursive: true });
    fs.writeFileSync(statuslineMjsPath, STATUSLINE_MJS_TEMPLATE, 'utf-8');
    report.fixesApplied.push(`已自动创建/恢复状态栏入口脚本: ${statuslineMjsPath}`);
    report.statuslineScript.exists = true;
  }

  const standardStatusLine = getStandardStatusLineCommand();

  // 4.2 修复 ~/.claude/settings.json
  // P1-2: 备份永不覆盖（首轮 .bak，此后带时间戳）
  // P1-3: 仅当 statusLine 缺失或被判定异常时才写入，健康的自定义配置不覆写
  // P1-4: 文件存在但 JSON 解析失败时中止修复，绝不用空对象覆写丢弃 env 等其余配置
  try {
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsExists = fs.existsSync(settingsPath);
    const needsWrite = !settingsExists || !report.settings.hasStatusLine || !!report.settings.issue;

    if (!needsWrite) {
      report.fixesApplied.push('settings.json 的 statusLine 已健康，跳过覆写（保护现有自定义配置）');
    } else {
      let settings = {};
      let parseOk = true;
      if (settingsExists) {
        const bakPath = createBackup(settingsPath);
        report.fixesApplied.push(`已备份原始 settings.json -> ${bakPath}`);
        try {
          settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        } catch (err) {
          parseOk = false;
          const msg = `settings.json JSON 解析失败（${err.message}），已中止自动修复以免清空 env 等其余配置；请先手动修复 JSON 语法后重试。原始文件与备份均未改动（备份: ${bakPath}）`;
          report.fixesApplied.push(`[已跳过] ${msg}`);
          console.error(`\n${c.red}${c.bold}[ABORT] ${msg}${c.reset}\n`);
        }
      }
      if (parseOk) {
        settings.statusLine = standardStatusLine;
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
        report.fixesApplied.push(`已更新 ${settingsPath}，注入跨平台安全 statusLine 命令`);
        report.settings.hasStatusLine = true;
        report.settings.command = standardStatusLine.command;
        report.settings.issue = null;
      }
    }
  } catch (err) {
    report.fixesApplied.push(`修复 settings.json 失败: ${err.message}`);
  }

  // 4.3 修复 cc-switch.db
  // P1-2: 备份永不覆盖（首轮 .bak，此后带时间戳）
  // P1-3: 仅修复诊断出的问题档案，健康的自定义 statusLine 不覆写
  const problemIds = new Set(report.ccSwitch.missingStatusLineProviders.map((p) => p.id));
  if (report.ccSwitch.installed) {
    if (problemIds.size === 0 && report.ccSwitch.commonConfigHasStatusLine) {
      report.fixesApplied.push('cc-switch 中所有 Claude 供应商档案与全局配置均已健康，跳过数据库覆写');
    } else {
      try {
        // 备份数据库
        const dbBakPath = createBackup(ccSwitchDbPath);
        report.fixesApplied.push(`已备份原始 cc-switch.db -> ${dbBakPath}`);

        const DatabaseSync = await loadNodeSqlite();

        if (DatabaseSync) {
          const db = new DatabaseSync(ccSwitchDbPath);
          const providers = db.prepare("SELECT id, name, settings_config FROM providers WHERE app_type = 'claude'").all();
          let updatedCount = 0;
          const unableToFix = [];
          for (const p of providers) {
            if (!problemIds.has(p.id)) continue; // 健康档案保持原样，不覆写
            try {
              const cfg = JSON.parse(p.settings_config || '{}');
              cfg.statusLine = standardStatusLine;
              db.prepare("UPDATE providers SET settings_config = ? WHERE id = ?").run(JSON.stringify(cfg), p.id);
              updatedCount++;
            } catch {
              unableToFix.push({ id: p.id, name: p.name, reason: '配置损坏无法解析，未修复' });
            }
          }

          // 更新全局 common_config_claude（解析失败时中止写入，防止清空其余全局配置）
          let commonParseOk = true;
          try {
            const row = db.prepare("SELECT value FROM settings WHERE key = 'common_config_claude'").get();
            let common = {};
            if (row && row.value) {
              try {
                common = JSON.parse(row.value);
              } catch (err) {
                commonParseOk = false;
                console.error(`${c.yellow}[WARN]${c.reset} common_config_claude JSON 解析失败（${err.message}），已跳过覆写以防清空其余全局配置`);
              }
            }
            if (commonParseOk) {
              common.statusLine = standardStatusLine;
              db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('common_config_claude', ?)").run(JSON.stringify(common));
            }
          } catch {}

          db.close();
          report.fixesApplied.push(`已在 cc-switch.db 中固化 ${updatedCount} 个问题供应商档案及全局配置的 statusLine（健康档案保持不变）`);
          report.ccSwitch.missingStatusLineProviders = unableToFix;
        } else {
          // 降级使用 sqlite3 CLI（-json 精确读取 + stdin 安全写入，同样仅修复问题档案）
          try {
            const providers = readClaudeProvidersViaCli(ccSwitchDbPath);
            let updatedCount = 0;
            const unableToFix = [];
            for (const p of providers) {
              if (!problemIds.has(p.id)) continue;
              try {
                const cfg = JSON.parse(p.settings_config || '{}');
                cfg.statusLine = standardStatusLine;
                // 仅需转义 SQL 单引号；SQL 经 stdin 通道传输，不再受 Shell 双引号/反斜杠/$ 转义破坏
                const escapedJson = JSON.stringify(cfg).replace(/'/g, "''");
                const escapedId = String(p.id).replace(/'/g, "''");
                execSqliteViaStdin(ccSwitchDbPath, `UPDATE providers SET settings_config='${escapedJson}' WHERE id='${escapedId}';`);
                updatedCount++;
              } catch {
                unableToFix.push({ id: p.id, name: p.name, reason: '配置损坏无法解析，未修复' });
              }
            }
            report.fixesApplied.push(`通过 sqlite3 CLI stdin 安全通道修复了 ${updatedCount} 个 cc-switch 问题供应商档案的 statusLine`);
            report.ccSwitch.missingStatusLineProviders = unableToFix;
          } catch (cliErr) {
            report.fixesApplied.push(`cc-switch 自动修复降级失败: ${cliErr.message}`);
          }
        }
      } catch (err) {
        report.fixesApplied.push(`修复 cc-switch 失败: ${err.message}`);
      }
    }
  }
}

// 主执行函数
async function main() {
  await inspectCcSwitch();

  if (isFix) {
    await applyFixes();
  }

  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // 格式化终端输出
  console.log(`\n${c.bold}======================================================${c.reset}`);
  console.log(`${c.bold}       Claude HUD 环境体检报告 (Health Report)        ${c.reset}`);
  console.log(`${c.bold}======================================================${c.reset}\n`);

  // 系统环境
  console.log(`${c.bold}1. 宿主环境${c.reset}`);
  console.log(`   操作系统: ${process.platform} (${os.release()})`);
  console.log(`   Node 版本: ${process.version}`);
  if (process.platform === 'win32') {
    if (report.gitBash.present) {
      console.log(`   Git Bash : ${pass} 检测到 (${report.gitBash.path})`);
    } else {
      console.log(`   Git Bash : ${warn} 未检测到 (Claude Code 将使用 PowerShell 作为执行器)`);
    }
  }

  // 配置文件检查
  console.log(`\n${c.bold}2. 客户端配置 (~/.claude/settings.json)${c.reset}`);
  if (!report.settings.exists) {
    console.log(`   文件状态: ${fail} 文件不存在 (${settingsPath})`);
  } else if (!report.settings.hasStatusLine) {
    console.log(`   文件状态: ${fail} 存在但缺失 statusLine 字段 (导致 HUD 不亮)`);
  } else if (report.settings.issue) {
    console.log(`   文件状态: ${warn} 已配置，但存在兼容性风险: ${report.settings.issue}`);
    console.log(`   当前命令: ${c.gray}${report.settings.command}${c.reset}`);
  } else {
    console.log(`   文件状态: ${pass} statusLine 配置完好`);
    console.log(`   当前命令: ${c.green}${report.settings.command}${c.reset}`);
  }

  // 入口脚本检查
  console.log(`\n${c.bold}3. 状态栏入口脚本${c.reset}`);
  if (report.statuslineScript.exists) {
    console.log(`   脚本状态: ${pass} 已就绪 (${report.statuslineScript.path})`);
  } else {
    console.log(`   脚本状态: ${warn} 缺失 (可通过 --fix 自动创建)`);
  }

  // cc-switch 检查
  console.log(`\n${c.bold}4. cc-switch 数据库防护${c.reset}`);
  if (!report.ccSwitch.installed) {
    console.log(`   状态: ${info} 未检测到 cc-switch (独立运行环境)`);
  } else {
    const missing = report.ccSwitch.missingStatusLineProviders.length;
    if (missing === 0) {
      console.log(`   状态: ${pass} 所有 Claude 供应商档案 (${report.ccSwitch.claudeProviders} 个) 均已固化 statusLine`);
    } else {
      console.log(`   状态: ${fail} 检测到 ${missing} 个供应商存在 statusLine 缺失或隐患 (切换后会导致 HUD 失效!):`);
      for (const p of report.ccSwitch.missingStatusLineProviders) {
        console.log(`     - [${p.id}] ${p.name}${p.reason ? ` (${c.yellow}${p.reason}${c.reset})` : ''}`);
      }
    }
  }

  // 诊断总结与建议
  console.log(`\n${c.bold}------------------------------------------------------${c.reset}`);
  if (report.issuesFound.length === 0) {
    console.log(`${c.green}${c.bold}[OK] 本地环境完全健康！HUD 具备稳定激活条件。${c.reset}`);
    console.log(`若使用中转时进度条仍显示 0%，属于 API 服务端 SSE 协议问题，请运行:`);
    console.log(`  ${c.cyan}npm run probe${c.reset} 或使用本地网关 ${c.cyan}npm run proxy${c.reset}\n`);
  } else {
    console.log(`${c.red}${c.bold}发现 ${report.issuesFound.length} 个潜在问题:${c.reset}`);
    for (const issue of report.issuesFound) {
      console.log(`  ${c.yellow}*${c.reset} ${issue}`);
    }

    if (!isFix) {
      console.log(`\n${c.bold}建议执行一键自愈修复:${c.reset}`);
      console.log(`  ${c.cyan}node skills/claude-hud-doctor/scripts/doctor.mjs --fix${c.reset}\n`);
    }
  }

  // 修复执行记录
  if (report.fixesApplied.length > 0) {
    console.log(`\n${c.bold}已执行自愈修复:${c.reset}`);
    for (const fix of report.fixesApplied) {
      console.log(`  ${c.green}✔${c.reset} ${fix}`);
    }
    console.log(`\n${c.green}${c.bold}[SUCCESS] 自愈修复完成！请重新启动 Claude Code 查看效果。${c.reset}\n`);
  }
}

main().catch((err) => {
  console.error(`${fail} doctor 执行异常:`, err);
  process.exit(1);
});
