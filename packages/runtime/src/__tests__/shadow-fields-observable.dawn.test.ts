// shadow-fields-observable.dawn.test.ts
// feat-20260621-merge-directionallightshadow-into-directionallight M6
//
// Observability gate: proves depthBias, normalBias, pcfKernelSize --
// three merged DirectionalLight shadow fields -- produce real pixel A/B diffs.
//
// Root cause of prior "0 diff everywhere" failure: (a) materials without
// ShadowCaster pass (nothing written into shadow depth atlas), (b) floor
// position outside camera frustum. Both fixed in the harness below.
//
// Each pixel A/B pair gets its own `it()` with a fresh createRenderer call --
// shadow-atlas state and device-lost crashes from prior A/B rounds cannot
// contaminate the current comparison.

import { World } from '@forgeax/engine-ecs';
import {
  Camera,
  createRenderer,
  DirectionalLight,
  HANDLE_CUBE,
  Instances,
  MeshFilter,
  MeshRenderer,
  Transform,
} from '@forgeax/engine-runtime';
import type { MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

const WIDTH = 256;
const HEIGHT = 256;
const BPR = Math.ceil((WIDTH * 4) / 256) * 256;

const ENGINE_MANIFEST = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  return buildEngineShaderManifest();
})();
const ENGINE_MANIFEST_URL = `data:application/json,${encodeURIComponent(JSON.stringify(ENGINE_MANIFEST))}`;

// Helper types
interface WriteCapture {
  f32: Float32Array;
}

function composedStandardPbr(): string {
  const m = ENGINE_MANIFEST.materialShaders.find(
    (s: { identifier: string }) => s.identifier === 'forgeax::default-standard-pbr',
  );
  if (!m) throw new Error('default-standard-pbr not in engine manifest');
  return m.composedWgsl;
}

function buildTranslationGrid(): Float32Array {
  const out = new Float32Array(5 * 16);
  const s = 2.5;
  const h = ((5 - 1) * s) / 2;
  for (let i = 0; i < 5; i++) {
    const b = i * 16;
    out[b + 0] = 1;
    out[b + 5] = 1;
    out[b + 10] = 1;
    out[b + 15] = 1;
    out[b + 12] = i * s - h;
  }
  return out;
}

// Material with ShadowCaster pass -- required for depth writes into shadow atlas
function casterMat(w: World) {
  return w.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::default-standard-pbr',
        tags: { LightMode: 'Forward' },
        queue: 2000,
      },
      {
        name: 'ShadowCaster',
        shader: 'forgeax::default-shadow-caster',
        tags: { LightMode: 'ShadowCaster' } as Record<string, string>,
        passKind: 'shadow-caster' as const,
      },
    ],
    paramValues: {
      baseColor: [0.8, 0.6, 0.4, 1],
      metallic: 0.3,
      roughness: 0.5,
      emissive: [0, 0, 0],
      emissiveIntensity: 0,
      occlusionStrength: 1,
    },
  } as MaterialAsset);
}
function floorMat(w: World) {
  return w.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::default-standard-pbr',
        tags: { LightMode: 'Forward' },
        queue: 2000,
      },
    ],
    paramValues: {
      baseColor: [0.9, 0.9, 0.9, 1],
      metallic: 0,
      roughness: 0.9,
      emissive: [0, 0, 0],
      emissiveIntensity: 0,
      occlusionStrength: 1,
    },
  } as MaterialAsset);
}

// Floor at Y=5 Z=5 — in camera frustum (camera Y=8 Z=16, FOV 45, depth 11,
// visible Y [3.44, 12.56]). Occluder cubes at Y=7 cast shadow DOWN.
function spawnScene(
  world: World,
  castShadow: boolean,
  depthBias: number,
  normalBias: number,
  pcf: number,
  mapSize?: number,
) {
  const cm = casterMat(world);
  const fm = floorMat(world);
  world.spawn(
    {
      component: Transform,
      data: {
        posX: 0,
        posY: 5,
        posZ: 5,
        quatX: 0,
        quatY: 0,
        quatZ: 0,
        quatW: 1,
        scaleX: 8,
        scaleY: 0.1,
        scaleZ: 8,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [fm] } },
  );
  world.spawn(
    {
      component: Transform,
      data: {
        posX: 0,
        posY: 8,
        posZ: 16,
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
        fov: (45 * Math.PI) / 180,
        aspect: 1,
        near: 0.1,
        far: 100,
        clearR: 0.05,
        clearG: 0.05,
        clearB: 0.08,
        clearA: 1,
      },
    },
  );
  world.spawn({
    component: DirectionalLight,
    data: {
      directionX: 0.3,
      directionY: -0.9,
      directionZ: -0.31,
      colorR: 1,
      colorG: 1,
      colorB: 1,
      intensity: 1,
      castShadow,
      mapSize: mapSize ?? 1024,
      depthBias,
      normalBias,
      shadowDistance: 50,
      pcfKernelSize: pcf,
    },
  });
  world.spawn(
    {
      component: Transform,
      data: {
        posX: 0,
        posY: 7,
        posZ: 5,
        quatX: 0,
        quatY: 0,
        quatZ: 0,
        quatW: 1,
        scaleX: 0.5,
        scaleY: 0.5,
        scaleZ: 0.5,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [cm] } },
    { component: Instances, data: { transforms: buildTranslationGrid() } },
  );
}

function diff(a: Uint8Array, b: Uint8Array): { diff: number; maxChanDelta: number } {
  let d = 0,
    mc = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const v = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    if (v > 0) {
      d++;
      if (v > mc) mc = v;
    }
  }
  return { diff: d, maxChanDelta: mc };
}

async function readback(dev: GPUDevice, rt: GPUTexture): Promise<Uint8Array> {
  const buf = dev.createBuffer({ size: BPR * HEIGHT, usage: 0x0001 | 0x0008 });
  {
    const enc = dev.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: rt },
      { buffer: buf, bytesPerRow: BPR, rowsPerImage: HEIGHT },
      { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    );
    dev.queue.submit([enc.finish()]);
  }
  await buf.mapAsync(0x0001);
  const px = new Uint8Array(buf.getMappedRange().slice(0));
  buf.unmap();
  buf.destroy();
  return px;
}

async function renderConfig(
  castShadow: boolean,
  depthBias: number,
  normalBias: number,
  pcf: number,
  mapSize?: number,
): Promise<Uint8Array> {
  let sd: GPUDevice | undefined;
  let rt: GPUTexture | undefined;
  const _s = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
  globalThis.navigator.gpu.requestAdapter = async (opts) => {
    const ra = await _s(opts);
    if (!ra) return ra;
    const ord = ra.requestDevice.bind(ra);
    ra.requestDevice = async (desc) => {
      const dev = await ord(desc);
      if (!sd) sd = dev;
      return dev;
    };
    return ra;
  };
  const ens = (d: GPUDevice, f: GPUTextureFormat): GPUTexture => {
    if (rt) return rt;
    rt = d.createTexture({
      size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
      format: f,
      usage: 0x10 | 0x01,
      viewFormats: ['rgba8unorm-srgb'],
    });
    return rt;
  };
  const mc = {
    width: WIDTH,
    height: HEIGHT,
    getContext(k: string): unknown {
      if (k !== 'webgpu') return null;
      return {
        configure(d: { device: GPUDevice; format?: GPUTextureFormat }) {
          ens(d.device, d.format ?? 'rgba8unorm');
        },
        unconfigure() {},
        getCurrentTexture(): GPUTexture {
          if (!rt) throw new Error('no rt');
          return rt;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;

  let renderer: Awaited<ReturnType<typeof createRenderer>>;
  try {
    renderer = await createRenderer(mc, {}, { shaderManifestUrl: ENGINE_MANIFEST_URL });
  } finally {
    globalThis.navigator.gpu.requestAdapter = _s;
  }
  const ready = await renderer.ready;
  if (!ready.ok) throw ready.error;
  if (sd === undefined) throw new Error('device not initialized');
  const dev = sd;

  const w = new World();
  spawnScene(w, castShadow, depthBias, normalBias, pcf, mapSize);
  let de = 0;
  for (let i = 0; i < 300; i++) {
    const r = renderer.draw([w], { owner: 0 });
    if (!r.ok) de++;
  }
  if (de > 0) throw new Error(`draw errors: ${de}`);
  // rt is created lazily by the canvas configure()/getCurrentTexture path during
  // the first draw, so it is only guaranteed present after the draw loop.
  if (rt === undefined) throw new Error('render target not initialized');
  await dev.queue.onSubmittedWorkDone();
  return readback(dev, rt);
}

async function renderConfigWithSpy(
  castShadow: boolean,
  depthBias: number,
  normalBias: number,
  pcf: number,
  mapSize?: number,
): Promise<{ pixels: Uint8Array; captured: WriteCapture[] }> {
  let sd: GPUDevice | undefined;
  let rt: GPUTexture | undefined;
  const captured: WriteCapture[] = [];

  const _s = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
  globalThis.navigator.gpu.requestAdapter = async (opts) => {
    const ra = await _s(opts);
    if (!ra) return ra;
    const ord = ra.requestDevice.bind(ra);
    ra.requestDevice = async (desc) => {
      const dev = await ord(desc);
      if (!sd) {
        sd = dev;
        const orig = dev.queue.writeBuffer.bind(dev.queue);
        const spy = (
          buf: GPUBuffer,
          off: number,
          data: BufferSource | SharedArrayBuffer,
          ...rest: readonly unknown[]
        ): void => {
          const view = data as ArrayBufferView & { length?: number; BYTES_PER_ELEMENT?: number };
          const nb = view.byteLength ?? (view.length ?? 0) * (view.BYTES_PER_ELEMENT ?? 4);
          // feat-20260625 w25: the View UBO grew 592 -> 784 B (148 -> 196 f32)
          // when the spot lightViewProj array folded into its tail. The
          // directional fields this test reads live in floats [0..148); capture
          // that leading window from the now-784 B view write.
          if (nb >= 784 && off === 0) {
            const copy = new Float32Array(148);
            if (data instanceof Float32Array) copy.set(data.subarray(0, 148));
            else if (ArrayBuffer.isView(data)) {
              const sf32 = new Float32Array(data.buffer, data.byteOffset, 148);
              copy.set(sf32);
            }
            captured.push({ f32: copy });
          }
          (orig as (...a: readonly unknown[]) => void)(buf, off, data, ...rest);
        };
        (dev.queue as unknown as { writeBuffer: typeof spy }).writeBuffer = spy;
      }
      return dev;
    };
    return ra;
  };
  const ens = (d: GPUDevice, f: GPUTextureFormat): GPUTexture => {
    if (rt) return rt;
    rt = d.createTexture({
      size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
      format: f,
      usage: 0x10 | 0x01,
      viewFormats: ['rgba8unorm-srgb'],
    });
    return rt;
  };
  const mc = {
    width: WIDTH,
    height: HEIGHT,
    getContext(k: string): unknown {
      if (k !== 'webgpu') return null;
      return {
        configure(d: { device: GPUDevice; format?: GPUTextureFormat }) {
          ens(d.device, d.format ?? 'rgba8unorm');
        },
        unconfigure() {},
        getCurrentTexture(): GPUTexture {
          if (!rt) throw new Error('no rt');
          return rt;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;

  let renderer: Awaited<ReturnType<typeof createRenderer>>;
  try {
    renderer = await createRenderer(mc, {}, { shaderManifestUrl: ENGINE_MANIFEST_URL });
  } finally {
    globalThis.navigator.gpu.requestAdapter = _s;
  }
  const ready = await renderer.ready;
  if (!ready.ok) throw ready.error;
  if (sd === undefined) throw new Error('device not initialized');
  const dev = sd;

  const w = new World();
  spawnScene(w, castShadow, depthBias, normalBias, pcf, mapSize);
  let de = 0;
  for (let i = 0; i < 10; i++) {
    const r = renderer.draw([w], { owner: 0 });
    if (!r.ok) de++;
  }
  if (de > 0) throw new Error(`draw errors: ${de}`);
  await dev.queue.onSubmittedWorkDone();
  return { pixels: new Uint8Array(0), captured };
}

describe('M6 shadow fields observability', () => {
  // --- Gate A: structural WGSL check ---
  it('composed default-standard-pbr WGSL reads view.depthBias, view.normalBias, view.pcfKernelSize', () => {
    const wgsl = composedStandardPbr();
    expect(wgsl).toContain('depthBias');
    expect(wgsl).toContain('normalBias');
    expect(wgsl).toContain('pcfKernelSize');
  });

  // --- Gate B: UBO spy — slots [126]=depthBias, [127]=normalBias, [128]=pcfKernelSize ---
  it('View UBO slots [126]=depthBias, [127]=normalBias, [128]=pcfKernelSize', async () => {
    if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function') return;
    const { captured } = await renderConfigWithSpy(true, 0.123, 0.456, 3);
    const vw = captured.filter((c) => c.f32.length >= 148);
    expect(vw.length).toBeGreaterThan(0);
    const last = vw[vw.length - 1];
    if (last === undefined) throw new Error('no view UBO write captured');
    const f32 = last.f32;
    expect(Math.abs((f32[126] ?? Number.NaN) - 0.123)).toBeLessThan(0.001);
    expect(Math.abs((f32[127] ?? Number.NaN) - 0.456)).toBeLessThan(0.001);
    expect(f32[128]).toBe(3);
  }, 60000);

  // --- Gate D: pcfKernelSize clamp (9 -> 5; cap matches WGSL MAX_PCF_HALF=2) ---
  it('pcfKernelSize=9 clamped to 5 in View UBO[128]', async () => {
    if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function') return;
    const { captured } = await renderConfigWithSpy(true, 0.005, 0.05, 9);
    const vw9 = captured.filter((c) => c.f32.length >= 148);
    expect(vw9.length).toBeGreaterThan(0);
    const last9 = vw9[vw9.length - 1];
    if (last9 === undefined) throw new Error('no view UBO write captured');
    expect(last9.f32[128]).toBe(5);
  }, 60000);

  // --- Gate D: validate() rejections ---
  it('validate() accepts pcfKernelSize=9 (odd), rejects 2 (even) and 0', () => {
    const v = (
      DirectionalLight as {
        validate?: (d: Record<string, number | boolean>) => { code: string } | null;
      }
    ).validate;
    expect(
      v?.({
        castShadow: true,
        cascadeCount: 4,
        splitLambda: 0.75,
        cascadeBlend: 0.2,
        mapSize: 2048,
        shadowDistance: 50,
        pcfKernelSize: 9,
      }),
    ).toBeNull();
    expect(
      v?.({
        castShadow: true,
        cascadeCount: 4,
        splitLambda: 0.75,
        cascadeBlend: 0.2,
        mapSize: 2048,
        shadowDistance: 50,
        pcfKernelSize: 2,
      })?.code,
    ).toBe('shadow-invalid-config');
    expect(
      v?.({
        castShadow: true,
        cascadeCount: 4,
        splitLambda: 0.75,
        cascadeBlend: 0.2,
        mapSize: 2048,
        shadowDistance: 50,
        pcfKernelSize: 0,
      })?.code,
    ).toBe('shadow-invalid-config');
  });

  // --- Gate C: pixel A/B — castShadow ON vs OFF (control) ---
  it('pixel A/B: castShadow ON vs OFF (control — must differ)', async () => {
    if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function') return;
    const pxOn = await renderConfig(true, 0.005, 0.05, 3);
    const pxOff = await renderConfig(false, 0.005, 0.05, 3);
    const d = diff(pxOn, pxOff);
    expect(d.diff).toBeGreaterThan(0);
  }, 60000);

  // --- Gate C: pixel A/B — depthBias 0.0 vs 0.5 ---
  it('pixel A/B: depthBias 0.0 vs 0.5', async () => {
    if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function') return;
    const pxA = await renderConfig(true, 0.0, 0.05, 3);
    const pxB = await renderConfig(true, 0.5, 0.05, 3);
    const d = diff(pxA, pxB);
    expect(d.diff).toBeGreaterThan(0);
  }, 60000);

  // --- Gate C: pixel A/B — normalBias 0.0 vs 0.5 ---
  it('pixel A/B: normalBias 0.0 vs 0.5', async () => {
    if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function') return;
    const pxA = await renderConfig(true, 0.005, 0.0, 3);
    const pxB = await renderConfig(true, 0.005, 0.5, 3);
    const d = diff(pxA, pxB);
    expect(d.diff).toBeGreaterThan(0);
  }, 60000);

  // --- Gate C: pixel A/B — pcfKernelSize 1 vs 5 (cap; MAX_PCF_HALF=2) ---
  it('pixel A/B: pcfKernelSize 1 vs 5', async () => {
    if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function') return;
    const pxA = await renderConfig(true, 0.005, 0.05, 1);
    const pxB = await renderConfig(true, 0.005, 0.05, 5);
    const d = diff(pxA, pxB);
    expect(d.diff).toBeGreaterThan(0);
  }, 60000);

  // --- Gate F: mapSize 256 vs 2048 (independent shadow proof) ---
  it('pixel A/B: mapSize 256 vs 2048', async () => {
    if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function') return;
    const pxA = await renderConfig(true, 0.005, 0.05, 3, 256);
    const pxB = await renderConfig(true, 0.005, 0.05, 3, 2048);
    const d = diff(pxA, pxB);
    expect(d.diff).toBeGreaterThan(0);
  }, 60000);

  // --- Gate E: equal-control — same config twice => 0 diff ---
  it('equal-control: same config twice = 0 byte diff', async () => {
    if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function') return;
    const pxA = await renderConfig(true, 0.005, 0.05, 3);
    const pxB = await renderConfig(true, 0.005, 0.05, 3);
    const d = diff(pxA, pxB);
    expect(d.diff).toBe(0);
  }, 60000);

  // --- Gate G (AC-08): per-field falsification — discriminating-power proof ---
  //
  // AC-08 requires a git-visible gate proving each field's AC-03 signal is
  // CAUSED BY that field's UBO wiring, not by render nondeterminism. The
  // falsification is the contrast pair, asserted in ONE test so the discriminating
  // power is self-evident and cannot silently rot:
  //
  //   varied(field)  -> diff > 0   (the AC-03 observable signal)
  //   held(field)    -> diff == 0  (remove the only variable => signal vanishes)
  //
  // The `held` leg is the falsification: with the field pinned equal across both
  // renders, the bias/PCF UBO slot receives identical bytes, so IF the rendered
  // diff still appeared it would prove the signal came from something other than
  // the field (nondeterminism / a confounding input) and the AC-03 A/B above would
  // be meaningless. held==0 + varied>0 together establish that the observed signal
  // is attributable to exactly that field's wiring. Equivalent to "delete the UBO
  // write -> signal disappears" without mutating production engine code: pinning
  // the source value equal makes the write a no-op differentiator.
  //
  // Falsification SSOT note: to manually re-confirm the destructive variant
  // (physically removing the UBO write), comment out the matching
  // `viewPayload[126|127|128] = ...` line in render-system-record.ts and re-run
  // the corresponding `varied` leg — its diff collapses to 0, matching `held`.
  it('falsification: depthBias varied differs, held does not (signal attributable to the field)', async () => {
    if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function') return;
    const varied = diff(
      await renderConfig(true, 0.0, 0.05, 3),
      await renderConfig(true, 0.5, 0.05, 3),
    );
    const held = diff(
      await renderConfig(true, 0.0, 0.05, 3),
      await renderConfig(true, 0.0, 0.05, 3),
    );
    expect(varied.diff).toBeGreaterThan(0);
    expect(held.diff).toBe(0);
  }, 90000);

  it('falsification: normalBias varied differs, held does not', async () => {
    if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function') return;
    const varied = diff(
      await renderConfig(true, 0.005, 0.0, 3),
      await renderConfig(true, 0.005, 0.5, 3),
    );
    const held = diff(
      await renderConfig(true, 0.005, 0.0, 3),
      await renderConfig(true, 0.005, 0.0, 3),
    );
    expect(varied.diff).toBeGreaterThan(0);
    expect(held.diff).toBe(0);
  }, 90000);

  it('falsification: pcfKernelSize varied differs, held does not', async () => {
    if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function') return;
    const varied = diff(
      await renderConfig(true, 0.005, 0.05, 1),
      await renderConfig(true, 0.005, 0.05, 5),
    );
    const held = diff(
      await renderConfig(true, 0.005, 0.05, 1),
      await renderConfig(true, 0.005, 0.05, 1),
    );
    expect(varied.diff).toBeGreaterThan(0);
    expect(held.diff).toBe(0);
  }, 90000);
});
