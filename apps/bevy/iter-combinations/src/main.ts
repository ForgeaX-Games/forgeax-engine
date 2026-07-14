// apps/bevy/iter-combinations - reproduction of Bevy's `iter_combinations` example.
//
// Bevy source (references/repos/bevy/examples/ecs/iter_combinations.rs): an N-body
// gravity simulation. `interact_bodies` uses `query.iter_combinations_mut()` to
// apply each unordered PAIR's mutual gravitational force once; `integrate` then
// verlet-steps every body. Bodies attract and clump.
//
// forgeax mapping — an ECS-front-door MOTION demo:
//   - createApp -> owns the frame loop AND auto-inserts the 'Time' resource
//     (world.getResource('Time').dt) before each world.update().
//   - world.addSystem (x2, chained) -> stepInteract (pairwise force accumulation
//     via the new queryCombinations) then stepIntegrate (verlet), mirroring Bevy's
//     (interact_bodies, integrate) in FixedUpdate.
//   - stepInteract uses queryCombinations — the pairwise query iterator added in
//     solo round 20260713-194533, mapping Bevy's Query::iter_combinations_mut.
//
// The World + step math live in the shared src/iter-combinations.ts (SSOT for this
// app AND the dawn smoke), so the two never drift.

import { createApp } from '@forgeax/engine-app';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildIterCombinationsWorld, stepIntegrate, stepInteract } from './iter-combinations';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-iter-combinations: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[bevy-iter-combinations] no usable backend:', err);
  } else {
    console.error('[bevy-iter-combinations] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-iter-combinations] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  console.warn(`[bevy-iter-combinations] backend=${app.renderer.backend}`);

  buildIterCombinationsWorld(app.world);

  // Bevy: (interact_bodies, integrate) — accumulate pairwise forces first, then
  // verlet-integrate, both off Time.dt.
  app.world.addSystem({
    name: 'interact-bodies',
    queries: [],
    fn: (world) => {
      stepInteract(world);
    },
  });
  app.world.addSystem({
    name: 'integrate',
    queries: [],
    fn: (world) => {
      const dt = world.hasResource('Time') ? world.getResource<{ dt: number }>('Time').dt : 0;
      stepIntegrate(world, dt);
    },
  });

  const started = app.start();
  if (!started.ok) console.error('[bevy-iter-combinations] app.start failed:', started.error);
}
