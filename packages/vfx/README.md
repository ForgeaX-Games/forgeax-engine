# @forgeax/engine-vfx

Runtime-safe contract for code-first GPU particle effects. Authors write emitter metadata plus two WGSL functions; the engine owns allocation, scheduling, compaction, indirect drawing, recovery, and asset transport.

> [!IMPORTANT]
> Particle behavior is code, not an operator or node graph. Runtime players consume cooked programs and never compile WGSL.

## Ownership

The machine-readable asset boundary is
[`schemas/asset-authority.schema.json`](../../schemas/asset-authority.schema.json). Author source
and its WGSL module are authoritative; native cook produces the Pack payload and
asset-local program artifact, while Catalog and runtime state are derived
projections. Lifecycle evidence therefore runs from source validation through a
successful cook receipt and runtime fingerprint check. A stale or missing
artifact must be cold-cooked instead of being treated as current.

| Package | Owns |
|:--|:--|
| `@forgeax/engine-vfx` | Source validation, cooked asset loading, `ParticleEffectPlayer`, FixedUpdate intents, deterministic spawn scheduling |
| `@forgeax/engine-vfx-compiler` | WGSL composition, import resolution, Naga validation, reflection, deterministic cook |
| `@forgeax/engine-vfx-render` | Persistent GPU state, compute passes, fixed-bounds culling, billboard/mesh projection, indirect draws |

## Author source

```ts
import { defineParticleEffectSourceV3 } from '@forgeax/engine-vfx';

export const sparks = defineParticleEffectSourceV3({
  schemaVersion: 3,
  emitters: [{
    id: 'sparks',
    capacity: 100_000,
    backend: { required: 'gpu' },
    space: 'world',
    bounds: { kind: 'sphere', center: [0, 0, 0], radius: 12 },
    schedule: { rate: 20_000, bursts: [{ time: 0, count: 2_000 }] },
    program: { module: 'sparks.vfx.wgsl' },
    renderers: [{ kind: 'billboard', material: SPARK_MATERIAL, blend: 'additive' }],
    simulationWhenCulled: 'continue',
  }],
});
```

The parser rejects unknown fields. This Batch A slice is GPU-only and requires
`backend: { required: 'gpu' }`; missing GPU capability fails structurally rather
than selecting a hidden backend. CPU fallback, runtime compilation, raw author
bindings, and CPU particle mirrors are not accepted. Batch B renderer metadata is
executable: billboard advanced fields, ribbon strips, trail history, and beam
endpoints each produce reflected resources and an indirect topology draw.

New authoring tools may use `PARTICLE_CODE_DEFAULT_MODULE_ID` as an immediately
cookable seed. The compiler owns that minimal WGSL module; advanced effects name
game-authored `.vfx.wgsl` modules and remain code-first.

A mesh renderer selects exactly one draw surface with `submesh` (default `0`):
`{ kind: 'mesh', mesh, material, submesh: 2 }`. An out-of-range index fails
preparation instead of silently drawing another submesh.

## Program v3 data plane

The minimum-fidelity slice exposes a schema-driven Program v3 authoring boundary
through `defineParticleEffectSourceV3`. Its fixed Core record is 112 bytes
(`VfxParticle`); effect snapshot values live in `VfxParameters`, while optional
`VfxCustom` values use a persistent GPU storage record capped at four
`vec4`-equivalent lanes. The compiler derives the WGSL declarations, reflection,
host stride, and renderer projections from these schemas. Reflected member
offsets preserve authored WGSL declaration order. Custom storage array stride
uses the struct's natural WGSL alignment; the vec4 lane count is a budget,
not an extra padding requirement (one scalar has a 4-byte stride).

```ts
import { defineParticleEffectSourceV3 } from '@forgeax/engine-vfx';

export const effect = defineParticleEffectSourceV3({
  schemaVersion: 3,
  emitters: [{
    id: 'embers', capacity: 4096, backend: { required: 'gpu' }, space: 'world',
    bounds: { kind: 'sphere', center: [0, 0, 0], radius: 8 },
    schedule: { rate: 120 }, program: { module: 'embers.vfx.wgsl' },
    renderers: [{
      kind: 'billboard', material: 'ember-material', sorting: 'view-depth',
      materialInputs: ['heat'],
    }],
  }],
});
```

Program v3 keeps the existing bounded `channels`/`events` and sub-emitter
path. The unused `vfx:channel` Data Interface token is not part of the v3
vocabulary; `camera`, single-sample `scene-depth`, and `noise` are
generation-owned resources and must be supplied by the renderer host.
Scene-depth is intentionally accepted only with `sampleCount: 1`; no implicit
MSAA resolve is performed.

Mesh renderers expose semantic Quaternion/Scale3 attributes and Standard
lighting/shadow intent. Mesh and billboard both support `none`, `view-depth`,
`view-distance`, `custom-ascending`, and `custom-descending` sorting; custom
sorting requires an explicit scalar `attributes.sort` from `VfxCustom`.
Stable `timeScale: 0` players emit no simulation intents. Reset, replay,
visibility restart, parameter patches and channel inputs still execute at zero delta. Billboard, Ribbon, Trail, and Beam retain their
topology-specific projection paths. Invalid or missing semantic/material input
references fail at cook time, and undeclared Parameters, Custom, and data
interface resources do not allocate a GPU binding.

## Batch B renderers and control

```ts
renderers: [
  {
    kind: 'billboard', material: SPARK_MATERIAL, blend: 'additive',
    capacity: 4096, overflow: 'drop-oldest',
    textureSheet: { columns: 4, rows: 4, frameRate: 12 },
    pivot: [0.5, 0.25], softParticle: { fadeDistance: 0.4 }, sorting: 'view-depth',
  },
  { kind: 'ribbon', stripKey: 'alive-index', capacity: 1024, overflow: 'drop-newest', width: 0.2 },
  { kind: 'trail', historyLength: 8, capacity: 1024, overflow: 'drop-oldest', width: 0.15 },
  { kind: 'beam', endpointField: 'velocity', capacity: 256, overflow: 'drop-newest', width: 0.08 },
]
```

`ribbon`, `trail`, and `beam` have independent capacities, resource plans,
shader entry points, and indirect draws. A renderer is never silently changed to
a billboard. `textureSheet`, `pivot`, `softParticle`, and `sorting` are reflected
into the billboard GPU path; soft particles require the explicitly registered
scene-depth provider. Capacity overflow is reported through inspection.

## Author WGSL

```wgsl
#import forgeax_vfx::prelude::{
  VfxParticle,
  VfxSpawnContext,
  VfxUpdateContext,
  vfx_integrate,
  vfx_random_spawn,
}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  let angle = vfx_random_spawn(ctx, 0u) * 6.2831853;
  (*particle).velocity = vec3<f32>(cos(angle), 2.0, sin(angle));
  (*particle).lifetime = 1.5;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  (*particle).velocity.y -= 9.8 * ctx.delta;
  (*particle).sprite_rotation += ctx.delta * 2.0;
  vfx_integrate(ctx, particle);
}
```

The managed shell exposes this stable particle surface:

| Field | Meaning |
|:--|:--|
| `position` | Emitter-local or world position |
| `velocity` | Velocity used by `vfx_integrate` |
| `color` | Linear HDR color and alpha |
| `sprite_size` | Billboard width/height |
| `sprite_rotation` | Billboard rotation in radians |
| `mesh_orientation` / `mesh_scale` | Mesh Quaternion (x, y, z, w) and Scale3 |
| `material_random` | Stable material random scalar |
| `age`, `lifetime` | Engine advances age and kills at `age >= lifetime` |
| `alive` | Set to `0u` for explicit death |
| `id` | Stable spawn identity for addressable random |

Author modules must define exactly `vfx_spawn` and `vfx_update`. They must not declare shader stages, bind groups, bindings, or `forgeax_vfx_*` symbols. Reuse behavior with ordinary shader `#import`; imports are composed and validated at cook time.

## Load and play

```ts
import { loadVfxGpuEffect, ParticleEffectPlayer } from '@forgeax/engine-vfx';

const loaded = await loadVfxGpuEffect(assets, EFFECT_GUID);
if (!loaded.ok) return loaded;

const effect = world.allocSharedRef('ParticleEffectAsset', loaded.value);
world.spawn({
  component: ParticleEffectPlayer,
  data: { effect, playing: true, seed: 42, timeScale: 1 },
});
```

Install `createVfxRuntimeHost` from `@forgeax/engine-vfx-render`, attach each World once, and register `host.feature` with the Renderer. The host installs the loader and FixedUpdate intent producer.

## Authoring projection

Runtime-safe tools can inspect the cooked effect without importing the build-time
compiler or duplicating renderer schemas:

```ts
import {
  describeVfxGpuEffect,
  isVfxGpuEffectAsset,
} from '@forgeax/engine-vfx';

const payload = assets.lookup(EFFECT_GUID);
if (!isVfxGpuEffectAsset(payload)) return;

const descriptor = describeVfxGpuEffect(payload);
// descriptor.emitters: stable tree of program/stage/channel/event/renderer nodes
// descriptor.timeline: rate, bursts and loop duration by emitter
// descriptor.dependencies: module, asset and data-interface identities
// descriptor.capabilities: executable / partial / unavailable truth
```

The descriptor is immutable, UI-neutral and versioned. It preserves the authored
WGSL module ID in each cooked emitter, but intentionally omits WGSL bytes and
compiler objects. `isVfxGpuEffectAsset` owns the stable cooked discriminator at
the producer boundary; detailed artifact validation remains the Pack loader's
responsibility.

> [!IMPORTANT]
> The descriptor is an inspection/read-model contract, not a second authoring
> language. Program v3 source plus `.vfx.wgsl` is authoritative. Older payloads
> are rejected at the loader boundary and must be cold-cooked before publication.

## Runtime invariants

- FixedUpdate is the only simulation clock; render frames consume ordered tick intents.
- GPU particle buffers remain persistent and are never read back for ordinary simulation or drawing.
- Time-zero bursts fire once per play cycle. Rate remainder and particle IDs survive frame-rate variation.
- `vfx_random_spawn` and `vfx_random_update` are addressable by seed, particle ID, tick, and sample key.
- Cold GPU preparation stalls effect time within the bounded queue. Post-start overflow reports `vfx-intent-queue-overflow`; ticks are not silently discarded.
- Seed/effect changes and stop-to-play transitions restart the player at a fixed boundary.
- `phaseTick` is effect-relative and resets to zero on replay or `restart-on-visible`; the existing `tick` remains the World-global FixedTime correlation key.
- `replay(player)` advances an authored stopped player for exactly one FixedUpdate and never creates a second persistent play-state authority.

`VfxGpuRuntime.inspectPlayers()` and `inspectPlayer(player)` expose stable keyed
snapshots for every attached player and emitter. They report the asset GUID,
program/layout fingerprints, parameter generation, pending patch count, channel
counters, `cameraVisible`, `sessionEnabled`, phase/global ticks, schedule, bounds, renderer/stage metadata and the latest
committed tick intent per emitter. Observation never selects a single global
“latest intent,” so two players and multi-emitter effects remain distinguishable.
The renderer may use `forEachEmitterSource()` to refresh frustum visibility from
live emitters even when a paused player has no pending fixed-tick intent.

## Culling policy

| `simulationWhenCulled` | Hidden behavior | Visible transition |
|:--|:--|:--|
| `continue` | Simulate without projection or draw | Draw current state |
| `pause` | Freeze simulation and effect time | Resume frozen state |
| `restart-on-visible` | Freeze while hidden | Reset before drawing again |

Bounds are required and conservatively tested against the camera frustum. Local-space bounds use the player's world transform and maximum axis scale.

Camera culling and editor preview masking are independent runtime axes:

- `setEmitterCameraVisibility` is renderer-owned frustum evidence and applies the authored culling policy.
- `setEmitterSessionEnabled` is a non-authored preview mask used for mute/isolate. Disabled emitters neither simulate nor render retained output.
- Neither API changes a cooked renderer's authored `enabled` field.

## Structured recovery

| Code | Repair |
|:--|:--|
| `vfx-source-version-unsupported` | Migrate behavior to WGSL and cold-cook the supported schema |
| `vfx-source-invalid` | Repair `detail.path`; unknown and unsupported fields fail closed |
| `vfx-asset-version-unsupported` | Cold-cook the older source and publish a Program v3 payload |
| `vfx-asset-v3-program-missing` | Republish the Program v3 asset-local `particle-effect/program.json` artifact |
| `vfx-asset-v3-fingerprint-mismatch` | Cold-cook the v3 payload and program atomically |
| `vfx-effect-unavailable` | Load the shared effect before the first FixedUpdate |
| `vfx-intent-queue-overflow` | Recover the Renderer or restart the player; inspect render readiness |

Device recovery discards the old render generation and reconstructs each active
retained emitter from its deterministic committed fixed-tick inputs on the first
submitted replacement-device frame. Recovery does not advance World time,
publish channel events, allocate a play cycle, or reset the authored player.
No stale handle or CPU particle mirror survives recovery.
