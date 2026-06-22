// apps/learn-render/2.lighting/1.colors/src/index.ts
// LearnOpenGL section 2.lighting 1.colors (forgeax mapping).
//
// LO 2.1 covers the concept that object color and light color combine
// via per-component multiplication in the fragment shader. The LO scene
// places a colored cube at origin, a white lamp cube at the light
// position, and computes `ambient + diffuse` in Phong style.
//
// In forgeax, the same concept is expressed through the engine PBR
// pipeline (standard material + DirectionalLight component + unlit
// lamp marker). The visual differs from the LO Phong implementation,
// but the conceptual lesson -- object color interacts with light color
// -- is preserved.
// 1. engine usage
import { createApp } from '@forgeax/engine-app';
import type { App, AppError } from '@forgeax/engine-app';
import { Entity, World } from '@forgeax/engine-ecs';
import type { InputBackend } from '@forgeax/engine-input';
import { vec3 } from '@forgeax/engine-math';
import type { RhiError } from '@forgeax/engine-rhi/errors';
import {
  Camera,
  DirectionalLight,
  EngineEnvironmentError,
  HANDLE_CUBE,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  Transform,
} from '@forgeax/engine-runtime';
import type { MaterialAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  addFirstPersonSystem,
  CAMERA_FOV_RADIANS,
  createFirstPersonControls,
  createScrollFovAccumulator,
} from '../../../../shared/src/learn-render-first-person';

// 2. example-specific glue

// Object color (LO: `glm::vec3(1.0f, 0.5f, 0.31f)`)
const OBJECT_BASE_COLOR = [1.0, 0.5, 0.31, 1.0] as const;

// Light color (LO: `glm::vec3(1.0f, 1.0f, 1.0f)`)
const LIGHT_COLOR_R = 1.0;
const LIGHT_COLOR_G = 1.0;
const LIGHT_COLOR_B = 1.0;

// Light position (LO: `glm::vec3 lightPos(1.2f, 1.0f, 2.0f)`)
const LIGHT_POS_X = 1.2;
const LIGHT_POS_Y = 1.0;
const LIGHT_POS_Z = 2.0;

// Light direction (from light position toward origin, normalized).
// LO computes `normalize(lightPos - FragPos)`; forgeax DirectionalLight
// .direction points FROM light TOWARD surface, hence `normalize(-lightPos)`.
const LIGHT_DIR = vec3.normalize(vec3.create(), [-LIGHT_POS_X, -LIGHT_POS_Y, -LIGHT_POS_Z]);

const LAMP_SCALE = 0.2;
const CAMERA_POS_Z = 3;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100;


// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 2.lighting 1.colors] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const winExt = window as unknown as { __colorsInputBackend?: () => InputBackend };
  const overrideBackend = winExt.__colorsInputBackend?.();

  const bundler = forgeaxBundlerAdapter();
  const appRes: { ok: true; value: App } | { ok: false; error: AppError | RhiError | EngineEnvironmentError } =
    overrideBackend === undefined
      ? await createApp(target, {}, bundler)
      : await createFirstPersonControls(target, overrideBackend, bundler);
  if (!appRes.ok) {
    reportBootstrapError(appRes.error);
    return;
  }
  const app = appRes.value;
  const renderer = app.renderer;
  const world = app.world;

  app.onError((e) => {
    console.error('[learn-render 2.lighting 1.colors] app.onError:', e.code, e.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: e.code, hint: e.hint });
  });

  const assets = renderer.assets;
  assets.configurePackIndex('/pack-index.json');

  // The engine ships HANDLE_CUBE as the procedural cube; MeshFilter uses it
  // directly below (no per-demo GUID round-trip needed).

  // feat-20260523 M8-T03: schema-driven material; paramSchema declared inline
  // so the demo stays self-contained without a .pack.json sidecar.
  const objectMatHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({
      baseColor: [OBJECT_BASE_COLOR[0], OBJECT_BASE_COLOR[1], OBJECT_BASE_COLOR[2], 1],
      metallic: 0.0,
      roughness: 0.5,
    }),
  );

  // Unlit material for the lamp cube (always renders white, like LO's
  // separate light cube shader).
  const lampMatHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.unlit([1.0, 1.0, 1.0, 1.0]),
  );

  // Spawn the colored object cube at origin (LO: cube at origin).
  world
    .spawn(
      {
        component: Transform,
        data: {},
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [objectMatHandle] } },
    )
    .unwrap();

  // Spawn the lamp cube at the light position (LO: separate white cube).
  world
    .spawn(
      {
        component: Transform,
        data: {
          posX: LIGHT_POS_X, posY: LIGHT_POS_Y, posZ: LIGHT_POS_Z,
          scaleX: LAMP_SCALE, scaleY: LAMP_SCALE, scaleZ: LAMP_SCALE,
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [lampMatHandle] } },
    )
    .unwrap();

  // Spawn a directional light pointing from lamp position toward the cube
  // (LO: Phong diffuse formula with `normalize(lightPos - FragPos)`).
  world.spawn({
    component: DirectionalLight,
    data: {
      directionX: LIGHT_DIR[0] ?? 0,
      directionY: LIGHT_DIR[1] ?? 0,
      directionZ: LIGHT_DIR[2] ?? 0,
      colorR: LIGHT_COLOR_R,
      colorG: LIGHT_COLOR_G,
      colorB: LIGHT_COLOR_B,
      intensity: 1.0,
    },
  });

  // Spawn camera at LO initial pose (0,0,3) yaw=-90 deg pitch=0; first-person
  // system below drives WASD/mouse/scroll on top of this spawn.
  const cameraAspect = target.width / target.height;
  world.spawn(
    {
      component: Transform,
      data: { posZ: CAMERA_POS_Z },
    },
    {
      component: Camera,
      data: perspective({
        fov: CAMERA_FOV_RADIANS,
        aspect: cameraAspect,
        near: CAMERA_NEAR,
        far: CAMERA_FAR,
      }),
    },
  ).unwrap();

  addFirstPersonSystem(world, renderer, {
    name: 'learn-render-colors-first-person',
    overrideBackend,
  });
  addScrollFovSystem(world, renderer);

  installCaptureHook(target, app, world);

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 2.lighting 1.colors] app.start failed:', startRes.error);
    return;
  }
  console.warn(`[learn-render 2.lighting 1.colors] backend=${renderer.backend}`);
}

function installCaptureHook(
  _target: HTMLCanvasElement,
  app: App,
  world: World,
): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureColors?: CaptureHook };
  const renderer = app.renderer;
  win.__captureColors = async (): Promise<Uint8Array> => {
    world.update();
    renderer.draw(world);
    const r = await renderer.readPixels();
    if (!r.ok) {
      throw new Error(
        `[learn-render 2.lighting 1.colors] readPixels failed: ${r.error.code} -- ${r.error.hint ?? ''}`,
      );
    }
    return r.value;
  };
}

function addScrollFovSystem(world: App['world'], renderer: App['renderer']): void {
  const scrollFov = createScrollFovAccumulator();
  world.addSystem({
    name: 'learn-render-colors-scroll-fov',
    after: ['input-frame-start-scan'],
    queries: [{ with: [Camera, Entity] }],
    fn: (world, queryResults) => {
      const snapshot = renderer.input.snapshot(world);
      if (snapshot === undefined) return;
      scrollFov.apply(snapshot.mouse.wheelDelta);
      for (const bundles of queryResults[0]) {
        for (let i = 0; i < bundles.Entity.self.length; i++) {
          bundles.Camera.fov[i] = scrollFov.fovRad;
        }
      }
    },
  });
}

function reportBootstrapError(err: AppError | RhiError | EngineEnvironmentError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[learn-render 2.lighting 1.colors] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[learn-render 2.lighting 1.colors] ${err.code}: ${err.hint}`);
}

declare global {
  interface Window {
    __captureColors?: () => Promise<Uint8Array>;
    __colorsInputBackend?: () => InputBackend;
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}