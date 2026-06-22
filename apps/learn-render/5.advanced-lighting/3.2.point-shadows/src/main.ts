// apps/learn-render/5.advanced-lighting/3.2.point-shadows/src/main.ts
// LearnOpenGL section 5.3.2 — point-light cube-map shadows.
// Room scene: large cube (scale=5) viewed from inside with cullMode='none',
// solid-color inner objects, orbiting point light with PointLightShadow.
//
// GREP anchors for AI users:
//   - "// 1. engine usage"    public engine API consumed
//   - "// 2. scene constants" D4 scene-specific constants
//   - "// 3. bootstrap"       entry point wiring (1)+(2)

// 1. engine usage
import { createApp } from '@forgeax/engine-app';
import {
  Camera,
  DirectionalLight,
  HANDLE_CUBE,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  PointLight,
  PointLightShadow,
  Transform,
} from '@forgeax/engine-runtime';
import type { MaterialAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { addFirstPersonSystem } from '../../../../shared/src/learn-render-first-person';

// 2. scene constants

// Room: HANDLE_CUBE scaled to 5 units viewed from inside.
const ROOM_SCALE = 5;
const ROOM_Y = 0;

// Camera: first-person starting at origin looking -Z.
const CAMERA_FOV = Math.PI / 4;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 50.0;

// Inner objects: solid-color cubes at varying positions inside the room.
const INNER_OBJECTS = [
  { posX: -2, posY: 0, posZ: -1, scale: 1, color: [1, 0.3, 0.3] as const },
  { posX: 1, posY: -1, posZ: -2, scale: 0.7, color: [0.3, 1, 0.3] as const },
  { posX: 0, posY: 1.5, posZ: -3, scale: 0.5, color: [0.3, 0.3, 1] as const },
  { posX: -1, posY: -0.5, posZ: 2, scale: 1.2, color: [1, 1, 0.3] as const },
  { posX: 2, posY: -1.5, posZ: 1, scale: 0.8, color: [1, 0.3, 1] as const },
];

// Point light: orbits in a circle (x=sin(t)*3, z=cos(t)*3) at fixed y=4.
const LIGHT_ORBIT_Y = 4;
const LIGHT_ORBIT_RADIUS = 3;
const LIGHT_RANGE = 25;
const LIGHT_INTENSITY = 8;

// Ambient directional fill so the room interior is not pitch black.
const FILL_DIRECTION = { directionX: 0, directionY: -1, directionZ: 0.1 };
const FILL_INTENSITY = 0.15;

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 5.3.2 point-shadows] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter() },
  );
  if (!appRes.ok) {
    console.error('[learn-render 5.3.2 point-shadows] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  const renderer = app.renderer;
  const world = app.world;

  app.onError((error) => {
    console.error('[learn-render 5.3.2 point-shadows] app.onError:', error.code, error.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });

  // Room inner-wall material: MaterialAsset POJO with cullMode='none' so
  // back-faces and inner walls are visible from inside the cube.
  const roomMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::default-standard-pbr',
        fragmentEntry: 'fs_main',
        tags: { LightMode: 'Forward' },
        passKind: 'forward',
        renderState: { cullMode: 'none' },
      },
      {
        name: 'ShadowCaster',
        shader: 'forgeax::default-shadow-caster',
        tags: { LightMode: 'ShadowCaster' },
        passKind: 'shadow-caster',
      },
    ],
    paramValues: {
      baseColor: [0.4, 0.4, 0.5, 1],
      metallic: 0,
      roughness: 0.5,
      occlusionStrength: 1,
    },
  });

  // Room geometry: HANDLE_CUBE scaled up to form a 2*ROOM_SCALE box.
  world.spawn(
    {
      component: Transform,
      data: {
        posY: ROOM_Y,
        scaleX: ROOM_SCALE,
        scaleY: ROOM_SCALE,
        scaleZ: ROOM_SCALE,
        quatW: 1,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [roomMat] } },
  ).unwrap();

  // Inner solid-color objects.
  for (const obj of INNER_OBJECTS) {
    const [r, g, b] = obj.color;
    const mat = Materials.standard({ baseColor: [r, g, b, 1] });
    const matHandle = world.allocSharedRef('MaterialAsset', mat);
    world.spawn(
      {
        component: Transform,
        data: {
          posX: obj.posX, posY: obj.posY, posZ: obj.posZ,
          quatW: 1,
          scaleX: obj.scale, scaleY: obj.scale, scaleZ: obj.scale,
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [matHandle] } },
    ).unwrap();
  }

  // Ambient directional fill light (no shadow — just illuminates interior).
  world.spawn(
    {
      component: DirectionalLight,
      data: {
        directionX: FILL_DIRECTION.directionX,
        directionY: FILL_DIRECTION.directionY,
        directionZ: FILL_DIRECTION.directionZ,
        colorR: 1, colorG: 1, colorB: 1,
        intensity: FILL_INTENSITY,
      },
    },
  ).unwrap();

  // Orbiting point light with shadow.
  const lightEntity = world.spawn(
    {
      component: Transform,
      data: { posX: 0, posY: LIGHT_ORBIT_Y, posZ: 0 },
    },
    {
      component: PointLight,
      data: { range: LIGHT_RANGE, intensity: LIGHT_INTENSITY },
    },
    {
      component: PointLightShadow,
      data: {}, // all 6 fields at defaults (mapSize=512, depthBias=0.005, etc.)
    },
  ).unwrap();

  // Camera: first-person starting at origin.
  const cameraEntity = world.spawn(
    { component: Transform, data: { posY: 1.5, quatW: 1 } },
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
    name: 'learn-render-5.3.2-point-shadows-first-person',
    overrideBackend: undefined,
  });

  // Per-frame orbit: light circles (x=sin(t)*3, z=cos(t)*3) at fixed y.
  let elapsed = 0;
  world.addSystem({
    name: 'point-light-orbit',
    queries: [],
    fn: () => {
      elapsed += 1 / 60;
      const t = elapsed;
      world.set(lightEntity, Transform, {
        posX: Math.sin(t) * LIGHT_ORBIT_RADIUS,
        posZ: Math.cos(t) * LIGHT_ORBIT_RADIUS,
      });
    },
  });

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 5.3.2 point-shadows] app.start failed:', startRes.error);
    return;
  }

  window.addEventListener('resize', () => {
    const dpr = devicePixelRatio;
    target.width = window.innerWidth * dpr;
    target.height = window.innerHeight * dpr;
    world.set(cameraEntity, Camera, { aspect: window.innerWidth / window.innerHeight });
  });

  console.warn(`[learn-render 5.3.2 point-shadows] backend=${renderer.backend}`);
}

declare global {
  interface Window {
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}