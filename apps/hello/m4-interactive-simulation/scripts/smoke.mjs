#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const root = resolve(here, '..', '..', '..', '..');
const childEnv = { ...process.env, INIT_CWD: root };

function run(label, args) {
  try {
    execFileSync('pnpm', args, { cwd: root, env: childEnv, stdio: 'inherit' });
    console.log(`[m4-interactive] ${label}: PASS`);
  } catch (error) {
    const status = error?.status ?? 'unknown';
    throw new Error(`${label} failed with status ${status}`);
  }
}

try {
  run('physics gravity/readiness', ['--filter', '@forgeax/hello-physics', 'smoke']);
  run('character fixed-step/collision', ['--filter', '@forgeax/hello-character', 'smoke']);
  run('audio app lifecycle', ['--filter', '@forgeax/hello-audio', 'smoke']);
  run('audio browser gesture/spatial pan/collision cleanup', ['--filter', '@forgeax/hello-audio', 'smoke:browser']);
  run('2D physics ECS/KCC lifecycle', [
    'exec',
    'vitest',
    'run',
    'packages/physics-rapier2d/__tests__/moveandslide-2d.test.ts',
    'packages/physics-rapier2d/__tests__/free-fall-collision.test.ts',
    '--testNamePattern',
    'AC-12|ECS bridge|despawn|collision|free-fall|kinematic|gravity|error',
  ]);
  run('physics lifecycle tests', [
    'exec',
    'vitest',
    'run',
    'packages/physics-rapier3d/src/__tests__/physics-rapier3d.unit.test.ts',
    '--testNamePattern',
    'dynamic ball falls|moveAndSlide|CollidingEntities|childof-kinematic|despawn cleanup|hasBody readiness',
  ]);
  run('audio lifecycle tests', [
    'exec',
    'vitest',
    'run',
    'packages/audio-webaudio/src/__tests__/audio-webaudio.unit.test.ts',
    '--testNamePattern',
    'bus|routing|declarative playback|Entity despawn cleanup|listener getter|audioListenerSyncSystem|spatialBlend|edge detection|destroy then new backend|concurrent backends|F24',
  ]);
  console.log('[m4-interactive] PASS - M4 interactive simulation gates GREEN');
  console.log('[m4-interactive] deferred: replay remains outside this round.');
} catch (error) {
  console.error(`[m4-interactive] FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
