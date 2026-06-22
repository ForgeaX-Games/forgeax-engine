// apps/hello/sprite-atlas -- 1 atlas / 100 sprite instances / 1 draw
// call with walk animation (feat-20260521-sprite-atlas-animation M6).
//
// What this demo exercises end-to-end (charter F1 progressive disclosure):
//   - SpriteMaterialAsset (M1) -- 4 material handles, one per walk frame
//     region, sharing a single atlas texture.
//   - SpriteRegionOverride (M2) -- per-entity UV region override set by
//     the tick system each frame; no asset-side bake needed.
//   - SpriteAnimation (M2) -- 6-field ECS component holding frameCount /
//     frameDuration / currentFrame / accumDt / regions flat array /
//     playbackMode.
//   - spriteAnimationTickSystem (M4) -- dt accumulator + frame advance
//     with loop/clamp modes; writes SpriteRegionOverride.region each tick.
//   - Instances(M2) -- 100 mat4 transforms packed into one flat
//     Float32Array; RenderSystem emits 1 drawIndexed per frame.
//   - createApp + auto input/time + rAF (feat-20260518).
//
// charter mapping:
//   F1 -- 4-step recipe lives at the top of bootstrap().
//   P3 -- every Result.err consumed via .code + .hint (structured path).
//   P4 -- same MeshFilter(HANDLE_QUAD) + MeshRenderer entry as all 2D/3D
//         material variants; no special SpriteRenderer surface.
//   P5 -- atlas PNG + sidecar pre-generated via atlas CLI and committed;
//         demo build chain has zero atlas-tool dependency.

import type { App, AppError } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app';
import { ok as okResult } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { RhiError } from '@forgeax/engine-rhi/errors';
import {
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  Camera,
  createDevImportTransport,
  EngineEnvironmentError,
  HANDLE_QUAD,
  Instances,
  MeshFilter,
  MeshRenderer,
  SPRITE_PLAYBACK_MODE_LOOP,
  SpriteAnimation,
  SpriteRegionOverride,
  spriteAnimationTickSystem,
  Transform,
} from '@forgeax/engine-runtime';

import type {
  Handle,
  MaterialAsset,
  SamplerAsset,
  TextureAsset,
} from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const ATLAS_GUID = '0e8657b1-c0ab-4940-a4f6-27fcd976823c';
const PACK_INDEX_URL = '/pack-index.json';
const INSTANCE_COUNT = 100;

// Atlas sidecar region fields per frame: [uMin, vMin, uW, vH].
// The demo reads the walk.atlas.json at runtime to decouple the
// commit from per-frame region constants (charter F2: sidecar JSON is a
// first-class text channel; if the atlas is regenerated upstream, the
// demo picks up new regions without source code edits).
// Named .json (not .meta.json) to avoid the pack scanner treating it as a
// pack external-asset-package sidecar (scanner rejects non-pack *.meta.json).
interface AtlasSidecar {
  readonly atlasWidth: number;
  readonly atlasHeight: number;
  readonly regions: ReadonlyArray<{
    readonly name: string;
    readonly uMin: number;
    readonly vMin: number;
    readonly uW: number;
    readonly vH: number;
  }>;
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) {
  throw new Error('[sprite-atlas] missing <canvas id="app"> in index.html');
}

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[sprite-atlas] no usable WebGPU backend:', err);
  } else {
    console.error('[sprite-atlas] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  // Step 1: createApp(canvas, opts) -- one-screen takeoff.
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() },
  );
  if (!appRes.ok) {
    reportAppError(appRes.error);
    return;
  }
  const app: App = appRes.value;
  console.warn(`[sprite-atlas] backend=${app.renderer.backend}`);

  const ready = await app.renderer.ready;
  if (!ready.ok) {
    console.error('[sprite-atlas] renderer.ready failed:', ready.error.code, ready.error.hint);
    return;
  }

  const assets = app.renderer.assets;
  if (assets === null) {
    console.error('[sprite-atlas] AssetRegistry is null (no usable backend)');
    return;
  }
  assets.configurePackIndex(PACK_INDEX_URL);

  const world = app.world;

  // Step 2: add the sprite animation tick system to the schedule.
  // It runs after input/time, before RenderSystem.extract, advancing
  // currentFrame + accumDt and writing SpriteRegionOverride.region
  // each frame (plan-strategy D-7).
  world.addSystem({
    name: 'sprite-animation-tick',
    after: ['input-frame-start-scan'],
    queries: [],
    fn: () => {
      const tickRes = spriteAnimationTickSystem(world);
      if (!tickRes.ok) {
        // charter P3 structured failure: read .code / .expected / .hint
        // from the discriminated union.
        console.warn(
          '[sprite-atlas] spriteAnimationTickSystem rejected:',
          tickRes.error.code,
          tickRes.error.expected,
          tickRes.error.hint,
        );
      }
    },
  });

  // Step 3: load the atlas texture + sidecar. The atlas PNG is imported
  // at build time by pluginPack (walk.atlas.png.meta.json GUID) and
  // served as part of pack-index.json. The sidecar is fetched directly
  // from the dev server (Vite publicDir-like behavior: vite-plugin-pack
  // copies it to dist/).
  const atlasGuidRes = AssetGuid.parse(ATLAS_GUID);
  if (!atlasGuidRes.ok) {
    console.error('[sprite-atlas] ATLAS_GUID parse failed:', atlasGuidRes.error.code);
    return;
  }
  const texHandleRes = await assets.loadByGuid<TextureAsset>(atlasGuidRes.value);
  if (!texHandleRes.ok) {
    console.error(
      '[sprite-atlas] atlas texture loadByGuid failed:',
      texHandleRes.error.code,
      texHandleRes.error.hint,
    );
    return;
  }
  // loadByGuid returns the payload (D-17); mint a user-tier column handle.
  const textureHandle = world.allocSharedRef('TextureAsset', texHandleRes.value);

  // Fetch sidecar JSON to extract per-frame regions (charter F2: text channel).
  let sidecarResp: Response;
  try {
    sidecarResp = await fetch('/assets/walk.atlas.json');
  } catch (err) {
    console.error(
      '[sprite-atlas] sidecar fetch error:',
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  if (!sidecarResp.ok) {
    console.error(
      '[sprite-atlas] sidecar fetch failed:',
      sidecarResp.status,
      sidecarResp.statusText,
    );
    return;
  }
  let sidecar: AtlasSidecar;
  try {
    sidecar = (await sidecarResp.json()) as AtlasSidecar;
  } catch (err) {
    console.error(
      '[sprite-atlas] sidecar JSON parse error:',
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  const frameRegions: ReadonlyArray<[number, number, number, number]> =
    sidecar.regions.map((r) => [r.uMin, r.vMin, r.uW, r.vH] as const);

  // Step 4: mint sampler (shared across all 4 material handles).
  // nearest filtering prevents atlas-edge bleeding (charter P3).
  const samplerHandle: Handle<'SamplerAsset', 'shared'> = world.allocSharedRef<
    'SamplerAsset',
    SamplerAsset
  >('SamplerAsset', {
    kind: 'sampler',
    magFilter: 'nearest',
    minFilter: 'nearest',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });

  // Mint 4 MaterialAsset handles (one per walk frame region) using
  // the unified pass-based interface (AC-01 / plan-strategy D-1).
  // All share the same atlas texture + sampler but differ in `region`
  // (the static per-frame sub-rectangle). At runtime, SpriteRegionOverride
  // overrides this for the host entity; the 4 base materials are only
  // anchors used by the tick system to compute region slices.
  const materialHandles: Handle<'MaterialAsset', 'shared'>[] = [];
  for (let i = 0; i < 4; i++) {
    const region = frameRegions[i] ?? [0, 0, 1, 1];
    // feat-20260527 M3 / w10: pass-based sprite material (plan-strategy D-3).
    const material: MaterialAsset = {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          shader: 'forgeax::sprite',
          tags: { LightMode: 'Forward' },
          queue: 3000,
        },
      ],
      paramValues: {
        baseColor: [1.0, 1.0, 1.0, 1.0],
        texture: textureHandle,
        sampler: samplerHandle,
        region,
        pivot: [0.5, 0.5],
      },
    };
    materialHandles.push(world.allocSharedRef('MaterialAsset', material));
  }

  // Flat regions array for SpriteAnimation.regions: frameCount * 4 floats.
  const flatRegions = new Float32Array(16); // 4 frames * 4 floats
  for (let i = 0; i < 4; i++) {
    const r = frameRegions[i] ?? [0, 0, 1, 1];
    flatRegions[i * 4 + 0] = r[0];
    flatRegions[i * 4 + 1] = r[1];
    flatRegions[i * 4 + 2] = r[2];
    flatRegions[i * 4 + 3] = r[3];
  }

  // Build 10x10 grid of mat4 instance transforms.
  const instanceTransforms = new Float32Array(INSTANCE_COUNT * 16);
  const GRID = 10;
  const SPACING = 0.22;
  for (let i = 0; i < INSTANCE_COUNT; i++) {
    const row = Math.floor(i / GRID);
    const col = i % GRID;
    const cx = (col - (GRID - 1) / 2) * SPACING;
    const cy = (row - (GRID - 1) / 2) * SPACING;
    const base = i * 16;
    // Column-major mat4: translation at indices 12, 13, 14.
    instanceTransforms[base + 0] = 1;
    instanceTransforms[base + 1] = 0;
    instanceTransforms[base + 2] = 0;
    instanceTransforms[base + 3] = 0;
    instanceTransforms[base + 4] = 0;
    instanceTransforms[base + 5] = 1;
    instanceTransforms[base + 6] = 0;
    instanceTransforms[base + 7] = 0;
    instanceTransforms[base + 8] = 0;
    instanceTransforms[base + 9] = 0;
    instanceTransforms[base + 10] = 1;
    instanceTransforms[base + 11] = 0;
    instanceTransforms[base + 12] = cx;
    instanceTransforms[base + 13] = cy;
    instanceTransforms[base + 14] = 0;
    instanceTransforms[base + 15] = 1;
  }

  // Step 5: spawn ortho camera.
  const aspect = target.width / Math.max(target.height, 1);
  okResult(
    world.spawn(
      {
        component: Transform,
        data: {
          posX: 0,
          posY: 0,
          posZ: 5,
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
        data: {
          fov: Math.PI / 4,
          aspect,
          near: 0.1,
          far: 100,
          projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
          // Neutral dark slate so premultiplied sprite alpha-blend reads
          // cleanly against the background (was passed via the retired
          // RendererOptions.clearColor; sinks here per feat-20260608 D-1).
          clearR: 0.07,
          clearG: 0.07,
          clearB: 0.09,
          clearA: 1.0,
        },
      },
    ),
  );

  // Step 6: spawn 1 host entity carrying Instances(100) + SpriteAnimation
  // + SpriteRegionOverride. The tick system writes the current frame's
  // region into SpriteRegionOverride each frame; RenderSystem's sprite
  // bucket reads the override for all 100 instances.
  //
  // charter F1 application point (AC-08 IDE autocomplete): the
  // `world.spawn({ component: SpriteAnimation, data: { ... } })` call
  // site is where AI users discover the 6-field shape through IDE
  // autocomplete. The 6 fields are:
  //   frameCount: u32, frameDuration: f32, currentFrame: u32,
  //   accumDt: f32, regions: array<f32>, playbackMode: u32
  okResult(
    world.spawn(
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
      { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
      {
        component: MeshRenderer,
        data: { materials: [materialHandles[0]!] },
      },
      { component: Instances, data: { transforms: instanceTransforms } },
      {
        component: SpriteAnimation,
        data: {
          frameCount: 4,
          frameDuration: 0.2,
          currentFrame: 0,
          accumDt: 0,
          regions: flatRegions,
          playbackMode: SPRITE_PLAYBACK_MODE_LOOP,
        },
      },
      {
        component: SpriteRegionOverride,
        data: { region: new Float32Array([0, 0, 0.5, 0.5]) },
      },
    ),
  );

  // Final wire: arm the rAF loop.
  const startRes = app.start();
  if (!startRes.ok) {
    reportAppError(startRes.error);
    return;
  }
  console.warn('[sprite-atlas] running. 100 sprites / 1 atlas / 1 draw call.');
}

function reportAppError(err: AppError | RhiError | EngineEnvironmentError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[sprite-atlas] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[sprite-atlas] ${err.code}: ${err.hint}`);
}