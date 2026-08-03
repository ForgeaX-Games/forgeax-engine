# forgeax-engine-vfx

Use this skill for the public VFX path: load a cooked effect by GUID, attach
`ParticleEffectPlayer`, install the CPU simulation plugin, and connect its
validated billboard/mesh observations to `@forgeax/engine-vfx-render`.

`@forgeax/engine-vfx` owns source validation, Pack v2 loading, author intent,
FixedUpdate lifecycle, stock CPU operators, telemetry, and `ParticleRenderBatch`.
`@forgeax/engine-vfx-render` owns scene-space resolution, GPU preparation,
RenderFeature contribution, draw recording, and readiness diagnostics.

Switch on closed error codes and read `detail` plus `hint`. For renderer warm-up,
accept only bounded `render-feature-preparation-failed` events whose detail says
`stage: 'prepare'` and `recovery: 'next-frame'`. A later or persistent event is
a failure. `empty` is valid no-live-output state; it is not `unavailable` or
`failed`.

The Boss Lightning probes are the concrete verification path: Dawn runs 300
frames and checks billboard/mesh buckets, draw count, particle count, pixel
energy, and persistent errors; Browser checks the dev Pack/import path, camera
readiness, render readiness, and both falsifiers. Visual evidence is
supplementary and does not replace API, recovery, or smoke assertions.

First-read recipe: build with
`particleEffectImporter(createStockParticleOperatorRegistry())`, then load
effect GUID `019e9c00-0000-7000-8000-000000000000` through `/pack-index.json`
and `particleEffectPackLoader`. Allocate the shared effect handle only after
the load Result is ready; `createStockParticleCpuExecutorRegistry()` is the
matching runtime registry. The scene owner supplies a real `ChildOf` joint to
`particleSceneSpaceResolver({ world, resolveJoint })`. The feature's
`diagnostics().error` keeps the material or mesh handle identity in
`detail.assetGuid` during retryable preparation; retry the next valid frame and
surface persistent validation errors unchanged.
