// sprite-nineslice-mesh-bind.dawn.test.ts -- feat-20260527-sprite-nineslice
// M2 / w13. dawn-node smoke that the HANDLE_NINESLICE_QUAD GPU buffers are
// resident and bind cleanly when a sprite material declares non-zero `slices`.
//
// Plan-strategy §M2 boundary clause: M2 must include at least one dawn fixture so
// the dangling-slot regression (the prior implement's round-1 issue #2:
// builtin handle imported but not GPU-uploaded) trips before verify, not at
// PR review. This fixture renders ONE frame with `slices=[0.25,0.25,0.25,0.25]`
// + `sliceMode=0` + a 4x4 RGBA texture, then asserts:
//   (a) renderer.draw returns ok (no thrown error).
//   (b) zero RhiError fires through `Renderer.onError`.
// It does NOT assert pixel content -- M3 / w15 (hello-sprite-nineslice-section
// dawn fixture) covers stretch + tile pixel parity.

import { World } from '@forgeax/engine-ecs';
import {
  AssetRegistry,
  Camera,
  createRenderer,
  HANDLE_QUAD,
  MeshFilter,
  MeshRenderer,
  SPRITE_PREMULTIPLIED_ALPHA_BLEND,
  Transform,
} from '@forgeax/engine-runtime';
import type { MaterialAsset, SamplerAsset, TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

const WIDTH = 64;
const HEIGHT = 64;
const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;

const ENGINE_MANIFEST = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  return buildEngineShaderManifest();
})();
const ENGINE_MANIFEST_URL = `data:application/json,${encodeURIComponent(
  JSON.stringify(ENGINE_MANIFEST),
)}`;

describe('feat-20260527-sprite-nineslice w13 dawn smoke (HANDLE_NINESLICE_QUAD bind)', () => {
  it('sprite + slices=[.25,.25,.25,.25] renders one frame with 0 RhiError', async () => {
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

    const assets = renderer.assets;
    expect(assets).toBeInstanceOf(AssetRegistry);

    const world = new World();

    // ── Build a 4x4 RGBA texture (16 texels) with a recognizable pattern. ──
    // The exact pixels are not asserted -- the frame just needs to render
    // without firing RhiError. 4x4 is below the wgpu mipmap requirement so
    // mipmap=false in the import settings.
    const pixels = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) {
      pixels[i * 4 + 0] = (i * 16) & 0xff;
      pixels[i * 4 + 1] = 0x88;
      pixels[i * 4 + 2] = 0x44;
      pixels[i * 4 + 3] = 0xff;
    }
    const texAsset: TextureAsset = {
      kind: 'texture',
      width: 4,
      height: 4,
      format: 'rgba8unorm-srgb',
      colorSpace: 'srgb',
      mipmap: false,
      data: pixels,
    };
    const texHandle = world.allocSharedRef<'TextureAsset', TextureAsset>('TextureAsset', texAsset);
    // feat-20260601-gpu-resource-store-extraction M1: explicit texture GPU upload.
    const texUploadRes = await renderer.store.uploadTexture(texHandle, texAsset, {
      bytes: pixels,
      width: 4,
      height: 4,
      mime: 'image/png',
      colorSpace: 'srgb',
      mipmap: false,
    });
    expect(texUploadRes.ok).toBe(true);
    if (!texUploadRes.ok) return;

    const samplerAsset: SamplerAsset = {
      kind: 'sampler',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'nearest',
    };
    const samplerHandle = world.allocSharedRef<'SamplerAsset', SamplerAsset>(
      'SamplerAsset',
      samplerAsset,
    );

    // Sprite material with non-zero slices -- this triggers the w11 mesh
    // routing override to HANDLE_NINESLICE_QUAD. paramValues includes
    // texture + sampler so the missing-texture debug-pink branch stays cold.
    //
    // feat-20260625-refactor-sprite-as-transparent-mesh M4 / w16 — updated
    // to use the post-M2/M3 SSOT material shape:
    //   - first-pass `transparent: true` flag (M2 / w6, Q3=b) drives the
    //     LDR split + premultiplied-alpha blend pipeline (replaces the
    //     legacy shadingModel='sprite' arm ablated in M3 / w15).
    //   - paramValues field names are UBO-aligned to sprite.wgsl.meta.json
    //     paramSchema (M3 / w11, D-4): `baseColorTexture` (was `texture`)
    //     and `slicesAndMode` vec4 (was `slices` + `sliceMode` split).
    // feat-20260626-sprite-transparent-collapse M1/M4: the boolean
    // `transparent` field has collapsed into `renderState.blend` as the
    // single asset-side SSOT; transparent routing now derives from
    // `renderState.blend !== undefined`.
    // The slices mesh routing decision (D-2 sentinel:
    // HANDLE_QUAD -> HANDLE_NINESLICE_QUAD when slices != [0,0,0,0]) is
    // unchanged; the record stage reads it via the materialShaderId ===
    // 'forgeax::sprite' + non-zero `slicesAndMode.xyz` predicate.
    const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
      kind: 'material',
      passes: [
        {
          name: 'Sprite',
          shader: 'forgeax::sprite',
          queue: 3000,
          tags: { LightMode: 'Forward' },
          renderState: { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND },
        },
      ],
      paramValues: {
        baseColorTexture: texHandle as unknown as string,
        sampler: samplerHandle as unknown as string,
        slicesAndMode: [0.25, 0.25, 0.25, 0.25],
      },
    });

    const errors: unknown[] = [];
    renderer.onError((e) => {
      errors.push(e);
    });

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
      { component: MeshRenderer, data: { materials: [matHandle] } },
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
        data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 },
      },
    );

    const drawn = renderer.draw(world);
    expect(drawn.ok).toBe(true);
    if (sharedDevice !== undefined) {
      await sharedDevice.queue.onSubmittedWorkDone();
    }

    // The sprite-nineslice path should produce zero RhiError fires -- the
    // GPU buffers for HANDLE_NINESLICE_QUAD are resident (w12 step-3 upload),
    // the sprite UBO carries the 4-vec4 slot 3 (w11 helper), and the sprite
    // pipeline binds the same 12F vertex layout (D-2 reuse).
    expect(errors).toEqual([]);
  });
});
