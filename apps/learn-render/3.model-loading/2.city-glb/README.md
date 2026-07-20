# learn-render 3.2 -- city-glb loader (scratch / diagnosis)

> [!NOTE]
> Loads the UE5.2 `city_Sample_512.glb` (254 meshes, 452 materials, 1160 textures, 360 nodes) through the standard `@forgeax/engine-gltf` importer + 4-step recipe, reusing the learn-render 3.1 (Sponza) scaffold. Built to reproduce and fix two reported rendering issues: (1) texture tiling anomaly, (2) transparent materials rendering opaque.

## The asset is worktree-local (not committed)

The `.glb` is ~62 MB and decodes to multiple GB of RGBA textures. It lives in `local-assets/` (gitignored) with its generated `<source>.meta.json` sidecar:

```bash
# regenerate the sidecar after (re)placing the glb
node ../../../../packages/gltf/dist/cli-gltf.mjs import local-assets/city_Sample_512.glb
```

Scene GUID (`019f221e-d014-716b-94d2-5bf3b3243806`) is hard-coded in `src/index.ts`; if you re-import a different glb, update it from the sidecar's `scene` sub-asset.

## How to run

```bash
pnpm --filter @forgeax/app-learn-render-3-model-loading-2-city-glb dev      # vite dev server (browser WebGPU)
pnpm --filter @forgeax/app-learn-render-3-model-loading-2-city-glb visual   # headless playwright screenshot -> screenshot.png
```

> [!IMPORTANT]
> First load is slow (~3-4 min): the scene fans out ~1028 on-demand `POST /__import` sub-asset imports (254 meshes + 452 materials + 321 textures) and decodes them to RGBA. The `visual.mjs` sentinel waits up to 7 min for `window.__citySceneReady`.

## Engine bugs found + fixed (demo failures route to engine fixes)

| # | Symptom | Root cause | Fix |
|:--|:--|:--|:--|
| 1 | **Model would not load at all** -- `mesh-vertex-stride-mismatch` on every multi-UV mesh | The mesh-bin decode consumer (`asset-registry.ts`) rehydrated only `skinIndex`/`skinWeight` from the `.bin`, **dropping the `uv1..uvK` standalone attribute arrays** (feat-20260629 multi-uv regression). The wide interleaved `vertices` buffer (14 floats) then disagreed with `attributes` (which lost `uv1`), so the register-stride validator computed stride 12 and rejected. | Reconstruct `uv1..uvK` Float32Arrays from the interleaved buffer during `.bin` decode using the header's `uvSetCount`/`floatsPerVertex`. |
| 2 | **Transparent materials render opaque** | `toMaterialAsset` (gltf bridge) dropped glTF `alphaMode` entirely -- every material got a single opaque `Forward` pass at `queue=2000`. | Parser captures `alphaMode`/`alphaCutoff`; bridge maps `BLEND` -> `renderState.blend` (straight-alpha) + `queue=Transparent(3000)`. |
| 3 | **Transparency crash** (exposed by fix #2) -- `pbr-identity-instance-ssbo ... too small ... requires at least 80 bytes` | The shared identity instance buffer was 64 B (one mat4), but the sprite `PER_INSTANCE_REGION=true` pipeline variant (reached by the transparent split pass once any transparent geometry exists) needs 80 B (mat4 + region vec4). | Size the shared identity instance buffer to 80 B (`createRenderer.ts`). |
| 4 | **Wrong texture tiling** (issue #1) -- surfaces textured with UV set 0 while 433/452 materials specify `texCoord=1` | Built-in PBR sampled UV set 0 only (feat-20260629 single-UV product decision). | Built-in PBR/skin declare `@location(6) uv1` + per-material `uvSet` UBO selector (offset 68, UBO stays 80 B); bridge emits `uvSet` from `baseColorTexCoord`. Clamp-to-last keeps single-UV byte-identical. |
| 5 | **Crosswalk BLEND submesh renders black** (issue #2, second facet) -- `MI_StreetDecals` is a transparent (BLEND) **submesh** on the multi-material `Street_2Lane*` meshes; its `a==0` gaps composited as solid black | Transparency routing was **entity-level, keyed on `material[0]` only**, and the LDR transparent sub-pass was **sprite-only + whole-mesh**. So a transparent PBR submesh of a multi-material mesh was drawn opaque (its `a==0` black RGB showing through). | **FIXED (Bug 5) — per-submesh transparency, end to end.** It's genuinely BLEND (alpha histogram: 58.9% `a==0`, 41.1% soft mid-alpha, 0% opaque), not MASK. Extract derives per-submesh `transparent`; the LDR split skips only transparent submeshes in the geometry pass and draws them in a generalized per-submesh PBR blend sub-pass; bridge sets `depthWriteEnabled=false` for BLEND. See the spec Bug 5 for the full rollout. |

## Issue #1 (tiling) -- FIXED (Bug 4)

- **433 of 452** materials specify `baseColorTexture.texCoord = 1` (sample **UV set 1**), and UV0 vs UV1 differ for 668/674 primitives.
- The built-in PBR shader previously sampled **UV set 0 only** (feat-20260629 kept it single-UV). It now declares a second UV set (`@location(6) uv1`) and honors a per-material `uvSet` selector in the material UBO; the bridge emits `uvSet` from `baseColorTexture.texCoord`. Single-UV meshes stay byte-identical via clamp-to-last (uv1 aliases onto uv0). See `docs/specs/2026-07-02-city-glb-multiuv-transparent-load-fixes.md` Bug 4 for the full three-PSO-path rollout.

## Charter note

This is a **scratch / diagnosis** app (all `forgeax.metrics` disabled, not in any CI gate). It exists to reproduce the two reported issues against a real large UE asset; the value is the five engine fixes above, which apply to any multi-UV / transparent glTF.
