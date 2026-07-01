// t51 (M3.5) -- dawn 4-pass IBL precompute readback (red-phase).
//
// Real GPU (dawn-node / webgpu native binding) test: feeds a 4x2 rgba16float
// all-ones equirect into uploadCubemapFromEquirect, then reads back one
// pixel from each of the 4 produced textures. All 4 pixels must be
// non-zero -- a zero readback means the GPU pass never ran (round-1
// counter-as-dispatch-proxy regression).
//
// Red phase: before t52/t53 wire real createIblPipelines + runIblPrecompute,
// the cubemap / irradiance / prefilter / brdfLut textures are created but
// never drawn into, so every readback pixel is vec4(0).
//
// Green phase: t52/t53 land 4 real render passes + queue.submit; readback
// pixels carry non-zero values (white equirect -> bright cube -> non-zero
// irradiance / prefilter / brdfLut).

import { World } from '@forgeax/engine-ecs';
import { composeShader } from '@forgeax/engine-naga';
import { ok } from '@forgeax/engine-rhi';
import type { EquirectAsset, TextureFormat } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { GpuResourceStore } from '../../gpu-resource-store';
import { getOrCreateIblCache, setIblComposedShaders } from '../../ibl/IblPipelineCache';

const mockCaps = {
  backendKind: 'webgpu' as const,
  compute: true,
  timestampQuery: false,
  indirectDrawing: false,
  textureCompression: false,
  multiDrawIndirect: false,
  pushConstants: false,
  textureBindingArray: false,
  samplerAliasing: false,
  firstInstanceIndirect: false,
  storageBuffer: true,
  storageTexture: false,
  rgba16floatRenderable: true,
  rg11b10ufloatRenderable: false,
  float32Filterable: false,
  maxColorAttachments: 8,
};

// feat-20260601-gpu-resource-store-extraction M1 (D-3 falsifiable anchor): a
// single store._uploadCubemapFromEquirect(world, srcHandle, srcPod) returns the
// cube handle, and store.getCubemapGpuTexture(cubeHandle) reads it back -- the
// single-call contract is preserved. The cube POD register-relay is injected
// at configureGpuDevice and mints via world.allocSharedRef (the store holds no
// registry reference, D-3).

// Load + compose the 6 ibl-* WGSL modules into the 4 composed entry shaders
// that createIblPipelines consumes. Mirrors what vite-plugin-shader does at
// build-time for the browser/runtime path; the dawn test stands in for
// vite-plugin-shader so the readback receives non-placeholder pipelines.
async function composeIblShadersForDawn(): Promise<void> {
  const fsId = 'node:fs';
  const pathId = 'node:path';
  const urlId = 'node:url';
  const fs = (await import(/* @vite-ignore */ fsId)) as {
    readFileSync: (p: string, enc: string) => string;
  };
  const pathMod = (await import(/* @vite-ignore */ pathId)) as {
    resolve: (...parts: string[]) => string;
    dirname: (p: string) => string;
  };
  const url = (await import(/* @vite-ignore */ urlId)) as {
    fileURLToPath: (u: string) => string;
  };
  const here = url.fileURLToPath(import.meta.url);
  // Resolve packages/shader/src/ relative to this test file
  // (packages/runtime/src/__tests__/dawn/).
  const shaderSrc = pathMod.resolve(pathMod.dirname(here), '..', '..', '..', '..', 'shader', 'src');
  const read = (name: string) => fs.readFileSync(pathMod.resolve(shaderSrc, name), 'utf8');
  const sharedSrc = read('ibl-shared.wgsl');
  const equirectSrc = read('ibl-equirect-to-cube.wgsl');
  const irradianceSrc = read('ibl-irradiance.wgsl');
  const prefilterSrc = read('ibl-prefilter.wgsl');
  const brdfLutSrc = read('ibl-brdf-lut.wgsl');
  // ibl-shared is the only #import the per-pass modules reference.
  const imports = { 'forgeax_pbr::ibl_shared': sharedSrc };
  const [equirectToCube, irradiance, prefilter, brdfLut] = await Promise.all([
    composeShader(equirectSrc, imports, {}),
    composeShader(irradianceSrc, imports, {}),
    composeShader(prefilterSrc, imports, {}),
    composeShader(brdfLutSrc, imports, {}),
  ]);
  setIblComposedShaders({ equirectToCube, irradiance, prefilter, brdfLut });
}

const dawnReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;

function makeWhiteEquirect(): EquirectAsset {
  // 4x2 rgba16float, all 1.0 (HDR white). 16-bit float 1.0 = 0x3C00 = 15360.
  const w = 4;
  const h = 2;
  const data = new Uint8Array(w * h * 8);
  const dv = new DataView(data.buffer);
  for (let i = 0; i < w * h * 4; i++) {
    dv.setUint16(i * 2, 0x3c00, true);
  }
  return {
    kind: 'equirect',
    width: w,
    height: h,
    format: 'rgba16float' as TextureFormat,
    data,
    colorSpace: 'linear',
  };
}

// biome-ignore lint/suspicious/noExplicitAny: native GPUDevice has minimal typing here
async function readbackRgba16f(device: any, texture: any, arrayLayer: number, mipLevel: number) {
  // Read one pixel from (0,0) of (face=arrayLayer, mip=mipLevel).
  const bytesPerRow = 256;
  const buffer = device.createBuffer({
    size: bytesPerRow,
    usage: 0x0001 | 0x0008, // MAP_READ | COPY_DST
  });
  const encoder = device.createCommandEncoder({ label: 'ibl-readback' });
  encoder.copyTextureToBuffer(
    { texture, mipLevel, origin: { x: 0, y: 0, z: arrayLayer } },
    { buffer, bytesPerRow },
    { width: 1, height: 1, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(0x0001 /* MAP_READ */);
  const range = buffer.getMappedRange();
  const dv = new DataView(range.slice(0));
  buffer.unmap();
  const f16ToF32 = (u16: number) => {
    const sign = (u16 & 0x8000) >> 15;
    const exp = (u16 & 0x7c00) >> 10;
    const frac = u16 & 0x03ff;
    if (exp === 0) return (sign ? -1 : 1) * 2 ** -14 * (frac / 1024);
    if (exp === 0x1f) return frac ? Number.NaN : (sign ? -1 : 1) * Number.POSITIVE_INFINITY;
    return (sign ? -1 : 1) * 2 ** (exp - 15) * (1 + frac / 1024);
  };
  return [
    f16ToF32(dv.getUint16(0, true)),
    f16ToF32(dv.getUint16(2, true)),
    f16ToF32(dv.getUint16(4, true)),
    f16ToF32(dv.getUint16(6, true)),
  ];
}

describe('t51 (M3.5) -- dawn IBL 4-pass non-zero readback', () => {
  it.skipIf(!dawnReady)(
    'AC-04/05/06: equirect / irradiance / prefilter / brdfLut readback pixels are non-zero',
    async () => {
      // Compose ibl-* WGSL into 4 entry shaders before the upload. In
      // production this happens at vite-plugin-shader build-time and the
      // runtime calls setIblComposedShaders with the composed bundle;
      // dawn-node tests stand in for vite-plugin-shader by composing on
      // demand via @forgeax/engine-naga.
      await composeIblShadersForDawn();
      // biome-ignore lint/suspicious/noExplicitAny: dynamic global navigator typed minimally
      const adapter = await (navigator as any).gpu.requestAdapter();
      const device = await adapter.requestDevice();

      const store = new GpuResourceStore();
      const world = new World();
      const equirect = makeWhiteEquirect();
      const equirectHandle = world.allocSharedRef('EquirectAsset', equirect);

      // We pass the raw GPUDevice directly so the runtime exercises the
      // same dawn path that user-mesh-upload.dawn.test.ts uses. The cube POD
      // register-relay is injected here (D-3).
      store.configureGpuDevice(
        // biome-ignore lint/suspicious/noExplicitAny: dawn device shape
        device as any,
        // biome-ignore lint/suspicious/noExplicitAny: dawn device shape
        async (d: any, desc: { code: string; label?: string }) => {
          const mod = d.createShaderModule({ code: desc.code, label: desc.label });
          // biome-ignore lint/suspicious/noExplicitAny: matching shim Result shape
          return { ok: true, value: mod, unwrap: () => mod, unwrapOr: () => mod } as any;
        },
        (w: World, pod: EquirectAsset) => ok(w.allocSharedRef('EquirectAsset', pod)),
        mockCaps,
      );

      // Single call returns the cube handle (D-3 single-call contract). The
      // projection method is @internal (private) after feat-20260630 M2 / w11;
      // the dawn test reaches it through the store internals.
      // biome-ignore lint/suspicious/noExplicitAny: private method access for the dawn IBL readback probe
      const result = await (store as any)._uploadCubemapFromEquirect(
        world,
        equirectHandle,
        equirect,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const cubeHandle = result.value;
      // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture
      const cubeTexture = store.getCubemapGpuTexture(cubeHandle as any);
      expect(cubeTexture).toBeDefined();

      // feat-20260612 M3 / w11 (1c76c1b9): GpuResourceStore handle maps now
      // hold the GpuTexture wrapper (`{handle, isDestroyed, destroy()}`).
      // dawn-node `copyTextureToBuffer` consumes the raw GPUTexture handle,
      // so the wrapper unwrap goes via `.handle` here. The IBL cache slots
      // below still hold raw textures (the ibl/IblPipelineCache wrapping is
      // OOS for this feat -- D-8 / OOS-10).
      // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture
      const cubeRaw = (cubeTexture as any).handle;

      // (a) equirect-to-cube face 0 center pixel != 0
      const cubePx = await readbackRgba16f(device, cubeRaw, 0, 0);
      expect(cubePx.some((c) => c !== 0)).toBe(true);

      // (b) irradiance, (c) prefilter, (d) brdfLut: the textures live on
      // IblPipelineCache after t52/t53. Read via cache slots.
      const cache = getOrCreateIblCache(device);
      // biome-ignore lint/suspicious/noExplicitAny: cache slots typed any
      const irrTex = (cache as any).irradianceTexture;
      // biome-ignore lint/suspicious/noExplicitAny: cache slots typed any
      const prefTex = (cache as any).prefilterTexture;
      // biome-ignore lint/suspicious/noExplicitAny: cache slots typed any
      const brdfTex = (cache as any).brdfLutTexture;
      expect(irrTex).toBeDefined();
      expect(prefTex).toBeDefined();
      expect(brdfTex).toBeDefined();

      const irrPx = await readbackRgba16f(device, irrTex, 0, 0);
      expect(irrPx.some((c) => c !== 0)).toBe(true);

      const prefPx = await readbackRgba16f(device, prefTex, 0, 0);
      expect(prefPx.some((c) => c !== 0)).toBe(true);

      const brdfPx = await readbackRgba16f(device, brdfTex, 0, 0);
      expect(brdfPx.some((c) => c !== 0)).toBe(true);
    },
    60_000,
  );
});
