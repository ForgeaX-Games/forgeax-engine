// feat-20260709-editor-world-partition-editorworld-super-composite / M2 / w10
// (RED — impl lands in w12). Full-chain consumer test on the rhi-null headless
// backend: the drawSource seam drives a REAL Renderer (createRenderer +
// RhiNull) end-to-end — update -> extract -> record — with no GPU.
//
// Unlike w8 (spy renderer, call-shape) and w9 (spy renderer, stale-matrix), this
// test exercises the actual runtime render pipeline through the seam. The camera
// + light + visible mesh live ONLY in the injected world; the frame-loop's own
// world is empty. So a non-zero draw count proves three things at once:
//   1. drawSource is consumed (else the empty loop world is drawn -> 0 draws),
//   2. the injected world was world.update()'d (propagate ran; extract finds the
//      camera + resolved Transform.world),
//   3. the full URP record path fired headlessly (bookkeeper counts draws).
//
// rhi-null needs no GPU: navigator.gpu is stubbed undefined so createRenderer
// selects the injected RhiNull instance, and the RhiNullDevice bookkeeper counts
// draw / bind-group / pipeline records. File suffix `.test.ts` runs in the node
// vitest project (no dawn / no browser).
//
// The frame-loop is driven directly (createFrameLoop + injected now/raf/caf)
// rather than through createApp, because createApp's assemble form does not (yet
// — that is w11) forward drawSource; w12 threads it into the loop. Driving the
// loop directly keeps this test focused on the seam's runtime contract. The
// drawSource option is reached through a typed alias before w12 widens the type.
//
// Anchors:
//   plan-strategy §2 D-3 (drawSource pull -> update injected worlds -> draw)
//   research F1 (frame-loop is the update -> draw driver; the seam insertion pt)
//   feat-20260623 rhi-null-command-flow.unit.test.ts (headless full-chain
//     precedent: createRenderer + RhiNull + bookkeeper counters)

import { World } from '@forgeax/engine-ecs';
import type { RhiNullDevice } from '@forgeax/engine-rhi-null';
import { rhi } from '@forgeax/engine-rhi-null';
import {
  Camera,
  createRenderer,
  DirectionalLight,
  HANDLE_CUBE,
  MeshFilter,
  MeshRenderer,
  type Renderer,
  registerPropagateTransforms,
  Transform,
} from '@forgeax/engine-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFrameLoop, type FrameLoopOptions } from '../internal/frame-loop';

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

function identityTransform(
  overrides: Partial<Record<string, number>> = {},
): Record<string, number> {
  return {
    posX: 0,
    posY: 0,
    posZ: 0,
    quatX: 0,
    quatY: 0,
    quatZ: 0,
    quatW: 1,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    ...overrides,
  };
}

// The injected world carries the FULL renderable set (camera + light + visible
// mesh). It also registers propagateTransforms so the frame-loop's world.update
// resolves Transform.world before extract reads it.
function makeInjectedWorld(): World {
  const world = new World();
  registerPropagateTransforms(world);
  world.spawn(
    { component: Transform, data: identityTransform({ posZ: 5 }) },
    { component: Camera, data: { fov: 60, near: 0.1, far: 1000, tonemap: 4 } },
  );
  world.spawn(
    { component: Transform, data: identityTransform() },
    {
      component: DirectionalLight,
      data: { directionX: 0.5, directionY: -1, directionZ: -0.5, castShadow: true, intensity: 1 },
    },
  );
  world.spawn(
    { component: Transform, data: identityTransform() },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: {} },
  );
  return world;
}

function makeSyncScheduler() {
  let pending: ((t: number) => void) | null = null;
  let clock = 0;
  const raf = (cb: (t: number) => void): number => {
    pending = cb;
    return 1;
  };
  const caf = (): void => {
    pending = null;
  };
  const now = (): number => {
    clock += 16;
    return clock;
  };
  const pump = (frames: number): void => {
    for (let i = 0; i < frames; i++) {
      const cb = pending;
      pending = null;
      if (cb === null) break;
      cb(clock);
    }
  };
  return { raf, caf, now, pump };
}

type DrawSourceCallback = () =>
  | { worlds: readonly World[]; cameraOwner: number; resourceOwner: number }
  | undefined;

type FrameLoopOptionsWithDrawSource = FrameLoopOptions & {
  drawSource?: DrawSourceCallback;
};

const createFrameLoopWithDrawSource = createFrameLoop as unknown as (
  opts: FrameLoopOptionsWithDrawSource,
) => ReturnType<typeof createFrameLoop>;

// The RhiNull instance is a structural stand-in for a real RhiInstance in this
// headless test; cast the options bag to RendererOptions so the direct
// createRenderer import (strict RendererOptions) accepts the injected backend.
const rhiOptions = {
  rhi: rhi as unknown as import('@forgeax/engine-runtime').RendererOptions['rhi'],
} as import('@forgeax/engine-runtime').RendererOptions;

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

describe('drawSource full chain on rhi-null headless (w10)', () => {
  it('drives update -> extract -> record for an injected world with no GPU', async () => {
    const canvas = makeStubCanvas();
    renderer = await createRenderer(canvas, rhiOptions, {
      shaderManifestUrl: buildManifestDataUrl(),
    });
    await renderer.ready;

    const rhiNullDevice = renderer.device as unknown as RhiNullDevice;

    // The frame-loop's own world is EMPTY — it has no camera / mesh, so it
    // records zero draws on its own. Only the injected world is renderable.
    const loopWorld = new World();
    const injectedWorld = makeInjectedWorld();

    const drawSource: DrawSourceCallback = () => ({
      worlds: [injectedWorld],
      cameraOwner: 0,
      resourceOwner: 0,
    });

    const { raf, caf, now, pump } = makeSyncScheduler();
    const loop = createFrameLoopWithDrawSource({
      world: loopWorld,
      renderer: renderer as Renderer,
      now,
      raf,
      caf,
      drawSource,
    });

    // Reset per-frame counters immediately before the observed frame.
    rhiNullDevice.totalDrawCount = 0;
    rhiNullDevice.totalBindGroupCount = 0;
    rhiNullDevice.framePassNames = [];

    expect(loop.start().ok).toBe(true);
    pump(1);
    loop.stop();

    // The full URP record path fired for the INJECTED world: a non-zero draw
    // count is only reachable if drawSource was consumed AND the injected world
    // was updated (camera + resolved Transform.world present for extract).
    expect(rhiNullDevice.totalDrawCount).toBeGreaterThanOrEqual(1);
    expect(rhiNullDevice.totalBindGroupCount).toBeGreaterThanOrEqual(1);
    expect(renderer.perFramePassNames.length).toBeGreaterThan(0);
    expect(renderer.perFramePassNames).toContain('main');
  });
});
