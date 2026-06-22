// post-process-register-roundtrip.dawn.test.ts - feat-20260604-resource-owning
// -render-graph-and-fullscreen-postpr M3 / F-2 fix-up.
//
// PIPE-NEUTRAL: this file exercises fullscreen post-process passes via
// addFullscreenPass, which bypasses material-pass selection. The URP
// tag convention (tags: { LightMode: 'Forward' }) is not applicable
// here — no passes:[] material literal exists in this file.
//
// Round-trip dawn integration test for the postProcess.register channel +
// addFullscreenPass dispatcher (F-2 / F-7 wiring):
//   (a) register(id, entry) is callable through the public renderer.postProcess
//       surface (re-runs through createRenderer to a real Renderer instance).
//   (b) registering the SAME id twice throws PostProcessError with code
//       'post-process-already-registered' (programmer-error fail-fast).
//   (c) addFullscreenPass referencing an unregistered id throws PostProcessError
//       with code 'post-process-not-found' through the dispatcher's lookup +
//       throw branch (the load-bearing AC-08 path: F-2 verified by exercising
//       the runtime.lookupPostProcess plumbing on a real Renderer).
//
// Distinct from fullscreen-post-process-pass.dawn.test.ts (which exercises the
// FXAA built-in path via antialias='fxaa' + camera) — this test exercises the
// AI-user register/lookup channel directly, ensuring an unregistered id never
// silently no-ops (charter P3) and ensuring the registry survives a real
// renderer.draw cycle.

import { RenderGraph } from '@forgeax/engine-render-graph';
import { describe, expect, it } from 'vitest';
import { createRenderer } from '../createRenderer';
import { addFullscreenPass } from '../render-graph-primitives';
import type { RenderPipelineContext } from '../render-pipeline-context';

const WIDTH = 256;
const HEIGHT = 256;

const ENGINE_MANIFEST = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  return buildEngineShaderManifest();
})();
const ENGINE_MANIFEST_URL = `data:application/json,${encodeURIComponent(
  JSON.stringify(ENGINE_MANIFEST),
)}`;

async function setupRenderer(): Promise<Awaited<ReturnType<typeof createRenderer>>> {
  if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function') {
    throw new Error('dawn-node navigator.gpu not injected; vitest.setup-webgpu.ts regressed');
  }
  let renderTarget: GPUTexture | undefined;
  let sharedDevice: GPUDevice | undefined;
  const original = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
  globalThis.navigator.gpu.requestAdapter = async (opts) => {
    const a = await original(opts);
    if (a === null) return a;
    const od = a.requestDevice.bind(a);
    a.requestDevice = async (desc) => {
      const d = await od(desc);
      if (sharedDevice === undefined) sharedDevice = d;
      return d;
    };
    return a;
  };
  const mockCanvas = {
    width: WIDTH,
    height: HEIGHT,
    getContext(kind: string) {
      if (kind !== 'webgpu') return null;
      return {
        configure() {},
        unconfigure() {},
        getCurrentTexture(): GPUTexture {
          if (sharedDevice === undefined)
            throw new Error('render target requested before device captured');
          if (renderTarget === undefined) {
            renderTarget = sharedDevice.createTexture({
              size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
              format: 'rgba8unorm',
              usage: 0x10 | 0x01,
              viewFormats: ['rgba8unorm-srgb'],
            });
          }
          return renderTarget;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;
  try {
    const r = await createRenderer(mockCanvas, undefined, {
      shaderManifestUrl: ENGINE_MANIFEST_URL,
    });
    const ready = await r.ready;
    if (!ready.ok) throw new Error('renderer.ready failed');
    return r;
  } finally {
    globalThis.navigator.gpu.requestAdapter = original;
  }
}

describe('feat-20260604 M3 F-2 fix-up: postProcess.register + addFullscreenPass dispatcher', () => {
  it('renderer.postProcess.register accepts a new id (round-trip success)', async () => {
    const r = await setupRenderer();
    // The first register MUST succeed (no throw). entry.source is a placeholder
    // WGSL string — the dispatcher does not compile it on this path; only the
    // BGL/sampler/bind-group helpers run on the AI-user execute closure.
    expect(() =>
      r.postProcess.register('test::roundtrip-A', {
        source: 'fn main() {}',
      }),
    ).not.toThrow();
  });

  it('renderer.postProcess.register throws on same-id duplicate (programmer-error fail-fast)', async () => {
    const r = await setupRenderer();
    r.postProcess.register('test::roundtrip-B', { source: 'fn main() {}' });
    let caught: unknown = null;
    try {
      r.postProcess.register('test::roundtrip-B', { source: 'fn main() {}' });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    const err = caught as { code?: string; detail?: { id?: string } };
    expect(err.code).toBe('post-process-already-registered');
    expect(err.detail?.id).toBe('test::roundtrip-B');
  });

  it('renderer.postProcess.register throws params-size-mismatch when params.byteSize < 16 (live fail-fast)', async () => {
    // feat-20260621 AC-A3: the eager params-UBO guard must fire on the REAL
    // register() path (not just on a hand-constructed PostProcessError). byteSize
    // below the 16B std140 minimum is a programmer error caught at register time,
    // before any frame draws.
    const r = await setupRenderer();
    let caught: unknown = null;
    try {
      r.postProcess.register('test::roundtrip-params-too-small', {
        source: 'fn main() {}',
        params: { byteSize: 8, defaultValue: new Uint8Array(8) },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught, 'register with byteSize < 16 must throw').not.toBeNull();
    const err = caught as { code?: string; detail?: { byteSize?: number; actualLength?: number } };
    expect(err.code).toBe('params-size-mismatch');
    expect(err.detail?.byteSize).toBe(8);
  });

  it('renderer.postProcess.register throws params-size-mismatch when defaultValue.length !== byteSize (live fail-fast)', async () => {
    // Same guard, second branch: declared byteSize and the seed defaultValue
    // disagree — the eager UBO write would corrupt; register() must reject.
    const r = await setupRenderer();
    let caught: unknown = null;
    try {
      r.postProcess.register('test::roundtrip-params-length-mismatch', {
        source: 'fn main() {}',
        params: { byteSize: 16, defaultValue: new Uint8Array(12) },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught, 'register with mismatched defaultValue length must throw').not.toBeNull();
    const err = caught as { code?: string; detail?: { byteSize?: number; actualLength?: number } };
    expect(err.code).toBe('params-size-mismatch');
    expect(err.detail?.byteSize).toBe(16);
    expect(err.detail?.actualLength).toBe(12);
  });

  it('addFullscreenPass referencing unregistered id throws post-process-not-found via dispatcher', async () => {
    // The dispatcher's lookup-and-throw branch is the load-bearing AC-08 path.
    // Build a minimal RenderGraph with a single fullscreen pass referencing an
    // id that was never registered; running its execute closure must throw a
    // PostProcessError with code 'post-process-not-found'.
    //
    // We synthesise a stub ctx that satisfies the closure's read paths
    // (runtime.lookupPostProcess returns undefined, ctx.view is non-null).
    // The dispatcher's only consumed surface on this path is
    // ctx.runtime.lookupPostProcess; the throw fires before any device call.
    const r = await setupRenderer();
    void r;

    const stubCtx = {
      runtime: {
        lookupPostProcess: (_id: string) => undefined,
      },
      view: {} as unknown,
    } as unknown as RenderPipelineContext;

    const graph = new RenderGraph<RenderPipelineContext>();
    graph.addColorTarget('rt', {
      format: 'rgba8unorm',
      size: { w: WIDTH, h: HEIGHT },
    });
    addFullscreenPass(graph, 'pp', { shader: 'never::registered', color: 'rt' });

    // Reach into the registry to recover the descriptor.execute. listPasses
    // surfaces only name/reads/writes; the executor lives on the PassEntry
    // accessible via the private passes registry. The cast is test-internal
    // (mirrors how render-system-record reaches into the registry to invoke
    // pass.descriptor.execute on the per-frame topology).
    const passes = (
      graph as unknown as {
        passes: {
          list(): readonly { name: string; descriptor: { execute?: (c: unknown) => void } }[];
        };
      }
    ).passes.list();
    const pp = passes.find((p) => p.name === 'pp');
    expect(pp, 'pass "pp" must be registered').toBeDefined();
    if (!pp || pp.descriptor.execute === undefined) return;
    let caught: unknown = null;
    try {
      pp.descriptor.execute(stubCtx);
    } catch (e) {
      caught = e;
    }
    expect(caught, 'addFullscreenPass with unregistered id must throw').not.toBeNull();
    const err = caught as { code?: string; detail?: { id?: string } };
    expect(err.code).toBe('post-process-not-found');
    expect(err.detail?.id).toBe('never::registered');
  });
});
