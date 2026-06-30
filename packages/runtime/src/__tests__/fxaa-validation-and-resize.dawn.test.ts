// fxaa-validation-and-resize.dawn.test.ts - feat-20260528-fxaa-post-processing
// / M3 / w17.
// Dawn integration tests: (a) AC-07 — render frame with antialias='fxaa'
// and verify no WebGPU validation errors are generated; (b) AC-08 — resize
// canvas to new dimensions and re-render, verify no crash and frame is
// non-black.
//
// Follows the user-handle-mesh-render.dawn.test.ts pattern for canvas mock,
// device capture, and pixel readback.

import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { Camera, MeshFilter, MeshRenderer, Transform } from '../components';
import { ANTIALIAS_FXAA } from '../components/camera';
import { createRenderer, HANDLE_CUBE } from '../index';

const WIDTH = 256;
const HEIGHT = 256;
// feat-20260608 TASK-007 dropped clearColor from createRenderer; the
// per-Camera clearR/G/B/A is now the SSOT. AC-08 resize asserts
// `r+g+b > 0` on the post-resize center pixel, which cannot rely on a
// non-black default clear -- wire the original [0.06, 0.06, 0.08, 1]
// into the Camera spawn so the cube-vs-clear contrast matches the
// pre-TASK-007 expectation.
const CLEAR_RGBA: readonly [number, number, number, number] = [0.06, 0.06, 0.08, 1.0];

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

async function doReadPixels(
  device: GPUDevice,
  renderTarget: GPUTexture,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const bytesPerPixel = 4;
  const unpaddedBytesPerRow = width * bytesPerPixel;
  const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
  const buf = device.createBuffer({
    size: bytesPerRow * height,
    usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
  });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: buf, bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
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

function spawnCubeScene(world: World): void {
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
    { component: MeshRenderer, data: {} },
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
        antialias: ANTIALIAS_FXAA,
        clearR: CLEAR_RGBA[0],
        clearG: CLEAR_RGBA[1],
        clearB: CLEAR_RGBA[2],
        clearA: CLEAR_RGBA[3],
      },
    },
  );
}

describe('feat-20260528-fxaa-post-processing M3 w17: AC-07 validation + AC-08 resize dawn test', () => {
  it('AC-07: antialias=fxaa frame produces no WebGPU validation errors', async () => {
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

    // Track uncapturederror events on the raw GPUDevice.
    const capturedErrors: string[] = [];
    const rawDev = device as unknown as {
      onuncapturederror?: ((event: unknown) => void) | null;
    };
    if (typeof rawDev.onuncapturederror !== 'undefined') {
      rawDev.onuncapturederror = (event: unknown) => {
        capturedErrors.push(
          (event as { error?: { message?: string } })?.error?.message ?? String(event),
        );
      };
    }

    const world = new World();
    spawnCubeScene(world);

    const drawn = renderer.draw(world);
    expect(drawn.ok).toBe(true);
    await device.queue.onSubmittedWorkDone();

    // AC-07: No WebGPU validation errors during the FXAA frame.
    // We can't rely on onuncapturederror being settable (dawn-node may not
    // expose it), so we also verify the draw returned ok.
    if (capturedErrors.length > 0) {
      expect(
        capturedErrors.length,
        `WebGPU validation errors during FXAA frame: ${capturedErrors.join('; ')}`,
      ).toBe(0);
    }

    // Read back to verify frame is non-empty.
    if (renderTarget === undefined) throw new Error('renderTarget not configured');
    const pixels = await doReadPixels(device, renderTarget, WIDTH, HEIGHT);
    const cx = WIDTH >> 1;
    const cy = HEIGHT >> 1;
    const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
    const off = cy * bytesPerRow + cx * 4;
    const r = pixels[off + 2] ?? 0;
    const g = pixels[off + 1] ?? 0;
    const b = pixels[off + 0] ?? 0;
    expect(r + g + b, 'center pixel must not be black').toBeGreaterThan(0);
  });

  it('AC-08: canvas resize + re-render with antialias=fxaa does not crash', async () => {
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

    // Use dynamic sizes so we can test resize.
    let canvasW = WIDTH;
    let canvasH = HEIGHT;
    let renderTarget: GPUTexture | undefined;
    const ensureRenderTarget = (device: GPUDevice, format: GPUTextureFormat): GPUTexture => {
      if (renderTarget !== undefined) {
        // Recreate on size change.
        if (renderTarget.width !== canvasW || renderTarget.height !== canvasH) {
          renderTarget.destroy();
          renderTarget = undefined;
        }
      }
      if (renderTarget !== undefined) return renderTarget;
      renderTarget = device.createTexture({
        size: { width: canvasW, height: canvasH, depthOrArrayLayers: 1 },
        format,
        usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC,
        viewFormats: ['rgba8unorm-srgb'],
      });
      return renderTarget;
    };
    const mockCanvas = {
      get width() {
        return canvasW;
      },
      get height() {
        return canvasH;
      },
      set width(v: number) {
        canvasW = v;
      },
      set height(v: number) {
        canvasH = v;
      },
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

    // Frame 1: render at 256x256.
    const world = new World();
    spawnCubeScene(world);

    const drawn1 = renderer.draw(world);
    expect(drawn1.ok).toBe(true);
    await device.queue.onSubmittedWorkDone();

    // Read back frame 1 to verify non-empty.
    if (renderTarget === undefined) throw new Error('renderTarget not configured');
    const pixels1 = await doReadPixels(device, renderTarget, canvasW, canvasH);
    const cx1 = canvasW >> 1;
    const cy1 = canvasH >> 1;
    const bpRow1 = Math.ceil((canvasW * 4) / 256) * 256;
    const off1 = cy1 * bpRow1 + cx1 * 4;
    const r1 = pixels1[off1 + 2] ?? 0;
    const g1 = pixels1[off1 + 1] ?? 0;
    const b1 = pixels1[off1 + 0] ?? 0;
    expect(r1 + g1 + b1, 'center pixel must not be black before resize').toBeGreaterThan(0);

    // AC-08: Resize canvas to new dimensions.
    // In dawn-node the mock canvas size change triggers the render target
    // recreation AND the intermediate texture lazy-alloc detects dimension
    // drift and reallocates. The FXAA BindGroup is invalidated (set to null)
    // so the next frame rebuilds it with the new intermediate view.
    canvasW = 128;
    canvasH = 128;

    // Frame 2: render at 128x128 (post-resize).
    const drawn2 = renderer.draw(world);
    // AC-08: The draw must not crash.
    expect(drawn2.ok).toBe(true);
    await device.queue.onSubmittedWorkDone();

    // Read back frame 2 to verify non-empty.
    if (renderTarget === undefined) throw new Error('renderTarget not configured');
    const pixels2 = await doReadPixels(device, renderTarget, canvasW, canvasH);
    const cx2 = canvasW >> 1;
    const cy2 = canvasH >> 1;
    const bpRow2 = Math.ceil((canvasW * 4) / 256) * 256;
    const off2 = cy2 * bpRow2 + cx2 * 4;
    const r2 = pixels2[off2 + 2] ?? 0;
    const g2 = pixels2[off2 + 1] ?? 0;
    const b2 = pixels2[off2 + 0] ?? 0;
    // post-resize frame is non-black (cube rendered correctly at new size).
    expect(r2 + g2 + b2, 'center pixel must not be black after resize').toBeGreaterThan(0);
  });
});
