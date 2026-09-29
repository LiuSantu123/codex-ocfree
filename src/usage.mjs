/**
 * Local free-tier usage tracking.
 *
 * Verified empirically (2026-09): the upstream chat/completions response carries
 * NO rate-limit / remaining-quota headers — only x-opencode-* metadata — so the
 * only honest way to show "how much quota is left" is to count locally:
 * every request that actually reaches upstream (bridge chat + availability
 * probes) is appended to ~/.codex-ocfree/usage.jsonl and aggregated here.
 *
 * Reference cap: community-measured ~200 requests / 5h free window
 * (opencode issue #33495 → 429 FreeUsageLimitError). Not officially documented;
 * override with OC2C_LIMIT_5H=<n>, or 0 to hide all reference bars.
 *
 * Used by: bridge.mjs (record + system-message note), probe.mjs (record),
 *          quota.mjs (display), cli.mjs (status one-liner).
 */
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './config.mjs';

export const USAGE_FILE = path.join(STATE_DIR, 'usage.jsonl');

/** reference cap per 5h window; 0 = disabled */
export function limit5h() {
  const v = process.env.OC2C_LIMIT_5H;
  if (v === undefined || v === '') return 200;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** derived per-day reference (24h / 5h windows) */
export function limitDay() {
  const l = limit5h();
  return l ? Math.round((l * 24) / 5) : 0;
}

let cache = { ts: 0, recs: null };

/** append one record; never throws (tracking must not break serving) */
export function recordUsage(rec) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(USAGE_FILE, JSON.stringify({ ts: Date.now(), ...rec }) + '\n');
    cache = { ts: 0, recs: null };
    if (Math.random() < 0.03) pruneUsage();
  } catch { /* ignore */ }
}

/** drop records older than keepDays (runs opportunistically on write) */
export function pruneUsage(keepDays = 30) {
  try {
    if (!fs.existsSync(USAGE_FILE)) return;
    const cutoff = Date.now() - keepDays * 86400000;
    const lines = fs.readFileSync(USAGE_FILE, 'utf8').split('\n').filter(Boolean);
    const keep = lines.filter((l) => {
      try { return JSON.parse(l).ts >= cutoff; } catch { return false; }
    });
    if (keep.length !== lines.length) {
      fs.writeFileSync(USAGE_FILE, keep.length ? keep.join('\n') + '\n' : '');
    }
  } catch { /* ignore */ }
}

/** read all records (5s in-memory cache to keep per-request cost near zero) */
export function readUsage({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && cache.recs && now - cache.ts < 5000) return cache.recs;
  let recs = [];
  try {
    recs = fs.readFileSync(USAGE_FILE, 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { recs = []; }
  cache = { ts: now, recs };
  return recs;
}

/** normalize chat-style and responses-style usage objects */
export function normTokens(u) {
  if (!u || typeof u !== 'object') return { input: 0, output: 0, total: 0 };
  const input = Number(u.input_tokens ?? u.prompt_tokens ?? 0) || 0;
  const output = Number(u.output_tokens ?? u.completion_tokens ?? 0) || 0;
  const total = Number(u.total_tokens ?? (input + output)) || input + output;
  return { input, output, total };
}

const isOk = (r) => r.status === 200 || r.status === 'completed';

/** aggregate records into day / 5h-window / yesterday / week views */
export function summarize(recs = readUsage(), now = Date.now()) {
  const d0 = new Date(now);
  d0.setHours(0, 0, 0, 0);
  const dayStart = d0.getTime();
  const yStart = dayStart - 86400000;
  const w5 = now - 5 * 3600 * 1000;

  const pack = (list) => {
    const o = {
      n: list.length, chat: 0, probe: 0, fail: 0,
      tokens: { input: 0, output: 0, total: 0 },
      byModel: {},
    };
    for (const r of list) {
      if (r.kind === 'probe') o.probe++; else o.chat++;
      if (!isOk(r)) o.fail++;
      const t = normTokens(r.usage);
      o.tokens.input += t.input;
      o.tokens.output += t.output;
      o.tokens.total += t.total;
      const m = r.model || '?';
      o.byModel[m] = (o.byModel[m] || 0) + 1;
    }
    return o;
  };

  const today = recs.filter((r) => r.ts >= dayStart);
  const hits = today.filter((r) =>
    r.status === 429 ||
    (r.err && /limit|quota/i.test(String(r.err.type) + ' ' + String(r.err.message))),
  );
  const week = recs.filter((r) => r.ts >= now - 7 * 86400000);
  const days = new Set(week.map((r) => new Date(r.ts).toDateString()));

  return {
    dayStart,
    today: pack(today),
    w5h: pack(recs.filter((r) => r.ts >= w5)),
    yday: recs.filter((r) => r.ts >= yStart && r.ts < dayStart).length,
    hits,
    last: recs[recs.length - 1] || null,
    total: recs.length,
    weekAvg: days.size ? Math.round(week.length / days.size) : 0,
  };
}

/**
 * One-line English note appended to the codex system message, so the model can
 * answer "额度还剩多少" in-chat from local data. Empty until some usage exists.
 */
export function quotaLine() {
  try {
    const recs = readUsage();
    if (!recs.length) return '';
    const s = summarize(recs);
    const lim = limit5h();
    const bits = [`${s.today.n} requests today`];
    if (lim) bits.push(`${s.w5h.n} in the last 5h vs reference cap ~${lim}/5h`);
    if (s.hits.length) bits.push(`free cap hit ${s.hits.length}x today (429 FreeUsageLimitError)`);
    return (
      `[free-tier usage — local estimate] ${bits.join('; ')}. ` +
      'The upstream exposes no remaining-quota numbers; when the cap is reached it returns ' +
      '429 FreeUsageLimitError. If the user asks about quota/额度/remaining limit, quote these figures.'
    );
  } catch {
    return '';
  }
}
