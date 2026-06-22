#!/usr/bin/env node
// postinstall.mjs — graceful-degrade native addon rebuild.
//
// Per requirements AC-13 + plan-strategy S5.1 TDD-exempt:
//   - FBX_SDK_ROOT not set or invalid → warn + exit 0
//   - FBX_SDK_ROOT set + SDK present → run node-gyp rebuild
//   - Rebuild failure → warn + exit 0 (never block workspace install)

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SDK_ROOT = process.env.FBX_SDK_ROOT;
const CWD = dirname(dirname(fileURLToPath(import.meta.url))); // packages/fbx/

if (!SDK_ROOT || !existsSync(SDK_ROOT)) {
  console.warn(
    'FBX_SDK_ROOT not set or invalid; @forgeax/engine-fbx native binding skipped. ' +
      'Set FBX_SDK_ROOT to enable.',
  );
  process.exit(0);
}

const includeDir = join(SDK_ROOT, 'include');
if (!existsSync(includeDir)) {
  console.warn(
    `FBX_SDK_ROOT is set (${SDK_ROOT}) but include/ directory not found; ` +
      '@forgeax/engine-fbx native binding skipped.',
  );
  process.exit(0);
}

try {
  execSync('npx node-gyp rebuild', {
    cwd: CWD,
    stdio: 'inherit',
    env: { ...process.env, FBX_SDK_ROOT: resolve(SDK_ROOT) },
  });
} catch (_err) {
  console.warn(
    'node-gyp rebuild failed; @forgeax/engine-fbx native binding skipped. ' +
      'Run `pnpm rebuild @forgeax/engine-fbx` manually to retry.',
  );
  process.exit(0);
}