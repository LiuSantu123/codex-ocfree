/**
 * Generate ~/.codex/opencode.models.json — Codex `model_catalog_json` for the
 * OpenCode Zen free models, read from the models.dev cache inside opencode.db.
 *
 * Only models that pass availability.json are listed (set OC2C_ALL=1 to include
 * everything). `codex free-model-catalog` style output: slugs + ctx + reasoning.
 */
import fs from 'node:fs';
import { CATALOG, OPEND_DB, readAvailability, dim, green, yellow } from './config.mjs';

const BASE_INSTRUCTIONS =
  'You are Codex, a coding agent running in the Codex CLI. Follow the developer and user instructions supplied by the Codex harness.';

const MODELS_DEV_API = 'https://models.dev/api.json';

/**
 * Load the opencode model map. Sources, in order:
 *   1. models.dev cache inside ~/.local/share/opencode/opencode.db (works offline)
 *   2. https://models.dev/api.json (works without opencode installed)
 * Returns the models map { "<model-id>": {...} }.
 */
export async function loadModelsMap() {
  let dbErr = null;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(OPEND_DB, { readOnly: true });
    const raw = db.prepare("select value from kv where key='models-dev:catalog'").get().value;
    db.close();
    const parsed = JSON.parse(raw);
    const catalog = typeof parsed.body === 'string' ? JSON.parse(parsed.body) : parsed;
    const models = catalog.opencode && catalog.opencode.models;
    if (models && Object.keys(models).length) return models;
    throw new Error('opencode entry empty in db cache');
  } catch (e) {
    dbErr = e;
  }
  try {
    const r = await fetch(MODELS_DEV_API, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const api = await r.json();
    const models = api.opencode && api.opencode.models;
    if (!models || !Object.keys(models).length) throw new Error('no opencode models in models.dev response');
    console.log(dim(`(opencode.db 不可用: ${dbErr.message} — 已改从 models.dev 在线获取)`));
    return models;
  } catch (e2) {
    throw new Error(
      `无法获取模型元数据: opencode.db 失败(${dbErr.message}); models.dev 在线也失败(${e2.message})`,
    );
  }
}

/** cost.input === 0 && cost.output === 0 */
export const freeModels = (models) =>
  Object.values(models).filter((m) => m.cost && m.cost.input === 0 && m.cost.output === 0);

export async function genCatalog({ out = CATALOG, all = !!process.env.OC2C_ALL } = {}) {
  const availability = !all ? readAvailability() : null;

  const models = await loadModelsMap();
  const free = freeModels(models);
  const reachable = availability ? free.filter((m) => availability[m.id] === 'ok') : free;
  if (availability) {
    const dropped = free.filter((m) => availability[m.id] !== 'ok');
    if (dropped.length) console.log(yellow(`filtered out ${dropped.length} unreachable models (availability.json)`));
  }

  const entries = reachable.map((m) => {
    const ctx = (m.limit && m.limit.context) || 128000;
    const reasoning = !!m.reasoning;
    return {
      additional_speed_tiers: [],
      apply_patch_tool_type: 'freeform',
      availability_nux: null,
      base_instructions: BASE_INSTRUCTIONS,
      context_window: ctx,
      default_reasoning_level: reasoning ? 'medium' : 'low',
      default_reasoning_summary: reasoning ? 'auto' : 'none',
      default_verbosity: 'low',
      description: (m.description ? m.description + ' ' : '') + 'OpenCode Zen free model (no API key).',
      display_name: `${m.name} (OpenCode Free)`,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      // Codex only accepts text/image/audio (models.dev has some "video" entries)
      input_modalities: (() => {
        const mods = ((m.modalities && m.modalities.input) || ['text']).filter((x) =>
          ['text', 'image', 'audio'].includes(x),
        );
        return mods.length ? mods : ['text'];
      })(),
      max_context_window: ctx,
      priority: 10,
      service_tiers: [],
      shell_type: 'shell_command',
      slug: m.id,
      support_verbosity: false,
      supported_in_api: true,
      supported_reasoning_levels: reasoning
        ? [
            { description: 'Faster responses with lighter reasoning', effort: 'low' },
            { description: 'Balances speed and reasoning depth', effort: 'medium' },
            { description: 'Greater reasoning depth for complex tasks', effort: 'high' },
          ]
        : [],
      supports_image_detail_original: false,
      supports_parallel_tool_calls: true,
      supports_reasoning_summaries: reasoning,
      supports_search_tool: false,
      truncation_policy: { limit: 10000, mode: 'bytes' },
      upgrade: null,
      use_responses_lite: false,
      visibility: 'list',
      web_search_tool_type: 'text',
    };
  });

  entries.sort((a, b) => a.slug.localeCompare(b.slug));
  fs.writeFileSync(out, JSON.stringify({ models: entries }, null, 1) + '\n');
  console.log(`${green('wrote')} ${entries.length} free models -> ${out}`);
  for (const e of entries) console.log(dim(`  ${e.slug}  ctx=${e.context_window}  reasoning=${e.supports_reasoning_summaries}`));
  return entries;
}
