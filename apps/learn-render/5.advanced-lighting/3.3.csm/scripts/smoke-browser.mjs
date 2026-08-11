// smoke-browser.mjs -- RHI-debug capture pixel-parity verification for
// learn-render 5.x csm (3.3.csm). Delegates to the shared harness; supplies
// demo identity + live-pixel hook (window.__captureCsm, installed by
// src/main.ts).
// Local-only gate (no Chrome+WebGPU on CI runners).

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-5-advanced-lighting-3-3-csm',
  label: 'learn-render 5.3.3 csm',
  mode: 'pixel',
  liveHook: '__captureCsm',
  rtIdx: 0,
  appDir: dirname(here),
  assertCapture: assertCsmCapture,
  assertTape: assertCsmTape,
});

/** @param {object} report */
function assertCsmCapture(report) {
  const events = report.events;
  const passes = events.filter(
    (event) =>
      event.kind === 'beginRenderPass' &&
      event.colorAttachmentViewHandleIds.length === 0 &&
      typeof event.depthStencilViewHandleId === 'string',
  );
  if (passes.length !== 4) {
    throw new Error(`expected 4 depth-only cascade passes, got ${passes.length}`);
  }
  const depthViews = new Set(passes.map((pass) => pass.depthStencilViewHandleId));
  if (depthViews.size !== 1) {
    throw new Error(`expected one shared cascade atlas view, got ${[...depthViews].join(', ')}`);
  }
  const depthViewId = passes[0].depthStencilViewHandleId;
  const depthView = events.find(
    (event) => event.kind === 'createTextureView' && event.resultHandleId === depthViewId,
  );
  const depthTexture = events.find(
    (event) => event.kind === 'createTexture' && event.handleId === depthView?.sourceHandleId,
  );
  const size = depthTexture?.desc?.size;
  if (
    depthTexture?.desc?.format !== 'depth32float' ||
    size?.width !== 4096 ||
    size?.height !== 4096 ||
    size?.depthOrArrayLayers !== 1
  ) {
    throw new Error(`cascade atlas lineage is not 4096x4096 depth32float: ${JSON.stringify(depthTexture?.desc)}`);
  }
  for (const pass of passes) {
    const begin = events.indexOf(pass);
    const end = events.findIndex((event, index) => index > begin && event.kind === 'endRenderPass');
    const body = events.slice(begin, end < 0 ? events.length : end);
    if (body.filter((event) => event.kind === 'drawIndexed').length < 10) {
      throw new Error(`cascade pass at event ${begin} did not record scene indexed draws`);
    }
  }
  const sceneDepthBgl = events.find(
    (event) =>
      event.kind === 'createBindGroupLayout' &&
      event.desc?.label === 'fullscreen-post-with-scene-depth-bgl',
  );
  const depthEntry = sceneDepthBgl?.desc?.entries?.find((entry) => entry.binding === 3);
  if (depthEntry?.texture?.sampleType !== 'depth' || depthEntry.texture.viewDimension !== '2d') {
    throw new Error('cascade overlay BGL does not declare a 2d depth read');
  }
}

/** @param {{ tape: { events: readonly object[], blobPool: Map<string, ArrayBuffer> } }} input */
function assertCsmTape({ tape }) {
  const events = tape.events;
  const depthPasses = events.filter(
    (event) =>
      event.kind === 'beginRenderPass' &&
      event.colorAttachmentViewHandleIds.length === 0 &&
      typeof event.depthStencilViewHandleId === 'string',
  );
  const depthViewId = depthPasses[0]?.depthStencilViewHandleId;
  const viewBgl = events.find(
    (event) => event.kind === 'createBindGroupLayout' && event.desc?.label === 'pbr-view-bgl',
  );
  const viewGroup = events.find(
    (event) =>
      event.kind === 'createBindGroup' &&
      event.layoutHandleId === viewBgl?.handleId &&
      event.resourceHandleIds?.some((id) => id === depthViewId),
  );
  if (!viewGroup) {
    throw new Error('pbr-view bind group does not retain the cascade depth view');
  }
  const cascadeIndexBufferId = viewGroup.resourceHandleIds[7];
  const cascadeIndexBuffer = events.find(
    (event) => event.kind === 'createBuffer' && event.handleId === cascadeIndexBufferId,
  );
  if (cascadeIndexBuffer?.desc?.size !== 80) {
    throw new Error(`expected 80B cascade-index UBO, got ${JSON.stringify(cascadeIndexBuffer?.desc)}`);
  }
  const readBlob = (hash) => {
    const blob = tape.blobPool.get(hash);
    return blob === undefined ? undefined : new Uint8Array(blob);
  };
  const selectorValues = events
    .filter(
      (event) =>
        event.kind === 'writeBuffer' &&
        event.handleId === cascadeIndexBufferId &&
        event.size === 16,
    )
    .map((event) => new Uint32Array(readBlob(event.dataHash)?.buffer ?? new ArrayBuffer(0))[0]);
  if (selectorValues.length < 4 || ![0, 1, 2, 3].every((value) => selectorValues.includes(value))) {
    throw new Error(`cascade selector writes are not 0..3: ${JSON.stringify(selectorValues)}`);
  }
  const viewBufferId = viewGroup.resourceHandleIds[0];
  const viewBuffer = events.find(
    (event) => event.kind === 'createBuffer' && event.handleId === viewBufferId,
  );
  if (viewBuffer?.desc?.size !== 784) {
    throw new Error(`expected 784B view/split UBO, got ${JSON.stringify(viewBuffer?.desc)}`);
  }
  const viewWrite = events.find(
    (event) => event.kind === 'writeBuffer' && event.handleId === viewBufferId && event.size === 784,
  );
  const viewBytes = viewWrite === undefined ? undefined : readBlob(viewWrite.dataHash);
  if (viewBytes === undefined || viewBytes.byteLength !== 784) {
    throw new Error('view/split UBO write blob is missing');
  }
  const viewFloats = new Float32Array(viewBytes.buffer, viewBytes.byteOffset, viewBytes.byteLength / 4);
  const cameraPosition = [viewFloats[24], viewFloats[25], viewFloats[26]];
  const expectedCameraPosition = [0, 1.5, 6];
  if (
    cameraPosition.some(
      (value, index) =>
        !Number.isFinite(value) || Math.abs(value - expectedCameraPosition[index]) > 0.01,
    )
  ) {
    throw new Error(`camera position lineage is not [0,1.5,6]: ${JSON.stringify(cameraPosition)}`);
  }
  const splits = [viewFloats[108], viewFloats[112], viewFloats[116], viewFloats[120]];
  const expectedSplits = [3.5, 7.94, 17.31, 50];
  if (splits.some((value, index) => !Number.isFinite(value) || Math.abs(value - expectedSplits[index]) > 0.02)) {
    throw new Error(`camera split values are not recorded in the view UBO: ${JSON.stringify(splits)}`);
  }
  const cascadeMatrixOffsets = [28, 60, 76, 92];
  const cascadeMatrices = cascadeMatrixOffsets.map((offset) => viewFloats.slice(offset, offset + 16));
  if (
    cascadeMatrices.some(
      (matrix) => matrix.length !== 16 || matrix.some((value) => !Number.isFinite(value)) || matrix.every((value) => value === 0),
    )
  ) {
    throw new Error('one or more cascade lightViewProj matrices are missing from the View UBO');
  }
  const adjacentMatrixDelta = cascadeMatrices.slice(1).map((matrix, index) =>
    Math.max(...matrix.map((value, element) => Math.abs(value - cascadeMatrices[index][element]))),
  );
  if (adjacentMatrixDelta.some((delta) => delta < 0.0001)) {
    throw new Error(`cascade lightViewProj matrices are not depth-derived: ${JSON.stringify(adjacentMatrixDelta)}`);
  }
  const cascadeCount = viewFloats[124];
  const cascadeBlend = viewFloats[125];
  if (!Number.isFinite(cascadeCount) || Math.abs(cascadeCount - 4) > 0.01) {
    throw new Error(`expected cascadeCount=4 in the View UBO, got ${cascadeCount}`);
  }
  if (!Number.isFinite(cascadeBlend) || Math.abs(cascadeBlend - 0.2) > 0.01) {
    throw new Error(`expected cascadeBlend=0.2 in the View UBO, got ${cascadeBlend}`);
  }
  console.log(
    `[csm] View UBO lineage camera=${JSON.stringify(cameraPosition)} ` +
      `matrixDelta=${JSON.stringify(adjacentMatrixDelta)} count=${cascadeCount} blend=${cascadeBlend}`,
  );
  if (viewFloats.slice(0, 16).every((value) => value === 0 || !Number.isFinite(value))) {
    throw new Error('camera matrix region in the view UBO is empty');
  }
}
