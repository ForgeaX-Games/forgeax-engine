# `@forgeax/engine-vfx-render`

This package is the downstream production bridge from CPU-owned
`ParticleRenderBatch` data to the engine RenderFeature seam. `@forgeax/engine-vfx`
owns effect loading, FixedUpdate simulation, lifecycle, telemetry, and batch
validation.

## GUID to pixels

The host loads a cooked Pack v2 effect by GUID, installs
`particleSimulationPlugin`, advances the World, and installs the feature:

```ts
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createApp } from '@forgeax/engine-app';
import { createRenderer } from '@forgeax/engine-runtime';
import {
  loadParticleEffect,
  particleEffectPackLoader,
  particleSimulationPlugin,
  createStockParticleCpuExecutorRegistry,
} from '@forgeax/engine-vfx';
import { particleRenderFeature, particleSceneSpaceResolver } from '@forgeax/engine-vfx-render';

declare const assets: import('@forgeax/engine-assets-runtime').AssetRegistry;
declare const canvas: HTMLCanvasElement;
declare const bundler: Parameters<typeof createRenderer>[2];
declare const scene: { player: EntityHandle; mouthJoint: EntityHandle };
const world = new World();
const effectGuid = '019e9c00-0000-7000-8000-000000000000';
assets.configurePackIndex('/pack-index.json');
assets.loaders.registerPackLoader(particleEffectPackLoader);
const loaded = await loadParticleEffect(assets, effectGuid);
if (!loaded.ok) throw new Error(loaded.error.hint);
const effect = world.allocSharedRef('ParticleEffectAsset', loaded.value);
const player = scene.player;
const mouthJoint = scene.mouthJoint;
const resolver = particleSceneSpaceResolver({
  world,
  resolveJoint: entity => (entity === player ? mouthJoint : undefined),
});
const feature = particleRenderFeature({
  observations: { read: world => readParticleObservation(world) },
  camera: { read: world => readParticleCamera(world) },
});
const renderer = await createRenderer(canvas, { features: [feature] }, bundler);
const appResult = await createApp({
  renderer,
  world,
  plugins: [
    particleSimulationPlugin({
      assets,
      spaceResolver: resolver,
      cpuExecutors: createStockParticleCpuExecutorRegistry(),
    }),
  ],
});
if (!appResult.ok) throw new Error(appResult.error.hint);
appResult.value.start();
```

The `scene` value comes from the project scene owner: its `mouthJoint` is a
real `ChildOf` entity, not a render-only offset. The authored material GUID used by the mesh output is
`019e9c00-0000-7000-8000-000000000002`; it is loaded from the authored Pack v2
package through the same pack-index route. The feature consumes validated
`billboard` and `mesh` buckets. It never reads raw source JSON, infers output
kind from filenames, or creates a second GUID registry.

## Readiness and recovery

`diagnostics()` exposes `empty`, `preparing`, `ready`, `disabled`, and
`unavailable`. Pipeline preparation may be asynchronous. During warm-up, a
material or mesh preparation miss retains the encoded asset identity in
`diagnostics().error.detail.assetGuid`, with the closed error `code`, `expected`,
and `hint` intact. Keep the feature retryable and call the normal frame path
again; a successful preparation clears the error and reaches `ready`. A
`render-feature-preparation-failed` event with `stage: 'prepare'` and
`recovery: 'next-frame'` is recoverable only during the bounded warm-up window;
the smoke gate records it as warm-up and fails on any post-readiness or
persistent error. Never hide a persistent shader validation error behind a
placeholder asset or a demo-side fallback.

Scene-space resolution is explicit: local emitters use
`particleSceneSpaceResolver({ world, resolveJoint })`, while world emitters
retain world coordinates. The resolver owner decides whether a local effect
uses its player, parent, or authored joint pose.
Pause, replay, seed changes, despawn cleanup, and output readiness remain in
`ParticleSimulation`.

## Public surface

| Symbol | Contract |
| --- | --- |
| `particleRenderFeature` | RenderFeature producer for validated billboard/mesh batches |
| `particleSceneSpaceResolver` | Resolves local particle positions against the host World |
| `ParticleRenderDiagnostics` | Readiness, bucket, and structured error observation |
| `ParticleRenderError` | Closed particle-render failure vocabulary |
| `PARTICLE_SHADER_IDENTIFIERS` | Stable shader identities for the two output kinds |

This package is not a VFX authoring frontend, editor, transport, compatibility
feature, or alternate simulation owner.
