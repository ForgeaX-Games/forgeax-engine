#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { create as createDawn, globals as dawnGlobals } from 'webgpu';
import { PNG } from 'pngjs';
import { createReplay, deserializeTape, pixelDeltaAbsMean } from '@forgeax/engine-rhi-debug';
import { rhi as nullRhi } from '@forgeax/engine-rhi-null';
import { createShaderModule, rhi as webgpuRhi } from '@forgeax/engine-rhi-webgpu';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const [tapePath, reportPath, livePngPath] = process.argv.slice(2);
if (tapePath === undefined || reportPath === undefined) {
  throw new Error('usage: cross-backend-replay.mjs <tapePath> <reportPath> [livePngPath]');
}

const report = JSON.parse(await readFile(reportPath, 'utf8'));
const tapeResult = deserializeTape(
  JSON.stringify({ header: report.header, events: report.events }),
  new Uint8Array(await readFile(tapePath)),
);
if (!tapeResult.ok) {
  throw new Error(`deserializeTape failed: ${tapeResult.error.code} (${tapeResult.error.hint})`);
}

const tape = tapeResult.value;
const drawCount = tape.events.filter(
  (event) =>
    event.kind === 'draw' ||
    event.kind === 'drawIndexed' ||
    event.kind === 'drawIndirect' ||
    event.kind === 'drawIndexedIndirect' ||
    event.kind === 'dispatchWorkgroups',
).length;
const frameMarkCount = tape.events.filter((event) => event.kind === 'frameMark').length;
if (drawCount === 0 || frameMarkCount === 0) {
  throw new Error(`browser tape lacks dynamic evidence: draws=${drawCount} frameMarks=${frameMarkCount}`);
}

Object.assign(globalThis, dawnGlobals);
if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
}
const dawnGpu = createDawn([]);
Object.defineProperty(globalThis.navigator, 'gpu', {
  value: dawnGpu,
  configurable: true,
  writable: true,
});
dawnGpu.getPreferredCanvasFormat = () => 'rgba8unorm';
const dawnAdapterResult = await webgpuRhi.requestAdapter();
if (!dawnAdapterResult.ok) {
  throw new Error(`Dawn adapter failed: ${dawnAdapterResult.error.code} (${dawnAdapterResult.error.hint})`);
}
const dawnDeviceResult = await dawnAdapterResult.value.requestDevice({
  requiredLimits: { maxUniformBufferBindingSize: 262144 },
});
if (!dawnDeviceResult.ok) {
  throw new Error(`Dawn device failed: ${dawnDeviceResult.error.code} (${dawnDeviceResult.error.hint})`);
}
const dawnReplayResult = createReplay(tape, dawnDeviceResult.value, createShaderModule);
if (!dawnReplayResult.ok) {
  throw new Error(`Dawn createReplay failed: ${dawnReplayResult.error.code} (${dawnReplayResult.error.hint})`);
}
const dawnReplay = dawnReplayResult.value;
const dawnStepResult = await dawnReplay.stepTo(tape.events.length - 1);
if (!dawnStepResult.ok) {
  throw new Error(`Dawn replay stepTo(${tape.events.length - 1}) failed: ${dawnStepResult.error.code} (${dawnStepResult.error.hint})`);
}
const dawnReadbackResult = await dawnReplay.readbackRt();
if (!dawnReadbackResult.ok) {
  throw new Error(`Dawn replay readback failed: ${dawnReadbackResult.error.code} (${dawnReadbackResult.error.hint})`);
}
const dawnReadback = dawnReadbackResult.value;
const dawnLitBytes = dawnReadback.pixels.reduce((count, byte) => count + (byte > 8 ? 1 : 0), 0);
if (dawnReadback.width <= 0 || dawnReadback.height <= 0 || dawnLitBytes === 0) {
  throw new Error(
    `Dawn replay produced an empty render target: ${dawnReadback.width}x${dawnReadback.height} litBytes=${dawnLitBytes}`,
  );
}
let livePixelDelta;
if (livePngPath !== undefined) {
  // Browser toDataURL() may select adaptive PNG row filters; use pngjs for
  // decoding rather than the engine smoke codec, whose intentionally tiny
  // decoder only accepts filter=0 reference fixtures.
  const livePng = PNG.sync.read(await readFile(livePngPath));
  const live = { width: livePng.width, height: livePng.height, pixels: new Uint8Array(livePng.data) };
  if (live.width !== dawnReadback.width || live.height !== dawnReadback.height) {
    throw new Error(
      `Dawn/live dimensions differ: dawn=${dawnReadback.width}x${dawnReadback.height} live=${live.width}x${live.height}`,
    );
  }
  // Playwright preserves the canvas compositor's transparent alpha while the
  // Dawn render target is an opaque WebGPU attachment. Alpha is presentation
  // metadata here, not a cross-backend color signal; compare the RGB payload
  // after making both buffers explicitly opaque.
  const livePixels = new Uint8Array(live.pixels);
  const dawnPixels = new Uint8Array(dawnReadback.pixels);
  for (let i = 3; i < livePixels.length; i += 4) {
    livePixels[i] = 255;
    dawnPixels[i] = 255;
  }
  livePixelDelta = pixelDeltaAbsMean(livePixels, dawnPixels);
  writeFileSync(`${livePngPath}.dawn.png`, writeReferencePng(dawnPixels, dawnReadback.width, dawnReadback.height));
  if (livePixelDelta > 0.1) {
    throw new Error(`Dawn/live pixel delta too large: ${livePixelDelta.toFixed(5)} > 0.1`);
  }
}
dawnReplay.dispose();

const adapterResult = await nullRhi.requestAdapter();
if (!adapterResult.ok) throw new Error(`null adapter failed: ${adapterResult.error.code}`);
const deviceResult = await adapterResult.value.requestDevice();
if (!deviceResult.ok) throw new Error(`null device failed: ${deviceResult.error.code}`);

const replayResult = createReplay(tape, deviceResult.value);
if (!replayResult.ok) {
  throw new Error(`null createReplay failed: ${replayResult.error.code} (${replayResult.error.hint})`);
}
const replay = replayResult.value;
const endIndex = tape.events.length - 1;
const stepResult = await replay.stepTo(endIndex);
if (!stepResult.ok) {
  throw new Error(`null replay stepTo(${endIndex}) failed: ${stepResult.error.code} (${stepResult.error.hint})`);
}
replay.dispose();

console.log(
  `[m7-backend] same-scene cross-backend replay: PASS (browser tape -> Dawn pixel readback + null structural replay; events=${tape.events.length}, draws=${drawCount}, frameMarks=${frameMarkCount}, dawnRt=${dawnReadback.width}x${dawnReadback.height}, dawnLitBytes=${dawnLitBytes}, livePixelDelta=${livePixelDelta === undefined ? 'not-requested' : livePixelDelta.toFixed(5)})`,
);
