/**
 * Anthropic Messages protocol <-> OpenAI chat/completions conversion.
 *
 * Serves Claude Code (ANTHROPIC_BASE_URL -> bridge /v1/messages), Trae and
 * ZCode (kind: "anthropic") — any client speaking the Anthropic Messages API.
 *
 *   anthropicToChat(r)        request  -> chat body (+ gate tools, aliases)
 *   makeAnthropicConverter()  chat SSE -> Anthropic SSE event stream
 *   anthropicResult()         aggregated chat chunks -> non-stream Anthropic JSON
 *   estimateTokens(r)         rough input_tokens for /messages/count_tokens
 *
 * Deliberate v0.3.0 simplifications (documented in README):
 *   - reasoning/thinking blocks are dropped both ways (free models emit
 *     deepseek-style reasoning; unrequested thinking blocks confuse clients).
 *   - images become "[image omitted]" (free-tier models are text-only).
 */
import { randomBytes } from 'node:crypto';
import { quotaLine } from './usage.mjs';
import { injectGateTools, mapBack } from './gate.mjs';

const ALPH = 'abcdefghijklmnopqrstuvwxyz0123456789';
const rand = (n) => Array.from({ length: n }, () => ALPH[randomBytes(1)[0] % 36]).join('');
const rid = () => randomBytes(8).toString('hex');

const anthropicStopToFinish = { end_turn: 'stop', max_tokens: 'length', tool_use: 'tool_calls', stop_sequence: 'stop' };
const finishToAnthropicStop = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'end_turn' };

function blockText(content) {
  // anthropic text-block array -> plain string (images/thinking degraded)
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const out = [];
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') out.push(b.text);
      else if (b.type === 'image') out.push('[image omitted]');
      else if (b.type === 'thinking' || b.type === 'redacted_thinking') { /* dropped */ }
      else if (typeof b.text === 'string') out.push(b.text);
    }
    return out.join('');
  }
  return String(content);
}

/** chat-format tool_choice -> anthropic tool_choice */
function toAnthropicToolChoice(tc) {
  if (tc == null) return undefined;
  if (tc === 'auto') return { type: 'auto' };
  if (tc === 'none') return { type: 'none' };
  if (tc === 'required') return { type: 'any' };
  if (typeof tc === 'object') {
    if (tc.type === 'function' && tc.function && tc.function.name) return { type: 'tool', name: tc.function.name };
    if (tc.type === 'function' && tc.name) return { type: 'tool', name: tc.name };
    if (tc.type === 'auto' || tc.type === 'any' || tc.type === 'none') return tc;
    if (tc.type === 'tool') return { type: 'tool', name: tc.name };
  }
  return undefined;
}

/**
 * Anthropic Messages request -> chat/completions body.
 * Returns { body, aliases, inputTokens } (body.model left for the caller to
 * resolve). The gate requires stream:true — the caller aggregates when the
 * client asked for a non-streaming reply.
 */
export function anthropicToChat(r) {
  const messages = [];
  const usageNote = quotaLine();

  // system: string | text blocks; quota note rides along so the model can
  // answer "额度还剩多少" in-chat from local data
  let sys = '';
  if (typeof r.system === 'string') sys = r.system;
  else if (Array.isArray(r.system)) sys = blockText(r.system);
  if (usageNote) sys = sys ? sys + '\n\n' + usageNote : usageNote;
  if (sys) messages.push({ role: 'system', content: sys });

  const input = Array.isArray(r.messages) ? r.messages : [];
  for (const m of input) {
    if (!m || typeof m !== 'object' || !m.role) continue;
    if (m.role === 'system') {
      // some proxies smuggle system into messages; fold it in
      const t = blockText(m.content);
      if (t) messages.push({ role: 'system', content: t });
      continue;
    }
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        if (m.content) messages.push({ role: 'user', content: m.content });
        continue;
      }
      const blocks = Array.isArray(m.content) ? m.content : [];
      const texts = [];
      let sawToolResult = false;
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') texts.push(String(b.text || ''));
        else if (b.type === 'tool_result') {
          sawToolResult = true;
          let c = '';
          if (typeof b.content === 'string') c = b.content;
          else if (Array.isArray(b.content)) {
            c = b.content
              .map((x) => (x && x.type === 'text' ? x.text : x && x.type === 'image' ? '[image omitted]' : JSON.stringify(x)))
              .join('\n');
          }
          messages.push({ role: 'tool', tool_call_id: String(b.tool_use_id || ''), content: c || '(no output)' });
        } else if (b.type === 'image') texts.push('[image omitted]');
        else if (b.type === 'thinking' || b.type === 'redacted_thinking') { /* dropped */ }
        else if (typeof b.text === 'string') texts.push(b.text);
      }
      const txt = texts.join('');
      if (txt) messages.push({ role: 'user', content: txt });
      else if (!sawToolResult && blocks.length === 0) messages.push({ role: 'user', content: '' });
    } else if (m.role === 'assistant') {
      if (typeof m.content === 'string') {
        if (m.content) messages.push({ role: 'assistant', content: m.content });
        continue;
      }
      const blocks = Array.isArray(m.content) ? m.content : [];
      const texts = [];
      const toolCalls = [];
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') texts.push(String(b.text || ''));
        else if (b.type === 'tool_use') {
          toolCalls.push({
            id: String(b.id || 'call_' + rid()),
            type: 'function',
            function: { name: String(b.name || ''), arguments: JSON.stringify(b.input || {}) },
          });
        } else if (b.type === 'thinking' || b.type === 'redacted_thinking') { /* dropped */ }
        else if (typeof b.text === 'string') texts.push(b.text);
      }
      const txt = texts.join('');
      if (toolCalls.length) messages.push({ role: 'assistant', content: txt || null, tool_calls: toolCalls });
      else if (txt) messages.push({ role: 'assistant', content: txt });
    }
  }
  if (!messages.length) messages.push({ role: 'user', content: '' });

  // tools: anthropic {name, description, input_schema} -> openai function tools
  const tools = [];
  const seen = new Set();
  for (const t of Array.isArray(r.tools) ? r.tools : []) {
    if (!t || typeof t !== 'object') continue;
    if (t.type && t.type !== 'function') continue; // skip anthropic custom tools
    const name = t.name || (t.function && t.function.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const parameters =
      (t.input_schema && typeof t.input_schema === 'object' && t.input_schema) ||
      (t.parameters && typeof t.parameters === 'object' && t.parameters) || { type: 'object', properties: {} };
    tools.push({ type: 'function', function: { name: String(name), description: String(t.description || ''), parameters } });
  }
  const aliases = injectGateTools(tools);

  const body = { messages, tools, stream: true }; // gate requires stream:true
  if (r.max_tokens != null && Number.isFinite(Number(r.max_tokens))) body.max_tokens = Number(r.max_tokens);
  if (r.temperature != null) body.temperature = r.temperature;
  if (r.top_p != null) body.top_p = r.top_p;
  if (r.top_k != null) body.top_k = r.top_k;
  if (r.stop_sequences && Array.isArray(r.stop_sequences) && r.stop_sequences.length) body.stop = r.stop_sequences;
  const tc = toAnthropicToolChoice(r.tool_choice);
  if (tc) body.tool_choice = tc;
  if (r.parallel_tool_calls !== undefined) body.parallel_tool_calls = !!r.parallel_tool_calls;

  const inputTokens = estimateTokens({ system: sys, messages, tools });
  return { body, aliases, inputTokens };
}

/** rough input token estimate (chars / 4) for count_tokens & message_start */
export function estimateTokens(sample) {
  try {
    return Math.max(1, Math.round(JSON.stringify(sample || {}).length / 4));
  } catch {
    return 1;
  }
}

/** POST /v1/messages/count_tokens -> { input_tokens } (local estimate) */
export function countTokens(r) {
  const sample = { system: r.system, messages: r.messages, tools: r.tools };
  return { input_tokens: estimateTokens(sample) };
}

/** upstream chat-format error body -> anthropic error envelope */
export function toAnthropicError(status, upstreamBody, upstreamType) {
  let type = 'api_error';
  if (status === 400) type = 'invalid_request_error';
  else if (status === 401 || status === 403) type = 'authentication_error';
  else if (status === 404) type = 'not_found_error';
  else if (status === 429) type = 'rate_limit_error';
  let message = `upstream error (HTTP ${status})`;
  try {
    const j = typeof upstreamBody === 'string' ? JSON.parse(upstreamBody) : upstreamBody;
    const e = (j && (j.error || j)) || {};
    if (e.message) message = String(e.message);
    if (e.type && typeof e.type === 'string' && e.type !== 'error') type = e.type;
  } catch { /* keep default */ }
  if (upstreamType === 'rate_limit' || /limit|quota/i.test(message)) type = 'rate_limit_error';
  return { type: 'error', error: { type, message } };
}

/**
 * chat SSE chunks -> Anthropic message event stream.
 * send(type, payload) writes `event: type\ndata: {...}\n\n` (payload carries
 * its own `type` field, per the Anthropic wire format).
 */
export function makeAnthropicConverter({ send, model, inputTokens, mapToolName = (n) => n }) {
  const msgId = 'msg_' + rid();
  let started = false;
  let blockIdx = 0;
  let textOpen = false;
  const toolBlocks = new Map(); // chat index -> { idx, id, name }
  let gotAnything = false;
  let usageRaw = null;
  let stopReason = null;

  const message = (extra = {}) => ({
    id: msgId,
    type: 'message',
    role: 'assistant',
    model: String(model || ''),
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: inputTokens || 0, output_tokens: 0 },
    ...extra,
  });

  const begin = () => {
    if (started) return;
    started = true;
    send('message_start', { type: 'message_start', message: message() });
  };

  const closeText = () => {
    if (!textOpen) return;
    textOpen = false;
    send('content_block_stop', { type: 'content_block_stop', index: blockIdx });
  };

  const handleChunk = (chunk) => {
    if (chunk && chunk.usage) usageRaw = chunk.usage;
    const choice = chunk && Array.isArray(chunk.choices) ? chunk.choices[0] : null;
    if (!choice) return;
    const delta = choice.delta || {};

    // reasoning dropped (see module header)
    if (typeof delta.content === 'string' && delta.content) {
      gotAnything = true;
      begin();
      if (!textOpen) {
        closeTools();
        blockIdx += 1;
        textOpen = true;
        send('content_block_start', { type: 'content_block_start', index: blockIdx, content_block: { type: 'text', text: '' } });
      }
      send('content_block_delta', {
        type: 'content_block_delta',
        index: blockIdx,
        delta: { type: 'text_delta', text: delta.content },
      });
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        if (!tc) continue;
        const ci = typeof tc.index === 'number' ? tc.index : 0;
        let rec = toolBlocks.get(ci);
        if (!rec) {
          gotAnything = true;
          begin();
          closeText();
          blockIdx += 1;
          rec = { idx: blockIdx, id: String(tc.id || 'toolu_' + rid()), name: mapToolName((tc.function && tc.function.name) || '') };
          toolBlocks.set(ci, rec);
          send('content_block_start', {
            type: 'content_block_start',
            index: rec.idx,
            content_block: { type: 'tool_use', id: rec.id, name: rec.name, input: {} },
          });
        }
        if (tc.function && typeof tc.function.name === 'string' && tc.function.name && !rec.name) {
          rec.name = mapToolName(tc.function.name);
        }
        if (tc.function && typeof tc.function.arguments === 'string' && tc.function.arguments) {
          send('content_block_delta', {
            type: 'content_block_delta',
            index: rec.idx,
            delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
          });
        }
      }
    }

    if (choice.finish_reason) stopReason = choice.finish_reason;
  };

  function closeTools() {
    for (const rec of toolBlocks.values()) {
      if (rec.closed) continue;
      rec.closed = true;
      send('content_block_stop', { type: 'content_block_stop', index: rec.idx });
    }
  }

  /** finish the anthropic message; returns { usage, stopReason } for recording */
  const finish = (status, errorMsg) => {
    if (status !== 'completed') {
      if (status === 'failed' && started) {
        send('error', { type: 'error', error: { type: 'api_error', message: String(errorMsg || 'upstream stream failed') } });
      }
      return { usage: usageRaw ? mapUsage(usageRaw) : null, stopReason };
    }
    begin();
    closeText();
    closeTools();
    const usage = usageRaw ? mapUsage(usageRaw) : null;
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: finishToAnthropicStop[stopReason] || 'end_turn', stop_sequence: null },
      usage: {
        ...(usage ? { input_tokens: usage.input_tokens } : { input_tokens: inputTokens || 0 }),
        output_tokens: usage ? usage.output_tokens : 0,
      },
    });
    send('message_stop', { type: 'message_stop' });
    return { usage, stopReason };
  };

  return { begin, handleChunk, finish, empty: () => !gotAnything && !usageRaw };
}

export function mapUsage(u) {
  if (!u) return null;
  const input = Number(u.prompt_tokens || u.input_tokens || 0) || 0;
  const output = Number(u.completion_tokens || u.output_tokens || 0) || 0;
  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
}

/**
 * Non-streaming: build the Anthropic message JSON from an aggregated chat
 * result ({ content, toolCalls:[{id,name,args}], finish, usage }).
 */
export function anthropicResult({ model, content, toolCalls, finish, usage, inputTokens }) {
  const blocks = [];
  if (content) blocks.push({ type: 'text', text: content });
  for (const tc of toolCalls || []) {
    let input = {};
    try { input = tc.args ? JSON.parse(tc.args) : {}; } catch { input = { _raw: tc.args }; }
    blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
  }
  if (!blocks.length) blocks.push({ type: 'text', text: '' });
  const u = usage || {};
  return {
    id: 'msg_' + rid(),
    type: 'message',
    role: 'assistant',
    model: String(model || ''),
    content: blocks,
    stop_reason: finishToAnthropicStop[finish] || (toolCalls && toolCalls.length ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: {
      input_tokens: Number(u.input_tokens ?? u.prompt_tokens ?? inputTokens ?? 0) || 0,
      output_tokens: Number(u.output_tokens ?? u.completion_tokens ?? 0) || 0,
    },
  };
}
