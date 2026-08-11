---
name: forgeax-engine-vfx
description: ForgeaX code-first GPU VFX: author two WGSL hooks, cook Pack v2, play through ECS, and render executable billboard, mesh, ribbon, trail, or beam output. Use when creating, loading, debugging, or extending VFX effects.
---

# ForgeaX VFX

Use one path:

1. Author schema-v2 emitter metadata with `program: { module }`, required fixed bounds, schedule, and renderer GUIDs.
2. Author `vfx_spawn` and `vfx_update` in WGSL; import `forgeax_vfx::prelude` and shared shader modules with `#import`.
3. Cook with `createParticleCodeNativeCooker(modules)`; publish payload and `particle-effect/program.json` atomically.
4. Create one `createVfxRuntimeHost({ camera })`, attach each `{ world, assets }`, and register `host.feature` with the Renderer.
5. Load by GUID with `loadVfxGpuEffect`, allocate a shared `ParticleEffectAsset` ref, and spawn `ParticleEffectPlayer`.

Read [`packages/vfx/README.md`](../../packages/vfx/README.md) for the author ABI and lifecycle, [`packages/vfx-compiler/README.md`](../../packages/vfx-compiler/README.md) for reflection and cook errors, and [`packages/vfx-render/README.md`](../../packages/vfx-render/README.md) for GPU/render ownership.

> [!IMPORTANT]
> Behavior belongs in WGSL code, not a node/operator graph. Do not add CPU mirrors, runtime compilation, backend-name checks, direct RHI access, particle readback, or demo-side render workarounds.

Switch on structured error codes and use `detail` plus `hint`. Unknown source fields fail closed. Batch B accepts executable billboard advanced fields and independent ribbon, trail, and beam topologies. It does not add CPU fallback, runtime compilation, raw author bindings, CPU particle mirrors, gameplay readback, graph authoring, or VFX RPC.

For editor/tool inspection, narrow registry payloads with `isVfxGpuEffectAsset`
and project them through `describeVfxGpuEffect`. The immutable descriptor owns
the emitter tree, timeline, dependencies and executable/partial/unavailable
capability truth without exposing compiler objects or raw WGSL bytes.

Inspect runtime state with `host.inspect(world)`. The aggregate is keyed by host
generation, player handle, asset GUID and emitter ID; do not collapse it back to
one latest intent or treat a realm-local handle as cross-World identity. Recover
through the owning generation/LKG path. For asset changes, run
`node scripts/asset-cook-contract.mjs`; a package-local scripts path is invalid.
Verify with:

```sh
pnpm --filter @forgeax/hello-boss-lightning smoke:browser
pnpm --filter @forgeax/hello-boss-lightning smoke
pnpm --filter @forgeax/hello-boss-lightning smoke:falsify
node apps/hello/boss-lightning/scripts/smoke-public-only.mjs
pnpm metrics:check
pnpm metrics:run
```

Browser and Dawn are required because Null structural success cannot prove compute validation, topology draws, or pixels. Visual evidence records `advanced-renderers-visible`, `live-patch-continuity`, `event-sub-emitter-visible`, and `hmr-last-known-good-visible` with a PNG and falsifier result.
