// smoke-browser.mjs -- RHI-debug capture pixel-parity verification for
// learn-render 5.x csm (3.3.csm). Delegates to the shared harness; supplies
// demo identity + live-pixel hook (window.__captureCsm, installed by
// src/main.ts).
// Local-only gate (no Chrome+WebGPU on CI runners).

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const CSM_ATLAS_TILE_SIZE = 2048;
const CSM_ATLAS_TILES_PER_SIDE = 2;

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-5-advanced-lighting-3-3-csm',
  label: 'learn-render 5.3.3 csm',
  mode: 'pixel',
  liveHook: '__captureCsm',
  rtIdx: 0,
  appDir: dirname(here),
  assertCapture: assertCsmCapture,
  assertTape: assertCsmTape,
  assertPixels: assertCsmPixels,
  urlSuffix: process.env.FALSIFY === 'force-csm-highlight-layer-2' ? '?csm-highlight=2' : '',
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
  assertCsmAtlasTileViewports(events, passes);
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

function assertCsmAtlasTileViewports(events, depthPasses) {
  const actual = depthPasses.map((pass) => {
    const viewport = events.find(
      (event) => event.kind === 'setViewport' && event.passHandleId === pass.passHandleId,
    );
    if (viewport === undefined) {
      throw new Error(`cascade pass ${pass.passHandleId} does not set an atlas viewport`);
    }
    return {
      x: viewport.x,
      y: viewport.y,
      w: viewport.w,
      h: viewport.h,
      minDepth: viewport.minDepth,
      maxDepth: viewport.maxDepth,
    };
  });
  const expected = actual.map((_, index) => ({
    x: (index % CSM_ATLAS_TILES_PER_SIDE) * CSM_ATLAS_TILE_SIZE,
    y: Math.floor(index / CSM_ATLAS_TILES_PER_SIDE) * CSM_ATLAS_TILE_SIZE,
    w: CSM_ATLAS_TILE_SIZE,
    h: CSM_ATLAS_TILE_SIZE,
    minDepth: 0,
    maxDepth: 1,
  }));
  const gated = actual.map((viewport) => ({ ...viewport }));
  if (process.env.FALSIFY === 'force-csm-atlas-tile-duplicate') {
    gated[3] = { ...gated[2] };
    console.log('[csm] FALSIFY=force-csm-atlas-tile-duplicate -- duplicated cascade 2 viewport');
  }
  const mismatch = gated.findIndex((viewport, index) =>
    Object.keys(expected[index]).some((key) => viewport[key] !== expected[index][key]),
  );
  if (mismatch >= 0) {
    throw new Error(
      `cascade atlas tile ${mismatch} viewport is not the derived 2x2 layout: ` +
        `${JSON.stringify({ actual: gated, expected })}`,
    );
  }
  console.log(
    `[csm] atlas tiles=${JSON.stringify(actual.map(({ x, y }) => [x, y]))} ` +
      `tileSize=${CSM_ATLAS_TILE_SIZE}`,
  );
}

function assertCsmAtlasSamplerFormula(shaderCode) {
  let gated = shaderCode;
  if (process.env.FALSIFY === 'force-csm-atlas-sampler-tile-formula') {
    gated = gated.replace(
      /let\s+_e\d+\s*=\s*_atlasTileOrigin[^;]+;/,
      'let _e0 = vec2<f32>(0f);',
    );
    console.log(
      '[csm] FALSIFY=force-csm-atlas-sampler-tile-formula -- replaced sampler tile origin',
    );
  }
  const compact = gated.replace(/\s+/g, '');
  const atlasStart = compact.indexOf('fn_atlasTileOrigin');
  const sampleStart = compact.indexOf('fn_sampleShadowForCascade');
  const sampleEnd = compact.indexOf('fnevalDirectional', sampleStart);
  if (atlasStart < 0 || sampleStart <= atlasStart || sampleEnd <= sampleStart) {
    throw new Error('compiled CSM shader atlas sampler function boundaries are missing');
  }
  const atlas = compact.slice(atlasStart, sampleStart);
  const sample = compact.slice(sampleStart, sampleEnd);
  const required = [
    [/fn_atlasTileOrigin[^)]*\)->vec2<f32>/, atlas],
    [/select\(2u,1u,\(count[^)]*<=1u\)\)/, atlas],
    [/layer[^;]*%tilesPerSide/, atlas],
    [/layer[^;]*\/tilesPerSide/, atlas],
    [/_atlasTileOrigin[^;]+;/, sample],
    [/lettileUv=vec2<f32>\([^;]*projCoords\.x[^;]*projCoords\.y[^;]*\);/, sample],
    [/letuv_\d+=\(\(tileUv\*inv_\d+\)\+_e\d+\);/, sample],
    [/lettileLo=\(_e\d+\+texel_\d+\);/, sample],
    [/lettileHi=\(\(_e\d+\+vec2\(inv_\d+\)\)-texel_\d+\);/, sample],
    [/letoffsetUv=clamp\(\(uv_\d+\+[^;]*texel_\d+\)\),tileLo,tileHi\);/, sample],
  ];
  const missing = required.findIndex(([pattern, source]) => !pattern.test(source));
  if (missing >= 0) {
    throw new Error(`CSM atlas sampler formula is missing source term ${missing}`);
  }
  console.log(
    '[csm] sampler lineage layer->tileOrigin->atlasUv->inTilePcf=accepted',
  );
}

/** @param {{ pixels: Uint8Array, width: number, height: number }} input */
function assertCsmPixels({ pixels, width, height }) {
  let sumRg = 0;
  let sumRgSq = 0;
  let rgCount = 0;
  for (let i = 0; i < width * height; i++) {
    const red = pixels[i * 4] ?? 0;
    const green = pixels[i * 4 + 1] ?? 0;
    if (green > 5) {
      const ratio = red / green;
      sumRg += ratio;
      sumRgSq += ratio * ratio;
      rgCount++;
    }
  }
  const meanRg = rgCount > 0 ? sumRg / rgCount : 0;
  const varianceRg = rgCount > 1 ? sumRgSq / rgCount - meanRg * meanRg : 0;
  const stddevRg = Math.sqrt(Math.max(0, varianceRg));

  const regionAvgRgRatio = (y0, regionHeight) => {
    let redSum = 0;
    let greenSum = 0;
    for (let y = y0; y < y0 + regionHeight; y++) {
      for (let x = 0; x < width; x++) {
        const index = (y * width + x) * 4;
        redSum += pixels[index] ?? 0;
        greenSum += pixels[index + 1] ?? 0;
      }
    }
    return greenSum > 0 ? redSum / greenSum : 999;
  };
  const stripHeight = Math.floor(height * 0.1);
  const bottomRg = regionAvgRgRatio(Math.floor(height * 0.85), stripHeight);
  const topRg = regionAvgRgRatio(0, stripHeight);
  console.log(
    `[csm] pixel cascade bands meanRg=${meanRg.toFixed(3)} stddevRg=${stddevRg.toFixed(4)} ` +
      `bottomRg=${bottomRg.toFixed(3)} topRg=${topRg.toFixed(3)}`,
  );
  if (process.env.FALSIFY === 'force-csm-highlight-layer-2') {
    if (meanRg >= 1.8 || stddevRg >= 0.45) {
      throw new Error(
        `selected cascade c2 pixel signature is missing: meanRg=${meanRg.toFixed(3)} ` +
          `stddevRg=${stddevRg.toFixed(4)}`,
      );
    }
    if (bottomRg >= topRg - 0.05) {
      throw new Error(
        `selected cascade c2 pixel depth gradient is missing: bottomRg=${bottomRg.toFixed(3)} ` +
          `topRg=${topRg.toFixed(3)}`,
      );
    }
    console.log('[csm] selected cascade c2 pixel signature accepted');
    return;
  }
  if (stddevRg < 0.35) {
    throw new Error(`cascade overlay pixel diversity is too low: stddevRg=${stddevRg.toFixed(4)}`);
  }
  if (bottomRg >= topRg - 0.05) {
    throw new Error(
      `cascade overlay pixel depth gradient is missing: bottomRg=${bottomRg.toFixed(3)} topRg=${topRg.toFixed(3)}`,
    );
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
  assertCsmAtlasTileViewports(events, depthPasses);
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

  const overlayBglIds = new Set(
    events
      .filter(
        (event) =>
          event.kind === 'createBindGroupLayout' &&
          event.desc?.label === 'fullscreen-post-with-scene-depth-bgl',
      )
      .map((event) => event.handleId),
  );
  const overlayGroup = events.find(
    (event) => event.kind === 'createBindGroup' && overlayBglIds.has(event.layoutHandleId),
  );
  const overlayParamsBufferId = overlayGroup?.resourceHandleIds?.[2];
  const overlayParamsWrite = events.find(
    (event) =>
      event.kind === 'writeBuffer' &&
      event.handleId === overlayParamsBufferId &&
      event.size === 16,
  );
  const overlayParamsBytes =
    overlayParamsWrite === undefined ? undefined : readBlob(overlayParamsWrite.dataHash);
  const overlayTintMode =
    overlayParamsBytes === undefined || overlayParamsBytes.byteLength < 4
      ? undefined
      : new DataView(
          overlayParamsBytes.buffer,
          overlayParamsBytes.byteOffset,
          overlayParamsBytes.byteLength,
        ).getFloat32(0, true);
  const expectedOverlayTintMode =
    process.env.FALSIFY === 'force-csm-highlight-layer-2' ? 2 : 0;
  if (overlayTintMode !== expectedOverlayTintMode) {
    throw new Error(
      `expected CSM overlay tintMode=${expectedOverlayTintMode}, got ${overlayTintMode}`,
    );
  }
  console.log(`[csm] overlay params tintMode=${overlayTintMode}`);

  const selectorRows = depthPasses.map((pass, expectedIndex) => {
    const begin = events.indexOf(pass);
    const selectorWrite = events
      .slice(0, begin)
      .findLast(
        (event) =>
          event.kind === 'writeBuffer' &&
          event.handleId === cascadeIndexBufferId &&
          event.size === 16,
      );
    const selectorBytes = selectorWrite === undefined ? undefined : readBlob(selectorWrite.dataHash);
    const selector =
      selectorBytes === undefined || selectorBytes.byteLength < 4
        ? undefined
        : new DataView(selectorBytes.buffer, selectorBytes.byteOffset, selectorBytes.byteLength).getUint32(0, true);
    const end = events.findIndex(
      (event, index) => index > begin && event.kind === 'endRenderPass',
    );
    const body = events.slice(begin, end < 0 ? events.length : end);
    const shadowViewGroupId = body.find(
      (event) => event.kind === 'setBindGroup' && event.index === 0,
    )?.bindGroupHandleId;
    const shadowViewGroup = events.find(
      (event) => event.kind === 'createBindGroup' && event.handleId === shadowViewGroupId,
    );
    return {
      expectedIndex,
      selector,
      draws: body.filter((event) => event.kind === 'drawIndexed').length,
      selectorBound: shadowViewGroup?.resourceHandleIds[7] === cascadeIndexBufferId,
    };
  });
  const selectorValues = selectorRows.map((row) => row.selector);
  const gatedSelectorValues = [...selectorValues];
  if (process.env.FALSIFY === 'force-csm-selector-duplicate') {
    gatedSelectorValues[3] = gatedSelectorValues[2];
    console.log('[csm] FALSIFY=force-csm-selector-duplicate -- duplicated cascade 2 selector');
  }
  if (
    gatedSelectorValues.length !== 4 ||
    gatedSelectorValues.some((value, index) => value !== index) ||
    selectorRows.some((row) => row.draws < 10 || !row.selectorBound)
  ) {
    throw new Error(
      `cascade receiver lineage is not ordered 0..3 with bound shadow draws: ${JSON.stringify(selectorRows)}`,
    );
  }

  const receiverPass = events
    .map((event, index) => ({ event, index }))
    .find(({ event, index }) => {
      if (
        event.kind !== 'beginRenderPass' ||
        !event.colorAttachmentViewHandleIds.some((handleId) => typeof handleId === 'string')
      ) {
        return false;
      }
      const end = events.findIndex(
        (candidate, candidateIndex) =>
          candidateIndex > index && candidate.kind === 'endRenderPass',
      );
      return events
        .slice(index, end < 0 ? events.length : end)
        .some((candidate) => candidate.kind === 'drawIndexed');
    });
  if (receiverPass === undefined) {
    throw new Error('CSM receiver render pass with indexed draws is missing');
  }
  const receiverEnd = events.findIndex(
    (event, index) => index > receiverPass.index && event.kind === 'endRenderPass',
  );
  const receiverBody = events.slice(
    receiverPass.index,
    receiverEnd < 0 ? events.length : receiverEnd,
  );
  const receiverViewBindIndex = receiverBody.findIndex(
    (event) =>
      event.kind === 'setBindGroup' &&
      event.index === 0 &&
      event.bindGroupHandleId === viewGroup.handleId,
  );
  if (
    receiverViewBindIndex < 0 ||
    !receiverBody.slice(receiverViewBindIndex).some((event) => event.kind === 'drawIndexed') ||
    viewGroup.resourceHandleIds[3] !== depthViewId
  ) {
    throw new Error('CSM receiver draw does not bind and draw from the cascade atlas view');
  }
  const receiverPipelineId = receiverBody.find((event) => event.kind === 'setPipeline')?.pipelineHandleId;
  const receiverPipeline = events.find(
    (event) => event.kind === 'createRenderPipeline' && event.handleId === receiverPipelineId,
  );
  const receiverShader = events.find(
    (event) =>
      event.kind === 'createShaderModule' &&
      event.handleId === receiverPipeline?.fragmentShaderModuleHandleId,
  );
  const cascadeShaderTerms = [
    '_pickCascadeLayer',
    '_atlasTileOrigin',
    '_sampleShadowForCascade',
    'cascadeBlend',
    'textureSampleCompareLevel',
  ];
  if (
    receiverShader?.wgslCode === undefined ||
    cascadeShaderTerms.some((term) => !receiverShader.wgslCode.includes(term))
  ) {
    throw new Error(`CSM receiver shader does not retain cascade selection/atlas sampling: ${receiverShader?.handleId}`);
  }
  assertCsmAtlasSamplerFormula(receiverShader.wgslCode);
  console.log(
    `[csm] receiver lineage selectors=${JSON.stringify(selectorValues)} ` +
      `atlas=${depthViewId} draws=${receiverBody.filter((event) => event.kind === 'drawIndexed').length}`,
  );
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
