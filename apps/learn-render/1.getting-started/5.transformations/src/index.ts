// apps/learn-render/1.getting-started/5.transformations/src/index.ts
// LearnOpenGL section 1.5 - Transformations (forgeax mapping with the
// shared cube + wood-container texture from §1.4 + a system-fn that
// each frame writes Transform SoA columns reproducing
//   trans = glm::translate(trans, glm::vec3(0.5, -0.5, 0));
//   trans = glm::rotate(trans, time, glm::vec3(0, 0, 1));
//   trans = glm::scale(trans, glm::vec3(pulse));
// where pulse animates 0.5 + 0.5 * sin(t * 2 pi / 3) per plan-decisions
// D-8 / OOS-8 (the LO static glm::vec3(0.5) is replaced by a visible
// sin pulse so the system fn output is observable each tick).
//
// AC-06 three-section marker convention:
//   `// 1. engine usage`            -> public engine API consumed.
//   `// 2. example-specific glue`   -> the LO §1.5 cube + wood texture
//                                       + sin-pulse animation system
//                                       descriptor + GUID literals.
//   `// 3. bootstrap`               -> entry point that wires (1)+(2).
//
// charter mapping:
//   - F1 (limited context):  three-section markers double as grep
//     anchors (AC-06); `world.addSystem` / `bundles.Transform.quatZ` is
//     the LO §1.5 -> forgeax animation idiom anchor.
//   - F2 (text > image):     the LO §1.5 GLM chapter is documented as
//     text in this file's comment block + the README LO folded
//     `<details>` block; the pixel-parity baseline (round-1-trans
//     formations.png) is verification only.
//   - P1 (progressive disclosure):  the README top callout points at
//     this file; AI users read the 3 sections + the system descriptor
//     + the GUID literals and have the full LO §1.5 -> forgeax picture
//     in one directory.
//   - P3 (explicit failure):  `EngineEnvironmentError` surfaces the
//     "no usable backend" path; loadByGuid Err arms switch on
//     err.code and log structured detail.
//   - P4 (consistent abstraction):  the same `createApp(canvas, opts)`
//     factory + ECS spawn + `MeshRenderer` discriminator + 10 f32
//     Transform column SoA (`bundles.Transform.quatZ` -> engine internal
//     mat4 compose) is the entry across every learn-render example;
//     LO §1.5 just adds the per-frame system fn atop the LO §1.4
//     textured cube baseline.
//   - P5 (producer / consumer split):  `computeTransformAt(t)` is the
//     pure helper consumed both by the system fn and by the unit test
//     (transform-state.test.ts); the producer side stays POD-only.
//
// AC-15 (c) regression: the example must NOT import the build-time
// decode helper from @forgeax/engine-image and must NOT call any
// AssetRegistry low-level upload entry directly -- the call stack is
// loadByGuid-only (3 entries: loadByGuid<TextureAsset> +
// loadByGuid<MeshAsset> + loadByGuid<MaterialAsset>).

// 1. engine usage - the public createApp + ECS World facade + Asset
// Registry namespace + AssetGuid parser + MaterialAsset / TextureAsset /
// MeshAsset POD types + 4 component schemas (Transform / Camera /
// MeshFilter / MeshRenderer). The `Time` resource (key 'Time') is
// populated by the engine-app frame-loop each tick (plan-decisions D-1);
// the system fn reads `world.getResource<{dt:number}>('Time')?.dt`
// for the elapsed delta -- no fn-signature extension to ECS surface.
import { createApp } from '@forgeax/engine-app';
import { Entity, type World } from '@forgeax/engine-ecs';
import type { AppError } from '@forgeax/engine-app';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { RhiError } from '@forgeax/engine-rhi/errors';
import {
  Camera,
  createDevImportTransport,
  EngineEnvironmentError,
  HANDLE_CUBE,
  MeshFilter,
  MeshRenderer,
  resolveAssetHandle,
  Transform,
} from '@forgeax/engine-runtime';
import type { MaterialAsset, MeshAsset, TextureAsset } from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import materialPackJson from '../assets/material-wood.pack.json';
import { computeTransformAt } from './transform-animation';

// 1. engine usage marker (inline anchor for AC-06 grep gate; the
// expanded prose block sits above the import group).

// 2. example-specific glue - LO §1.5 cube + container texture + per-
// frame system fn. Three GUID literals form the disk-schema -> runtime
// bridge (AI users grep them via `rg "WOOD_TEXTURE_GUID" apps/`):
//
//   WOOD_TEXTURE_GUID  -> forgeax-engine-assets/learn-opengl/textures/
//                          container.jpg.meta.json subAssets[0].guid
//                          (sRGB JPG decoded by @forgeax/engine-image
//                          at build time / runtime fetch).
//   CUBE_MESH_GUID     -> forgeax-engine-assets/learn-opengl/meshes/
//                          cube-mesh.stub.meta.json subAssets[0].guid
//                          (engine-builtin procedural cube; the GUID is
//                          the disk identifier, the runtime aliases
//                          the same logical mesh as HANDLE_CUBE).
//   CUBE_MATERIAL_GUID -> assets/material-wood.pack.json assets[0].guid
//                          (UnlitMaterialAsset whose baseColorTexture
//                          slot references WOOD_TEXTURE_GUID -- the LO
//                          §1.4 sampler2D bind point in WGSL terms).
const WOOD_TEXTURE_GUID = '019e3969-1d46-773e-988c-a10e305ff2a4';
const CUBE_MESH_GUID = '019e3968-6007-71ae-856e-1fd6c9728cfb';
const CUBE_MATERIAL_GUID = '019e4906-23d4-72f8-bca5-7f18f5465e9a';
// Stable across dev (configureServer middleware) + prod (generateBundle
// emit) per @forgeax/engine-vite-plugin-pack (charter P4 consistent
// abstraction).
const PACK_INDEX_URL = '/pack-index.json';

interface MaterialPackEntry {
  readonly guid: string;
  readonly kind: string;
  readonly payload: {
    readonly kind: string;
    readonly passes: ReadonlyArray<{ readonly name: string; readonly shader: string }>;
    readonly paramValues: {
      readonly baseColor: readonly [number, number, number, number];
      readonly baseColorTexture?: string;
    };
  };
}

interface MaterialPackFile {
  readonly assets: ReadonlyArray<MaterialPackEntry>;
}

// 3. bootstrap - locate the canvas, hand it to createApp (engine-app
// shell wires the rAF frame-loop + Time resource + auto input attach),
// wire the AssetRegistry through the loadByGuid recipe, spawn the
// textured cube + camera, register the per-frame Transform animation
// system, and start the app. createApp owns the rAF pump (charter P4
// consistent abstraction; OOS-9 / OOS-11 -- the demo never touches
// raw mat4 math or the browser raw rAF API).
const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 1.5 transformations] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    // four-verb redesign 2026-06-06: dev lazy-import transport for
    // raw-source texture rows (container.jpg). Absent => `loadByGuid`
    // returns `asset-not-imported` and the demo aborts.
    { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() },
  );
  if (!appRes.ok) {
    reportBootstrapError(appRes.error);
    return;
  }
  const app = appRes.value;
  const renderer = app.renderer;
  const world = app.world;

  app.onError((e) => {
    console.error('[learn-render 1.5 transformations] app.onError:', e.code, e.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: e.code, hint: e.hint });
  });

  const assets = renderer.assets;
  assets.configurePackIndex(PACK_INDEX_URL);

  // Parse the 3 GUID literals once (charter F1 single-grep entry).
  const woodGuidRes = AssetGuid.parse(WOOD_TEXTURE_GUID);
  const cubeGuidRes = AssetGuid.parse(CUBE_MESH_GUID);
  const matGuidRes = AssetGuid.parse(CUBE_MATERIAL_GUID);
  if (!woodGuidRes.ok || !cubeGuidRes.ok || !matGuidRes.ok) {
    console.error(
      '[learn-render 1.5 transformations] GUID parse failed for one of the 3 fixtures',
    );
    return;
  }

  // The texture handle resolves through the production fetch chain
  // (configurePackIndex -> /pack-index.json -> container.jpg ->
  // parseImage -> uploadTexture); the cube handle resolves through the
  // Map fast-path seeded by registerWithGuid below (alias to engine-
  // builtin HANDLE_CUBE); the material handle resolves through the
  // same Map fast-path after we register the reconstructed POD.
  const woodHandleRes = await assets.loadByGuid<TextureAsset>(woodGuidRes.value);
  if (!woodHandleRes.ok) {
    console.error(
      '[learn-render 1.5 transformations] wood texture loadByGuid failed:',
      woodHandleRes.error.code,
    );
    return;
  }

  const cubeAssetRes = resolveAssetHandle<MeshAsset>(world, HANDLE_CUBE);
  if (!cubeAssetRes.ok) {
    console.error('[learn-render 1.5 transformations] HANDLE_CUBE asset unavailable');
    return;
  }
  assets.catalog<MeshAsset>(cubeGuidRes.value, cubeAssetRes.value);

  const matPack = materialPackJson as unknown as MaterialPackFile;
  const matEntry = matPack.assets.find((a) => a.kind === 'material');
  if (matEntry === undefined) {
    console.error(
      '[learn-render 1.5 transformations] material-wood.pack.json missing material entry',
    );
    return;
  }
  // loadByGuid returns the texture PAYLOAD (M8 D-17); mint a user-tier column
  // handle so the baseColorTexture slot carries a resolved numeric Handle.
  const woodTexHandle = unwrapHandle(world.allocSharedRef('TextureAsset', woodHandleRes.value));
  const cubeMaterial: MaterialAsset = {
    kind: 'material',
    passes: [{ name: 'Forward', shader: 'forgeax::default-unlit', tags: { LightMode: 'Forward' }, queue: 2000 }],
    paramValues: {
      baseColor: matEntry.payload.paramValues.baseColor,
      baseColorTexture: woodTexHandle,
    },
  };
  assets.catalog<MaterialAsset>(matGuidRes.value, cubeMaterial);

  const cubeHandleRes = await assets.loadByGuid<MeshAsset>(cubeGuidRes.value);
  const matHandleRes = await assets.loadByGuid<MaterialAsset>(matGuidRes.value);
  if (!cubeHandleRes.ok || !matHandleRes.ok) {
    console.error(
      '[learn-render 1.5 transformations] loadByGuid failed:',
      cubeHandleRes.ok ? null : cubeHandleRes.error.code,
      matHandleRes.ok ? null : matHandleRes.error.code,
    );
    return;
  }
  // loadByGuid returns payloads (M8 D-17); mint user-tier column handles.
  const cubeHandle = world.allocSharedRef('MeshAsset', cubeHandleRes.value);
  const matHandle = world.allocSharedRef('MaterialAsset', matHandleRes.value);

  // Spawn the cube + camera onto the world. spawn-time defaults are
  // identity (the LO §1.5 glm::mat4(1.0f) baseline); the per-frame
  // system fn writes the LO transform constants each tick. Camera sits
  // at z=3 looking at origin (LO §1.5 chapter does not advance the
  // camera; the cube's translate(0.5, -0.5, 0) places it lower-right
  // of frame).
  const cubeSpawn = world
    .spawn(
      {
        component: Transform,
        data: {
          posX: 0,
          posY: 0,
          posZ: 0,
          quatX: 0,
          quatY: 0,
          quatZ: 0,
          quatW: 1,
          scaleX: 1,
          scaleY: 1,
          scaleZ: 1,
        },
      },
      { component: MeshFilter, data: { assetHandle: cubeHandle } },
      {
        component: MeshRenderer,
        data: { materials: [matHandle] },
      },
    )
    .unwrap();
  world.spawn(
    {
      component: Transform,
      data: {
        posX: 0,
        posY: 0,
        posZ: 3,
        quatX: 0,
        quatY: 0,
        quatZ: 0,
        quatW: 1,
        scaleX: 1,
        scaleY: 1,
        scaleZ: 1,
      },
    },
    {
      component: Camera,
      data: { fov: Math.PI / 4, aspect: target.width / target.height, near: 0.1, far: 100 },
    },
  );

  // Per-frame Transform animation system. The fn body reads dt from
  // the 'Time' resource (engine-app frame-loop SSOT, plan-decisions
  // D-1) and accumulates elapsed seconds into a closure-scoped counter
  // so subsequent ticks advance the LO §1.5 time variable. The system
  // writes the Transform SoA columns directly (no mat4 math; charter
  // P4 + OOS-11). `computeTransformAt(t)` is the pure helper shared
  // with the unit test (charter P5 producer / consumer split).
  let elapsedSec = 0;
  let lastTickQuatZ = 0;
  let lastTickScaleX = 1;
  let lastTickScaleY = 1;
  let tickCount = 0;
  world.addSystem({
    name: 'transformations-animate-cube',
    queries: [{ with: [Transform, MeshFilter, Entity] }],
    fn: (world, queryResults) => {
      const time = world.getResource<{ readonly dt: number }>('Time');
      const dt = time?.dt ?? 0;
      elapsedSec += dt;
      const fields = computeTransformAt(elapsedSec);
      for (const bundles of queryResults[0]) {
        const count = bundles.Entity.self.length;
        for (let i = 0; i < count; i++) {
          bundles.Transform.posX[i] = fields.posX;
          bundles.Transform.posY[i] = fields.posY;
          bundles.Transform.posZ[i] = fields.posZ;
          bundles.Transform.quatX[i] = fields.quatX;
          bundles.Transform.quatY[i] = fields.quatY;
          bundles.Transform.quatZ[i] = fields.quatZ;
          bundles.Transform.quatW[i] = fields.quatW;
          bundles.Transform.scaleX[i] = fields.scaleX;
          bundles.Transform.scaleY[i] = fields.scaleY;
          bundles.Transform.scaleZ[i] = fields.scaleZ;
        }
      }
      lastTickQuatZ = fields.quatZ;
      lastTickScaleX = fields.scaleX;
      lastTickScaleY = fields.scaleY;
      tickCount += 1;
    },
  });

  // Capture hooks used by the bench-screenshot recorder + the multi-
  // frame browser test. __captureTransformationsState exposes the
  // latest system-driven Transform values; __captureTransformations
  // re-issues a fresh draw and reads canvas pixels via
  // renderer.readPixels() (engine API since 2026-05-17).
  type CaptureHook = () => Promise<Uint8Array>;
  type StateHook = () => {
    readonly quatZ: number;
    readonly scaleX: number;
    readonly scaleY: number;
    readonly elapsedSec: number;
    readonly tickCount: number;
    readonly cubeEntity: ReturnType<World['spawn']>;
  };
  const win = window as unknown as {
    __captureTransformations?: CaptureHook;
    __captureTransformationsState?: StateHook;
  };
  win.__captureTransformationsState = (): ReturnType<StateHook> => ({
    quatZ: lastTickQuatZ,
    scaleX: lastTickScaleX,
    scaleY: lastTickScaleY,
    elapsedSec,
    tickCount,
    cubeEntity: { ok: true, value: cubeSpawn } as unknown as ReturnType<World['spawn']>,
  });
  win.__captureTransformations = async (): Promise<Uint8Array> => {
    world.update();
    renderer.draw(world);
    const r = await renderer.readPixels();
    if (!r.ok) {
      throw new Error(
        `[learn-render 1.5 transformations] readPixels failed: ${r.error.code} -- ${r.error.hint ?? ''}`,
      );
    }
    return r.value;
  };

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 1.5 transformations] app.start failed:', startRes.error);
    return;
  }
  console.warn(`[learn-render 1.5 transformations] backend=${renderer.backend}`);
}

function reportBootstrapError(err: AppError | RhiError | EngineEnvironmentError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[learn-render 1.5 transformations] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[learn-render 1.5 transformations] ${err.code}: ${err.hint}`);
}
