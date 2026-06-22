// apps/learn-render/5.advanced-lighting/9.ssao/src/main.ts
// LearnOpenGL section 5.9 — Screen-Space Ambient Occlusion.
//
// LO 5.9 extends 5.8 deferred-shading by enabling SSAO on the same scene
// (9-cube 3x3 grid + 32 point lights, glibc seed=13). The visual delta is
// AO darkening at cube-floor contact edges + cube-cube cluster corners.
//
// Scene parity SSOT: the 5.8 main.ts numerical set + spawn structure is
// reproduced verbatim here; the only delta is `config.ssao = { enabled: true }`
// on the HDRP RenderPipelineAsset and a slightly tighter camera so AO contact
// shadows are unambiguous.
//
// Charter mapping:
//   - F1 single-entry indexability: SSAO turn-on is one literal field on the
//     HDRP config; AI users should not need to read the SSAO source to wire it.
//   - P3 explicit failure: bad ssao.radius / ssao.bias raise PostProcessError.
//
// GREP anchors for AI users:
//   - "// 1. engine usage"    public engine API consumed
//   - "// 2. scene constants" LO 5.8.1 numerical set + RNG (parity with 5.8)
//   - "// 3. bootstrap"       entry point wiring

// 1. engine usage

import { createApp } from '@forgeax/engine-app';
import type { CanvasAppError } from '@forgeax/engine-app';
import {
  Camera,
  EngineEnvironmentError,
  HANDLE_CUBE,
  HDRP_PIPELINE_ID,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  PointLight,
  Transform,
} from '@forgeax/engine-runtime';
import type { Handle, MaterialAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

// 2. scene constants — parity with 5.8 deferred-shading + 5.9 SSAO config

const NUM_LIGHTS = 32;
const CLUSTER_GRID = { x: 16, y: 9, z: 24 } as const;
const CUBE_SCALE = 0.5;
const CUBE_SPACING = 3.0;
const CUBE_Y = -0.5;

// Floor below the cube grid; large flat slab so SSAO has clear contact-edge
// darkening to render. Not in the 5.8 scene; added here because the AO effect
// reads strongest at object-floor contact, which 5.8 doesn't have.
const FLOOR_Y = -1.0;
const FLOOR_SCALE_XZ = 8.0;
const FLOOR_SCALE_Y = 0.1;
const FLOOR_COLOR: [number, number, number, number] = [0.6, 0.6, 0.6, 1];

// SSAO tuning: radius=0.5, bias=0.025, intensity=1.0 (LO 5.9 defaults).
const SSAO_CONFIG = {
  enabled: true,
  radius: 0.5,
  bias: 0.025,
  intensity: 1.0,
} as const;

// glibc-compatible LCG: matches `srand(13)` + `rand()` from LO 5.8.1.
// Verbatim from apps/learn-render/5.advanced-lighting/8.deferred-shading/src/main.ts.
function glibcRand(state: number): [number, number] {
  const next = ((state * 1103515245 + 12345) >>> 0) & 0x7fffffff;
  const value = (next >> 16) & 0x7fff;
  return [next, value];
}

function randomPosition(state: number): [number, number, number, number] {
  const [s1, xv] = glibcRand(state);
  const [s2, yv] = glibcRand(s1);
  const [s3, zv] = glibcRand(s2);
  const x = ((xv % 100) / 100.0) * 6.0 - 3.0;
  const y = ((yv % 100) / 100.0) * 6.0 - 3.0;
  const z = ((zv % 100) / 100.0) * 6.0 - 3.0;
  return [x, y, z, s3];
}

function randomColor(state: number): [number, number, number, number] {
  const [s1, rv] = glibcRand(state);
  const [s2, gv] = glibcRand(s1);
  const [s3, bv] = glibcRand(s2);
  const r = ((rv % 100) / 200.0) + 0.5;
  const g = ((gv % 100) / 200.0) + 0.5;
  const b = ((bv % 100) / 200.0) + 0.5;
  return [r, g, b, s3];
}

function generateLightData(): Array<{
  posX: number; posY: number; posZ: number;
  colorR: number; colorG: number; colorB: number;
}> {
  let state = 13;
  const lights: Array<{
    posX: number; posY: number; posZ: number;
    colorR: number; colorG: number; colorB: number;
  }> = [];
  for (let i = 0; i < NUM_LIGHTS; i++) {
    const [px, py, pz, sa] = randomPosition(state);
    const [cr, cg, cb, sb] = randomColor(sa);
    state = sb;
    lights.push({ posX: px, posY: py, posZ: pz, colorR: cr, colorG: cg, colorB: cb });
  }
  return lights;
}

const LIGHT_DATA = generateLightData();

const FALSIFY = (() => {
  if (typeof window !== 'undefined') {
    const url = new URL(window.location.href);
    return url.searchParams.get('falsify') ?? '';
  }
  return '';
})();

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) {
  throw new Error("[learn-render 5.9 ssao] missing <canvas id='app'> in index.html");
}

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[learn-render 5.9 ssao] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error('[learn-render 5.9 ssao] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appRes.ok) {
    reportAppError(appRes.error);
    return;
  }
  const app = appRes.value;
  console.warn(`[learn-render 5.9 ssao] backend=${app.renderer.backend}`);

  const ready = await app.renderer.ready;
  if (!ready.ok) {
    console.error('[learn-render 5.9 ssao] renderer.ready failed:', ready.error.code, ready.error.hint);
    return;
  }

  const assets = app.renderer.assets;
  if (assets === null) {
    console.error('[learn-render 5.9 ssao] AssetRegistry is null');
    return;
  }

  // Wire the __learnRenderErrors bus for onerror-gate coverage.
  const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
  if (bus !== undefined) {
    app.onError((error) => {
      bus.push({ code: error.code, hint: error.hint });
    });
  }

  const world = app.world;

  // AC-01: install HDRP with config.ssao. feat-20260614 M8 (D-19):
  // installPipeline takes the RenderPipelineAsset POD directly (no register
  // round-trip; the AssetRegistry holds no handle concept). Type narrowing
  // from pipelineId, no `as` assertion.
  const ssaoEnabled = FALSIFY !== 'ssao-off';
  const installRes = app.renderer.installPipeline({
    kind: 'render-pipeline',
    pipelineId: HDRP_PIPELINE_ID,
    config: {
      clusterGrid: CLUSTER_GRID,
      ssao: ssaoEnabled ? { ...SSAO_CONFIG } : { enabled: false },
    },
  });
  if (!installRes.ok) {
    console.error(
      '[learn-render 5.9 ssao] installPipeline failed:',
      installRes.error.code,
      installRes.error.hint,
    );
    return;
  }

  // Floor material. feat-20260614 M8 (D-17): mint a user-tier column handle
  // directly via world.allocSharedRef (returns a bare Handle, not a Result).
  const floorMatHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: FLOOR_COLOR }),
  );

  // Floor: large thin slab below the cube grid. Distinct from 5.8 scene —
  // 5.9 needs explicit ground plane so AO at object-floor contact is visible.
  world.spawn(
    {
      component: Transform,
      data: {
        posX: 0,
        posY: FLOOR_Y,
        posZ: 0,
        quatW: 1,
        scaleX: FLOOR_SCALE_XZ,
        scaleY: FLOOR_SCALE_Y,
        scaleZ: FLOOR_SCALE_XZ,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [floorMatHandle] } },
  ).unwrap();

  // Cube colors: 9 distinct hues for the 3x3 grid (parity with 5.8).
  const cubeColors: Array<[number, number, number]> = [
    [1.0, 0.3, 0.3], [0.3, 1.0, 0.3], [0.3, 0.3, 1.0],
    [1.0, 1.0, 0.3], [0.3, 1.0, 1.0], [1.0, 0.3, 1.0],
    [0.7, 0.7, 0.3], [0.3, 0.7, 0.7], [0.7, 0.3, 0.7],
  ];

  // Spawn 9 cubes in 3x3 grid at y=-0.5, spacing 3.0 (parity with 5.8).
  const cubeHandles: Handle<'MaterialAsset', 'shared'>[] = [];
  let idx = 0;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const cx = (col - 1) * CUBE_SPACING;
      const cz = (row - 1) * CUBE_SPACING;
      const [r, g, b] = cubeColors[idx]!;

      const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
        'MaterialAsset',
        Materials.standard({ baseColor: [r, g, b, 1] }),
      );
      cubeHandles.push(matHandle);

      world.spawn(
        {
          component: Transform,
          data: {
            posX: cx, posY: CUBE_Y, posZ: cz,
            quatW: 1,
            scaleX: CUBE_SCALE, scaleY: CUBE_SCALE, scaleZ: CUBE_SCALE,
          },
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [matHandle] } },
      ).unwrap();
      idx++;
    }
  }

  // Spawn 32 point lights from the pre-computed deterministic seed=13 data
  // (parity with 5.8). Each light gets a small light-box visualisation cube.
  for (let i = 0; i < NUM_LIGHTS; i++) {
    const ld = LIGHT_DATA[i]!;
    world.spawn(
      {
        component: Transform,
        data: { posX: ld.posX, posY: ld.posY, posZ: ld.posZ, quatW: 1 },
      },
      {
        component: PointLight,
        data: {
          colorR: ld.colorR,
          colorG: ld.colorG,
          colorB: ld.colorB,
          intensity: 1.0,
          range: 6.0,
        },
      },
    );

    world.spawn(
      {
        component: Transform,
        data: {
          posX: ld.posX, posY: ld.posY, posZ: ld.posZ,
          quatW: 1,
          scaleX: 0.125, scaleY: 0.125, scaleZ: 0.125,
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [cubeHandles[0]!] } },
    );
  }

  // Camera at (0, 1.5, 6) looking -Z (parity with 5.8). Eye height 1.5 +
  // cube grid at y=-0.5 keeps both the cube tops and the floor visible so
  // SSAO contact-edge darkening reads clearly.
  world.spawn(
    {
      component: Transform,
      data: { posX: 0, posY: 1.5, posZ: 6.0, quatW: 1 },
    },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 50 }),
        clearR: 0.02,
        clearG: 0.02,
        clearB: 0.04,
      },
    },
  ).unwrap();

  const startRes = app.start();
  if (!startRes.ok) {
    reportAppError(startRes.error);
    return;
  }
  console.warn(
    `[learn-render 5.9 ssao] running. SSAO=${ssaoEnabled ? 'enabled' : 'OFF'} (radius=${SSAO_CONFIG.radius}, bias=${SSAO_CONFIG.bias}, intensity=${SSAO_CONFIG.intensity}). 9-cube 3x3 grid + 32 point lights + floor (parity with 5.8 deferred-shading).`,
  );
}

function reportAppError(err: CanvasAppError | EngineEnvironmentError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[learn-render 5.9 ssao] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[learn-render 5.9 ssao] ${err.code}: ${err.hint}`);
}

declare global {
  interface Window {
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}
