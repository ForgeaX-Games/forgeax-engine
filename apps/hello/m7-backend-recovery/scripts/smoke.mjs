#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const root = new URL('../../../..', import.meta.url).pathname;
const env = { ...process.env, INIT_CWD: root };

function run(label, args) {
  const result = spawnSync('pnpm', args, {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) throw new Error(`${label} failed with status ${result.status ?? 'unknown'}`);
  console.log(`[m7-backend] ${label}: PASS`);
  return result.stdout ?? '';
}

try {
  run('null/runtime lifecycle + injected renderer recovery', [
    '--filter',
    '@forgeax/engine-runtime',
    'exec',
    'vitest',
    'run',
    'src/__tests__/rhi-null-renderer-lifecycle.unit.test.ts',
    'src/__tests__/rhi-null-command-flow.unit.test.ts',
    'src/__tests__/rhi-null-noop-behavior.unit.test.ts',
    'src/__tests__/renderer-health.unit.test.ts',
    'src/__tests__/renderer-recover.unit.test.ts',
  ]);

  run('wgpu structured contracts', [
    '--filter',
    '@forgeax/engine-rhi-wgpu',
    'exec',
    'vitest',
    'run',
    'src/__tests__/rhi-wgpu.unit.test.ts',
  ]);

  run('browser submit recovery', [
    'exec',
    'vitest',
    'run',
    '--project',
    'browser',
    'packages/rhi-wgpu/src/__tests__/submit-error-fanout.browser.test.ts',
  ]);

  run('Dawn unsupported fallback rejection', [
    'exec',
    'vitest',
    'run',
    '--project',
    'dawn',
    'packages/runtime/src/__tests__/video-extract-bindgroup.dawn.test.ts',
  ]);

  run('Dawn resize/resource churn', ['--filter', '@forgeax/hello-bloom', 'smoke']);
  const browserCapture = run('browser WebGPU capture', ['--filter', '@forgeax/hello-cube', 'smoke:browser']);
  const captureMatch = browserCapture.match(
    /\[smoke-browser\] capture-artifacts: tape=(\S+) report=(\S+)/,
  );
  if (captureMatch?.[1] === undefined || captureMatch[2] === undefined) {
    throw new Error('browser capture did not publish tape/report paths for cross-backend replay');
  }
  run('same-scene cross-backend replay', [
    'exec',
    'node',
    'apps/hello/m7-backend-recovery/scripts/cross-backend-replay.mjs',
    captureMatch[1],
    captureMatch[2],
  ]);
  run('debug-only tree-shake', [
    '--filter',
    '@forgeax/engine-rhi-debug',
    'exec',
    'vitest',
    'run',
    'src/__tests__/tree-shake.unit.test.ts',
  ]);

  console.log('[m7-backend] PASS - M7 backend/recovery evidence GREEN');
  console.log(
    '[m7-backend] deferred: real hardware device-loss rebuild remains open.',
  );
} catch (error) {
  console.error(`[m7-backend] FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
