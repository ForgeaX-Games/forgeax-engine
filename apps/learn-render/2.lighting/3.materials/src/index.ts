// apps/learn-render/2.lighting/3.materials/src/index.ts
// LearnOpenGL section 2.lighting 3.1 materials (forgeax mapping).
//
// LO 3.1 teaches that material properties (Phong: ambient, diffuse,
// specular, shininess) modulate how a surface responds to a light. The
// LO scene drives this with a single cube and a time-varying light color
// (sin waves at different frequencies per RGB channel), showing how the
// same material responds to different light spectra.
//
// In forgeax the Phong material slots are replaced by PBR parameters:
// `baseColor` + `metallic` + `roughness` on a single StandardMaterial.
// The PointLight carries only `color` + `intensity` (+ `range`) -- mainstream
// PBR engines don't split ambient/diffuse/specular onto the light side
// (ambient is handled by env lighting/IBL, specular by the BRDF). Thus
// `light.ambient` / `light.specular` from LO have no engine-side
// counterparts; we translate only the color animation.
//
// LO 3.1's fragment shader uses `normalize(light.position - FragPos)` --
// the source is a point light at a fixed world-space position, with no
// distance attenuation. forgeax's `PointLight` always applies 1/d^2
// attenuation in `pbr.wgsl` (KHR_lights_punctual + math safety net), so
// the cube renders darker than the LO reference at the same position;
// that is physically correct, not a rendering bug.
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

// Object base color (LO: `material.diffuse = glm::vec3(1.0f, 0.5f, 0.31f)`)
const OBJECT_BASE_COLOR = [1.0, 0.5, 0.31, 1.0] as const;

// PBR material parameters. LO uses `material.shininess = 32` which maps
// to a moderately tight specular lobe; roughness ~0.3 is a reasonable
// PBR equivalent (low enough to show a distinct highlight when the light
// is bright, broad enough to read as a non-mirror surface).
const OBJECT_METALLIC = 0.0;
const OBJECT_ROUGHNESS = 0.3;

// Light position (LO: `glm::vec3 lightPos(1.2f, 1.0f, 2.0f)`).
// Lamp visual + PointLight share one entity so the lamp's Transform
// drives both the visible marker and the light's world-space position.
const LIGHT_POS_X = 1.2;
const LIGHT_POS_Y = 1.0;
const LIGHT_POS_Z = 2.0;

// LO materials.cpp light animation: lightColor.{x,y,z} = sin(time*{2.0,0.7,1.3}).
// LO does not pre-multiply by 0.5/0.2 in the modern forgeax mapping
// (Phong's `diffuse = lightColor * 0.5` + `ambient = diffuse * 0.2`
// scaling factors are Phong-era hacks; PBR uses `color` directly and
// negative channels are clamped to 0 to mirror LO's framebuffer clamp).
const LIGHT_ANIM_FREQ_R = 2.0;
const LIGHT_ANIM_FREQ_G = 0.7;
const LIGHT_ANIM_FREQ_B = 1.3;
const LIGHT_ANIM_DT = 0.016; // ~60fps fixed step

// Lamp marker size (LO: `glm::scale(model, glm::vec3(0.2f))`)
const LAMP_SCALE = 0.2;

// Camera (LO: `Camera camera(glm::vec3(0.0f, 0.0f, 3.0f))` with Zoom=45 deg).
const CAMERA_POS_Z = 3;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100;
const CAMERA_PROJECTION_PERSPECTIVE = 0;


// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 2.lighting 3.materials] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const winExt = window as unknown as { __materialsInputBackend?: () => InputBackend };
  const overrideBackend = winExt.__materialsInputBackend?.();

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
    console.error('[learn-render 2.lighting 3.materials] app.onError:', e.code, e.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: e.code, hint: e.hint });
  });

  const assets = renderer.assets;
  assets.configurePackIndex('/pack-index.json');

  // HANDLE_CUBE is the builtin procedural cube; MeshFilter uses it directly.

  // feat-20260527 M1 / w4: pass-based MaterialAsset minted via allocSharedRef
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

  const lampMatHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [{ name: 'Forward', shader: 'forgeax::default-unlit', tags: { LightMode: 'Forward' }, queue: 2000 }],
    paramValues: { baseColor: [1.0, 1.0, 1.0, 1.0] },
  });

  // Spawn the object cube at origin (LO: model = identity).
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

  // Spawn the lamp cube + co-located PointLight. The lamp's Transform
  // provides both the visible marker position and the light source
  // position via the `[Transform, PointLight]` extract query. color is
  // animated each frame; intensity stays at 1.0 (no Phong-era *0.5
  // scaling). range = +Infinity disables KHR quartic truncation but
  // 1/d^2 attenuation still applies.
  const lightEntity = world
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
          colorR: 1.0,
          colorG: 1.0,
          colorB: 1.0,
          intensity: 100.0,
          range: 50,
        },
      },
    )
    .unwrap();

  // ECS system: animate light color (LO sin waves per channel, negatives
  // clamped to 0 to mirror LO's framebuffer clamp behavior).
  let elapsed = 0;
  world.addSystem({
    name: 'animated-light-color',
    queries: [],
    fn: () => {
      elapsed += LIGHT_ANIM_DT;
      const colorR = Math.max(0, Math.sin(elapsed * LIGHT_ANIM_FREQ_R));
      const colorG = Math.max(0, Math.sin(elapsed * LIGHT_ANIM_FREQ_G));
      const colorB = Math.max(0, Math.sin(elapsed * LIGHT_ANIM_FREQ_B));
      world.set(lightEntity, PointLight, { colorR, colorG, colorB });
    },
  });

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
    name: 'learn-render-materials-first-person',
    overrideBackend,
  });
  addScrollFovSystem(world, renderer);

  installCaptureHook(target, app, world);

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 2.lighting 3.materials] app.start failed:', startRes.error);
    return;
  }
  console.warn(`[learn-render 2.lighting 3.materials] backend=${renderer.backend}`);
}

function installCaptureHook(
  _target: HTMLCanvasElement,
  app: App,
  world: World,
): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureMaterials?: CaptureHook };
  const renderer = app.renderer;
  win.__captureMaterials = async (): Promise<Uint8Array> => {
    world.update();
    renderer.draw([world], { owner: 0 });
    const r = await renderer.readPixels();
    if (!r.ok) {
      throw new Error(
        `[learn-render 2.lighting 3.materials] readPixels failed: ${r.error.code} -- ${r.error.hint ?? ''}`,
      );
    }
    return r.value;
  };
}

function addScrollFovSystem(world: App['world'], renderer: App['renderer']): void {
  const scrollFov = createScrollFovAccumulator();
  world.addSystem({
    name: 'learn-render-materials-scroll-fov',
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
    console.error(`[learn-render 2.lighting 3.materials] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[learn-render 2.lighting 3.materials] ${err.code}: ${err.hint}`);
}

declare global {
  interface Window {
    __captureMaterials?: () => Promise<Uint8Array>;
    __materialsInputBackend?: () => InputBackend;
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}
