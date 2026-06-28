// apps/learn-render/4.advanced-opengl/2.stencil-testing/src/index.ts
// LearnOpenGL section 4.2 - Stencil Testing (pixel-level replica).
//
// Three entity groups implementing the LO 4.2 multi-pass stencil outline
// sequence through separate entities (the engine does not currently support
// per-pass Transform overrides on a single entity):
//
//   (A) Floor: metal.png floor at Y=-0.5, PBR material with
//       stencilWriteMask=0x00 -- does NOT write to stencil buffer.
//   (B) Cubes: two marble.jpg cubes at (-1,0,-1) and (2,0,0), PBR material
//       with stencil.compare='always' + stencilWriteMask=0xFF +
//       stencilReference=1 -- always passes stencil test and writes ref=1.
//   (C) Outlines: two scale-1.1 cubes at the same positions, pure-color
//       unlit outline-solid shader with stencil.compare='not-equal' +
//       stencilReadMask=0xFF + stencilReference=1 + depthWriteEnabled=false.
//       Since the floor wrote no stencil and the normal cubes wrote ref=1
//       everywhere, the outline passes only where stencil != 1 -- the
//       outline band surrounding each cube.
//
// Textures are loaded through the GUID asset pipeline:
//   configurePackIndex('/pack-index.json') + loadByGuid<TextureAsset>.
//
// LO exact stencil parameters (research Finding LO-SCENE section 2):
//   - outline color: vec4(0.04, 0.28, 0.26, 1.0) -- cyan-green
//   - outline scale: 1.1
//   - normal pass: glStencilFunc(GL_ALWAYS, 1, 0xFF), glStencilMask(0xFF)
//   - outline pass: glStencilFunc(GL_NOTEQUAL, 1, 0xFF), glStencilMask(0x00),
//                   glDisable(GL_DEPTH_TEST)
//
// GREP anchors for AI users:
//   - "// 1. engine usage"    public engine API consumed
//   - "// 2. example glue"    LO 4.2 scene-specific constants + GUIDs
//   - "// 3. bootstrap"       entry point wiring (1)+(2)

// 1. engine usage
import { createApp } from '@forgeax/engine-app';
import type { App } from '@forgeax/engine-app';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  Camera,
  createDevImportTransport,
  DirectionalLight,
  HANDLE_CUBE,
  HANDLE_QUAD,
  MeshFilter,
  MeshRenderer,
  perspective,
  Transform,
} from '@forgeax/engine-runtime';
import type { MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import { RenderQueue, unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { addFirstPersonSystem } from '../../../../shared/src/learn-render-first-person';

// 2. example glue

import outlineSolidShader from './outline-solid.wgsl';

const OUTLINE_SHADER_ID = 'learn-render::outline-solid';

const PACK_INDEX_URL = '/pack-index.json';

// Texture GUIDs from forgeax-engine-assets/learn-opengl/textures/*.meta.json
const METAL_GUID_STR = '019e3969-1d47-760f-982e-7bad1ffd969c';
const MARBLE_GUID_STR = '019e3969-1d46-7933-b14d-4faee5635ad6';

// LO 4.2 outline color: vec4(0.04, 0.28, 0.26, 1.0) -- cyan-green.
const OUTLINE_COLOR: readonly [number, number, number, number] = [
  0.04, 0.28, 0.26, 1.0,
];

const OUTLINE_SCALE = 1.1;

// Scene geometry: LO 4.1 exact parameters (shared with depth-testing demo).
// Floor: Y=-0.5, 10x10 quad.
const FLOOR_Y = -0.5;
const FLOOR_SCALE = 5;
const SIN_NEG_90 = Math.sin(-Math.PI / 4);
const COS_NEG_90 = Math.cos(-Math.PI / 4);

// Cube world positions (LO 4.1/4.2 verbatim).
const CUBE1_POS = [-1.0, 0.0, -1.0] as const;
const CUBE2_POS = [2.0, 0.0, 0.0] as const;

// Camera: (0,0,3), Zoom=45 deg, near=0.1, far=100.0.
const CAMERA_POS_Z = 3;
const CAMERA_FOV = Math.PI / 4;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100.0;

// Light direction pointing down-left-forward.
const LIGHT_DIR_X = -0.5;
const LIGHT_DIR_Y = -1.0;
const LIGHT_DIR_Z = -0.3;

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 4.2 stencil-testing] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() },
  );
  if (!appRes.ok) {
    console.error('[learn-render 4.2 stencil-testing] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  const renderer = app.renderer;
  const world = app.world;
  app.onError((error) => {
    console.error('[learn-render 4.2 stencil-testing] app.onError:', error.code, error.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });
  const assets = renderer.assets;

  // Register the custom outline-solid material shader before scene setup.
  const shader = renderer.shader;
  if (shader === null) {
    console.error('[learn-render 4.2 stencil-testing] renderer.shader is null');
    return;
  }
  shader.registerMaterialShader(OUTLINE_SHADER_ID, {
    source: outlineSolidShader.wgsl,
    paramSchema: [{ name: 'baseColor', type: 'color' }],
  });

  // Wire the pack-index URL for GUID-based texture loading.
  assets.configurePackIndex(PACK_INDEX_URL);

  // Parse texture GUIDs.
  const metalGuidRes = AssetGuid.parse(METAL_GUID_STR);
  const marbleGuidRes = AssetGuid.parse(MARBLE_GUID_STR);
  if (!metalGuidRes.ok || !marbleGuidRes.ok) {
    console.error('[learn-render 4.2 stencil-testing] GUID parse failed');
    return;
  }

  // Load textures through the GUID asset pipeline.
  const metalHandleRes = await assets.loadByGuid<TextureAsset>(metalGuidRes.value);
  const marbleHandleRes = await assets.loadByGuid<TextureAsset>(marbleGuidRes.value);
  if (!metalHandleRes.ok || !marbleHandleRes.ok) {
    console.error(
      '[learn-render 4.2 stencil-testing] loadByGuid failed:',
      metalHandleRes.ok ? null : metalHandleRes.error.code,
      marbleHandleRes.ok ? null : marbleHandleRes.error.code,
    );
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) {
      if (!metalHandleRes.ok) bus.push({ code: metalHandleRes.error.code, hint: metalHandleRes.error.hint });
      if (!marbleHandleRes.ok) bus.push({ code: marbleHandleRes.error.code, hint: marbleHandleRes.error.hint });
    }
    return;
  }
  const metalTex = unwrapHandle(world.allocSharedRef('TextureAsset', metalHandleRes.value));
  const marbleTex = unwrapHandle(world.allocSharedRef('TextureAsset', marbleHandleRes.value));

  // ── Floor material: PBR with stencilWriteMask=0x00 ────────────────
  // AC-01: stencilWriteMask: 0x00 as a top-level literal with no `as`.
  const floorMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::default-standard-pbr',
        tags: { LightMode: 'Forward' },
        queue: RenderQueue.Geometry as number,
        renderState: {
          stencilWriteMask: 0x00,
        },
      },
    ],
    paramValues: {
      baseColor: [1.0, 1.0, 1.0, 1.0],
      metallic: 0.0,
      roughness: 0.9,
      baseColorTexture: metalTex,
    },
  });

  // ── Cube material: PBR with stencil write (ref=1, mask=0xFF) ─────
  // Normal pass writes stencil ref=1 everywhere the cube rasterizes.
  const cubeMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::default-standard-pbr',
        tags: { LightMode: 'Forward' },
        queue: RenderQueue.Geometry as number,
        renderState: {
          stencilWriteMask: 0xFF,
          stencil: { compare: 'always', passOp: 'replace' },
        },
        stencilReference: 1,
      },
    ],
    paramValues: {
      baseColor: [1.0, 1.0, 1.0, 1.0],
      metallic: 0.0,
      roughness: 0.5,
      baseColorTexture: marbleTex,
    },
  });

  // ── Outline material: unlit solid color, stencil test only ───────
  // Outline passes where stencil != 1 (only the band outside the
  // cube interior, since the normal cube pass wrote 1 everywhere and
  // the floor wrote nothing). depthWriteEnabled=false mirrors
  // LO glDisable(GL_DEPTH_TEST) so the outline always draws.
  const outlineMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        // Single-pass outline: shares URP's main scene pass (selector
        // `{ LightMode: ['Forward'] }`). The pass-name "ForwardOutline"
        // documents intent inside the multi-pass material; the LightMode
        // tag must remain 'Forward' so the URP main pass selects this
        // pass (post-#344 pipeline-driven pass selector). Stencil ref-1
        // not-equal compare + queue Geometry+1 ensure outline draws
        // after the cube body within the same scene pass.
        name: 'ForwardOutline',
        shader: OUTLINE_SHADER_ID,
        tags: { LightMode: 'Forward' },
        queue: (RenderQueue.Geometry as number) + 1,
        renderState: {
          stencilReadMask: 0xFF,
          stencil: { compare: 'not-equal' },
          depthWriteEnabled: false,
        },
        stencilReference: 1,
      },
    ],
    paramValues: {
      baseColor: OUTLINE_COLOR,
    },
  });

  // ── Spawn entities ────────────────────────────────────────────────

  // Spawn floor.
  world.spawn(
    {
      component: Transform,
      data: {
        posY: FLOOR_Y,
        scaleX: FLOOR_SCALE,
        scaleY: FLOOR_SCALE,
        scaleZ: FLOOR_SCALE,
        quatX: SIN_NEG_90,
        quatW: COS_NEG_90,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [floorMat] } },
  ).unwrap();

  // Spawn cube 1 at (-1, 0, -1).
  world.spawn(
    {
      component: Transform,
      data: {
        posX: CUBE1_POS[0],
        posY: CUBE1_POS[1],
        posZ: CUBE1_POS[2],
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [cubeMat] } },
  ).unwrap();

  // Spawn cube 2 at (2, 0, 0).
  world.spawn(
    {
      component: Transform,
      data: {
        posX: CUBE2_POS[0],
        posY: CUBE2_POS[1],
        posZ: CUBE2_POS[2],
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [cubeMat] } },
  ).unwrap();

  // Spawn outline cube 1 at (-1, 0, -1) with scale 1.1.
  world.spawn(
    {
      component: Transform,
      data: {
        posX: CUBE1_POS[0],
        posY: CUBE1_POS[1],
        posZ: CUBE1_POS[2],
        scaleX: OUTLINE_SCALE,
        scaleY: OUTLINE_SCALE,
        scaleZ: OUTLINE_SCALE,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [outlineMat] } },
  ).unwrap();

  // Spawn outline cube 2 at (2, 0, 0) with scale 1.1.
  world.spawn(
    {
      component: Transform,
      data: {
        posX: CUBE2_POS[0],
        posY: CUBE2_POS[1],
        posZ: CUBE2_POS[2],
        scaleX: OUTLINE_SCALE,
        scaleY: OUTLINE_SCALE,
        scaleZ: OUTLINE_SCALE,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [outlineMat] } },
  ).unwrap();

  // Directional light.
  world.spawn({
    component: DirectionalLight,
    data: {
      directionX: LIGHT_DIR_X,
      directionY: LIGHT_DIR_Y,
      directionZ: LIGHT_DIR_Z,
      colorR: 1.0,
      colorG: 1.0,
      colorB: 1.0,
      intensity: 1.0,
    },
  });

  // Camera at (0, 0, 3), Zoom=45 deg. First-person system drives
  // WASD/mouse/scroll on top of this spawn.
  const cameraEntity = world.spawn(
    { component: Transform, data: { posZ: CAMERA_POS_Z } },
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
    name: 'learn-render-4.2-first-person',
    overrideBackend: undefined,
  });

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 4.2 stencil-testing] app.start failed:', startRes.error);
    return;
  }

  installCaptureHook(app, world);

  window.addEventListener('resize', () => {
    const dpr = devicePixelRatio;
    target.width = window.innerWidth * dpr;
    target.height = window.innerHeight * dpr;
    world.set(cameraEntity, Camera, { aspect: window.innerWidth / window.innerHeight });
  });

  console.warn(`[learn-render 4.2 stencil-testing] backend=${renderer.backend}`);
}

// RHI-debug live-pixel hook for the capture smoke harness (pixel mode). Drives
// one update + draw + readPixels so the live canvas read is anchored to the same
// frame the capture records. Only meaningful when the page is served with
// FORGEAX_ENGINE_RHI_DEBUG=1; harmless otherwise.
function installCaptureHook(app: App, world: App['world']): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureStencilTesting?: CaptureHook };
  const renderer = app.renderer;
  win.__captureStencilTesting = async (): Promise<Uint8Array> => {
    world.update();
    renderer.draw(world);
    const r = await renderer.readPixels();
    if (!r.ok) {
      throw new Error(
        `[learn-render 4.2 stencil-testing] readPixels failed: ${r.error.code} -- ${r.error.hint ?? ''}`,
      );
    }
    return r.value;
  };
}

declare global {
  interface Window {
    __captureStencilTesting?: () => Promise<Uint8Array>;
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}