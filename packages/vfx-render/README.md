# `@forgeax/engine-vfx-render`

This package is the downstream production bridge from CPU-owned
`ParticleRenderBatch` data to the engine RenderFeature seam. `@forgeax/engine-vfx`
owns effect loading, FixedUpdate simulation, lifecycle, telemetry, and batch
validation.

## GUID to pixels

`ParticleRuntimeHost` is the public assembly owner for a production VFX path.
It creates one renderer feature, installs the existing Pack loader once per
host-provided `AssetRegistry`, and attaches the existing particle simulation
once per host-provided `World`. It creates neither a World nor a registry.

```ts
import { World } from '@forgeax/engine-ecs';
import { createApp, type BundlerOptions } from '@forgeax/engine-app';
import { createParticleRuntimeHost } from '@forgeax/engine-vfx-render';

declare const assets: import('@forgeax/engine-assets-runtime').AssetRegistry;
declare const canvas: HTMLCanvasElement;
declare const bundler: BundlerOptions;
declare const camera: import('@forgeax/engine-vfx-render').ParticleRenderFeatureOptions['camera'];

const world = new World();
const host = createParticleRuntimeHost({ camera });
const attached = await host.attachWorld({ world, assets });
if (!attached.ok) {
  console.error(attached.error.code, attached.error.expected, attached.error.hint);
  throw attached.error;
}

const app = await createApp(canvas, { features: [host.feature] }, bundler);
if (!app.ok) throw app.error;
app.value.start().unwrap();

// Stop this World before releasing the host-owned registry.
const detached = host.detachWorld({ world });
if (!detached.ok) console.error(detached.error.code, detached.error.hint);
```

`attachWorld` is idempotent for the same World and returns
`{ state: 'already-attached' }` on a repeated call. Two Worlds get separate
transient simulations even when they share one registry. `detachWorld` removes
only the World system and simulation resource; it never disposes the shared
registry. Host errors are structured with `code`, `expected`, `actual`, `hint`,
and `retryable`, so a caller can repair the named boundary and retry without
parsing a message.

After attachment, the host consumes the validated `billboard` and `mesh`
buckets produced by `ParticleSimulation.readAll()`. The authored material GUID
used by a mesh output is still loaded from the Pack v2 package through the same
pack-index route. The host never reads raw source JSON, infers output kind from
filenames, or creates a second GUID registry.

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
| `createParticleRuntimeHost` | Idempotent World attach/detach owner and feature bundle |
| `particleSceneSpaceResolver` | Resolves local particle positions against the host World |
| `ParticleRenderDiagnostics` | Readiness, bucket, and structured error observation |
| `ParticleRenderError` | Closed particle-render failure vocabulary |
| `PARTICLE_SHADER_IDENTIFIERS` | Stable shader identities for the two output kinds |

This package is not a VFX authoring frontend, editor, transport, compatibility
feature, or alternate simulation owner.

## Visibility boundary

Quick start: keep VFX simulation and `ParticleRenderBatch` production in
`@forgeax/engine-vfx`; register this feature as a render producer. The render
host applies effective entity visibility before a particle draw contributes.

| Observation | Owner | Recovery |
|:--|:--|:--|
| Author intent | ECS `Visibility` | Correct the component through `world.set` |
| Parent-derived effective state | `@forgeax/engine-render` + scene hierarchy | Repair `snapshot.diagnostics`, then resolve again |
| Particle readiness | `diagnostics()` in this package | Follow the structured error hint and retry the next frame |

`visibilityStats` is a renderer observation, not a VFX simulation counter.
There is no VFX-specific visibility component, shadow, camera, picking,
lifecycle, or asset fallback in this package. A failed particle draw must route
to the owning engine boundary rather than a demo-side stand-in.
