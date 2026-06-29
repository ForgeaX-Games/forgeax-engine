// feat-20260623-world-space-video-asset M4 / w13 — AC-06: a VideoAsset GUID
// embedded in a MaterialAsset.paramValues texture field flows through the
// extract layer and produces a bind group without blowing up.
//
// AC-06 (requirements.md): video reuses the existing paramValues texture
// channel (no new MaterialAsset top-level field). The extract layer's
// resolveTexLike must recognise `payload.kind === 'video'` (D-5) and route it
// as a video source rather than minting a TextureAsset handle (which would then
// crash the record stage's ensureResident, whose switch has no `video` arm).
//
// R-7 (plan-strategy §4): the field the video GUID occupies (baseColorTexture)
// MUST be in the shader's `derive(paramSchema).textureFieldNames` traversal set
// — otherwise extract never even looks at it and the video silently fails to
// render. This test asserts that membership explicitly (the R-7 anchor) so a
// future schema edit that drops baseColorTexture surfaces here.
//
// Two layers of assertion:
//   1. CPU (deterministic) — extractFrame on a world with a standard-PBR
//      material whose baseColorTexture paramValue is a catalogued VideoAsset
//      GUID. The produced MaterialSnapshot must (a) flag baseColorTexture as a
//      video-sourced field (videoTextureFields), and (b) NOT carry it as a
//      static TextureAsset handle (no ensureResident pollution, AC-08). This is
//      the RED anchor before w14 (extract resolveTexLike video branch).
//   2. dawn (structural) — a full renderer frame with the same material draws
//      with zero RhiError, proving the extract->record->bind-group path does
//      not blow up on a video-sourced texture field (the bind group is produced;
//      the per-frame upload itself lands in w16, here the field falls back to the
//      default view until a frame is uploaded).

import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type {
  Handle,
  MaterialAsset,
  MaterialPassDescriptor,
  MeshAsset,
  VideoAsset,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

import { AssetRegistry } from '../asset-registry';
import { Camera, MeshFilter, MeshRenderer, Transform } from '../components';
import { createRenderer, HANDLE_CUBE, HANDLE_QUAD } from '../index';
import { extractFrame } from '../render-system-extract';
import { propagateTransforms } from '../systems/propagate-transforms';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const WIDTH = 128;
const HEIGHT = 128;
const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;

const STANDARD_PBR_SHADER = 'forgeax::default-standard-pbr';
const FORWARD_PBR_PASS: MaterialPassDescriptor = {
  name: 'Forward',
  shader: STANDARD_PBR_SHADER,
};

function transformData(x: number, y: number, z: number) {
  return {
    posX: x,
    posY: y,
    posZ: z,
    quatX: 0,
    quatY: 0,
    quatZ: 0,
    quatW: 1,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
  };
}

function registerTestMesh(world: World) {
  const mesh: MeshAsset = {
    kind: 'mesh',
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2]),
    attributes: {},
    aabb: new Float32Array([0, 0, 0, 1, 1, 1]),
    submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' }],
  };
  return world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', mesh);
}

/**
 * Catalog a VideoAsset GUID + a standard-PBR material whose baseColorTexture
 * paramValue references it; return the material column handle to spawn with.
 */
function catalogVideoMaterial(
  world: World,
  assets: AssetRegistry,
): { matHandle: Handle<'MaterialAsset', 'shared'>; videoGuid: AssetGuid } {
  const videoGuid = AssetGuid.random();
  const videoGuidStr = AssetGuid.format(videoGuid);
  const video: VideoAsset = { kind: 'video', url: 'extract-bindgroup-clip.webm' };
  assets.catalog(videoGuid, video);

  const material: MaterialAsset = {
    kind: 'material',
    passes: [FORWARD_PBR_PASS],
    // The video GUID occupies the baseColorTexture texture2d slot — exactly the
    // shape a static texture would (D-5 reuse of the texture2d slot).
    paramValues: { baseColor: [1, 1, 1], baseColorTexture: videoGuidStr },
  } as MaterialAsset;
  const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', material);
  return { matHandle, videoGuid };
}

describe('AC-06 / R-7 — video GUID in paramValues is a recognised texture field (M4 / w13)', () => {
  it('R-7: baseColorTexture is in the standard-PBR shader textureFieldNames set', () => {
    const assets = new AssetRegistry(makeMockShaderRegistry());
    const fields = assets.materialShaderTextureFieldNames(STANDARD_PBR_SHADER);
    expect(fields, 'standard-PBR shader must declare texture fields').toBeDefined();
    expect(fields?.has('baseColorTexture')).toBe(true);
  });

  it('extract flags the video-sourced field and does NOT carry it as a static TextureAsset handle', () => {
    const world = new World();
    const assets = new AssetRegistry(makeMockShaderRegistry());
    const mesh = registerTestMesh(world);
    const { matHandle } = catalogVideoMaterial(world, assets);

    world
      .spawn(
        { component: Transform, data: transformData(0, 0, 0) },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [matHandle] } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: transformData(0, 0, 5) },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();

    propagateTransforms(world);
    const frame = extractFrame(world, assets);
    expect(frame.renderables.length).toBe(1);
    const mat = frame.renderables[0]?.material;
    expect(mat).toBeDefined();

    // Desired post-w14 behavior (RED before w14):
    //   (a) the baseColorTexture field is flagged as video-sourced.
    expect(mat?.videoTextureFields?.has('baseColorTexture')).toBe(true);
    //   (b) it is NOT carried as a static TextureAsset handle (would pollute the
    //       ensureResident cache + crash on a video POD, AC-08).
    expect(mat?.textureHandles?.has('baseColorTexture')).not.toBe(true);
    expect(mat?.baseColorTexture).toBeUndefined();
  });
});

interface DawnHarness {
  renderer: Awaited<ReturnType<typeof createRenderer>>;
  device: GPUDevice;
}

const ENGINE_MANIFEST = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  return buildEngineShaderManifest();
})();
const ENGINE_MANIFEST_URL = `data:application/json,${encodeURIComponent(
  JSON.stringify(ENGINE_MANIFEST),
)}`;

async function bootDawn(): Promise<DawnHarness | null> {
  const dawnAvailable = typeof globalThis.navigator?.gpu?.requestAdapter === 'function';
  if (!dawnAvailable) {
    throw new Error('dawn-node navigator.gpu not injected; vitest.setup-webgpu.ts regressed');
  }
  let sharedDevice: GPUDevice | undefined;
  const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
    globalThis.navigator.gpu,
  );
  globalThis.navigator.gpu.requestAdapter = async (opts) => {
    const rawAdapter = await originalRequestAdapter(opts);
    if (rawAdapter === null) return rawAdapter;
    const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
    rawAdapter.requestDevice = async (desc) => {
      const dev = await originalRequestDevice(desc);
      if (sharedDevice === undefined) sharedDevice = dev;
      return dev;
    };
    return rawAdapter;
  };

  let renderTarget: GPUTexture | undefined;
  const ensureRenderTarget = (device: GPUDevice, format: GPUTextureFormat): GPUTexture => {
    if (renderTarget !== undefined) return renderTarget;
    renderTarget = device.createTexture({
      size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
      format,
      usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC,
      viewFormats: ['rgba8unorm-srgb'],
    });
    return renderTarget;
  };
  const mockCanvas = {
    width: WIDTH,
    height: HEIGHT,
    getContext(kind: string): unknown {
      if (kind !== 'webgpu') return null;
      return {
        configure(desc: { device: GPUDevice; format?: GPUTextureFormat }) {
          ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm');
        },
        unconfigure() {},
        getCurrentTexture(): GPUTexture {
          if (renderTarget === undefined) {
            if (sharedDevice === undefined) {
              throw new Error('render target requested before device captured');
            }
            return ensureRenderTarget(sharedDevice, 'rgba8unorm');
          }
          return renderTarget;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;

  let renderer: Awaited<ReturnType<typeof createRenderer>>;
  try {
    renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: ENGINE_MANIFEST_URL });
  } finally {
    globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
  }
  const ready = await renderer.ready;
  expect(ready.ok).toBe(true);
  if (!ready.ok) return null;
  if (sharedDevice === undefined) throw new Error('dawn device never captured');
  ensureRenderTarget(sharedDevice, 'rgba8unorm');
  return { renderer, device: sharedDevice };
}

describe('AC-06 — extract->record->bind group does not blow up on a video field (dawn) (M4 / w13)', () => {
  it('a renderer frame with a video-sourced baseColorTexture draws with 0 RhiError', async () => {
    const harness = await bootDawn();
    if (harness === null) return;
    const { renderer, device } = harness;

    const assets = renderer.assets;
    if (assets === null) throw new Error('AssetRegistry is null');

    const videoGuid = AssetGuid.random();
    const videoGuidStr = AssetGuid.format(videoGuid);
    const video: VideoAsset = { kind: 'video', url: 'extract-bindgroup-clip.webm' };
    const videoCatalog = assets.catalog(videoGuid, video as never);
    expect(videoCatalog.ok).toBe(true);

    const materialPayload = {
      kind: 'material' as const,
      passes: [FORWARD_PBR_PASS],
      paramValues: { baseColor: [1, 1, 1], baseColorTexture: videoGuidStr },
    };

    const errorCodes: string[] = [];
    const unsub = renderer.onError((e) => {
      errorCodes.push(e.code);
    });

    const world = new World();
    const matHandle = world.allocSharedRef('MaterialAsset', materialPayload);
    world
      .spawn(
        { component: Transform, data: transformData(0, 0, 0) },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [matHandle] } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: transformData(0, 0, 5) },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();

    const drawn = renderer.draw(world);
    expect(drawn.ok).toBe(true);
    await device.queue.onSubmittedWorkDone();
    if (typeof unsub === 'function') unsub();

    // The video-sourced texture field must not trip any WebGPU VALIDATION error
    // (the bind group is well-formed; the field falls back to the default view).
    // The expected, structured `video-upload-unsupported` signal (AC-10, asserted
    // below) is NOT a validation error and is excluded here.
    const validationErrors = errorCodes.filter((c) => c !== 'video-upload-unsupported');
    expect(
      validationErrors,
      'a video-sourced texture field must not trip any WebGPU validation error',
    ).toEqual([]);
  });

  // AC-10 PRODUCTION-PATH assertion: with no VideoElementProvider registered
  // (dawn has no HTMLVideoElement) and no high-perf GPUExternalTexture capability,
  // the REAL per-frame upload path (render-system-record videoTextureView) hits
  // the double-miss and MUST fire the structured VideoUploadUnsupportedError on
  // the engine error channel — NOT silently bind a default view. This exercises
  // the production draw path end-to-end, replacing the prior orphan pure-function
  // test (resolveVideoUpload) that the production render path never called.
  it('AC-10: production draw fires video-upload-unsupported on capability double-miss', async () => {
    const harness = await bootDawn();
    if (harness === null) return;
    const { renderer, device } = harness;

    const assets = renderer.assets;
    if (assets === null) throw new Error('AssetRegistry is null');

    const videoGuid = AssetGuid.random();
    const videoGuidStr = AssetGuid.format(videoGuid);
    const video: VideoAsset = { kind: 'video', url: 'double-miss-clip.webm' };
    expect(assets.catalog(videoGuid, video as never).ok).toBe(true);

    // Mirror the demo recipe exactly: unlit shader + HANDLE_QUAD. The video
    // upload path (videoTextureView) is reached via the per-submesh user-region
    // bind-group loop, which iterates the shader's textureFieldNames; unlit
    // declares baseColorTexture there. (The earlier standard-PBR + HANDLE_CUBE
    // shape routes through a different builtin-cube pipeline branch that does not
    // hit the user-region video loop — not the production demo path.)
    const materialPayload = {
      kind: 'material' as const,
      passes: [
        { name: 'Forward', shader: 'forgeax::default-unlit', tags: { LightMode: 'Forward' } },
      ],
      paramValues: { baseColor: [1, 1, 1], baseColorTexture: videoGuidStr },
    };

    const fired: { code: string; hint: string }[] = [];
    const unsub = renderer.onError((e) => {
      fired.push({ code: e.code, hint: e.hint });
    });

    const world = new World();
    // NB: NO VIDEO_ELEMENT_PROVIDER_KEY resource inserted -> the production
    // upload path resolves element===undefined; high-perf path is absent on
    // dawn -> genuine AC-10 double-miss.
    const matHandle = world.allocSharedRef('MaterialAsset', materialPayload);
    world
      .spawn(
        { component: Transform, data: transformData(0, 0, 0) },
        { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
        { component: MeshRenderer, data: { materials: [matHandle] } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: transformData(0, 0, 5) },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();

    const drawn = renderer.draw(world);
    expect(drawn.ok).toBe(true);
    await device.queue.onSubmittedWorkDone();
    if (typeof unsub === 'function') unsub();

    const unsupported = fired.filter((e) => e.code === 'video-upload-unsupported');
    expect(
      unsupported.length,
      'production videoTextureView must fire video-upload-unsupported on double-miss (AC-10), not silently bind default',
    ).toBeGreaterThan(0);
    // The signal is property-accessible (charter P3): AI users branch on .code
    // and read .hint without string-parsing the human message.
    expect(unsupported[0]?.hint.length ?? 0).toBeGreaterThan(0);
  });
});
