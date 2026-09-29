#!/usr/bin/env node
import { main } from '../src/cli.mjs';

// Node 22 flags node:sqlite as experimental; keep install/output noise clean
// (the catalog generator imports it dynamically, long after this line runs).
const origEmitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes('SQLite is an experimental feature')) return;
  return origEmitWarning(warning, ...rest);
};

main().then(
  (code) => process.exit(Number(code) || 0),
  (err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  },
);
