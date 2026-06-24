// apps/learn-render/2.lighting/2.basic-lighting/src/index.ts
// LearnOpenGL section 2.lighting 2.1 basic_lighting_diffuse + 2.2 basic_lighting_specular (forgeax mapping).
//
// LO 2.1 teaches diffuse lighting: the angle between the surface normal
// and the per-fragment light direction determines brightness
// (`max(dot(norm, normalize(lightPos - FragPos)), 0)`). LO 2.2 adds the
// specular component: view-dependent highlights computed from the
// reflection vector and the view direction
// (`pow(max(dot(viewDir, reflectDir), 0), shininess)`). The light source is
// at a fixed world-space position `lightPos` -- it is a point light,
// not a directional light, even though LO 2.2's fragment shader skips
// distance attenuation.
//
// In forgeax, both diffuse and specular are handled by the engine PBR
// pipeline: a `PointLight` component on the lamp entity (its position comes
// from the companion `Transform`) drives a Cook-Torrance + Lambertian BRDF
// with KHR_lights_punctual quartic + 1/d^2 attenuation. The `roughness`
// parameter controls the specular lobe width -- analogous to LO's
// `shininess` exponent but physically-based and energy-conserving.
//
// This example uses a low roughness (0.2) to produce a clearly visible
// specular highlight. Note: forgeax's PBR point light always applies
// 1/d^2 attenuation, while LO 2.2's hand-written fragment shader does
// not -- so the cube here renders darker than the LO reference at the
// same lamp position. That is physically correct, not a rendering bug.
// 1. engine usage
import { createApp } from '@forgeax/engine-app';
import type { App, CanvasAppError } from '@forgeax/engine-app';
import { Entity, World } from '@forgeax/engine-ecs';
import type { InputBackend } from '@forgeax/engine-input';
import {
  Camera,
  EngineEnvironmentError,
  HANDLE_CUBE,
  MeshFilter,
  MeshRenderer,
  PointLight,
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

// PBR material parameters -- low roughness produces a visible specular
// highlight (analogous to LO's specular shininess exponent). metallic=0.0
// keeps the material dielectric so the specular lobe reflects light color
// rather than tinting by baseColor.
const OBJECT_METALLIC = 0.0;
const OBJECT_ROUGHNESS = 0.2;

// Light color (LO: `glm::vec3(1.0f, 1.0f, 1.0f)`)
const LIGHT_COLOR_R = 1.0;
const LIGHT_COLOR_G = 1.0;
const LIGHT_COLOR_B = 1.0;

// Light position (LO: `glm::vec3 lightPos(1.2f, 1.0f, 2.0f)`).
// In forgeax this is the lamp entity's `Transform.pos*` -- the same entity
// carries the `PointLight` component, so the render system reads its
// world-space position via the `[Transform, PointLight]` query.
const LIGHT_POS_X = 1.2;
const LIGHT_POS_Y = 1.0;
const LIGHT_POS_Z = 2.0;

const LAMP_SCALE = 0.2;
const CAMERA_POS_Z = 3;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100;
const CAMERA_PROJECTION_PERSPECTIVE = 0;


// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 2.lighting 2.basic-lighting] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const winExt = window as unknown as { __basicLightingInputBackend?: () => InputBackend };
  const overrideBackend = winExt.__basicLightingInputBackend?.();

  const bundler = forgeaxBundlerAdapter();
  const appRes: { ok: true; value: App } | { ok: false; error: CanvasAppError } =
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
    console.error('[learn-render 2.lighting 2.basic-lighting] app.onError:', e.code, e.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: e.code, hint: e.hint });
  });

  const assets = renderer.assets;
  assets.configurePackIndex('/pack-index.json');

  // HANDLE_CUBE is the builtin procedural cube; MeshFilter uses it directly.

  // feat-20260527 m3 / w12: pass-based MaterialAsset minted via
  // world.allocSharedRef (M8 D-17 column mint).
  const objectMatHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
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
      baseColor: [OBJECT_BASE_COLOR[0], OBJECT_BASE_COLOR[1], OBJECT_BASE_COLOR[2]],
      metallic: OBJECT_METALLIC,
      roughness: OBJECT_ROUGHNESS,
    },
  });

  // Unlit material for the lamp cube.
  const lampMatHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [{ name: 'Forward', shader: 'forgeax::default-unlit', tags: { LightMode: 'Forward' }, queue: 2000 }],
    paramValues: { baseColor: [1.0, 1.0, 1.0, 1.0] },
  });

  // Spawn the object cube at origin.
  world
    .spawn(
      {
        component: Transform,
        data: {
          posX: 0, posY: 0, posZ: 0,
          quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
          scaleX: 1, scaleY: 1, scaleZ: 1,
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [objectMatHandle] } },
    )
    .unwrap();

  // Spawn the lamp cube + co-located point light. PointLight's position
  // comes from its companion Transform, so a single entity carries both
  // the visible lamp marker and the light source -- mirroring LO's
  // `lightPos` semantics where the lamp cube IS the emitter.
  // PointLight defaults: range = +Infinity (no quartic truncation), but
  // 1/d^2 attenuation always applies in the PBR shader.
  world
    .spawn(
      {
        component: Transform,
        data: {
          posX: LIGHT_POS_X, posY: LIGHT_POS_Y, posZ: LIGHT_POS_Z,
          quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
          scaleX: LAMP_SCALE, scaleY: LAMP_SCALE, scaleZ: LAMP_SCALE,
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [lampMatHandle] } },
      {
        component: PointLight,
        data: {
          colorR: LIGHT_COLOR_R,
          colorG: LIGHT_COLOR_G,
          colorB: LIGHT_COLOR_B,
          intensity: 100.0,
          range: 50,
        },
      },
    )
    .unwrap();

  // Spawn camera at LO initial pose (0,0,3) yaw=-90 deg pitch=0; first-person
  // system below drives WASD/mouse/scroll on top of this spawn.
  const cameraAspect = target.width / target.height;
  world.spawn(
    {
      component: Transform,
      data: {
        posX: 0, posY: 0, posZ: CAMERA_POS_Z,
        quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
        scaleX: 1, scaleY: 1, scaleZ: 1,
      },
    },
    {
      component: Camera,
      data: {
        fov: CAMERA_FOV_RADIANS,
        aspect: cameraAspect,
        near: CAMERA_NEAR,
        far: CAMERA_FAR,
        projection: CAMERA_PROJECTION_PERSPECTIVE,
        left: -1, right: 1, bottom: -1, top: 1,
      },
    },
  );

  addFirstPersonSystem(world, renderer, {
    name: 'learn-render-basic-lighting-first-person',
    overrideBackend,
  });
  addScrollFovSystem(world, renderer);

  installCaptureHook(target, app, world);

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 2.lighting 2.basic-lighting] app.start failed:', startRes.error);
    return;
  }
  console.warn(`[learn-render 2.lighting 2.basic-lighting] backend=${renderer.backend}`);
}

function installCaptureHook(
  _target: HTMLCanvasElement,
  app: App,
  world: World,
): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureBasicLighting?: CaptureHook };
  const renderer = app.renderer;
  win.__captureBasicLighting = async (): Promise<Uint8Array> => {
    world.update();
    renderer.draw(world);
    const r = await renderer.readPixels();
    if (!r.ok) {
      throw new Error(
        `[learn-render 2.lighting 2.basic-lighting] readPixels failed: ${r.error.code} -- ${r.error.hint ?? ''}`,
      );
    }
    return r.value;
  };
}

function addScrollFovSystem(world: App['world'], renderer: App['renderer']): void {
  const scrollFov = createScrollFovAccumulator();
  world.addSystem({
    name: 'learn-render-basic-lighting-scroll-fov',
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

function reportBootstrapError(err: CanvasAppError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[learn-render 2.lighting 2.basic-lighting] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[learn-render 2.lighting 2.basic-lighting] ${err.code}: ${err.hint}`);
}

declare global {
  interface Window {
    __captureBasicLighting?: () => Promise<Uint8Array>;
    __basicLightingInputBackend?: () => InputBackend;
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}