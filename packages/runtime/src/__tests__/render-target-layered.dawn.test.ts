import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { encodeRgbaPng, offscreenCanvas } from './hdr-evidence.fixture';
import {
  assertLayeredEvidence,
  assertReplayEvidence,
  LAYERED_CANVAS_SIZE,
  type LayeredCostShape,
  layerSheet,
  measureLayeredCost,
  median,
  replayLayeredTapes,
  toSrgbBytes,
  verifyLayeredTargets,
} from './render-target-layered.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const layeredPackage = fileURLToPath(
  new URL('./fixtures/layered-target/layered-target.pack.json', import.meta.url),
);
const manifestUrl = shaderManifestUrl(
  await buildEngineShaderManifest({ materialPackages: [layeredPackage] }),
);
const directory = 'artifacts/pr-evidence/rt-3d-array/dawn';

it('renders 3D slices and array layers, samples them in a material, reads back and replays', {
  timeout: 180_000,
}, async () => {
  const canvas = offscreenCanvas(LAYERED_CANVAS_SIZE);
  const recorder = attachRecorder(webgpu).unwrap();
  const host = await constructRuntimeRendererHost(
    canvas.canvas,
    { rhi: recorder.backend.rhi },
    { shaderManifestUrl: manifestUrl },
  );
  if (!host.ok) throw new Error(JSON.stringify(host.error));
  mkdirSync(directory, { recursive: true });
  try {
    const evidence = await verifyLayeredTargets(host.value.renderer, recorder);
    writeFileSync(
      `${directory}/canvas.png`,
      encodeRgbaPng(toSrgbBytes(evidence.canvas), LAYERED_CANVAS_SIZE, 2),
    );
    writeFileSync(
      `${directory}/target-layers.png`,
      encodeRgbaPng(
        toSrgbBytes(layerSheet(evidence.volumeLayers, evidence.arrayLayers)),
        LAYERED_CANVAS_SIZE,
        2,
      ),
    );
    writeFileSync(`${directory}/volume-frame.rhitape`, evidence.volumeTape.bytes);
    writeFileSync(`${directory}/array-frame.rhitape`, evidence.arrayTape.bytes);
    assertLayeredEvidence(evidence);
    const replay = await replayLayeredTapes(webgpu, evidence);
    writeFileSync(
      `${directory}/replay-target-layers.png`,
      encodeRgbaPng(
        toSrgbBytes(layerSheet(replay.replayVolumeImages, replay.replayArrayImages)),
        LAYERED_CANVAS_SIZE,
        2,
      ),
    );
    writeFileSync(
      `${directory}/evidence.json`,
      JSON.stringify(
        {
          backend: 'dawn',
          frames: evidence.frames,
          readbackLayers: evidence.readbackLayers,
          canvasQuads: evidence.canvasQuads,
          falsifier: evidence.falsifier,
          replay: {
            volumeDigest: replay.volumeDigest,
            arrayDigest: replay.arrayDigest,
            volumeWrites: replay.volumeWrites,
            arrayWrites: replay.arrayWrites,
            replayLayers: replay.replayLayers,
            maxLiveReplayDelta: replay.maxLiveReplayDelta,
            falsifier: replay.falsifier,
          },
        },
        null,
        2,
      ),
    );
    assertReplayEvidence(replay);
  } finally {
    host.value.renderer.dispose();
    canvas.destroy();
    (await recorder.dispose()).unwrap();
  }
});

it('records CPU draw and GPU cost of a layered writer against a 2D writer', {
  timeout: 180_000,
}, async () => {
  const canvas = offscreenCanvas(LAYERED_CANVAS_SIZE);
  const host = await constructRuntimeRendererHost(
    canvas.canvas,
    {
      rhi: webgpu.rhi,
      gpuPassTiming: { maxPassesPerFrame: 64, maxFramesInFlight: 2, retentionFrames: 8 },
    },
    { shaderManifestUrl: manifestUrl },
  );
  if (!host.ok) throw new Error(JSON.stringify(host.error));
  mkdirSync(directory, { recursive: true });
  try {
    // Interleave runs so machine drift affects both shapes.
    const runs = [];
    for (let round = 0; round < 3; round++)
      for (const shape of ['2d', '3d', '2d-array'] as const)
        runs.push(await measureLayeredCost(host.value.renderer, shape));
    const summarize = (shape: LayeredCostShape) => {
      const selected = runs.filter((run) => run.shape === shape);
      return {
        cpuDrawMedianMs: median(selected.flatMap((run) => run.cpuDrawMilliseconds)),
        gpuFrameMedianNs: median(selected.flatMap((run) => run.gpuFrameNanoseconds)),
        gpuSamples: selected.reduce((sum, run) => sum + run.gpuFrameNanoseconds.length, 0),
        timingStatus: selected.map((run) => run.timingStatus),
      };
    };
    const summary = {
      backend: 'dawn',
      writersPerFrame: 1,
      baseline2d: summarize('2d'),
      volume3d: summarize('3d'),
      array2d: summarize('2d-array'),
    };
    writeFileSync(`${directory}/perf.json`, JSON.stringify(summary, null, 2));
    expect(summary.volume3d.cpuDrawMedianMs).toBeGreaterThan(0);
  } finally {
    host.value.renderer.dispose();
    canvas.destroy();
  }
});
