// msaa-sprite-pixel-diff.dawn.test.ts -
// feat-20260604-learn-render-4-10-anti-aliasing-msaa-engine-wiring / M2 / w9 [F-1 fixup].
//
// Closes the F-1 sprite+MSAA test-coverage blind spot called out by plan w9
// acceptanceCheck and ImplementReviewer issue-2: the most intricate path of
// this feat is the LDR (tonemap=none) sprite-split sub-pass under MSAA
// (render-system-record.ts splitLdrSprite + the count=4 multisample
// unorm target + deferred resolve to the single-sample swap-chain view).
// No existing green test reached it - the MSAA demo scene is pure mesh
// (triangle/cube/quad/sphere) and the hello-sprite smoke runs antialias=none.
//
// This test renders a sprite entity (HANDLE_QUAD + forgeax::sprite material)
// behind a default perspective Camera with tonemap=none, once at
// antialias=none and once at antialias=msaa, and asserts:
//   (1) the MSAA pass emits 0 RhiError - if the sprite sub-pass paired a
//       count=1 color attachment against the count=4 depth (or wired an
//       illegal resolveTarget), WebGPU validation would fire immediately
//       through renderer.onError. 0 errors proves the split-sub-pass
//       sampleCount pairing + resolve wiring is legal. (hard floor, AC-05)
//   (2) the MSAA frame differs from the antialias=none frame - proving the
//       sprite MSAA path is genuinely active and not a silent no-op (AC-04).
//
// Follows the fxaa-pixel-diff.dawn.test.ts canvas-mock / device-capture /
// readback recipe and the hello-sprite smoke sprite-material registration.
//
// feat-20260625-refactor-sprite-as-transparent-mesh M4 / w16 — touched
// only the material-payload literal (transparent:true + UBO-aligned
// paramValues field names per D-3 / D-4). The pixel-diff predicate
// (MSAA frame != none-AA frame) is invariant under the F-4 unit-quad
// resize because the sprite occupies the same rotated-quad footprint
// in NDC and the rotated edge still gives MSAA something to smooth.
// AC-13 perf declaration: this fixture asserts only structural absence-
// of-RhiError + pixel-diff existence; perf is not bounded here and is
// covered by the hello-sprite smoke FPS gate (smoke green = no
// regression beyond the SMOKE_PIXEL_THRESHOLD eps).

import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { Camera, MeshFilter, MeshRenderer, Transform } from '../components';
import { ANTIALIAS_MSAA, ANTIALIAS_NONE, TONEMAP_NONE } from '../components/camera';
import { createRenderer, HANDLE_QUAD, SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '../index';

const WIDTH = 256;
const HEIGHT = 256;

const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;

const ENGINE_MANIFEST = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  return buildEngineShaderManifest();
})();
const ENGINE_MANIFEST_URL = `data:application/json,${encodeURIComponent(
  JSON.stringify(ENGINE_MANIFEST),
)}`;

async function doReadPixels(device: GPUDevice, renderTarget: GPUTexture): Promise<Uint8Array> {
  const bytesPerPixel = 4;
  const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
  const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
  const buf = device.createBuffer({
    size: bytesPerRow * HEIGHT,
    usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
  });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: buf, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([enc.finish()]);
  await device.queue.onSubmittedWorkDone();
  await buf.mapAsync(MAP_MODE_READ);
  const mapped = buf.getMappedRange();
  const bytes = new Uint8Array(mapped.slice(0));
  buf.unmap();
  buf.destroy();
  return bytes;
}

// 8x8 RGBA texture (4 colour quadrants) so the sprite has visible texels
// under the multiplicative colorTint. Mirrors the hello-sprite smoke's
// buildSyntheticRgba so the sprite material loads without an HTTP /pack
// fetch (dawn-node has no server).
function buildSyntheticRgba(): { width: number; height: number; data: Uint8Array } {
  const w = 8;
  const h = 8;
  const bytes = new Uint8Array(w * h * 4);
  const palette = [
    [220, 110, 50, 255],
    [80, 220, 100, 255],
    [60, 180, 220, 255],
    [230, 130, 200, 255],
  ];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const top = y < h / 2;
      const left = x < w / 2;
      const quadrant = top ? (left ? 0 : 1) : left ? 2 : 3;
      const c = palette[quadrant] ?? palette[0] ?? [255, 255, 255, 255];
      bytes[i + 0] = c[0] ?? 0;
      bytes[i + 1] = c[1] ?? 0;
      bytes[i + 2] = c[2] ?? 0;
      bytes[i + 3] = c[3] ?? 0;
    }
  }
  return { width: w, height: h, data: bytes };
}

function spawnSpriteScene(world: World, spriteMaterialPayload: unknown, antialias: number): void {
  // feat-20260614 M8: MeshRenderer.materials holds a per-World column handle
  // (numeric); mint it from the catalogued material payload on the World the
  // scene is spawned into. The material's texture/sampler paramValues are GUID
  // strings the extract stage resolves to per-World handles.
  const spriteMaterial = world.allocSharedRef('MaterialAsset', spriteMaterialPayload);
  // A rotated quad gives diagonal sprite edges so MSAA has something to
  // smooth (the camera-facing axis-aligned quad would expose almost no
  // edge to antialias).
  world.spawn(
    {
      component: Transform,
      data: {
        posX: 0,
        posY: 0,
        posZ: 0,
        quatX: 0,
        quatY: 0,
        quatZ: 0.3826834,
        quatW: 0.9238795,
        scaleX: 1,
        scaleY: 1,
        scaleZ: 1,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [spriteMaterial as never] } },
  );
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
      data: {
        fov: Math.PI / 4,
        aspect: 1,
        near: 0.1,
        far: 100,
        tonemap: TONEMAP_NONE,
        antialias,
      } as Record<string, unknown> as never,
    },
  );
}

describe('feat-20260604-msaa M2 w9 [F-1]: LDR sprite + MSAA split sub-pass coverage (dawn)', () => {
  it('LDR (tonemap=none) + sprite + antialias=msaa: 0 RhiError + pixel diff vs antialias=none', async () => {
    const dawnAvailable = typeof globalThis.navigator?.gpu?.requestAdapter === 'function';
    if (!dawnAvailable)
      throw new Error('dawn-node navigator.gpu not injected; vitest.setup-webgpu.ts regressed');

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
              if (sharedDevice === undefined)
                throw new Error('render target requested before device captured');
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
    expect(renderer.backend).toBe('webgpu');
    const ready = await renderer.ready;
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;
    const device = sharedDevice;
    if (device === undefined) throw new Error('GPUDevice not captured');

    const assets = renderer.assets;
    if (assets === null) throw new Error('AssetRegistry is null');

    // Catalogue + upload a small sprite texture, a sampler, and a
    // forgeax::sprite material. feat-20260625 M2/M3 (D-3): sprite is now
    // a regular material whose `transparent: true` first-pass flag (not
    // the legacy shadingModel='sprite' arm) drives the LDR split sub-pass
    // in the record stage. feat-20260614 M8: AssetRegistry holds GUID->
    // payload only (no handle concept); texture/sampler are referenced
    // from the material paramValues by GUID string and resolved to per-
    // World column handles at extract. The explicit uploadTexture call
    // exercises the GPU residency path via a column handle minted on an
    // upload-only World.
    //
    // Falsification (smoke harness sensitivity claim, not committed to CI):
    // if the sprite pass's blend state is hand-rewritten to `src=one /
    // dst=zero` (hard-edge non-blended composite), the MSAA frame becomes
    // byte-identical to the antialias=none baseline (assertion (2) flips
    // RED with diffCount=0). This confirms the smoke is sensitive to the
    // premultiplied-alpha blend path the `transparent: true` pass declaration
    // selects.
    const synth = buildSyntheticRgba();
    const synthPod = {
      kind: 'texture' as const,
      width: synth.width,
      height: synth.height,
      format: 'rgba8unorm-srgb' as const,
      data: synth.data,
      colorSpace: 'srgb' as const,
      mipmap: false,
    };
    const TEX_GUID = '00000000-0000-7000-8000-0000000005a1';
    const SAMPLER_GUID = '00000000-0000-7000-8000-0000000005a2';
    const MATERIAL_GUID = '00000000-0000-7000-8000-0000000005a3';
    const texCatalog = assets.catalog(TEX_GUID, synthPod as never);
    expect(texCatalog.ok, 'sprite texture catalog').toBe(true);
    if (!texCatalog.ok) return;

    const uploadWorld = new World();
    const textureHandle = uploadWorld.allocSharedRef('TextureAsset', synthPod);
    const uploadRes = await renderer.store.uploadTexture(textureHandle, synthPod as never, {
      bytes: synth.data,
      width: synth.width,
      height: synth.height,
      mime: 'image/png',
      colorSpace: 'srgb',
      mipmap: false,
    });
    expect(uploadRes.ok, 'sprite texture upload').toBe(true);
    if (!uploadRes.ok) return;

    const samplerCatalog = assets.catalog(SAMPLER_GUID, {
      kind: 'sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    } as never);
    expect(samplerCatalog.ok, 'sampler catalog').toBe(true);
    if (!samplerCatalog.ok) return;

    const spriteMaterialPayload = {
      kind: 'material' as const,
      passes: [
        {
          name: 'Forward',
          shader: 'forgeax::sprite',
          tags: { LightMode: 'Forward' },
          queue: 3000,
          // feat-20260625 M2 / w6 (Q3=b): transparent is now a first-class
          // material-side flag that drives the LDR pass split + premultiplied
          // -alpha blend pipeline selection in the record stage. The legacy
          // shadingModel='sprite' arm that used to trigger the split via
          // shader-id inference is gone (M3 / w15).
          // feat-20260626-sprite-transparent-collapse M1/M4: the boolean
          // `transparent` field has collapsed into `renderState.blend` as
          // the single asset-side SSOT; transparent routing now derives
          // from `renderState.blend !== undefined`.
          renderState: { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND },
        },
      ],
      paramValues: {
        // feat-20260625 M3 / w11 (D-4): paramValues field names are now UBO-
        // aligned to match sprite.wgsl.meta.json paramSchema 1:1 (colorTint /
        // region / pivotAndSize / slicesAndMode / baseColorTexture). The
        // legacy `baseColor` / `texture` / `pivot` / `size` field names are
        // still read by the extract-stage backwards-compat fold (D-8) so
        // older demos keep rendering during migration; new code declares
        // the UBO-aligned forms directly.
        colorTint: [1.0, 0.4, 0.4, 1.0],
        baseColorTexture: TEX_GUID,
        sampler: SAMPLER_GUID,
        region: [0, 0, 1, 1],
        pivotAndSize: [0.5, 0.5, 1, 1],
      },
    };
    const matCatalog = assets.catalog(MATERIAL_GUID, spriteMaterialPayload as never);
    expect(matCatalog.ok, 'sprite material catalog').toBe(true);
    if (!matCatalog.ok) return;

    // Pass 1: antialias=none baseline.
    const worldNone = new World();
    spawnSpriteScene(worldNone, spriteMaterialPayload, ANTIALIAS_NONE);
    const drawnNone = renderer.draw([worldNone], { owner: 0 });
    expect(drawnNone.ok, 'LDR sprite none-AA draw').toBe(true);
    await device.queue.onSubmittedWorkDone();
    if (renderTarget === undefined) throw new Error('renderTarget not configured');
    const pixelsNone = await doReadPixels(device, renderTarget);
    expect(pixelsNone.length).toBeGreaterThan(0);

    // Pass 2: antialias=msaa - exercises the LDR sprite split sub-pass
    // under MSAA. Capture every RhiError fired through the renderer's
    // fan-out channel during this draw.
    const msaaErrors: Array<{ code: string }> = [];
    const unsubscribe = renderer.onError((err) => msaaErrors.push({ code: err.code }));
    const worldMsaa = new World();
    spawnSpriteScene(worldMsaa, spriteMaterialPayload, ANTIALIAS_MSAA);
    const drawnMsaa = renderer.draw([worldMsaa], { owner: 0 });
    await device.queue.onSubmittedWorkDone();
    if (typeof unsubscribe === 'function') unsubscribe();
    expect(drawnMsaa.ok, 'LDR sprite MSAA draw').toBe(true);

    // (1) Hard floor: the sprite split sub-pass under MSAA must not trip
    // any WebGPU validation error (count mismatch / illegal resolveTarget).
    expect(
      msaaErrors.length,
      `expected 0 RhiError on LDR sprite+MSAA path, got: [${msaaErrors.map((e) => e.code).join(', ')}]`,
    ).toBe(0);

    if (renderTarget === undefined) throw new Error('renderTarget not configured');
    const pixelsMsaa = await doReadPixels(device, renderTarget);
    expect(pixelsMsaa.length).toBe(pixelsNone.length);

    // (2) MSAA must not be a silent no-op on the sprite path: the resolved
    // multisample frame differs from the single-sample baseline at the
    // rotated sprite edges.
    let diffCount = 0;
    for (let i = 0; i < pixelsNone.length; i++) {
      if (pixelsNone[i] !== pixelsMsaa[i]) diffCount++;
    }
    expect(
      diffCount,
      'expected pixel diff > 0 between sprite MSAA and none-AA frames',
    ).toBeGreaterThan(0);
  });
});
