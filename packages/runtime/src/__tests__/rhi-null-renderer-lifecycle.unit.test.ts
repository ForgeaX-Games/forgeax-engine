// feat-20260623-dummy-null-rhi-headless-backend / M3 / w16
// T-a: createRenderer lifecycle dogfood unit test (AC-02/03/11/12)
//
// Five scenarios covering the createRenderer-to-draw lifecycle with the
// RhiNull headless backend injected via Channel 1 escape hatch
// (createRenderer(canvas, { rhi: rhiNull })). All scenarios run in node
// environment; no dawn/browser dependency.
//
// Scenario coverage matrix (plan-strategy D-3):
//   1. createRenderer({rhi: rhiNull}) does not throw
//   2. await renderer.ready does not reject (AC-02 — R-2 createShaderModule)
//   3. renderer.draw(world) does not crash (AC-03 — headless frame)
//   4. await queue.onSubmittedWorkDone() resolves immediately (AC-12)
//   5. renderer.dispose() then draw returns err (lifecycle guard)

import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HANDLE_CUBE } from '../asset-registry';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer, Transform } from '../components';
import type { Renderer } from '../renderer';

const ENGINE = '../createRenderer';

function makeStubCanvas(w = 800, h = 600): HTMLCanvasElement {
  return {
    width: w,
    height: h,
    getContext(_kind: string): unknown {
      return null;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as HTMLCanvasElement;
}

/** Inline shader manifest so ready() doesn't fail fetching /shaders/manifest.json. */
function buildManifestDataUrl(): string {
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
    ],
  };
  return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
}

function makeWorld(): World {
  const world = new World();
  // Camera + Transform on SAME entity (required by extract system)
  world.spawn(
    { component: Transform, data: {} },
    { component: Camera, data: { fov: 60, near: 0.1, far: 1000 } },
  );
  // Light + Transform on same entity
  world.spawn({ component: Transform, data: {} }, { component: DirectionalLight, data: {} });
  // Visible entity: MeshFilter + MeshRenderer + Transform on same entity
  world.spawn(
    { component: Transform, data: {} },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: {} },
  );
  return world;
}

let renderer: Renderer | null = null;

beforeEach(() => {
  vi.stubGlobal('navigator', { gpu: undefined });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (renderer) {
    try {
      renderer.dispose();
    } catch {
      // ignore
    }
    renderer = null;
  }
});

describe('rhi-null-renderer-lifecycle.unit.test.ts (T-a)', () => {
  async function loadEngine() {
    return (await import(ENGINE)) as {
      createRenderer: (
        canvas: HTMLCanvasElement,
        options?: { rhi?: unknown },
        bundler?: { shaderManifestUrl?: string },
      ) => Promise<Renderer>;
    };
  }

  const rhiOptions = {
    rhi: rhi as unknown as {
      requestAdapter: () => unknown;
      acquireCanvasContext: () => unknown;
      createShaderModule: () => unknown;
    },
  };

  const bundler = { shaderManifestUrl: buildManifestDataUrl() };

  it('1. createRenderer({rhi: rhiNull}) does not throw', async () => {
    const engine = await loadEngine();
    const canvas = makeStubCanvas();
    renderer = await engine.createRenderer(canvas, rhiOptions, bundler);
    expect(renderer).toBeDefined();
    expect(renderer.device).toBeDefined();
  });

  it('2. await renderer.ready resolves ok (AC-02 — R-2 createShaderModule)', async () => {
    const engine = await loadEngine();
    const canvas = makeStubCanvas();
    renderer = await engine.createRenderer(canvas, rhiOptions, bundler);
    const ready = await renderer.ready;
    expect(ready.ok).toBe(true);
  });

  it('3. renderer.draw(world) does not crash (AC-03)', async () => {
    const engine = await loadEngine();
    const canvas = makeStubCanvas();
    renderer = await engine.createRenderer(canvas, rhiOptions, bundler);
    await renderer.ready;
    const world = makeWorld();
    renderer.draw(world);
  });

  it('4. await queue.onSubmittedWorkDone() resolves immediately (AC-12)', async () => {
    const engine = await loadEngine();
    const canvas = makeStubCanvas();
    renderer = await engine.createRenderer(canvas, rhiOptions, bundler);
    await renderer.ready;
    const start = performance.now();
    await renderer.device.queue.onSubmittedWorkDone();
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(20);
  });

  it('5. renderer.dispose() then draw returns err (lifecycle guard)', async () => {
    const engine = await loadEngine();
    const canvas = makeStubCanvas();
    renderer = await engine.createRenderer(canvas, rhiOptions, bundler);
    await renderer.ready;
    renderer.dispose();
    const world = makeWorld();
    const drawResult = renderer.draw(world);
    expect(drawResult.ok).toBe(false);
  });

  it("6. no 'rhi-not-available' fires on ready (B-1: headless null backend has no preferred-canvas-format degradation)", async () => {
    const engine = await loadEngine();
    const canvas = makeStubCanvas();
    renderer = await engine.createRenderer(canvas, rhiOptions, bundler);
    const codes: string[] = [];
    renderer.onError((e: { code: string }) => codes.push(e.code));
    await renderer.ready;
    // The 'null' backend's rgba8unorm swap-chain is its intended steady state,
    // not a degraded fallback — selectSwapChainFormat's diagnostic must be
    // suppressed for it (verify round-1 sandbox B-1). Falsifiable: remove the
    // backendKind!=='null' guard in createRenderer and this turns red.
    expect(codes).not.toContain('rhi-not-available');
  });
});
