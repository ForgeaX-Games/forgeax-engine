// apps/learn-render/5.advanced-lighting/7.bloom/src/index.ts
// LearnOpenGL section 5.7 - Bloom.
//
// Faithful port of the LearnOpenGL 5.7 Bloom scene
// (src/5.advanced_lighting/7.bloom/bloom.cpp): a large wood floor, six
// container2 wooden boxes scattered with assorted positions/rotations/
// scales, four bright "light box" cubes, and four HDR point lights whose
// colours run well past 1.0 (up to 15.0). The bright light-box cubes are
// the bloom source: each is an unlit cube painted with its light colour
// (mirroring the tutorial's 7.light_box.fs, which writes lightColor
// straight to FragColor), so their pixels blow past the bloom bright-pass
// threshold of 1.0 and glow.
//
// Bloom is opt-in via Camera fields (bloom, bloomThreshold, bloomIntensity,
// bloomBlurRadius) + Reinhard-extended tonemap. The engine declares the
// URP default bloom chain (bright-filter -> blur-h -> blur-v -> composite);
// no custom pipeline code lives here. Contrast with 6.hdr's custom
// RenderPipeline paradigm and apps/hello/bloom (which proves the bloom
// infrastructure and toggles it at runtime via Space).
//
// GREP anchors for AI users:
//   - "// 1. engine usage"    public engine API consumed
//   - "// 2. example-specific glue"  LO 5.7 scene-specific constants + materials
//   - "// 3. bootstrap"       entry point wiring (1)+(2) + HUD

// 1. engine usage
import { type App, createApp } from '@forgeax/engine-app';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { quat } from '@forgeax/engine-math';
import {
  BLOOM_DISABLED,
  BLOOM_ENABLED,
  Camera,
  HANDLE_CUBE,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  PointLight,
  TONEMAP_REINHARD_EXTENDED,
  Transform,
} from '@forgeax/engine-runtime';
import type { MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createDevImportTransport } from '@forgeax/engine-runtime';
import { addFirstPersonSystem } from '../../../../shared/src/learn-render-first-person';

// 2. example-specific glue

const PACK_INDEX_URL = '/pack-index.json';

// Texture GUIDs from forgeax-engine-assets/learn-opengl/textures/
//   wood.png       GUID 019e3969-1d48-7c3b-ac24-6d68f457065f
//   container2.png GUID 019e3969-1d46-7945-a75a-ef97d537531e
const WOOD_GUID_STR = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const CONTAINER2_GUID_STR = '019e3969-1d46-7945-a75a-ef97d537531e';

// Bloom configuration. threshold=1.0 only filters HDR-bright pixels (the
// light boxes); intensity/blurRadius match hello/bloom's PASS config.
const BLOOM_THRESHOLD = 1.0;
const BLOOM_INTENSITY = 1.0;
const BLOOM_BLUR_RADIUS = 4.0;

// Reinhard-extended exposure analogue. The bloom_final tonemap in the
// tutorial uses exposure=1.0.
const TONEMAP_EXPOSURE = 1.0;

// HDR light colours (bloom.cpp lightColors). Channels exceed 1.0 so the
// light boxes blow past the bloom bright-pass threshold and glow.
const LIGHT_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [5.0, 5.0, 5.0],
  [10.0, 0.0, 0.0],
  [0.0, 0.0, 15.0],
  [0.0, 5.0, 0.0],
];

// Light positions (bloom.cpp lightPositions). Shared by the point lights
// and the bright light-box cubes that visualise them.
const LIGHT_POSITIONS: ReadonlyArray<readonly [number, number, number]> = [
  [0.0, 0.5, 1.5],
  [-4.0, 0.5, -3.0],
  [3.0, 0.5, 1.0],
  [-0.8, 2.4, -1.0],
];

// Each light box is a unit cube scaled to 0.25 (bloom.cpp light cube scale).
const LIGHT_BOX_SCALE = 0.25;

// PointLight intensity/range. The tutorial bakes brightness into the light
// colour itself; here colour stays in [0,1]-ish proportions per channel via
// LIGHT_COLORS (which already carry the HDR magnitude), driven at unit
// intensity. Range covers the ~12-unit floor.
const POINT_LIGHT_INTENSITY = 1.0;
const POINT_LIGHT_RANGE = 30.0;

// Wood floor: a large flat box centred below the scene (bloom.cpp:
// translate (0,-1,0), scale (12.5, 0.5, 12.5)). The builtin cube spans
// [-0.5,0.5], so scale maps directly to full extents.
const FLOOR_POS_Y = -1.0;
const FLOOR_SCALE_X = 12.5;
const FLOOR_SCALE_Y = 0.5;
const FLOOR_SCALE_Z = 12.5;

// Six wooden container boxes (bloom.cpp scenery cubes). Each entry is
// [posX, posY, posZ, uniformScale, rotAxisXYZ, rotDeg]; rotDeg=0 means no
// rotation. Axes are normalised by quat.fromAxisAngle.
type BoxSpec = {
  pos: readonly [number, number, number];
  scale: number;
  axis: readonly [number, number, number];
  deg: number;
};
const CONTAINER_BOXES: readonly BoxSpec[] = [
  { pos: [0.0, 1.5, 0.0], scale: 0.5, axis: [1, 0, 0], deg: 0 },
  { pos: [2.0, 0.0, 1.0], scale: 0.5, axis: [1, 0, 0], deg: 0 },
  { pos: [-1.0, -1.0, 2.0], scale: 1.0, axis: [1, 0, 1], deg: 60 },
  { pos: [0.0, 2.7, 4.0], scale: 1.25, axis: [1, 0, 1], deg: 23 },
  { pos: [-2.0, 1.0, -3.0], scale: 1.0, axis: [1, 0, 1], deg: 124 },
  { pos: [-3.0, 0.0, 0.0], scale: 0.5, axis: [1, 0, 0], deg: 0 },
];

// Camera at (0, 0, 5) looking down -Z (bloom.cpp Camera(0,0,5)).
const CAMERA_POS_X = 0.0;
const CAMERA_POS_Y = 0.0;
const CAMERA_POS_Z = 5.0;
const CAMERA_FOV = Math.PI / 4;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100.0;

const DEG2RAD = Math.PI / 180;

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 5.7 bloom] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() },
  );
  if (!appRes.ok) {
    console.error('[learn-render 5.7 bloom] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  const renderer = app.renderer;
  const world = app.world;
  app.onError((error) => {
    console.error('[learn-render 5.7 bloom] app.onError:', error.code, error.hint);
    const bus = (
      globalThis as unknown as {
        __learnRenderErrors?: Array<{ code: string; hint?: string }>;
    __captureBloom?: () => Promise<Uint8Array>;
      }
    ).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });

  const assets = renderer.assets;
  assets.configurePackIndex(PACK_INDEX_URL);

  // Load textures by GUID.
  const woodGuidRes = AssetGuid.parse(WOOD_GUID_STR);
  const container2GuidRes = AssetGuid.parse(CONTAINER2_GUID_STR);
  if (!woodGuidRes.ok || !container2GuidRes.ok) {
    console.error('[learn-render 5.7 bloom] GUID parse failed');
    return;
  }

  const [woodTexRes, container2TexRes] = await Promise.all([
    assets.loadByGuid<TextureAsset>(woodGuidRes.value),
    assets.loadByGuid<TextureAsset>(container2GuidRes.value),
  ]);
  if (!woodTexRes.ok || !container2TexRes.ok) {
    console.error('[learn-render 5.7 bloom] loadByGuid failed');
    return;
  }
  const woodTex = woodTexRes.value;
  const container2Tex = container2TexRes.value;

  // Wood floor + container boxes: standard PBR lit by the point lights.
  const floorMatHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({
      baseColor: [1.0, 1.0, 1.0, 1.0],
      roughness: 0.9,
      baseColorTexture: unwrapHandle(world.allocSharedRef('TextureAsset', woodTex)),
    }),
  );
  const containerMatHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({
      baseColor: [1.0, 1.0, 1.0, 1.0],
      roughness: 0.8,
      baseColorTexture: unwrapHandle(world.allocSharedRef('TextureAsset', container2Tex)),
    }),
  );

  // Spawn wood floor.
  world
    .spawn(
      {
        component: Transform,
        data: {
          posX: 0,
          posY: FLOOR_POS_Y,
          posZ: 0,
          scaleX: FLOOR_SCALE_X,
          scaleY: FLOOR_SCALE_Y,
          scaleZ: FLOOR_SCALE_Z,
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [floorMatHandle] } },
    )
    .unwrap();

  // Spawn the six wooden container boxes.
  const rot = quat.create();
  for (const box of CONTAINER_BOXES) {
    quat.fromAxisAngle(rot, box.axis, box.deg * DEG2RAD);
    world
      .spawn(
        {
          component: Transform,
          data: {
            posX: box.pos[0],
            posY: box.pos[1],
            posZ: box.pos[2],
            quatX: rot[0] ?? 0,
            quatY: rot[1] ?? 0,
            quatZ: rot[2] ?? 0,
            quatW: rot[3] ?? 1,
            scaleX: box.scale,
            scaleY: box.scale,
            scaleZ: box.scale,
          },
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [containerMatHandle] } },
      )
      .unwrap();
  }

  // Spawn the four HDR point lights + their bright light-box cubes.
  // The light box is an unlit cube painted with the light colour (HDR,
  // channels up to 15.0) -- this is the bloom source, mirroring the
  // tutorial's 7.light_box.fs (FragColor = lightColor).
  LIGHT_POSITIONS.forEach((pos, i) => {
    const color = LIGHT_COLORS[i] ?? [1, 1, 1];

    // Point light illuminating the floor + containers.
    world
      .spawn(
        {
          component: Transform,
          data: { posX: pos[0], posY: pos[1], posZ: pos[2] },
        },
        {
          component: PointLight,
          data: {
            colorR: color[0],
            colorG: color[1],
            colorB: color[2],
            intensity: POINT_LIGHT_INTENSITY,
            range: POINT_LIGHT_RANGE,
          },
        },
      )
      .unwrap();

    // Bright light-box cube (unlit, HDR light colour -> bloom source).
    const lightBoxMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
      'MaterialAsset',
      Materials.unlit([color[0], color[1], color[2], 1.0], { castShadow: false }),
    );
    world
      .spawn(
        {
          component: Transform,
          data: {
            posX: pos[0],
            posY: pos[1],
            posZ: pos[2],
            scaleX: LIGHT_BOX_SCALE,
            scaleY: LIGHT_BOX_SCALE,
            scaleZ: LIGHT_BOX_SCALE,
          },
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [lightBoxMat] } },
      )
      .unwrap();
  });

  // Camera with bloom + tonemap enabled.
  // Camera.bloom=BLOOM_ENABLED opt-in drives the URP default bloom chain
  // (bright-filter -> blur-h -> blur-v -> composite). No custom pipeline
  // code needed -- this is the "Camera fields as API" paradigm, contrasted
  // with 6.hdr's custom RenderPipeline paradigm.
  const cameraEntity = world
    .spawn(
      {
        component: Transform,
        data: { posX: CAMERA_POS_X, posY: CAMERA_POS_Y, posZ: CAMERA_POS_Z },
      },
      {
        component: Camera,
        data: {
          ...perspective({
            fov: CAMERA_FOV,
            aspect: target.width / target.height,
            near: CAMERA_NEAR,
            far: CAMERA_FAR,
          }),
          tonemap: TONEMAP_REINHARD_EXTENDED,
          exposure: TONEMAP_EXPOSURE,
          bloom: BLOOM_ENABLED,
          bloomThreshold: BLOOM_THRESHOLD,
          bloomIntensity: BLOOM_INTENSITY,
          bloomBlurRadius: BLOOM_BLUR_RADIUS,
        },
      },
    )
    .unwrap();

  // First-person controls so the AI user can explore the bloom scene.
  addFirstPersonSystem(app.world, app.renderer, {
    name: 'learn-render-5.7-bloom-first-person',
    overrideBackend: undefined,
  });

  // Space-key toggle for the bloom A/B comparison -- the core interaction of
  // LearnOpenGL 5.7 (the tutorial flips `bloom` to show the same scene with
  // and without glow). Mirrors apps/hello/bloom: read the spacebar from the
  // input snapshot, derive a press-edge from prev-frame level, flip
  // Camera.bloom between BLOOM_ENABLED and BLOOM_DISABLED via world.set.
  // The engine re-reads bloom every frame at extract; no other change needed.
  // InputSnapshot.keyboard matches KeyboardEvent.key, so the spacebar is the
  // literal ' ' (NOT 'Space', which is ev.code).
  let prevSpace = false;
  let currentBloom: number = BLOOM_ENABLED;
  world.addSystem({
    name: 'learn-render-5.7-bloom-space-toggle',
    after: ['input-frame-start-scan'],
    queries: [],
    fn: () => {
      const snap = app.renderer.input.snapshot(world);
      if (snap === undefined) return;
      const cur = snap.keyboard.down(' ');
      if (cur && !prevSpace) {
        const target = currentBloom === BLOOM_ENABLED ? BLOOM_DISABLED : BLOOM_ENABLED;
        const setRes = world.set(cameraEntity, Camera, { bloom: target });
        if (setRes.ok) {
          currentBloom = target;
          updateHud(currentBloom);
        } else {
          console.error('[learn-render 5.7 bloom] toggle world.set failed:', setRes.error.code);
        }
      }
      prevSpace = cur;
    },
  });

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 5.7 bloom] app.start failed:', startRes.error);
    return;
  }

  // HUD: display bloom status + scene reference.
  window.addEventListener('resize', () => {
    const dpr = devicePixelRatio;
    target.width = window.innerWidth * dpr;
    target.height = window.innerHeight * dpr;
    world.set(cameraEntity, Camera, { aspect: window.innerWidth / window.innerHeight });
  });

  updateHud(currentBloom);

  console.warn(`[learn-render 5.7 bloom] backend=${renderer.backend}. Press Space to toggle bloom.`);

  installCaptureHook(app, world);
}

// RHI-debug live-pixel hook for the capture smoke harness (pixel mode). Drives
// one update + draw + readPixels so the live canvas read is anchored to the same
// frame the capture records. Only meaningful when the page is served with
// FORGEAX_ENGINE_RHI_DEBUG=1; harmless otherwise.
function installCaptureHook(app: App, world: App['world']): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureBloom?: CaptureHook };
  const renderer = app.renderer;
  win.__captureBloom = async (): Promise<Uint8Array> => {
    world.update();
    renderer.draw([world], { owner: 0 });
    const r = await renderer.readPixels();
    if (!r.ok) {
      throw new Error(
        `[learn-render 5.7 bloom] readPixels failed: ${r.error.code} -- ${r.error.hint ?? ''}`,
      );
    }
    return r.value;
  };
}

// HUD reflecting the current bloom state + the Space-toggle hint, so the A/B
// comparison (LO 5.7's whole point) is discoverable from the on-screen text.
function updateHud(bloom: number): void {
  const hudElement = document.getElementById('hud');
  if (hudElement === null) return;
  const state = bloom === BLOOM_ENABLED ? 'ON' : 'OFF';
  hudElement.innerText = `bloom: ${state} (threshold=1.0) -- press [Space] to toggle | 4 HDR light boxes (colors up to 15.0) glow over 6 wooden crates`;
}

declare global {
  interface Window {
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}
