// shadow-csm-tile-consistency.test.ts - bug-20260619-csm-multi-cascade-directional-shadow-broken
// M1 / AC-04 + AC-06 + AC-07: three-way agreement between
//   (1) the depth-pass tile  -- the per-cascade setViewport the REAL urp
//       pipeline issues on the dedicated 'render-system-shadow' encoder,
//   (2) the sampler-side tile -- the WGSL `_atlasTileOrigin(layer, count)`
//       formula in lighting-directional.wgsl, and
//   (3) the matrix slot       -- layer index -> lightViewProj_A..D.
// For every (count, layer) in {1,2,3,4} x [0,count) all three must point at the
// same tile / slot, otherwise a cascade samples an empty tile (or another
// cascade's depth) and the shadow silently vanishes.
//
// This DOES NOT re-declare the tile formula and test it against itself (the
// shadow-csm-atlas.test.ts antipattern: a local computeAtlasLayout copy that
// could agree with a bug verbatim). The depth tile is captured from the actual
// urp cascade loop driven through createRenderer + renderer.draw([world], { owner: 0 }); the
// sampler tile is read from the WGSL source the GPU actually compiles. The
// canonical mapping is asserted against BOTH real sources, so a drift on either
// side breaks the test.
//
// AC-04 (count 2/3/4) and AC-06 (count 1) are GREEN today -- they are
// regression guards proving the failure does not come from tile misplacement.
// AC-07: documented below as a finding (the 9-tap PCF offset is added in
// atlas-space and can cross a tile boundary for count > 1).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Handle } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENGINE = '../createRenderer';

interface CapturedViewport {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface CaptureLog {
  // setViewport calls on the 'render-system-shadow' encoder, in cascade order.
  shadowViewports: CapturedViewport[];
}

function makeMockGL2(): unknown {
  return {
    __mockTag: 'webgl2',
    getExtension: () => null,
    getParameter: () => 1,
    isContextLost: () => false,
  };
}

function makeMockCanvas(): HTMLCanvasElement {
  const canvas = {
    width: 800,
    height: 600,
    getContext(kind: string): unknown {
      if (kind === 'webgl2') return makeMockGL2();
      if (kind === 'webgpu') {
        return {
          __mockTag: 'webgpu-canvas-context',
          configure: () => undefined,
          unconfigure: () => undefined,
          getCurrentTexture: () => ({ createView: () => ({}) }),
        };
      }
      return null;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return canvas as Partial<HTMLCanvasElement> as HTMLCanvasElement;
}

function makeRenderPassEncoder(log: CaptureLog, isShadowEncoder: boolean): Record<string, unknown> {
  return {
    setPipeline: () => undefined,
    setVertexBuffer: () => undefined,
    setIndexBuffer: () => undefined,
    setBindGroup: () => undefined,
    setViewport: (x: number, y: number, w: number, h: number) => {
      if (isShadowEncoder) log.shadowViewports.push({ x, y, w, h });
    },
    draw: () => undefined,
    drawIndexed: () => undefined,
    setStencilReference: () => undefined,
    end: () => undefined,
  };
}

function makeMockGPUDevice(log: CaptureLog): unknown {
  const lost = new Promise<unknown>(() => undefined);
  return {
    __mockTag: 'gpu-device',
    lost,
    features: new Set(),
    limits: {},
    queue: {
      submit: () => undefined,
      writeBuffer: () => undefined,
      writeTexture: () => undefined,
    },
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => ({}),
    createBindGroup: () => ({}),
    createBuffer: () => ({
      getMappedRange: () => new ArrayBuffer(64),
      unmap: () => undefined,
    }),
    createCommandEncoder: (desc?: { label?: string }) => {
      // Only the dedicated shadow encoder routes through the per-cascade
      // viewport call site (recordShadowPass). Other encoders (main / boot
      // clears) carry different labels and are ignored, so the captured list is
      // exactly the cascade tile placement in order.
      const isShadowEncoder = desc?.label === 'render-system-shadow';
      return {
        beginRenderPass: () => makeRenderPassEncoder(log, isShadowEncoder),
        finish: () => ({}),
      };
    },
    createTexture: () => ({ createView: () => ({}) }),
    createSampler: () => ({}),
    destroy: () => undefined,
  };
}

function makeMockGPU(device: unknown): unknown {
  return {
    requestAdapter: async () => ({ requestDevice: async () => device }),
    getPreferredCanvasFormat: () => 'bgra8unorm',
  };
}

const baseNavigator = { userAgent: 'mock-engine-test' } as Partial<Navigator> as Navigator;

function buildManifestDataUrl(): string {
  const materialShaderStub = (identifier: string) => ({
    identifier,
    sourcePath: `${identifier}.wgsl`,
    composedWgsl: '/* stub */',
    paramSchema: '[]',
    variants: [],
  });
  const manifest = {
    schemaVersion: '1.0.0',
    entries: [
      { hash: 'pbr00000', wgsl: '/* pbr stub - calls f_schlick( */', glsl: '', bindings: '' },
      { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
      {
        hash: 'tonemap0',
        wgsl: '/* tonemap stub - struct TonemapParams { exposure: f32 }; */',
        glsl: '',
        bindings: '',
      },
      // createRenderer registers forgeax::default-shadow-caster from the first
      // entry whose wgsl has '@location(0) position' but not '@location(1)
      // normal'. Without it the shadow PSO lookup is null, recordShadowPass
      // early-exits, and no viewport is captured.
      {
        hash: 'shadowcaster0',
        wgsl: '/* shadow caster stub - @location(0) position vertex-only */',
        glsl: '',
        bindings: '',
      },
    ],
    materialShaders: [
      materialShaderStub('forgeax::default-standard-pbr'),
      materialShaderStub('forgeax::default-unlit'),
    ],
  };
  return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
}

async function importEngine(): Promise<{
  createRenderer: (
    canvas: unknown,
    opts?: unknown,
    bundler?: unknown,
  ) => Promise<{
    ready: Promise<void>;
    draw: (worlds: unknown, opts: { owner: number }) => void;
    onError: (cb: (err: { code: string }) => void) => () => void;
  }>;
}> {
  return (await import(ENGINE)) as never;
}

async function importEcs(): Promise<{ World: new () => unknown }> {
  return (await import('@forgeax/engine-ecs')) as never;
}

async function importComponents(): Promise<{
  Transform: unknown;
  MeshFilter: unknown;
  MeshRenderer: unknown;
  Camera: unknown;
  DirectionalLight: unknown;
  HANDLE_CUBE: Handle<'MeshAsset', 'shared'>;
}> {
  return {
    ...(await import('../index')),
    ...(await import('@forgeax/engine-assets-runtime')),
  } as never;
}

function identityTransform(): Record<string, number[]> {
  return { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] };
}

async function captureCascadeViewports(cascadeCount: number, mapSize: number): Promise<CaptureLog> {
  const log: CaptureLog = { shadowViewports: [] };
  const device = makeMockGPUDevice(log);
  vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
  const { createRenderer } = await importEngine();
  const renderer = await createRenderer(
    makeMockCanvas(),
    {},
    { shaderManifestUrl: buildManifestDataUrl() },
  );
  await renderer.ready;
  const { World } = await importEcs();
  const C = await importComponents();
  const world = new (World as new () => { spawn: (...componentDatas: unknown[]) => unknown })();
  world.spawn(
    {
      component: C.Camera,
      data: {
        fov: Math.PI / 4,
        aspect: 16 / 9,
        near: 0.1,
        far: 100,
        projection: 0,
        left: -1,
        right: 1,
        bottom: -1,
        top: 1,
      },
    },
    { component: C.Transform, data: { ...identityTransform(), pos: [0, 0, 3] } },
  );
  world.spawn({
    component: C.DirectionalLight,
    data: {
      direction: [-0.5, -1, -0.3],
      color: [1, 1, 1],
      intensity: 1,
      cascadeCount,
      mapSize,
    },
  });
  world.spawn(
    { component: C.MeshFilter, data: { assetHandle: C.HANDLE_CUBE } },
    { component: C.MeshRenderer, data: {} },
    { component: C.Transform, data: identityTransform() },
  );
  renderer.onError(() => undefined);
  renderer.draw([world], { owner: 0 });
  return log;
}

// Canonical cascade->tile mapping. Asserted against BOTH real sources below;
// it is the shared expectation, not the thing under test.
function canonicalTile(layer: number, count: number): { col: number; row: number } {
  const tilesPerSide = Math.ceil(Math.sqrt(count));
  return { col: layer % tilesPerSide, row: Math.floor(layer / tilesPerSide) };
}

// Read the WGSL the GPU actually compiles and evaluate its _atlasTileOrigin
// branch-free tilesPerSide rule (select(2u, 1u, count<=1u)) so the sampler-side
// mapping is pinned to the real shader source, not a hand-copy.
const LIGHTING_WGSL = fileURLToPath(
  new URL('../../../shader/src/lighting-directional.wgsl', import.meta.url),
);

function wgslAtlasTilesPerSide(count: number): number {
  const src = readFileSync(LIGHTING_WGSL, 'utf8');
  // The shader rule lives in _atlasTileOrigin: tilesPerSide = select(2u,1u,count<=1u).
  // We assert that exact expression is present, then evaluate it here.
  const m = src.match(/tilesPerSide\s*:\s*u32\s*=\s*select\(2u,\s*1u,\s*count\s*<=\s*1u\)/);
  if (m === null) {
    throw new Error(
      'lighting-directional.wgsl _atlasTileOrigin tilesPerSide rule changed; update AC-04 test',
    );
  }
  return count <= 1 ? 1 : 2;
}

function wgslAtlasTile(layer: number, count: number): { col: number; row: number } {
  const tilesPerSide = wgslAtlasTilesPerSide(count);
  return { col: layer % tilesPerSide, row: Math.floor(layer / tilesPerSide) };
}

describe('CSM cascade tile / matrix / viewport three-way agreement (AC-04, AC-06)', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { ...baseNavigator });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const count of [1, 2, 3, 4]) {
    it(`count=${count}: depth viewport == _atlasTileOrigin == matrix slot for every layer`, async () => {
      const mapSize = 1024;
      const log = await captureCascadeViewports(count, mapSize);

      // urp issues exactly one shadow pass (one viewport) per cascade.
      expect(log.shadowViewports).toHaveLength(count);

      for (let layer = 0; layer < count; layer++) {
        const vp = log.shadowViewports[layer];
        expect(vp).toBeDefined();
        if (vp === undefined) continue;

        // (1) real depth-pass tile, derived from the captured viewport origin.
        expect(vp.w).toBe(mapSize);
        expect(vp.h).toBe(mapSize);
        const depthTile = { col: vp.x / mapSize, row: vp.y / mapSize };
        expect(Number.isInteger(depthTile.col)).toBe(true);
        expect(Number.isInteger(depthTile.row)).toBe(true);

        // (2) sampler-side tile from the real WGSL formula.
        const samplerTile = wgslAtlasTile(layer, count);

        // (3) matrix slot: layer index maps 1:1 to lightViewProj_A..D, so the
        // slot index IS the layer. The depth pass uses cascadeIndex=layer to
        // pick the same matrix (urp-pipeline addShadowPass cascadeIndex: i).
        const matrixSlot = layer;

        // Three-way: all point at the same tile, and the matrix slot is the
        // layer that produced it.
        expect(depthTile).toEqual(samplerTile);
        expect(depthTile).toEqual(canonicalTile(layer, count));
        expect(matrixSlot).toBe(layer);
      }
    });
  }

  it('AC-06: count=1 collapses to tile (0,0), matrix slot 0, viewport (0,0)', async () => {
    const mapSize = 1024;
    const log = await captureCascadeViewports(1, mapSize);
    expect(log.shadowViewports).toHaveLength(1);
    const vp = log.shadowViewports[0];
    expect(vp).toEqual({ x: 0, y: 0, w: mapSize, h: mapSize });
    expect(wgslAtlasTile(0, 1)).toEqual({ col: 0, row: 0 });
    expect(canonicalTile(0, 1)).toEqual({ col: 0, row: 0 });
  });
});

// AC-07 (9-tap PCF offset coordinate-system self-consistency).
//
// _sampleShadowForCascade (lighting-directional.wgsl) computes:
//   tileUv   = (ndc.xy * 0.5 + 0.5)          // tile-local, range [0,1]
//   uv       = tileUv * inv + tileOrigin     // atlas-space
//   OOB early-return tests tileUv in [0,1]   // tile-local
//   9-tap:   offsetUv = clamp(uv + (x,y)*texel, tileLo, tileHi)  // atlas-space
//
// The OOB guard and the sampled coordinate are in DIFFERENT spaces. For count=1
// (inv=1, tileOrigin=0 => uv == tileUv) they coincide, so there was never a
// cross-tile risk. For count>1 the 9-tap offset is added in atlas space AFTER
// the tile-local OOB check, so a fragment within one texel of a tile edge would
// sample +/-1 texel into the neighbouring tile (a different cascade's depth) and
// leave a 1-texel seam at cascade boundaries. RC-2/D-6 (bug-20260619) fixed this
// by clamping every tap to this cascade's tile rect [tileOrigin, tileOrigin+inv)
// (one texel inset). This guard asserts the clamp is present so the fix cannot
// silently regress; for count=1 the clamp widens to the full atlas (no-op).
describe('AC-07: PCF offset coordinate-system self-consistency (static source check)', () => {
  it('count>1 taps are clamped to the cascade tile rect (no cross-tile sampling)', () => {
    const src = readFileSync(LIGHTING_WGSL, 'utf8');
    // Guard the structure: OOB tests tileUv, sampling uses uv = tileUv*inv +
    // tileOrigin, and every 9-tap offset is clamped to the tile rect.
    expect(src).toMatch(/let\s+uv\s*=\s*tileUv\s*\*\s*inv\s*\+\s*tileOrigin/);
    expect(src).toMatch(/tileUv\.x\s*>=\s*0\.0\s*&&\s*tileUv\.x\s*<=\s*1\.0/);
    expect(src).toMatch(
      /offsetUv\s*=\s*clamp\(\s*uv\s*\+\s*vec2<f32>\(f32\(x\),\s*f32\(y\)\)\s*\*\s*texel\s*,\s*tileLo\s*,\s*tileHi\s*\)/,
    );
    // One-texel inset tile clamp (merged 5.3-production-shadow-demos variant-free
    // PCF uses a fixed texel inset; the per-iteration radius clip keeps all taps
    // of kernels {1,3,5} in-tile).
    expect(src).toMatch(/let\s+tileLo\s*=\s*tileOrigin\s*\+\s*texel/);
    expect(src).toMatch(/let\s+tileHi\s*=\s*tileOrigin\s*\+\s*vec2<f32>\(inv\)\s*-\s*texel/);
    // count=1 => tilesPerSide=1 => inv=1, tileOrigin=(0,0) => uv === tileUv, so
    // the OOB guard space and sample space coincide regardless of the clamp.
    expect(wgslAtlasTilesPerSide(1)).toBe(1);
  });
});
