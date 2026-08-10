# @forgeax/engine-vfx

Runtime-safe contract for code-first GPU particle effects. Authors write emitter metadata plus two WGSL functions; the engine owns allocation, scheduling, compaction, indirect drawing, recovery, and asset transport.

> [!IMPORTANT]
> Particle behavior is code, not an operator or node graph. Runtime players consume cooked programs and never compile WGSL.

## Ownership

The machine-readable asset boundary is
[`asset-authority.schema.json`](../../asset-authority.schema.json). Author source
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
import { defineParticleEffectSourceV2 } from '@forgeax/engine-vfx';

export const sparks = defineParticleEffectSourceV2({
  schemaVersion: 2,
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

## Batch B renderers and control

```ts
renderers: [
  {
    kind: 'billboard', material: SPARK_MATERIAL, blend: 'additive',
    capacity: 4096, overflow: 'drop-oldest',
    textureSheet: { columns: 4, rows: 4, frameRate: 12 },
    pivot: [0.5, 0.25], softParticle: { distance: 0.4 }, sorting: 'back-to-front',
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
  (*particle).velocity = vec4<f32>(cos(angle), 2.0, sin(angle), 0.0);
  (*particle).lifetime = 1.5;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  (*particle).velocity.y -= 9.8 * ctx.delta;
  (*particle).size_rotation.z += ctx.delta * 2.0;
  vfx_integrate(ctx, particle);
}
```

The managed shell exposes this stable particle surface:

| Field | Meaning |
|:--|:--|
| `position.xyz` | Emitter-local or world position; `.w` is available to author code |
| `velocity.xyz` | Velocity used by `vfx_integrate`; `.w` is available to author code |
| `color` | Linear HDR color and alpha |
| `size_rotation.xy` | Billboard width/height; mesh uses `.x` as uniform scale |
| `size_rotation.z` | Rotation in radians |
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

## Runtime invariants

- FixedUpdate is the only simulation clock; render frames consume ordered tick intents.
- GPU particle buffers remain persistent and are never read back for ordinary simulation or drawing.
- Time-zero bursts fire once per play cycle. Rate remainder and particle IDs survive frame-rate variation.
- `vfx_random_spawn` and `vfx_random_update` are addressable by seed, particle ID, tick, and sample key.
- Cold GPU preparation stalls effect time within the bounded queue. Post-start overflow reports `vfx-intent-queue-overflow`; ticks are not silently discarded.
- Seed/effect changes and stop-to-play transitions restart the player at a fixed boundary.

## Culling policy

| `simulationWhenCulled` | Hidden behavior | Visible transition |
|:--|:--|:--|
| `continue` | Simulate without projection or draw | Draw current state |
| `pause` | Freeze simulation and effect time | Resume frozen state |
| `restart-on-visible` | Freeze while hidden | Reset before drawing again |

Bounds are required and conservatively tested against the camera frustum. Local-space bounds use the player's world transform and maximum axis scale.

## Structured recovery

| Code | Repair |
|:--|:--|
| `vfx-source-version-unsupported` | Migrate behavior to WGSL and cold-cook schema v2 |
| `vfx-source-invalid` | Repair `detail.path`; unknown and unsupported fields fail closed |
| `vfx-asset-v2-program-missing` | Republish the asset-local `particle-effect/program.json` artifact |
| `vfx-asset-v2-fingerprint-mismatch` | Cold-cook payload and program atomically |
| `vfx-effect-unavailable` | Load the shared effect before the first FixedUpdate |
| `vfx-intent-queue-overflow` | Recover the Renderer or restart the player; inspect render readiness |

Device recovery discards the old render generation, clears VFX GPU state, and restarts players from source inputs. No stale handle or CPU particle mirror survives recovery.
