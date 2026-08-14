#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageName = '@forgeax/app-learn-render-4-advanced-opengl-5-framebuffers';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

for (const script of ['smoke', 'smoke:browser', 'smoke:browser-live']) {
  const result = spawnSync('pnpm', ['--filter', packageName, script], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
