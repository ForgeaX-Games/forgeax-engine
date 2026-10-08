import { mkdirSync, writeFileSync } from 'node:fs';
import { Camera, CameraView } from '@forgeax/engine-render';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { assert, expect, it } from 'vitest';
import {
  createIrradianceFieldHarness,
  type FieldImage,
  irradianceFieldGi,
  SIZE,
} from './renderer-irradiance-field.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderManifest());
const directory = 'artifacts/irradiance-field/dawn';
mkdirSync(directory, { recursive: true });

const PROBE_BUDGET = 96;
const CARD_BUDGET = 32;
/** Bounded observation window; fairness uses the solo baseline target. */
const LIMIT = 240;
const TOLERANCE = 0.1;

/** Mean of one image half: the left half is view A, the right half view B. */
const half = (image: FieldImage, side: 0 | 1) => {
  let sum = 0;
  for (let y = 0; y < SIZE; y++)
    for (let x = side * (SIZE / 2); x < (side + 1) * (SIZE / 2); x++)
      sum += image.red[y * SIZE + x] ?? 0;
  return sum / ((SIZE * SIZE) / 2);
};
/** First frame after which the series stays within `TOLERANCE` of `reference`. */
const settledAt = (series: readonly number[], reference: number) => {
  let last = -1;
  series.forEach((value, i) => {
    if (Math.abs(value - reference) > TOLERANCE * reference) last = i;
  });
  return last + 1 < series.length ? last + 1 : undefined;
};

it('splits one Renderer GI budget fairly between two CameraViews in different rooms', {
  timeout: 1_500_000,
}, async () => {
  const recorder = attachRecorder(webgpu).unwrap();
  const h = await createIrradianceFieldHarness({
    rhi: recorder.backend.rhi,
    manifest,
    instrumentation: {
      onDeviceLost: () => recorder.deviceLost(),
      resolveSurfaceDevice: (
        device: Parameters<typeof recorder.backend.unwrapDeviceForSurface>[0],
      ) => ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
    },
  });
  const result: Record<string, unknown> = {};
  try {
    // Two rooms behind the harness back wall, split at x = 0 by a wall with a
    // door at z in [0, 1]. Only the left room holds an emitter: the right room
    // is lit through the door alone.
    h.spawn(h.floorMesh, h.white, [0, -1.5, -2]);
    h.spawn(h.floorMesh, h.white, [0, 1.5, -2]);
    const side = await h.slab(0.25, 3, 5);
    h.spawn(side, h.white, [-3.8, 0, -0.5]);
    h.spawn(side, h.white, [3.8, 0, -0.5]);
    h.spawn(await h.slab(0.1, 3, 3), h.white, [0, 0, -1.5]);
    h.spawn(await h.slab(0.1, 3, 1), h.white, [0, 0, 1.5]);
    h.spawn(await h.slab(1.5, 1.5, 0.25), h.emissive, [-2.2, -0.4, -2.7]);

    // View A looks into the lit room, view B into the dark one; each fills half the canvas.
    const lens = { fov: Math.PI / 3, aspect: 0.5, near: 0.1, far: 50 } as const;
    h.world.set(h.camera, Transform, { pos: [-2, 0, 1.7] }).unwrap();
    h.world.set(h.camera, Camera, lens).unwrap();
    const second = h.world
      .spawn(
        { component: Transform, data: { pos: [2, 0, 1.7] } },
        { component: Camera, data: { ...lens, antialias: 0, bloom: 0, tonemap: 0 } },
      )
      .unwrap();
    for (const [i, entity] of [h.camera, second].entries())
      h.world
        .addComponent(entity, {
          component: CameraView,
          data: { viewport: new Float32Array([i * 0.5, 0, 0.5, 1]), order: i },
        })
        .unwrap();

    const gi = irradianceFieldGi({
      hysteresis: 0.5,
      probeBudget: PROBE_BUDGET,
      cardBudget: CARD_BUDGET,
      clipmap: { levels: 2, dimensions: [6, 6, 6] },
    });
    /** Fields of the enabled views, left to right. */
    const viewGi = () => {
      const views = h.renderer.inspect().views;
      assert(views, 'Renderer exposes its view roster');
      return views
        .filter((view) => view.renderedFrames > 0 && view.diffuseGi !== undefined)
        .sort((a, b) => (a.viewport[0] ?? 0) - (b.viewport[0] ?? 0))
        .map((view) => {
          const state = view.diffuseGi;
          assert(
            state && 'gather' in state && state.gather === 'irradiance-field',
            JSON.stringify(view),
          );
          return state;
        });
    };
    type Share = NonNullable<ReturnType<typeof viewGi>[number]['share']>;
    /**
     * Fresh field generation for `views` enabled views, then `LIMIT` frames of
     * both halves from the first ready frame and a long-run reference.
     */
    const converge = async (views: number) => {
      h.setGi(undefined);
      await h.draw();
      h.setGi(gi);
      for (let frame = 0; ; frame++) {
        await h.draw();
        const states = viewGi();
        if (
          states.length === views &&
          states.every((s) => s.state === 'ready' && s.submittedFrames > 0)
        )
          break;
        if (states.some((s) => s.state === 'failed') || frame > 600)
          throw new Error(JSON.stringify({ states, errors: h.errors }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const series: [number[], number[]] = [[], []];
      const shares: Share[][] = [];
      for (let frame = 0; frame < LIMIT; frame++) {
        const image = await h.surfaceImage();
        series[0].push(half(image, 0));
        series[1].push(half(image, 1));
        const split = viewGi().map((state) => {
          assert(state.share, `share missing: ${JSON.stringify(state)}`);
          expect(state.share.views).toBe(views);
          return state.share;
        });
        expect(split.length).toBe(views);
        shares.push(split);
      }
      for (let i = 0; i < 240; i++) await h.draw();
      const tail: FieldImage[] = [];
      for (let i = 0; i < 8; i++) tail.push(await h.surfaceImage());
      const reference = ([0, 1] as const).map(
        (side) => tail.reduce((sum, image) => sum + half(image, side), 0) / tail.length,
      );
      const settled = ([0, 1] as const).map((side) =>
        settledAt(series[side], reference[side] ?? Number.NaN),
      );
      return { series, shares, reference, settled };
    };

    const shared = await converge(2);
    // Every frame both views hold a share and together never exceed the budget.
    for (const split of shared.shares) {
      for (const share of split) {
        expect(share.probes).toBeGreaterThan(0);
        expect(share.captureTiles).toBeGreaterThan(0);
      }
      const total = (key: 'probes' | 'captureTiles' | 'relightTiles') =>
        split.reduce((sum, share) => sum + share[key], 0);
      expect(total('probes')).toBeLessThanOrEqual(PROBE_BUDGET);
      expect(total('relightTiles')).toBeLessThanOrEqual(CARD_BUDGET);
    }
    const { reference, settled } = shared;
    // The emitter room is bright, the other lit only through the door.
    expect(reference[0]).toBeGreaterThan(0);
    expect(reference[1]).toBeGreaterThan(0);
    expect(reference[1]).toBeLessThan(reference[0] ?? 0);
    const trace = JSON.stringify({ series: shared.series, reference });
    expect(settled[0], trace).toBeDefined();
    // Neither view starves: each received half of the probe budget on average.
    const mean = (values: readonly number[]) =>
      values.reduce((sum, v) => sum + v, 0) / values.length;
    const probeShares = [0, 1].map((v) => mean(shared.shares.map((s) => s[v]?.probes ?? 0)));
    for (const share of probeShares) expect(share).toBeCloseTo(PROBE_BUDGET / 2, 0);

    // RHI Debug capture of one budgeted frame: probe traces and Card relights per view.
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    await h.draw();
    (await recorder.frameBoundary()).unwrap();
    const captured = viewGi().map((state) => state.share);
    const encoded = (await pending).unwrap();
    writeFileSync(`${directory}/multiview-frame.rhitape`, encoded.bytes);
    const model = buildFrameModel(decodeTape(encoded.bytes).unwrap());
    const runs = (entryPoint: string) =>
      model.works.filter((work) =>
        work.pipeline.shaders.some((shader) => shader.entryPoint === entryPoint),
      );
    const dispatchX = (work: (typeof model.works)[number]) =>
      (work.drawCall as { x?: number } | null)?.x ?? 0;
    const traces = runs('traceProbes');
    const relights = runs('lightCards');
    // One trace dispatch per view field, together sized by one view's budget.
    expect(traces.length).toBe(2);
    result.capture = {
      digest: encoded.digest,
      works: model.works.length,
      shares: captured,
      traceProbes: traces.map(dispatchX),
      lightCards: relights.map(dispatchX),
      cardDraws: runs('fs_card').length,
    };
    // Baseline: the dark-room view alone holds the whole budget. Sharing must cost
    // it at most the halved budget's slowdown, never starvation.
    h.world.set(h.camera, CameraView, { enabled: false }).unwrap();
    const solo = await converge(1);
    for (const [split] of solo.shares) expect(split?.probes).toBe(PROBE_BUDGET);
    const soloSettled = solo.settled[1];
    assert(soloSettled !== undefined, JSON.stringify(solo.series[1]));
    expect(solo.reference[1]).toBeGreaterThan(0);
    // Fairness compares the time to reach one physical target: the solo
    // baseline's steady dark-room energy. Independent budgeted generations
    // have different stochastic histories; their separate future means are
    // retained below, not used as two different stopping targets.
    const sharedSettled = settledAt(shared.series[1], solo.reference[1] ?? Number.NaN);
    expect(sharedSettled, JSON.stringify({ shared: shared.series[1], solo })).toBeDefined();
    expect(sharedSettled ?? LIMIT).toBeLessThanOrEqual(
      Math.max(2.5 * soloSettled, soloSettled + 32),
    );
    expect(solo.reference[1]).toBeCloseTo(reference[1] ?? 0, 2);
    result.fairness = {
      budget: { probes: PROBE_BUDGET, cards: CARD_BUDGET },
      reference,
      settledFrames: [settled[0], sharedSettled],
      independentSharedSettledFrames: settled,
      solo: { reference: solo.reference[1], settledFrames: soloSettled, series: solo.series[1] },
      meanProbeShares: probeShares,
      series: shared.series.map((s) => s.map((v) => Number(v.toFixed(5)))),
    };
    expect(h.errors).toEqual([]);
  } finally {
    writeFileSync(
      `${directory}/multiview-result.json`,
      JSON.stringify({ result, errors: h.errors, inspection: h.renderer.inspect() }, null, 2),
    );
    await h.dispose();
  }
});
