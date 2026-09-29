/**
 * Bridge control: spawn src/bridge.mjs (start/stop/status/serve) and query health.
 * The bridge itself is a standalone script; codex-ocfree only drives it.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_BASE, BRIDGE_PORT } from './config.mjs';

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bridge.mjs');

export async function bridgeHealth(timeoutMs = 1500) {
  try {
    const r = await fetch(`${BRIDGE_BASE}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return await r.json(); // { ok, pid, port, upstream, ua }
  } catch {
    return null;
  }
}

/** Run `node src/bridge.mjs <cmd>` with inherited stdio. Resolves with exit code. */
export function bridgeCtl(cmd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE, cmd], { stdio: 'inherit', env: process.env });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (e) => {
      console.error(`failed to launch bridge: ${e.message}`);
      resolve(1);
    });
  });
}

/** Start the bridge if it is not already up. Returns the health object or null. */
export async function ensureBridge({ quiet = false } = {}) {
  const up = await bridgeHealth();
  if (up) {
    if (!quiet) console.log(`bridge already up on ${BRIDGE_BASE} (pid ${up.pid})`);
    return up;
  }
  const code = await bridgeCtl('start');
  if (code !== 0) return null;
  return bridgeHealth(8000);
}

export const port = BRIDGE_PORT;
