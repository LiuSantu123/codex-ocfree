/**
 * `codex-ocfree doctor` — environment / config health checks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  BRIDGE_BASE,
  BRIDGE_PORT,
  CATALOG,
  CODEX_HOME,
  OPEND_DB,
  PROVIDER_KEY,
  STATE_DIR,
  bold,
  dim,
  fail,
  getModel,
  green,
  info,
  ok,
  readCatalog,
  readAvailability,
  red,
  warn,
} from './config.mjs';
import { bridgeHealth } from './bridgectl.mjs';
import { checkHome, listHomes, wrapperInstalled } from './profiles.mjs';

const profile = process.env.OCSW_PROFILE || 'opencode';

function binVersion(bin, arg = '--version') {
  try {
    const r = spawnSync(bin, [arg], { encoding: 'utf8', timeout: 5000 });
    const out = (r.stdout || r.stderr || '').trim().split('\n')[0];
    return r.status === 0 || out ? out : null;
  } catch {
    return null;
  }
}

export async function doctor() {
  let bad = 0;
  let good = 0;
  let notes = 0;
  const head = (t) => console.log(`\n${bold(t)}`);

  head('runtime');
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 22) {
    ok(`node ${process.versions.node}`);
    good++;
  } else {
    fail(`node ${process.versions.node} — 需要 >= 22（node:sqlite / fetch）`);
    bad++;
  }
  const codexV = binVersion('codex');
  if (codexV) {
    ok(`codex  ${codexV}`);
    good++;
  } else {
    fail('codex 不在 PATH 里');
    bad++;
  }

  head('upstream data');
  if (fs.existsSync(OPEND_DB)) {
    ok(`opencode.db  ${dim(OPEND_DB)}`);
    good++;
  } else {
    info(`opencode.db 缺失 — 目录会走 models.dev 在线回退（无需安装 opencode）`);
  }
  const models = readCatalog();
  if (models.length) {
    ok(`model catalog: ${models.length} 个模型 -> ${CATALOG}`);
    good++;
  } else {
    fail(`model catalog 空/缺失: ${CATALOG} — 跑 ${dim('codex-ocfree refresh')}`);
    bad++;
  }
  const avail = readAvailability();
  if (avail) {
    const n = Object.values(avail).filter((v) => v === 'ok').length;
    info(`上次探测: ${n}/${Object.keys(avail).length} ok (${dim(path.join(STATE_DIR, 'availability.json'))})`);
  } else {
    info(`未探测过可用性 — ${dim('codex-ocfree probe')}（只列真正可用的模型）`);
  }

  head(`profile: ${profile}`);
  const cfgPath = path.join(CODEX_HOME, `${profile}.config.toml`);
  if (fs.existsSync(cfgPath)) {
    ok(`profile config  ${dim(cfgPath)}`);
    good++;
  } else {
    fail(`profile config 缺失: ${cfgPath} — 跑 ${dim('codex-ocfree setup')}`);
    bad++;
  }
  const model = getModel(profile);
  if (model) {
    if (!models.length || models.some((m) => m.slug === model)) {
      ok(`default model = ${model}`);
      good++;
    } else {
      fail(`default model "${model}" 不在 catalog 里 — ${dim(`codex-ocfree use <slug>`)} 或 ${dim('codex-ocfree refresh')}`);
      bad++;
    }
  } else if (fs.existsSync(cfgPath)) {
    warn(`profile 没写 model = — codex 会回退到基础配置的 model`);
    bad++;
  }
  if (fs.existsSync(cfgPath)) {
    const txt = fs.readFileSync(cfgPath, 'utf8');
    const hasProvider = txt.includes(`[model_providers.${PROVIDER_KEY}]`) || txt.includes('[model_providers.opencode-free-codex]');
    if (hasProvider && /wire_api\s*=\s*"responses"/.test(txt) && txt.includes(`127.0.0.1:${BRIDGE_PORT}`)) {
      ok(`provider 指向本地桥 :${BRIDGE_PORT} (wire_api=responses)`);
      good++;
    } else if (hasProvider) {
      warn(`provider 配置异常: 检查 base_url(应含 127.0.0.1:${BRIDGE_PORT}) 与 wire_api="responses"`);
      bad++;
    } else {
      fail(`profile 里没有 [model_providers.${PROVIDER_KEY}] — 重跑 ${dim('codex-ocfree setup')}（不会覆盖已有文件时请手动合并）`);
      bad++;
    }
  }

  head('bridge');
  const health = await bridgeHealth();
  if (health) {
    ok(`up  ${BRIDGE_BASE}  pid=${health.pid}  -> ${health.upstream}`);
    good++;
  } else {
    warn(`down — ${dim('codex-ocfree up')}（按需启动，不算故障）`);
    notes++;
    // port busy by someone else?
    try {
      const r = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/`, { signal: AbortSignal.timeout(800) });
      info(`端口 ${BRIDGE_PORT} 有进程在听但不是 codex-ocfree 桥（status=${r.status}）`);
    } catch {
      /* nothing listening */
    }
  }

  head('session isolation (CODEX_HOME)');
  const homes = listHomes();
  if (homes.length) {
    for (const h of homes) {
      const c = checkHome(h);
      const broken = c.links.filter((l) => l.state === 'warn');
      if (broken.length) warn(`${h}: ${broken.map((b) => `${b.name} -> ${b.target}`).join(', ')}`);
      else ok(`~/.codex.d/${h}/  (${c.links.filter((l) => l.state === 'ok').length} 个共享链接正常)`);
      if (broken.length) bad++;
      else good++;
    }
  } else {
    info(`没有隔离 home — 跑 ${dim('codex-ocfree init <profile>')}`);
  }
  if (process.env.CODEX_HOME) {
    info(`当前 shell 有 CODEX_HOME=${process.env.CODEX_HOME}（手动设的，优先级最高）`);
  }
  const wrap = wrapperInstalled();
  if (wrap.managed) {
    ok(`${wrap.file} 已装 codex-ocfree codex() 包装（新终端生效）`);
    good++;
  } else if (wrap.anyCodexFn) {
    warn(`${wrap.file} 有非 codex-ocfree 管理的 codex() 函数（可用，但不由 codex-ocfree 维护）`);
    notes++;
  } else {
    warn(`bash/zsh rc 都没有 codex() 包装 — \`codex --profile X\` 不会自动隔离，跑 \`codex-ocfree init\`（或用 \`run\`）`);
    bad++;
  }

  console.log('');
  if (bad === 0 && notes === 0) console.log(green('all good ✅'));
  else if (bad === 0) console.log(`${green('基本正常')}  ${dim(`（${good} 项正常，${notes} 项提醒）`)}`);
  else console.log(`${red(`${bad} 项需要处理`)}  ${dim(`（${good} 项正常，${notes} 项提醒）`)}`);
  return bad === 0 ? 0 : 1;
}
