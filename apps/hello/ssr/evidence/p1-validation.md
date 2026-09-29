# Wave 1 Engine P1: AO, soft shadows and dynamic reflections

This PR covers items 6 and 7 of the Voxel rendering infrastructure strategy and
the four GPU Scene follow-ups. The PR checks identify the final validated commit;
local runs below describe the implemented source before that final CI run.

> [!IMPORTANT]
> The standalone SSR optimization targets remain unmet. Keep the measured CPU,
> GPU and memory results separate from functional acceptance. This record does
> not claim Voxel destruction integration, an SDK release or a merge to main.

## Delivered behavior and verification

| Scope | Result and regression route |
|:--|:--|
| Contact AO | Correct current depth/normal reconstruction, hemisphere sampling, bilateral filtering and single material-AO composition. Plane/cube controls isolate off, zero strength, radius, quality and cube lift. Removing/reinserting the occluder removes/restores AO. |
| AO with soft shadows | The Room carrier adds thin walls, a pole and fragments under fixed lighting/exposure. Independent AO, PCF3/PCF5/PCSS medium/high and angular-radius controls. The browser journey checks independent effects, pole motion, wall removal, camera motion, exact restoration and 300 stationary frames. |
| Cascaded shadows | Existing four-cascade PCF/PCSS owner remains authoritative. Native PCF3 near, PCSS medium seam and PCSS high motion carriers each complete 300 frames with no renderer errors. |
| Actual SSR | Hi-Z, bounded trace, temporal resolve, roughness mip chain and energy-preserving fallback replacement execute on the GPU. The 36 native shader cases and ten browser dispatch/Hi-Z cases cover geometry, rejection, distance, roughness and stable output. The reflected cube corner repair keeps the 48/5 trace/refinement bounds. |
| Dynamic probes | Once/on-change/continuous/manual updates share one face/filter step per frame. Six captures plus 30 filters publish atomically after readiness. Browser journeys cover object movement, offscreen changes, shared materials, multiple probes, Atmosphere changes, invalidation and recovery. |
| Environment consistency | An image-free explicit Skylight and local probe consume the same Atmosphere radiance. Empty-plane probe on/off changes zero pixels above the regression threshold. Persistent device-owned sky lighting avoids rebaking during unchanged probe steps. [Detailed reproduction and measurements](p1-ssao-probe-completion.md). |
| GPU Scene combinations | Custom Surface main lighting and supported shadow draws stay indirect with Clustered lights, SSAO, SSR fallback MRT and probe capture. The real four-material publication test also covers Forward/Deferred, MSAA, FXAA, TAA, Bloom, TAAU at 0.67 scale and replacement-device recovery. CPU fallback draw count stays zero. Auxiliary G-buffer/temporal geometry remains explicitly separate from this display-lane claim. |
| Importer bounds | glTF/FBX producers enclose imported animation clips conservatively, including between-key extrema, hierarchy transforms and signed morph envelopes. Real Fox.glb and humanoid.fbx GUID/dev-transport journeys retain GPU admission for 300 frames. Nonzero runtime morph deformation keeps its explicit admission rules. |
| Surface shadow ABI | Standard Surface and Alpha Mask receive the generated scene-index ShadowCaster from the same opacity/culling contract. Full-custom vertex deformation requires explicit author declaration. |
| Material capacity | 512-byte scene material rows; the compiler rejects 528 bytes, packing reaches byte 496 and real GPU multi-row tests consume the final vector. |

## New recording regressions

The PCSS angular-radius UI exposed an ECS precision defect: authored `0.05`
becomes `0.05000000074505806` in the f32 column and was rejected during extraction.
Validation now accepts the stored representations of both documented endpoints,
while rejecting the adjacent out-of-range f32 values and nonfinite inputs. Nine
owner assertions exercise authored values and World spawn/set round trips. The
Room browser journey renders both endpoints under PCSS medium/high, restores the
original pixels exactly, and then completes its 300 stationary frames. The
maximum-radius UI was also operated directly without console errors.

The SSR depth and reflection pyramids now each use one compute pass with ordered
per-mip dispatches. All mip levels, dimensions and shader arithmetic are retained.
The 64-by-32 Dawn reproducer previously recorded five reduction passes where one
is required. The same 300-frame pixel test now passes in Dawn and Chromium.
RenderGraph explicitly distinguishes an internally written-then-sampled texture
from incoming read/write data, derives both binding usages, rejects unsupported
storage capabilities and confines this declaration to compute passes.

Temporal projection previously rendered both equivalent opaque Forward and
Deferred material passes. Actual Dawn command interception records six draws for
four Surface objects before the repair, and four afterwards. Only equivalent
Standard opaque projections collapse; different shaders, culling, blending,
stencil and full-custom programs retain their distinct behavior. TAAU and device
recovery remain in that same runtime regression.

## Room pixel evidence

The 1280-by-720 Room scene uses radius 0.5 AO, a 2048-square four-cascade shadow
map and a directional angular radius of 0.025. These changes come from the public
profile and ECS light/transform APIs, with fixed exposure and light intensity.

| Comparison | Changed pixels |
|:--|--:|
| AO off versus on, shadows off | 39,835 |
| Shadows off versus PCF3, AO unchanged | 8,187 |
| PCF3 versus PCSS medium | 4,434 |
| Move the thin pole | 37,346 |
| Remove the thin wall | 136,445 |
| Restore pole, wall or camera | 0 each |
| 300 stationary frames | 0 versus baseline on every frame |
| Same-frame Browser versus Dawn replay | 0 |

The actual image was inspected: contact darkening follows the cube, fragments
and room joints, while open floor remains clear. These checks establish local
correctness and restoration, not image or performance parity with Three.js.
The existing [Three.js comparison](../../../learn-render/5.advanced-lighting/9.ssao/README.md#threejs-reference)
keeps the algorithm and sampling differences explicit.

## Performance and limits

The recording changes reduce redundant work without changing quality settings.
The independently derived 1080p SSR allocation remains 43,543,892 bytes against
45,088,768 bytes. Normal rendering performs no full-frame reflection readback;
diagnostic capture remains opt-in. A stationary sky performs no new bake work.

The existing performance command retains its CPU increment p50 0.25 ms and SSR
GPU pass-duration sum p50/p95 3/5 ms targets. Current results and original samples
are attached to the delivery evidence and summarized on the PR. They must not be
reported as passing when the command is red. Pass timestamp intervals can overlap,
so their sum is not frame latency; the host is not an exclusive GPU benchmark host.

Probe updates are amortized: a 64-square probe normally needs 36 completed work
submissions after pipeline readiness. Source motion during capture can delay a
coherent generation. Resolution/memory admission and one global work step bound
resources, but they do not promise simultaneous six-face capture or zero latency.

## Reproduction

```bash
pnpm --filter @forgeax/app-learn-render-5-advanced-lighting-9-ssao smoke:browser
pnpm --filter @forgeax/hello-ssr smoke:browser
pnpm --filter @forgeax/hello-ssr smoke
pnpm --filter @forgeax/hello-ssr smoke:performance
pnpm exec vitest run --project dawn packages/runtime/src/__tests__/surface-standard-pipeline.dawn.test.ts
pnpm exec vitest run --project dawn packages/render/src/__tests__/ssr
```

Full browser, Dawn and the complete 300-frame hello/learn-render smoke roster are
required on the final PR commit. Earlier green runs do not certify later edits.
