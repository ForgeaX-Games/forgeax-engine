# @forgeax/engine-vfx-render

Production RenderFeature and host for persistent GPU particle simulation and indirect billboard, mesh, ribbon, trail, and beam drawing.

## Host recipe

```ts
import { createVfxRuntimeHost } from '@forgeax/engine-vfx-render';
import { createRenderer } from '@forgeax/engine-runtime';

const vfx = createVfxRuntimeHost({
  camera: {
    read: world => readActiveParticleCamera(world),
  },
  maxQueuedTicks: 8,
});

const attached = await vfx.attachWorld({ world, assets });
if (!attached.ok) return attached;

const created = await createRenderer(canvas, { features: [vfx.feature] });
if (!created.ok) throw created.error;
const renderer = created.value;
```

Create the host before the Renderer and pass `host.feature` at Renderer
construction. `attachWorld` installs the versioned Pack loader (including the
Program v3 path) and one FixedUpdate producer. `detachWorld` removes both the
system and runtime resource. Material and mesh GUIDs resolve through the
attached World's `AssetRegistry`.

## Frame path

| Stage | Work |
|:--|:--|
| Extract | Read the explicit simulation camera, complete view roster, and ordered GPU tick intents once per attached World |
| Plan | Declare shared frame simulation and independent view projection work in one plan |
| Record | Produce requested simulation scene inputs, execute each fixed tick and trail-history write once, then copy the completed state into each updating view before sorting, projection, and indirect draws |
| Recover | Drop generation-owned GPU state and restart affected runtime players |
| Dispose | Release feature-owned state; the Renderer resolver destroys RHI resources exactly once |

The generic render seam accepts persistent compute programs/buffers/bindings, external GPU vertex buffers, and indirect draw commands. Renderer code does not enumerate VFX kinds.
At first use, the feature declares compute entrypoints for authored renderer
topologies plus simulation, event, sorting, custom stage, and unknown extension
kernels. A disabled renderer remains authored so visibility changes, retained
players, and replay can resume without a different program contract.

One Renderer owns one feature instance and one source acknowledgement transaction.
All enabled views contribute to emitter visibility using their final viewport
projection, including views holding their last image because of update cadence.
Submitted source feedback updates runtime visibility even when no tick was queued;
this lets a paused emitter resume after camera reentry. Extraction does not mutate
visibility from authored camera aspect. Worker transport can add one frame of
visibility feedback latency. An updating view owns its camera basis,
sorted indices, projection counters, indirect commands, trail-offset scratch,
and output instances. Sorting or mesh projection in one view cannot mutate
another view or the shared simulation. View order and cadence do not change
the number of fixed ticks consumed.

The host's `camera.read(world)` explicitly supplies the simulation camera.
Its snapshot survives source publication and supplies these reflected inputs
without requiring a game to allocate GPU resources:

| Data interface | Default producer | Scope |
|:--|:--|:--|
| Camera | A 64-byte uniform containing the explicit simulation view-projection matrix | Shared by that World's emitters |
| Scene depth | Renderer captures opaque scene coverage from the same simulation camera at the outer surface extent | One requested capture per World and frame, independent of display views |
| Noise | Renderer owns the generation-resident noise texture | Shared by all emitters |

Only reflected inputs acquire resources. Display camera order, viewport extent,
and update cadence do not select simulation inputs or repeat simulation.
Scene depth uses the composed scene, including geometry outside every display
frustum. Its producer completes before shared simulation; each updating view
then projects the same completed particle state.

Explicit resident `dataInterfaces` provider resources retain their typed binding
and generation checks. An absent provider or resident payload uses the default
producer. Explicit unavailability, stale resources, wrong types, and duplicate
providers defer the affected emitter stream. The feature only advances its
submission ledger after all declared frame passes appear in the submission
receipt; source feedback is acknowledged once after the Renderer submits.

## Depth convention

Camera providers supply the same Reverse-Z view-projection as the Engine camera.
Built-in billboard depth tests and soft-particle fading use larger raw depths
for nearer surfaces; zero denotes empty background and does not fade particles.
`softParticle.fadeDistance` retains its normalized depth-buffer units.
GPU view-depth sorting orders smaller depths first for back-to-front blending;
world-distance and custom sorting keep their existing keys.

## GPU state

| Buffer | Lifetime | CPU traffic |
|:--|:--|:--|
| Particle state | Emitter instance | Initial clear only |
| Alive flags, scan scratch, stable indices | Emitter instance | Initial clear only |
| Shared indirect counts | Emitter instance | Compaction owns instance counts |
| View indices, counters, indirect commands, trail scratch | View and renderer instance | GPU copy from shared state before view sorting and projection |
| Tick uniforms | Bounded ring | One small write per fixed tick |
| Program v3 Parameters | Emitter instance | One snapshot write per fixed tick when declared |
| Program v3 Custom | Emitter instance | GPU-persistent; no per-particle CPU mirror |
| Renderer projection instances | View and renderer instance | None after allocation |
| Mesh geometry/index data | Prepared graphics cache | Initial upload |
| Ribbon strip resources | Ribbon renderer | Initial allocation; GPU indirect count |
| Trail history resources | Trail renderer | Initial allocation; GPU history updates |
| Beam endpoint resources | Beam renderer | Initial allocation; GPU endpoint projection |

There is no steady-state particle readback or CPU particle upload.

Material particle inputs use up to four vec4 lanes. The highest selected lane
determines the input region size; selecting lane 3 alone still reserves four
lanes. VFX projects the cooked values on GPU and forwards that lane count in the
graphics program declaration. Render derives the matching multi-stream layout
and includes its complete stride/attributes in pipeline identity.

| Adapter | Core instance bytes | First material-input shader location |
|:--|--:|--:|
| Billboard | 124 | 9 |
| Ribbon / Trail / Beam | 48 | 4 |
| Mesh | 72 | 10 |

Each selected input occupies its declared lane at `coreBytes + lane * 16`;
instance stride is `coreBytes + (highestLane + 1) * 16`. Missing or stale material
declarations fail with structured input errors rather than silently substituting
zero-valued inputs. Four-lane and sparse-lane support is exercised through the
cooked five-topology Dawn fixture, not only synthetic buffer uploads.

Bindings retained by an attached player keep their transitive buffers alive. When a player,
emitter, or World disappears, untouched GPU resources leave the live cache immediately and their
buffers are destroyed only after the submitted queue work completes. Renderer recovery and dispose
use the same owner path.

## Rendering

- Billboard projection uses camera right/up, particle width/height, and the v3 `sprite_rotation`; color and HDR material values are packed per renderer on GPU.
- Mesh renderers consume the explicitly selected `MeshAsset` submesh geometry/index data and one independent projected instance stream per renderer.
- Program v3 Mesh projection writes world-space center and Quaternion/Scale3 basis
  data. The built-in Mesh adapter supplies geometry inputs to the same Standard
  surface evaluator as scene Mesh. Render owns lighting preparation, topology
  variants, effective material values, Skylight inputs, and Cluster bindings;
  particles do not allocate a second lighting system or scene Mesh/Instance tables.
  Negative/non-uniform scale uses an inverse-transpose normal basis and preserves
  tangent handedness. Mesh `castShadows` contributes the same GPU instance/index/
  indirect data to Standard light views through a `shadow-caster` plan pass.
  The shared Dawn/WebGPU acceptance fixture proves directional/point/spot casting,
  camera-culled casters, Point receiving and authored bias, and four roughness/
  metallic combinations against ordinary Mesh under a real HDR equirect.
  Current-depth-dependent simulation consumes its dedicated opaque scene capture
  before display views project particles and render shadows. Render-only frames
  retain simulation state without advancing it; a catch-up submission exposes
  its final tick to every updating view. The indirect buffer is never
  reinitialized per tick.
- Multiple renderers on one emitter receive independent material values and indirect command offsets.
- A material pass named `particle-billboard` or `particle-mesh` selects the published
  cooked program for the receiving renderer's context and its render state. The
  material projection travels with the extracted snapshot; source module names are
  not aliases for cooked specialization keys. Without a matching particle pass, the package-owned
  built-in shader supplies the particle vertex adapter. Mesh preserves the ordinary
  `Forward` material render state; the other renderers use their particle defaults.
- The selected particle shader's reflected binding contract controls whether it receives the
  standard material bind group at group 1. An ordinary material's parameters never add an
  undeclared group to the built-in billboard shader. Numeric parameters use the shader-schema UBO layout;
  texture parameters resolve their authored TextureAsset and optional SamplerAsset through the
  attached World and the renderer's shared GPU residency store. Shaders without material bindings keep
  the original group-0-only contract.
- The renderer owns bind-group resource leases. Per-preparation material UBOs are destroyed exactly
  once when the prepared graphics generation retires or recovers; texture and sampler residency
  remains owned by the shared GPU resource store.
- Billboard blend is explicit: `additive`, premultiplied `alpha`, or `opaque-cutout`.
- Scene color/depth target formats and sample counts derive from RenderFeature targets.
- Fixed bounds suppress the main-camera raster when culled, not an enabled Mesh
  shadow contribution. Simulation follows the source culling policy.
- Camera-frustum results publish through `setEmitterCameraVisibility`; session mute/isolate is a separate mask that suppresses compute and draw contribution while retaining prepared bindings as warm state. A paused player can therefore be isolated and restored without a new simulation intent or GPU-resource reallocation.
- WGSL runtime time is the effect-relative `phaseTick`; the world-global tick remains an internal ring-selection and correlation clock. Replay and deterministic seek therefore restart shader time as well as CPU scheduling.

Billboard texture sheets, pivot, and soft-particle depth sampling execute from
the reflected renderer contract. Mesh and billboard sorting use the managed GPU
sort pass before instance projection, independently of indexed draw offsets.
Emitter resource identity uses the complete emitter ID within its World,
attachment, player and generation; display-name truncation never keys storage.

Mesh geometry projects declared source attributes into one 72-byte stream:
position, normal, UV0, tangent, UV1 and RGBA. Geometry owns packing; Render maps
color/UV1 to locations 14/15, leaving 4..9 for instances and 10..13 for up to four
material-input lanes. Missing color defaults to white and missing UV1 to zero;
source colors multiply particle colors. This applies with or without custom
material inputs. Index uploads are four-byte aligned without changing authored
indices, draw counts or firstIndex. Ribbon, trail, and beam use
independent resource plans and shader entry points. Parent variants and CPU
counterparts remain outside this runtime boundary.

Material texture and sampler bindings remain executable for particle materials;
the advanced renderer fields augment that shared material path.

## Runtime inspection

`host.inspect(world)` returns one immutable aggregate for the attached world:

| Field | Meaning |
|:--|:--|
| `generation` | Host attachment generation; changes when a new World realm is attached |
| `players[]` | Keyed per-player snapshots, including every emitter rather than one latest intent |
| `diagnostics[]` | Runtime-owned structured diagnostics for the same world |

The aggregate is `undefined` for an unattached World. A freshly attached empty
World returns an explicit empty aggregate, which lets tools distinguish “ready,
no player” from “not attached.” Realm-local entity handles are never reused as
cross-World identity; consumers must pair them with the host generation and
asset GUID.

`host.acquireControl(world)` is the command-side counterpart to inspection. It
returns a generation-bound lease for replay and runtime-only emitter session
masks, so product hosts do not reach through the public host into
`VFX_GPU_RUNTIME_RESOURCE_KEY`. Every command revalidates the attachment
generation, runtime resource and live `ParticleEffectPlayer`; detach,
reattach, or player destruction therefore returns a structured
`VfxRuntimeHostControlError` instead of mutating a stale realm. Acquire a new
lease after any host generation change. These controls are transient runtime
intent and do not modify authored `ParticleEffectPlayer` data.

The same generation-bound lease exposes `patchPlayerParameters` and
`submitChannel` for the bounded runtime control surface. Parameter patches
return the host generation, parameter generation, and pending patch count;
channel submissions retain the existing typed channel/event/sub-emitter path.
Missing players, invalid instance input, stale generations, and detached
worlds all return the closed `VfxRuntimeHostControlError` union. There is no
open Data Interface or second channel registry.

The render feature also exposes `feature.inspect()` as a bounded
`VfxRenderObservation`. `frameNumber`, `dispatches`, `indirectDraws`, and
`subjectOutputs` describe the VFX commands admitted in the last submitted
frame. `subjectOutputs` counts admitted subject raster commands; it is not a
particle-instance readback and must not be interpreted as proof that an
indirect draw had a non-zero instance count. Preview tools combine this receipt
with the existing owner inspection, PNG, and RHI-tape artifacts.

`createVfxRenderInspectSnapshot` and `topologyRecoveryHint` expose structured
readiness and recovery evidence. Device loss or a stale generation discards the
affected topology resources. The first submitted replacement-device frame
reconstructs active retained GPU state from the runtime's deterministic
committed fixed-tick inputs; rejected candidate frames do not publish that
generation or replay World-facing events.

## Capabilities and recovery

The feature requires RHI `compute` and `indirectDrawing`. Capability absence disables registration through the standard RenderFeature capability error; it never guesses a backend by package name and never silently falls back to CPU.

Expected first-use pipeline preparation may report bounded `render-feature-preparation-failed` warm-up. Persistent preparation errors, WebGPU validation errors, or any later `render-feature-stage-failed` are failures. Renderer recovery creates a fresh resource generation and invokes the feature recovery hook before rendering resumes.

A missing registered particle shader is a `material-shader-not-found` failure,
not asynchronous pipeline warm-up. Inspect the renderer error cause and repair
the material publication before retrying.

## Verification oracle

`apps/hello/boss-lightning` is the production path:

| Gate | Proof |
|:--|:--|
| `smoke:browser` | Dev Pack/import transport, Browser WebGPU validation, loader, runtime, camera readiness |
| `smoke` | Dawn 60 frames, billboard and mesh pixel energy, readiness deadline, explicit recovery |
| `smoke:falsify` | Disable-VFX, zero-emitter, missing-depth, and topology-fallback modes produce explicit structured failures |
| `scripts/bench/vfx-batch-b.mjs` | Exact 10K/100K/1M total capacity, 30 warm-up plus 60 sampled frames, zero particle readback, and per-adapter p95 budget |

```sh
pnpm --filter @forgeax/hello-boss-lightning smoke:browser
pnpm --filter @forgeax/hello-boss-lightning smoke
pnpm --filter @forgeax/hello-boss-lightning smoke:falsify
node apps/hello/boss-lightning/scripts/smoke-public-only.mjs
node scripts/bench/vfx-batch-b.mjs
```

The hardware product target is p95 <= 33.34 ms. CI's forced lavapipe adapter is
a software correctness reference, not evidence of hardware GPU throughput, so
its p95 is recorded but is not treated as an FPS gate. Reports include
`adapterClass`, `performanceGated`, the hardware target, and
`allocatedCapacity`. A hardware run must satisfy the target, and every tier
must allocate exactly the declared total capacity.

Null/backend unit tests prove graph and resource structure; they do not replace Browser or Dawn execution.
