/**
 * codex-ocfree — OpenCode free models × Codex CLI: bridge, profile isolation, model switching.
 *
 * Dependency-free, Node >= 22. Entry: bin/codex-ocfree.mjs -> main().
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  BRIDGE_BASE,
  BRIDGE_PORT,
  CATALOG,
  CODEX_HOME,
  PROVIDER_KEY,
  STATE_DIR,
  bold,
  cyan,
  dim,
  ensureState,
  getModel,
  green,
  info,
  ok,
  profileConfigPath,
  readAvailability,
  readCatalog,
  setModel,
  warn,
  yellow,
} from './config.mjs';
import { ensureBridge, bridgeCtl, bridgeHealth } from './bridgectl.mjs';
import { genCatalog } from './catalog.mjs';
import { probe } from './probe.mjs';
import { init, listHomes, codexHomeFor, wrapperSnippet, rcPath, detectShell } from './profiles.mjs';
import { select } from './tui.mjs';
import { doctor } from './doctor.mjs';
import { cmdQuota, quotaBrief } from './quota.mjs';
import { helperList, helperConfigure, helperReset, helperWizard } from './helper.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();

const HELP = `
${bold('codex-ocfree')} ${dim('v' + VERSION)} — OpenCode 免费模型接入主流 Agent（协议桥三端点 + profile 隔离 + 模型切换 + helper 中控台）

${bold('安装 / 首次使用')}
  ${cyan('bash install.sh')}                     一键安装：clone + 链接命令 + setup（仓库根目录）
  ${cyan('codex-ocfree setup')}                  一键安装：写 profile + 探测可用模型 + 生成目录 + 会话隔离 + shell 集成（--no-probe 跳过探测）
  ${cyan('codex-ocfree init [profile]')}         只装会话隔离（~/.codex.d/<profile> + codex() 包装，按 \$SHELL 选 bash/zsh，--shell 可覆盖）
  ${cyan('codex-ocfree doctor')}                 体检：运行时 / 桥 / 配置 / 隔离 / shell 集成

${bold('协议桥（三协议 -> chat/completions）')}
  ${dim('端点: /v1/responses (Codex) · /v1/chat/completions (OpenAI 兼容) · /v1/messages + count_tokens (Anthropic)')}
  ${cyan('codex-ocfree up')}                     起桥（后台，pid/日志在 ~/.codex-ocfree/）
  ${cyan('codex-ocfree down|status')}            停桥 / 查状态
  ${cyan('codex-ocfree serve')}                  前台跑桥（看日志用）

${bold('多 agent 接入（helper 中控台，对标 arkcli helper）')}
  ${cyan('codex-ocfree helper')}                  交互向导（TTY；非 TTY 等价 list）
  ${cyan('codex-ocfree helper list [--json]')}    检测主流 agent：安装/配置状态/配置路径/协议
  ${cyan('codex-ocfree helper configure <a>')}    指向本地桥：codex claude-code dsh opencode（trae/zcode 打印 GUI 指引卡）
  ${cyan('codex-ocfree helper reset <a>')}        还原注入的配置（原值有备份，保留你的其它设置）

${bold('模型')}
  ${cyan('codex-ocfree models')}                 TUI 选择并设为默认模型
  ${cyan('codex-ocfree use <slug> [-p <p>]')}     直接设默认模型
  ${cyan('codex-ocfree refresh [--all]')}         重新探测可用模型 + 重建目录（--all 含不可用）
  ${cyan('codex-ocfree probe [id ...]')}          只探测可用性（写 ~/.codex-ocfree/availability.json）
  ${cyan('codex-ocfree quota [usage]')}           免费额度估计（本地统计 + ~200次/5h 参考；对话内也可问模型）

${bold('profile / 会话隔离')}
  ${cyan('codex-ocfree profile')}                 列出隔离 home 与启动方式
  ${cyan('codex-ocfree profile add <name>')}      新建一个隔离 home
  ${cyan('codex-ocfree run [-p <p>] <args>')}     起桥(按需) + 设 CODEX_HOME + 代跑 codex（脚本/CI 用）
  ${cyan('codex-ocfree shell [zsh|bash]')}        打印 codex() 包装片段（默认按 \$SHELL）

${bold('其它')}
  ${dim('环境变量: OC2C_PORT(8973) OC2C_UA OC2C_DB OC2C_CATALOG OC2C_UPSTREAM OC2C_STATE OC2C_ALL OC2C_LIMIT_5H(200)  PROBE_TIMEOUT_MS(15000) PROBE_CONCURRENCY(4)')}

用法示例:
  bash install.sh                          # 新用户一键装
  codex-ocfree setup && codex-ocfree up
  codex --profile opencode                 # 新开终端（codex() 包装自动隔离会话）
  codex-ocfree models                      # 换免费模型
`;

/* ------------------------------------------------------------------ setup -- */

const DEFAULT_MODEL_PREF = ['mimo-v2.6-flash-free', 'mimo-v2.5-free', 'big-pickle'];
function pickDefaultModel(models) {
  if (!models.length) return null;
  for (const p of DEFAULT_MODEL_PREF) {
    if (models.some((m) => m.slug === p)) return p;
  }
  return models[0].slug;
}

async function setup(profile = 'opencode', opts = {}) {
  ensureState();
  console.log(bold(`\ncodex-ocfree setup → profile "${profile}"\n`));

  // 1. ~/.codex must exist (run codex at least once)
  if (!fs.existsSync(CODEX_HOME)) {
    fs.mkdirSync(CODEX_HOME, { recursive: true });
    warn(`${CODEX_HOME} 不存在，已创建（建议先跑一次 codex 生成基础配置）`);
  }

  // 2. first run: probe which free models actually answer upstream (~10-60s),
  //    so the catalog only lists working ones; `--no-probe` skips it
  const hadAvail = !!readAvailability();
  if (!hadAvail && !opts.noProbe) {
    info('首次运行：探测上游可用模型（约 1 分钟，可用 --no-probe 跳过）…');
    await probe([]);
  } else if (!hadAvail) {
    info('未探测可用性（--no-probe）：目录将包含上游可能已下线的模型');
  }

  // 3. model catalog
  let models = readCatalog();
  if (!models.length || !hadAvail) {
    try {
      await genCatalog();
      models = readCatalog();
    } catch (e) {
      warn(`生成模型目录失败: ${e.message}`);
      info('（可稍后跑 codex-ocfree refresh 重试）');
    }
  } else {
    ok(`model catalog 已存在: ${models.length} 个模型`);
  }

  // 4. profile config
  const cfgPath = profileConfigPath(profile);
  const tplPath = path.join(ROOT, 'templates', 'opencode.config.toml.example');
  if (fs.existsSync(cfgPath)) {
    ok(`profile config 已存在，保持不动: ${cfgPath}`);
    if (!getModel(profile) && models.length) {
      setModel(profile, pickDefaultModel(models));
      ok(`补上默认 model = ${getModel(profile)}`);
    }
  } else {
    const model = getModel(profile) || pickDefaultModel(models) || 'SET_ME';
    const tpl = fs.readFileSync(tplPath, 'utf8');
    const rendered = tpl
      .replaceAll('@MODEL@', model)
      .replaceAll('@CATALOG@', CATALOG)
      .replaceAll('@PORT@', String(BRIDGE_PORT));
    fs.writeFileSync(cfgPath, rendered);
    ok(`写入 profile config: ${cfgPath}`);
    if (model === 'SET_ME') {
      warn('没有可用模型，model 未设置 — 先跑 codex-ocfree refresh 再 codex-ocfree use <slug>');
    }
  }
  if (!readCatalog().length) {
    warn(`模型目录为空，codex 会报 "Model metadata not found" — 先 codex-ocfree refresh`);
  } else if (!readAvailability()) {
    info(`尚未探测可用性（当前目录含上游可能已下线的模型）— 建议先跑 ${bold('codex-ocfree refresh')}`);
  }

  // 5. isolation
  init(profile, { quiet: true, shell: opts.shell });
  const home = codexHomeFor(profile);
  ok(`会话隔离 home: ${home}`);

  console.log(`
${bold('下一步')}
  1. ${green('source ' + rcPath() + '   # 或开新终端，让 codex() 包装生效')}
  2. ${green('codex-ocfree up')}                       # 起协议桥
  3. ${green(`codex --profile ${profile}`)}                    # 开聊（会话历史与默认 codex 隔离）
     或 ${green(`codex-ocfree run -p ${profile}`)}                 # 一条命令：起桥 + 隔离 + 启动
  4. ${green('codex-ocfree models')}                   # 换模型 / ${green('codex-ocfree doctor')} 体检
`);
  return 0;
}

/* --------------------------------------------------------------- commands -- */

async function cmdUp() {
  const h = await ensureBridge();
  if (!h) {
    console.error(`桥启动失败，看日志: ${path.join(STATE_DIR, 'bridge.log')}`);
    return 1;
  }
  console.log(`bridge up  ${green(BRIDGE_BASE)}  pid=${h.pid}  upstream=${h.upstream}`);
  return 0;
}

async function cmdStatus() {
  const h = await bridgeHealth();
  if (h) {
    console.log(`bridge up   ${BRIDGE_BASE}  pid=${h.pid}`);
    console.log(`  upstream: ${h.upstream}`);
    console.log(`  ua:       ${h.ua}`);
    console.log(`  catalog:  ${CATALOG}`);
    const models = readCatalog();
    console.log(`  models:   ${models.length}`);
  } else {
    console.log('bridge down');
  }
  const qb = quotaBrief();
  console.log(`quota:      ${qb || dim('暂无记录')}${qb ? dim('  (codex-ocfree quota 详情)') : ''}`);
  return h ? 0 : 1;
}

async function cmdRefresh(opts) {
  const profile = opts.profile || 'opencode';
  ensureState();
  if (!opts.noProbe) await probe([]);
  await genCatalog({ all: opts.all });
  const models = readCatalog();
  const cur = getModel(profile);
  if (cur && !models.some((m) => m.slug === cur) && models.length) {
    const next = pickDefaultModel(models);
    setModel(profile, next);
    warn(`当前默认模型 ${cur} 已不在目录中 → 已切换为 ${next}`);
  }
  return 0;
}

async function cmdModels(opts) {
  const profile = opts.profile || 'opencode';
  const models = readCatalog();
  if (!models.length) {
    console.error(`模型目录为空: ${CATALOG} — 先跑 codex-ocfree refresh`);
    return 1;
  }
  const cur = getModel(profile);
  const avail = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(ensureState(), 'availability.json'), 'utf8'));
    } catch {
      return null;
    }
  })();
  const items = models.map((m) => {
    const ctx = m.context_window >= 1000 ? `${Math.round(m.context_window / 1000)}k` : `${m.context_window}`;
    const marks = [
      m.slug === cur ? cyan('[current]') : '',
      avail && avail[m.slug] !== 'ok' ? yellow('[unverified]') : '',
      m.reasoning ? 'reason' : '',
    ].filter(Boolean);
    return `${m.slug.padEnd(30)} ctx=${ctx.padEnd(6)} ${marks.join(' ')}`;
  });
  const curIdx = Math.max(0, models.findIndex((m) => m.slug === cur));

  if (opts.print) {
    items.forEach((s) => console.log(s));
    return 0;
  }
  const idx = await select(`codex-ocfree models — profile "${profile}" （↑↓ 选, Enter 确认, q 取消）`, items, {
    currentIndex: curIdx,
  });
  if (idx === null) return 1;
  setModel(profile, models[idx].slug);
  ok(`model → ${models[idx].slug}  (${profileConfigPath(profile)})`);
  console.log(dim('下次启动生效（桥无需重启）'));
  return 0;
}

function cmdUse(args, opts) {
  const slug = args.find((a) => !a.startsWith('-'));
  const profile = opts.profile || 'opencode';
  if (!slug) {
    console.error('用法: codex-ocfree use <slug> [-p <profile>]');
    return 1;
  }
  const cfg = profileConfigPath(profile);
  if (!fs.existsSync(cfg)) {
    console.error(`profile config 不存在: ${cfg} — 先跑 codex-ocfree setup`);
    return 1;
  }
  const models = readCatalog();
  if (models.length && !models.some((m) => m.slug === slug)) {
    console.error(`"${slug}" 不在模型目录中。可用:\n  ` + models.map((m) => m.slug).join('\n  '));
    return 1;
  }
  setModel(profile, slug);
  ok(`model = ${slug}  (${cfg})`);
  return 0;
}

function cmdProfile(args) {
  const sub = args[0];
  if (sub === 'add') {
    const name = args[1];
    if (!name) {
      console.error('用法: codex-ocfree profile add <name>');
      return 1;
    }
    init(name);
    return 0;
  }
  if (sub && sub !== 'list') {
    console.error(`未知子命令: ${sub}（可用: list, add <name>）`);
    return 1;
  }
  const homes = listHomes();
  console.log(`\n${bold('codex profiles')}  ${dim('(会话/历史按 CODEX_HOME 隔离)')}\n`);
  console.log(`  ${cyan('(default)')}  ${dim('~/.codex')}  ${dim('← 裸 codex')}`);
  for (const h of homes) {
    const cfg = path.join(CODEX_HOME, `${h}.config.toml`);
    const model = fs.existsSync(cfg) ? getModel(h) : null;
    console.log(
      `  ${cyan(h.padEnd(10))} ${codexHomeFor(h)}  ${dim(model ? `model=${model}` : fs.existsSync(cfg) ? '' : '(no config)')}`,
    );
  }
  console.log(`
${bold('启动')}
  codex --profile <name>     ${dim('# codex() 包装自动切 CODEX_HOME（bash / zsh 均支持）')}
  codex-ocfree run -p <name> ${dim('# 起桥(按需) + 设 CODEX_HOME + 代跑 codex（脚本/CI 用这个）')}
  ${dim('新增隔离: codex-ocfree profile add <name>   （改完 rc 记得重开终端或 source）')}
`);
  return 0;
}

async function cmdHelper(rest, opts) {
  const sub = rest[0];
  const flags = rest.slice(1).filter((a) => a.startsWith('--'));
  const args = rest.slice(1).filter((a) => !a.startsWith('--'));
  const json = flags.includes('--json') || opts.print;
  if (!sub || sub === 'wizard') {
    if (process.stdout.isTTY) return await helperWizard();
    return await helperList({ json });
  }
  if (sub === 'list' || sub === 'ls') return await helperList({ json });
  if (sub === 'configure' || sub === 'config' || sub === 'add') {
    if (!args[0]) {
      console.error('用法: codex-ocfree helper configure <agent>   (agent 见 helper list)');
      return 1;
    }
    return await helperConfigure(args[0], opts);
  }
  if (sub === 'reset' || sub === 'remove') {
    if (!args[0]) {
      console.error('用法: codex-ocfree helper reset <agent>');
      return 1;
    }
    return await helperReset(args[0], opts);
  }
  console.error(`未知子命令: ${sub}（可用: list, configure <agent>, reset <agent>）`);
  return 1;
}

async function cmdRun(args, profile = null) {
  // the global parser consumed the profile flag; hand it back to codex so the
  // $CODEX_HOME/<name>.config.toml layer is actually applied
  const rest = profile ? ['-p', profile, ...args] : [...args];
  const bridgeNeeded = profile === 'opencode';

  if (bridgeNeeded) {
    const h = await ensureBridge({ quiet: false });
    if (!h) {
      console.error(`桥启动失败，看日志: ${path.join(STATE_DIR, 'bridge.log')}`);
      return 1;
    }
  }

  const env = { ...process.env };
  if (profile && fs.existsSync(codexHomeFor(profile))) {
    env.CODEX_HOME = codexHomeFor(profile);
    console.log(dim(`CODEX_HOME=${env.CODEX_HOME}`));
  }

  return await new Promise((resolve) => {
    const child = spawn('codex', rest, { stdio: 'inherit', env });
    const noop = () => {};
    process.on('SIGINT', noop);
    process.on('SIGTERM', noop);
    child.on('error', (e) => {
      console.error(`codex 启动失败: ${e.message}`);
      resolve(1);
    });
    child.on('exit', (code, sig) => {
      process.removeListener('SIGINT', noop);
      process.removeListener('SIGTERM', noop);
      resolve(sig ? 1 : (code ?? 0));
    });
  });
}

/* ---------------------------------------------------------------- dispatch -- */

export async function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];

  // global-ish flags
  const opts = { profile: null, print: false, all: false, noProbe: false, shell: null };
  const rest = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-p' || a === '--profile') opts.profile = argv[++i] ?? null;
    else if (a.startsWith('--profile=')) opts.profile = a.slice(10);
    else if (a === '--print') opts.print = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--no-probe') opts.noProbe = true;
    else if (a === '--shell') opts.shell = argv[++i] ?? null;
    else rest.push(a);
  }

  switch (cmd) {
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(HELP);
      return 0;
    case '-v':
    case '--version':
    case 'version':
      console.log(VERSION);
      return 0;
    case 'setup':
      return await setup(rest[0] || opts.profile || 'opencode', opts);
    case 'init':
      init(rest[0] || opts.profile || 'opencode', { shell: opts.shell });
      return 0;
    case 'up':
    case 'start':
      return await cmdUp();
    case 'down':
    case 'stop':
      return await bridgeCtl('stop');
    case 'serve':
      return await bridgeCtl('serve');
    case 'status':
      return await cmdStatus();
    case 'quota':
    case 'usage':
      return cmdQuota();
    case 'refresh':
      return await cmdRefresh(opts);
    case 'probe':
      ensureState();
      await probe(rest);
      return 0;
    case 'catalog':
      ensureState();
      await genCatalog({ all: opts.all });
      return 0;
    case 'models':
      return await cmdModels({ ...opts, profile: opts.profile || rest[0] });
    case 'use':
      return cmdUse(rest, opts);
    case 'profile':
      return cmdProfile(rest);
    case 'helper':
      return await cmdHelper(rest, opts);
    case 'run':
      return await cmdRun(rest, opts.profile);
    case 'shell': {
      const sh = rest[0] || opts.shell || detectShell();
      if (sh !== 'zsh' && sh !== 'bash') {
        console.error(`不支持的 shell: ${sh}（支持 zsh / bash）`);
        return 1;
      }
      console.log(wrapperSnippet(sh));
      return 0;
    }
    case 'doctor':
      return await doctor();
    default:
      console.error(`未知命令: ${cmd}\n`);
      console.log(HELP);
      return 2;
  }
}
