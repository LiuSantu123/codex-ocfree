#!/usr/bin/env node
/**
 * codex-ocfree protocol bridge
 *
 * Codex (OpenAI Responses API, wire_api="responses")
 *        <-->  local HTTP bridge  <-->  OpenCode Zen free models (chat/completions)
 *
 * Upstream gate requirements (verified empirically 2026-09):
 *   - URL      : https://opencode.ai/inference/openai/v1/chat/completions
 *     (free models on /responses return ModelProtocolUnsupported; /zen/v1 returns 403)
 *   - UA       : opencode/<semver>/cli  (>= some minimum semver; "latest" channel ok)
 *   - session  : "ses_" + 12 lowercase hex + 14 alnum
 *   - body     : stream:true AND tools[] must contain names "read" AND "shell"
 *   - auth     : optional; a fresh OAuth token from opencode.db is used when available,
 *     otherwise no Authorization header (both return 200; a stale token returns 401)
 *
 * Commands (normally driven by `codex-ocfree up|down|status`):
 *   node src/bridge.mjs            foreground server
 *   node src/bridge.mjs start      daemonize (pid/log in ~/.codex-ocfree/)
 *   node src/bridge.mjs stop
 *   node src/bridge.mjs status
 *
 * Env: OC2C_PORT(8973) OC2C_HOST OC2C_UPSTREAM OC2C_UA OC2C_DB OC2C_CATALOG
 *      OC2C_TIMEOUT_MS(600000) OC2C_STATE(~/.codex-ocfree)
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STATE_DIR = process.env.OC2C_STATE || path.join(os.homedir(), '.codex-ocfree');
fs.mkdirSync(STATE_DIR, { recursive: true });
const PID_FILE = path.join(STATE_DIR, 'bridge.pid');
const LOG_FILE = path.join(STATE_DIR, 'bridge.log');

const PORT = Number(process.env.OC2C_PORT || 8973);
const HOST = process.env.OC2C_HOST || '127.0.0.1';
const UPSTREAM = String(process.env.OC2C_UPSTREAM || 'https://opencode.ai/inference/openai/v1').replace(/\/+$/, '');
const UA = process.env.OC2C_UA || 'opencode/2.0.18/cli';
const DB_PATH = process.env.OC2C_DB || path.join(os.homedir(), '.local/share/opencode/opencode.db');
const CATALOG_PATH = process.env.OC2C_CATALOG || path.join(os.homedir(), '.codex/opencode.models.json');
const REQ_TIMEOUT_MS = Number(process.env.OC2C_TIMEOUT_MS || 10 * 60 * 1000);

/** Gate: request must advertise tools with these exact names (mapped back to exec_command). */
const GATE_TOOL_NAMES = ['read', 'shell'];

const ALPH = 'abcdefghijklmnopqrstuvwxyz0123456789';
const rand = (n) => Array.from({ length: n }, () => ALPH[randomBytes(1)[0] % 36]).join('');
const rid = () => randomBytes(8).toString('hex');
const log = (...a) => console.error(`[oc2c ${new Date().toISOString()}]`, ...a);

function newSessionId() {
  // "ses_" + 12 lowercase hex + 14 alphanumeric (verified gate format)
  return 'ses_' + randomBytes(6).toString('hex') + rand(14);
}

/* ------------------------------------------------------------------ auth -- */

let authCache = { value: null, ts: 0, loaded: false };
async function loadAuthToken() {
  const now = Date.now();
  if (authCache.loaded && now - authCache.ts < 300000) return authCache.value;
  authCache = { value: null, ts: now, loaded: true };
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    const row = db.prepare('select value from credential').get();
    db.close();
    const cred = JSON.parse(row.value);
    if (cred.access && Number(cred.expires || 0) > now + 60000) {
      authCache.value = cred.access;
      log('auth: using OAuth token from opencode.db');
    } else {
      log('auth: no fresh token, going anonymous');
    }
  } catch (e) {
    log('auth: cannot read credential (' + e.message + '), going anonymous');
  }
  return authCache.value;
}

async function gateHeaders() {
  const h = {
    'content-type': 'application/json',
    'user-agent': UA,
    'x-opencode-session': newSessionId(),
    'x-opencode-client': 'cli',
  };
  const tok = await loadAuthToken();
  if (tok) h.authorization = `Bearer ${tok}`;
  return h;
}

/* --------------------------------------------- responses -> chat/completions -- */

function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const out = [];
    for (const p of content) {
      if (p == null) continue;
      if (typeof p === 'string') { out.push(p); continue; }
      if (typeof p.text === 'string') { out.push(p.text); continue; }
      if (p.type === 'input_image' || p.type === 'output_image' || p.image_url) out.push('[image omitted]');
    }
    return out.join('');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return String(content);
}

/**
 * Convert Codex Responses-API request -> chat/completions body.
 * Returns { body, aliases } where aliases = set of gate tool names we injected
 * (used to map function-call names back to exec_command on the response path).
 */
function toChatBody(r) {
  const messages = [];
  if (r.instructions) messages.push({ role: 'system', content: String(r.instructions) });

  const input =
    typeof r.input === 'string'
      ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: r.input }] }]
      : Array.isArray(r.input) ? r.input : [];

  let pendingToolCalls = null;
  const flushToolCalls = () => {
    if (pendingToolCalls && pendingToolCalls.length) {
      messages.push({ role: 'assistant', content: null, tool_calls: pendingToolCalls });
    }
    pendingToolCalls = null;
  };

  for (const it of input) {
    if (!it || typeof it !== 'object') continue;
    const type = it.type || (it.role && it.content !== undefined ? 'message' : null);
    if (type === 'message') {
      const role = it.role === 'developer' ? 'system' : it.role === 'tool' ? 'tool' : it.role;
      if (!role) continue;
      flushToolCalls();
      const text = textOf(it.content);
      if (role === 'tool') messages.push({ role: 'tool', tool_call_id: it.call_id || '', content: text });
      else messages.push({ role, content: text });
    } else if (type === 'function_call') {
      if (!pendingToolCalls) pendingToolCalls = [];
      pendingToolCalls.push({
        id: it.call_id || it.id || 'call_' + rid(),
        type: 'function',
        function: {
          name: String(it.name || ''),
          arguments: typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments || {}),
        },
      });
    } else if (type === 'function_call_output') {
      flushToolCalls(); // tool results must directly follow their assistant tool_calls msg
      messages.push({
        role: 'tool',
        tool_call_id: it.call_id || '',
        content: typeof it.output === 'string' ? it.output : textOf(it.output),
      });
    } else if (type === 'reasoning') {
      // encrypted reasoning is not portable; skip
    } else {
      log('toChat: skipping unknown input item type', type);
    }
  }
  flushToolCalls();

  // tools: keep only function tools (drop namespace/web_search/etc. — chat API
  // doesn't understand them), then inject gate tools "read"/"shell".
  const tools = [];
  const seen = new Set();
  for (const t of Array.isArray(r.tools) ? r.tools : []) {
    if (!t || t.type !== 'function' || !t.name || seen.has(t.name)) continue;
    seen.add(t.name);
    const fn = { name: String(t.name), description: String(t.description || '') };
    fn.parameters = t.parameters && typeof t.parameters === 'object' ? t.parameters : { type: 'object', properties: {} };
    tools.push({ type: 'function', function: fn });
  }
  const aliases = new Set();
  const exec = tools.find((t) => t.function.name === 'exec_command');
  const fallbackParams = {
    type: 'object',
    properties: { cmd: { type: 'string', description: 'Shell command to execute.' } },
    required: ['cmd'],
  };
  for (const g of GATE_TOOL_NAMES) {
    if (seen.has(g)) continue;
    const src = exec ? exec.function : { name: g, description: 'Runs a shell command.', parameters: fallbackParams };
    tools.push({
      type: 'function',
      function: {
        name: g,
        description: 'Alias of exec_command. ' + (src.description || ''),
        parameters: src.parameters,
      },
    });
    aliases.add(g);
    seen.add(g);
  }

  const body = {
    model: String(r.model || '').replace(/^opencode\//, ''),
    messages,
    tools,
    stream: true, // gate requires stream:true
    stream_options: { include_usage: true },
  };
  if (r.reasoning && r.reasoning.effort) body.reasoning_effort = r.reasoning.effort;
  if (typeof r.tool_choice === 'string') body.tool_choice = r.tool_choice;
  else if (r.tool_choice && r.tool_choice.type === 'function' && r.tool_choice.name)
    body.tool_choice = { type: 'function', function: { name: r.tool_choice.name } };
  if (r.parallel_tool_calls !== undefined) body.parallel_tool_calls = !!r.parallel_tool_calls;

  return { body, aliases };
}

/* --------------------------------------- chat SSE stream -> responses events -- */

function makeConverter(r, send, aliases) {
  const resp = {
    id: 'resp_' + rid(),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'in_progress',
    model: r.model || '',
    output: [],
    instructions: r.instructions ?? null,
    tools: Array.isArray(r.tools) ? r.tools : [],
    tool_choice: typeof r.tool_choice === 'string' ? r.tool_choice : 'auto',
    parallel_tool_calls: !!r.parallel_tool_calls,
    error: null,
    incomplete_details: null,
    usage: null,
    metadata: {},
  };

  const items = []; // {idx, item} in output order
  const pushItem = (idx, item) => { items.push({ idx, item }); };
  let outIdx = 0;

  let msg = null;      // {idx, id, text}
  let reason = null;   // {idx, id, text}
  const toolCalls = new Map(); // chat index -> {idx, item, callId, name, args}
  let gotAnything = false;
  let usageRaw = null;
  const emitted = [];

  const ev = (type, data) => {
    const payload = { type, ...data };
    emitted.push(payload);
    send(type, payload);
  };

  const finishReasoning = () => {
    if (!reason) return;
    const { idx, id, text } = reason;
    reason = null;
    ev('response.reasoning_summary_text.done', { item_id: id, output_index: idx, summary_index: 0, text });
    ev('response.reasoning_summary_part.done', {
      item_id: id, output_index: idx, summary_index: 0,
      part: { type: 'summary_text', text },
    });
    const it = items.find((x) => x.idx === idx);
    if (it) { it.item.summary = [{ type: 'summary_text', text }]; it.item.status = 'completed'; }
    ev('response.output_item.done', { output_index: idx, item: it ? it.item : { type: 'reasoning', id, summary: [{ type: 'summary_text', text }], status: 'completed' } });
  };

  const finishMessage = () => {
    if (!msg) return;
    const { idx, id, text } = msg;
    msg = null;
    const part = { type: 'output_text', text, annotations: [] };
    ev('response.output_text.done', { item_id: id, output_index: idx, content_index: 0, text });
    ev('response.content_part.done', { item_id: id, output_index: idx, content_index: 0, part });
    const it = items.find((x) => x.idx === idx);
    if (it) { it.item.content = [part]; it.item.status = 'completed'; }
    ev('response.output_item.done', { output_index: idx, item: it ? it.item : { type: 'message', id, role: 'assistant', status: 'completed', content: [part] } });
  };

  const mapToolName = (name) => (aliases && aliases.has(name) ? 'exec_command' : name);

  const handleChunk = (chunk) => {
    if (chunk && chunk.usage) usageRaw = chunk.usage;
    const choice = chunk && Array.isArray(chunk.choices) ? chunk.choices[0] : null;
    if (!choice) return;
    const delta = choice.delta || {};

    if (typeof delta.reasoning === 'string' && delta.reasoning) {
      gotAnything = true;
      if (!reason) {
        finishMessage(); // a fresh reasoning block after text (rare) gets its own item
        const idx = outIdx++;
        const id = 'rs_' + rid();
        reason = { idx, id, text: '' };
        pushItem(idx, { type: 'reasoning', id, summary: [], status: 'in_progress' });
        ev('response.output_item.added', { output_index: idx, item: { type: 'reasoning', id, summary: [], status: 'in_progress' } });
        ev('response.reasoning_summary_part.added', {
          item_id: id, output_index: idx, summary_index: 0,
          part: { type: 'summary_text', text: '' },
        });
      }
      reason.text += delta.reasoning;
      ev('response.reasoning_summary_text.delta', { item_id: reason.id, output_index: reason.idx, summary_index: 0, delta: delta.reasoning });
    }

    if (typeof delta.content === 'string' && delta.content) {
      gotAnything = true;
      finishReasoning();
      if (!msg) {
        const idx = outIdx++;
        const id = 'msg_' + rid();
        msg = { idx, id, text: '' };
        pushItem(idx, { type: 'message', id, role: 'assistant', status: 'in_progress', content: [] });
        ev('response.output_item.added', { output_index: idx, item: { type: 'message', id, role: 'assistant', status: 'in_progress', content: [] } });
        ev('response.content_part.added', { item_id: id, output_index: idx, content_index: 0, part: { type: 'output_text', text: '' } });
      }
      msg.text += delta.content;
      ev('response.output_text.delta', { item_id: msg.id, output_index: msg.idx, content_index: 0, delta: delta.content, logprobs: [] });
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        if (!tc) continue;
        const ci = typeof tc.index === 'number' ? tc.index : 0;
        let rec = toolCalls.get(ci);
        if (!rec) {
          gotAnything = true;
          finishReasoning();
          finishMessage(); // function_call items follow the message item
          const idx = outIdx++;
          const callId = tc.id || 'call_' + rid();
          const name = mapToolName((tc.function && tc.function.name) || '');
          rec = {
            idx, callId, name, args: '',
            item: { type: 'function_call', id: 'fc_' + rid(), call_id: callId, name, arguments: '', status: 'in_progress' },
          };
          toolCalls.set(ci, rec);
          pushItem(idx, rec.item);
          ev('response.output_item.added', { output_index: idx, item: rec.item });
        }
        if (tc.id && !rec.item.call_id) rec.item.call_id = rec.callId = tc.id;
        if (tc.function && tc.function.name && !rec.name) {
          rec.name = rec.item.name = mapToolName(tc.function.name);
        }
        if (tc.function && typeof tc.function.arguments === 'string' && tc.function.arguments) {
          rec.args += tc.function.arguments;
          ev('response.function_call_arguments.delta', { item_id: rec.item.id, output_index: rec.idx, delta: tc.function.arguments });
        }
      }
    }
  };

  const finish = (status, errorMsg) => {
    finishReasoning();
    finishMessage();
    for (const rec of toolCalls.values()) {
      if (rec.item.status !== 'in_progress') continue;
      ev('response.function_call_arguments.done', { item_id: rec.item.id, output_index: rec.idx, arguments: rec.args });
      rec.item.arguments = rec.args;
      rec.item.status = 'completed';
      ev('response.output_item.done', { output_index: rec.idx, item: rec.item });
    }
    resp.output = items.sort((a, b) => a.idx - b.idx).map((x) => x.item);
    resp.status = status;
    if (status === 'failed') {
      resp.error = { code: 'bridge_error', message: String(errorMsg || 'upstream stream failed') };
    }
    resp.usage = mapUsage(usageRaw);
    if (status === 'completed') ev('response.completed', { response: resp });
    else if (status === 'failed') ev('response.failed', { response: resp });
    else ev('response.incomplete', { response: resp });
    return resp;
  };

  return {
    begin() {
      ev('response.created', { response: { ...resp, output: [] } });
      ev('response.in_progress', { response: { ...resp, output: [] } });
    },
    handleChunk,
    finish,
    empty: () => !gotAnything && !usageRaw,
    get response() { return resp; },
  };
}

function mapUsage(u) {
  if (!u) return { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 };
  return {
    input_tokens: u.prompt_tokens || 0,
    input_tokens_details: { cached_tokens: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0 },
    output_tokens: u.completion_tokens || 0,
    output_tokens_details: { reasoning_tokens: (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0 },
    total_tokens: u.total_tokens || ((u.prompt_tokens || 0) + (u.completion_tokens || 0)),
  };
}

/* ------------------------------------------------------------ HTTP plumbing -- */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 64 * 1024 * 1024) { reject(new Error('request body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

function jsonReply(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

async function postChat(body, allowAuthRetry = true) {
  const headers = await gateHeaders();
  let resp = await fetch(`${UPSTREAM}/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
  });
  if (resp.status === 401 && headers.authorization && allowAuthRetry) {
    log('upstream 401 with token, retrying anonymous');
    const h2 = { ...headers };
    delete h2.authorization;
    h2['x-opencode-session'] = newSessionId();
    resp = await fetch(`${UPSTREAM}/chat/completions`, {
      method: 'POST', headers: h2, body: JSON.stringify(body), signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
  }
  return resp;
}

async function handleResponses(req, res) {
  let r;
  try {
    r = JSON.parse((await readBody(req)) || '{}');
  } catch (e) {
    return jsonReply(res, 400, { error: { message: 'invalid JSON: ' + e.message, type: 'invalid_request_error' } });
  }

  const { body: chatBody, aliases } = toChatBody(r);
  log(`responses: model=${chatBody.model} msgs=${chatBody.messages.length} tools=${chatBody.tools.length} aliases=${[...aliases].join(',')}`);

  let upstream;
  try {
    upstream = await postChat(chatBody);
  } catch (e) {
    return jsonReply(res, 502, { error: { message: 'bridge: upstream request failed: ' + e.message, type: 'upstream_error' } });
  }

  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => '');
    log(`upstream ${upstream.status}: ${txt.slice(0, 300)}`);
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
    return res.end(txt);
  }

  const streaming = r.stream !== false;

  if (!streaming) {
    // aggregate then return a single Response object
    const conv = makeConverter(r, () => {}, aliases);
    conv.begin();
    const decoder = new TextDecoder();
    let buf = '', done = false;
    try {
      for await (const chunk of upstream.body) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { done = true; break; }
          try { conv.handleChunk(JSON.parse(data)); } catch { /* skip malformed */ }
        }
        if (done) break;
      }
    } catch (e) {
      log('stream read error:', e.message);
      return jsonReply(res, 502, { error: { message: 'bridge: upstream stream error: ' + e.message, type: 'upstream_error' } });
    }
    const finalStatus = conv.empty() ? 'failed' : 'completed';
    const final = conv.finish(finalStatus, finalStatus === 'failed' ? 'upstream returned an empty stream' : null);
    return jsonReply(res, finalStatus === 'failed' ? 502 : 200, final);
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

  const conv = makeConverter(r, send, aliases);
  conv.begin();

  const clientGone = new Promise((resolve) => req.on('close', resolve));
  const decoder = new TextDecoder();
  let buf = '', done = false, finished = false;
  const finalize = (status, msg) => {
    if (finished) return;
    finished = true;
    try { conv.finish(status, msg); } catch (e) { log('finish error:', e.message); }
    res.end();
  };

  try {
    const bodyIter = (async () => {
      for await (const chunk of upstream.body) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { done = true; break; }
          let obj;
          try { obj = JSON.parse(data); } catch { continue; }
          conv.handleChunk(obj);
        }
        if (done) break;
      }
    })();
    const winner = await Promise.race([bodyIter.then(() => 'body'), clientGone.then(() => 'client')]);
    if (winner === 'client') {
      log('client disconnected, aborting upstream');
      try { await upstream.body.cancel(); } catch { /* ignore */ }
      return;
    }
    if (conv.empty()) finalize('failed', 'upstream returned an empty stream');
    else finalize('completed');
  } catch (e) {
    log('stream error:', e.message);
    if (!finished) {
      try { conv.finish('failed', e.message); } catch { /* ignore */ }
      finished = true;
      res.end();
    }
  }
}

function handleModels(res) {
  let models = [];
  try {
    const cat = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    models = (cat.models || []).map((m) => ({
      id: m.slug, object: 'model', created: 0, owned_by: 'opencode',
    }));
  } catch { /* no catalog */ }
  jsonReply(res, 200, { object: 'list', data: models });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];
  try {
    if (req.method === 'GET' && (url === '/health' || url === '/healthz')) {
      return jsonReply(res, 200, { ok: true, pid: process.pid, port: PORT, upstream: UPSTREAM, ua: UA });
    }
    if (req.method === 'GET' && /\/models$/.test(url)) return handleModels(res);
    if (req.method === 'POST' && /\/responses$/.test(url)) return await handleResponses(req, res);
    jsonReply(res, 404, { error: { message: `no route: ${req.method} ${url}`, type: 'invalid_request_error' } });
  } catch (e) {
    log('handler error:', e.stack || e.message);
    if (!res.headersSent) jsonReply(res, 500, { error: { message: String(e.message), type: 'bridge_error' } });
    else try { res.end(); } catch { /* ignore */ }
  }
});

/* ------------------------------------------------------------ mgmt commands -- */

function isUp() {
  return fetch(`http://${HOST}:${PORT}/health`, { signal: AbortSignal.timeout(2000) })
    .then((r) => r.ok)
    .catch(() => false);
}

async function waitForUp(ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await isUp()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const cmd = process.argv[2] || 'serve';

if (cmd === 'start') {
  if (await isUp()) { console.log(`bridge already running on :${PORT}`); process.exit(0); }
  const logFd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    detached: true, stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  if (await waitForUp()) {
    fs.writeFileSync(PID_FILE, String(child.pid));
    console.log(`bridge started on http://${HOST}:${PORT} (pid ${child.pid}, log ${LOG_FILE})`);
  } else {
    console.error('bridge failed to start; see ' + LOG_FILE);
    process.exit(1);
  }
} else if (cmd === 'stop') {
  let pid = null;
  try { pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim()); } catch { /* fall through */ }
  if (!pid && (await isUp())) {
    // pid file missing but server answers: nothing safe to kill without pid
    console.log(`bridge is up on :${PORT} but no pid file; run: fuser -k ${PORT}/tcp`);
    process.exit(0);
  }
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); console.log(`stopped bridge pid ${pid}`); }
    catch (e) { console.log('bridge not running (' + e.message + ')'); }
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  } else console.log('bridge not running');
} else if (cmd === 'status') {
  const up = await isUp();
  console.log(up ? `bridge up on http://${HOST}:${PORT}` : 'bridge down');
  process.exit(up ? 0 : 1);
} else {
  server.listen(PORT, HOST, () => log(`listening on http://${HOST}:${PORT} -> ${UPSTREAM} (ua=${UA})`));
  const writePid = () => { try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch { /* ignore */ } };
  server.on('listening', writePid);
  process.on('SIGTERM', () => { try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ } server.close(() => process.exit(0)); });
}
