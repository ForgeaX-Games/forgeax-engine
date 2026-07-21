// apps/learn-render/5.advanced-lighting/1.advanced-lighting/src/index.ts
// LearnOpenGL section 5.1 - Blinn-Phong.
// Per-fragment Blinn-Phong shading via custom WGSL shader.
//
// Custom shader path (charter F1 grep gate):
//   grep `registerMaterialShader` -> finds this file
//   grep `learn-render::5-1-blinn-phong` -> finds WGSL + index.ts + meta.json
//
// MaterialAsset is constructed as a POJO directly (no Materials.standard())
// to demonstrate the raw asset shape for AI users.
//
// GREP anchors for AI users:
//   - "// 1. engine usage"    public engine API consumed
//   - "// 2. example glue"    LO 5.1 scene-specific constants + GUIDs
//   - "// 3. bootstrap"       entry point wiring (1)+(2)

// 1. engine usage
import { type App, createApp } from '@forgeax/engine-app';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  Camera,
  createDevImportTransport,
  MeshFilter,
  MeshRenderer,
  perspective,
  Transform,
} from '@forgeax/engine-runtime';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import type { MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { addFirstPersonSystem } from '../../../../shared/src/learn-render-first-person';

import blinnPhongShader from './blinn-phong.wgsl';

const BLINN_PHONG_SHADER_ID = 'learn-render::5-1-blinn-phong' as const;

// 2. example glue

const PACK_INDEX_URL = '/pack-index.json';

// LO 5.1 renders a wood FLOOR plane lit from above. The whole point of the
// chapter is the grazing-angle floor where Blinn-Phong's half-vector
// specular visibly differs from Phong's reflect-vector specular. Texture
// GUID from forgeax-engine-assets/learn-opengl/textures/wood.png.meta.json.
const WOOD_GUID_STR = '019e3969-1d48-7c3b-ac24-6d68f457065f';

// Floor geometry: LO uses a 20x20 plane on the XZ plane at y=-0.5 with
// normal +Y. createPlaneGeometry produces an XY plane facing +Z, so we
// rotate it -90deg about X to lay it flat (normal -> +Y) so the floor
// normal faces the overhead light at the origin.
const FLOOR_SIZE = 20;
const FLOOR_Y = -0.5;
// quat for -90deg about X: (sin(-pi/4), 0, 0, cos(-pi/4)).
const FLOOR_QUAT_X = Math.sin(-Math.PI / 4);
const FLOOR_QUAT_W = Math.cos(-Math.PI / 4);

// Blinn-Phong constants (lightPos, lightColor, shininess) are baked into
// `blinn-phong.wgsl` as `const` because LO 5.1 never animates them.
// LIGHT_POS is (0,0,0) — above the floor (FLOOR_Y=-0.5), so the floor's
// +Y normal faces the light and the surface lights up (cube-at-origin
// placed the light INSIDE the geometry, back-facing every visible face).
// `viewPos` is read from the engine View UBO (`view.cameraPos`), which
// the engine fills from the active Camera transform every frame. User
// shaders cannot allocate additional @group(1) bindings above 6 — the
// engine reserves binding 7..17 for Skylight + emissive/AO (see
// `pbr-pipeline.ts buildPbrPipelineLayouts`).
const CAMERA_POS_Z = 3;
const CAMERA_FOV = Math.PI / 4;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100.0;

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 5.1 blinn-phong] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() },
  );
  if (!appRes.ok) {
    console.error('[learn-render 5.1 blinn-phong] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  const renderer = app.renderer;
  const world = app.world;
  app.onError((error) => {
    console.error('[learn-render 5.1 blinn-phong] app.onError:', error.code, error.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });
  const assets = renderer.assets;

  // Wire the pack-index URL for GUID-based texture loading.
  assets.configurePackIndex(PACK_INDEX_URL);

  // Register the Blinn-Phong custom material shader. paramSchema is empty
  // because the WGSL inlines the LO 5.1 constants (no extra UBO required).
  const shader = renderer.shader;
  if (shader === null) {
    console.error('[learn-render 5.1 blinn-phong] renderer.shader is null');
    return;
  }
  shader.registerMaterialShader(BLINN_PHONG_SHADER_ID, {
    source: blinnPhongShader.wgsl,
    paramSchema: [
      { name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] },
      { name: 'baseColorTexture', type: 'texture2d' },
    ],
  });

  // Parse texture GUID.
  const woodGuidRes = AssetGuid.parse(WOOD_GUID_STR);
  if (!woodGuidRes.ok) {
    console.error('[learn-render 5.1 blinn-phong] GUID parse failed');
    return;
  }

  // Load texture through the GUID asset pipeline.
  const texRes = await assets.loadByGuid<TextureAsset>(woodGuidRes.value);
  if (!texRes.ok) {
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: texRes.error.code, hint: texRes.error.hint });
    console.error('[learn-render 5.1 blinn-phong] loadByGuid failed:', texRes.error.code);
    return;
  }
  const woodTex = texRes.value;

  // Construct MaterialAsset POJO directly.
  const mat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: BLINN_PHONG_SHADER_ID,
        tags: { LightMode: 'Forward' },
      },
    ],
    paramValues: {
      baseColorTexture: unwrapHandle(world.allocSharedRef('TextureAsset', woodTex)),
    },
  });

  // Floor plane: 20x20 on the XZ plane at y=-0.5, normal +Y facing the
  // overhead light at the origin (LIGHT_POS in blinn-phong.wgsl). The
  // procedural plane faces +Z, so rotate -90deg about X to lay it flat.
  const floorRes = createPlaneGeometry(FLOOR_SIZE, FLOOR_SIZE);
  if (!floorRes.ok) {
    console.error('[learn-render 5.1 blinn-phong] createPlaneGeometry failed:', floorRes.error);
    return;
  }
  const floorMesh = world.allocSharedRef('MeshAsset', floorRes.value);
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, FLOOR_Y, 0], quat: [FLOOR_QUAT_X, 0, 0, FLOOR_QUAT_W]},
    },
    { component: MeshFilter, data: { assetHandle: floorMesh } },
    { component: MeshRenderer, data: { materials: [mat] } },
  ).unwrap();

  // Camera at (0, 0, 3), FOV=45 deg.
  const cameraEntity = world.spawn(
    { component: Transform, data: { pos: [0, 0, CAMERA_POS_Z]} },
    {
      component: Camera,
      data: perspective({
        fov: CAMERA_FOV,
        aspect: target.width / target.height,
        near: CAMERA_NEAR,
        far: CAMERA_FAR,
      }),
    },
  ).unwrap();

  addFirstPersonSystem(app.world, app.renderer, {
    name: 'learn-render-5.1-first-person',
    overrideBackend: undefined,
  });

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 5.1 blinn-phong] app.start failed:', startRes.error);
    return;
  }

  window.addEventListener('resize', () => {
    const dpr = devicePixelRatio;
    target.width = window.innerWidth * dpr;
    target.height = window.innerHeight * dpr;
    world.set(cameraEntity, Camera, { aspect: window.innerWidth / window.innerHeight });
  });

  console.warn(`[learn-render 5.1 blinn-phong] backend=${renderer.backend}`);

  installCaptureHook(app, world);
}

// RHI-debug live-pixel hook for the capture smoke harness (pixel mode). Drives
// one update + draw + readPixels so the live canvas read is anchored to the same
// frame the capture records. Only meaningful when the page is served with
// FORGEAX_ENGINE_RHI_DEBUG=1; harmless otherwise.
function installCaptureHook(app: App, world: App['world']): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureAdvancedLighting?: CaptureHook };
  const renderer = app.renderer;
  win.__captureAdvancedLighting = async (): Promise<Uint8Array> => {
    world.update(1 / 60).unwrap();
    renderer.draw([world], { owner: 0 });
    const r = await renderer.readPixels();
    if (!r.ok) {
      throw new Error(
        `[learn-render 5.1 blinn-phong] readPixels failed: ${r.error.code} -- ${r.error.hint ?? ''}`,
      );
    }
    return r.value;
  };
}

declare global {
  interface Window {
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
    __captureAdvancedLighting?: () => Promise<Uint8Array>;
  }
}