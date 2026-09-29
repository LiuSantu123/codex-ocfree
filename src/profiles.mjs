/**
 * Per-profile session/history isolation.
 *
 * `codex --profile X` only layers $CODEX_HOME/X.config.toml over the base
 * config — every profile still shares ~/.codex sessions/state/history (setting
 * `sqlite_home` does NOT work: rollouts stay in ~/.codex/sessions). The only
 * reliable lever is CODEX_HOME itself, so each profile gets its own home at
 * ~/.codex.d/<name>/ with configs symlinked back to ~/.codex (shared edits).
 *
 * `ocfree init <name>` does two things:
 *   1. create ~/.codex.d/<name>/ and symlink config + skills + rules + MEMORY
 *   2. install a `codex()` wrapper into ~/.bashrc or ~/.zshrc (picked via $SHELL;
 *      bash and zsh have different array indexing, so snippets differ) that flips
 *      CODEX_HOME when it sees `--profile <name>` (idempotent, marker-delimited)
 */
import fs from 'node:fs';
import path from 'node:path';
import { CODEX_D, CODEX_HOME, HOME, ok, warn, fail, info, dim, green, yellow } from './config.mjs';

const SHARED_ENTRIES = (profile) => [
  'config.toml',
  `${profile}.config.toml`,
  'skills',
  'rules',
  'MEMORY.md',
];

const MARK_BEGIN = '# >>> codex-ocfree: codex profile isolation >>>';
const MARK_END = '# <<< codex-ocfree: codex profile isolation <<<';

export function codexHomeFor(profile) {
  return path.join(CODEX_D, profile);
}

/** Create ~/.codex.d/<profile>/ and symlink shared config entries. */
export function initHome(profile) {
  const home = codexHomeFor(profile);
  fs.mkdirSync(home, { recursive: true });
  const results = [];
  for (const name of SHARED_ENTRIES(profile)) {
    const src = path.join(CODEX_HOME, name);
    const dst = path.join(home, name);
    if (!fs.existsSync(src) && !isSymlink(dst)) {
      results.push({ name, state: 'skip', detail: 'not present in ~/.codex' });
      continue;
    }
    if (isSymlink(dst)) {
      const cur = fs.readlinkSync(dst);
      if (cur === src) {
        results.push({ name, state: 'ok', detail: 'linked' });
      } else {
        results.push({ name, state: 'warn', detail: `existing link -> ${cur}` });
      }
      continue;
    }
    if (fs.existsSync(dst)) {
      results.push({ name, state: 'warn', detail: 'exists as a real file/dir, left untouched' });
      continue;
    }
    try {
      fs.symlinkSync(src, dst);
      results.push({ name, state: 'ok', detail: 'linked' });
    } catch (e) {
      results.push({ name, state: 'fail', detail: e.message });
    }
  }
  return { home, results };
}

const isSymlink = (p) => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/* ------------------------------------------------------- shell integration -- */

/** zsh: arrays are 1-indexed; bash: arrays are 0-indexed (two variants below). */
export function detectShell() {
  const s = (process.env.OCSW_SHELL || process.env.SHELL || '').toLowerCase();
  return s.includes('bash') ? 'bash' : 'zsh';
}

/** rc file for a shell (test overrides: OCSW_RC, legacy OCSW_ZSHRC) */
export function rcPath(shell = detectShell()) {
  const override = process.env.OCSW_RC || process.env.OCSW_ZSHRC;
  if (override) return override;
  return shell === 'bash' ? path.join(HOME, '.bashrc') : path.join(HOME, '.zshrc');
}

const WRAP_COMMENT = `# 用法不变：codex --profile arkcli / codex --profile opencode / codex
# 有 ~/.codex.d/<profile> 目录时自动切换 CODEX_HOME，否则用默认 ~/.codex`;

const ZSH_SNIPPET = `${MARK_BEGIN}
${WRAP_COMMENT}
codex() {
  local home_dir="" i
  local -a args
  args=("$@")
  local n=\${#args}
  for (( i=1; i<=n; i++ )); do
    case "\${args[i]}" in
      --profile=*) home_dir="\${args[i]#--profile=}"; break ;;
      -p|--profile)
        if (( i < n )); then home_dir="\${args[i+1]}"; fi
        break ;;
    esac
  done
  if [[ -n "$home_dir" && -d "$HOME/.codex.d/$home_dir" ]]; then
    CODEX_HOME="$HOME/.codex.d/$home_dir" command codex "\${args[@]}"
  else
    command codex "\${args[@]}"
  fi
}
${MARK_END}`;

const BASH_SNIPPET = `${MARK_BEGIN}
${WRAP_COMMENT}
codex() {
  local home_dir="" i
  local -a args
  args=("$@")
  local n=\${#args[@]}
  for (( i=0; i<n; i++ )); do
    case "\${args[i]}" in
      --profile=*) home_dir="\${args[i]#--profile=}"; break ;;
      -p|--profile)
        if (( i+1 < n )); then home_dir="\${args[i+1]}"; fi
        break ;;
    esac
  done
  if [[ -n "$home_dir" && -d "$HOME/.codex.d/$home_dir" ]]; then
    CODEX_HOME="$HOME/.codex.d/$home_dir" command codex "\${args[@]}"
  else
    command codex "\${args[@]}"
  fi
}
${MARK_END}`;

export function wrapperSnippet(shell = detectShell()) {
  return shell === 'bash' ? BASH_SNIPPET : ZSH_SNIPPET;
}

/** Install the wrapper into the rc file of `shell` (idempotent). */
export function installWrapper({ shell = detectShell(), rc = rcPath(shell) } = {}) {
  const existing = fs.existsSync(rc) ? fs.readFileSync(rc, 'utf8') : '';
  if (existing.includes(MARK_BEGIN)) {
    if (existing.includes(MARK_END)) return { state: 'ok', detail: `already installed in ${rc}`, rc };
    return { state: 'fail', detail: `marker ${MARK_BEGIN} present but end marker missing in ${rc}`, rc };
  }
  if (/^\s*codex\s*\(\)/m.test(existing)) {
    return { state: 'unmanaged', detail: `${rc} already defines codex() outside the codex-ocfree block`, rc };
  }
  fs.appendFileSync(rc, `\n${wrapperSnippet(shell)}\n`);
  return { state: 'installed', detail: `appended to ${rc} (${shell})`, rc };
}

/** Check both rc files: is the wrapper installed anywhere? */
export function wrapperInstalled() {
  const files =
    process.env.OCSW_RC || process.env.OCSW_ZSHRC
      ? [rcPath()]
      : [...new Set([path.join(HOME, '.zshrc'), path.join(HOME, '.bashrc')])];
  let res = { managed: false, anyCodexFn: false, file: null };
  for (const f of files) {
    let txt;
    try {
      txt = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    if (txt.includes(MARK_BEGIN) && txt.includes(MARK_END)) return { managed: true, anyCodexFn: true, file: f };
    if (/^\s*codex\s*\(\)/m.test(txt)) res = { managed: false, anyCodexFn: true, file: f };
  }
  return res;
}

/** List isolation homes currently on disk. */
export function listHomes() {
  try {
    return fs
      .readdirSync(CODEX_D, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** Report on the health of one isolation home (symlinks intact?). */
export function checkHome(profile) {
  const home = codexHomeFor(profile);
  const out = { profile, home, exists: false, links: [] };
  if (!fs.existsSync(home)) return out;
  out.exists = true;
  for (const name of SHARED_ENTRIES(profile)) {
    const dst = path.join(home, name);
    const src = path.join(CODEX_HOME, name);
    if (isSymlink(dst)) {
      const cur = fs.readlinkSync(dst);
      out.links.push({ name, state: cur === src ? 'ok' : 'warn', target: cur });
    } else if (fs.existsSync(dst)) {
      out.links.push({ name, state: 'info', target: '(real file)' });
    }
  }
  return out;
}

/** High-level init: home + wrapper + print summary. */
export function init(profile, { quiet = false, shell } = {}) {
  const sh = shell || detectShell();
  const { home, results } = initHome(profile);
  const wrap = installWrapper({ shell: sh });
  if (!quiet) {
    console.log(`\ncodex profile isolation for ${profile} (${sh}):`);
    for (const r of results) {
      const msg = `${r.name} ${dim('->')} ${r.detail}`;
      if (r.state === 'ok') ok(msg);
      else if (r.state === 'warn') warn(msg);
      else if (r.state === 'fail') fail(msg);
      else info(msg);
    }
    console.log('');
    if (wrap.state === 'fail') fail(`shell wrapper: ${wrap.detail}`);
    else if (wrap.state === 'unmanaged') warn(`shell wrapper: ${wrap.detail}`);
    else ok(`shell wrapper: ${wrap.detail}`);

    if (wrap.state === 'installed') {
      console.log(yellow(`\n  ⚠ 需要重载 shell 才生效：`));
      console.log(`      source ${wrap.rc}   # 或开新终端`);
    } else if (wrap.state === 'unmanaged') {
      console.log(yellow(`\n  ⚠ 检测到 ${wrap.rc} 已有自己的 codex() 函数，codex-ocfree 未注入。`));
      console.log(`    要改由 codex-ocfree 管理：先删除旧的 codex() 定义，再跑 ${green('codex-ocfree init')}。`);
    }
    console.log(`\n  home:  ${home}`);
    console.log(`  start: ${green(`codex --profile ${profile}`)}   (裸 codex 仍用默认 ~/.codex)\n`);
  }
  return { home, results, wrap };
}
