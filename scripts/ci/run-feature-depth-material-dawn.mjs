#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VITEST = resolve(ROOT, 'node_modules/vitest/vitest.mjs');
const TEST_FILE = 'packages/runtime/src/__tests__/feature-depth-material.dawn.test.ts';
const GROUPS = Object.freeze([
  ['depth-writer', '^samples depth written'],
  ['billboard-layout', 'billboard-material-input-instance'],
  ['topology-layout', 'topology'],
  ['mesh-layout', 'mesh-geometry-material-input-instance'],
]);

if (!existsSync(resolve(ROOT, TEST_FILE))) {
  throw new Error(`Dawn feature-depth entry does not exist: ${TEST_FILE}`);
}

for (const [groupName, testNamePattern] of GROUPS) {
  console.log(`[dawn-feature-depth] ${groupName}`);
  const exitCode = await new Promise((finish) => {
    const child = spawn(
      process.execPath,
      [
        VITEST,
        'run',
        '--project=dawn',
        '--isolate',
        '--maxWorkers=1',
        '--no-file-parallelism',
        TEST_FILE,
        '--testNamePattern',
        testNamePattern,
      ],
      {
        cwd: ROOT,
        env: { ...process.env, FORGEAX_DAWN_ISOLATED: '1' },
        stdio: 'inherit',
      },
    );
    child.once('error', (error) => {
      console.error(`[dawn-feature-depth] ${error instanceof Error ? error.message : error}`);
      finish(1);
    });
    child.once('exit', (code, signal) => {
      if (signal !== null) {
        console.error(`[dawn-feature-depth] ${groupName} terminated by ${signal}`);
        finish(1);
        return;
      }
      finish(code ?? 1);
    });
  });
  if (exitCode !== 0) {
    process.exitCode = exitCode;
    break;
  }
}
