---
name: forgeax-engine-vfx
description: ForgeaX code-first GPU particles: author two WGSL hooks, cook Pack v2, play through ECS, and render persistent compute state with billboard or mesh output. Use when creating, loading, debugging, or extending VFX effects.
---

# ForgeaX VFX

Use one path:

1. Author schema-v2 emitter metadata with `program: { module }`, required fixed bounds, schedule, and renderer GUIDs.
2. Author `vfx_spawn` and `vfx_update` in WGSL; import `forgeax_vfx::prelude` and shared shader modules with `#import`.
3. Cook with `createParticleCodeNativeCooker(modules)`; publish payload and `particle-effect/program.json` atomically.
4. Create one `createVfxRuntimeHost({ camera })`, attach each `{ world, assets }`, and register `host.feature` with the Renderer.
5. Load by GUID with `loadVfxGpuEffect`, allocate a shared `ParticleEffectAsset` ref, and spawn `ParticleEffectPlayer`.

Read [`packages/vfx/README.md`](../../packages/vfx/README.md) for the author ABI and lifecycle, [`packages/vfx-compiler/README.md`](../../packages/vfx-compiler/README.md) for cook errors, and [`packages/vfx-render/README.md`](../../packages/vfx-render/README.md) for GPU/render ownership.

> [!IMPORTANT]
> Behavior belongs in WGSL code, not a node/operator graph. Do not add CPU mirrors, runtime compilation, backend-name checks, direct RHI access, particle readback, or demo-side render workarounds.

Switch on structured error codes and use `detail` plus `hint`. Unknown source fields fail closed. Batch A does not accept CPU fallback, parent/value variants, live parameters, texture sheets, particle sorting, ribbons, beams, or events.

Verify engine/RHI changes with all required smoke gates. For VFX specifically, run Boss Lightning `smoke:browser`, `smoke`, and `smoke:falsify`; Browser and Dawn are required because Null structural success cannot prove compute validation or pixels.
