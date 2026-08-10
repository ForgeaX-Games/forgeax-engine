# @forgeax/engine-vfx-render

Production RenderFeature and host for persistent GPU particle simulation and indirect billboard/mesh drawing.

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

const renderer = await createRenderer(canvas, { features: [vfx.feature] });
```

Create the host before the Renderer and pass `host.feature` at Renderer
construction. `attachWorld` installs the schema-v2 Pack loader and one
FixedUpdate producer. `detachWorld` removes both the system and runtime
resource. Material and mesh GUIDs resolve through the attached World's
`AssetRegistry`.

## Frame path

| Stage | Work |
|:--|:--|
| Extract | Read camera and ordered GPU tick intents from each attached World |
| Prepare | Reuse/create program, particle, scan, indirect, per-tick uniform, per-renderer projection, mesh, and graphics resources |
| Contribute | Record spawn/update/scan/compact, one projection dispatch per renderer, then dependent indirect draws |
| Recover | Drop generation-owned GPU state and restart affected runtime players |
| Dispose | Release feature-owned state; the Renderer resolver destroys RHI resources exactly once |

The generic render seam accepts persistent compute programs/buffers/bindings, external GPU vertex buffers, and indirect draw commands. Renderer code does not enumerate VFX kinds.

## GPU state

| Buffer | Lifetime | CPU traffic |
|:--|:--|:--|
| Particle state | Emitter instance | Initial clear only |
| Alive flags, scan scratch, stable indices | Emitter instance | Initial clear only |
| Indirect commands | Emitter instance | Static geometry fields at creation; instance count on GPU |
| Tick uniforms | Bounded ring | One small write per fixed tick |
| Renderer projection instances | Renderer instance | None after allocation |
| Mesh geometry/index data | Prepared graphics cache | Initial upload |

There is no steady-state particle readback or CPU particle upload.
Bindings retained by an attached player keep their transitive buffers alive. When a player,
emitter, or World disappears, untouched GPU resources leave the live cache immediately and their
buffers are destroyed only after the submitted queue work completes. Renderer recovery and dispose
use the same owner path.

## Rendering

- Billboard projection uses camera right/up, particle width/height, and `size_rotation.z`; color and HDR material values are packed per renderer on GPU.
- Mesh renderers consume the explicitly selected `MeshAsset` submesh geometry/index data and one independent projected instance stream per renderer.
- Multiple renderers on one emitter receive independent material values and indirect command offsets.
- A material pass named `particle-billboard` or `particle-mesh` selects that renderer's authored
  shader module and render state. Ordinary `Forward` passes are ignored because their vertex layout
  is not a particle projection contract; absence of a matching particle pass uses the package-owned
  built-in shader.
- A custom particle material with a non-empty `parameters` schema receives the standard material
  bind group at group 1. Numeric parameters are uploaded through the shader-schema UBO layout;
  texture parameters resolve their authored TextureAsset and optional SamplerAsset through the
  attached World and the renderer's shared GPU residency store. Materials with no parameters keep
  the original group-0-only contract.
- The renderer owns bind-group resource leases. Per-preparation material UBOs are destroyed exactly
  once when the prepared graphics generation retires or recovers; texture and sampler residency
  remains owned by the shared GPU resource store.
- Billboard blend is explicit: `additive`, premultiplied `alpha`, or `opaque-cutout`.
- Scene color/depth target formats and sample counts derive from RenderFeature targets.
- Fixed bounds cull projection/draw before graph contribution; simulation follows the source culling policy.

Texture sheets, soft-particle depth sampling, parent variants, live parameter mutation, particle
sorting, ribbons, beams, and CPU counterparts remain Batch B work. Material texture/sampler binding
is executable; animation-specific sheet fields remain intentionally absent until their own runtime
and verification exist.

## Capabilities and recovery

The feature requires RHI `compute` and `indirectDrawing`. Capability absence disables registration through the standard RenderFeature capability error; it never guesses a backend by package name and never silently falls back to CPU.

Expected first-use pipeline preparation may report bounded `render-feature-preparation-failed` warm-up. Persistent preparation errors, WebGPU validation errors, or any later `render-feature-stage-failed` are failures. Renderer recovery creates a fresh resource generation and invokes the feature recovery hook before rendering resumes.

## Verification oracle

`apps/hello/boss-lightning` is the production path:

| Gate | Proof |
|:--|:--|
| `smoke:browser` | Dev Pack/import transport, Browser WebGPU validation, loader, runtime, camera readiness |
| `smoke` | Dawn 300 frames, billboard and mesh pixel energy, readiness deadline, explicit recovery |
| `smoke:falsify` | Disable-VFX, zero-emitter, and missing-material modes produce explicit zero output |

Null/backend unit tests prove graph and resource structure; they do not replace Browser or Dawn execution.
