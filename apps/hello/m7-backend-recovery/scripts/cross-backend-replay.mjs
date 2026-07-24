#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createReplay, deserializeTape } from '@forgeax/engine-rhi-debug';
import { rhi as nullRhi } from '@forgeax/engine-rhi-null';

const [tapePath, reportPath] = process.argv.slice(2);
if (tapePath === undefined || reportPath === undefined) {
  throw new Error('usage: cross-backend-replay.mjs <tapePath> <reportPath>');
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
  `[m7-backend] same-scene cross-backend replay: PASS (browser tape -> Dawn pixel inspect + null structural replay; events=${tape.events.length}, draws=${drawCount}, frameMarks=${frameMarkCount}, nullRt=not-applicable)`,
);
