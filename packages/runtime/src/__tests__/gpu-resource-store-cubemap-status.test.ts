// feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M2 / w10 —
// GpuResourceStore cubemap projection status tri-state + no-retry + idempotent
// unit tests (plan-strategy D-3 / D-4 / D-7, research F-2 / R-2 / R-5).
//
// Coverage matrix (plan-strategy §5.3 key test points (2) / (3)):
//   (a) CubemapGpuEntry.status tri-state ('pending' | 'ready' | 'failed') is
//       written into the store's cubemapGpuHandles map and reads back through
//       the private getter surface (status authority SSOT lives in the store,
//       D-3; not in the SkylightSnapshot).
//   (b) A projection that fails writes status:'failed' EXPLICITLY and a second
//       call with the same source handle does NOT re-run the upload (R-2 /
//       AC-09: failure must be recorded explicitly, never inferred from a
//       missing map key, otherwise the record arm retries every frame).
//   (c) The same equirect source handle resolves idempotently to a single
//       CubemapGpuEntry: a second _uploadCubemapFromEquirect call returns the
//       cached handle without minting a second GPU texture (research F-2).
//
// The store method is package-internal after w11 (`_`-prefixed + @internal,
// F-9: not a user-facing call; the record arm in the same package drives it in
// M3). The test reaches it through an `as any` cast.

import type { Handle, World } from '@forgeax/engine-ecs';
import type { Result, RhiCaps } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-rhi';
import type { EquirectAsset } from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { GpuResourceStore } from '../gpu-resource-store';

// ── Hardware caps probe (rgba16float renderable => HDR cubemap path allowed) ──

const capsRenderable: RhiCaps = {
  timestampQuery: false,
  indirectFirstInstance: false,
  firstInstanceIndirect: false,
  storageBuffer: true,
  storageTexture: false,
  rgba16floatRenderable: true,
  rg11b10ufloatRenderable: false,
  float32Filterable: false,
  maxColorAttachments: 8,
} as unknown as RhiCaps;

// ── Mock GPU device: createTexture / createTextureView / queue succeed so the
// upload path runs all the way to a 'ready' entry. A counter tracks texture
// creation so the idempotency assertion can prove a second call does not mint
// a second physical texture. ──

interface DeviceProbe {
  textures: number;
  views: number;
}

const okShim = <T>(v: T) => ({ ok: true as const, value: v });

// biome-ignore lint/suspicious/noExplicitAny: opaque mock GPU device surface
function makeReadyDevice(probe: DeviceProbe): any {
  return {
    createShaderModule: () => okShim({ __mock: 'shader' }),
    createSampler: () => okShim({ __mock: 'sampler' }),
    createBindGroupLayout: () => okShim({ __mock: 'bgl' }),
    createPipelineLayout: () => okShim({ __mock: 'layout' }),
    createRenderPipeline: () => okShim({ __mock: 'pipeline' }),
    createBindGroup: () => okShim({ __mock: 'bindGroup' }),
    createCommandEncoder: () => okShim({ __mock: 'encoder', beginRenderPass: () => ({}) }),
    createBuffer: (desc: { size?: number }) => okShim({ __mock: 'buffer', size: desc.size ?? 0 }),
    createTexture: () => {
      probe.textures += 1;
      return okShim({
        __mock: `texture-${probe.textures}`,
        createView: () => ({ __mock: 'view' }),
      });
    },
    createTextureView: () => {
      probe.views += 1;
      return okShim({ __mock: `view-${probe.views}` });
    },
    queue: {
      writeTexture: () => undefined,
      writeBuffer: () => undefined,
      submit: () => undefined,
    },
  };
}

// A device whose createTexture for the cube target returns undefined, forcing
// the upload to fail-fast with a structured error (drives status:'failed').
// biome-ignore lint/suspicious/noExplicitAny: opaque mock GPU device surface
function makeFailingDevice(): any {
  return {
    createShaderModule: () => okShim({ __mock: 'shader' }),
    createTexture: () => ({ ok: false as const, error: undefined }),
    createTextureView: () => ({ ok: false as const, error: undefined }),
    queue: {
      writeTexture: () => undefined,
      writeBuffer: () => undefined,
      submit: () => undefined,
    },
  };
}

// EquirectAsset register relay: mints a fresh shared EquirectAsset handle. The
// store keys cubemapGpuHandles by both the source and the minted handle (M2 w11
// keeps the relay but mints EquirectAsset rather than the retired CubeTexture).
function makeRegisterEquirect(): (
  world: World,
  pod: EquirectAsset,
) => Result<Handle<'EquirectAsset', 'shared'>, never> {
  let next = 7000;
  return () => ok(toShared<'EquirectAsset'>(next++));
}

// The store is wired WITHOUT an async shader-module factory so the optional IBL
// precompute render-pass block is skipped: this unit test asserts the status /
// idempotency / no-retry bookkeeping (written BEFORE the precompute block); the
// IBL precompute pixel correctness is covered by the dawn readback test.
function configuredStore(device: unknown, caps: RhiCaps = capsRenderable): GpuResourceStore {
  const store = new GpuResourceStore();
  store.configureGpuDevice(
    // biome-ignore lint/suspicious/noExplicitAny: mock device satisfies MipmapBlitDevice structurally
    device as any,
    undefined,
    makeRegisterEquirect() as never,
    caps,
  );
  return store;
}

function equirectPod(width = 4, height = 2): EquirectAsset {
  return {
    kind: 'equirect',
    width,
    height,
    format: 'rgba16float',
    data: new Uint8Array(width * height * 8),
    colorSpace: 'linear',
  };
}

// The world is only consumed by the register relay; a stub satisfies the call.
const stubWorld = {} as unknown as World;

describe('GpuResourceStore cubemap projection status (M2 / w10)', () => {
  it('status:ready — successful projection records a ready CubemapGpuEntry', async () => {
    const probe: DeviceProbe = { textures: 0, views: 0 };
    const store = configuredStore(makeReadyDevice(probe));
    const src = toShared<'EquirectAsset'>(100);

    // biome-ignore lint/suspicious/noExplicitAny: private method + private map access
    const s = store as any;
    const res = await s._uploadCubemapFromEquirect(stubWorld, src, equirectPod());
    expect(res.ok).toBe(true);

    const entry = s.cubemapGpuHandles.get(100);
    expect(entry).toBeDefined();
    expect(entry.status).toBe('ready');
    expect(entry.view).toBeDefined();
    expect(entry.faceViews.length).toBe(6);
  });

  it('status:failed — a failed projection writes status:failed explicitly and the second call does NOT re-run the upload (R-2 / AC-09)', async () => {
    const store = configuredStore(makeFailingDevice());
    const src = toShared<'EquirectAsset'>(200);

    // biome-ignore lint/suspicious/noExplicitAny: private method + private map access
    const s = store as any;
    const first = await s._uploadCubemapFromEquirect(stubWorld, src, equirectPod());
    expect(first.ok).toBe(false);

    // Failure must be recorded explicitly so the record arm can branch on it
    // (never inferred from a missing map key — that would retry every frame).
    const entry = s.cubemapGpuHandles.get(200);
    expect(entry).toBeDefined();
    expect(entry.status).toBe('failed');

    // Second frame: a re-query must NOT re-launch the projection. Swap the
    // device for one that would succeed; if the store retried it would flip to
    // ready. The status:failed record must short-circuit before any GPU work.
    const probe: DeviceProbe = { textures: 0, views: 0 };
    s.gpuDevice = makeReadyDevice(probe);
    const second = await s._uploadCubemapFromEquirect(stubWorld, src, equirectPod());
    expect(second.ok).toBe(false);
    expect(probe.textures).toBe(0);
    expect(s.cubemapGpuHandles.get(200).status).toBe('failed');
  });

  it('idempotent — same equirect source handle resolves to a single CubemapGpuEntry without minting a second texture (research F-2)', async () => {
    const probe: DeviceProbe = { textures: 0, views: 0 };
    const store = configuredStore(makeReadyDevice(probe));
    const src = toShared<'EquirectAsset'>(300);

    // biome-ignore lint/suspicious/noExplicitAny: private method + private map access
    const s = store as any;
    const first = await s._uploadCubemapFromEquirect(stubWorld, src, equirectPod());
    expect(first.ok).toBe(true);
    const texturesAfterFirst = probe.textures;
    expect(texturesAfterFirst).toBeGreaterThan(0);

    const second = await s._uploadCubemapFromEquirect(stubWorld, src, equirectPod());
    expect(second.ok).toBe(true);
    // The cached handle is returned verbatim; no second physical texture.
    expect(probe.textures).toBe(texturesAfterFirst);
    expect(first.value).toEqual(second.value);
    expect(s.cubemapGpuHandles.get(300).status).toBe('ready');
  });
});
