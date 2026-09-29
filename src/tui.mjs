/**
 * Minimal dependency-free TUI list selector (arrow keys / j-k / enter / esc).
 * Falls back to a numbered prompt when stdin is not a TTY.
 *
 * select(title, items, { currentIndex, pageSize }) -> Promise<number | null>
 *   items: string[]  (pre-formatted lines)
 */
import readline from 'node:readline';

const TOKEN = /\x1b\[[0-9;]*[A-Za-z]|\x1b|[\s\S]/g;

export async function select(title, items, opts = {}) {
  if (!items.length) return null;
  const start = Math.min(Math.max(opts.currentIndex ?? 0, 0), items.length - 1);
  if (!process.stdin.isTTY || !process.stdout.isTTY) return fallback(title, items, start);

  const PAGE = Math.min(Math.max(opts.pageSize || 12, 3), items.length);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const out = process.stdout;
    let idx = start;
    let scroll = Math.max(0, Math.min(start - Math.floor(PAGE / 2), items.length - PAGE));
    let lastLines = 0;
    let done = false;

    const dim = (s) => `\x1b[2m${s}\x1b[0m`;

    const render = () => {
      const marks = [];
      const from = scroll;
      const to = Math.min(items.length, scroll + PAGE);
      for (let i = from; i < to; i++) marks.push(`${i === idx ? ' > ' : '   '}${items[i]}`);
      const lines = [`${title}  ${dim(`(${idx + 1}/${items.length})`)}`, ...marks];
      const total = Math.max(lastLines, lines.length);
      if (lastLines > 0) out.write(`\x1b[${lastLines}A`);
      for (let i = 0; i < total; i++) {
        out.write('\r\x1b[2K' + (lines[i] ?? '') + '\n');
      }
      lastLines = total;
    };

    const wipe = () => {
      if (lastLines <= 0) return;
      out.write(`\x1b[${lastLines}A`);
      for (let i = 0; i < lastLines; i++) {
        out.write('\r\x1b[2K');
        if (i < lastLines - 1) out.write('\n');
      }
      lastLines = 0;
    };

    const finish = (result) => {
      done = true;
      stdin.removeListener('data', onChunk);
      stdin.setRawMode(false);
      stdin.pause();
      wipe();
      if (result === null) out.write(`${title}  ${dim('cancelled')}\n`);
      else out.write(`${title}  > ${items[result]}\n`);
      resolve(result);
    };

    const onChunk = (chunk) => {
      if (done) return;
      const tokens = chunk.match(TOKEN) || [];
      for (const t of tokens) {
        if (t === '\x03' || t === '\x1b' || t === 'q') return finish(null); // ctrl-c / esc / q
        if (t === '\r' || t === '\n') return finish(idx);
        if (t === '\x1b[A' || t === 'k') idx = Math.max(0, idx - 1);
        else if (t === '\x1b[B' || t === 'j') idx = Math.min(items.length - 1, idx + 1);
        else if (t === '\x1b[5~') idx = Math.max(0, idx - PAGE); // pgup
        else if (t === '\x1b[6~') idx = Math.min(items.length - 1, idx + PAGE); // pgdn
        else if (t === 'g') idx = 0;
        else if (t === 'G') idx = items.length - 1;
      }
      if (idx < scroll) scroll = idx;
      if (idx >= scroll + PAGE) scroll = idx - PAGE + 1;
      render();
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onChunk);
    render();
  });
}

async function fallback(title, items, start) {
  console.log(title);
  items.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) =>
    rl.question(`选择序号 [1-${items.length}]（直接回车 = ${start + 1}，空 = 取消）: `, res),
  );
  rl.close();
  const t = answer.trim();
  if (!t) return start;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 1 || n > items.length) return null;
  return n - 1;
}
