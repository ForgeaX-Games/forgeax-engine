# @forgeax/hello-skin

feat-20260523-skin-skeleton-animation M4 convergence demo -- synthetic 2-bone skinned cube with AnimationPlayer auto-play.

## Quick start

```bash
pnpm --filter @forgeax/hello-skin dev
```

Expected first frame: a small blue-tinted cube (0.3x scale, unlit `baseColor=[0.3, 0.6, 1.0]`) centered on screen, rotating its upper half (joint_1) around the Y-axis over a 2-second looping animation. Background is dark blue (`clearColor=[0.05, 0.05, 0.08]`).

## Fresh worktree prerequisite

If you cloned a fresh worktree (or just ran `git worktree add`), run this one-time bootstrap before `pnpm -F @forgeax/hello-skin dev`. Otherwise vite's `optimizeDeps` crashes on a missing `@forgeax/engine-gltf` dist and the demo never loads -- surfacing as a misleading `loadByGuid<SceneAsset>(...) -> asset-not-imported` console error against whatever vite happens to bind to (or against a sibling demo's `localhost:5173` on a port collision). See `bug-20260612-skin-fox-loadbyguid-asset-not-imported-in-dev` (`plan-decisions.md` M1 root-cause witness) for the structured trace.

```bash
git submodule update --init --recursive    # forgeax-engine-assets sidecar
cp <main-tree>/packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm packages/wgpu-wasm/pkg/
pnpm install --frozen-lockfile
pnpm build                                  # MUST run; emits dist/index.mjs for every @forgeax/engine-* package
pnpm -F @forgeax/hello-skin dev --strictPort
```

If `pnpm -F @forgeax/hello-skin dev`'s stderr includes `Failed to resolve entry for package "@forgeax/engine-gltf"` -> you skipped `pnpm build`. Run it once and re-launch dev. See `AGENTS.md` Worktree discipline section for the canonical checklist.

## Fixture

Synthetic inline data (no external GLB). RiggedSimple.glb submodule fixture not available; the demo constructs assets programmatically in `src/main.ts`:

- **SkeletonAsset**: 2 joints (joint_0 at origin, joint_1 at +0.5 Y), both IBM = identity
- **SkinAsset**: 2 jointPaths `['joint_0', 'joint_1']`, skeletonGuid cross-reference
- **AnimationClip**: 2-second LINEAR rotation quaternion on joint_1 (0 -> 90 deg around Y), looping
- **MeshAsset**: 24-vertex cube with `skinIndex` (0.5 weight on each joint) + `skinWeight` attributes
- **MaterialAsset**: Unlit `baseColor=[0.3, 0.6, 1.0]`

## Smoke

```bash
pnpm --filter @forgeax/hello-skin smoke
```

dawn-node, 300 frames, 5-grid-sample readback: all sites must exceed epsilon=0.05 distance from clear color, no NaN pixels, no RhiError events.

## Pipeline

```
Synth assets -> registerWithGuid -> world.spawn(Skin + AnimationPlayer)
-> registerAdvanceAnimationPlayer -> render loop
-> default-standard-pbr-skin.wgsl (vertex-stage palete skinning)
```

## Animation playback (feat-20260612-skin-palette-per-frame-upload)

挂 `Skin` + `AnimationPlayer` + `Transform` 三件套即可——Survey / Walk / Run 三 clip 在 Fox.glb 上自动播放。**零 setup**：`createApp` 自动注册 `advanceAnimationPlayer`；`createRenderer` 启动期一次性建 `SkinPaletteAllocator`；每帧 `extractFrame` 入口 `resetForFrame()` + per-skin entity `allocateSlice` + `writeJointPalette` 把 `Transform.world × IBM` 上传到 `pbr-skin` BGL `@group(2)@binding(1)`。

> [!NOTE]
> PR #361（feat-20260611-fox-skinning-vertex-attribute-chain）落地时 Fox 渲染**bind-pose 静态**——layer-1..4（VBO + BGL + PSO + record-stage BG）已通，但 palette UBO 是 16320 B identity-mat4 静态 stub。feat-20260612 接通了 `AnimationPlayer` -> `advanceAnimationPlayer` -> `propagateTransforms` -> `extractFrame hasSkin` 段 -> `SkinPaletteAllocator` -> record-stage dynOffset 全链，三只 Fox 在 Survey / Walk / Run 下真动起来。

详见 [`packages/runtime/README.md` §SkinPaletteAllocator](../../../packages/runtime/README.md#skinpaletteallocator-feat-20260612-skin-palette-per-frame-upload) + [`forgeax-engine-render-pipeline` §skin palette per-frame upload](../../../skills/forgeax-engine-render-pipeline/SKILL.md#skin-palette-per-frame-upload-feat-20260612)。