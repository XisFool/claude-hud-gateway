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
import { execSync } from 'node:child_process';

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
const ccSwitchDbPath = path.join(homeDir, '.cc-switch', 'cc-switch.db');
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
        if (cmd.includes('\\') && !cmd.includes('\\\\')) {
          report.settings.issue = 'contains_unescaped_backslashes';
          report.issuesFound.push('settings.json 中的 statusLine.command 包含未转义反斜杠，在 Git Bash 中会导致路径解析破坏');
        } else if (cmd.includes('cols=$(stty') && !report.gitBash.present) {
          report.settings.issue = 'bash_syntax_without_git_bash';
          report.issuesFound.push('statusLine.command 包含 Bash 命令语法，但系统未检测到 Git for Windows，PowerShell 执行将报语法错误');
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
    let DatabaseSync;
    try {
      const sqlite = await import('node:sqlite');
      DatabaseSync = sqlite.DatabaseSync;
    } catch {}

    if (DatabaseSync) {
      const db = new DatabaseSync(ccSwitchDbPath);
      
      // 查询所有 claude 供应商
      const providers = db.prepare("SELECT id, name, settings_config FROM providers WHERE app_type = 'claude'").all();
      report.ccSwitch.claudeProviders = providers.length;

      for (const p of providers) {
        try {
          const cfg = JSON.parse(p.settings_config || '{}');
          if (!cfg.statusLine || !cfg.statusLine.command) {
            report.ccSwitch.missingStatusLineProviders.push({ id: p.id, name: p.name });
          }
        } catch {
          report.ccSwitch.missingStatusLineProviders.push({ id: p.id, name: p.name });
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
      // 降级尝试 sqlite3 CLI
      try {
        const rowsRaw = execSync(`sqlite3 "${ccSwitchDbPath}" "SELECT id, name, settings_config FROM providers WHERE app_type='claude';"`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        const lines = rowsRaw.trim().split(/\r?\n/).filter(Boolean);
        report.ccSwitch.claudeProviders = lines.length;
        for (const line of lines) {
          const parts = line.split('|');
          const id = parts[0];
          const name = parts[1];
          const jsonStr = parts.slice(2).join('|');
          try {
            const cfg = JSON.parse(jsonStr);
            if (!cfg.statusLine || !cfg.statusLine.command) {
              report.ccSwitch.missingStatusLineProviders.push({ id, name });
            }
          } catch {
            report.ccSwitch.missingStatusLineProviders.push({ id, name });
          }
        }
      } catch {}
    }

    if (report.ccSwitch.missingStatusLineProviders.length > 0) {
      report.issuesFound.push(
        `cc-switch 中有 ${report.ccSwitch.missingStatusLineProviders.length} 个 Claude 供应商未配置 statusLine，切换至这些供应商会导致 HUD 立即丢失！`
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
  try {
    fs.mkdirSync(claudeDir, { recursive: true });
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      // 备份
      fs.copyFileSync(settingsPath, `${settingsPath}.bak`);
      report.fixesApplied.push(`已备份原始 settings.json -> ${settingsPath}.bak`);
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      } catch {}
    }

    settings.statusLine = standardStatusLine;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    report.fixesApplied.push(`已更新 ${settingsPath}，注入跨平台安全 statusLine 命令`);
    report.settings.hasStatusLine = true;
    report.settings.command = standardStatusLine.command;
    report.settings.issue = null;
  } catch (err) {
    report.fixesApplied.push(`修复 settings.json 失败: ${err.message}`);
  }

  // 4.3 修复 cc-switch.db
  if (report.ccSwitch.installed) {
    try {
      // 备份数据库
      fs.copyFileSync(ccSwitchDbPath, `${ccSwitchDbPath}.bak`);
      report.fixesApplied.push(`已备份原始 cc-switch.db -> ${ccSwitchDbPath}.bak`);

      let DatabaseSync;
      try {
        const sqlite = await import('node:sqlite');
        DatabaseSync = sqlite.DatabaseSync;
      } catch {}

      if (DatabaseSync) {
        const db = new DatabaseSync(ccSwitchDbPath);
        
        // 更新所有缺失 statusLine 的 Claude Provider
        const providers = db.prepare("SELECT id, name, settings_config FROM providers WHERE app_type = 'claude'").all();
        let updatedCount = 0;
        for (const p of providers) {
          try {
            const cfg = JSON.parse(p.settings_config || '{}');
            cfg.statusLine = standardStatusLine;
            const newJson = JSON.stringify(cfg);
            db.prepare("UPDATE providers SET settings_config = ? WHERE id = ?").run(newJson, p.id);
            updatedCount++;
          } catch {}
        }

        // 更新全局 common_config_claude
        try {
          const row = db.prepare("SELECT value FROM settings WHERE key = 'common_config_claude'").get();
          let common = {};
          if (row && row.value) {
            try { common = JSON.parse(row.value); } catch {}
          }
          common.statusLine = standardStatusLine;
          db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('common_config_claude', ?)").run(JSON.stringify(common));
        } catch {}

        db.close();
        report.fixesApplied.push(`已在 cc-switch.db 中成功固化 ${updatedCount} 个供应商档案及全局配置中的 statusLine！`);
        report.ccSwitch.missingStatusLineProviders = [];
      } else {
        // 降级使用 sqlite3 CLI
        try {
          const rowsRaw = execSync(`sqlite3 "${ccSwitchDbPath}" "SELECT id, settings_config FROM providers WHERE app_type='claude';"`, {
            encoding: 'utf-8',
          });
          const lines = rowsRaw.trim().split(/\r?\n/).filter(Boolean);
          for (const line of lines) {
            const [id, ...rest] = line.split('|');
            const cfgJson = rest.join('|');
            try {
              const cfg = JSON.parse(cfgJson);
              cfg.statusLine = standardStatusLine;
              const escaped = JSON.stringify(cfg).replace(/'/g, "''");
              execSync(`sqlite3 "${ccSwitchDbPath}" "UPDATE providers SET settings_config='${escaped}' WHERE id='${id}';"`);
            } catch {}
          }
          report.fixesApplied.push(`通过 sqlite3 CLI 批量修复了 cc-switch 供应商档案中的 statusLine`);
          report.ccSwitch.missingStatusLineProviders = [];
        } catch (cliErr) {
          report.fixesApplied.push(`cc-switch 自动修复降级失败: ${cliErr.message}`);
        }
      }
    } catch (err) {
      report.fixesApplied.push(`修复 cc-switch 失败: ${err.message}`);
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
      console.log(`   状态: ${fail} 检测到 ${missing} 个供应商缺失 statusLine (切换后会冲掉 HUD!):`);
      for (const p of report.ccSwitch.missingStatusLineProviders) {
        console.log(`     - [${p.id}] ${p.name}`);
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
