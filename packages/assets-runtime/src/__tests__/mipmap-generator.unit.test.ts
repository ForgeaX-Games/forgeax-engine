// @forgeax/engine-assets-runtime -- mipmap-generator coverage (fix issue #709).
// numMipLevels formula + per-device pipeline cache + generateMipmaps (async
// build) + blitMipmapsSync (prewarmed) exercised against an in-memory device
// stub (no real GPU). Mirrors the runtime-project mipmap tests, but imports the
// relative `../mipmap-generator` so coverage attributes to src/, not dist/.

import { ok as rhiOk } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import {
  blitMipmapsSync,
  generateMipmaps,
  getOrCreateMipmapPipeline,
  type MipmapBlitDevice,
  type MipmapShaderModuleFactory,
  mipmapCacheSize,
  numMipLevels,
} from '../mipmap-generator';

let nextId = 0;
// The device-surface shims are loosely typed (`any` descriptors) so a plain
// { ok, value } POD satisfies them; the shader factory returns a real Result.
function ok<T>(value: T) {
  return { ok: true as const, value };
}

function makeBlitDevice(): MipmapBlitDevice {
  const pass = {
    setPipeline: () => {},
    setBindGroup: () => {},
    draw: () => {},
    end: () => {},
  };
  const encoder = {
    beginRenderPass: () => pass,
    finish: () => ok({ tag: `cmdbuf-${nextId++}` }),
  };
  return {
    createSampler: () => ok({ tag: `sampler-${nextId++}` }),
    createBindGroupLayout: () => ok({ tag: `bgl-${nextId++}` }),
    createPipelineLayout: () => ok({ tag: `pl-${nextId++}` }),
    createRenderPipeline: (desc: { fragment?: { targets?: ReadonlyArray<{ format?: string }> } }) =>
      ok({ tag: `pipeline-${nextId++}`, format: desc.fragment?.targets?.[0]?.format }),
    createTexture: () => ok({ tag: `tex-${nextId++}` }),
    createBindGroup: () => ok({ tag: `bg-${nextId++}` }),
    createTextureView: () => ok({ tag: `view-${nextId++}` }),
    createCommandEncoder: () => ok(encoder),
    queue: { submit: () => ok(undefined) },
  } as unknown as MipmapBlitDevice;
}

const stubShaderFactory: MipmapShaderModuleFactory = async () =>
  rhiOk({ tag: `shader-${nextId++}` } as unknown);

describe('numMipLevels', () => {
  it('256x256 -> 9', () => expect(numMipLevels({ width: 256, height: 256 })).toBe(9));
  it('1x1 -> 1', () => expect(numMipLevels({ width: 1, height: 1 })).toBe(1));
  it('0x0 -> 1 (max<=1 guard)', () => expect(numMipLevels({ width: 0, height: 0 })).toBe(1));
  it('non-square 300x200 -> 9', () => expect(numMipLevels({ width: 300, height: 200 })).toBe(9));
  it('17x5 -> 5', () => expect(numMipLevels({ width: 17, height: 5 })).toBe(5));
});

describe('getOrCreateMipmapPipeline + mipmapCacheSize', () => {
  it('fresh device starts at cache size 0', () => {
    expect(mipmapCacheSize(makeBlitDevice())).toBe(0);
  });

  it('same format twice -> cache hit (identical pipeline, size 1)', async () => {
    const device = makeBlitDevice();
    const a = await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory);
    const b = await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value).toBe(b.value);
    expect(mipmapCacheSize(device)).toBe(1);
  });

  it('different formats -> separate slots (size 2)', async () => {
    const device = makeBlitDevice();
    await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory);
    await getOrCreateMipmapPipeline(device, 'rgba8unorm-srgb', stubShaderFactory);
    expect(mipmapCacheSize(device)).toBe(2);
  });

  it('two devices keep independent caches', async () => {
    const d1 = makeBlitDevice();
    const d2 = makeBlitDevice();
    const r1 = await getOrCreateMipmapPipeline(d1, 'rgba8unorm', stubShaderFactory);
    const r2 = await getOrCreateMipmapPipeline(d2, 'rgba8unorm', stubShaderFactory);
    if (!r1.ok || !r2.ok) throw new Error('expected ok');
    expect(r1.value).not.toBe(r2.value);
  });

  it('propagates a shader-module factory failure', async () => {
    const device = makeBlitDevice();
    const failing: MipmapShaderModuleFactory = async () =>
      ({ ok: false, error: { code: 'x' } }) as never;
    const res = await getOrCreateMipmapPipeline(device, 'rgba8unorm', failing);
    expect(res.ok).toBe(false);
  });
});

describe('generateMipmaps (async build path)', () => {
  it('returns ok immediately when levels <= 1', async () => {
    const device = makeBlitDevice();
    const res = await generateMipmaps(
      device,
      {},
      { format: 'rgba8unorm', width: 1, height: 1 },
      stubShaderFactory,
    );
    expect(res.ok).toBe(true);
    expect(mipmapCacheSize(device)).toBe(0); // never built a pipeline
  });

  it('builds + blits the full mip chain for a 4x4 texture', async () => {
    const device = makeBlitDevice();
    const res = await generateMipmaps(
      device,
      { tag: 'tex' },
      { format: 'rgba8unorm', width: 4, height: 4 },
      stubShaderFactory,
    );
    expect(res.ok).toBe(true);
    expect(mipmapCacheSize(device)).toBe(1);
  });
});

describe('blitMipmapsSync (prewarmed path)', () => {
  it('returns ok immediately when levels <= 1', () => {
    const res = blitMipmapsSync(
      makeBlitDevice(),
      {},
      { format: 'rgba8unorm', width: 1, height: 1 },
    );
    expect(res.ok).toBe(true);
  });

  it('errors when the device cache was never prewarmed', () => {
    const res = blitMipmapsSync(
      makeBlitDevice(),
      {},
      { format: 'rgba8unorm', width: 4, height: 4 },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('rhi-not-available');
  });

  it('errors when the requested format was not prewarmed', async () => {
    const device = makeBlitDevice();
    await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory);
    const res = blitMipmapsSync(device, {}, { format: 'bgra8unorm', width: 4, height: 4 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('rhi-not-available');
  });

  it('blits the full chain once the format is prewarmed', async () => {
    const device = makeBlitDevice();
    await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory);
    const res = blitMipmapsSync(
      device,
      { tag: 'tex' },
      { format: 'rgba8unorm', width: 8, height: 8 },
    );
    expect(res.ok).toBe(true);
  });
});
