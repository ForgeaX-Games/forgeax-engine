# hello-bloom

> Bloom post-processing opt-in exemplar. Press Space to toggle the 4-pass declarative bloom pipeline at runtime.

(feat-20260531-bloom-first-declarative-render-graph-pass / M4 / w18)

## What is demonstrated

- **4-pass declarative render graph chain**: bloom-bright -> bloom-blur-h -> bloom-blur-v -> bloom-composite -- the engine's first post-processing chain built on `RenderGraph.addPass({reads,writes,execute})`.
- **Camera bloom columns**: 4 new f32 columns (`bloom`/`bloomThreshold`/`bloomIntensity`/`bloomBlurRadius`) configured per-Camera alongside `tonemap`/`antialias`.
- **Zero-overhead default**: bloom=0 (BLOOM_DISABLED) allocates no textures, binds no pipelines -- full early-return in the 4 execute closures.
- **Runtime toggle**: Space-key press-edge system swaps Camera.bloom between BLOOM_ENABLED and BLOOM_DISABLED via world.set. DOM HUD overlay mirrors state as text.
- **HDR+Reinhard pipeline**: Camera.tonemap=Reinhard-Extended enables the HDR path required by bloom; the bright-pass extracts pixels > bloomThreshold (1.0) from the HDR target.

## Run

```bash
pnpm dev                        # vite dev server -> localhost:5173
pnpm build                      # production bundle -> dist/
pnpm --filter @forgeax/hello-bloom smoke   # structural smoke (dawn-node)
```

## Scene

An emissive sphere (baseColor=[1.0,0.85,0.55], emissive=[1.0,0.7,0.3], emissiveIntensity=2.0) on the left and a non-emissive reference cube on the right, under a slant directional light. The sphere's > 1.0 HDR pixels feed the bloom bright-pass; the cube stays below the threshold as a visual anchor.

## Keybind

| Key | Action |
|:--|:--|
| <kbd>Space</kbd> | Toggle bloom on/off |

## Smoke gate

`scripts/smoke-dawn.mjs` runs a structural-only dawn-node headless smoke (300 frames, no pixel readback). Verdict: app.onError == 0, console.error == 0, and all 4 bloom passes (bloom-bright / bloom-blur-h / bloom-blur-v / bloom-composite) present in the compiled per-frame render graph (`renderer.perFramePassNames`).
