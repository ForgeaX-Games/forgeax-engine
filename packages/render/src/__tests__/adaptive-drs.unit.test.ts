import { describe, expect, it } from 'vitest';
import {
  DynamicResolutionController,
  gpuPassFrameMilliseconds,
} from '../pipeline/dynamic-resolution';
import { createGpuPassTimingFrame } from '../record/gpu-pass-timing/contract';

const parameters = { targetGpuMs: 16, minScale: 0.5, maxScale: 1 };
const owner = {};
const configure = (
  controller: DynamicResolutionController,
  overrides = {},
  camera = 1,
  width = 960,
  generation = 1,
) => {
  const extent = controller.configure(
    { ...parameters, ...overrides },
    owner,
    camera,
    width,
    540,
    generation,
    true,
  );
  if (extent === undefined) throw new Error('missing DRS extent');
  return extent;
};
async function sample(controller: DynamicResolutionController, ms: number | undefined) {
  controller.observe(Promise.resolve(ms));
  await Promise.resolve();
  await Promise.resolve();
}

describe('adaptive DRS feedback', () => {
  it('converges under a pixel-bound GPU load and slowly restores quality after recovery', async () => {
    const controller = new DynamicResolutionController();
    let extent = configure(controller);
    for (let frame = 0; frame < 96; frame++) {
      controller.commit(extent);
      await sample(controller, 30 * extent.scale ** 2 + 1);
      extent = configure(controller);
    }
    expect(extent.scale).toBeLessThan(0.8);
    expect(30 * extent.scale ** 2 + 1).toBeLessThan(16.8);
    expect(extent.outputWidth).toBe(960);
    const low = extent.scale;
    for (let frame = 0; frame < 160; frame++) {
      await sample(controller, 5);
      extent = configure(controller);
    }
    expect(extent.scale).toBe(1);
    expect(low).toBeGreaterThanOrEqual(0.5);
  });

  it('holds near the budget and ignores isolated spikes, invalid timings and absent samples', async () => {
    const controller = new DynamicResolutionController();
    configure(controller);
    for (let frame = 0; frame < 80; frame++) await sample(controller, frame === 1 ? 28 : 16);
    expect(configure(controller).scale).toBe(1);
    for (const ms of [undefined, 0, NaN, Infinity, -1]) await sample(controller, ms);
    expect(configure(controller).scale).toBe(1);
    expect(controller.inspect()?.status).toBe('warming');
    // A CPU stall contributes no GPU sample and cannot lower resolution.
    for (let frame = 0; frame < 60; frame++) expect(configure(controller).scale).toBe(1);
  });

  it.each([
    'camera',
    'resize',
    'device',
    'parameters',
    'disable',
    'detach',
  ] as const)('rejects a delayed sample after %s and bounds in-flight feedback', async (change) => {
    const controller = new DynamicResolutionController();
    configure(controller);
    let complete!: (ms: number) => void;
    controller.observe(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    expect(controller.needsSample).toBe(false);
    if (change === 'camera') configure(controller, {}, 2);
    if (change === 'resize') configure(controller, {}, 1, 640);
    if (change === 'device') configure(controller, {}, 1, 960, 2);
    if (change === 'parameters') configure(controller, { targetGpuMs: 8 });
    if (change === 'disable') controller.configure(undefined, owner, 1, 960, 540, 1, true);
    if (change === 'detach') controller.reset();
    expect(controller.needsSample).toBe(false);
    complete(100);
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.inspect()?.gpuMs).toBeUndefined();
    expect(configure(controller).scale).toBe(1);
  });

  it('preserves fixed scaling, explicit unsupported fallback and accepted extent isolation', async () => {
    const controller = new DynamicResolutionController();
    const fixed = configure(controller, { minScale: 0.75, maxScale: 0.75 });
    controller.commit(fixed);
    expect(controller.inspect()).toMatchObject({ status: 'fixed', extent: { scale: 0.75 } });
    expect(controller.needsSample).toBe(false);
    const fallback = controller.configure(parameters, owner, 1, 960, 540, 1, false);
    expect(fallback?.scale).toBe(1);
    expect(controller.inspect()).toMatchObject({ status: 'unavailable', extent: { scale: 0.75 } });
    expect(controller.needsSample).toBe(false);
    configure(controller);
    controller.commit(configure(controller));
    for (let frame = 0; frame < 8; frame++) await sample(controller, 100);
    expect(configure(controller).scale).toBeLessThan(1);
    expect(controller.inspect()?.extent?.scale).toBe(1);
  });

  it('keeps non-grid authored bounds and tiny output dimensions valid', async () => {
    const controller = new DynamicResolutionController();
    const bounds = { minScale: 0.67, maxScale: 0.9 };
    configure(controller, bounds);
    for (let i = 0; i < 100; i++) await sample(controller, 100);
    expect(configure(controller, bounds).scale).toBeGreaterThanOrEqual(0.67);
    for (let i = 0; i < 100; i++) await sample(controller, 1);
    expect(configure(controller, bounds).scale).toBeLessThanOrEqual(0.9);
    const tiny = controller.configure(parameters, owner, 1, 3, 2, 2, true);
    if (tiny === undefined) throw new Error('missing tiny extent');
    expect([tiny.internalWidth, tiny.internalHeight]).toEqual([3, 2]);
  });

  it('uses elapsed GPU ticks including inter-pass gaps and refuses partial frames', () => {
    const frame = createGpuPassTimingFrame({
      frameId: 1,
      deviceGeneration: 1,
      graphGeneration: 1,
      backendKind: 'webgpu',
      timestampPeriodNanoseconds: 2,
      passCapacity: 2,
      passes: [0, 1].map((index) => ({
        passName: `p${index}`,
        passKind: 'raster',
        executionIndex: index,
        status: 'measured',
        measurementSource: 'pass-boundary',
        beginningTick: String(100 + index * 10_000_000),
        endTick: String(1_000_100 + index * 10_000_000),
        durationNanoseconds: 2_000_000,
      })),
    });
    expect(gpuPassFrameMilliseconds(frame)).toBe(22);
    expect(gpuPassFrameMilliseconds({ ...frame, droppedPassCount: 1 })).toBeUndefined();
    expect(gpuPassFrameMilliseconds({ ...frame, passes: [] })).toBeUndefined();
  });
});
