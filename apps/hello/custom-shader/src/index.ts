// apps/hello/custom-shader/src/index.ts
//
// feat-20260523-shader-template-instance-split AC-14 free-end demo --
// pulse material custom shader with the full M9 visible-pulse wiring.
//
// Custom material shader path:
//   pulse-material.wgsl  : user-side WGSL ~30 line body, #imports
//                          forgeax_view::common + forgeax_pbr::brdf
//   pulse-material.wgsl.meta.json
//                        : sidecar with assetType='shader' +
//                          subAssets[].kind='material-shader' +
//                          paramSchema (3-field SSOT, feat-20260528-
//                          material-shader-registration-unification);
//                          the @forgeax/engine-vite-plugin-shader
//                          transform hook reads paramSchema from this
//                          sidecar for the production build path
//                          (M3 / T03; AC-09).
//   pulse-material.pack.json
//                        : MaterialAsset payload referring to the shader
//                          via materialShader='my-game::pulse-material'
//                          (path identifier, not GUID); paramSchema +
//                          paramValues carry baseColor (color) + metallic
//                          (f32 -- aliased as 'time') + roughness (f32 --
//                          aliased as 'speed').
//
// Engine wiring (M9-T05 -- per-MaterialShader pipeline cache):
//   1. Vite plugin shader processes pulse-material.wgsl at build / dev,
//      emitting the composed wgsl into the shader manifest.
//   2. App imports `./pulse-material.wgsl` -- vite returns
//      { hash, wgsl } (hash = composed wgsl content hash).
//   3. After `await renderer.ready`, app calls
//      shader.registerMaterialShader('my-game::pulse-material',
//      { source: composedWgsl, paramSchema: [...] }).
//   4. App registers a MaterialAsset with `materialShader:
//      'my-game::pulse-material'` + paramValues. MeshFilter binds the
//      cube; MeshRenderer binds the new material handle.
//   5. RenderSystem.record-stage hits cache miss on first frame, calls
//      buildPipelineForMaterialShader -> stores in
//      Map<materialShaderId, RenderPipeline>; subsequent frames cache-hit.
//   6. raf loop mutates `paramValues.metallic = (now - start) / 1000` to
//      drive the shader's `time` field. The 48-byte Material UBO writer
//      (record stage) overlays paramSnapshot positionally -- the f32 slot
//      that the WGSL reads as `time` gets written every frame, producing
//      a visible sin(time*speed) pulse on the cube colour (AC-14).
//
// AI-user discoverability anchors (charter F1):
//   grep `registerMaterialShader` -> finds this file + the engine-shipped
//        register API (M5-T05 + ShaderRegistry.ts).
//   grep `my-game::pulse-material` -> finds the WGSL + .pack.json + this
//        file (3-way co-source binding).
//   grep `forgeax::default-standard-pbr` -> finds the engine-shipped
//        sibling (default PBR; same registerMaterialShader surface,
//        charter P4 consistent abstraction).
//
// Engine boundary note: pulse-material's WGSL declares
//   struct PulseUniforms { baseColor: vec4<f32>, time: f32, speed: f32 };
// at @group(1) @binding(0). The engine's per-frame Material UBO writer
// fills the 48-byte slot positionally per paramSchema declaration order
// (M9-T05 schema-driven overlay): the first f32 entry lands at the
// Material.metallic offset (16); pulse-material reads that offset as
// `time`. The second f32 entry lands at Material.roughness (offset 20);
// pulse-material reads that offset as `speed`. Byte-identical std140
// layout. M9 ships this as the simplest schema-driven shape; an
// explicit per-shader uniform descriptor lifecycle is OOS-9.

import { World } from '@forgeax/engine-ecs';
import {
  Camera,
  acquireCanvasContext,
  createRenderer,
  DirectionalLight,
  EngineEnvironmentError,
  MeshFilter,
  MeshRenderer,
  Name,
  perspective,
  Transform,
} from '@forgeax/engine-runtime';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import type { MaterialAsset } from '@forgeax/engine-runtime';  // feat-20260527 M1: register<MaterialAsset>
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

import pulseShader from './pulse-material.wgsl';

const PULSE_MATERIAL_SHADER_PATH = 'my-game::pulse-material';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-custom-shader: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[custom-shader] no usable backend:', err);
  } else {
    console.error('[custom-shader] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const renderer = await createRenderer(target, {}, forgeaxBundlerAdapter());
  // Configure canvas context (mirrors hello-cube; canvas-context migration
  // bridge from the M4 RHI rework).
  const ctxResult = acquireCanvasContext(target);
  if (ctxResult.ok) {
    const cfgResult = ctxResult.value.configure({
      device: renderer.device,
      format: 'rgba8unorm',
      usage: 0x10 | 0x01,
    });
    if (!cfgResult.ok) {
      console.error('[custom-shader] canvasContext.configure failed:', cfgResult.error);
    }
  } else {
    console.warn('[custom-shader] acquireCanvasContext failed:', ctxResult.error);
  }
  console.warn(`[custom-shader] backend=${renderer.backend}`);

  const ready = await renderer.ready;
  if (!ready.ok) {
    console.error('[custom-shader] renderer.ready failed:', ready.error);
    return;
  }

  // Renderer.shader / .assets are nullable (D-S3 narrow surface). Both
  // resolve non-null after successful createRenderer (charter P3 explicit
  // failure: a null here means renderer construction did not complete;
  // no PBR pipeline cache exists and the visible-pulse demo is
  // structurally inapplicable).
  const shader = renderer.shader;
  const assets = renderer.assets;
  if (shader === null || assets === null) {
    console.error('[custom-shader] renderer.shader or renderer.assets is null; visible-pulse demo requires a fully initialized WebGPU backend.');
    return;
  }
  const world = new World();

  // Register the user-side material shader entry under the path identifier
  // declared in the .wgsl `#define_import_path` header. ShaderRegistry
  // throws on duplicate registration (fail-fast no-overwrite per AGENTS.md
  // explicit registration); the demo registers exactly once between
  // renderer.ready and the first draw call (charter P3 explicit failure --
  // any wiring drift surfaces immediately at startup).
  //
  // paramSchema is hardcoded here for the dawn-node smoke path (non-Vite,
  // feat-20260528-material-shader-registration-unification M4 w17
  // dual-path note: production build reads paramSchema from
  // pulse-material.wgsl.meta.json sidecar via vite-plugin-shader w10;
  // the hardcoded copy below is the smoke-only fallback).
  shader.registerMaterialShader(PULSE_MATERIAL_SHADER_PATH, {
    source: pulseShader.wgsl,
    paramSchema: [
      { name: 'baseColor', type: 'color' },
      { name: 'metallic', type: 'f32' },
      { name: 'roughness', type: 'f32' },
    ],
  });

  // Register the schema-driven MaterialAsset that references the user
  // shader. paramSchema names mirror the engine Material UBO slot names
  // so the record-stage writer (M9-T05 schema-driven overlay) fills the
  // 48-byte UBO positionally: the first color entry -> baseColor (offset
  // 0..16), the first f32 -> Material.metallic offset (16), the second
  // f32 -> Material.roughness offset (20). pulse-material.wgsl reads the
  // metallic offset as `time` and the roughness offset as `speed` (both
  // are f32 fields in PulseUniforms, std140 byte-identical). Initial
  // paramValues seeds time=0 and speed=2 (sin period ~pi seconds).
  //
  // Note: Materials.standard() uses forgeax::default-standard-pbr, but
  // this demo uses a custom material shader path. We register via
  // register<MaterialAsset> with the custom materialShader identifier.
  const paramValues: Record<string, number | number[]> = {
    baseColor: [0.95, 0.45, 0.2],
    metallic: 0,
    roughness: 2,
  };
  const materialHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: PULSE_MATERIAL_SHADER_PATH,
        tags: { LightMode: 'Forward' },
        queue: 2000,
      },
    ],
    paramValues,
  });

  // Procedural box (12-floats stride: position + normal + uv + tangent).
  // The PBR pipeline cache builder (M9-T03) assumes the standard 4-BGL
  // chain and 12-floats vertex layout for user shaders.
  const boxRes = createBoxGeometry(1, 1, 1);
  if (!boxRes.ok) {
    console.error('[custom-shader] createBoxGeometry failed:', boxRes.error);
    return;
  }
  const boxMeshHandle = world.allocSharedRef('MeshAsset', boxRes.value);

  // Compose the World: cube + camera + directional light. Direct light
  // ensures the pulse-material lit path produces a non-black baseline
  // (the shader's f_schlick term still evaluates against the world
  // normal); the SMOKE_PIXEL_THRESHOLD pulse-delta gate at M9-T06 reads
  // pixels at 3 distinct t values to confirm the colour is visibly
  // pulsing across frames.
  world
    .spawn(
      { component: Name, data: { value: 'pulse-cube' } as never },
      {
        component: Transform,
        data: {},
    },
      { component: MeshFilter, data: { assetHandle: boxMeshHandle } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    )
    .unwrap();
  world.spawn(
    {
      component: Transform,
      data: { posZ: 3 },
  },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  ).unwrap();
  world.spawn({
    component: DirectionalLight,
    data: {
      directionX: -0.5,
      directionY: -1,
      directionZ: -0.3,
      colorR: 1,
      colorG: 0.95,
      colorB: 0.9,
      intensity: 1.0,
  },
  }).unwrap();

  // raf loop: mutate paramValues.metallic (read by the shader as `time`).
  // The asset's paramValues object aliases the local `paramValues`
  // reference (register<MaterialAsset> stores by-reference) so a
  // mutation here propagates to the next extract -> snapshot -> record
  // -> Material UBO writeBuffer cycle. M9 OOS: an explicit
  // `assets.updateMaterialParams(handle, partial)` API lands in a future
  // feat (charter P5 producer / consumer split).
  const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const frame = (): void => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    paramValues.metallic = (now - startTime) / 1000;
    const r = renderer.draw(world);
    if (!r.ok) console.error('[custom-shader] draw error:', r.error);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}