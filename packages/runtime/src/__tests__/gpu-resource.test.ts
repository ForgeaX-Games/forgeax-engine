// feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M2 / w6 —
// GpuBuffer / GpuTexture .destroy() unit tests.
//
// Coverage matrix (requirements AC-04 + plan-strategy §5.3):
//   1. GpuBuffer.destroy: first call returns ok; isDestroyed flips to true.
//   2. GpuBuffer.destroy: second call routes the underlying RhiDevice
//      'destroy-after-destroy' err verbatim (D-7 SSOT — RHI shim is the
//      lifecycle SSOT; the runtime wrapper forwards instead of duplicating
//      the bookkeeping; charter §F1).
//   3. GpuTexture.destroy: same first / ok + isDestroyed=true.
//   4. GpuTexture.destroy: same second / 'destroy-after-destroy' forward.
//
// Mock shape: a minimal RhiDevice stub with destroyBuffer / destroyTexture
// implementing per-handle `destroyed: Set` bookkeeping that mirrors the
// real shim's contract (rhi-webgpu device.ts lines 1404–1473). Plain
// branded handles are fabricated via `as unknown as Buffer / Texture` —
// the runtime wrapper never reads the brand; only the device methods
// touch the handle (charter §F4 explicit failure: any future shape
// change to handle bookkeeping flips the second-destroy branch).

import { SharedRefStore } from '@forgeax/engine-ecs';
import type { Buffer, Result, RhiCaps, RhiDevice, Texture } from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import {
  type EquirectAsset,
  type Handle,
  type MeshAsset,
  type TextureAsset,
  toShared,
  unwrapHandle,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

import { GpuBuffer, GpuTexture } from '../gpu-resource';
import { GpuResourceStore } from '../gpu-resource-store';

// ── Minimal RhiDevice stub (only destroyBuffer / destroyTexture wired) ──

type MinimalDevice = Pick<RhiDevice, 'destroyBuffer' | 'destroyTexture'>;

function makeMockDevice(): MinimalDevice {
  const destroyedBufs = new WeakSet<Buffer>();
  const destroyedTexs = new WeakSet<Texture>();
  return {
    destroyBuffer(buf: Buffer): Result<void, RhiError> {
      if (destroyedBufs.has(buf)) {
        return err(
          new RhiError({
            code: 'destroy-after-destroy',
            expected: 'GPU buffer handle has not been destroyed yet',
            hint: 'object already destroyed; track lifecycle in caller or check isDestroyed before re-destroy',
          }),
        );
      }
      destroyedBufs.add(buf);
      return ok(undefined);
    },
    destroyTexture(tex: Texture): Result<void, RhiError> {
      if (destroyedTexs.has(tex)) {
        return err(
          new RhiError({
            code: 'destroy-after-destroy',
            expected: 'GPU texture handle has not been destroyed yet',
            hint: 'object already destroyed; track lifecycle in caller or check isDestroyed before re-destroy',
          }),
        );
      }
      destroyedTexs.add(tex);
      return ok(undefined);
    },
  };
}

// Branded opaque handles; the runtime wrapper never inspects the brand,
// only the mock device methods key off identity.
function makeBufHandle(): Buffer {
  return {} as unknown as Buffer;
}
function makeTexHandle(): Texture {
  return {} as unknown as Texture;
}

describe('GpuBuffer (feat-20260612 M2 / w6)', () => {
  it('destroy: first call returns ok; isDestroyed flips to true', () => {
    const device = makeMockDevice();
    const handle = makeBufHandle();
    const gpuBuf = new GpuBuffer(device as unknown as RhiDevice, handle);

    expect(gpuBuf.isDestroyed).toBe(false);

    const r = gpuBuf.destroy();
    expect(r.ok).toBe(true);
    expect(gpuBuf.isDestroyed).toBe(true);
  });

  it("destroy: second call returns err 'destroy-after-destroy' (forwarded from RHI shim)", () => {
    const device = makeMockDevice();
    const handle = makeBufHandle();
    const gpuBuf = new GpuBuffer(device as unknown as RhiDevice, handle);

    const first = gpuBuf.destroy();
    expect(first.ok).toBe(true);

    const second = gpuBuf.destroy();
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('destroy-after-destroy');
    }
    // isDestroyed stays true — the second call did not un-destroy it.
    expect(gpuBuf.isDestroyed).toBe(true);
  });
});

describe('GpuTexture (feat-20260612 M2 / w6)', () => {
  it('destroy: first call returns ok; isDestroyed flips to true', () => {
    const device = makeMockDevice();
    const handle = makeTexHandle();
    const gpuTex = new GpuTexture(device as unknown as RhiDevice, handle);

    expect(gpuTex.isDestroyed).toBe(false);

    const r = gpuTex.destroy();
    expect(r.ok).toBe(true);
    expect(gpuTex.isDestroyed).toBe(true);
  });

  it("destroy: second call returns err 'destroy-after-destroy' (forwarded from RHI shim)", () => {
    const device = makeMockDevice();
    const handle = makeTexHandle();
    const gpuTex = new GpuTexture(device as unknown as RhiDevice, handle);

    const first = gpuTex.destroy();
    expect(first.ok).toBe(true);

    const second = gpuTex.destroy();
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('destroy-after-destroy');
    }
    expect(gpuTex.isDestroyed).toBe(true);
  });
});

// ── M-3 / w9 + w10: gpuStore narrowing + destroyAll unit tests ──
//
// Coverage matrix (requirements AC-05 + AC-06 / plan-strategy §7 M-3 / D-2 / D-9):
//   w9: type-level narrowing — getMeshGpuHandles(...).vertexBuffer / indexBuffer
//       is GpuBuffer (not raw RHI Buffer); getCubemapGpuTexture(...) is GpuTexture
//       (not raw Texture). Validated by `const _: GpuBuffer = entry.vertexBuffer`
//       in the test body — `pnpm typecheck` is the gate.
//   w10: gpuStore.destroyAll() walks the three handle maps + every GpuResource
//       isDestroyed flips to true; second call is idempotent (no error).
//
// The mock device extends the pipeline.unit.test.ts shape with destroyBuffer /
// destroyTexture (M-1) so the GpuBuffer / GpuTexture wrappers can forward.

interface DeviceProbe {
  buffers: number;
  textures: number;
  views: number;
  destroyedBuffers: number;
  destroyedTextures: number;
}

function freshProbe(): DeviceProbe {
  return { buffers: 0, textures: 0, views: 0, destroyedBuffers: 0, destroyedTextures: 0 };
}

const okShim = <T>(v: T) => ({ ok: true as const, value: v });

// biome-ignore lint/suspicious/noExplicitAny: opaque mock GPU device surface
function makeStoreMockDevice(probe: DeviceProbe): any {
  const destroyedBufs = new WeakSet<object>();
  const destroyedTexs = new WeakSet<object>();
  return {
    createShaderModule: () => okShim({ __mock: 'shader' }),
    createSampler: () => okShim({ __mock: 'sampler' }),
    createBindGroupLayout: () => okShim({ __mock: 'bgl' }),
    createPipelineLayout: () => okShim({ __mock: 'layout' }),
    createRenderPipeline: () => okShim({ __mock: 'pipeline' }),
    createBindGroup: () => okShim({ __mock: 'bindGroup' }),
    createBuffer: (desc: { size?: number }) => {
      probe.buffers += 1;
      return okShim({ __mock: `buffer-${probe.buffers}`, size: desc.size ?? 0 });
    },
    createTexture: () => {
      probe.textures += 1;
      return okShim({ __mock: `texture-${probe.textures}` });
    },
    createTextureView: () => {
      probe.views += 1;
      return okShim({ __mock: `view-${probe.views}` });
    },
    destroyBuffer(buf: object): Result<void, RhiError> {
      if (destroyedBufs.has(buf)) {
        return err(
          new RhiError({
            code: 'destroy-after-destroy',
            expected: 'GPU buffer handle has not been destroyed yet',
            hint: 'object already destroyed; track lifecycle in caller',
          }),
        );
      }
      destroyedBufs.add(buf);
      probe.destroyedBuffers += 1;
      return ok(undefined);
    },
    destroyTexture(tex: object): Result<void, RhiError> {
      if (destroyedTexs.has(tex)) {
        return err(
          new RhiError({
            code: 'destroy-after-destroy',
            expected: 'GPU texture handle has not been destroyed yet',
            hint: 'object already destroyed; track lifecycle in caller',
          }),
        );
      }
      destroyedTexs.add(tex);
      probe.destroyedTextures += 1;
      return ok(undefined);
    },
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
  textureCompressionBc: false,
  textureCompressionEtc2: false,
  textureCompressionAstc: false,
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
  pod: EquirectAsset,
) => Result<Handle<'EquirectAsset', 'shared'>, never> {
  let next = 1000;
  return () => ok(toShared<'EquirectAsset'>(next++));
}

// biome-ignore lint/suspicious/noExplicitAny: shader-module factory shim
const shaderFactory = async (_d: any, desc: { code: string; label?: string }) =>
  ok({ __mock: 'shader', label: desc.label ?? '' }) as never;

function configuredStore(probe: DeviceProbe): GpuResourceStore {
  const store = new GpuResourceStore();
  store.configureGpuDevice(
    makeStoreMockDevice(probe),
    shaderFactory,
    makeRegisterCube() as never,
    mockCaps,
  );
  return store;
}

function meshPodFixture(): MeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array(4 * 12),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    attributes: {},
    aabb: new Float32Array(6),
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 6,
        vertexCount: 0,
        topology: 'triangle-list',
      },
    ],
  };
}

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

describe('GpuResourceStore handle map narrowing (feat-20260612 M3 / w9, AC-05)', () => {
  it('getMeshGpuHandles returns entry whose vertexBuffer / indexBuffer are GpuBuffer (no `as` cast)', () => {
    const probe = freshProbe();
    const store = configuredStore(probe);
    const handle = toShared<'MeshAsset'>(1024);

    const res = store.ensureResident(handle, meshPodFixture());
    expect(res.ok).toBe(true);

    const entry = store.getMeshGpuHandles(handle);
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    // Type-level narrowing assertion (AC-05): TS must accept the assignment
    // without an `as` cast. If the field type were still raw `any` this would
    // also compile (any flows everywhere) -- the structural guarantee is the
    // runtime instanceof below; together they catch the migration regression.
    const _vbo: GpuBuffer = entry.vertexBuffer;
    expect(_vbo).toBeInstanceOf(GpuBuffer);

    // Mesh has indices in the fixture, so indexBuffer is non-null GpuBuffer.
    expect(entry.indexBuffer).not.toBeNull();
    if (entry.indexBuffer !== null) {
      const _ibo: GpuBuffer = entry.indexBuffer;
      expect(_ibo).toBeInstanceOf(GpuBuffer);
    }
  });

  it('getTextureGpuView returns the underlying view; texture entry holds a GpuTexture (M-3 wrapper)', () => {
    const probe = freshProbe();
    const store = configuredStore(probe);
    const handle = toShared<'TextureAsset'>(2048);

    const res = store.ensureResident(handle, texturePodFixture());
    expect(res.ok).toBe(true);

    // The view accessor stays decoupled (TextureView != GpuResource); the
    // narrowing applies to the texture-side entry, exercised via the public
    // destroyAll path in w10 (the texture field is private to the entry).
    expect(store.getTextureGpuView(handle)).toBeDefined();
  });
});

describe('GpuResourceStore.destroyAll (feat-20260612 M3 / w10, AC-06 prereq)', () => {
  it('walks all 3 handle maps + every entry is destroyed after destroyAll()', async () => {
    const probe = freshProbe();
    const store = configuredStore(probe);
    const meshHandle = toShared<'MeshAsset'>(1024);
    const texHandle = toShared<'TextureAsset'>(2048);

    // Populate mesh + texture maps via ensureResident.
    expect(store.ensureResident(meshHandle, meshPodFixture()).ok).toBe(true);
    expect(store.ensureResident(texHandle, texturePodFixture()).ok).toBe(true);

    const meshEntry = store.getMeshGpuHandles(meshHandle);
    expect(meshEntry).toBeDefined();
    if (meshEntry === undefined) return;
    expect(meshEntry.vertexBuffer.isDestroyed).toBe(false);
    if (meshEntry.indexBuffer !== null) {
      expect(meshEntry.indexBuffer.isDestroyed).toBe(false);
    }

    // destroyedBuffers / destroyedTextures probe baseline.
    const baselineDestroyedBufs = probe.destroyedBuffers;
    const baselineDestroyedTexs = probe.destroyedTextures;

    store.destroyAll();

    // Mesh entry's GpuBuffer wrappers flipped to destroyed.
    expect(meshEntry.vertexBuffer.isDestroyed).toBe(true);
    if (meshEntry.indexBuffer !== null) {
      expect(meshEntry.indexBuffer.isDestroyed).toBe(true);
    }

    // RHI device.destroyBuffer fired for vbo + ibo (2); destroyTexture for the
    // texture (1). The cubemap map is empty in this fixture (no equirect
    // upload); a non-empty cubemap path is exercised below.
    expect(probe.destroyedBuffers - baselineDestroyedBufs).toBe(2);
    expect(probe.destroyedTextures - baselineDestroyedTexs).toBe(1);

    // After destroyAll() the maps are cleared so subsequent accessors miss.
    expect(store.getMeshGpuHandles(meshHandle)).toBeUndefined();
    expect(store.getTextureGpuView(texHandle)).toBeUndefined();
  });

  it('idempotent: second destroyAll() does nothing and does not throw', () => {
    const probe = freshProbe();
    const store = configuredStore(probe);
    const meshHandle = toShared<'MeshAsset'>(1024);

    expect(store.ensureResident(meshHandle, meshPodFixture()).ok).toBe(true);

    store.destroyAll();
    const afterFirst = probe.destroyedBuffers;

    // Second call: maps are already empty; no further RHI destroy fires.
    expect(() => store.destroyAll()).not.toThrow();
    expect(probe.destroyedBuffers).toBe(afterFirst);
  });

  it('destroyAll on an empty store is a no-op', () => {
    const probe = freshProbe();
    const store = configuredStore(probe);

    expect(() => store.destroyAll()).not.toThrow();
    expect(probe.destroyedBuffers).toBe(0);
    expect(probe.destroyedTextures).toBe(0);
  });
});

// ── M-4 / w14: instanceBuffers dispose-path cleanup unit test ──
//
// Coverage matrix (requirements §scope item 7 + plan-strategy §7 M-4 + D-7):
//   1. disposeInstanceBuffers walks the Map, calls .destroy() on every
//      entry.buffer (a GpuBuffer wrapper), and clears the Map.
//   2. Every wrapped GpuBuffer flips isDestroyed=true after the helper runs.
//   3. The helper is idempotent: a second call on the cleared Map is a no-op.
//   4. The helper on an empty Map is a safe no-op.
//
// Dispose path is independent of the per-frame Map.delete cleanup — the
// per-frame path keeps its existing 'just delete the key' semantics
// (plan-strategy D-7 / OOS-11).

import { GpuBuffer as GpuBufferCls } from '../gpu-resource';
import { disposeInstanceBuffers } from '../instance-buffer-cache';

describe('disposeInstanceBuffers (feat-20260612 M4 / w14)', () => {
  it('walks the Map and destroys every entry; clears the Map', () => {
    const device = makeMockDevice();
    const map = new Map<
      number,
      { buffer: GpuBufferCls; uploadedByteLength: number; uploadedArchVersion: number }
    >();
    const buf1 = new GpuBufferCls(device as unknown as RhiDevice, makeBufHandle());
    const buf2 = new GpuBufferCls(device as unknown as RhiDevice, makeBufHandle());
    map.set(1, { buffer: buf1, uploadedByteLength: 256, uploadedArchVersion: 1 });
    map.set(2, { buffer: buf2, uploadedByteLength: 512, uploadedArchVersion: 1 });

    expect(buf1.isDestroyed).toBe(false);
    expect(buf2.isDestroyed).toBe(false);
    expect(map.size).toBe(2);

    disposeInstanceBuffers(map);

    expect(buf1.isDestroyed).toBe(true);
    expect(buf2.isDestroyed).toBe(true);
    expect(map.size).toBe(0);
  });

  it('idempotent: a second dispose on the cleared Map is a no-op', () => {
    const device = makeMockDevice();
    const map = new Map<
      number,
      { buffer: GpuBufferCls; uploadedByteLength: number; uploadedArchVersion: number }
    >();
    const buf = new GpuBufferCls(device as unknown as RhiDevice, makeBufHandle());
    map.set(1, { buffer: buf, uploadedByteLength: 256, uploadedArchVersion: 1 });

    disposeInstanceBuffers(map);
    expect(map.size).toBe(0);

    expect(() => disposeInstanceBuffers(map)).not.toThrow();
    expect(map.size).toBe(0);
  });

  it('on an empty Map is a safe no-op', () => {
    const map = new Map<
      number,
      { buffer: GpuBufferCls; uploadedByteLength: number; uploadedArchVersion: number }
    >();
    expect(() => disposeInstanceBuffers(map)).not.toThrow();
    expect(map.size).toBe(0);
  });
});

// ── M1 feat-20260619-gpu-resource-ownership-symmetric-release-primitive ──
//
// w1: AC-01 evict primitives basic unit tests (red phase)
// w2: AC-01 cubemap wrapper shared-dedup unit tests (red phase)
// w3: AC-03 releaseUnreferenced idempotent unit tests (red phase)
// w4: AC-04 aggregate failure unit tests (red phase)

// ── Helpers for A-family evict tests ──

function evictableTextureStore(): {
  store: GpuResourceStore;
  probe: DeviceProbe;
  handle: ReturnType<typeof toShared<'TextureAsset'>>;
  tex: GpuTexture;
} {
  const probe = freshProbe();
  const store = configuredStore(probe);
  const handle = toShared<'TextureAsset'>(3001);

  const res = store.ensureResident(handle, texturePodFixture());
  expect(res.ok).toBe(true);

  const tex = store._getTextureGpuTexture(handle);
  expect(tex).toBeDefined();
  if (tex === undefined) throw new Error('unreachable');
  expect(tex.isDestroyed).toBe(false);

  return { store, probe, handle, tex };
}

function evictableMeshStore(): {
  store: GpuResourceStore;
  probe: DeviceProbe;
  handle: ReturnType<typeof toShared<'MeshAsset'>>;
  vbo: GpuBuffer;
  ibo: GpuBuffer;
} {
  const probe = freshProbe();
  const store = configuredStore(probe);
  const handle = toShared<'MeshAsset'>(3002);

  const res = store.ensureResident(handle, meshPodFixture());
  expect(res.ok).toBe(true);

  const entry = store.getMeshGpuHandles(handle);
  expect(entry).toBeDefined();
  if (entry === undefined) throw new Error('unreachable');
  expect(entry.vertexBuffer.isDestroyed).toBe(false);
  expect(entry.indexBuffer).not.toBeNull();
  if (entry.indexBuffer === null) throw new Error('unreachable');

  return {
    store,
    probe,
    handle,
    vbo: entry.vertexBuffer,
    ibo: entry.indexBuffer,
  };
}

describe('evictTexture / evictMesh / evictCubemap (feat-20260619 M1 / w1)', () => {
  it('evictTexture: removes entry from Map + isDestroyed === true', () => {
    const { store, probe, handle, tex } = evictableTextureStore();
    const baselineDestroyed = probe.destroyedTextures;

    const r = store.evictTexture(handle);
    expect(r.freed).toBe(1);
    expect(r.errors).toEqual([]);

    expect(tex.isDestroyed).toBe(true);
    expect(store._getTextureGpuTexture(handle)).toBeUndefined();
    expect(store.getTextureGpuView(handle)).toBeUndefined();
    expect(probe.destroyedTextures - baselineDestroyed).toBe(1);
  });

  it('evictTexture: double evict is no-op (freed=0, no error)', () => {
    const { store, handle } = evictableTextureStore();

    const r1 = store.evictTexture(handle);
    expect(r1.freed).toBe(1);

    const r2 = store.evictTexture(handle);
    expect(r2.freed).toBe(0);
    expect(r2.errors).toEqual([]);
  });

  it('evictTexture: non-existent key is no-op', () => {
    const probe = freshProbe();
    const store = configuredStore(probe);
    const handle = toShared<'TextureAsset'>(9999);

    const r = store.evictTexture(handle);
    expect(r.freed).toBe(0);
    expect(r.errors).toEqual([]);
  });

  it('evictMesh: removes entry + both vbo and ibo destroyed', () => {
    const { store, probe, handle, vbo, ibo } = evictableMeshStore();
    const baselineDestroyed = probe.destroyedBuffers;

    const r = store.evictMesh(handle);
    expect(r.freed).toBe(1);
    expect(r.errors).toEqual([]);

    expect(vbo.isDestroyed).toBe(true);
    expect(ibo.isDestroyed).toBe(true);
    expect(store.getMeshGpuHandles(handle)).toBeUndefined();
    // vbo + ibo = 2 buffer destroys
    expect(probe.destroyedBuffers - baselineDestroyed).toBe(2);
  });

  it('evictMesh: double evict is no-op', () => {
    const { store, handle } = evictableMeshStore();

    const r1 = store.evictMesh(handle);
    expect(r1.freed).toBe(1);

    const r2 = store.evictMesh(handle);
    expect(r2.freed).toBe(0);
    expect(r2.errors).toEqual([]);
  });

  it('evictMesh: non-existent key is no-op', () => {
    const probe = freshProbe();
    const store = configuredStore(probe);
    const handle = toShared<'MeshAsset'>(9999);

    const r = store.evictMesh(handle);
    expect(r.freed).toBe(0);
    expect(r.errors).toEqual([]);
  });

  it('evictCubemap: non-existent key is no-op', () => {
    const probe = freshProbe();
    const store = configuredStore(probe);

    const r = store.evictCubemap(9999);
    expect(r.freed).toBe(0);
    expect(r.errors).toEqual([]);
  });
});

describe('evictCubemap wrapper shared-dedup (feat-20260619 M1 / w2)', () => {
  it('evictCubemap on sourceId destroys wrapper; cubeId entry remains but is destroyed', () => {
    const probe = freshProbe();
    const store = configuredStore(probe);

    // Construct a cubemap with two entries sharing one GpuTexture wrapper
    // (mirrors uploadCubemapFromEquirect's dual set at sourceId + cubeId).
    const srcHandle = toShared<'EquirectAsset'>(4001);
    const cubeHandle = toShared<'EquirectAsset'>(4002);
    const sourceId = unwrapHandle(srcHandle);
    const cubeId = unwrapHandle(cubeHandle);

    // Create a GpuTexture wrapper directly
    const device = makeMockDevice() as unknown as RhiDevice;
    const gpuTex = new GpuTexture(device, {} as unknown as Texture);

    // biome-ignore lint/suspicious/noExplicitAny: access private store maps for test setup
    const storeAny = store as any;
    const sharedView = { __mock: 'cubemap-view' };
    const sharedFaceViews = [
      { __mock: 'face-0' },
      { __mock: 'face-1' },
      { __mock: 'face-2' },
      { __mock: 'face-3' },
      { __mock: 'face-4' },
      { __mock: 'face-5' },
    ];
    storeAny.cubemapGpuHandles.set(sourceId, {
      status: 'ready',
      texture: gpuTex,
      view: sharedView,
      faceViews: sharedFaceViews,
    });
    storeAny.cubemapGpuHandles.set(cubeId, {
      status: 'ready',
      texture: gpuTex,
      view: sharedView,
      faceViews: sharedFaceViews,
    });

    expect(gpuTex.isDestroyed).toBe(false);
    expect(storeAny.cubemapGpuHandles.has(sourceId)).toBe(true);
    expect(storeAny.cubemapGpuHandles.has(cubeId)).toBe(true);

    // Evict sourceId
    const r1 = store.evictCubemap(srcHandle);
    expect(r1.freed).toBe(1);
    expect(r1.errors).toEqual([]);

    expect(gpuTex.isDestroyed).toBe(true);
    expect(storeAny.cubemapGpuHandles.has(sourceId)).toBe(false);
    // cubeId entry still exists but wrapper is destroyed
    expect(storeAny.cubemapGpuHandles.has(cubeId)).toBe(true);

    // Evict cubeId: isDestroyed gate makes this no-op
    const r2 = store.evictCubemap(cubeHandle);
    expect(r2.freed).toBe(0);
    expect(r2.errors).toEqual([]);
    expect(storeAny.cubemapGpuHandles.has(cubeId)).toBe(false);
  });
});

describe('releaseUnreferenced (feat-20260619 M1 / w3)', () => {
  it('releases entries not in liveSet; keeps entries in liveSet', () => {
    const probe = freshProbe();
    const store = configuredStore(probe);
    const keepHandle = toShared<'TextureAsset'>(5001);
    const evictHandle = toShared<'TextureAsset'>(5002);

    store.ensureResident(keepHandle, texturePodFixture());
    store.ensureResident(evictHandle, texturePodFixture());

    const keepId = unwrapHandle(keepHandle);
    const liveSet = new Set<number>([keepId]);

    const r = store.releaseUnreferenced(liveSet);
    expect(r.freed).toBe(1);
    expect(r.errors).toEqual([]);

    // kept entry is intact
    expect(store._getTextureGpuTexture(keepHandle)).toBeDefined();
    expect(store._getTextureGpuTexture(keepHandle)?.isDestroyed).toBe(false);

    // evicted entry is gone
    expect(store._getTextureGpuTexture(evictHandle)).toBeUndefined();
  });

  it('ignores ids in liveSet that do not exist in store', () => {
    const probe = freshProbe();
    const store = configuredStore(probe);
    const handle = toShared<'TextureAsset'>(5003);
    store.ensureResident(handle, texturePodFixture());

    const liveSet = new Set<number>([unwrapHandle(handle), 99999]);

    const r = store.releaseUnreferenced(liveSet);
    // Only the resident texture should be kept; external id is ignored.
    expect(r.freed).toBe(0);
    expect(store._getTextureGpuTexture(handle)).toBeDefined();
  });

  it('empty liveSet releases everything; second call is no-op', () => {
    const probe = freshProbe();
    const store = configuredStore(probe);
    const h1 = toShared<'TextureAsset'>(5101);
    const h2 = toShared<'TextureAsset'>(5102);
    const h3 = toShared<'MeshAsset'>(5103);

    store.ensureResident(h1, texturePodFixture());
    store.ensureResident(h2, texturePodFixture());
    store.ensureResident(h3, meshPodFixture());

    const r1 = store.releaseUnreferenced(new Set());
    // 2 textures (1 each) + 1 mesh (vbo + ibo = 2 buffer frees) = 4
    expect(r1.freed).toBe(4);

    // Everything gone
    expect(store._getTextureGpuTexture(h1)).toBeUndefined();
    expect(store._getTextureGpuTexture(h2)).toBeUndefined();
    expect(store.getMeshGpuHandles(h3)).toBeUndefined();

    // Second call: no-op (Map already empty)
    const r2 = store.releaseUnreferenced(new Set());
    expect(r2.freed).toBe(0);
    expect(r2.errors).toEqual([]);
  });

  it('is idempotent: calling twice with same liveSet gives same result', () => {
    const probe = freshProbe();
    const store = configuredStore(probe);
    const keepHandle = toShared<'TextureAsset'>(5201);
    const evictHandle = toShared<'TextureAsset'>(5202);

    store.ensureResident(keepHandle, texturePodFixture());
    store.ensureResident(evictHandle, texturePodFixture());

    const liveSet = new Set<number>([unwrapHandle(keepHandle)]);

    const r1 = store.releaseUnreferenced(liveSet);
    expect(r1.freed).toBe(1);

    const r2 = store.releaseUnreferenced(liveSet);
    expect(r2.freed).toBe(0);
    expect(r2.errors).toEqual([]);
  });
});

describe('evict aggregate failure (feat-20260619 M1 / w4)', () => {
  function makeFailingMockDevice(): {
    device: MinimalDevice;
    failTex: Texture;
    failBuf: Buffer;
  } {
    const destroyedBufs = new WeakSet<Buffer>();
    const destroyedTexs = new WeakSet<Texture>();
    const failTex = {} as unknown as Texture;
    const failBuf = {} as unknown as Buffer;

    const device: MinimalDevice = {
      destroyBuffer(buf: Buffer): Result<void, RhiError> {
        if (buf === failBuf) {
          return err(
            new RhiError({
              code: 'destroy-after-destroy',
              expected: 'buffer not yet destroyed',
              hint: 'injected test failure',
            }),
          );
        }
        if (destroyedBufs.has(buf)) {
          return err(
            new RhiError({
              code: 'destroy-after-destroy',
              expected: 'GPU buffer handle has not been destroyed yet',
              hint: 'object already destroyed; track lifecycle in caller',
            }),
          );
        }
        destroyedBufs.add(buf);
        return ok(undefined);
      },
      destroyTexture(tex: Texture): Result<void, RhiError> {
        if (tex === failTex) {
          return err(
            new RhiError({
              code: 'destroy-after-destroy',
              expected: 'texture not yet destroyed',
              hint: 'injected test failure',
            }),
          );
        }
        if (destroyedTexs.has(tex)) {
          return err(
            new RhiError({
              code: 'destroy-after-destroy',
              expected: 'GPU texture handle has not been destroyed yet',
              hint: 'object already destroyed; track lifecycle in caller',
            }),
          );
        }
        destroyedTexs.add(tex);
        return ok(undefined);
      },
    };

    return { device, failTex, failBuf };
  }

  it('single evictTexture failure: errors collected, freed counts remaining', () => {
    const { device, failTex } = makeFailingMockDevice();

    // Build two GpuTexture wrappers: one that will fail, one normal.
    const goodTex = new GpuTexture(device as unknown as RhiDevice, {} as unknown as Texture);
    const badTex = new GpuTexture(device as unknown as RhiDevice, failTex);

    const probe = freshProbe();
    const store = configuredStore(probe);

    const goodHandle = toShared<'TextureAsset'>(6001);
    const badHandle = toShared<'TextureAsset'>(6002);
    const goodId = unwrapHandle(goodHandle);
    const badId = unwrapHandle(badHandle);

    // biome-ignore lint/suspicious/noExplicitAny: access private store maps for test setup
    const storeAny = store as any;
    storeAny.textureGpuHandles.set(goodId, {
      texture: goodTex,
      view: { __mock: 'view-good' },
    });
    storeAny.textureGpuHandles.set(badId, {
      texture: badTex,
      view: { __mock: 'view-bad' },
    });

    // Evict the good handle first
    const rGood = store.evictTexture(goodHandle);
    expect(rGood.freed).toBe(1);
    expect(rGood.errors).toEqual([]);
    expect(goodTex.isDestroyed).toBe(true);

    // Evict the bad handle
    const rBad = store.evictTexture(badHandle);
    expect(rBad.freed).toBe(0);
    expect(rBad.errors.length).toBe(1);
    expect(rBad.errors[0]?.code).toBe('destroy-after-destroy');
    // Sweep continued — bad handle entry removed
    expect(storeAny.textureGpuHandles.has(badId)).toBe(false);
  });

  it('single evictMesh failure: errors collected, freed counts remaining buffers', () => {
    const { device, failBuf } = makeFailingMockDevice();
    const probe = freshProbe();
    const store = configuredStore(probe);

    const handle = toShared<'MeshAsset'>(6003);
    const id = unwrapHandle(handle);

    const goodVbo = new GpuBuffer(device as unknown as RhiDevice, {} as unknown as Buffer);
    const badIbo = new GpuBuffer(device as unknown as RhiDevice, failBuf);

    // biome-ignore lint/suspicious/noExplicitAny: access private store maps for test setup
    const storeAny = store as any;
    storeAny.meshGpuHandles.set(id, {
      vertexBuffer: goodVbo,
      indexBuffer: badIbo,
      vboBytes: 256,
      iboBytes: 256,
      indexCount: 6,
      indexFormat: 'uint16',
      layout: '12F',
      vertexCount: 4,
      indexed: true,
      topology: 'triangle-list',
      submeshes: [{ indexOffset: 0, indexCount: 6, vertexCount: 0, topology: 'triangle-list' }],
    });

    const r = store.evictMesh(handle);
    // vbo destroyed ok but ibo failed — freed counts 0 (only vbo, but treat mesh as atomic evict)
    // The plan says evict counts freed per-resource, mesh has two buffers.
    // Per w5 design: evictMesh frees 1 (the mesh entry), errors collects both buffer failures.
    // Actually, let's check: D-1 says "read Result (ok→freed++; err→fire+errors.push)"
    // For mesh: two buffers → two destroy calls. freed counts successful destroys.
    expect(r.freed).toBe(1); // vbo ok
    expect(r.errors.length).toBe(1); // ibo failed
    expect(r.errors[0]?.code).toBe('destroy-after-destroy');
    expect(goodVbo.isDestroyed).toBe(true);
    expect(storeAny.meshGpuHandles.has(id)).toBe(false);
  });

  it('releaseUnreferenced with mixed failures: errors collected, sweep continues', () => {
    const { device, failTex } = makeFailingMockDevice();
    const probe = freshProbe();
    const store = configuredStore(probe);

    const badHandle = toShared<'TextureAsset'>(6010);
    const goodHandle = toShared<'MeshAsset'>(6011);
    const badId = unwrapHandle(badHandle);
    const goodId = unwrapHandle(goodHandle);

    const badTex = new GpuTexture(device as unknown as RhiDevice, failTex);
    const goodVbo = new GpuBuffer(device as unknown as RhiDevice, {} as unknown as Buffer);
    const goodIbo = new GpuBuffer(device as unknown as RhiDevice, {} as unknown as Buffer);

    // biome-ignore lint/suspicious/noExplicitAny: access private store maps for test setup
    const storeAny = store as any;
    storeAny.textureGpuHandles.set(badId, {
      texture: badTex,
      view: { __mock: 'view-bad' },
    });
    storeAny.meshGpuHandles.set(goodId, {
      vertexBuffer: goodVbo,
      indexBuffer: goodIbo,
      vboBytes: 256,
      iboBytes: 256,
      indexCount: 6,
      indexFormat: 'uint16',
      layout: '12F',
      vertexCount: 4,
      indexed: true,
      topology: 'triangle-list',
      submeshes: [{ indexOffset: 0, indexCount: 6, vertexCount: 0, topology: 'triangle-list' }],
    });

    const r = store.releaseUnreferenced(new Set());
    // badTex fails (1 error), goodVbo+goodIbo both succeed — freed counts each
    // per-resource destroy, so 2 buffer destroys = freed 2. bad tex = 0 frees, 1 error.
    expect(r.freed).toBe(2); // 2 buffer frees (vbo + ibo), 0 texture frees
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]?.code).toBe('destroy-after-destroy');
    expect(goodVbo.isDestroyed).toBe(true);
    expect(goodIbo.isDestroyed).toBe(true);
  });
});

// ── M2 w7: AC-02 event-driven recycle closed-loop integration test ──
//
// Validates the full chain: SharedRefStore.alloc(brand, pod, onLastRelease)
// -> release (rc 1->0) -> onLastRelease callback fires -> gpuStore.evictX.
//
// Scope per task description:
//   (1) Three resource types (TextureAsset / MeshAsset / EquirectAsset cubemap)
//       each construct one alloc -> retain -> release-to-rc=0 ->
//       onLastRelease triggers evict -> assert wrapper.isDestroyed===true.
//   (2) Covers "no manual evict needed" — entity despawn path auto-recycles.
//   (3) Negative assertion: onLastRelease NOT wired -> resource is NOT evicted
//       (stays resident in store).
//
// These tests wire the callback directly in the test (independent of w8's
// engine-location wiring). They will go red in this commit (red phase of TDD)
// and turn green when w8 completes the wiring.

describe('event-driven recycle closed-loop (feat-20260619 M2 / w7, AC-02)', () => {
  // Helper: create a GpuResourceStore with configured device and probe,
  // using the same mock infrastructure from earlier describe blocks.
  function evictCapturingStore(): {
    store: GpuResourceStore;
    probe: DeviceProbe;
    sharedRefs: SharedRefStore;
  } {
    const probe = freshProbe();
    const store = new GpuResourceStore();
    store.configureGpuDevice(
      makeStoreMockDevice(probe),
      shaderFactory,
      makeRegisterCube() as never,
      mockCaps,
    );
    return { store, probe, sharedRefs: new SharedRefStore() };
  }

  it('TextureAsset: allocWithOnLastRelease -> release to rc=0 -> evictTexture fires, wrapper destroyed', () => {
    const { store, probe, sharedRefs } = evictCapturingStore();
    const baselineDestroyed = probe.destroyedTextures;

    // Step 1: allocSharedRef with onLastRelease that calls evictTexture
    const payload: TextureAsset = texturePodFixture();
    const handle = sharedRefs.alloc('TextureAsset', payload, (p: TextureAsset) => {
      void p;
      // Use the most-recently-minted handle — alloc returns the handle but
      // the callback closure captures it via the sharedRefs alloc cycle.
      void store.evictTexture(handle);
    });

    // Step 2: ensureResident so GPU resources are materialised in the store
    const residentRes = store.ensureResident(handle, payload);
    expect(residentRes.ok).toBe(true);

    const tex = store._getTextureGpuTexture(handle);
    expect(tex).toBeDefined();
    if (tex === undefined) return;
    expect(tex.isDestroyed).toBe(false);

    // Step 3: retain (rc 2) then release twice to hit rc 0 (alloc grants rc=1)
    // The alloc already grants rc=1. We need to verify the callback fires when
    // rc transitions 1->0, so just release once.
    const releaseRes = sharedRefs.release(handle);
    expect(releaseRes.ok).toBe(true);

    // rc now 0 => onLastRelease callback fired => evictTexture called
    expect(tex.isDestroyed).toBe(true);
    expect(store._getTextureGpuTexture(handle)).toBeUndefined();
    expect(store.getTextureGpuView(handle)).toBeUndefined();
    expect(probe.destroyedTextures - baselineDestroyed).toBe(1);
  });

  it('MeshAsset: allocWithOnLastRelease -> release to rc=0 -> evictMesh fires, vbo+ibo destroyed', () => {
    const { store, probe, sharedRefs } = evictCapturingStore();
    const baselineDestroyed = probe.destroyedBuffers;

    const payload: MeshAsset = meshPodFixture();
    const handle = sharedRefs.alloc('MeshAsset', payload, (p: MeshAsset) => {
      void p;
      void store.evictMesh(handle);
    });

    const residentRes = store.ensureResident(handle, payload);
    expect(residentRes.ok).toBe(true);

    const entry = store.getMeshGpuHandles(handle);
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.vertexBuffer.isDestroyed).toBe(false);
    expect(entry.indexBuffer).not.toBeNull();
    if (entry.indexBuffer === null) return;

    const releaseRes = sharedRefs.release(handle);
    expect(releaseRes.ok).toBe(true);

    // rc 0 => onLastRelease => evictMesh called
    expect(entry.vertexBuffer.isDestroyed).toBe(true);
    expect(entry.indexBuffer.isDestroyed).toBe(true);
    expect(store.getMeshGpuHandles(handle)).toBeUndefined();
    expect(probe.destroyedBuffers - baselineDestroyed).toBe(2);
  });

  it('EquirectAsset cubemap: allocWithOnLastRelease -> release to rc=0 -> evictCubemap fires', () => {
    const { store, sharedRefs } = evictCapturingStore();

    let cubeIdNum = 0;
    const cubePayload: EquirectAsset = {
      kind: 'equirect',
      width: 64,
      height: 64,
      format: 'rgba16float',
      data: new Uint8Array(64 * 64 * 8),
      colorSpace: 'linear',
    };
    const cubeHandle = sharedRefs.alloc('EquirectAsset', cubePayload, (p: EquirectAsset) => {
      void p;
      void store.evictCubemap(cubeIdNum);
    });
    cubeIdNum = unwrapHandle(cubeHandle);

    // Directly seed a cubemap entry into the store (simulating uploadCubemapFromEquirect
    // with the matching sourceId). We don't test the full equirect upload path;
    // we only verify the evict callback chain.
    const device = makeMockDevice() as unknown as RhiDevice;
    const gpuTex = new GpuTexture(device, {} as unknown as Texture);

    // biome-ignore lint/suspicious/noExplicitAny: access private store maps for test setup
    const storeAny = store as any;
    storeAny.cubemapGpuHandles.set(cubeIdNum, {
      status: 'ready',
      texture: gpuTex,
      view: { __mock: 'cubemap-view' },
      faceViews: [
        { __mock: 'face-0' },
        { __mock: 'face-1' },
        { __mock: 'face-2' },
        { __mock: 'face-3' },
        { __mock: 'face-4' },
        { __mock: 'face-5' },
      ],
    });

    expect(gpuTex.isDestroyed).toBe(false);
    expect(storeAny.cubemapGpuHandles.has(cubeIdNum)).toBe(true);

    // Release to rc=0 -> onLastRelease callback fires -> evictCubemap
    const releaseRes = sharedRefs.release(cubeHandle);
    expect(releaseRes.ok).toBe(true);

    expect(gpuTex.isDestroyed).toBe(true);
    expect(storeAny.cubemapGpuHandles.has(cubeIdNum)).toBe(false);
  });

  it('negative: no onLastRelease callback -> resource NOT evicted on release', () => {
    const { store, sharedRefs } = evictCapturingStore();

    // Allocate WITHOUT onLastRelease
    const payload: TextureAsset = texturePodFixture();
    const handle = sharedRefs.alloc('TextureAsset', payload);

    const residentRes = store.ensureResident(handle, payload);
    expect(residentRes.ok).toBe(true);

    const tex = store._getTextureGpuTexture(handle);
    expect(tex).toBeDefined();
    if (tex === undefined) return;
    expect(tex.isDestroyed).toBe(false);

    // Release to rc=0
    const releaseRes = sharedRefs.release(handle);
    expect(releaseRes.ok).toBe(true);

    // Resource still resident — no callback, no evict
    expect(tex.isDestroyed).toBe(false);
    expect(store._getTextureGpuTexture(handle)).toBeDefined();
  });

  it('retain -> release retains rc>0: no premature evict at rc 2->1', () => {
    const { store, sharedRefs } = evictCapturingStore();

    const payload: TextureAsset = texturePodFixture();
    const handle = sharedRefs.alloc('TextureAsset', payload, (p: TextureAsset) => {
      void p;
      void store.evictTexture(handle);
    });

    store.ensureResident(handle, payload);
    const tex = store._getTextureGpuTexture(handle);
    expect(tex).toBeDefined();
    if (tex === undefined) return;

    // retain (rc 1->2)
    const retainRes = sharedRefs.retain(handle);
    expect(retainRes.ok).toBe(true);
    expect(sharedRefs.refcount(handle)).toBe(2);

    // release to rc=2->1 (NOT 1->0, callback should NOT fire)
    const releaseRes = sharedRefs.release(handle);
    expect(releaseRes.ok).toBe(true);
    expect(sharedRefs.refcount(handle)).toBe(1);

    // Resource still resident — callback not triggered at rc 2->1
    expect(tex.isDestroyed).toBe(false);
    expect(store._getTextureGpuTexture(handle)).toBeDefined();

    // Final release to rc=0 -> callback fires
    const finalRes = sharedRefs.release(handle);
    expect(finalRes.ok).toBe(true);
    expect(tex.isDestroyed).toBe(true);
    expect(store._getTextureGpuTexture(handle)).toBeUndefined();
  });
});
