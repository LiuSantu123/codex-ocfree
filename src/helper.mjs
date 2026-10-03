/**
 * `ocfree helper` — multi-agent console (styled after `arkcli helper`).
 *
 *   helper                     interactive wizard (TTY)
 *   helper list [--json]       installed / configured / path per agent
 *   helper configure <agent>   point the agent at the local bridge
 *   helper reset <agent>       remove what we injected, keep everything else
 *
 * Configure support (v0.3.0; traework-cn since v0.3.1):
 *   codex        ~/.codex/<profile>.config.toml + isolation home  (full)
 *   claude-code  ~/.claude/settings.json env keys                 (full, surgical)
 *   dsh          ~/.dsh/cordis.patch.yml loader patch array       (full, marker'd)
 *   opencode     ~/.config/opencode/opencode.json provider.ocfree (full)
 *   trae         GUI-only config (encrypted state.vscdb)          (guide card)
 *   traework-cn  TraeCode CLI ~/.trae/trae_cli.yaml models[]       (full, merged)
 *   zcode        GUI-managed, version-drifting schema             (guide card)
 *   others       detect-only
 *
 * Every destructive configure first snapshots the target file into
 * ~/.codex-ocfree/backups/ and records prior values in helper-state.json so
 * `helper reset` restores exactly what we touched and nothing else.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOME,
  CODEX_HOME,
  CATALOG,
  BRIDGE_BASE,
  BRIDGE_PORT,
  ensureState,
  getModel,
  profileConfigPath,
  readCatalog,
  bold,
  cyan,
  dim,
  green,
  yellow,
  red,
  ok,
  warn,
  fail,
  info,
} from './config.mjs';
import { initHome, installWrapper, codexHomeFor } from './profiles.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_PREF = ['mimo-v2.6-flash-free', 'mimo-v2.5-free', 'big-pickle'];

const DSH_HOME = path.join(HOME, '.dsh');
const DSH_PATCH = path.join(DSH_HOME, 'cordis.patch.yml'); // dsh 0.2.0-rc.2: top-level YAML array (verified)
const DSH_ENV = path.join(DSH_HOME, '.env'); // apiKeyEnv credential chain (verified)
const CLAUDE_SETTINGS = path.join(HOME, '.claude', 'settings.json');
const OPENCODE_CFG = path.join(HOME, '.config', 'opencode', 'opencode.json');
const TRAE_DIR = path.join(HOME, '.trae');
const ZCODE_V2 = path.join(HOME, '.zcode', 'v2', 'config.json');

const DSH_MARK_B = '# >>> codex-ocfree: ocfree provider >>>';
const DSH_MARK_E = '# <<< codex-ocfree: ocfree provider <<<';
const OC_KEY = 'ocfree-local'; // dummy credential — the bridge never checks auth

/* TraeCode CLI (traework CN) — verified empirically on trae-cli v0.120.52:
 *   - canonical global config: ~/.trae/trae_cli.yaml; the CLI auto-migrates the
 *     legacy 1.0 path (XDG/AppSupport) into it and leaves a compat symlink.
 *   - models:[] entries: {name, open_ai:{base_url,api_key,model}} and/or
 *     {claude:{base_url,model,api_key}} (docs.trae.cn/cli_model schema;
 *     acceptance checked with `trae-cli models --json` + `trae-cli doctor`).
 *   - dispatch requires a logged-in TRAE account (their entitlement gate) —
 *     helper only writes the model entries, login stays with the user.       */
const TRAE_CLI_YAML = path.join(TRAE_DIR, 'trae_cli.yaml'); // canonical (v0.120+)
const TRAE_OUR_NAMES = [OC_KEY, `${OC_KEY}-claude`];

/* ----------------------------------------------------------------- utils -- */

function hasCmd(cmd) {
  for (const dir of String(process.env.PATH || '').split(':')) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, cmd), fs.constants.X_OK);
      return true;
    } catch { /* keep looking */ }
  }
  return false;
}

function readJson(f) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

function backup(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const dir = path.join(ensureState(), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const dst = path.join(dir, `${path.basename(file)}.${Date.now()}.bak`);
    fs.copyFileSync(file, dst);
    return dst;
  } catch {
    return null;
  }
}

function hStatePath() {
  return path.join(ensureState(), 'helper-state.json');
}
function readHState() {
  return readJson(hStatePath()) || {};
}
function writeHState(s) {
  fs.writeFileSync(hStatePath(), JSON.stringify(s, null, 2) + '\n');
}

/** current default free model (profile opencode -> catalog preference) */
export function currentModel() {
  const cur = getModel('opencode');
  if (cur) return cur;
  const cat = readCatalog();
  for (const p of MODEL_PREF) if (cat.some((m) => m.slug === p)) return p;
  return cat[0] ? cat[0].slug : null;
}

function modelContext(model) {
  const m = readCatalog().find((x) => x.slug === model);
  return m && m.context_window > 0 ? Math.round(m.context_window) : 131072;
}

/* --------------------------------------------------------------- codex ----- */

function configureCodex(opts = {}) {
  const profile = opts.profile || 'opencode';
  ensureState();
  if (!fs.existsSync(CODEX_HOME)) fs.mkdirSync(CODEX_HOME, { recursive: true });
  const steps = [];
  const notes = [];
  const cfgPath = profileConfigPath(profile);

  if (!fs.existsSync(cfgPath)) {
    const model = currentModel();
    if (!model) {
      return { ok: false, steps, notes: ['模型目录为空 — 先跑 codex-ocfree refresh 再 configure'] };
    }
    const tplPath = path.join(ROOT, 'templates', 'opencode.config.toml.example');
    if (!fs.existsSync(tplPath)) return { ok: false, steps, notes: [`模板缺失: ${tplPath}`] };
    const tpl = fs.readFileSync(tplPath, 'utf8');
    fs.writeFileSync(
      cfgPath,
      tpl.replaceAll('@MODEL@', model).replaceAll('@CATALOG@', CATALOG).replaceAll('@PORT@', String(BRIDGE_PORT)),
    );
    steps.push(`写入 profile config: ${cfgPath} (model=${model})`);
  } else {
    steps.push(`profile config 已存在: ${cfgPath}`);
  }

  const { home, results } = initHome(profile);
  const bad = results.filter((r) => r.state === 'fail');
  steps.push(`会话隔离 home: ${home} (${results.filter((r) => r.state === 'ok').length}/${results.length} 链接)`);
  const wrap = installWrapper({});
  const warns = [];
  steps.push(`shell wrapper (${wrap.state}): ${wrap.rc || '-'}`);
  if (wrap.state === 'installed') notes.push(`source ${wrap.rc} 或开新终端让 codex() 包装生效`);
  if (wrap.state === 'unmanaged') warns.push(`检测到 ${wrap.rc} 有自己的 codex() 函数 — 未注入`);
  if (bad.length) return { ok: false, steps, notes: bad.map((b) => `${b.name}: ${b.detail}`), warns };
  notes.push(`启动: codex --profile ${profile}`);
  return { ok: true, steps, notes, warns };
}

function resetCodex(opts = {}) {
  const profile = opts.profile || 'opencode';
  const cfg = profileConfigPath(profile);
  const steps = [];
  if (!fs.existsSync(cfg)) return { ok: true, steps: [`未配置，无需 reset (${cfg})`] };
  const b = backup(cfg);
  fs.unlinkSync(cfg);
  steps.push(`已移除并备份: ${cfg} -> ${b}`);
  steps.push(`隔离 home 保留: ${codexHomeFor(profile)}（如需删除自行 rm -rf；shell wrapper 保留）`);
  return { ok: true, steps };
}

/* ---------------------------------------------------------- claude code ---- */

function configureClaude(opts = {}) {
  const model = currentModel();
  if (!model) return { ok: false, steps: [], notes: ['模型目录为空 — 先跑 codex-ocfree refresh'] };
  const existed = fs.existsSync(CLAUDE_SETTINGS);
  const cur = (existed && readJson(CLAUDE_SETTINGS)) || {};
  const env = { ...(cur.env && typeof cur.env === 'object' ? cur.env : {}) };
  // idempotency guard: already ours (and we have the prior values recorded)
  if (env.ANTHROPIC_BASE_URL === BRIDGE_BASE && readHState()['claude-code']) {
    return { ok: true, steps: ['已配置，保持不动（settings.json 已指向本地桥）'], notes: [] };
  }
  const prevEnv = {
    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_MODEL: env.ANTHROPIC_MODEL,
  };
  const b = backup(CLAUDE_SETTINGS);

  env.ANTHROPIC_BASE_URL = BRIDGE_BASE;
  env.ANTHROPIC_AUTH_TOKEN = OC_KEY;
  env.ANTHROPIC_MODEL = model;
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify({ ...cur, env }, null, 2) + '\n');

  const st = readHState();
  st['claude-code'] = { at: Date.now(), backup: b, prevEnv, existed, file: CLAUDE_SETTINGS };
  writeHState(st);

  return {
    ok: true,
    steps: [
      `env.ANTHROPIC_BASE_URL = ${BRIDGE_BASE}`,
      `env.ANTHROPIC_AUTH_TOKEN = ${OC_KEY}`,
      `env.ANTHROPIC_MODEL = ${model}`,
      ...(b ? [`原文件备份: ${b}`] : [`新建: ${CLAUDE_SETTINGS}`]),
    ],
    notes: [
      '重启 Claude Code 生效（env 只在启动时读取）',
      '原配置已逐键记录 — codex-ocfree helper reset claude-code 可还原',
    ],
  };
}

function resetClaude() {
  const cur = fs.existsSync(CLAUDE_SETTINGS) ? readJson(CLAUDE_SETTINGS) : null;
  const steps = [];
  const s0 = readHState();
  const st = s0['claude-code'];
  if (!cur || !cur.env) {
    if (st) {
      delete s0['claude-code'];
      writeHState(s0);
    }
    return { ok: true, steps: ['settings.json 不存在或无 env — 无需还原'] };
  }
  const base = cur.env.ANTHROPIC_BASE_URL;
  const ours = base === BRIDGE_BASE;
  if (!ours && !(st && st.prevEnv && base === st.prevEnv.ANTHROPIC_BASE_URL)) {
    return { ok: true, steps: [`当前 ANTHROPIC_BASE_URL=${base || '(未设置)'} 不指向 ocfree 桥 — 未改动`] };
  }
  const prev = (st && st.prevEnv) || {};
  for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL']) {
    if (prev[k] === undefined) delete cur.env[k];
    else cur.env[k] = prev[k];
  }
  if (st && !st.existed && Object.keys(cur.env).length === 0) {
    fs.unlinkSync(CLAUDE_SETTINGS);
    steps.push(`文件由 ocfree 创建，已删除: ${CLAUDE_SETTINGS}`);
  } else {
    fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(cur, null, 2) + '\n');
    steps.push(`已还原 env 三键: ${CLAUDE_SETTINGS}`);
  }
  if (st && st.backup) steps.push(`历史备份: ${st.backup}`);
  const s = readHState();
  delete s['claude-code'];
  writeHState(s);
  return { ok: true, steps };
}

/* ------------------------------------------------------------------ dsh ---- *
 * dsh (verified empirically on @deepseek-ai/dsh 0.2.0-rc.2):
 *   - $DSH_HOME/cordis.patch.yml is read at profile boot and MUST be a
 *     top-level YAML ARRAY of loader patch entries; $DSH_HOME/settings.yaml
 *     is NOT read by the boot path (probe: invalid settings.yaml ignored,
 *     wrong-shaped cordis.patch.yml rejected with a clear parse error).
 *   - apiKeyEnv resolves from $DSH_HOME/.env (probe: works with no export;
 *     without any credential pi-ai fails with "No API key for provider").
 */

const DSH_RE_LLM = /^- id: llm-pi-ai[ \t]*(#.*)?$/m;
const DSH_RE_DEF = /^- id: agent-default-model[ \t]*(#.*)?$/m;

function readText(f) {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
}

/** injection pieces for cordis.patch.yml (array entries) */
function dshPieces(model) {
  const ctx = modelContext(model);
  const subtree = [
    'ocfree:',
    '  displayName: OpenCode Free (ocfree)',
    '  apiKeyEnv: OCFREE_API_KEY',
    '  api: openai-completions',
    `  baseURL: ${BRIDGE_BASE}/v1`,
    '  models:',
    `    - id: ${model}`,
    `      name: ${model}`,
    `      contextWindow: ${ctx}`,
    '      maxTokens: 32768',
  ];
  const llmEntry = [
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    ...subtree.map((l) => '      ' + l),
  ];
  const defEntry = [
    '- id: agent-default-model',
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    '  config:',
    '    provider: ocfree',
    `    model: ${model}`,
  ];
  return { subtree, llmEntry, defEntry };
}

/** insert the ocfree subtree under an existing `- id: llm-pi-ai` entry (marker'd) */
function dshInsertOcfree(text, subtree) {
  const lines = text.split('\n');
  const llmIdx = lines.findIndex((l) => /^- id: llm-pi-ai[ \t]*(#.*)?$/.test(l));
  if (llmIdx < 0) return null;
  let end = lines.length;
  for (let i = llmIdx + 1; i < lines.length; i++) {
    if (/^- /.test(lines[i])) { end = i; break; } // next array element
  }
  let provIdx = -1;
  for (let i = llmIdx + 1; i < end; i++) {
    if (/^ +providers:[ \t]*(#.*)?$/.test(lines[i])) { provIdx = i; break; }
  }
  let insertAt, indent;
  if (provIdx >= 0) {
    insertAt = provIdx + 1;
    indent = lines[provIdx].match(/^ */)[0].length + 2;
  } else {
    let cfgIdx = -1;
    for (let i = llmIdx + 1; i < end; i++) {
      if (/^ +config:[ \t]*(#.*)?$/.test(lines[i])) { cfgIdx = i; break; }
    }
    if (cfgIdx < 0) return null;
    indent = lines[cfgIdx].match(/^ */)[0].length + 2;
    lines.splice(cfgIdx + 1, 0, ' '.repeat(indent) + 'providers:');
    insertAt = cfgIdx + 2;
    indent += 2;
  }
  lines.splice(insertAt, 0, DSH_MARK_B, ...subtree.map((l) => ' '.repeat(indent) + l), DSH_MARK_E);
  return lines.join('\n');
}

function configureDsh() {
  const model = currentModel();
  if (!model) return { ok: false, steps: [], notes: ['模型目录为空 — 先跑 codex-ocfree refresh'] };
  fs.mkdirSync(DSH_HOME, { recursive: true });
  const orig = readText(DSH_PATCH);
  const { subtree, llmEntry, defEntry } = dshPieces(model);
  const haveDefault = DSH_RE_DEF.test(orig);
  const steps = [];
  let bk = null;
  let out;

  if (orig.includes('ocfree:') && orig.includes(BRIDGE_BASE)) {
    return { ok: true, steps: ['已配置，保持不动（cordis.patch.yml 已含 ocfree provider）'], notes: [] };
  }
  const trimmed = orig.trim();
  const emptyish =
    !trimmed ||
    trimmed === '[]' ||
    trimmed === '{}' ||
    trimmed.split('\n').every((l) => !l.trim() || l.trim().startsWith('#'));
  if (emptyish) {
    bk = backup(DSH_PATCH);
    out = [DSH_MARK_B, ...llmEntry, ...(haveDefault ? [] : defEntry), DSH_MARK_E].join('\n') + '\n';
    steps.push(`写入 cordis.patch.yml${bk ? `（原文件备份: ${bk}）` : ''}`);
  } else if (!DSH_RE_LLM.test(orig)) {
    bk = backup(DSH_PATCH);
    out = orig.replace(/\s*$/, '\n') + [DSH_MARK_B, ...llmEntry, ...(haveDefault ? [] : defEntry), DSH_MARK_E].join('\n') + '\n';
    steps.push(`追加 llm-pi-ai patch 条目${bk ? `（备份: ${bk}）` : ''}`);
  } else {
    bk = backup(DSH_PATCH);
    const merged = dshInsertOcfree(orig, subtree);
    if (merged == null) {
      return { ok: false, steps: [], notes: ['无法定位 llm-pi-ai entry 的 config/providers — 请手动编辑 ' + DSH_PATCH] };
    }
    out = merged;
    steps.push(`在 llm-pi-ai entry 下插入 ocfree${bk ? `（备份: ${bk}）` : ''}`);
    if (!haveDefault) {
      out = out.replace(/\s*$/, '\n') + [DSH_MARK_B, ...defEntry, DSH_MARK_E].join('\n') + '\n';
      steps.push('同时设置 agent-default-model -> ocfree');
    }
  }
  fs.writeFileSync(DSH_PATCH, out);

  // credential: apiKeyEnv resolves from $DSH_HOME/.env (verified empirically)
  let envTxt = readText(DSH_ENV);
  if (!/^OCFREE_API_KEY=/m.test(envTxt)) {
    envTxt = envTxt.replace(/\s*$/, '\n') + 'OCFREE_API_KEY=' + OC_KEY + '\n';
    fs.writeFileSync(DSH_ENV, envTxt);
    steps.push(`写入凭据 OCFREE_API_KEY 到 ${DSH_ENV}`);
  }

  const st = readHState();
  st.dsh = { at: Date.now(), file: DSH_PATCH, backup: bk, wroteEnv: true };
  writeHState(st);

  return {
    ok: true,
    steps,
    notes: [
      '重启 dsh 生效（cordis.patch.yml 在启动时读取）',
      `已设 agent-default-model -> ocfree/${model}，headless/CLI 默认即走免费桥`,
      `凭据从 ${DSH_ENV} 解析，无需 export`,
    ],
  };
}

function resetDsh() {
  const steps = [];
  const s0 = readHState();
  const st = s0.dsh;
  let txt = readText(DSH_PATCH);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (txt.includes(DSH_MARK_B) && txt.includes(DSH_MARK_E)) {
    const re = () => new RegExp('[^\\n]*' + esc(DSH_MARK_B) + '[\\s\\S]*?' + esc(DSH_MARK_E) + '[^\\n]*\\n?', '');
    let guard = 0;
    while (txt.includes(DSH_MARK_B) && txt.includes(DSH_MARK_E) && guard++ < 10) txt = txt.replace(re(), '');
    const bare = txt.replace(/#[^\n]*\n/g, '').replace(/\s+/g, '');
    if (!bare) {
      const orig = st && st.backup && fs.existsSync(st.backup) ? fs.readFileSync(st.backup, 'utf8') : '';
      if (orig) {
        fs.writeFileSync(DSH_PATCH, orig);
        steps.push(`已还原原 cordis.patch.yml（备份: ${st.backup}）`);
      } else {
        fs.unlinkSync(DSH_PATCH);
        steps.push(`原文件为空/不存在，已删除: ${DSH_PATCH}`);
      }
    } else {
      fs.writeFileSync(DSH_PATCH, txt);
      steps.push(`已移除 ocfree 注入段: ${DSH_PATCH}`);
    }
  } else {
    steps.push(`cordis.patch.yml 无 ocfree 注入段 — 未改动`);
  }
  if (fs.existsSync(DSH_ENV)) {
    const e0 = readText(DSH_ENV);
    const e1 = e0.replace(/^OCFREE_API_KEY=[^\n]*\n?/m, '');
    if (e1 !== e0) {
      if (e1.trim()) fs.writeFileSync(DSH_ENV, e1);
      else fs.unlinkSync(DSH_ENV);
      steps.push(`已移除 ${DSH_ENV} 中的 OCFREE_API_KEY`);
    }
  }
  delete s0.dsh;
  writeHState(s0);
  return { ok: true, steps };
}

/* -------------------------------------------------------------- opencode --- */

function configureOpencode() {
  const model = currentModel();
  if (!model) return { ok: false, steps: [], notes: ['模型目录为空 — 先跑 codex-ocfree refresh'] };
  if (!fs.existsSync(path.dirname(OPENCODE_CFG))) {
    return { ok: false, steps: [], notes: [`未检测到 opencode 配置目录: ${path.dirname(OPENCODE_CFG)}`] };
  }
  const cur = readJson(OPENCODE_CFG);
  if (cur === null && fs.existsSync(OPENCODE_CFG)) {
    return { ok: false, steps: [], notes: [`${OPENCODE_CFG} 不是合法 JSON（jsonc？）— 请手动加 provider，见 helper guide opencode`] };
  }
  const base = (cur && cur.provider && cur.provider.ocfree && cur.provider.ocfree.options && cur.provider.ocfree.options.baseURL) || '';
  if (base === `${BRIDGE_BASE}/v1`) {
    return { ok: true, steps: ['已配置，保持不动（provider.ocfree 已指向本地桥）'], notes: [] };
  }
  const b = backup(OPENCODE_CFG);
  const out = { ...(cur || { $schema: 'https://opencode.ai/config.json' }) };
  out.provider = { ...(out.provider || {}) };
  out.provider.ocfree = {
    npm: '@ai-sdk/openai-compatible',
    name: 'OpenCode Free',
    options: { baseURL: `${BRIDGE_BASE}/v1`, apiKey: OC_KEY },
    models: { [model]: { name: model } },
  };
  fs.mkdirSync(path.dirname(OPENCODE_CFG), { recursive: true });
  fs.writeFileSync(OPENCODE_CFG, JSON.stringify(out, null, 2) + '\n');
  const st = readHState();
  st.opencode = { at: Date.now(), backup: b, file: OPENCODE_CFG };
  writeHState(st);
  return {
    ok: true,
    steps: [`provider.ocfree -> ${BRIDGE_BASE}/v1 (model ${model})`, ...(b ? [`原文件备份: ${b}`] : [])],
    notes: [
      '你的默认模型未改动 — 在 TUI 用 /models 选 ocfree/' + model + '，或 opencode run -m ocfree/' + model,
      'reset 只删除 provider.ocfree 键',
    ],
  };
}

function resetOpencode() {
  const steps = [];
  if (!fs.existsSync(OPENCODE_CFG)) return { ok: true, steps: ['配置文件不存在 — 无需还原'] };
  const cur = readJson(OPENCODE_CFG);
  if (!cur || !cur.provider || !cur.provider.ocfree) return { ok: true, steps: ['无 provider.ocfree — 未改动'] };
  const base = (cur.provider.ocfree.options && cur.provider.ocfree.options.baseURL) || '';
  if (base && base !== `${BRIDGE_BASE}/v1`) return { ok: true, steps: [`provider.ocfree 指向 ${base}（非 ocfree 桥）— 未改动`] };
  const b = backup(OPENCODE_CFG);
  delete cur.provider.ocfree;
  fs.writeFileSync(OPENCODE_CFG, JSON.stringify(cur, null, 2) + '\n');
  steps.push(`已删除 provider.ocfree${b ? `（备份: ${b}）` : ''}`);
  const s = readHState();
  delete s.opencode;
  writeHState(s);
  return { ok: true, steps };
}

/* ------------------------------------------------------- traework CN (traecli) */

function traeCliLegacyYaml() {
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'Application Support', 'trae_cli', 'trae_cli.yaml');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'trae_cli', 'trae_cli.yaml');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'trae_cli', 'trae_cli.yaml');
}

/** prefer the canonical file; only a real (non-symlink) legacy file counts as live */
function traeCliTarget() {
  const legacy = traeCliLegacyYaml();
  try {
    if (fs.existsSync(legacy) && !fs.lstatSync(legacy).isSymbolicLink() && !fs.existsSync(TRAE_CLI_YAML)) return legacy;
  } catch { /* fall through */ }
  return TRAE_CLI_YAML;
}

function traeCliBlock(model) {
  return [
    `- name: ${OC_KEY}`,
    '  open_ai:',
    `    base_url: ${BRIDGE_BASE}/v1`,
    `    api_key: ${OC_KEY}`,
    `    model: ${model}`,
    `- name: ${OC_KEY}-claude`,
    '  claude:',
    `    base_url: ${BRIDGE_BASE}`,
    `    model: ${model}`,
    `    api_key: ${OC_KEY}`,
  ];
}

function traeEntryName(line) {
  const m = String(line).match(/^\s*-\s+name:\s*(.*?)\s*$/);
  if (!m) return null;
  return m[1].replace(/^["'](.*)["']$/, '$1');
}

function traeHasOurEntries(text) {
  return TRAE_OUR_NAMES.every((n) => new RegExp(`^\\s*-\\s+name:\\s*["']?${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*$`, 'm').test(text))
    && text.includes(BRIDGE_BASE);
}

function traeHasAnyOurEntry(text) {
  return text.split('\n').some((l) => {
    const n = traeEntryName(l);
    return n !== null && TRAE_OUR_NAMES.includes(n);
  });
}

/** insert the ocfree entries under a top-level `models:` key (create the key if absent) */
function traeInsertModels(text, block) {
  const lines = text.split('\n');
  let mi = lines.findIndex((l) => /^models:[ \t]*(#.*)?$/.test(l));
  if (mi < 0) {
    // `models: []` flow style → rewrite as a block list
    mi = lines.findIndex((l) => /^models:\s*\[\s*\]\s*$/.test(l));
    if (mi >= 0) {
      lines[mi] = 'models:';
      lines.splice(mi + 1, 0, ...block.map((l) => '  ' + l));
      return lines.join('\n');
    }
    const t = text.replace(/\s*$/, '');
    return (t ? t + '\n' : '') + 'models:\n' + block.map((l) => '  ' + l).join('\n') + '\n';
  }
  let indent = 2;
  for (let i = mi + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() && /^\S/.test(l)) break; // next top-level key before any entry
    const m = l.match(/^( *)-\s/);
    if (m) { indent = m[1].length; break; }
  }
  lines.splice(mi + 1, 0, ...block.map((l) => ' '.repeat(indent) + l));
  return lines.join('\n');
}

/** remove exactly our two entries; keep every other line untouched */
function traeRemoveOurEntries(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const name = traeEntryName(lines[i]);
    if (name !== null && TRAE_OUR_NAMES.includes(name)) {
      const indent = lines[i].match(/^ */)[0].length;
      i++;
      while (i < lines.length) {
        const l2 = lines[i];
        if (!l2.trim()) break; // blank line ends the block (left in place)
        const ind2 = l2.match(/^ */)[0].length;
        if (ind2 < indent || (ind2 === indent && !/^\s*-\s/.test(l2))) break; // top-level / dedent
        if (ind2 === indent && /^\s*-\s/.test(l2)) break; // sibling entry
        i++;
      }
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  let res = out.join('\n');
  // an emptied `models:` key would parse as null → normalize to []
  if (/^models:\s*$/m.test(res) && !/^\s+-\s/m.test(res.replace(/^models:\s*$/m, ''))) {
    res = res.replace(/^models:\s*$/m, 'models: []');
  }
  return res;
}

function configureTraeworkCn() {
  const model = currentModel();
  if (!model) return { ok: false, steps: [], notes: ['模型目录为空 — 先跑 codex-ocfree refresh'] };
  const file = traeCliTarget();
  const orig = readText(file);
  if (/^models:\s*\[[^\]\s]|^models:\s*\[\s*$/m.test(orig)) {
    // non-empty flow-style `models:` — a naive insert would append a second
    // top-level `models:` key and silently shadow the user's entries.
    return {
      ok: false,
      steps: [],
      notes: [
        '检测到 models: 使用 flow 写法，无法安全合并 — 请手工在 models 列表里追加：',
        ...traeCliBlock(model).map((l) => '  ' + l),
        `配置文件: ${file}`,
      ],
    };
  }
  // remove-then-insert: replaces stale entries (old port / old model slug)
  // instead of appending duplicates; byte-identical result → keep as-is.
  const base = traeHasAnyOurEntry(orig) ? traeRemoveOurEntries(orig) : orig;
  let out = traeInsertModels(base, traeCliBlock(model));
  if (orig.endsWith('\n') && !out.endsWith('\n')) out += '\n';
  if (out === orig) {
    const sk = readHState();
    if (!sk['traework-cn']) {
      sk['traework-cn'] = { at: Date.now(), file, backup: null, existed: true };
      writeHState(sk);
    }
    return {
      ok: true,
      steps: ['已配置，保持不动（trae_cli.yaml 已含 ocfree 双协议条目）'],
      notes: traeNotes(file),
    };
  }
  const existed = fs.existsSync(file);
  const b = existed ? backup(file) : null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out);
  const st = readHState();
  st['traework-cn'] = { at: Date.now(), file, backup: b, existed };
  writeHState(st);
  return {
    ok: true,
    steps: [
      `写入 ${file}（models += ocfree / ocfree-claude, model=${model}）`,
      ...(b ? [`原文件备份: ${b}`] : [`新建: ${file}`]),
    ],
    notes: traeNotes(file, { configured: true }),
  };
}

function traeNotes(file, { configured = false } = {}) {
  const model = currentModel() || '<model>';
  const inst = hasCmd('traecli') || hasCmd('trae-cli');
  return [
    ...(configured ? ['重启 traecli 后输入 /model 选 ocfree-local（OpenAI 协议）或 ocfree-local-claude（Anthropic 协议）'] : []),
    ...(inst ? [] : ['未检测到 traecli/trae-cli 命令 — 配置已就绪，装好 TraeCode CLI 即可用']),
    'TraeCode CLI 要求先登录 TRAE 账号（登录/套餐校验是 TRAE 自己的门槛，helper 不代登录）',
    '',
    'TraeWork 桌面版（GUI，仅桌面版支持自定义模型）：',
    `  设置 → 模型 → 添加模型 → 自定义配置`,
    `    API 格式 OpenAI Chat Completions: 自定义请求地址 ${BRIDGE_BASE}/v1`,
    `    API 格式 Anthropic Messages:      自定义请求地址 ${BRIDGE_BASE}`,
    `    模型 ID ${model}   API 密钥 ${OC_KEY}`,
    '',
    '桥需在运行: codex-ocfree up',
    `配置文件: ${file}`,
  ];
}

function resetTraeworkCn() {
  const s0 = readHState();
  const st = s0['traework-cn'];
  let file = (st && st.file) || traeCliTarget();
  try {
    // CLI 0.120+ migrates the legacy file into ~/.trae and leaves a symlink;
    // operate on the real path so a created-by-us file is fully removed.
    if (fs.existsSync(file)) file = fs.realpathSync(file);
  } catch { /* keep logical path */ }
  const txt = readText(file);
  const steps = [];
  if (!txt.trim()) {
    if (st) { delete s0['traework-cn']; writeHState(s0); }
    return { ok: true, steps: ['无配置文件 — 无需还原'] };
  }
  if (!traeHasAnyOurEntry(txt)) {
    if (st) { delete s0['traework-cn']; writeHState(s0); }
    return { ok: true, steps: ['无 ocfree 条目 — 未改动'] };
  }
  const b = backup(file);
  const out = traeRemoveOurEntries(txt);
  const bare = out.replace(/^models:\s*\[\s*\]\s*$/m, '').replace(/\s+/g, '');
  if (!(st && st.existed) && !bare) {
    fs.unlinkSync(file);
    steps.push(`文件由 ocfree 创建，已删除: ${file}`);
  } else {
    fs.writeFileSync(file, out);
    steps.push(`已移除 ocfree 条目: ${file}${b ? `（备份: ${b}）` : ''}`);
  }
  if (st && st.backup) steps.push(`历史备份: ${st.backup}`);
  delete s0['traework-cn'];
  writeHState(s0);
  return { ok: true, steps };
}

/* ---------------------------------------------------- guide cards (trae/zcode) -- */

function guideCard(name) {
  const model = currentModel() || '<先跑 codex-ocfree refresh>';
  const ctx = modelContext(model);
  if (name === 'trae') {
    return {
      ok: true,
      steps: [
        'Trae 的模型配置只能在 GUI 里填（配置存加密的 state.vscdb，无 CLI/文件入口）：',
        '',
        '  打开  设置 → 模型 → 添加模型 → 自定义配置，填：',
        `    API 格式        OpenAI Chat Completions`,
        `    完整 URL        关闭（用基础地址）`,
        `    自定义请求地址  ${BRIDGE_BASE}/v1`,
        `    模型 ID         ${model}`,
        `    API 密钥        ${OC_KEY}`,
        '',
        '  （或 API 格式选 Anthropic Messages、地址填 ' + BRIDGE_BASE + ' — 二选一）',
        `  模型展示名称随意；上下文 ${Math.round(ctx / 1000)}k、最大输出 32768`,
      ],
      notes: ['桥需在运行: codex-ocfree up'],
    };
  }
  // zcode
  return {
    ok: true,
    steps: [
      'ZCode 支持 GUI 添加自定义供应商（配置随版本变化，这里给可粘贴的值）：',
      '',
      '  路径一（GUI）: 设置 → 模型 → 添加供应商',
      `    名称            OpenCode Free`,
      `    API 地址(Anthropic) ${BRIDGE_BASE}`,
      `    API Key         ${OC_KEY}`,
      `    添加模型 ID     ${model}（若不自动列出）`,
      '    打开 enable 开关',
      '',
      '  路径二（JSON）: 往 ~/.zcode/v2/config.json 的 provider 对象追加：',
      ...JSON.stringify(
        {
          ocfree: {
            name: 'OpenCode Free',
            kind: 'anthropic',
            apiKey: OC_KEY,
            baseURL: BRIDGE_BASE,
            apiKeyRequired: true,
            enabled: true,
            [model]: { limit: { context: ctx, output: 32768 }, modalities: { input: ['text'], output: ['text'] } },
          },
        },
        null,
        2,
      )
        .split('\n')
        .map((l) => '    ' + l),
      '',
      '  （字段形状随 ZCode 版本漂移；若合并后报错，用路径一手动填即可）',
    ],
    notes: ['桥需在运行: codex-ocfree up'],
  };
}

/* -------------------------------------------------------- detect-only list -- */

const DETECT_ONLY = [
  { name: 'workbuddy', display: 'WorkBuddy', dir: path.join(HOME, '.workbuddy-ai') },
  { name: 'cursor', display: 'Cursor', dir: path.join(HOME, '.cursor') },
  { name: 'grok', display: 'Grok', dir: path.join(HOME, '.grok') },
  { name: 'kimi-code', display: 'KimiCode', dir: path.join(HOME, '.kimi-code') },
  { name: 'openclaw', display: 'OpenClaw', dir: path.join(HOME, '.openclaw') },
  { name: 'hermes', display: 'Hermes', dir: path.join(HOME, '.hermes') },
  { name: 'pi', display: 'Pi', dir: path.join(HOME, '.pi') },
];

/* ------------------------------------------------------------- registry ---- */

export const AGENTS = [
  {
    name: 'codex',
    display: 'Codex CLI',
    proto: 'responses',
    support: 'configure',
    detect: () => ({
      installed: hasCmd('codex') || fs.existsSync(CODEX_HOME),
      configured: fs.existsSync(profileConfigPath('opencode')) && !!getModel('opencode'),
      path: profileConfigPath('opencode'),
    }),
    configure: configureCodex,
    reset: resetCodex,
    guide: configureCodex,
  },
  {
    name: 'claude-code',
    display: 'Claude Code',
    proto: 'anthropic',
    support: 'configure',
    detect: () => ({
      installed: hasCmd('claude') || fs.existsSync(path.dirname(CLAUDE_SETTINGS)),
      configured: (() => {
        const j = readJson(CLAUDE_SETTINGS);
        return !!(j && j.env && j.env.ANTHROPIC_BASE_URL === BRIDGE_BASE);
      })(),
      path: CLAUDE_SETTINGS,
    }),
    configure: configureClaude,
    reset: resetClaude,
  },
  {
    name: 'dsh',
    display: 'DeepSeek Harness',
    proto: 'openai-chat',
    support: 'configure',
    detect: () => {
      const txt = readText(DSH_PATCH);
      return {
        installed: fs.existsSync(DSH_HOME) || hasCmd('dsh'),
        configured: txt.includes('ocfree:') && txt.includes(BRIDGE_BASE),
        path: DSH_PATCH,
      };
    },
    configure: configureDsh,
    reset: resetDsh,
  },
  {
    name: 'opencode',
    display: 'OpenCode',
    proto: 'openai-chat',
    support: 'configure',
    detect: () => {
      const j = readJson(OPENCODE_CFG);
      return {
        installed: hasCmd('opencode') || fs.existsSync(path.dirname(OPENCODE_CFG)),
        configured: !!(j && j.provider && j.provider.ocfree && j.provider.ocfree.options && j.provider.ocfree.options.baseURL === `${BRIDGE_BASE}/v1`),
        path: OPENCODE_CFG,
      };
    },
    configure: configureOpencode,
    reset: resetOpencode,
  },
  {
    name: 'trae',
    display: 'Trae',
    proto: 'openai-chat | anthropic',
    support: 'guide',
    detect: () => ({ installed: hasCmd('trae') || fs.existsSync(TRAE_DIR), configured: false, path: '(GUI: 设置→模型)' }),
    guide: () => guideCard('trae'),
  },
  {
    name: 'traework-cn',
    display: 'TraeWork CN',
    proto: 'openai-chat | anthropic',
    support: 'configure',
    detect: () => {
      const file = traeCliTarget();
      const txt = readText(file);
      return {
        installed: hasCmd('traecli') || hasCmd('trae-cli') || fs.existsSync(TRAE_CLI_YAML) || fs.existsSync(traeCliLegacyYaml()),
        configured: traeHasOurEntries(txt),
        path: file,
      };
    },
    configure: configureTraeworkCn,
    reset: resetTraeworkCn,
  },
  {
    name: 'zcode',
    display: 'ZCode',
    proto: 'anthropic',
    support: 'guide',
    detect: () => ({ installed: hasCmd('zcode') || fs.existsSync(path.dirname(path.dirname(ZCODE_V2))), configured: false, path: ZCODE_V2 }),
    guide: () => guideCard('zcode'),
  },
  ...DETECT_ONLY.map((a) => ({
    name: a.name,
    display: a.display,
    proto: '-',
    support: 'detect',
    detect: () => ({ installed: fs.existsSync(a.dir) || hasCmd(a.name), configured: false, path: a.dir }),
  })),
];

export function findAgent(name) {
  return AGENTS.find((a) => a.name === name || a.name.replace(/-/g, '') === String(name || '').replace(/-/g, ''));
}

/* ----------------------------------------------------------------- list ---- */

function bridgeUpText() {
  return fetch(`${BRIDGE_BASE}/health`, { signal: AbortSignal.timeout(1500) })
    .then((r) => (r.ok ? green('up') : yellow('down')))
    .catch(() => red('down'));
}

export async function helperList({ json = false } = {}) {
  const rows = AGENTS.map((a) => {
    const d = a.detect();
    return {
      name: a.name,
      display: a.display,
      protocol: a.proto,
      support: a.support,
      installed: d.installed,
      configured: d.configured,
      path: d.path,
    };
  });
  if (json) {
    console.log(JSON.stringify({ bridge: BRIDGE_BASE, agents: rows }, null, 2));
    return 0;
  }
  const up = await bridgeUpText();
  console.log('');
  console.log(`${bold('ocfree helper')}  ${dim('agents @ bridge')} ${BRIDGE_BASE} [${up}]`);
  console.log('');
  const head = ['name', 'display', 'protocol', 'installed', 'state', 'support'];
  const cells = rows.map((r) => [
    r.name,
    r.display,
    r.protocol,
    r.installed ? 'yes' : '-',
    r.configured ? green('configured') : r.support === 'detect' ? dim('-') : 'not',
    r.support === 'configure' ? 'configure' : r.support === 'guide' ? yellow('guide') : dim('detect-only'),
  ]);
  const widths = head.map((h, i) => Math.max(...cells.map((c) => stripAnsi(String(c[i])).length), h.length));
  const line = (c) => '  ' + c.map((x, i) => pad(x, widths[i])).join('  ');
  console.log(line(head));
  console.log('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
  for (const c of cells) console.log(line(c));
  console.log('');
  console.log(dim('  configure: codex-ocfree helper configure <name>   reset: codex-ocfree helper reset <name>'));
  console.log(dim('  guide = 值打印出来手动填进 GUI；detect-only = 只检测不配置。'));
  console.log('');
  return 0;
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const pad = (s, w) => {
  const raw = stripAnsi(String(s));
  return String(s) + ' '.repeat(Math.max(0, w - raw.length));
};

/* ------------------------------------------------------ configure / reset --- */

function printResult(res) {
  for (const s of res.steps || []) (s ? info(s) : console.log(''));
  for (const w of res.warns || []) warn(w);
  if (res.ok) {
    for (const n of res.notes || []) ok(n);
  } else {
    for (const n of res.notes || []) fail(n);
  }
}

export async function helperConfigure(name, opts = {}) {
  const a = findAgent(name);
  if (!a) {
    console.error(`未知 agent: ${name}\n可用: ${AGENTS.filter((x) => x.support !== 'detect').map((x) => x.name).join(', ')}`);
    return 2;
  }
  if (a.support === 'detect') {
    console.error(`${a.name} 暂未适配（仅检测）— 见 helper list`);
    return 2;
  }
  console.log(`${bold('helper configure')} ${cyan(a.name)} ${dim(`(${a.display})`)}`);
  const fn = a.configure || a.guide;
  const res = fn(opts);
  printResult(res);
  return res.ok ? 0 : 1;
}

export async function helperReset(name, opts = {}) {
  const a = findAgent(name);
  if (!a) {
    console.error(`未知 agent: ${name}\n可用: ${AGENTS.filter((x) => x.support === 'configure').map((x) => x.name).join(', ')}`);
    return 2;
  }
  if (!a.reset) {
    console.error(`${a.name} 无自动 reset（${a.support === 'guide' ? 'guide 模式不写文件' : '仅检测'}）`);
    return 2;
  }
  console.log(`${bold('helper reset')} ${cyan(a.name)} ${dim(`(${a.display})`)}`);
  const res = a.reset(opts);
  printResult(res);
  return res.ok ? 0 : 1;
}

/* ---------------------------------------------------------------- wizard --- */

export async function helperWizard() {
  const { select } = await import('./tui.mjs');
  const rows = AGENTS.map((a) => {
    const d = a.detect();
    const state = d.configured ? green('[configured]') : a.support === 'detect' ? dim('[detect-only]') : a.support === 'guide' ? yellow('[guide]') : dim('[not configured]');
    const inst = d.installed ? '' : yellow('[未安装]');
    return `${a.name.padEnd(14)} ${a.display.padEnd(18)} ${state} ${inst}`;
  });
  const idx = await select('ocfree helper — 选择 agent（↑↓ 选, Enter 确认, q 退出）', rows);
  if (idx === null) return 0;
  const agent = AGENTS[idx];
  const d = agent.detect();

  console.log('');
  console.log(`  ${bold(agent.display)} ${dim(agent.name)}  proto=${agent.proto}  ${dim(d.path || '')}`);
  if (agent.support === 'detect') {
    console.log(dim('  该 agent 暂未适配（仅检测）。'));
    return 0;
  }
  const actions = [
    ...(agent.configure ? [`${agent.name.padEnd(14)} configure  指向本地桥（有备份）`] : [`${agent.name.padEnd(14)} guide      打印手动配置值`]),
    ...(agent.reset ? [`${'reset'.padEnd(16)} 还原 ocfree 注入的配置`] : []),
    'back'.padEnd(16) + ' 返回',
  ];
  const a2 = await select(`操作 ${agent.name}`, actions);
  if (a2 === null) return 0;
  const pick = actions[a2].trim().split(/\s+/)[0];
  if (pick === 'back') return 0;
  if (pick === 'reset') return await helperReset(agent.name);
  return await helperConfigure(agent.name);
}
