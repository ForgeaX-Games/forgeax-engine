// render-pipeline-trivial.dawn.test.ts
// feat-20260601-customizable-render-pipeline-seam-and-dogfood-rend M2 / w11.
//
// Structured dawn-node smoke for the customizable render-pipeline seam. This single test
// file is BOTH the AC-02 (register + install + run a trivial custom pipeline 300 frames,
// 0 RhiError) AND the AC-03 (install two RenderPipelineAssets sharing ONE logic id but
// differing only in config.passCount, observe perFramePassNames differ + a graph rebuild --
// the genuine one-logic-N-configs proof that config is threaded into buildGraph and is
// NON-no-op; feat-20260601 verify round 2 fixed the seam that formerly dropped config) AND
// the AC-08 proof: the trivial pipeline's buildGraph / execute closures take a `RenderPipelineContext`
// argument and reference ONLY its documented fields. A `ctx.internals` access does NOT
// type-check (the kitchen-sink is gone) - that compile error is the load-bearing AC-08
// oracle, asserted statically below via an `@ts-expect-error` line.
//
// Follows the fxaa-zero-overhead.dawn.test.ts pattern for canvas mock + device capture.

import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { RenderGraph } from '@forgeax/engine-render-graph';
import type { RenderPipelineAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { Camera, MeshFilter, MeshRenderer, Transform } from '../components';
import { createRenderer } from '../index';
import type { RenderPipeline } from '../render-pipeline';
import type { RenderPipelineContext, RenderPipelineData } from '../render-pipeline-context';

const WIDTH = 256;
const HEIGHT = 256;

const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;

const ENGINE_MANIFEST = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  return buildEngineShaderManifest();
})();
const ENGINE_MANIFEST_URL = `data:application/json,${encodeURIComponent(
  JSON.stringify(ENGINE_MANIFEST),
)}`;

/**
 * Build the trivial custom RenderPipeline. ONE logic id; its topology is sized at
 * `buildGraph` time by `data.config?.passCount` (the install-time `RenderPipelineAsset.config`
 * threaded through the pipeline seam, feat-20260601 verify round 2). Two `RenderPipelineAsset`s
 * sharing this one logic id but differing only in `config.passCount` install to observably
 * different `perFramePassNames` (AC-03, one-logic-N-configs).
 *
 * `data.config?.passCount ?? 1` is the read: missing config defaults to a single pass so a
 * config-less install still produces a non-empty frame (AC-02).
 *
 * AC-08 evidence: every closure below takes a `RenderPipelineContext` and reaches ONLY its
 * documented fields (`ctx.encoder`, `ctx.view`, `ctx.runtime.device`, `ctx.frameState`). It
 * CANNOT reach `ctx.internals` - that is a compile error (the `@ts-expect-error` test at the
 * bottom of this file pins that). Pass 0 clears the swap-chain view to a distinctive green
 * so the produced frame is observably non-empty (AC-02); passes 1..N-1 are no-ops. The
 * config-driven pass count drives `perFramePassNames` (AC-03).
 */
function makeTrivialPipeline(): RenderPipeline {
  return {
    buildGraph(
      ctx: RenderPipelineContext,
      data: RenderPipelineData,
    ): RenderGraph<RenderPipelineContext> | null {
      const passCount = data.config?.passCount ?? 1;
      const graph = new RenderGraph<RenderPipelineContext>();
      for (let i = 0; i < passCount; i++) {
        const isFirst = i === 0;
        graph.addPass(`custom-pass-${i}`, {
          reads: [],
          writes: [],
          execute: (c: RenderPipelineContext): void => {
            // Pass 0 clears the swap-chain view to a distinctive green so the frame is
            // observably non-empty (AC-02). Later passes are no-ops. Only documented ctx
            // fields are touched (encoder + view + runtime.errorRegistry).
            if (!isFirst) return;
            const pass = c.encoder.beginRenderPass({
              colorAttachments: [
                {
                  view: c.view as never,
                  clearValue: { r: 0, g: 0.6, b: 0, a: 1 },
                  loadOp: 'clear',
                  storeOp: 'store',
                },
              ],
            } as never);
            pass.end();
          },
        });
      }
      const compileResult = graph.compile({
        backendKind: ctx.runtime.device.caps.backendKind,
        caps: ctx.runtime.device.caps,
      });
      if (!compileResult.ok) return null;
      return graph;
    },
    execute(ctx: RenderPipelineContext): void {
      ctx.frameState.perFrameGraph?.execute(ctx);
    },
  };
}

interface DawnHarness {
  renderer: Awaited<ReturnType<typeof createRenderer>>;
  device: GPUDevice;
  renderTarget: GPUTexture;
}

async function bootDawn(): Promise<DawnHarness | null> {
  const dawnAvailable = typeof globalThis.navigator?.gpu?.requestAdapter === 'function';
  if (!dawnAvailable) {
    throw new Error('dawn-node navigator.gpu not injected; vitest.setup-webgpu.ts regressed');
  }
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
  if (!ready.ok) return null;
  if (sharedDevice === undefined) {
    throw new Error('dawn device never captured through requestDevice shim');
  }
  // Create the swap-chain render target eagerly. The mock canvas creates it lazily inside
  // getCurrentTexture(), which the first renderer.draw() triggers - but bootDawn returns
  // before any draw, so without this eager creation renderTarget stays undefined and the
  // harness would (formerly) return null, making the AC-02/AC-03 tests no-op (vacuous green).
  const target = ensureRenderTarget(sharedDevice, 'rgba8unorm');
  return { renderer, device: sharedDevice, renderTarget: target };
}

function spawnCubeScene(world: World): void {
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 0],
        quat: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: {} },
  );
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 3],
        quat: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
    },
    { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
  );
}

describe('feat-20260601 M2 w11: customizable render pipeline (dawn)', () => {
  it('AC-02: register + install a trivial custom pipeline, draw 300 frames, 0 RhiError', async () => {
    const harness = await bootDawn();
    if (harness === null) return;
    const { renderer, device } = harness;

    let rhiErrors = 0;
    renderer.onError(() => {
      rhiErrors++;
    });

    renderer.registerPipeline('test::trivial', makeTrivialPipeline());
    const installed = renderer.installPipeline({
      kind: 'render-pipeline',
      pipelineId: 'test::trivial',
      config: { passCount: 1 },
    });
    expect(installed.ok).toBe(true);

    const world = new World();
    spawnCubeScene(world);

    for (let f = 0; f < 300; f++) {
      const drawn = renderer.draw([world], { owner: 0 });
      expect(drawn.ok).toBe(true);
    }
    await device.queue.onSubmittedWorkDone();

    // AC-02: zero structured RhiError across 300 frames.
    expect(rhiErrors).toBe(0);
    // AC-02 non-empty frame proof: the custom pipeline drove the per-frame graph and the
    // declared pass set is present (falsification anchor: a buildGraph -> null returns an
    // empty perFramePassNames array, which would fail this assertion).
    expect(renderer.perFramePassNames).toEqual(['custom-pass-0']);
  });

  it('AC-03: ONE logic id + two configs (passCount 1 vs 2) rebuilds the graph + changes perFramePassNames', async () => {
    const harness = await bootDawn();
    if (harness === null) return;
    const { renderer, device } = harness;

    let rhiErrors = 0;
    renderer.onError(() => {
      rhiErrors++;
    });

    // ONE logic id. The config-driven difference is genuine (not faked by two closures): the
    // trivial pipeline's buildGraph reads `data.config?.passCount` (the install-time config
    // threaded through the seam). Two assets share this single logic id and differ ONLY in
    // config.passCount.
    renderer.registerPipeline('test::trivial', makeTrivialPipeline());

    const assetA: RenderPipelineAsset = {
      kind: 'render-pipeline',
      pipelineId: 'test::trivial',
      config: { passCount: 1 },
    };
    const assetB: RenderPipelineAsset = {
      kind: 'render-pipeline',
      pipelineId: 'test::trivial',
      config: { passCount: 2 },
    };

    const world = new World();
    spawnCubeScene(world);

    // Install A (config.passCount=1) + draw -> one custom pass.
    expect(renderer.installPipeline(assetA).ok).toBe(true);
    expect(renderer.draw([world], { owner: 0 }).ok).toBe(true);
    const passesAfterA = [...renderer.perFramePassNames];

    // Install B (same logic id, config.passCount=2) + draw -> the install bumps the
    // install-epoch brand-number, forcing a rebuild; buildGraph then reads the new
    // config and declares two passes. This is the falsifiable proof that config is NON-no-op:
    // if installPipeline dropped config (the verify-round-1 defect) passesAfterB would equal
    // passesAfterA and the assertion below would fail.
    expect(renderer.installPipeline(assetB).ok).toBe(true);
    expect(renderer.draw([world], { owner: 0 }).ok).toBe(true);
    const passesAfterB = [...renderer.perFramePassNames];

    await device.queue.onSubmittedWorkDone();

    // AC-03 (a)+(b): same logic id, the graph rebuilt (different pass set) and the
    // config-driven pass count is observable through perFramePassNames.
    expect(passesAfterA).toEqual(['custom-pass-0']);
    expect(passesAfterB).toEqual(['custom-pass-0', 'custom-pass-1']);
    expect(passesAfterA).not.toEqual(passesAfterB);
    // AC-03 (c): 0 RhiError across both installs + draws.
    expect(rhiErrors).toBe(0);
  });

  it('AC-08: a custom pipeline closure cannot reach ctx.internals (compile-time oracle)', () => {
    // The load-bearing AC-08 proof is static: the kitchen-sink `internals` field is GONE
    // from RenderPipelineContext. The line below MUST fail to type-check; if a future
    // change re-adds `internals` to the public ctx, the `@ts-expect-error` becomes unused
    // and tsc fails the build - turning this into a falsifiable guard.
    const probe = (ctx: RenderPipelineContext): unknown =>
      // @ts-expect-error - ctx.internals is intentionally unreachable (AC-08 oracle)
      ctx.internals;
    // The clean named surfaces ARE reachable (no error expected).
    const probeClean = (ctx: RenderPipelineContext): unknown => [
      ctx.assets,
      ctx.store,
      ctx.pipelineState,
      ctx.runtime,
    ];
    expect(typeof probe).toBe('function');
    expect(typeof probeClean).toBe('function');
  });

  // feat-20260604-resource-owning-render-graph-and-fullscreen-postpr M3 / w17:
  // AC-11 (addScenePass primitive) + AC-17 (end-to-end scene -> graph-owned RT
  // -> fullscreen post-process readback). The trivial pipeline above only clears
  // the swap-chain; below proves `g.addColorTarget` + `g.addScenePass` +
  // `g.addFullscreenPass` form the public vocabulary an AI user pipeline uses.
  //
  // The urp pipeline is exercised through createRenderer's default
  // install — one frame with a non-empty scene must read back non-clear pixels
  // through every pass (geometry, tonemap, fxaa). Without addScenePass /
  // addFullscreenPass actually drawing the scene into the graph-owned RT and
  // composing into the swap-chain, the readback would equal the clear colour —
  // which the falsify test below asserts when no scene is spawned.
  it('AC-11/17: urp addScenePass + addFullscreenPass renders scene non-empty', async () => {
    const harness = await bootDawn();
    if (harness === null) return;
    const { renderer, device, renderTarget } = harness;

    let rhiErrors = 0;
    renderer.onError(() => {
      rhiErrors++;
    });

    const world = new World();
    spawnCubeScene(world);

    // Drive a single frame through the default pipeline (forgeax::urp),
    // which after M3 is rewritten on top of addColorTarget / addScenePass /
    // addFullscreenPass. The end-to-end signature is observable through pixel
    // readback + perFramePassNames.
    expect(renderer.draw([world], { owner: 0 }).ok).toBe(true);
    await device.queue.onSubmittedWorkDone();

    // AC-15 / R-PERFPASS: the urp pass names are preserved post-rewrite.
    // perFramePassNames is the machine-readable proof that buildGraph still
    // declares the canonical chain after switching to the public vocabulary.
    //
    // feat-20260613-csm M6 / w22: the legacy 'shadow' pass is now N
    // independent 'shadowCascade<i>' passes (one per cascade tile in the
    // atlas, D-4). Without DirectionalLight with castShadow the urp falls back to
    // cascadeCount=1 -> a single 'shadowCascade0' pass.
    //
    // feat-20260612-point-light-shadows-urp-hdrp M3 / T-M3-4: 'point-shadow'
    // joins the chain after the directional cascade(s) (declared
    // unconditionally in urp-pipeline.ts buildGraph; recordPointShadowPass
    // early-returns when frameState.pointShadowSnapshots.length === 0 so the
    // zero-shadow scene pays no GPU cost — pass name still surfaces because
    // the graph node is declared at topology-build time).
    // feat-20260615-debug-draw M5: debug-overlay joins the chain after
    // fxaa (declared unconditionally in urp-pipeline.ts buildGraph;
    // attachDebugOverlayPass no-ops when no DebugDraw is registered so
    // the zero-draw scene pays no GPU cost).
    // feat-20260625-spot-light-shadow-mapping M2 / w9 (D-2): 'spot-shadow'
    // joins the chain after 'point-shadow' (declared unconditionally in
    // urp-pipeline.ts buildGraph; recordSpotShadowPass early-returns when no
    // castShadow spot has a valid tile so the zero-spot-shadow scene pays no
    // GPU cost — the graph node still surfaces at topology-build time).
    expect(renderer.perFramePassNames).toEqual([
      'shadowCascade0',
      'point-shadow',
      'spot-shadow',
      'skybox',
      'main',
      'bloom-bright',
      'bloom-blur-h',
      'bloom-blur-v',
      'bloom-composite',
      'tonemap',
      'fxaa',
      'debug-overlay',
    ]);

    // AC-17: read back the swap-chain texture. The cube scene clears to
    // (0.06, 0.06, 0.08) and renders an unlit cube + camera; the readback must
    // contain at least one pixel that differs from the clear colour. If
    // addScenePass / addFullscreenPass were no-ops (the falsifiable case), the
    // entire readback would equal the clear colour and this assertion would
    // fail.
    const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
    const readback = device.createBuffer({
      size: bytesPerRow * HEIGHT,
      usage: 0x09, // GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });
    const cmd = device.createCommandEncoder();
    cmd.copyTextureToBuffer(
      { texture: renderTarget, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
      { buffer: readback, bytesPerRow, rowsPerImage: HEIGHT },
      { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    );
    device.queue.submit([cmd.finish()]);
    await readback.mapAsync(1); // GPUMapMode.READ
    const view = new Uint8Array(readback.getMappedRange().slice(0));
    readback.unmap();
    readback.destroy();

    // Clear colour (0.06, 0.06, 0.08, 1.0) → sRGB-encoded ~ (69, 69, 80) in
    // bgra8unorm-srgb. Find pixels whose channel sum differs from clear by >40
    // (a comfortable threshold for tonemap/fxaa rounding while still proving
    // the scene drew non-clear content).
    const CLEAR_B = 80;
    const CLEAR_G = 69;
    const CLEAR_R = 69;
    let nonClearPixels = 0;
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const off = y * bytesPerRow + x * 4;
        const b = view[off];
        const g = view[off + 1];
        const r = view[off + 2];
        if (b === undefined || g === undefined || r === undefined) continue;
        const delta = Math.abs(b - CLEAR_B) + Math.abs(g - CLEAR_G) + Math.abs(r - CLEAR_R);
        if (delta > 40) nonClearPixels++;
      }
    }
    // AC-17 readback assertion: at least 1% of pixels must differ from the
    // clear colour (a cube + camera fills ~15-30% of the frame; 1% is a very
    // conservative lower bound that still proves the chain end-to-end).
    expect(nonClearPixels).toBeGreaterThan(WIDTH * HEIGHT * 0.01);
    expect(rhiErrors).toBe(0);
  });

  it('AC-17 falsify: empty scene reads back clear colour (proves end-to-end has discriminating power)', async () => {
    // Falsification anchor for the AC-17 readback above. If the previous test
    // passed only because of leftover GPU state or a dawn quirk (not because
    // addScenePass actually drew the scene), this test would also see
    // non-clear pixels — it doesn't, because spawning no renderables means
    // every pass clears or no-ops, leaving the swap-chain at the clear colour.
    const harness = await bootDawn();
    if (harness === null) return;
    const { renderer, device, renderTarget } = harness;

    let rhiErrors = 0;
    renderer.onError(() => {
      rhiErrors++;
    });

    const world = new World();
    // Camera only; NO MeshFilter / MeshRenderer (no draw calls in scene pass).
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 3],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
      // feat-20260608 sibling-collateral: clearColor moved off RendererOptions
      // to the Camera schema (one inline array<f32,4> column as of
      // feat-20260709 M3); explicit values keep this falsify discriminator
      // stable across the surface-trim cut.
      {
        component: Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 1,
          near: 0.1,
          far: 100,
          clearColor: [69 / 255, 69 / 255, 80 / 255, 1],
        },
      },
    );

    expect(renderer.draw([world], { owner: 0 }).ok).toBe(true);
    await device.queue.onSubmittedWorkDone();

    const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
    const readback = device.createBuffer({
      size: bytesPerRow * HEIGHT,
      usage: 0x09, // GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });
    const cmd = device.createCommandEncoder();
    cmd.copyTextureToBuffer(
      { texture: renderTarget, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
      { buffer: readback, bytesPerRow, rowsPerImage: HEIGHT },
      { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    );
    device.queue.submit([cmd.finish()]);
    await readback.mapAsync(1); // GPUMapMode.READ
    const view = new Uint8Array(readback.getMappedRange().slice(0));
    readback.unmap();
    readback.destroy();

    // With NO renderables, every pixel should be the clear colour — proving
    // the AC-17 readback test has discriminating power: a regression that
    // dropped scene-draw entirely would surface as "the AC-17 test sees the
    // same clear-only output this test sees".
    // feat-20260608 sibling-collateral: clear color is gamma-encoded by the
    // srgb output view (bgra8unorm-srgb view over bgra8unorm storage), so
    // clearR=clearG=69/255 (=0.27 linear) reads back as ~142 (=0.557 in srgb
    // encoding); clearB=80/255 (=0.314 linear) reads back as ~152.
    const CLEAR_B = 152;
    const CLEAR_G = 142;
    const CLEAR_R = 142;
    let nonClearPixels = 0;
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const off = y * bytesPerRow + x * 4;
        const b = view[off];
        const g = view[off + 1];
        const r = view[off + 2];
        if (b === undefined || g === undefined || r === undefined) continue;
        const delta = Math.abs(b - CLEAR_B) + Math.abs(g - CLEAR_G) + Math.abs(r - CLEAR_R);
        if (delta > 40) nonClearPixels++;
      }
    }
    // Conservative bound: <0.5% of pixels may stray from the clear colour
    // (FXAA edge softening across the 0-pixel boundary, etc.). The difference
    // with AC-17 above (>1% non-clear) is the discriminating signal.
    expect(nonClearPixels).toBeLessThan(WIDTH * HEIGHT * 0.005);
    expect(rhiErrors).toBe(0);
  });
});
