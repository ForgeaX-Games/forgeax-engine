// hello-compressed-texture -- KTX2/Basis block-compression e2e demo (M6 w39).
//
// Loads a 256x256 checkerboard texture through the build-time pack pipeline:
// the .meta.json sidecar sets `compressionMode: 'etc1s'` so the image importer
// produces a Basis KTX2 (.ktx2) at import time. The runtime loader transcode
// arm (M5 w34) transparently transcodes it to the platform-native block format
// on load. A quad mesh carries the texture through the packed PBR material
// pipeline so the pixel-parity smoke (w42) has a non-trivial render target.
//
// Query switch (D-13):
//   `?mode=uncompressed` -- loads an identical checkerboard through the
//   `compressionMode: 'none'` path, producing a raw RGBA8 .bin baseline.
//   This mirrors the production-fallback code path: when the device lacks
//   texture-compression capability, the loader falls back to rgba8unorm.
//
// charter mapping:
//   P1 progressive disclosure -- the default path exercises the full
//     Basis transcode chain with zero sidecar knowledge; the query switch
//     is the second-level disclosure for parity comparison.
//   P4 consistent abstraction -- same MeshFilter+MeshRenderer entry
//     whether loading KTX2 or raw .bin.
//
// Falsifiability (D-13 / §5.4): the uncompressed baseline path renders the
// same checkerboard through a different code path (raw RGBA8 upload vs
// block-compressed upload), serving as the ground truth for w42 pixel parity.

import { createApp } from '@forgeax/engine-app';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  Camera,
  createDevImportTransport,
  DirectionalLight,
  EngineEnvironmentError,
  HANDLE_QUAD,
  MeshFilter,
  MeshRenderer,
  perspective,
  Transform,
} from '@forgeax/engine-runtime';
import type { TextureAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const PACK_INDEX_URL = '/pack-index.json';

// GUIDs embedded in the demo's .meta.json sidecars (subAssets[0].guid).
// These are the stable identifiers the pack plugin stamps into pack-index.json
// at build time; the runtime resolves them via loadByGuid.
const COMPRESSED_GUID = '8a2b5c3d-4e6f-7a8b-9c0d-1e2f3a4b5c6d';
const UNCOMPRESSED_GUID = '9b3c4d5e-6f7a-8b9c-0d1e-2f3a4b5c6d7e';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) {
  throw new Error('[compressed-texture] missing <canvas id="app"> in index.html');
}

const mode = new URLSearchParams(window.location.search).get('mode') ?? 'compressed';

bootstrap(canvas, mode).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[compressed-texture] no usable WebGPU backend:', err);
  } else {
    console.error('[compressed-texture] bootstrap error:', err);
  }
});

async function bootstrap(
  target: HTMLCanvasElement,
  loadMode: string,
): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() },
  );
  if (!appRes.ok) {
    console.error('[compressed-texture] createApp failed');
    return;
  }
  const app = appRes.value;
  console.warn(`[compressed-texture] backend=${app.renderer.backend} mode=${loadMode}`);

  const ready = await app.renderer.ready;
  if (!ready.ok) {
    console.error('[compressed-texture] renderer.ready failed:', ready.error.code, ready.error.hint);
    return;
  }

  const assets = app.renderer.assets;
  if (assets === null) {
    console.error('[compressed-texture] AssetRegistry is null');
    return;
  }
  assets.configurePackIndex(PACK_INDEX_URL);
  const world = app.world;

  // Select the texture GUID based on the query mode.
  const textureGuid = loadMode === 'uncompressed' ? UNCOMPRESSED_GUID : COMPRESSED_GUID;
  const guidRes = AssetGuid.parse(textureGuid);
  if (!guidRes.ok) {
    console.error('[compressed-texture] GUID parse failed:', guidRes.error.code);
    return;
  }

  // loadByGuid returns the raw TextureAsset POD; the Basis transcode arm
  // runs transparently inside the load path (M5 w34).
  const texLoadRes = await assets.loadByGuid<TextureAsset>(guidRes.value);
  if (!texLoadRes.ok) {
    console.error(
      '[compressed-texture] texture loadByGuid failed:',
      texLoadRes.error.code,
      texLoadRes.error.hint,
    );
    return;
  }
  const texAsset = texLoadRes.value;
  console.warn(
    `[compressed-texture] texture loaded: format=${texAsset.format} ` +
    `size=${texAsset.data.byteLength}B mipLevelCount=${texAsset.mipLevelCount ?? 1}`,
  );

  // Mint a shared texture handle; the render-system-record path resolves it
  // at bind-time.
  const textureHandle = world.allocSharedRef('TextureAsset', texAsset);

  // Default linear-repeat sampler.
  const samplerHandle = world.allocSharedRef('SamplerAsset', {
    kind: 'sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
  });

  // Packed PBR material with the checkerboard texture wired to baseColor.
  const materialHandle = world.allocSharedRef('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        shader: 'forgeax::standard-pbr',
        paramValues: {
          baseColorFactor: [1, 1, 1, 1],
          roughnessFactor: 0.8,
          metallicFactor: 0,
          baseColorTexture: { handle: textureHandle },
          baseColorSampler: { handle: samplerHandle },
        },
      },
    ],
  });

  // A staggered layout of 4 quads helps the parity smoke (w42) exercise
  // the pipeline against multiple draw calls and UV offsets.
  const quads: [number, number, number, number, number, number][] = [
    [-1.5, 0.8, 0, 0.7, 0.7, 1],
    [1.5, 0.8, 0, 0.5, 0.5, 1],
    [-1.5, -0.8, 0, 0.5, 0.5, 1],
    [1.5, -0.8, 0, 0.7, 0.7, 1],
  ];

  for (const [px, py, pz, sx, sy, sz] of quads) {
    world.spawn(
      {
        component: MeshFilter,
        data: { assetHandle: HANDLE_QUAD },
      },
      {
        component: MeshRenderer,
        data: { materials: [materialHandle] },
      },
      {
        component: Transform,
        data: {
          posX: px,
          posY: py,
          posZ: pz,
          scaleX: sx,
          scaleY: sy,
          scaleZ: sz,
        },
      },
    );
  }

  // Directional light (no Transform -- direction is a field on the component).
  world.spawn({
    component: DirectionalLight,
    data: {
      directionX: -0.1,
      directionY: -0.6,
      directionZ: -1.0,
      colorR: 1,
      colorG: 1,
      colorB: 1,
      intensity: 3,
    },
  });

  // Camera: perspective from Z=3, looking at origin.
  world.spawn(
    { component: Transform, data: { posX: 0, posY: 0, posZ: 3 } },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 }),
        clearR: 0.02,
        clearG: 0.02,
        clearB: 0.05,
        clearA: 1,
      },
    },
  );

  // Print caps info on the page HUD.
  const caps = app.renderer.device.caps;
  const hud = document.getElementById('texture-hud');
  if (hud) {
    hud.innerHTML =
      `Backend: ${app.renderer.backend}  Mode: ${loadMode}<br>` +
      `BC: ${caps.textureCompressionBc ? 'yes' : 'no'}  ` +
      `ETC2: ${caps.textureCompressionEtc2 ? 'yes' : 'no'}  ` +
      `ASTC: ${caps.textureCompressionAstc ? 'yes' : 'no'}`;
  }
}