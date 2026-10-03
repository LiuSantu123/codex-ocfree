/**
 * Upstream gate tool injection for non-Codex clients (OpenAI chat / Anthropic).
 *
 * The upstream requires every request body to advertise tools named exactly
 * "read" and "shell" (verified empirically). Codex has exec_command and gets
 * the legacy alias treatment inside bridge.mjs; other agents (Claude Code,
 * dsh, opencode, ...) carry their own equivalents (Bash/Read/bash/read/...).
 *
 * Strategy: inject a tool literally named read/shell that CLONES the client's
 * equivalent tool (description + JSON schema), so when the model calls the
 * injected name the bridge only renames it back — arguments round-trip
 * unchanged. Gate names are matched case-sensitively (exact strings), role
 * detection is case-insensitive.
 */

export const GATE_TOOL_NAMES = ['read', 'shell'];

const FALLBACK_PARAMS = {
  shell: {
    type: 'object',
    properties: { cmd: { type: 'string', description: 'Shell command to execute.' } },
    required: ['cmd'],
  },
  read: {
    type: 'object',
    properties: { path: { type: 'string', description: 'File path to read.' } },
    required: ['path'],
  },
};

const ROLE_NAMES = {
  shell: ['bash', 'execute', 'execute_bash', 'execute_command', 'run_command', 'run_terminal_cmd', 'terminal', 'powershell', 'exec_command', 'run', 'command'],
  read: ['read_file', 'open_file', 'view_file', 'view', 'cat', 'readtext', 'file_read'],
};
const ROLE_DESC = {
  shell: /shell command|run(?:s)? (?:a |the )?(?:shell|bash|command)|execute.*(?:command|bash)|terminal command/i,
  read: /read(?:s)? (?:a |the )?file|file(?:'s)? content|view (?:a |the )?file/i,
};

function normName(n) {
  return String(n || '').toLowerCase();
}

/** Find the client's tool playing `role` ('shell'|'read'); null when none. */
export function pickByRole(tools, role) {
  const lower = tools.map((t) => normName(t.function && t.function.name));
  for (const want of ROLE_NAMES[role]) {
    const i = lower.indexOf(want);
    if (i >= 0) return tools[i];
  }
  const re = ROLE_DESC[role];
  const i = tools.findIndex((t) => re.test(String((t.function && t.function.description) || '')));
  return i >= 0 ? tools[i] : null;
}

/**
 * Inject gate tools into an OpenAI-format tools[] array (mutates it).
 *
 * @param {Array} tools  chat-format tools ({type:'function', function:{...}})
 * @returns {Map<string,string|null>} gate name -> equivalent client tool name,
 *          or null when the client has no equivalent (fallback schema used,
 *          calls keep the gate name). A gate name already present verbatim
 *          maps to itself and is left untouched.
 */
export function injectGateTools(tools) {
  const aliases = new Map();
  const exact = new Map(tools.map((t) => [String(t.function && t.function.name), t]));
  for (const g of GATE_TOOL_NAMES) {
    if (exact.has(g)) {
      aliases.set(g, g);
      continue;
    }
    const src = pickByRole(tools, g);
    tools.push({
      type: 'function',
      function: {
        name: g,
        description:
          (src ? `Alias of ${src.function.name}. ` : '') +
          String((src && src.function.description) || (g === 'shell' ? 'Runs a shell command.' : 'Reads a file.')),
        parameters:
          (src && src.function.parameters && typeof src.function.parameters === 'object' && src.function.parameters.type
            ? src.function.parameters
            : null) || FALLBACK_PARAMS[g],
      },
    });
    aliases.set(g, src ? String(src.function.name) : null);
  }
  return aliases;
}

/** Map a model-issued tool name back to the client's original name. */
export function mapBack(name, aliases) {
  const hit = aliases.get(name);
  return hit == null ? name : hit;
}
