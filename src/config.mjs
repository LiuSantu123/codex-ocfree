/**
 * Shared paths / small helpers for codex-ocfree.
 *
 * Layout (all overridable for tests via OCSW_* env vars):
 *   ~/.codex-ocfree/               state (bridge.pid, bridge.log, availability.json)
 *   ~/.codex/                  default CODEX_HOME (base config + <profile>.config.toml)
 *   ~/.codex/<profile>.config.toml   codex profile layer (loaded by `codex --profile <profile>`)
 *   ~/.codex/opencode.models.json    model catalog (model_catalog_json)
 *   ~/.codex.d/<profile>/      isolated CODEX_HOME (sessions/history), config symlinked
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.OCSW_HOME || os.homedir();
export const STATE_DIR = process.env.OC2C_STATE || process.env.OCSW_STATE || path.join(HOME, '.codex-ocfree');
export const CODEX_HOME = process.env.OCSW_CODEX_HOME || path.join(HOME, '.codex');
export const CODEX_D = process.env.OCSW_CODEX_D || path.join(HOME, '.codex.d');
export const CATALOG = process.env.OC2C_CATALOG || path.join(CODEX_HOME, 'opencode.models.json');
export const OPEND_DB = process.env.OC2C_DB || path.join(HOME, '.local/share/opencode/opencode.db');
export const BRIDGE_PORT = Number(process.env.OC2C_PORT || 8973);
export const BRIDGE_BASE = `http://127.0.0.1:${BRIDGE_PORT}`;
export const PROVIDER_KEY = 'opencode-free'; // [model_providers.<key>] in the profile toml
export const LEGACY_PROVIDER_KEYS = ['opencode-free-codex']; // accepted for pre-0.1 installs

export function ensureState() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  return STATE_DIR;
}

/** Profile config file: default profile -> config.toml, else <name>.config.toml */
export function profileConfigPath(profile) {
  return profile === 'default'
    ? path.join(CODEX_HOME, 'config.toml')
    : path.join(CODEX_HOME, `${profile}.config.toml`);
}

/** Read the top-level `model = "..."` from a toml file (ignores keys inside sections). */
export function getModel(profile) {
  const f = profileConfigPath(profile);
  if (!fs.existsSync(f)) return null;
  const head = fs.readFileSync(f, 'utf8').split(/^\[/m)[0];
  const m = head.match(/^model\s*=\s*"([^"]+)"/m);
  return m ? m[1] : null;
}

/** Set top-level `model = "<slug>"` (insert before the first section if absent). */
export function setModel(profile, slug) {
  const f = profileConfigPath(profile);
  let txt = fs.readFileSync(f, 'utf8');
  const lines = txt.split('\n');
  const headEnd = lines.findIndex((l) => /^\s*\[/.test(l));
  const head = headEnd === -1 ? lines : lines.slice(0, headEnd);
  let replaced = false;
  for (let i = 0; i < head.length; i++) {
    if (/^model\s*=/.test(head[i])) {
      head[i] = `model = "${slug}"`;
      replaced = true;
      break;
    }
  }
  if (replaced) {
    lines.splice(0, head.length, ...head);
    txt = lines.join('\n');
  } else {
    const block = [`model = "${slug}"`, ''];
    lines.unshift(...block);
    txt = lines.join('\n');
  }
  fs.writeFileSync(f, txt);
  return f;
}

/** Read the catalog: [{ slug, display_name, context_window, reasoning }] */
export function readCatalog() {
  try {
    const cat = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
    return (cat.models || []).map((m) => ({
      slug: m.slug,
      display_name: m.display_name || m.slug,
      context_window: m.context_window,
      reasoning: !!m.supports_reasoning_summaries,
    }));
  } catch {
    return [];
  }
}

export function readAvailability() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ensureState(), 'availability.json'), 'utf8'));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ output -- */

const TTY = process.stdout.isTTY;
const c = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = (s) => c('2', s);
export const bold = (s) => c('1', s);
export const green = (s) => c('32', s);
export const yellow = (s) => c('33', s);
export const red = (s) => c('31', s);
export const cyan = (s) => c('36', s);

export function ok(msg) {
  console.log(`  ${green('[ok]')}  ${msg}`);
}
export function warn(msg) {
  console.log(`  ${yellow('[!!]')}  ${msg}`);
}
export function fail(msg) {
  console.log(`  ${red('[xx]')}  ${msg}`);
}
export function info(msg) {
  console.log(`  ${dim('[--]')}  ${msg}`);
}
