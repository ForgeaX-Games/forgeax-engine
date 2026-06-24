// feat-20260623-world-space-video-asset M4 / w12 — AC-08: static texture
// cache regression.
//
// AC-08 (requirements.md): video per-frame upload must NOT enter the
// GpuResourceStore.ensureResident permanent-cache path. The video frame is a
// transient resource (re-uploaded every frame), the antithesis of the
// "upload once / cache forever" semantics ensureResident implements. The M4
// design (plan-strategy D-3) routes video through a separate DynamicTextureStore
// and leaves ensureResident untouched (the cube-texture eager path is the
// precedent: it also never enters the ensureResident switch).
//
// Two regression anchors:
//   1. structural — ensureResident's `switch (pod.kind)` keeps exactly two arms
//      (`mesh` + `texture`) and gains NO `case 'video'`. The switch has no
//      `default`, so a video arm would be the only way video could pollute the
//      cache; this source-level scan fails fast if a later edit adds one.
//   2. behavioral — a static TextureAsset still resolves through ensureResident
//      with cache-hit semantics: the second ensureResident for the same handle
//      reuses the GPU texture (no second createTexture) and returns the same
//      cached view. This proves the M4 video work did not perturb the static
//      texture cache.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SharedRefStore } from '@forgeax/engine-ecs';
import type { Result, RhiCaps } from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import type { CubeTextureAsset, Handle, TextureAsset } from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

import { GpuResourceStore } from '../gpu-resource-store';

const STORE_SRC = fileURLToPath(new URL('../gpu-resource-store.ts', import.meta.url));

function texturePodFixture(): TextureAsset {
  return {
    kind: 'texture',
    width: 2,
    height: 2,
    format: 'rgba8unorm-srgb',
    data: new Uint8Array(2 * 2 * 4).fill(188),
    colorSpace: 'srgb',
    mipmap: false,
  };
}

interface CreateProbe {
  textures: number;
  views: number;
}

// biome-ignore lint/suspicious/noExplicitAny: opaque mock GPU device surface
function makeMockDevice(probe: CreateProbe): any {
  const okShim = <T>(v: T) => ({ ok: true as const, value: v });
  return {
    createShaderModule: () => okShim({ __mock: 'shader' }),
    createSampler: () => okShim({ __mock: 'sampler' }),
    createBindGroupLayout: () => okShim({ __mock: 'bgl' }),
    createPipelineLayout: () => okShim({ __mock: 'layout' }),
    createRenderPipeline: () => okShim({ __mock: 'pipeline' }),
    createBindGroup: () => okShim({ __mock: 'bindGroup' }),
    createBuffer: (desc: { size?: number }) => okShim({ __mock: 'buffer', size: desc.size ?? 0 }),
    createTexture: () => {
      probe.textures += 1;
      return okShim({ __mock: `texture-${probe.textures}` });
    },
    createTextureView: () => {
      probe.views += 1;
      return okShim({ __mock: `view-${probe.views}` });
    },
    destroyBuffer: (): Result<void, RhiError> => ok(undefined),
    destroyTexture: (): Result<void, RhiError> => ok(undefined),
    queue: {
      writeBuffer: () => okShim(undefined),
      writeTexture: () => okShim(undefined),
      submit: () => okShim(undefined),
    },
  };
}

const mockCaps: RhiCaps = {
  backendKind: 'webgpu',
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

function makeRegisterCube(): (
  pod: CubeTextureAsset,
) => Result<Handle<'CubeTextureAsset', 'shared'>, never> {
  let next = 1000;
  return () => ok(toShared<'CubeTextureAsset'>(next++));
}

// biome-ignore lint/suspicious/noExplicitAny: shader-module factory shim
const shaderFactory = async (_d: any, desc: { code: string; label?: string }) =>
  ok({ __mock: 'shader', label: desc.label ?? '' }) as never;

function configuredStore(probe: CreateProbe): GpuResourceStore {
  const store = new GpuResourceStore();
  store.configureGpuDevice(
    makeMockDevice(probe),
    shaderFactory,
    makeRegisterCube() as never,
    mockCaps,
  );
  return store;
}

describe('AC-08 — ensureResident switch stays 2-arm (no video) (M4 / w12)', () => {
  it('ensureResident has exactly the mesh + texture case arms and no `case "video"`', () => {
    const src = readFileSync(STORE_SRC, 'utf8');
    // Locate the ensureResident body and isolate its `switch (pod.kind)`.
    const fnIdx = src.indexOf('ensureResident(');
    expect(fnIdx, 'ensureResident not found in gpu-resource-store.ts').toBeGreaterThan(-1);
    const switchIdx = src.indexOf('switch (pod.kind)', fnIdx);
    expect(switchIdx, 'switch (pod.kind) not found in ensureResident').toBeGreaterThan(-1);
    // Scan from the switch to the next top-level method boundary (the
    // uploadTexture jsdoc) so we only inspect ensureResident's switch.
    const switchEnd = src.indexOf('async uploadTexture', switchIdx);
    expect(switchEnd).toBeGreaterThan(switchIdx);
    const switchBody = src.slice(switchIdx, switchEnd);

    const caseArms = [...switchBody.matchAll(/case\s+'([a-z-]+)'\s*:/g)].map((m) => m[1]);
    expect(caseArms).toEqual(['mesh', 'texture']);
    expect(switchBody.includes("case 'video'")).toBe(false);
    // No `default:` arm — exhaustiveness is enforced by tsc-b, so a third
    // reachable kind (video) would be a compile error, never a silent cache
    // poison. Assert the absence so a later `default` does not mask it.
    expect(/\bdefault\s*:/.test(switchBody)).toBe(false);
  });
});

describe('AC-08 — static texture cache-hit behavior unchanged (M4 / w12)', () => {
  it('second ensureResident for the same texture handle reuses the GPU texture (cache hit)', () => {
    const probe: CreateProbe = { textures: 0, views: 0 };
    const store = configuredStore(probe);
    const handle = toShared<'TextureAsset'>(4096);

    const first = store.ensureResident(handle, texturePodFixture());
    expect(first.ok).toBe(true);
    const firstView = store.getTextureGpuView(handle);
    expect(firstView).toBeDefined();
    const texturesAfterFirst = probe.textures;
    expect(texturesAfterFirst).toBeGreaterThan(0);

    // Second call: cache hit — no new GPU texture is created, same view returned.
    const second = store.ensureResident(handle, texturePodFixture());
    expect(second.ok).toBe(true);
    expect(probe.textures).toBe(texturesAfterFirst);
    expect(store.getTextureGpuView(handle)).toBe(firstView);
  });

  it('a fresh handle does NOT hit the cache (distinct texture allocation)', () => {
    const probe: CreateProbe = { textures: 0, views: 0 };
    const store = configuredStore(probe);

    expect(store.ensureResident(toShared<'TextureAsset'>(5001), texturePodFixture()).ok).toBe(true);
    const afterOne = probe.textures;
    expect(store.ensureResident(toShared<'TextureAsset'>(5002), texturePodFixture()).ok).toBe(true);
    expect(probe.textures).toBeGreaterThan(afterOne);
  });

  // Anchor the imports actually exercised so the regression test fails to
  // typecheck (not silently no-op) if the store/RHI surfaces shift shape.
  it('SharedRefStore + RhiError surfaces import cleanly (compile anchor)', () => {
    expect(typeof SharedRefStore).toBe('function');
    const e = new RhiError({ code: 'feature-not-enabled', expected: 'x', hint: 'y' });
    expect(e).toBeInstanceOf(RhiError);
    expect(err(e).ok).toBe(false);
  });
});
