// apps/inspector-demo - Inspector P0 host harness (feat-20260516-console-dependency-inversion / w5m).
//
// Post-M5 wiring (charter proposition 1 progressive disclosure + plan-strategy
// section 3.3 success path): host assembly imports `Registry` /
// `wireDefaultInspectors` / `startConsoleServer` from `@forgeax/engine-console`
// directly; the engine-runtime no longer carries `Renderer.startConsole`.
//
// ECS-driven 5-component spawn form mirrors apps/hello/cube/src/main.ts: both demos share
// the same canonical 3-entity demo World via apps/shared/src/populate-demo-world.ts.
//
// AI-user-facing CLI demos to try after `pnpm --filter inspector-demo dev`:
//
//   forgeax-engine-console inspect entities --with Transform
//   forgeax-engine-console inspect components
//   forgeax-engine-console inspect world
//   forgeax-engine-console eval "world.inspect().entityCount"
//
// See AGENTS.md "Inspector / Console" section for the full CLI surface.

import { Registry, wireDefaultInspectors } from '@forgeax/engine-console';
import { startConsoleServer } from '@forgeax/engine-console/server';
import { registerEcsInspector, World } from '@forgeax/engine-ecs';
import {
  acquireCanvasContext,
  createRenderer,
  EngineEnvironmentError,
  registerRuntimeInspector,
} from '@forgeax/engine-runtime';
import { populateDemoWorld } from '../../shared/src/populate-demo-world';

const world = new World();
populateDemoWorld(world);

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('inspector-demo: missing <canvas id="app"> in index.html');
bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError)
    console.error('[inspector-demo] no usable backend:', err);
  else console.error('[inspector-demo] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const renderer = await createRenderer(target, {});
  const ctxResult = acquireCanvasContext(target);
  if (ctxResult.ok) {
    const cfgResult = ctxResult.value.configure({
      device: renderer.device,
      format: 'rgba8unorm',
      usage: 0x10 | 0x01,
    });
    if (!cfgResult.ok)
      console.error('[inspector-demo] canvasContext.configure failed:', cfgResult.error);
  } else {
    console.error('[inspector-demo] acquireCanvasContext failed:', ctxResult.error);
  }
  console.warn(`[inspector-demo] backend=${renderer.backend}`);

  // Inspector wiring (post-M5 dependency inversion: host owns the assembly).
  // wireDefaultInspectors registers the 3 roots (world / engine / assets) +
  // the canonical ecs/runtime contributor methods on the Registry; the
  // server reads them via registry.lookupRoot / registry.lookupMethod.
  // The host imports register*Inspector from the domain packages and passes
  // them in as the third argument; @forgeax/engine-console therefore never
  // value-imports @forgeax/engine-{ecs,runtime} (round 2 amendment —
  // physical guarantee behind AC-01 / AC-02 strict 4-deny-list).
  // plan-strategy section 3.3 success path; requirements G3 + AC-04 +
  // section 10.1 three-root contract.
  const reg = new Registry();
  const wired = wireDefaultInspectors(
    reg,
    {
      world,
      engine: renderer,
      assets: renderer.assets,
    },
    { registerEcsInspector, registerRuntimeInspector },
  );
  if (!wired.ok) {
    console.error('[inspector-demo] wireDefaultInspectors failed:', wired.error);
    return;
  }
  const consoleResult = await startConsoleServer({ port: 5732, registry: reg });
  if (!consoleResult.ok) {
    console.error('[inspector-demo] startConsoleServer failed:', consoleResult.error);
    return;
  }
  console.warn(
    `[inspector-demo] inspector server on ws://localhost:${consoleResult.value.port}/inspector`,
  );
  console.warn('[inspector-demo] try: forgeax-engine-console inspect entities --with Transform');

  const ready = await renderer.ready;
  if (!ready.ok) {
    console.error('[inspector-demo] renderer.ready failed:', ready.error);
    return;
  }
  const frame = (): void => {
    const r = renderer.draw(world);
    if (!r.ok) console.error('[inspector-demo] draw error:', r.error);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
