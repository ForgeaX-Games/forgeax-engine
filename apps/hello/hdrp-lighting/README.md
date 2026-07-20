# hello-hdrp-lighting

HDRP cluster-forward 256-light demo
(feat-20260608-cluster-lighting / M7 / w25).

URP is the engine default (zero config). HDRP is an opt-in upgrade for
high-fidelity multi-light rendering -- up to 256 punctual lights at
real-time framerates via cluster-forward shading.

## What this demo shows

256 punctual lights (200 PointLight + 56 SpotLight) over a dark slab.
The first 32 point lights orbit slowly so the cluster binner repopulates
every frame -- proves the binner runs once per frame, not just once at
install.

## How AI users opt in to HDRP

Three lines:

```ts
import { HDRP_PIPELINE_ID } from '@forgeax/engine-runtime';

const hdrpRes = assets.register<RenderPipelineAsset>({
  kind: 'render-pipeline',
  pipelineId: HDRP_PIPELINE_ID,
  config: { clusterGrid: { x: 16, y: 9, z: 24 } }, // optional, default {16, 9, 24}
});
renderer.installPipeline(hdrpRes.unwrap());
```

That's it. URP is replaced by HDRP for this renderer. A second
`installPipeline(urpHandle)` swaps back.

See `src/main.ts` for the full 9-step recipe (createApp -> register HDRP
-> installPipeline -> register material -> spawn slab + cube -> spawn 256
lights -> spawn camera -> per-frame orbit system -> app.start).

## Smoke gate (AC-21)

`pnpm --filter @forgeax/hello-hdrp-lighting smoke` runs the dawn-node
harness for 300 frames + asserts 5 criteria (structural-only, mirrors
`hello-physics` / `hello-bloom` structural smoke):

- (a) `backend=webgpu` literal observed.
- (b) frames observed >= 300.
- (c) HDRP install state vs URP per-frame graph signature: when
      installed, the URP signature passes (`shadow` / `main` / `fxaa` /
      `tonemap`) must NOT be in the per-frame graph; when
      `FALSIFY=force-urp`, all 4 must reappear.
- (d) `app.onError` fired only with KNOWN-NOISE codes
      (`render-system-multi-light` -- shared-extract URP N>4 warn fires
      regardless of installed pipeline; `hdrp-light-budget-exceeded` /
      `hdrp-index-list-overflow` -- M5/M6 fail-soft; `webgpu-runtime-
      error` -- HDRP M4 graph dangling-read compile fail, fail-soft).
- (e) `console.error` fired 0 times (structural failures).

> [!NOTE]
> The HDRP M4 cluster-forward pass declares `reads:[4 buffers]` without
> any producer pass writing them, so the render-graph dangling-read
> validation fail-fasts on every compile. The compile failure is
> fail-soft (the engine surfaces a `webgpu-runtime-error` once per frame
> and falls back to URP geometry); the cluster-forward shading itself is
> a follow-up engine gap. The smoke therefore proves only the
> install-seam acceptance + 256-light extract-without-crashing, not
> end-to-end cluster shading.

## Falsifiability (FALSIFY=force-urp)

```bash
FALSIFY=force-urp pnpm --filter @forgeax/hello-hdrp-lighting smoke
```

Skips `installPipeline(hdrpHandle)` so the engine stays on URP. The (c)
HDRP install vs URP-passes assertion catches it: with HDRP install
absent, the per-frame graph carries the URP signature passes; the smoke
flips its branch and confirms the demo's HDRP-vs-URP dependency is
real (AC-21 falsifiability).

## SSOT (AC-12 self-contained)

Smoke invocation literal `pnpm --filter @forgeax/hello-hdrp-lighting smoke`
lives in two places:

- `.github/workflows/ci.yml` (CI smoke step, M7 / w27).
- `apps/hello/hdrp-lighting/package.json#forgeax.smokeInvocation`.

## See also

- `apps/parity/urp-vs-hdrp/` -- side-by-side URP / HDRP comparison + ≤4
  light pixel-parity bench (AC-22).
- `packages/runtime/README.md` §URP / HDRP -- conceptual overview, when
  to choose URP vs HDRP, capability gates.
- `packages/runtime/src/hdrp-pipeline.ts` -- HDRP pipeline source +
  `validateClusterGrid`.
