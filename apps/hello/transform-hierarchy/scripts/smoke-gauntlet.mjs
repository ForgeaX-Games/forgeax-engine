#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const root = resolve(appRoot, '..', '..', '..', '..');
const env = { ...process.env };

for (const [label, script] of [
  ['Dawn', 'smoke-dawn.mjs'],
  ['Browser', 'smoke-browser.mjs'],
]) {
  const result = spawnSync(process.execPath, [resolve(here, script)], {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error(`[m23] ${label} leg failed with status ${result.status ?? 'signal'}`);
    process.exit(result.status ?? 1);
  }
}

console.log('[m23] gauntlet: Dawn + Browser structured hierarchy recovery: PASS');
