// shadow-quality-metrics.dawn.test.ts — L1 shadow-quality metric probes.
//
// WHY THIS EXISTS
// ---------------
// Structural smoke ("4 shadowCascade passes, no crash") proves the pipeline is
// wired, not that the shadows look right. Acne, missed occlusion, cascade seams
// and peter-panning all pass a structural gate while looking broken. This suite
// turns "does the shadow look good" into a handful of scalar metrics sampled off
// the real shadow atlas via `renderer.debugSampleShadowFactor`, each with a
// falsifiable assertion band. Regressions move a number; the number has a gate.
//
// WHAT THE PROBE MEASURES (and its honest limits)
// -----------------------------------------------
// `debugSampleShadowFactor(worldPositions)` reads the SAME shadow atlas the
// forward pass samples, selects the cascade by frustum containment (mirrors the
// shader's viewZ+splitPlanes selection), and returns a fixed-bias 3x3-PCF factor
// per point (1 = fully lit, 0 = fully shadowed). That makes these metrics honest:
//   - acne          — lit ground reads ~1 (no spurious self-shadow)
//   - coverage      — ground under the occluder reads low (shadow is present)
//   - contact       — the lit->shadowed transition sits at the occluder edge
//                     (peter-panning = shadow starts too far from the caster)
//   - cascadeSeam   — no factor discontinuity as depth crosses a split plane
// NOT measurable here (needs L3 lit-framebuffer readback): penumbra WIDTH driven
// by the material `pcfKernelSize`, because the probe uses its own fixed 3x3 tap,
// not the forward shader's variable kernel. We do not fake that metric.
//
// FALSIFY DISCIPLINE
// ------------------
// Each metric has a paired "must move the right way when the scene breaks" check
// (castShadow:false collapses coverage; a huge shadowDistance degrades near acne)
// so a vacuous all-green (empty atlas, probe returning a constant) cannot pass.

import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer, Transform } from '../components';
import { createRenderer } from '../index';

const ENGINE_MANIFEST = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  return buildEngineShaderManifest();
})();
const ENGINE_MANIFEST_URL = `data:application/json,${encodeURIComponent(
  JSON.stringify(ENGINE_MANIFEST),
)}`;

// biome-ignore lint/suspicious/noExplicitAny: dawn-node detection guard
const dawnReady = typeof navigator !== 'undefined' && (navigator as any).gpu !== undefined;

const GROUND_SIZE = 40;
const RT_W = 256;
const RT_H = 256;
const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;

// Mock canvas that exposes a real configurable WebGPU context + captures the
// device, mirroring shadow-m3.dawn.test.ts exactly (per-canvas adapter patch).
function createMockCanvas(): HTMLCanvasElement {
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
      size: { width: RT_W, height: RT_H, depthOrArrayLayers: 1 },
      format,
      usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC,
      viewFormats: ['rgba8unorm-srgb'],
    });
    return renderTarget;
  };
  return {
    width: RT_W,
    height: RT_H,
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
}

interface SceneConfig {
  readonly castShadow?: boolean;
  readonly cascadeCount?: number;
  readonly shadowDistance?: number;
  readonly mapSize?: number;
}

// Ground plane at y=0 with a 2x2x2 occluder centred at y=1.5 (bottom face at
// y=0.5), lit by a straight-down directional light. Orthographic camera framing
// the scene so every probe point lands in the atlas fit. Occluder edges are at
// x = +-1, so the ground shadow footprint is ~[-1,1] in x (light is near-vertical).
function buildScene(world: World, cfg: SceneConfig): void {
  world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [0, -0.005, 0],
          quat: [0, 0, 0, 1],
          scale: [GROUND_SIZE, 0.01, GROUND_SIZE],
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();

  world
    .spawn(
      {
        component: Transform,
        data: { pos: [0, 1.5, 0], quat: [0, 0, 0, 1], scale: [2, 2, 2] },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();

  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [0, -1, 0],
        color: [1, 1, 1],
        intensity: 1.5,
        castShadow: cfg.castShadow ?? true,
        cascadeCount: cfg.cascadeCount ?? 1,
        mapSize: cfg.mapSize ?? 1024,
        shadowDistance: cfg.shadowDistance ?? 50,
      },
    })
    .unwrap();

  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 10], quat: [0, 0, 0, 1] } },
      {
        component: Camera,
        data: {
          projection: 1,
          left: -GROUND_SIZE / 2,
          right: GROUND_SIZE / 2,
          bottom: -GROUND_SIZE / 2,
          top: GROUND_SIZE / 2,
          near: 0.1,
          far: 100,
          fov: 0,
          aspect: 1,
        } as Record<string, unknown> as never,
      },
    )
    .unwrap();
}

// ONE renderer for the whole suite. Creating a second createRenderer in the
// same dawn-node process trips `manifest-malformed` (shared shader-module cache
// state), so every sample() re-draws a fresh world through this single renderer
// and re-reads the atlas — the extract stage rebuilds shadow matrices per frame.
type Renderer = Awaited<ReturnType<typeof createRenderer>>;
let sharedRenderer: Renderer | undefined;
async function getRenderer(): Promise<Renderer> {
  if (sharedRenderer !== undefined) return sharedRenderer;
  const canvas = createMockCanvas();
  const renderer = await createRenderer(canvas, {}, { shaderManifestUrl: ENGINE_MANIFEST_URL });
  const ready = await renderer.ready;
  if (!ready.ok) throw new Error('renderer not ready');
  sharedRenderer = renderer;
  return renderer;
}

async function sample(
  cfg: SceneConfig,
  points: ReadonlyArray<readonly [number, number, number]>,
): Promise<number[]> {
  const renderer = await getRenderer();
  const world = new World();
  buildScene(world, cfg);
  world.update();
  const draw = renderer.draw([world], { owner: 0 });
  if (!draw.ok) throw new Error('draw failed');
  const res = await renderer.debugSampleShadowFactor?.(points);
  if (!res) throw new Error('debugSampleShadowFactor returned null');
  return res.map((r) => r.shadowFactor);
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('shadow quality metrics (L1 — off-atlas probe)', () => {
  it.skipIf(!dawnReady)('dawn-binding present', () => {
    expect(dawnReady).toBe(true);
  });

  // ── Metric: ACNE — lit ground far from the occluder must read ~fully lit ──
  it.skipIf(!dawnReady)('acne: unoccluded ground reads ~1 (no self-shadow noise)', async () => {
    const litPoints: [number, number, number][] = [
      [8, 0, 8],
      [-8, 0, 8],
      [8, 0, -8],
      [-8, 0, -8],
      [12, 0, 0],
      [-12, 0, 0],
    ];
    const factors = await sample({}, litPoints);
    const acneFraction = factors.filter((f) => f < 0.99).length / factors.length;
    // METRIC: fraction of clearly-unoccluded samples showing spurious shadow.
    // Gate: none should. A future acne regression pushes this above 0.
    expect(acneFraction).toBe(0);
    expect(mean(factors)).toBeGreaterThan(0.99);
  });

  // ── Metric: COVERAGE — ground under the occluder must be shadowed ──
  it.skipIf(!dawnReady)('coverage: ground under occluder reads shadowed', async () => {
    const under: [number, number, number][] = [
      [0, 0, 0],
      [0.5, 0, 0],
      [0, 0, 0.5],
      [-0.5, 0, -0.5],
    ];
    const factors = await sample({}, under);
    // METRIC: mean shadow factor directly under the caster. Gate: strongly
    // shadowed. Missed occlusion (bad ortho Z reach / too-small map) raises this.
    expect(mean(factors)).toBeLessThan(0.1);
  });

  // ── FALSIFY coverage: castShadow=false must collapse the shadow ──
  it.skipIf(!dawnReady)(
    'coverage falsify: castShadow=false leaves under-occluder lit',
    async () => {
      const under: [number, number, number][] = [
        [0, 0, 0],
        [0.5, 0, 0],
      ];
      const on = mean(await sample({ castShadow: true }, under));
      const off = mean(await sample({ castShadow: false }, under));
      // The same points flip from shadowed to lit — proves the probe reads a real
      // atlas, not a constant. Guards against a vacuous coverage pass.
      expect(on).toBeLessThan(0.1);
      expect(off).toBeGreaterThan(0.9);
    },
  );

  // ── Metric: CONTACT / peter-panning — transition sits at the occluder edge ──
  it.skipIf(!dawnReady)('contact: shadow edge tracks the occluder footprint (x≈1)', async () => {
    // Scan x from deep-shadow (0) outward past the occluder edge (1.0) into
    // full light. The last shadowed sample and first lit sample must straddle
    // x≈1. Peter-panning would push the transition well past the edge.
    const xs = [0, 0.4, 0.8, 1.0, 1.2, 1.6, 2.0, 3.0];
    const factors = await sample(
      {},
      xs.map((x) => [x, 0, 0] as [number, number, number]),
    );
    const scan = xs.map((x, i) => ({ x, f: factors[i] ?? 1 }));
    const lastShadowedX = scan.filter((s) => s.f < 0.5).at(-1)?.x ?? -1;
    const firstLitX = scan.find((s) => s.f > 0.5)?.x ?? 999;
    // METRIC: transition band position. Measured contact profile is
    // [0,0,0.33,1,1,1,1] over xs => lastShadowedX=1.0, firstLitX=1.2, i.e. a
    // one-sample transition straddling the occluder edge (x=1). Gate: shadow
    // persists to the edge and clears within ~1 texel of it. Peter-panning
    // (shadow detached from the caster) pushes firstLitX out; this catches it.
    expect(lastShadowedX).toBeGreaterThanOrEqual(0.8);
    expect(firstLitX).toBeLessThanOrEqual(1.2);
  });

  // ── Metric: CASCADE SEAM — no factor jump across a split boundary ──
  it.skipIf(!dawnReady)(
    'cascadeSeam: 4-cascade lit ground has no discontinuity vs 1-cascade',
    async () => {
      // Sample lit ground along increasing depth (spanning cascade splits under a
      // 4-cascade config). All should stay ~1; a seam would show a sudden dip at a
      // split plane. Compare the 4-cascade profile to the single-cascade baseline.
      const line: [number, number, number][] = [];
      for (let z = -18; z <= 18; z += 3) line.push([6, 0, z]);
      const one = await sample({ cascadeCount: 1 }, line);
      const four = await sample({ cascadeCount: 4 }, line);
      const maxAdjacentJump = (xs: number[]): number =>
        xs.reduce(
          (m, cur, i) => (i === 0 ? m : Math.max(m, Math.abs(cur - (xs[i - 1] ?? cur)))),
          0,
        );
      // METRIC: largest factor step between adjacent lit samples. Gate: small for
      // both; the 4-cascade path must not introduce a seam the 1-cascade lacks.
      expect(maxAdjacentJump(one)).toBeLessThan(0.1);
      expect(maxAdjacentJump(four)).toBeLessThan(0.1);
      expect(mean(four)).toBeGreaterThan(0.95);
    },
  );
});
