/**
 * `codex-ocfree quota` (alias: usage) — approximate free-tier usage display.
 *
 * All numbers are LOCAL estimates from usage.jsonl: the upstream never returns
 * remaining-quota headers, and the ~200 req/5h reference cap is
 * community-measured, not official. Show it honestly as such.
 */
import { readUsage, summarize, limit5h, limitDay, USAGE_FILE } from './usage.mjs';
import { dim, green, yellow, red, bold } from './config.mjs';

const bar = (pct, width = 20) => {
  const n = Math.max(0, Math.min(width, Math.round(pct * width)));
  return '█'.repeat(n) + '░'.repeat(width - n);
};

const fmtTokens = (n) => n.toLocaleString('en-US');

/** one-line summary for `codex-ocfree status`; null when no records yet */
export function quotaBrief() {
  try {
    const recs = readUsage();
    if (!recs.length) return null;
    const s = summarize(recs);
    const lim = limit5h();
    let line = `今日 ${s.today.n} 次 · 5h窗 ${s.w5h.n}${lim ? `/~${lim}` : ''}`;
    if (s.hits.length) line += red(` · 触顶 ${s.hits.length} 次`);
    return line;
  } catch {
    return null;
  }
}

export function cmdQuota() {
  const recs = readUsage({ fresh: true });
  if (!recs.length) {
    console.log(`尚无用量记录 (${USAGE_FILE})`);
    console.log(dim('  桥运行后会自动记录每次经过上游的请求；本机旧版桥(≤0.1.x)不写记录。'));
    console.log(dim('  上游不回传余量，所有数字均为本地统计估计。'));
    return 0;
  }

  const s = summarize(recs);
  const lim5 = limit5h();
  const limD = limitDay();

  console.log('');
  console.log(`${bold('免费额度估计')} ${dim('（本地统计 · 上游不回传余量）')}`);
  console.log(dim(`  数据: ${USAGE_FILE}`));
  console.log('');

  // today — absolute count first, reference bar second
  const pctD = limD ? s.today.n / limD : 0;
  const todayLine = limD
    ? `  ${bar(pctD)} 约 ${Math.min(100, (pctD * 100).toFixed(0))}%`
    : '';
  console.log(`  ${bold('今日')}    ${String(s.today.n).padStart(5)} 次${limD ? `  ${todayLine}（参考 ~${limD} 次/天）` : ''}`);
  console.log(`  ${dim(`对话 ${s.today.chat} · 探测 ${s.today.probe} · 失败 ${s.today.fail}`)}`);

  const pct5 = lim5 ? s.w5h.n / lim5 : 0;
  console.log(`  ${bold('5小时窗')} ${String(s.w5h.n).padStart(5)} 次${lim5 ? `  ${bar(pct5)} 约 ${Math.min(100, (pct5 * 100).toFixed(0))}%（参考 ~${lim5} 次/5h）` : ''}`);
  console.log(`  ${dim(`今日 tokens ${fmtTokens(s.today.tokens.total)}（in ${fmtTokens(s.today.tokens.input)} / out ${fmtTokens(s.today.tokens.output)}）`)}`);
  console.log(`  ${bold('昨日')}    ${s.yday} 次   ${dim(`近7日均 ${s.weekAvg} 次/天`)}`);

  // quota-hit events (429 FreeUsageLimitError)
  if (s.hits.length) {
    const last = s.hits[s.hits.length - 1];
    const when = new Date(last.ts).toTimeString().slice(0, 5);
    const detail = last.err ? `${last.err.type}${last.err.message ? ': ' + String(last.err.message).slice(0, 60) : ''}` : `HTTP ${last.status}`;
    console.log(`  ${red(`⚠ 今日触顶 ${s.hits.length} 次`)} ${dim(`最近 ${when} ${detail}`)}`);
    console.log(`  ${yellow('    触顶后需等滑动窗口过期（约5小时尺度），或 OC2C_LIMIT_5H 核对参考值。')}`);
  } else {
    console.log(`  ${green('✓ 今日未触顶')} ${dim('（触顶 = 上游 429 FreeUsageLimitError）')}`);
  }

  // model mix + last event
  const models = Object.entries(s.today.byModel).sort((a, b) => b[1] - a[1]);
  if (models.length) {
    console.log(`  ${dim('今日模型: ' + models.map(([m, n]) => `${m}×${n}`).join(' · '))}`);
  }
  if (s.last) {
    const t = new Date(s.last.ts);
    const dur = s.last.ms ? ` ${(s.last.ms / 1000).toFixed(1)}s` : '';
    const tok = s.last.usage ? ` ${fmtTokens(normTotal(s.last.usage))} tok` : '';
    console.log(`  ${dim(`最近: ${t.toTimeString().slice(0, 5)} ${s.last.model || '?'} ${s.last.status}${dur}${tok}`)}`);
  }

  console.log(dim(''));
  console.log(dim('  参考说明: 官方未公布免费额度；~200 次/5h 来自社区实测 (opencode#33495 → 429 FreeUsageLimitError)。'));
  console.log(dim('  改参考值: OC2C_LIMIT_5H=<n>（0 关闭参考条）。对话内可直接问模型“额度还剩多少”。'));
  console.log('');
  return 0;
}

function normTotal(u) {
  if (!u || typeof u !== 'object') return 0;
  const input = Number(u.input_tokens ?? u.prompt_tokens ?? 0) || 0;
  const output = Number(u.output_tokens ?? u.completion_tokens ?? 0) || 0;
  return Number(u.total_tokens ?? (input + output)) || input + output;
}
