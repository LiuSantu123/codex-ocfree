/**
 * Probe which OpenCode Zen free models are reachable through the
 * chat/completions endpoint; writes ~/.codex-ocfree/availability.json.
 *
 * Model id sources (in order):
 *   1. explicit args:            codex-ocfree probe gpt-5.5-free ...
 *   2. previous availability.json
 *   3. free models from the models.dev cache inside opencode.db
 *
 * Run before `codex-ocfree refresh` regenerates the catalog.
 */
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, ensureState, dim, green, red } from './config.mjs';
import { freeModels, loadModelsMap } from './catalog.mjs';

const OUT = path.join(ensureState(), 'availability.json');
const UPSTREAM = process.env.OC2C_UPSTREAM
  ? String(process.env.OC2C_UPSTREAM).replace(/\/+$/, '') + '/chat/completions'
  : 'https://opencode.ai/inference/openai/v1/chat/completions';
const UA = process.env.OC2C_UA || 'opencode/2.0.18/cli';

const fake = (n) => ({
  type: 'function',
  function: { name: n, description: 'alias of exec_command', parameters: { type: 'object', properties: {} } },
});

async function freeIdsFromMeta() {
  try {
    const models = await loadModelsMap(); // db cache, falls back to models.dev online
    return freeModels(models).map((m) => m.id).filter(Boolean);
  } catch (e) {
    console.error(dim(`(cannot read free model ids: ${e.message})`));
    return [];
  }
}

export async function probe(explicitIds = []) {
  ensureState();
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  let ids = explicitIds;
  if (!ids.length) {
    // union of previously probed ids and whatever the metadata source knows now
    const fromMeta = await freeIdsFromMeta();
    ids = [...new Set([...Object.keys(prev), ...fromMeta])];
  }
  if (!ids.length) {
    console.error('no model ids to probe (pass ids explicitly)');
    return prev;
  }

  const result = { ...prev };
  const concurrency = Number(process.env.PROBE_CONCURRENCY || 4);
  let i = 0;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  async function probeOne(id) {
    try {
      const r = await fetch(UPSTREAM, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': UA,
          'x-opencode-session': 'ses_' + 'a1b2c3d4e5f6' + Math.random().toString(36).slice(2, 8).padEnd(14, 'x'),
        },
        body: JSON.stringify({
          model: id,
          messages: [{ role: 'user', content: 'say OK' }],
          stream: true,
          tools: [fake('read'), fake('shell')],
        }),
        signal: AbortSignal.timeout(Number(process.env.PROBE_TIMEOUT_MS || 15000)),
      });
      const t = await r.text();
      if (r.status === 200 && t.includes('data:')) return 'ok';
      const msg = (t.match(/"message":"([^"]{0,120})/) || [, ''])[1] || t.slice(0, 120);
      return `http${r.status}:${msg}`;
    } catch (e) {
      return 'ERR:' + e.message;
    }
  }

  async function worker() {
    while (i < ids.length) {
      const id = ids[i++];
      const res = await probeOne(id);
      result[id] = res;
      const tag = res === 'ok' ? green('ok  ') : red(res.slice(0, 46).padEnd(46));
      console.log(`  ${tag}  ${id}`);
      await delay(800);
    }
  }
  console.log(dim(`probing ${ids.length} models against ${UPSTREAM} ...`));
  await Promise.all(Array.from({ length: concurrency }, worker));

  // drop models that no longer exist upstream (http404/400) from the id pool
  const okIds = Object.entries(result).filter(([, v]) => v === 'ok').map(([k]) => k);
  fs.writeFileSync(OUT, JSON.stringify(result, null, 1) + '\n');
  console.log(`\navailable: ${okIds.length}/${Object.keys(result).length} -> ${path.join(STATE_DIR, 'availability.json')}`);
  return result;
}
