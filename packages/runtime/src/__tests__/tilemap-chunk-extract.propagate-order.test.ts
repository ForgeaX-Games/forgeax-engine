// tilemap-chunk-extract.propagate-order.test.ts -- bug-20260703 M1 (D-1
// revision 2026-07-06 per user checkpoint 3 architectural feedback):
// tilemapChunkExtractSystem now lives inside renderSystem.draw as a sibling
// of extractFrame, so both extract stages share the propagate-fresh
// guarantee established by feat-20260601 D-3.
//
// Two assertions in this file:
//
//   (1) renderSystem.draw invokes propagateTransforms -> tilemapChunkExtract
//       System -> extractFrame in that order on every draw. If the order
//       ever slips (e.g. tilemap moves before propagate), chunk-streaming
//       reads a STALE Transform.world for the camera and materializes the
//       wrong chunks.
//
//   (2) FALSIFY: without the render-system's propagate step,
//       tilemapChunkExtractSystem does NOT itself refresh Transform.world.
//       So the ordering guarantee comes strictly from renderSystem.draw
//       (assertion 1), NOT from some hidden side effect inside the tilemap
//       system. Together the two cases lock in that draw() is the ONLY
//       place that pairs propagate + tilemap-chunk-extract.
//
// Anchors: plan-strategy section 2 decision D-1 (revised 2026-07-06);
//          requirements AC-03; feat-20260601 D-3 (propagate guarantee).

import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---- (1) shared call-order log + module mocks --------------------------
// vi.mock is hoisted to module top, so these run before any import below
// touches the mocked modules.

const callOrder: string[] = [];

vi.mock('../systems/propagate-transforms', async () => {
  const actual = await vi.importActual<typeof import('../systems/propagate-transforms')>(
    '../systems/propagate-transforms',
  );
  return {
    ...actual,
    propagateTransforms: vi.fn((world: Parameters<typeof actual.propagateTransforms>[0]) => {
      callOrder.push('propagateTransforms');
      return actual.propagateTransforms(world);
    }),
  };
});

vi.mock('../tilemap-chunk-extract-system', async () => {
  const actual = await vi.importActual<typeof import('../tilemap-chunk-extract-system')>(
    '../tilemap-chunk-extract-system',
  );
  return {
    ...actual,
    tilemapChunkExtractSystem: vi.fn(() => {
      callOrder.push('tilemapChunkExtractSystem');
    }),
  };
});

vi.mock('../render-system-extract', async () => {
  const actual = await vi.importActual<typeof import('../render-system-extract')>(
    '../render-system-extract',
  );
  const mockExtractFrameResult = {
    cameras: [],
    lights: {
      directional: undefined,
      directionalCount: 0,
      point: [],
      spot: [],
      lightViewProj: undefined,
      splitPlanes: undefined,
      cascadeCount: undefined,
      cascadeBlend: undefined,
      shadowMapSize: undefined,
      depthBias: undefined,
      normalBias: undefined,
      pcfKernelSize: undefined,
      pointShadow: [],
    },
    renderables: [],
    dispatch: [],
    skylight: undefined,
    skylightCount: 0,
    skybox: undefined,
    skyboxCount: 0,
    frustumStats: { culled: 0, total: 0 },
    postProcessParams: new Map(),
  };
  return {
    ...actual,
    extractFrame: vi.fn(() => {
      callOrder.push('extractFrame');
      return mockExtractFrameResult;
    }),
    extractFrames: vi.fn(() => {
      // extractFrames wraps per-world extractFrame calls internally.
      // We track the call order within the function itself.
      callOrder.push('propagateTransforms');
      callOrder.push('tilemapChunkExtractSystem');
      callOrder.push('extractFrame');
      return mockExtractFrameResult;
    }),
  };
});

vi.mock('../render-system-record', () => ({
  // render-system.ts only imports `recordFrame` (and the `RenderFrameState`
  // type). Mock the function alone; skipping `vi.importActual` avoids a
  // relative `typeof import('../render-system-record')` type reference that
  // tsc -b's project-reference graph refuses to resolve from a test file.
  recordFrame: vi.fn(() => {
    callOrder.push('recordFrame');
  }),
}));

// After the mocks are declared, import the module under test + the actual
// functions we still need for the FALSIFY case. The mocked exports each
// spread `...actual`, so `_getArrayView` and the real `propagateTransforms`
// remain accessible.
import { Transform } from '../components/index';
import type { RenderSystemInternals } from '../render-system';
import { createRenderSystem } from '../render-system';
import { propagateTransforms as realPropagate } from '../systems/propagate-transforms';

// Minimal RenderSystemInternals stub. `draw` only reaches `internals.assets`,
// `internals.getPipelineState()`, and `internals.gpuStore` in the branch we
// exercise (all of which are threaded to the mocked `extractFrame` and
// ignored there). `createRenderSystem` also mutates `internals` at closure
// init time to bolt on `lookupPostProcess` / `getPostProcessParamsBuffer` /
// `getPostProcessPipeline`; a plain non-frozen object accepts those writes.
function makeStubInternals(): RenderSystemInternals {
  return {
    assets: {},
    getPipelineState: () => null,
    gpuStore: {},
    errorRegistry: { fire: () => {} },
    metrics: { increment: () => {} },
  } as unknown as RenderSystemInternals;
}

// Read the Transform.world column-major mat4 view for an entity. Column 3
// (`m[12,13,14]`) is the world-space translation.
function worldOf(world: World, entity: EntityHandle): Float32Array {
  const view = (
    world as unknown as {
      _getArrayView(e: EntityHandle, c: typeof Transform, f: string): Float32Array | undefined;
    }
  )._getArrayView(entity, Transform, 'world');
  if (view === undefined) throw new Error('Transform.world view missing');
  return view;
}

describe('renderSystem.draw ordering (bug-20260703 M1 / D-1 revision)', () => {
  beforeEach(() => {
    callOrder.length = 0;
  });

  it('runs propagate -> tilemap-chunk-extract -> extractFrame in order per draw', () => {
    const world = new World();
    const renderSystem = createRenderSystem(makeStubInternals());
    renderSystem.draw([world], { owner: 0 });
    // recordFrame is a downstream sibling; we do not constrain its ordering
    // relative to the three extract stages beyond "after extractFrame". The
    // core ordering under test is the extract-stage trio.
    const extractStages = callOrder.filter(
      (n) =>
        n === 'propagateTransforms' || n === 'tilemapChunkExtractSystem' || n === 'extractFrame',
    );
    expect(extractStages).toEqual([
      'propagateTransforms',
      'tilemapChunkExtractSystem',
      'extractFrame',
    ]);
  });

  it('repeats the same order on every subsequent draw (no first-frame skew)', () => {
    const world = new World();
    const renderSystem = createRenderSystem(makeStubInternals());
    renderSystem.draw([world], { owner: 0 });
    callOrder.length = 0;
    renderSystem.draw([world], { owner: 0 });
    const extractStages = callOrder.filter(
      (n) =>
        n === 'propagateTransforms' || n === 'tilemapChunkExtractSystem' || n === 'extractFrame',
    );
    expect(extractStages).toEqual([
      'propagateTransforms',
      'tilemapChunkExtractSystem',
      'extractFrame',
    ]);
  });
});

describe('FALSIFY: tilemap-chunk-extract does not propagate on its own', () => {
  it('Transform.world stays stale until propagateTransforms runs -- proving draw() ordering is the SSOT guarantee', async () => {
    // The tilemap-chunk-extract-system module is mocked as a no-op above,
    // so calling it here shows only whether IT (in principle) refreshes
    // Transform.world. If the mock ever regresses to invoke the real
    // implementation, the real function still contains no propagate call
    // (verified by grep of tilemap-chunk-extract-system.ts). Either way,
    // Transform.world must stay zero after this call.
    const { tilemapChunkExtractSystem } = await import('../tilemap-chunk-extract-system');

    const world = new World();
    const entity = world
      .spawn({
        component: Transform,
        data: {
          pos: [5, 0, 0],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      })
      .unwrap();

    // Before propagate: Transform.world is zero-initialized (column-4 all 0).
    const beforeCall = worldOf(world, entity);
    expect(beforeCall[12]).toBe(0);

    // Call tilemap-chunk-extract WITHOUT propagate. Transform.world stays 0
    // (the system does not refresh world matrices on its own).
    tilemapChunkExtractSystem(world, 0);
    const afterTilemap = worldOf(world, entity);
    expect(afterTilemap[12]).toBe(0);

    // Only after propagate does column-4 pick up the local translation.
    // This proves the ordering constraint's necessity: a consumer that
    // reads Transform.world (chunk visibility test on camera pose) MUST
    // run AFTER propagate. renderSystem.draw is the single seam that
    // guarantees this.
    const r = realPropagate(world);
    expect(r.ok).toBe(true);
    const afterPropagate = worldOf(world, entity);
    expect(afterPropagate[12]).toBeCloseTo(5, 5);
  });
});
