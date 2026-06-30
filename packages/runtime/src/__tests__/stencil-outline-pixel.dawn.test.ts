// stencil-outline-pixel.dawn.test.ts -- bug-20260611-stencil-testing-outline-regression.
//
// Regression tripwire for PR #344 (pipeline-driven pass selector + ShadowCaster
// via material tags). Before #344 the URP main scene pass had no selector so
// every material pass was drawn; #344 added selector `{LightMode:['Forward']}`
// and silently filtered out passes whose tags did not match. The LO 4.2
// stencil-testing demo carried `LightMode:'ForwardOutline'` on its outline
// pass and the entire outline disappeared without warning. The frame still
// rendered visible cubes, so the existing dawn smoke greenlit the regression.
//
// This test reproduces the exact rendering recipe in a controlled scene:
//   - cube at origin with PBR Forward pass that writes stencil ref=1
//   - scaled-1.1 cube at origin with custom unlit shader, stencil compare
//     not-equal ref=1, depthWriteEnabled=false, queue Geometry+1
//   - assert >= 100 cyan-green pixels in the readback (LO 4.2 outline color
//     0.04 / 0.28 / 0.26 has the unique signature G > R + 0.05 && B > R + 0.03;
//     the rest of the frame is clearColor + lit cube, both grayscale-ish)
//
// Falsifiable: change the outline pass tags to `LightMode:'ForwardOutline'`
// (the bug shape) -> URP main pass selector drops the pass -> 0 cyan-green
// pixels -> red. Equally, deleting the outline material's stencil compare
// or the cube's stencilWriteMask=0xFF removes the outline band the same way.
//
// Boilerplate (canvas mock + device capture + pixel readback) follows
// fxaa-pixel-diff.dawn.test.ts. The outline material uses the engine
// builtin `forgeax::default-unlit` shader -- baseColor passes through
// without lighting, giving the LO 4.2 cyan-green tint regardless of
// lighting setup, and the test scene needs no DirectionalLight.

import { World } from '@forgeax/engine-ecs';
import type { MaterialAsset } from '@forgeax/engine-types';
import { RenderQueue } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { Camera, MeshFilter, MeshRenderer, Transform } from '../components';
import { createRenderer, HANDLE_CUBE } from '../index';

const WIDTH = 256;
const HEIGHT = 256;

const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;

const OUTLINE_COLOR: readonly [number, number, number, number] = [0.04, 0.28, 0.26, 1.0];
const OUTLINE_R_LT_G_GAP = 0.05;
const OUTLINE_R_LT_B_GAP = 0.03;
const OUTLINE_MIN_PIXELS = 100;

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

function countOutlinePixels(bytes: Uint8Array): { outline: number; nonZero: number } {
  const bytesPerPixel = 4;
  const bytesPerRow = Math.ceil((WIDTH * bytesPerPixel) / 256) * 256;
  let outline = 0;
  let nonZero = 0;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const off = y * bytesPerRow + x * bytesPerPixel;
      // bug-20260610: swap-chain unified to rgba8unorm — byte order is R, G, B, A.
      const r = (bytes[off + 0] ?? 0) / 255;
      const g = (bytes[off + 1] ?? 0) / 255;
      const b = (bytes[off + 2] ?? 0) / 255;
      if (r > 0 || g > 0 || b > 0) nonZero++;
      if (g - r > OUTLINE_R_LT_G_GAP && b - r > OUTLINE_R_LT_B_GAP) outline++;
    }
  }
  return { outline, nonZero };
}

describe('bug-20260611 stencil-outline pixel-presence (dawn)', () => {
  it('outline pass produces cyan-green pixels (LO 4.2 outline color signature)', async () => {
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
    if (assets === null) throw new Error('renderer.assets is null');

    const world = new World();

    // Cube material (writes stencil ref=1). Use unlit grayscale so the
    // cube body never produces G/B>R pixels and cannot be confused with
    // the outline pass under the assertion's color signature.
    const cubeMatHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          shader: 'forgeax::default-unlit',
          tags: { LightMode: 'Forward' },
          queue: RenderQueue.Geometry as number,
          renderState: {
            stencilWriteMask: 0xff,
            stencil: { compare: 'always', passOp: 'replace' },
          },
          stencilReference: 1,
        },
      ],
      paramValues: {
        baseColor: [0.5, 0.5, 0.5, 1.0],
      },
    } as MaterialAsset);

    // Outline material (stencil-test only, unlit cyan-green).
    // Tag MUST be LightMode='Forward' to be picked by URP main pass selector;
    // pre-fix the demo set 'ForwardOutline' which silently dropped the pass.
    const outlineMatHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
      kind: 'material',
      passes: [
        {
          name: 'ForwardOutline',
          shader: 'forgeax::default-unlit',
          tags: { LightMode: 'Forward' },
          queue: (RenderQueue.Geometry as number) + 1,
          renderState: {
            stencilReadMask: 0xff,
            stencil: { compare: 'not-equal' },
            depthWriteEnabled: false,
          },
          stencilReference: 1,
        },
      ],
      paramValues: {
        baseColor: OUTLINE_COLOR as readonly number[],
      },
    } as MaterialAsset);

    // Cube at origin.
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
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [cubeMatHandle] } },
    );

    // Outline cube at origin, scale 1.1.
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
          scaleX: 1.1,
          scaleY: 1.1,
          scaleZ: 1.1,
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [outlineMatHandle] } },
    );

    // Camera at z=3 looking at origin.
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
          aspect: WIDTH / HEIGHT,
          near: 0.1,
          far: 100,
        } as Record<string, unknown> as never,
      },
    );

    world.update();
    const drawn = renderer.draw(world);
    expect(drawn.ok).toBe(true);
    await device.queue.onSubmittedWorkDone();
    if (renderTarget === undefined) throw new Error('renderTarget not configured');

    const pixels = await doReadPixels(device, renderTarget);
    const { outline, nonZero } = countOutlinePixels(pixels);

    expect(
      outline,
      `cyan-green pixels (G-R>${OUTLINE_R_LT_G_GAP} && B-R>${OUTLINE_R_LT_B_GAP}); nonZero=${nonZero}/${WIDTH * HEIGHT}`,
    ).toBeGreaterThanOrEqual(OUTLINE_MIN_PIXELS);
  });
});
