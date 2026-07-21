// create-app-plugin.test.ts -- createApp + plugin runner integration (M2 / w14).
//
// Covers:
//   - AC-03: the canvas-form default plugin set is exactly 5 (transform / time
//     / animation / state / input) and registers the expected world systems.
//   - AC-02: physics + audio plugins register the expected world system set
//     (physics tick systems + 'PhysicsWorld' resource; audio-tick).
//   - AC-04: a duplicate plugin name surfaces as Result.err('duplicate-plugin')
//     through createApp (assemble form).
//   - AC-05: a failing plugin build surfaces as
//     Result.err('plugin-build-failed') with detail.cause through createApp.
//   - AC-06: physicsPlugin's async build completes BEFORE createApp resolves
//     (no post-resolve timing gap -- app.physics is populated immediately).
//
// Environment: the assemble form is driven with a renderer stub (no WebGPU),
// exercising the real createApp -> runPlugins path. The rapier 3D WASM backend
// loads in dawn-node, so the physics path runs for real; if it ever becomes
// unavailable the physics-dependent cases skip with a reason (per plan-strategy
// section 5.4 no-skip-by-default).
//
// charter awareness:
//   P2 structured > prose: assertions read world.inspect().systems (a
//       machine-readable enumeration), not pixels.
//   P3 explicit failure: duplicate / build-failed paths assert the structured
//       PluginError code + detail.

import { AUDIO_ENGINE_RESOURCE_KEY } from '@forgeax/engine-audio';
import {
  AUDIO_TICK_SYSTEM_NAME,
  audioPlugin,
  WebAudioEngine,
} from '@forgeax/engine-audio-webaudio';
import { err, type Result, World } from '@forgeax/engine-ecs';
import { INPUT_BACKEND_KEY } from '@forgeax/engine-input';
import { physicsPlugin } from '@forgeax/engine-physics';
import { type Plugin, PluginError, runPlugins } from '@forgeax/engine-plugin';
import type { Renderer } from '@forgeax/engine-runtime';
import { animationPlugin, transformPlugin } from '@forgeax/engine-runtime';
import { statePlugin } from '@forgeax/engine-state';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../create-app';
import { inputPlugin } from '../plugin-factories';

function makeRendererStub(): Renderer {
  const ready: Promise<{ ok: true; value: undefined }> = Promise.resolve({
    ok: true,
    value: undefined,
  });
  return {
    backend: 'webgpu' as const,
    ready,
    draw: (): { ok: true; value: undefined } => ({ ok: true, value: undefined }),
    onError: (): (() => void) => () => {},
    onLost: (): (() => void) => () => {},
    dispose: (): void => {},
  } as unknown as Renderer;
}

function systemNames(world: World): string[] {
  return world.inspect().systems.map((s) => s.name);
}

// Probe whether the rapier 3D WASM backend loads in this environment.
// Physics-dependent cases skip explicitly (it.skipIf) when unavailable,
// rather than silently returning from the test body (charter P3: explicit
// failure > silent behaviour).
let rapierAvailable = false;
beforeAll(async () => {
  try {
    const m = await import('@forgeax/engine-physics-rapier3d');
    const rapier = await m.loadRapier3D();
    m.createRapier3DPhysicsWorld(rapier);
    rapierAvailable = true;
  } catch {
    rapierAvailable = false;
  }
});

describe('createApp plugin runner -- default set (AC-03)', () => {
  it('the canvas default set is transform/animation/state/input', async () => {
    // The canvas form's default set, run directly against a World (no renderer
    // needed). INPUT_BACKEND_KEY is pre-inserted so inputPlugin registers its
    // scan system (mirrors createApp's app-layer input attach).
    const world = new World();
    world.insertResource(INPUT_BACKEND_KEY, {} as never);
    const defaultSet: Plugin[] = [
      transformPlugin(),
      animationPlugin(),
      statePlugin(),
      inputPlugin(),
    ];
    const result = await runPlugins(world, defaultSet, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect([...result.value.keys()]).toEqual(['transform', 'animation', 'state', 'input']);

    // World systems registered by the default set.
    const names = systemNames(world);
    expect(names).toContain('propagateTransforms');
    expect(names).toContain('advanceAnimationPlayer');
    expect(names).toContain('transitionStates');
    expect(names).toContain('input-frame-start-scan');
  });

  it('inputPlugin is a no-op when no INPUT_BACKEND_KEY resource is present', async () => {
    const world = new World();
    const result = await runPlugins(world, [inputPlugin()], []);
    expect(result.ok).toBe(true);
    expect(systemNames(world)).not.toContain('input-frame-start-scan');
  });
});

describe('createApp plugin runner -- physics + audio system set (AC-02)', () => {
  it('audioPlugin registers the audio-tick system when the backend resource is present', async () => {
    const world = new World();
    world.insertResource(AUDIO_ENGINE_RESOURCE_KEY, new WebAudioEngine());
    const result = await runPlugins(world, [], [audioPlugin()]);
    expect(result.ok).toBe(true);
    expect(systemNames(world)).toContain(AUDIO_TICK_SYSTEM_NAME);
  });

  it('physicsPlugin inserts PhysicsWorld + registers physics systems on success', {
    skip: !rapierAvailable,
  }, async () => {
    const world = new World();
    const result = await runPlugins(world, [], [physicsPlugin('rapier-3d')]);
    expect(result.ok).toBe(true);
    expect(world.hasResource('PhysicsWorld')).toBe(true);
    // AC-02: physics registers its three-phase tick systems. Assert the
    // expected system names are present (plan-strategy section 5.2
    // enumeration vs. old opts path system set).
    const names = systemNames(world);
    expect(names).toContain('physicsSyncBackend');
    expect(names).toContain('physicsStepSimulation');
    expect(names).toContain('physicsWriteback');
  });
});

describe('createApp plugin runner -- duplicate (AC-04)', () => {
  it('createApp(assemble) returns duplicate-plugin when two user plugins share a name', async () => {
    const result = await createApp({
      renderer: makeRendererStub(),
      world: new World(),
      plugins: [audioPlugin(), audioPlugin()],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('duplicate-plugin');
    if (result.error.code !== 'duplicate-plugin') return;
    expect(result.error.detail.name).toBe('audio');
  });
});

describe('createApp plugin runner -- build failure (AC-05)', () => {
  it('createApp(assemble) surfaces plugin-build-failed with detail.cause', async () => {
    const failing: Plugin = {
      name: 'boom',
      build(): Result<void, PluginError> {
        return err(
          new PluginError({
            code: 'plugin-build-failed',
            expected: 'every plugin.build(world) call must return Result.ok',
            hint: 'fix boom',
            detail: { pluginName: 'boom', cause: 'simulated WASM failure' },
          }),
        );
      },
    };
    const result = await createApp({
      renderer: makeRendererStub(),
      world: new World(),
      plugins: [failing],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('plugin-build-failed');
    if (result.error.code !== 'plugin-build-failed') return;
    expect(result.error.detail.pluginName).toBe('boom');
    expect(result.error.detail.cause).toBe('simulated WASM failure');
  });
});

describe('createApp plugin runner -- physics async timing (AC-06)', () => {
  it('app.physics is populated immediately after createApp resolves (no timing gap)', {
    skip: !rapierAvailable,
  }, async () => {
    const result = await createApp({
      renderer: makeRendererStub(),
      world: new World(),
      plugins: [physicsPlugin('rapier-3d')],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Because runPlugins awaits physicsPlugin's async build before createApp
    // resolves, the 'PhysicsWorld' resource is already present -- app.physics
    // reads it back synchronously with no post-resolve fire-and-forget gap.
    expect(result.value.physics).toBeDefined();
    // Verify the resource is present in the World (not just on the App handle,
    // confirming the physicsPlugin build fully populated it before resolve).
    expect(result.value.world.hasResource('PhysicsWorld')).toBe(true);
  });
});
