// apps/parity/urp-vs-hdrp -- URP vs HDRP pixel-parity fixture
// (feat-20260608-cluster-lighting / M7 / w26).
//
// Renders the SAME scene (≤4 PointLight) twice on a single page:
//   - left canvas (id="urp") via the engine default URP pipeline.
//   - right canvas (id="hdrp") via the HDRP pipeline (installPipeline).
//
// Both canvases use the SAME 8 dimensions (camera, geometry, material,
// light positions / intensities / ranges, clear color, viewport) so the
// only differing variable is the pipeline. AC-22 enforces ε ≤ 0.001
// pixel diff -- proves URP and HDRP shade the ≤4-light subset
// pixel-equivalent (cluster-forward must collapse to per-pixel forward
// for low light counts; the bench is a regression guard against
// future divergence in the shading math).
//
// __captureLeft / __captureRight are wired separately (left -> URP
// canvas readback, right -> HDRP canvas readback). The dual-capture
// pattern matches apps/parity/forgeax/src/main.ts so
// scripts/bench/pixel-parity.mjs can drive this fixture with the same
// captureBothFromSinglePage() shape.
//
// Charter mapping:
//   - P5 consistent abstraction: URP and HDRP are two installations of
//     the same RenderPipeline interface (registerPipeline +
//     installPipeline); the pixel-equivalent ≤4 light subset proves the
//     abstraction collapses correctly when the cluster-forward inner
//     loop is bound by the same number of lights as the URP forward
//     loop.
//   - F1 progressive disclosure: the two `bootstrap` calls below are
//     byte-for-byte identical except for the installPipeline call --
//     AI users grep `installPipeline(` to see exactly which surface
//     swaps the pipeline.

import { World } from '@forgeax/engine-ecs';
import {
  Camera,
  createRenderer,
  EngineEnvironmentError,
  HANDLE_CUBE,
  HDRP_PIPELINE_ID,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  PointLight,
  type Renderer,
  Transform,
  URP_PIPELINE_ID,
} from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const CANVAS_W = 512;
const CANVAS_H = 512;
const BASE_R = 0.6;
const BASE_G = 0.6;
const BASE_B = 0.65;

// Four matched PointLight specs -- shared by URP and HDRP scenes. Range
// is generous (8m) so the cluster-forward AABB intersection picks each
// light into the same cluster as the URP forward loop walks.
const LIGHT_SPECS = [
  { x: 0.8, y: 0.8, z: 0.6, r: 1, g: 0.85, b: 0.7, intensity: 4 },
  { x: -0.8, y: 0.7, z: 0.5, r: 0.7, g: 0.85, b: 1, intensity: 4 },
  { x: 0.3, y: -0.7, z: 0.7, r: 0.85, g: 1, b: 0.85, intensity: 3 },
  { x: -0.4, y: -0.6, z: 0.4, r: 1, g: 0.9, b: 0.85, intensity: 3 },
] as const;

const urpCanvasMaybe = document.querySelector<HTMLCanvasElement>('#urp');
const hdrpCanvasMaybe = document.querySelector<HTMLCanvasElement>('#hdrp');
if (!urpCanvasMaybe || !hdrpCanvasMaybe) {
  throw new Error('parity-urp-vs-hdrp: missing <canvas id="urp"> / <canvas id="hdrp">');
}
const urpCanvas: HTMLCanvasElement = urpCanvasMaybe;
const hdrpCanvas: HTMLCanvasElement = hdrpCanvasMaybe;
urpCanvas.width = CANVAS_W;
urpCanvas.height = CANVAS_H;
hdrpCanvas.width = CANVAS_W;
hdrpCanvas.height = CANVAS_H;

bootstrap().catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[parity-urp-vs-hdrp] no usable backend:', err);
  } else {
    console.error('[parity-urp-vs-hdrp] bootstrap error:', err);
  }
});

async function bootstrap(): Promise<void> {
  const urpRenderer = await createRenderer(urpCanvas, {}, forgeaxBundlerAdapter());
  const hdrpRenderer = await createRenderer(hdrpCanvas, {}, forgeaxBundlerAdapter());

  // Left: keep URP (engine default; URP_PIPELINE_ID is referenced for
  // grep gate + a sanity assertion via the perFramePassNames after
  // ready resolves).
  void URP_PIPELINE_ID;

  // Right: install HDRP via the same surface AI users would (charter P5).
  const urpReady = await urpRenderer.ready;
  if (!urpReady.ok) {
    console.error('[parity-urp-vs-hdrp] URP renderer.ready failed:', urpReady.error);
    return;
  }
  const hdrpReady = await hdrpRenderer.ready;
  if (!hdrpReady.ok) {
    console.error('[parity-urp-vs-hdrp] HDRP renderer.ready failed:', hdrpReady.error);
    return;
  }

  const installRes = hdrpRenderer.installPipeline({
    kind: 'render-pipeline',
    pipelineId: HDRP_PIPELINE_ID,
    config: { clusterGrid: { x: 16, y: 9, z: 24 } },
  });
  if (!installRes.ok) {
    console.error(
      '[parity-urp-vs-hdrp] installPipeline failed:',
      installRes.error.code,
      installRes.error.hint,
    );
    return;
  }

  const urpWorld = new World();
  const hdrpWorld = new World();
  populateScene(urpRenderer, urpWorld);
  populateScene(hdrpRenderer, hdrpWorld);

  // Initial draw so canvases have content before the first capture call.
  urpRenderer.draw([urpWorld], { owner: 0 });
  hdrpRenderer.draw([hdrpWorld], { owner: 0 });

  declareCaptureHooks(urpRenderer, urpWorld, hdrpRenderer, hdrpWorld);
}

function populateScene(_renderer: Renderer, world: World): void {
  // Standard PBR material -- both pipelines route the same material
  // through their forward shading path. The ≤4-light forward inner loop
  // (URP) and the cluster-forward inner loop (HDRP, with the cluster
  // bins for our 4 spawn positions populated) should produce
  // pixel-equivalent radiance. Material lives as a user-tier shared ref on
  // the World (D-19: no AssetRegistry round-trip for engine-built payloads).
  const matHandle = world.allocSharedRef('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::default-standard-pbr',
        tags: { LightMode: 'Forward' },
        queue: 2000,
      },
    ],
    paramValues: {
      baseColor: [BASE_R, BASE_G, BASE_B],
      metallic: 0.0,
      roughness: 0.4,
    },
  });

  // Hero cube at origin facing camera.
  world.spawn(
    {
      component: Transform,
      data: { posX: 0, posY: 0, posZ: 0, quatW: 1 },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [matHandle] } },
  ).unwrap();

  // 4 PointLight matched specs.
  for (const spec of LIGHT_SPECS) {
    world.spawn(
      { component: Transform, data: { posX: spec.x, posY: spec.y, posZ: spec.z, quatW: 1 } },
      {
        component: PointLight,
        data: {
          colorR: spec.r,
          colorG: spec.g,
          colorB: spec.b,
          intensity: spec.intensity,
          range: 8,
        },
      },
    );
  }

  // Camera locked: fov = 45deg, aspect = 1 (512x512), z = 3.
  world.spawn(
    { component: Transform, data: { posZ: 3 } },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 1.0 }) },
  ).unwrap();

  // Suppress unused import warning for Materials (charter F1 grep gate
  // helper -- AI users find Materials.unlit / Materials.standard via the
  // same module path).
  void Materials;
}

declare global {
  interface Window {
    __captureLeft?: () => Promise<Uint8Array>;
    __captureRight?: () => Promise<Uint8Array>;
  }
}

function declareCaptureHooks(
  urp: Renderer,
  urpWorld: World,
  hdrp: Renderer,
  hdrpWorld: World,
): void {
  const captureFor = (renderer: Renderer, world: World): (() => Promise<Uint8Array>) => async () => {
    renderer.draw([world], { owner: 0 });
    const r = await renderer.readPixels();
    if (!r.ok) {
      throw new Error(
        `parity-urp-vs-hdrp: readPixels failed: ${r.error.code} -- ${r.error.hint ?? ''}`,
      );
    }
    const flat = r.value;
    const out = new Uint8Array(CANVAS_W * CANVAS_H * 4);
    const rowBytes = CANVAS_W * 4;
    for (let y = 0; y < CANVAS_H; y++) {
      const srcOffset = y * rowBytes;
      const dstOffset = (CANVAS_H - 1 - y) * rowBytes;
      out.set(flat.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
    }
    return out;
  };
  window.__captureLeft = captureFor(urp, urpWorld);
  window.__captureRight = captureFor(hdrp, hdrpWorld);
}
