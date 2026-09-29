# P1 SSAO and realtime probe follow-up

> [!IMPORTANT]
> This follow-up extends PR #3163's SSAO and probe delivery. The previous exact
> head `eb0378150f` passed full CI and SDK preflight. Current follow-up gates are
> recorded on the PR; the separate strict SSR timing budget remains open.

## Reproduced gaps and repairs

| Reproduction | Owning repair | Regression |
|:--|:--|:--|
| Change Atmosphere haze, keep the old probe, then explicitly recapture: reflected pixel difference was zero | Probe capture samples the selected Atmosphere cube with a declared graph read; no second sky evaluator or texture | Fixed camera/geometry, frozen versus updated reflection, SSR disabled |
| Change only Atmosphere parameters under `on-change` | Include the selected environment signature in the existing capture revision | Automatic publication, visible reflected change, then no recapture while stationary |
| Enable GPU pass timing while capturing the combined scene: fresh Dawn replay failed at `beginRenderPass` with an invalid QuerySet object | Capture, closure, validation, lineage and replay retain and resolve timestamp QuerySet identity | Three native capture cases: raster, compute, empty compute; real Browser/Dawn frame replay with timestamps |
| With Atmosphere selected, an empty plane showed a large rectangular patch when the local probe was enabled: 27,216 changed pixels, mean delta 0.021849 | Explicit Skylight without an image consumes irradiance and prefiltered radiance from the same sky as the probe; the demo uses a neutral lighting tint | Remove the cube, settle the capture, toggle the probe and compare final pixels |
| Probe update steps reconstructed the graph and rebaked an unchanged sky: 9,408 executed bake passes in the journey | DeviceScope caches the sky, irradiance and prefilter resources across graph replacement; submission publishes the source signature | Exactly 126 executed bake passes for three source revisions; zero further baking while stationary |
| The interactive probe demonstration initially used once mode and had no visible scene-edit controls | Default the interactive carrier to on-change; expose capture-now, AO, sky/haze and cube-position controls | Real controls, independent SSR/probe toggles and narrow-window inspection |

The renderer still schedules one probe capture face or PMREM face/mip step per
frame, shared fairly across probes. Six captures plus 30 filters require 36
completed submissions after readiness. Publication remains atomic; this is an
amortized update with explicit latency, not a simultaneous six-face snapshot.
Atmosphere's display sun disc remains separate from the sky-radiance cube;
directional lighting supplies the material's specular sun response. An explicit Skylight with no image now consumes this same Atmosphere cube
through diffuse convolution and a roughness mip chain. Its color and intensity
remain explicit. An authored equirect image retains its source; no Skylight
still means no global ambient contribution.

## Actual browser and GPU evidence

The plane/cube journey uses 512 by 512, no AA, medium SSAO with radius 0.5,
Atmosphere and a 64-square probe. SSR is disabled during the comparisons.
Every one of 379 completed frames requires indirect display lighting and zero
CPU fallback draws. Live pixels and the captured frame replay on Dawn agree
exactly. Readback and GPU timing are explicit diagnostics.

| Observation | Result |
|:--|--:|
| Explicit recapture after haze change | 30,743 changed pixels; mean RGB delta 0.005953 |
| Automatic capture after haze change | 35,374 changed pixels; mean RGB delta 0.006347 |
| Maximum probe work steps in one frame | 1 |
| Stationary environment | No further generation change or sky bake |
| Sky baking across 379 frames | 126 executed passes: 3 source changes times 42 passes |
| Empty-plane probe on/off | 0 pixels above the 3/765 RGB threshold; mean delta 0.000035 |
| Timestamp-bearing Browser/Dawn pixel difference | 0 |

The independent SSAO plane/cube check also removes and reinserts the occluder's
MeshRenderer. Removing it must remove the contact AO; reinserting it must restore
the original pixels. The measured removed-occluder mean RGB delta is
0.000001787; reinsertion restores the original image exactly. Existing
zero-strength, disable/restore and cube-lift
comparisons remain in the same public profile and pixel path.

The actual interactive controls were exercised at 1280 pixels and at a
320-pixel viewport without horizontal overflow. Capture-now publishes a new
generation in once mode; disabling/re-enabling the probe disables/restores its
controls. The default TAA image has a continuous reflected cube silhouette.
The probe-only image remains an approximation from a fixed capture position,
not a planar mirror. The original rectangular patch was a rejected visual
result, not a valid limitation or an AO result. AO/probe isolation reproduced
its cause before the global Atmosphere lighting repair.

## Performance observations

These are local WebGPU Metal pass-boundary observations on a non-exclusive host,
not exclusive-device or cross-device budgets. Intervals can overlap and must not
be added as frame latency. The 512-square combined journey includes startup, publication and removal
transitions. The measurements below include the global lighting repair and
persistent sky resources. Unchanged sky data survives probe work, resize and
other graph replacement. The cache retains 1,062,168 payload bytes until the
DeviceScope retires; recovery receives a fresh cache. A sky change still runs
all 42 baking passes in its submission, so changing the sky every frame is
more expensive than updating objects under a stationary sky.

| Pass | Samples | p50 ms | p95 ms |
|:--|--:|--:|--:|
| SSAO calculation | 379 | 0.390 | 1.109 |
| SSAO blur | 379 | 0.608 | 1.525 |
| Probe raw capture | 36 | 0.732 | 2.066 |
| Probe filtering | 180 | 2.170 | 7.363 |
| Sky raw capture | 18 | 0.259 | 1.637 |
| Sky irradiance | 18 | 1.853 | 2.673 |
| Sky prefilter | 90 | 4.431 | 7.270 |

Separate 1280 by 720 AO sampling uses 15 warmup and 60 measured frames per
profile: low/medium/high calculation p50 is 0.740/1.110/1.912 ms; blur p50 is
1.394/1.760/2.564 ms. Disabled AO performs zero AO passes, and steady-state
per-frame bind-group creation stays zero. These measurements do not close the
pre-existing standalone SSR CPU/GPU timing budget.

## Comparison boundary

Three.js exposes background and physical-material environment as separate
[Scene properties](https://threejs.org/docs/pages/Scene.html), and its
[CubeCamera](https://threejs.org/docs/pages/CubeCamera.html) updates a capture
from one position. This comparison motivated explicit source selection and
frozen-versus-updated capture checks. It does not establish visual or timing
parity with Three.js.

## Local checks

The final follow-up source passed 1,902 Render unit tests, 120 shader-plugin
unit tests, three complete hello-ssr browser journeys, the independent SSAO
browser journey, app type checking and repository Biome checks (six existing
warnings). The Wave 1 browser surface also passed its three rendering cases.
The hello-ssr Browser/Dawn pair run is
`verify-1789354755498-499588bb0856490086ccc07378d5ded5`.
These local results precede the final commit; exact-commit complete CI is
reported separately on the PR.

## Reproduction

```bash
pnpm --filter @forgeax/hello-ssr smoke:browser
pnpm --filter @forgeax/app-learn-render-5-advanced-lighting-9-ssao smoke:browser
pnpm --filter @forgeax/app-learn-render-5-advanced-lighting-9-ssao smoke:performance
pnpm exec vitest run --project dawn packages/rhi-debug/src/__tests__/timestamp-query-capture.dawn.test.ts
pnpm ci:focus --kind unit --select @forgeax/engine-render
```

The new third hello-ssr browser journey is also directly available as
`node apps/hello/ssr/scripts/smoke-probe-atmosphere-browser.mjs`. Its performance
switch is explicit in the URL, and its final tape retains the tested AO/sky/probe
combination. Full browser, Dawn and 300-frame smoke rosters remain required on
the final PR commit; this report does not claim Voxel joint acceptance or merge.
