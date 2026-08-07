#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '..', '..', '..');
const defaultChildTimeoutMs = 180_000;

function resolveChildTimeoutMs(rawValue) {
  if (rawValue === undefined) return defaultChildTimeoutMs;
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`FORGEAX_M3_CHILD_TIMEOUT_MS must be a positive integer, received ${JSON.stringify(rawValue)}`);
  }
  return value;
}

const childTimeoutMs = resolveChildTimeoutMs(process.env.FORGEAX_M3_CHILD_TIMEOUT_MS);
console.log(`[m3-programmable] selector child timeout: ${childTimeoutMs} ms`);
const require = createRequire(resolve(repoRoot, 'package.json'));
let PNG;
try {
  ({ PNG } = require('pngjs'));
} catch {
  ({ PNG } = require(
    resolve(repoRoot, 'node_modules/.pnpm/pngjs@7.0.0/node_modules/pngjs/lib/png.js'),
  ));
}

function comparePngs(normalPath, falsifierPath) {
  const normal = PNG.sync.read(readFileSync(normalPath));
  const falsifier = PNG.sync.read(readFileSync(falsifierPath));
  if (normal.width !== falsifier.width || normal.height !== falsifier.height) {
    throw new Error(
      `PNG dimensions differ: normal=${normal.width}x${normal.height} falsifier=${falsifier.width}x${falsifier.height}`,
    );
  }
  let absoluteRgbDelta = 0;
  for (let index = 0; index < normal.data.length; index += 4) {
    absoluteRgbDelta += Math.abs(normal.data[index] - falsifier.data[index]);
    absoluteRgbDelta += Math.abs(normal.data[index + 1] - falsifier.data[index + 1]);
    absoluteRgbDelta += Math.abs(normal.data[index + 2] - falsifier.data[index + 2]);
  }
  const changedPixels = pixelmatch(
    normal.data,
    falsifier.data,
    undefined,
    normal.width,
    normal.height,
    { threshold: 0.1, includeAA: true },
  );
  return {
    changedPixels,
    changedFraction: changedPixels / (normal.width * normal.height),
    meanRgbDelta: absoluteRgbDelta / (normal.width * normal.height * 3 * 255),
    width: normal.width,
    height: normal.height,
  };
}

function compareDawnReadbacks(normalRgbaPath, normalMetaPath, falsifierRgbaPath, falsifierMetaPath) {
  const normalMeta = JSON.parse(readFileSync(normalMetaPath, 'utf8'));
  const falsifierMeta = JSON.parse(readFileSync(falsifierMetaPath, 'utf8'));
  if (normalMeta.width !== falsifierMeta.width || normalMeta.height !== falsifierMeta.height) {
    throw new Error(
      `Dawn readback dimensions differ: normal=${normalMeta.width}x${normalMeta.height} falsifier=${falsifierMeta.width}x${falsifierMeta.height}`,
    );
  }
  const normal = readFileSync(normalRgbaPath);
  const falsifier = readFileSync(falsifierRgbaPath);
  if (normal.length !== falsifier.length || normal.length !== normalMeta.width * normalMeta.height * 4) {
    throw new Error(
      `Dawn readback byte lengths differ or are invalid: normal=${normal.length} falsifier=${falsifier.length}`,
    );
  }
  let changedPixels = 0;
  let absoluteRgbDelta = 0;
  for (let index = 0; index < normal.length; index += 4) {
    const redDelta = Math.abs(normal[index] - falsifier[index]);
    const greenDelta = Math.abs(normal[index + 1] - falsifier[index + 1]);
    const blueDelta = Math.abs(normal[index + 2] - falsifier[index + 2]);
    if (redDelta !== 0 || greenDelta !== 0 || blueDelta !== 0) changedPixels++;
    absoluteRgbDelta += redDelta + greenDelta + blueDelta;
  }
  return {
    width: normalMeta.width,
    height: normalMeta.height,
    changedPixels,
    changedFraction: changedPixels / (normalMeta.width * normalMeta.height),
    meanRgbDelta: absoluteRgbDelta / (normalMeta.width * normalMeta.height * 3 * 255),
    normalSha256: normalMeta.sha256,
    falsifierSha256: falsifierMeta.sha256,
  };
}

function readDawnReadbackMetadata(path) {
  const metadata = JSON.parse(readFileSync(path, 'utf8'));
  return {
    width: metadata.width,
    height: metadata.height,
    byteLength: metadata.byteLength,
    nonBlackPixelCount: metadata.nonBlackPixelCount,
    meanRgb: metadata.meanRgb,
    sha256: metadata.sha256,
  };
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function countLiveTextures(report, matches) {
  const live = new Set();
  for (const event of report.events) {
    const handleId = event.handleId ?? event.id;
    if (handleId === undefined || handleId === null) continue;
    if (event.kind === 'createTexture' && matches(event.desc)) {
      live.add(handleId);
    } else if (event.kind === 'destroyTexture') {
      live.delete(handleId);
    }
  }
  return live.size;
}

function countLiveMsaaTextures(report) {
  return countLiveTextures(report, (desc) => desc?.sampleCount === 4);
}

function readRepeatabilitySnapshot(root) {
  const capture = JSON.parse(readFileSync(resolve(root, 'capture.json'), 'utf8'));
  const summary = JSON.parse(readFileSync(resolve(root, 'rhi-summary.json'), 'utf8'));
  return {
    capture: {
      pipeline: capture.pipeline,
      variant: capture.variant,
      post: capture.post,
      selectedVariant: capture.selectedVariant,
      selectedPost: capture.selectedPost,
      texture: capture.texture,
      antialias: capture.antialias,
      canvas: capture.canvas,
      resizeHistory: capture.resizeHistory,
      pipelineSwitchedAfterResize: capture.pipelineSwitchedAfterResize,
      variantSwitchedAfterPipeline: capture.variantSwitchedAfterPipeline,
      postSwitchedAfterPipeline: capture.postSwitchedAfterPipeline,
      falsifyPipeline: capture.falsifyPipeline,
    },
    rhi: {
      pipeline: summary.pipeline,
      variant: summary.variant,
      post: summary.post,
      texture: summary.texture,
      antialias: summary.antialias,
      textureResourceCount: summary.textureResourceCount,
      msaaTextureResourceCount: summary.msaaTextureResourceCount,
      resolveTargetCount: summary.resolveTargetCount,
      canvas: summary.canvas,
      resizeHistory: summary.resizeHistory,
      pipelineSwitchedAfterResize: summary.pipelineSwitchedAfterResize,
      variantSwitchedAfterPipeline: summary.variantSwitchedAfterPipeline,
      drawCount: summary.drawCount,
      inspections: summary.inspections,
    },
    dawn: readDawnReadbackMetadata(resolve(root, 'dawn-readback.json')),
    screenshotSha256: sha256File(resolve(root, 'custom-live.png')),
  };
}

function readComposedRhiSnapshot(root, label) {
  const report = JSON.parse(readFileSync(resolve(root, 'rhi', `${label}.report.json`), 'utf8'));
  return {
    textureResourceCount: countLiveTextures(
      report,
      (desc) => desc?.size?.width === 2 && desc?.size?.height === 2,
    ),
    msaaTextureResourceCount: countLiveMsaaTextures(report),
    resolveTargetCount: report.events.filter(
      (event) =>
        event.kind === 'beginRenderPass' &&
        event.colorAttachmentResolveTargetHandleIds?.some(
          (handleId) => handleId !== undefined && handleId !== null,
        ),
    ).length,
    drawCount: report.events.filter((event) => event.kind === 'draw' || event.kind === 'drawIndexed').length,
    dawn: readDawnReadbackMetadata(resolve(root, 'rhi', `${label}.dawn-readback.json`)),
  };
}

function readComposedSnapshot(root, falsifierLabel = 'falsified-second-texture-inversion') {
  const composed = JSON.parse(readFileSync(resolve(root, 'browser-composed.json'), 'utf8'));
  return {
    live: {
      variantDelta: composed.live.variantDelta,
      postDelta: composed.live.postDelta,
      resized: composed.live.resized.state,
      resizeHistory: composed.live.resizeHistory,
      screenshotSha256: sha256File(composed.live.resized.png),
    },
    falsifier: {
      variantDelta: composed.falsifier.variantDelta,
      secondTextureDelta: composed.falsifier.secondTextureDelta,
      secondTexture: composed.falsifier.secondTexture.state,
      resizeHistory: composed.falsifier.resizeHistory,
      screenshotSha256: sha256File(composed.falsifier.secondTexture.png),
    },
    rhi: {
      normal: readComposedRhiSnapshot(root, 'live-resized-inversion'),
      falsifier: readComposedRhiSnapshot(root, falsifierLabel),
    },
  };
}

function readLiveMaterialSnapshot(root) {
  const composed = JSON.parse(readFileSync(resolve(root, 'live-material-browser.json'), 'utf8'));
  const stableEvidence = (evidence) => ({
    enabled: evidence.enabled,
    applied: evidence.applied,
    beforeMaterialHandle: evidence.beforeMaterialHandle,
    afterMaterialHandle: evidence.afterMaterialHandle,
    beforeTextureHandles: evidence.beforeTextureHandles,
    afterTextureHandles: evidence.afterTextureHandles,
    baseColorSlotChanged: evidence.baseColorSlotChanged,
    detailSlotChanged: evidence.detailSlotChanged,
    inheritanceBacked: evidence.inheritanceBacked,
    sourceRootGuid: evidence.sourceRootGuid,
    sourceDerivedGuid: evidence.sourceDerivedGuid,
    sourceRootArtifactDigest: evidence.sourceRootArtifactDigest,
    sourceArtifactDigest: evidence.sourceArtifactDigest,
    sourceRootCookInputDigest: evidence.sourceRootCookInputDigest,
    sourceCookInputDigest: evidence.sourceCookInputDigest,
    falsifierMarker: evidence.falsifierMarker,
    afterComponentMaterialMatchesAfter:
      evidence.afterComponentMaterialHandle === evidence.afterMaterialHandle,
    resizeHistory: evidence.resizeHistory,
  });
  const snapshotLeg = (leg) => ({
    before: leg.before.state,
    after: leg.after.state,
    delta: leg.delta,
    beforeEvidence: stableEvidence(leg.beforeEvidence),
    afterEvidence: stableEvidence(leg.afterEvidence),
    dawn: leg.rhi.dawnReadback,
    rhiTopology: (() => {
      const report = JSON.parse(readFileSync(leg.rhi.report, 'utf8'));
      const reportText = JSON.stringify(report);
      return {
        msaaTextureResourceCount: countLiveMsaaTextures(report),
        resolveTargetCount: report.events.filter(
          (event) =>
            event.kind === 'beginRenderPass' &&
            event.colorAttachmentResolveTargetHandleIds?.some(
              (handleId) => handleId !== undefined && handleId !== null,
            ),
        ).length,
        hasDepthBinding: reportText.includes('sceneDepth') && reportText.includes('depthSampler') && reportText.includes('"binding":3'),
      };
    })(),
    draws: leg.rhi.draws,
    inspectedDraw: leg.rhi.inspect?.drawCall
      ? {
          pipelineKind: leg.rhi.inspect.drawCall.pipelineKind,
          vertexCount: leg.rhi.inspect.drawCall.vertexCount,
          instanceCount: leg.rhi.inspect.drawCall.instanceCount,
          firstVertex: leg.rhi.inspect.drawCall.firstVertex,
          firstInstance: leg.rhi.inspect.drawCall.firstInstance,
        }
      : undefined,
    screenshotSha256: sha256File(leg.after.png),
  });
  return { normal: snapshotLeg(composed.normal), falsifier: snapshotLeg(composed.falsifier) };
}

function readDepthSnapshot(root) {
  const depth = JSON.parse(readFileSync(resolve(root, 'depth-browser.json'), 'utf8'));
  return {
    normal: {
      baseline: depth.normal.baseline,
      variant: depth.normal.variant,
      resized: depth.normal.resized,
      resizeHistory: depth.normal.resizeHistory,
      dawn: depth.normal.rhi.dawn,
      hasDepthBinding: depth.normal.rhi.hasDepthBinding,
    },
    falsifier: {
      baseline: depth.falsifier.baseline,
      dawn: depth.falsifier.rhi.dawn,
      hasDepthBinding: depth.falsifier.rhi.hasDepthBinding,
    },
    delta: depth.delta,
  };
}

function repeatabilityDiff(first, second) {
  const firstJson = JSON.stringify(first);
  const secondJson = JSON.stringify(second);
  return firstJson === secondJson ? undefined : { first, second };
}

function run(label, args, extraEnv = {}, cwd = repoRoot) {
  const outputDir = mkdtempSync(resolve(tmpdir(), 'forgeax-m3-run-'));
  const stdoutPath = resolve(outputDir, 'stdout.txt');
  const stderrPath = resolve(outputDir, 'stderr.txt');
  const stdoutFd = openSync(stdoutPath, 'w');
  const stderrFd = openSync(stderrPath, 'w');
  let result;
  try {
    result = spawnSync('pnpm', args, {
      cwd,
      detached: true,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', stdoutFd, stderrFd],
      timeout: childTimeoutMs,
      env: { ...process.env, INIT_CWD: repoRoot, ...extraEnv },
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  if (result.error?.code === 'ETIMEDOUT' && result.pid !== undefined) {
    try {
      process.kill(-result.pid, 'SIGKILL');
    } catch {
      // The detached process group may have already exited with the timeout.
    }
  }
  const output = `${readFileSync(stdoutPath, 'utf8')}${readFileSync(stderrPath, 'utf8')}`;
  rmSync(outputDir, { recursive: true, force: true });
  process.stdout.write(output);
  if (result.error?.code === 'ETIMEDOUT') {
    console.error(`[m3-programmable] ${label}: child timeout after ${childTimeoutMs} ms`);
  } else if (result.error) {
    console.error(`[m3-programmable] ${label}: spawn failed: ${result.error.message}`);
  }
  return { status: result.status, output };
}

function readLastJsonLine(output) {
  for (const line of output.trim().split('\n').reverse()) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && value.status === 'pass') return value;
    } catch {
      // Ignore pnpm/Vite progress lines and keep looking for the smoke payload.
    }
  }
  return undefined;
}

function runCustomMaterialBrowser(label, extraEnv = {}) {
  return run(
    label,
    ['--filter', '@forgeax/hello-custom-shader', 'run', 'smoke:browser'],
    extraEnv,
  );
}

const customMaterial = run('custom material', [
  '--filter',
  '@forgeax/hello-custom-shader',
  'smoke',
]);
const customMaterialEvidence = customMaterial.status === 0 ? readLastJsonLine(customMaterial.output) : undefined;
if (
  customMaterial.status !== 0 ||
  customMaterialEvidence?.status !== 'pass' ||
  customMaterialEvidence?.frames !== 300 ||
  customMaterialEvidence?.rootArtifactDigest !== customMaterialEvidence?.derivedArtifactDigest ||
  customMaterialEvidence?.pixel?.[0] < 240 ||
  customMaterialEvidence?.pixel?.[3] !== 255
) {
  console.error('[m3-programmable] custom material: FAIL - Dawn material gate did not pass');
  process.exit(1);
}
console.log('[m3-programmable] custom material pixel: PASS');

const customMaterialBrowserRuns = ['first', 'second'].map((repeat) => {
  const result = runCustomMaterialBrowser(`custom material browser ${repeat}`);
  const evidence = result.status === 0 ? readLastJsonLine(result.output) : undefined;
  if (
    result.status !== 0 ||
    evidence?.browserPath !== true ||
    evidence.rootArtifactDigest !== evidence.derivedArtifactDigest ||
    typeof evidence.rootCookInputDigest !== 'string' ||
    evidence.textureHandlesDistinct !== true
  ) {
    console.error(`[m3-programmable] custom material browser ${repeat}: FAIL - semantic browser evidence missing`);
    process.exit(1);
  }
  return evidence;
});
if (repeatabilityDiff(customMaterialBrowserRuns[0], customMaterialBrowserRuns[1]) !== undefined) {
  console.error(
    `[m3-programmable] custom material browser repeatability: FAIL - ${JSON.stringify({ first: customMaterialBrowserRuns[0], second: customMaterialBrowserRuns[1] })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom material browser: PASS repeats=2 rootArtifactDigest=${customMaterialBrowserRuns[0].rootArtifactDigest}`,
);
console.log('[m3-programmable] custom material texture binding: PASS');

const customMaterialBrowserFalsifiers = [
  ['missing-parent', 'missing-derived-parent', 'FORGEAX_FALSIFY_MISSING_PARENT'],
  ['uv-transform', 'uv0-transform-loss', 'FORGEAX_FALSIFY_UV0_TRANSFORM'],
  ['missing-normal-resource', 'missing-normal-resource', 'FORGEAX_FALSIFY_MISSING_NORMAL_RESOURCE'],
  ['swapped-normal-binding', 'swapped-normal-binding', 'FORGEAX_FALSIFY_SWAPPED_NORMAL_BINDING'],
];
for (const [label, expected, envKey] of customMaterialBrowserFalsifiers) {
  for (const repeat of ['first', 'second']) {
    const result = runCustomMaterialBrowser(`custom material browser ${label} falsifier ${repeat}`, {
      [envKey]: '1',
    });
    if (result.status === 0 || !result.output.includes(`FALSIFY_EXPECTED_FAILURE:${expected}`)) {
      console.error(
        `[m3-programmable] custom material browser ${label} falsifier ${repeat}: FAIL - expected attributed failure missing`,
      );
      process.exit(1);
    }
  }
  console.log(`[m3-programmable] custom material browser ${label} falsifier: PASS repeats=2`);
}

const normalSlotVisualArtifactRoot = resolve(
  process.env.FORGEAX_M3_ARTIFACT_DIR ??
    resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering'),
  'custom-material-normal-slot-visual-causality',
);
mkdirSync(normalSlotVisualArtifactRoot, { recursive: true });
const normalSlotVisualRuns = [];
for (const repeat of ['first', 'second']) {
  const normalArtifactDir = resolve(normalSlotVisualArtifactRoot, repeat, 'normal');
  const swapArtifactDir = resolve(normalSlotVisualArtifactRoot, repeat, 'normal-slot-swap');
  const normalBrowser = runCustomMaterialBrowser(`custom material normal-slot visual ${repeat} normal`, {
    FORGEAX_MATERIAL_ARTIFACT_DIR: normalArtifactDir,
  });
  const swappedBrowser = runCustomMaterialBrowser(`custom material normal-slot visual ${repeat} swap`, {
    FORGEAX_FALSIFY_NORMAL_SLOT_SWAP: '1',
    FORGEAX_MATERIAL_ARTIFACT_DIR: swapArtifactDir,
  });
  const normalBrowserEvidence = normalBrowser.status === 0 ? readLastJsonLine(normalBrowser.output) : undefined;
  const normalScreenshotPath = resolve(normalArtifactDir, 'custom-material.png');
  const swappedScreenshotPath = resolve(swapArtifactDir, 'custom-material.png');
  if (
    normalBrowser.status !== 0 ||
    normalBrowserEvidence?.browserPath !== true ||
    normalBrowserEvidence?.renderedTextureHandles?.[0] !== normalBrowserEvidence?.resolvedTextureHandles?.[0] ||
    normalBrowserEvidence?.renderedTextureHandles?.[1] !== normalBrowserEvidence?.resolvedTextureHandles?.[1] ||
    swappedBrowser.status === 0 ||
    !swappedBrowser.output.includes('FALSIFY_EXPECTED_FAILURE:normal-slot-swap')
  ) {
    console.error(
      `[m3-programmable] custom material normal-slot visual ${repeat}: FAIL - ${JSON.stringify({ normalStatus: normalBrowser.status, swapStatus: swappedBrowser.status })}`,
    );
    process.exit(1);
  }
  const browserDelta = comparePngs(normalScreenshotPath, swappedScreenshotPath);
  const normalDawn = run(
    `custom material normal-slot Dawn ${repeat} normal`,
    ['--filter', '@forgeax/hello-custom-shader', 'run', 'smoke:normal-slot-dawn'],
  );
  const swappedDawn = run(
    `custom material normal-slot Dawn ${repeat} swap`,
    ['--filter', '@forgeax/hello-custom-shader', 'run', 'smoke:normal-slot-dawn'],
    { FORGEAX_MATERIAL_DAWN_VARIANT: 'normal-slot-swap' },
  );
  const normalDawnEvidence = normalDawn.status === 0 ? readLastJsonLine(normalDawn.output) : undefined;
  const swappedDawnEvidence = swappedDawn.status === 0 ? readLastJsonLine(swappedDawn.output) : undefined;
  if (
    browserDelta.meanRgbDelta <= 0.01 ||
    normalDawn.status !== 0 ||
    swappedDawn.status !== 0 ||
    normalDawnEvidence?.variant !== 'normal' ||
    swappedDawnEvidence?.variant !== 'normal-slot-swap' ||
    JSON.stringify(normalDawnEvidence?.pixel) === JSON.stringify(swappedDawnEvidence?.pixel)
  ) {
    console.error(
      `[m3-programmable] custom material normal-slot visual ${repeat}: FAIL - ${JSON.stringify({ browserDelta, normalDawn: normalDawnEvidence, swappedDawn: swappedDawnEvidence })}`,
    );
    process.exit(1);
  }
  const snapshot = {
    rootArtifactDigest: normalBrowserEvidence.rootArtifactDigest,
    normalTextureSlot: normalDawnEvidence.normalTextureSlot,
    browser: {
      normalSha256: sha256File(normalScreenshotPath),
      swappedSha256: sha256File(swappedScreenshotPath),
      delta: browserDelta,
    },
    dawn: {
      normal: normalDawnEvidence.pixel,
      swapped: swappedDawnEvidence.pixel,
    },
  };
  writeFileSync(resolve(normalSlotVisualArtifactRoot, `repeat-${repeat}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
  normalSlotVisualRuns.push(snapshot);
}
if (repeatabilityDiff(normalSlotVisualRuns[0], normalSlotVisualRuns[1]) !== undefined) {
  console.error(
    `[m3-programmable] custom material normal-slot visual repeatability: FAIL - ${JSON.stringify({ first: normalSlotVisualRuns[0], second: normalSlotVisualRuns[1] })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom material normal-slot visual causality: PASS repeats=2 changedPixels=${normalSlotVisualRuns[0].browser.delta.changedPixels} meanRgbDelta=${normalSlotVisualRuns[0].browser.delta.meanRgbDelta.toFixed(4)} dawnPixels=${normalSlotVisualRuns[0].dawn.normal.join(',')}/${normalSlotVisualRuns[0].dawn.swapped.join(',')}`,
);

const normalSlotLiveArtifactRoot = resolve(
  process.env.FORGEAX_M3_ARTIFACT_DIR ??
    resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering'),
  'custom-material-normal-slot-live-mutation',
);
mkdirSync(normalSlotLiveArtifactRoot, { recursive: true });
const normalSlotLiveRuns = [];
for (const repeat of ['first', 'second']) {
  const artifactDir = resolve(normalSlotLiveArtifactRoot, repeat);
  const browser = runCustomMaterialBrowser(`custom material normal-slot live mutation ${repeat}`, {
    FORGEAX_MATERIAL_LIVE_NORMAL_SLOT_SWAP: '1',
    FORGEAX_MATERIAL_ARTIFACT_DIR: artifactDir,
  });
  const browserEvidence = browser.status === 0 ? readLastJsonLine(browser.output) : undefined;
  const browserBeforePath = resolve(artifactDir, 'live-normal-slot-before.png');
  const browserAfterPath = resolve(artifactDir, 'live-normal-slot-after.png');
  const browserDelta =
    browser.status === 0 && existsSync(browserBeforePath) && existsSync(browserAfterPath)
      ? comparePngs(browserBeforePath, browserAfterPath)
      : undefined;
  const dawn = run(
    `custom material normal-slot live Dawn ${repeat}`,
    ['--filter', '@forgeax/hello-custom-shader', 'run', 'smoke:normal-slot-live-dawn'],
    { FORGEAX_MATERIAL_ARTIFACT_DIR: artifactDir },
  );
  const dawnEvidence = dawn.status === 0 ? readLastJsonLine(dawn.output) : undefined;
  if (
    browser.status !== 0 ||
    browserEvidence?.liveMutation?.enabled !== true ||
    browserEvidence?.liveMutation?.applied !== true ||
    browserEvidence?.liveMutation?.beforeTextureHandles?.[0] !==
      browserEvidence?.liveMutation?.afterTextureHandles?.[0] ||
    browserEvidence?.liveMutation?.beforeTextureHandles?.[1] ===
      browserEvidence?.liveMutation?.afterTextureHandles?.[1] ||
    browserEvidence?.liveVisual?.beforePath === undefined ||
    browserEvidence?.liveVisual?.afterPath === undefined ||
    browserDelta?.meanRgbDelta <= 0.01 ||
    dawn.status !== 0 ||
    dawnEvidence?.frontDoor !== 'engine-renderer-world-draw' ||
    dawnEvidence?.material?.baseColorPreserved !== true ||
    dawnEvidence?.material?.normalSlotChanged !== true ||
    dawnEvidence?.delta?.meanRgbDelta <= 0.001
  ) {
    console.error(
      `[m3-programmable] custom material normal-slot live mutation: FAIL - ${JSON.stringify({ browserStatus: browser.status, browserEvidence, browserDelta, dawnStatus: dawn.status, dawnEvidence })}`,
    );
    process.exit(1);
  }
  const snapshot = {
    browser: {
      mutation: browserEvidence.liveMutation,
      beforeSha256: sha256File(browserBeforePath),
      afterSha256: sha256File(browserAfterPath),
      delta: browserDelta,
    },
    dawn: {
      material: dawnEvidence.material,
      before: dawnEvidence.before,
      after: dawnEvidence.after,
      delta: dawnEvidence.delta,
    },
  };
  writeFileSync(resolve(normalSlotLiveArtifactRoot, `repeat-${repeat}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
  normalSlotLiveRuns.push(snapshot);
}
if (repeatabilityDiff(normalSlotLiveRuns[0], normalSlotLiveRuns[1]) !== undefined) {
  console.error(
    `[m3-programmable] custom material normal-slot live mutation repeatability: FAIL - ${JSON.stringify({ first: normalSlotLiveRuns[0], second: normalSlotLiveRuns[1] })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom material normal-slot live mutation: PASS repeats=2 changedPixels=${normalSlotLiveRuns[0].browser.delta.changedPixels} meanRgbDelta=${normalSlotLiveRuns[0].browser.delta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${normalSlotLiveRuns[0].dawn.delta.changedPixels}`,
);

const inheritanceLiveArtifactRoot = resolve(
  process.env.FORGEAX_M3_ARTIFACT_DIR ??
    resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering'),
  'custom-material-inheritance-live-rebind',
);
mkdirSync(inheritanceLiveArtifactRoot, { recursive: true });
const inheritanceLiveRuns = [];
for (const repeat of ['first', 'second']) {
  const artifactDir = resolve(inheritanceLiveArtifactRoot, repeat);
  const browser = runCustomMaterialBrowser(`custom material inheritance live rebind ${repeat}`, {
    FORGEAX_MATERIAL_LIVE_INHERITANCE_REBIND: '1',
    FORGEAX_MATERIAL_ARTIFACT_DIR: artifactDir,
  });
  const browserEvidence = browser.status === 0 ? readLastJsonLine(browser.output) : undefined;
  const browserBeforePath = resolve(artifactDir, 'live-inheritance-before.png');
  const browserAfterPath = resolve(artifactDir, 'live-inheritance-after.png');
  const browserDelta =
    browser.status === 0 && existsSync(browserBeforePath) && existsSync(browserAfterPath)
      ? comparePngs(browserBeforePath, browserAfterPath)
      : undefined;
  const falsifier = runCustomMaterialBrowser(`custom material inheritance live rebind falsifier ${repeat}`, {
    FORGEAX_MATERIAL_LIVE_INHERITANCE_REBIND: '1',
    FORGEAX_FALSIFY_LIVE_INHERITANCE_REBIND: '1',
    FORGEAX_MATERIAL_ARTIFACT_DIR: resolve(artifactDir, 'falsifier'),
  });
  const dawn = run(
    `custom material inheritance live Dawn ${repeat}`,
    ['--filter', '@forgeax/hello-custom-shader', 'run', 'smoke:normal-slot-live-dawn'],
    { FORGEAX_MATERIAL_LIVE_INHERITANCE_REBIND: '1', FORGEAX_MATERIAL_ARTIFACT_DIR: artifactDir },
  );
  const dawnEvidence = dawn.status === 0 ? readLastJsonLine(dawn.output) : undefined;
  const dawnFalsifier = run(
    `custom material inheritance live Dawn falsifier ${repeat}`,
    ['--filter', '@forgeax/hello-custom-shader', 'run', 'smoke:normal-slot-live-dawn'],
    {
      FORGEAX_MATERIAL_LIVE_INHERITANCE_REBIND: '1',
      FORGEAX_FALSIFY_LIVE_INHERITANCE_REBIND: '1',
      FORGEAX_MATERIAL_ARTIFACT_DIR: resolve(artifactDir, 'falsifier-dawn'),
    },
  );
  if (
    browser.status !== 0 ||
    browserEvidence?.liveMutation?.inheritanceBacked !== true ||
    browserEvidence?.liveMutation?.applied !== true ||
    browserEvidence?.liveMutation?.sourceDerivedGuid !== browserEvidence?.derivedGuid ||
    browserEvidence?.liveMutation?.sourceArtifactDigest !== browserEvidence?.derivedArtifactDigest ||
    browserEvidence?.liveMutation?.sourceCookInputDigest !== browserEvidence?.derivedCookInputDigest ||
    browserEvidence?.liveMutation?.beforeMaterialHandle === browserEvidence?.liveMutation?.afterMaterialHandle ||
    browserEvidence?.liveMutation?.beforeTextureHandles?.[0] === browserEvidence?.liveMutation?.afterTextureHandles?.[0] ||
    browserEvidence?.liveMutation?.beforeTextureHandles?.[1] === browserEvidence?.liveMutation?.afterTextureHandles?.[1] ||
    browserDelta?.meanRgbDelta <= 0.01 ||
    falsifier.status === 0 ||
    !falsifier.output.includes('FALSIFY_EXPECTED_FAILURE:live-inheritance-rebind') ||
    dawn.status !== 0 ||
    dawnEvidence?.material?.inheritanceBacked !== true ||
    dawnEvidence?.material?.sourceArtifactDigest !== dawnEvidence?.derivedArtifactDigest ||
    dawnEvidence?.material?.sourceCookInputDigest !== dawnEvidence?.derivedCookInputDigest ||
    dawnEvidence?.material?.beforeTextureHandles?.[0] === dawnEvidence?.material?.afterTextureHandles?.[0] ||
    dawnEvidence?.material?.beforeTextureHandles?.[1] === dawnEvidence?.material?.afterTextureHandles?.[1] ||
    dawnEvidence?.delta?.meanRgbDelta <= 0.001 ||
    dawnFalsifier.status === 0 ||
    !dawnFalsifier.output.includes('FALSIFY_EXPECTED_FAILURE:live-inheritance-rebind')
  ) {
    console.error(
      `[m3-programmable] custom material inheritance live rebind ${repeat}: FAIL - ${JSON.stringify({ browserStatus: browser.status, browserEvidence, browserDelta, falsifierStatus: falsifier.status, dawnStatus: dawn.status, dawnEvidence, dawnFalsifierStatus: dawnFalsifier.status })}`,
    );
    process.exit(1);
  }
  const snapshot = {
    browser: {
      rootArtifactDigest: browserEvidence.rootArtifactDigest,
      derivedArtifactDigest: browserEvidence.derivedArtifactDigest,
      rootCookInputDigest: browserEvidence.rootCookInputDigest,
      derivedCookInputDigest: browserEvidence.derivedCookInputDigest,
      mutation: browserEvidence.liveMutation,
      beforeSha256: sha256File(browserBeforePath),
      afterSha256: sha256File(browserAfterPath),
      delta: browserDelta,
    },
    dawn: {
      rootArtifactDigest: dawnEvidence.rootArtifactDigest,
      derivedArtifactDigest: dawnEvidence.derivedArtifactDigest,
      rootCookInputDigest: dawnEvidence.rootCookInputDigest,
      derivedCookInputDigest: dawnEvidence.derivedCookInputDigest,
      material: dawnEvidence.material,
      before: dawnEvidence.before,
      after: dawnEvidence.after,
      delta: dawnEvidence.delta,
    },
  };
  writeFileSync(resolve(inheritanceLiveArtifactRoot, `repeat-${repeat}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
  inheritanceLiveRuns.push(snapshot);
}
if (repeatabilityDiff(inheritanceLiveRuns[0], inheritanceLiveRuns[1]) !== undefined) {
  console.error(
    `[m3-programmable] custom material inheritance live rebind repeatability: FAIL - ${JSON.stringify({ first: inheritanceLiveRuns[0], second: inheritanceLiveRuns[1] })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom material inheritance live rebind: PASS repeats=2 changedPixels=${inheritanceLiveRuns[0].browser.delta.changedPixels} meanRgbDelta=${inheritanceLiveRuns[0].browser.delta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${inheritanceLiveRuns[0].dawn.delta.changedPixels}`,
);

const materialResizeArtifactRoot = resolve(
  process.env.FORGEAX_M3_ARTIFACT_DIR ?? resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering'),
  'custom-material-normal-slot-live-resize-rebuild',
);
mkdirSync(materialResizeArtifactRoot, { recursive: true });
const materialResizeRuns = [];
for (const repeat of ['first', 'second']) {
  const normalDir = resolve(materialResizeArtifactRoot, `normal-${repeat}`);
  const swapDir = resolve(materialResizeArtifactRoot, `swap-${repeat}`);
  const normalBrowser = runCustomMaterialBrowser(`custom material normal-slot resize normal ${repeat}`, {
    FORGEAX_MATERIAL_LIVE_NORMAL_SLOT_RESIZE: '1',
    FORGEAX_MATERIAL_ARTIFACT_DIR: normalDir,
  });
  const swapBrowser = runCustomMaterialBrowser(`custom material normal-slot resize swap ${repeat}`, {
    FORGEAX_MATERIAL_LIVE_NORMAL_SLOT_SWAP_RESIZE: '1',
    FORGEAX_MATERIAL_ARTIFACT_DIR: swapDir,
  });
  const normalBrowserEvidence = normalBrowser.status === 0 ? readLastJsonLine(normalBrowser.output) : undefined;
  const swapBrowserEvidence = swapBrowser.status === 0 ? readLastJsonLine(swapBrowser.output) : undefined;
  const normalAfterPath = resolve(normalDir, 'live-normal-slot-resize-after.png');
  const swapAfterPath = resolve(swapDir, 'live-normal-slot-resize-after.png');
  const browserDelta =
    normalBrowser.status === 0 && swapBrowser.status === 0 && existsSync(normalAfterPath) && existsSync(swapAfterPath)
      ? comparePngs(normalAfterPath, swapAfterPath)
      : undefined;
  const normalDawn = run(
    `custom material normal-slot resize Dawn normal ${repeat}`,
    ['--filter', '@forgeax/hello-custom-shader', 'run', 'smoke:normal-slot-live-dawn'],
    { FORGEAX_MATERIAL_LIVE_RESIZE_VARIANT: 'normal', FORGEAX_MATERIAL_ARTIFACT_DIR: normalDir },
  );
  const swapDawn = run(
    `custom material normal-slot resize Dawn swap ${repeat}`,
    ['--filter', '@forgeax/hello-custom-shader', 'run', 'smoke:normal-slot-live-dawn'],
    { FORGEAX_MATERIAL_LIVE_RESIZE_VARIANT: 'swap', FORGEAX_MATERIAL_ARTIFACT_DIR: swapDir },
  );
  const normalDawnEvidence = normalDawn.status === 0 ? readLastJsonLine(normalDawn.output) : undefined;
  const swapDawnEvidence = swapDawn.status === 0 ? readLastJsonLine(swapDawn.output) : undefined;
  const dawnDelta =
    normalDawn.status === 0 && swapDawn.status === 0
      ? compareDawnReadbacks(
          resolve(normalDir, 'live-normal-slot-after-resize.rgba'),
          resolve(normalDir, 'live-normal-slot-after-resize.json'),
          resolve(swapDir, 'live-normal-slot-after-resize.rgba'),
          resolve(swapDir, 'live-normal-slot-after-resize.json'),
        )
      : undefined;
  if (
    normalBrowser.status !== 0 ||
    swapBrowser.status !== 0 ||
    normalBrowserEvidence?.resizeRebuild?.afterCanvas?.join('x') !== '384x192' ||
    swapBrowserEvidence?.resizeRebuild?.afterCanvas?.join('x') !== '384x192' ||
    swapBrowserEvidence?.liveMutation?.afterComponentMaterialHandle !== swapBrowserEvidence?.liveMutation?.afterMaterialHandle ||
    swapBrowserEvidence?.resizeRebuild?.postResizeMaterialHandle !== swapBrowserEvidence?.liveMutation?.afterMaterialHandle ||
    normalBrowserEvidence?.resizeRebuild?.postResizeMaterialHandle !== normalBrowserEvidence?.liveMutation?.beforeMaterialHandle ||
    browserDelta?.meanRgbDelta <= 0.01 ||
    normalDawn.status !== 0 ||
    swapDawn.status !== 0 ||
    normalDawnEvidence?.resize?.after?.join('x') !== '256x192' ||
    swapDawnEvidence?.resize?.after?.join('x') !== '256x192' ||
    swapDawnEvidence?.material?.normalSlotChanged !== true ||
    dawnDelta?.meanRgbDelta <= 0.001
  ) {
    console.error(
      `[m3-programmable] custom material normal-slot resize/rebuild: FAIL - ${JSON.stringify({ normalBrowser: normalBrowserEvidence, swapBrowser: swapBrowserEvidence, browserDelta, normalDawn: normalDawnEvidence, swapDawn: swapDawnEvidence, dawnDelta })}`,
    );
    process.exit(1);
  }
  const snapshot = {
    browser: {
      normal: { resize: normalBrowserEvidence.resizeRebuild, sha256: sha256File(normalAfterPath) },
      swap: { mutation: swapBrowserEvidence.liveMutation, resize: swapBrowserEvidence.resizeRebuild, sha256: sha256File(swapAfterPath) },
      delta: browserDelta,
    },
    dawn: {
      normal: { material: normalDawnEvidence.material, resize: normalDawnEvidence.resize, sha256: normalDawnEvidence.after.sha256 },
      swap: { material: swapDawnEvidence.material, resize: swapDawnEvidence.resize, sha256: swapDawnEvidence.after.sha256 },
      delta: dawnDelta,
    },
  };
  writeFileSync(resolve(materialResizeArtifactRoot, `repeat-${repeat}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
  materialResizeRuns.push(snapshot);
}
if (repeatabilityDiff(materialResizeRuns[0], materialResizeRuns[1]) !== undefined) {
  console.error(
    `[m3-programmable] custom material normal-slot resize/rebuild repeatability: FAIL - ${JSON.stringify({ first: materialResizeRuns[0], second: materialResizeRuns[1] })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom material normal-slot resize/rebuild: PASS repeats=2 browserChangedPixels=${materialResizeRuns[0].browser.delta.changedPixels} browserMeanRgbDelta=${materialResizeRuns[0].browser.delta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${materialResizeRuns[0].dawn.delta.changedPixels}`,
);

const twoSlotResizeArtifactRoot = resolve(
  process.env.FORGEAX_M3_ARTIFACT_DIR ?? resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering'),
  'custom-material-two-slot-live-resize-rebuild',
);
mkdirSync(twoSlotResizeArtifactRoot, { recursive: true });
const twoSlotResizeRuns = [];
for (const repeat of ['first', 'second']) {
  const normalDir = resolve(twoSlotResizeArtifactRoot, `normal-${repeat}`);
  const swapDir = resolve(twoSlotResizeArtifactRoot, `swap-${repeat}`);
  const normalBrowser = run(
    `custom material two-slot resize normal ${repeat}`,
    ['--filter', '@forgeax/hello-custom-shader', 'run', 'smoke:browser'],
    { FORGEAX_MATERIAL_LIVE_TWO_SLOT_RESIZE: '1', FORGEAX_MATERIAL_ARTIFACT_DIR: normalDir },
  );
  const swapBrowser = run(
    `custom material two-slot resize swap ${repeat}`,
    ['--filter', '@forgeax/hello-custom-shader', 'run', 'smoke:browser'],
    { FORGEAX_MATERIAL_LIVE_TWO_SLOT_SWAP_RESIZE: '1', FORGEAX_MATERIAL_ARTIFACT_DIR: swapDir },
  );
  const normalBrowserEvidence = normalBrowser.status === 0 ? readLastJsonLine(normalBrowser.output) : undefined;
  const swapBrowserEvidence = swapBrowser.status === 0 ? readLastJsonLine(swapBrowser.output) : undefined;
  const normalAfterPath = resolve(normalDir, 'live-two-slot-resize-after.png');
  const swapAfterPath = resolve(swapDir, 'live-two-slot-resize-after.png');
  const browserDelta =
    normalBrowser.status === 0 && swapBrowser.status === 0 && existsSync(normalAfterPath) && existsSync(swapAfterPath)
      ? comparePngs(normalAfterPath, swapAfterPath)
      : undefined;
  const normalDawn = run(
    `custom material two-slot resize Dawn normal ${repeat}`,
    ['--filter', '@forgeax/hello-custom-shader', 'run', 'smoke:normal-slot-live-dawn'],
    { FORGEAX_MATERIAL_LIVE_TWO_SLOT_RESIZE_VARIANT: 'normal', FORGEAX_MATERIAL_ARTIFACT_DIR: normalDir },
  );
  const swapDawn = run(
    `custom material two-slot resize Dawn swap ${repeat}`,
    ['--filter', '@forgeax/hello-custom-shader', 'run', 'smoke:normal-slot-live-dawn'],
    { FORGEAX_MATERIAL_LIVE_TWO_SLOT_RESIZE_VARIANT: 'swap', FORGEAX_MATERIAL_ARTIFACT_DIR: swapDir },
  );
  const normalDawnEvidence = normalDawn.status === 0 ? readLastJsonLine(normalDawn.output) : undefined;
  const swapDawnEvidence = swapDawn.status === 0 ? readLastJsonLine(swapDawn.output) : undefined;
  const dawnDelta =
    normalDawn.status === 0 && swapDawn.status === 0
      ? compareDawnReadbacks(
          resolve(normalDir, 'live-normal-slot-after-resize.rgba'),
          resolve(normalDir, 'live-normal-slot-after-resize.json'),
          resolve(swapDir, 'live-normal-slot-after-resize.rgba'),
          resolve(swapDir, 'live-normal-slot-after-resize.json'),
        )
      : undefined;
  if (
    normalBrowser.status !== 0 ||
    swapBrowser.status !== 0 ||
    normalBrowserEvidence?.resizeRebuild?.afterCanvas?.join('x') !== '384x192' ||
    swapBrowserEvidence?.resizeRebuild?.afterCanvas?.join('x') !== '384x192' ||
    normalBrowserEvidence?.liveMutation?.baseColorSlotChanged !== false ||
    normalBrowserEvidence?.liveMutation?.normalSlotChanged !== false ||
    swapBrowserEvidence?.liveMutation?.baseColorSlotChanged !== true ||
    swapBrowserEvidence?.liveMutation?.normalSlotChanged !== true ||
    swapBrowserEvidence?.liveMutation?.beforeTextureHandles?.[0] === swapBrowserEvidence?.liveMutation?.afterTextureHandles?.[0] ||
    swapBrowserEvidence?.liveMutation?.beforeTextureHandles?.[1] === swapBrowserEvidence?.liveMutation?.afterTextureHandles?.[1] ||
    swapBrowserEvidence?.resizeRebuild?.postResizeMaterialHandle !== swapBrowserEvidence?.liveMutation?.afterMaterialHandle ||
    normalBrowserEvidence?.resizeRebuild?.postResizeMaterialHandle !== normalBrowserEvidence?.liveMutation?.beforeMaterialHandle ||
    browserDelta?.meanRgbDelta <= 0.01 ||
    normalDawn.status !== 0 ||
    swapDawn.status !== 0 ||
    normalDawnEvidence?.resize?.after?.join('x') !== '256x192' ||
    swapDawnEvidence?.resize?.after?.join('x') !== '256x192' ||
    normalDawnEvidence?.material?.baseColorChanged !== false ||
    normalDawnEvidence?.material?.afterHandle !== normalDawnEvidence?.material?.beforeHandle ||
    swapDawnEvidence?.material?.baseColorChanged !== true ||
    swapDawnEvidence?.material?.afterHandle === swapDawnEvidence?.material?.beforeHandle ||
    swapDawnEvidence?.material?.normalSlotChanged !== true ||
    swapDawnEvidence?.material?.beforeTextureHandles?.[0] === swapDawnEvidence?.material?.afterTextureHandles?.[0] ||
    swapDawnEvidence?.material?.beforeTextureHandles?.[1] === swapDawnEvidence?.material?.afterTextureHandles?.[1] ||
    dawnDelta?.meanRgbDelta <= 0.001
  ) {
    console.error(
      `[m3-programmable] custom material two-slot resize/rebuild: FAIL - ${JSON.stringify({ normalBrowser: normalBrowserEvidence, swapBrowser: swapBrowserEvidence, browserDelta, normalDawn: normalDawnEvidence, swapDawn: swapDawnEvidence, dawnDelta })}`,
    );
    process.exit(1);
  }
  const snapshot = {
    browser: {
      normal: { resize: normalBrowserEvidence.resizeRebuild, sha256: sha256File(normalAfterPath) },
      swap: { mutation: swapBrowserEvidence.liveMutation, resize: swapBrowserEvidence.resizeRebuild, sha256: sha256File(swapAfterPath) },
      delta: browserDelta,
    },
    dawn: {
      normal: { material: normalDawnEvidence.material, resize: normalDawnEvidence.resize, sha256: normalDawnEvidence.after.sha256 },
      swap: { material: swapDawnEvidence.material, resize: swapDawnEvidence.resize, sha256: swapDawnEvidence.after.sha256 },
      delta: dawnDelta,
    },
  };
  writeFileSync(resolve(twoSlotResizeArtifactRoot, `repeat-${repeat}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
  twoSlotResizeRuns.push(snapshot);
}
if (repeatabilityDiff(twoSlotResizeRuns[0], twoSlotResizeRuns[1]) !== undefined) {
  console.error(
    `[m3-programmable] custom material two-slot resize/rebuild repeatability: FAIL - ${JSON.stringify({ first: twoSlotResizeRuns[0], second: twoSlotResizeRuns[1] })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom material two-slot live resize/rebuild: PASS repeats=2 browserChangedPixels=${twoSlotResizeRuns[0].browser.delta.changedPixels} browserMeanRgbDelta=${twoSlotResizeRuns[0].browser.delta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${twoSlotResizeRuns[0].dawn.delta.changedPixels}`,
);

const renderGraph = run('render graph seam', [
  'vitest',
  'run',
  '--project=dawn',
  'packages/runtime/src/__tests__/render-pipeline-trivial.dawn.test.ts',
]);
if (
  renderGraph.status !== 0 ||
  !renderGraph.output.includes('Test Files  1 passed (1)') ||
  !renderGraph.output.includes('Tests  5 passed (5)')
) {
  console.error('[m3-programmable] render graph seam: FAIL - Dawn custom pipeline suite did not pass');
  process.exit(1);
}
console.log('[m3-programmable] render graph seam: PASS');

const depthOverlay = run('depth-aware overlay', [
  '--filter',
  '@forgeax/app-learn-render-5-advanced-lighting-3-3-csm',
  'smoke',
]);
if (
  depthOverlay.status !== 0 ||
  !depthOverlay.output.includes('[smoke] PASS - criteria GREEN') ||
  !depthOverlay.output.includes('depth-banding-top/bottom-RG=') ||
  !depthOverlay.output.includes('shadowCascades=4')
) {
  console.error('[m3-programmable] depth-aware URP overlay: FAIL - depth/pixel gate did not pass');
  process.exit(1);
}
console.log('[m3-programmable] depth-aware URP overlay: PASS');

const fakeDepth = run(
  'fake-depth falsifier',
  ['--filter', '@forgeax/app-learn-render-5-advanced-lighting-3-3-csm', 'smoke'],
  { FALSIFY: 'force-fake-depth' },
);
const fakeDepthPixelOracleFailed =
  fakeDepth.output.includes('R/G stddev=') || fakeDepth.output.includes('no depth banding gradient --');
const fakeDepthExpectedFailure =
  fakeDepth.output.includes('expected spatial diversity from cascade bands') ||
  fakeDepth.output.includes('no depth banding gradient --');
if (
  fakeDepth.status === 0 ||
  !fakeDepth.output.includes('FALSIFY force-fake-depth') ||
  !fakeDepthPixelOracleFailed ||
  !fakeDepthExpectedFailure
) {
  console.error('[m3-programmable] fake-depth falsifier: FAIL - bad depth did not flip the pixel oracle');
  process.exit(1);
}
console.log('[m3-programmable] fake-depth falsifier: PASS');

const multiUvRoot = resolve(repoRoot, 'apps', 'hello-multi-uv');
const multiUv = run('multi-UV Dawn', ['--filter', '@forgeax/hello-multi-uv', 'smoke']);
if (
  multiUv.status !== 0 ||
  !multiUv.output.includes('[smoke] PASS - 5 criteria GREEN') ||
  !multiUv.output.includes('quadSampleMaxDiff=') ||
  !multiUv.output.includes('[smoke] texture binding: PASS schema=baseColorTexture+detailTexture textureSample=true')
) {
  console.error('[m3-programmable] multi-UV Dawn: FAIL - 2-UV public rendering gate did not pass');
  process.exit(1);
}
console.log('[m3-programmable] multi-UV Dawn: PASS');

const multiUvFalsify = run(
  'multi-UV falsifier',
  ['exec', 'node', 'scripts/smoke-falsify.mjs'],
  {},
  multiUvRoot,
);
if (
  multiUvFalsify.status !== 0 ||
  !multiUvFalsify.output.includes('PASS_FALSIFY') ||
  !multiUvFalsify.output.includes('maxDiff=0.0000')
) {
  console.error('[m3-programmable] multi-UV falsifier: FAIL - constant-uv1 control did not kill the oracle');
  process.exit(1);
}
console.log('[m3-programmable] multi-UV falsifier: PASS');

let multiUvManifest;
try {
  multiUvManifest = JSON.parse(
    readFileSync(resolve(multiUvRoot, 'dist', 'shaders', 'manifest.json'), 'utf8'),
  );
} catch (error) {
  console.error(`[m3-programmable] multi-UV variant: FAIL - manifest unreadable: ${error}`);
  process.exit(1);
}
const multiUvShader = (multiUvManifest.materialShaders ?? []).find(
  (entry) => entry?.identifier === 'hello-multi-uv::multi-uv-demo',
);
const variants = multiUvShader?.variants ?? [];
const falseVariant = variants.find((variant) => variant.defines?.M3_MULTI_UV_VARIANT === false);
if (
  multiUvShader?.uvSetCount !== 2 ||
  variants.length < 4 ||
  falseVariant === undefined ||
  falseVariant.composedWgsl === multiUvShader.composedWgsl
) {
  console.error(
    `[m3-programmable] multi-UV variant: FAIL - uvSetCount=${multiUvShader?.uvSetCount ?? 'missing'} variants=${variants.length}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] multi-UV variant: PASS uvSetCount=${multiUvShader.uvSetCount} variants=${variants.length} falseVariantBytesDiffer=true`,
);

const browserVariant = run(
  'multi-UV browser variant',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-variant'],
  {
    FORGEAX_M3_ARTIFACT_DIR:
      process.env.FORGEAX_M3_ARTIFACT_DIR ??
      resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering', 'browser-variant'),
  },
);
if (
  browserVariant.status !== 0 ||
  !browserVariant.output.includes('[m3-browser-variant] PASS -') ||
  !browserVariant.output.includes('falsifiedDelta=0.000')
) {
  console.error('[m3-programmable] multi-UV browser variant: FAIL - live compiled variant selection did not pass');
  process.exit(1);
}
console.log('[m3-programmable] multi-UV browser variant: PASS');

const browserLive = run(
  'browser live pipeline',
  ['--filter', '@forgeax/app-learn-render-4-advanced-opengl-5-framebuffers', 'run', 'smoke:browser-live'],
  {
    FORGEAX_M3_ARTIFACT_DIR:
      process.env.FORGEAX_M3_ARTIFACT_DIR ??
      resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering', 'browser-live'),
  },
);
if (browserLive.status !== 0 || !browserLive.output.includes('[m3-programmable] browser live pipeline: PASS')) {
  console.error('[m3-programmable] browser live pipeline: FAIL - public browser switch/resize/RHI evidence did not pass');
  process.exit(1);
}
console.log('[m3-programmable] browser live pipeline: PASS');

const browserComposed = run(
  'browser custom pipeline + post composition',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-composed'],
  {
    FORGEAX_M3_ARTIFACT_DIR:
      process.env.FORGEAX_M3_ARTIFACT_DIR ??
      resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering', 'browser-composed'),
  },
);
if (
  browserComposed.status !== 0 ||
  !browserComposed.output.includes('[m3-composed] PASS pipeline=custom') ||
  !browserComposed.output.includes('secondTextureChanged=')
) {
  console.error('[m3-programmable] browser custom pipeline + post composition: FAIL - combined selector journey did not pass');
  process.exit(1);
}
console.log('[m3-programmable] browser custom pipeline + post composition: PASS');
console.log('[m3-programmable] browser multi-texture falsifier: PASS');

const liveMaterialArtifactRoot =
  process.env.FORGEAX_M3_ARTIFACT_DIR ??
  resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering', 'live-material-two-slot-composed-repeatability');
const liveMaterialRuns = [];
for (const pass of ['first', 'second']) {
  liveMaterialRuns.push({
    pass,
    result: run(
      `browser composed two-slot material rebind ${pass}`,
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-composed'],
      {
        FORGEAX_M3_LIVE_MATERIAL: '1',
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(liveMaterialArtifactRoot, pass),
      },
    ),
  });
}
const liveMaterialSnapshots = liveMaterialRuns.map((runResult) => ({
  pass: runResult.pass,
  snapshot: readLiveMaterialSnapshot(resolve(liveMaterialArtifactRoot, runResult.pass)),
}));
for (const runResult of liveMaterialRuns) {
  if (
    runResult.result.status !== 0 ||
    !runResult.result.output.includes('[m3-live-material] PASS pipeline=custom post=inversion msaa=true') ||
    !runResult.result.output.includes('normalSlots=true/true') ||
    !runResult.result.output.includes('resizeHistory=640x360>480x270>720x405>640x360>480x270>720x405>640x360')
  ) {
    console.error(`[m3-programmable] composed two-slot material rebind ${runResult.pass}: FAIL`);
    process.exit(1);
  }
}
const firstLiveMaterial = liveMaterialSnapshots[0].snapshot;
const secondLiveMaterial = liveMaterialSnapshots[1].snapshot;
if (repeatabilityDiff(firstLiveMaterial, secondLiveMaterial) !== undefined) {
  console.error(`[m3-programmable] composed two-slot material rebind repeatability: FAIL - ${JSON.stringify({ first: firstLiveMaterial, second: secondLiveMaterial })}`);
  process.exit(1);
}
for (const leg of ['normal', 'falsifier']) {
  const value = firstLiveMaterial[leg];
  if (
    value.after.pipeline !== 'M3_PIPELINE=custom' ||
    value.after.post !== 'M3_POST_EFFECT=inversion' ||
    value.afterEvidence.resizeHistory.join('>') !== '640x360>480x270>720x405>640x360>480x270>720x405>640x360' ||
    value.draws === 0 ||
    value.inspectedDraw === undefined ||
    value.dawn.nonBlackPixelCount === 0
  ) {
    console.error(`[m3-programmable] composed two-slot material RHI/Dawn evidence: FAIL - ${JSON.stringify({ leg, value })}`);
    process.exit(1);
  }
}
if (
  firstLiveMaterial.normal.afterEvidence.baseColorSlotChanged !== true ||
  firstLiveMaterial.normal.afterEvidence.detailSlotChanged !== true ||
  firstLiveMaterial.normal.afterEvidence.afterComponentMaterialMatchesAfter !== true ||
  firstLiveMaterial.falsifier.afterEvidence.baseColorSlotChanged === true && firstLiveMaterial.falsifier.afterEvidence.detailSlotChanged === true ||
  firstLiveMaterial.normal.delta.changed < 1000 ||
  firstLiveMaterial.falsifier.delta.changed < 100
) {
  console.error(`[m3-programmable] composed two-slot material oracle: FAIL - ${JSON.stringify(firstLiveMaterial)}`);
  process.exit(1);
}
console.log(`[m3-programmable] composed two-slot material rebind repeatability: PASS normalChanged=${firstLiveMaterial.normal.delta.changed} falsifierChanged=${firstLiveMaterial.falsifier.delta.changed} normalDawnSha=${firstLiveMaterial.normal.dawn.sha256} falsifierDawnSha=${firstLiveMaterial.falsifier.dawn.sha256}`);

const noMsaaLiveMaterialArtifactRoot =
  process.env.FORGEAX_M3_ARTIFACT_DIR ??
  resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering', 'live-material-two-slot-composed-no-msaa-repeatability');
function runNoMsaaLiveMaterialRepeatability(startVariant) {
  const scenarioRoot = resolve(noMsaaLiveMaterialArtifactRoot, `start-${startVariant}`);
  const noMsaaLiveMaterialRuns = [];
  for (const pass of ['first', 'second']) {
    noMsaaLiveMaterialRuns.push({
      pass,
      result: run(
        `browser composed two-slot material rebind no-MSAA start=${startVariant} ${pass}`,
        ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-composed'],
        {
          FORGEAX_M3_LIVE_MATERIAL: '1',
          FORGEAX_M3_MSAA: '0',
          FORGEAX_M3_START_VARIANT: startVariant,
          FORGEAX_M3_RESIZE_CHURN: '1',
          FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
          FORGEAX_M3_ARTIFACT_DIR: resolve(scenarioRoot, pass),
        },
      ),
    });
  }
  const noMsaaLiveMaterialSnapshots = noMsaaLiveMaterialRuns.map((runResult) => ({
    pass: runResult.pass,
    snapshot: readLiveMaterialSnapshot(resolve(scenarioRoot, runResult.pass)),
  }));
  const expectedVariant = `M3_MULTI_UV_VARIANT=${startVariant}`;
  for (const runResult of noMsaaLiveMaterialRuns) {
    if (
      runResult.result.status !== 0 ||
      !runResult.result.output.includes(`[m3-live-material] PASS pipeline=custom post=inversion msaa=false startVariant=${startVariant}`) ||
      !runResult.result.output.includes('normalSlots=true/true') ||
      !runResult.result.output.includes('resizeHistory=640x360>480x270>720x405>640x360>480x270>720x405>640x360')
    ) {
      console.error(`[m3-programmable] composed two-slot material rebind no-MSAA start=${startVariant} ${runResult.pass}: FAIL`);
      process.exit(1);
    }
  }
  const firstNoMsaaLiveMaterial = noMsaaLiveMaterialSnapshots[0].snapshot;
  const secondNoMsaaLiveMaterial = noMsaaLiveMaterialSnapshots[1].snapshot;
  if (repeatabilityDiff(firstNoMsaaLiveMaterial, secondNoMsaaLiveMaterial) !== undefined) {
    console.error(`[m3-programmable] composed two-slot material rebind no-MSAA start=${startVariant} repeatability: FAIL - ${JSON.stringify({ first: firstNoMsaaLiveMaterial, second: secondNoMsaaLiveMaterial })}`);
    process.exit(1);
  }
  for (const leg of ['normal', 'falsifier']) {
    const value = firstNoMsaaLiveMaterial[leg];
    if (
      value.before.variant !== expectedVariant ||
      value.after.variant !== expectedVariant ||
      value.after.pipeline !== 'M3_PIPELINE=custom' ||
      value.after.post !== 'M3_POST_EFFECT=inversion' ||
      value.afterEvidence.resizeHistory.join('>') !== '640x360>480x270>720x405>640x360>480x270>720x405>640x360' ||
      value.draws === 0 ||
      value.inspectedDraw === undefined ||
      value.dawn.nonBlackPixelCount === 0
    ) {
      console.error(`[m3-programmable] composed two-slot material no-MSAA start=${startVariant} RHI/Dawn evidence: FAIL - ${JSON.stringify({ leg, value })}`);
      process.exit(1);
    }
  }
  if (
    firstNoMsaaLiveMaterial.normal.afterEvidence.baseColorSlotChanged !== true ||
    firstNoMsaaLiveMaterial.normal.afterEvidence.detailSlotChanged !== true ||
    firstNoMsaaLiveMaterial.normal.afterEvidence.afterComponentMaterialMatchesAfter !== true ||
    (firstNoMsaaLiveMaterial.falsifier.afterEvidence.baseColorSlotChanged === true &&
      firstNoMsaaLiveMaterial.falsifier.afterEvidence.detailSlotChanged === true) ||
    firstNoMsaaLiveMaterial.normal.delta.changed < 1000 ||
    firstNoMsaaLiveMaterial.falsifier.delta.changed < 100
  ) {
    console.error(`[m3-programmable] composed two-slot material no-MSAA start=${startVariant} oracle: FAIL - ${JSON.stringify(firstNoMsaaLiveMaterial)}`);
    process.exit(1);
  }
  console.log(`[m3-programmable] composed two-slot material no-MSAA start=${startVariant} rebind repeatability: PASS normalChanged=${firstNoMsaaLiveMaterial.normal.delta.changed} falsifierChanged=${firstNoMsaaLiveMaterial.falsifier.delta.changed} normalDawnSha=${firstNoMsaaLiveMaterial.normal.dawn.sha256} falsifierDawnSha=${firstNoMsaaLiveMaterial.falsifier.dawn.sha256}`);
}
runNoMsaaLiveMaterialRepeatability('true');
runNoMsaaLiveMaterialRepeatability('false');

const composedInheritanceLiveArtifactRoot =
  process.env.FORGEAX_M3_ARTIFACT_DIR ??
  resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering', 'inheritance-live-material-composed-repeatability');
const composedInheritanceLiveRuns = [];
for (const pass of ['first', 'second']) {
  const result = run(
    `browser composed inherited material rebind ${pass}`,
    ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-composed'],
    {
      FORGEAX_M3_INHERITANCE_LIVE_MATERIAL: '1',
      FORGEAX_M3_MSAA: '1',
      FORGEAX_M3_START_VARIANT: 'true',
      FORGEAX_M3_RESIZE_CHURN: '1',
      FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
      FORGEAX_M3_ARTIFACT_DIR: resolve(composedInheritanceLiveArtifactRoot, pass),
    },
  );
  composedInheritanceLiveRuns.push({
    pass,
    result,
    snapshot: readLiveMaterialSnapshot(resolve(composedInheritanceLiveArtifactRoot, pass)),
  });
}
for (const runResult of composedInheritanceLiveRuns) {
  if (
    runResult.result.status !== 0 ||
    !runResult.result.output.includes('[m3-live-material] PASS pipeline=custom post=inversion msaa=true startVariant=true') ||
    !runResult.result.output.includes('normalSlots=true/true') ||
    !runResult.result.output.includes('falsifierSlots=false/false') ||
    !runResult.result.output.includes('resizeHistory=640x360>480x270>720x405>640x360>480x270>720x405>640x360')
  ) {
    console.error(`[m3-programmable] composed inherited material rebind ${runResult.pass}: FAIL`);
    process.exit(1);
  }
}
const firstComposedInheritanceLive = composedInheritanceLiveRuns[0].snapshot;
const secondComposedInheritanceLive = composedInheritanceLiveRuns[1].snapshot;
if (repeatabilityDiff(firstComposedInheritanceLive, secondComposedInheritanceLive) !== undefined) {
  console.error(
    `[m3-programmable] composed inherited material rebind repeatability: FAIL - ${JSON.stringify({ first: firstComposedInheritanceLive, second: secondComposedInheritanceLive })}`,
  );
  process.exit(1);
}
for (const leg of ['normal', 'falsifier']) {
  const value = firstComposedInheritanceLive[leg];
  if (
    value.before.variant !== 'M3_MULTI_UV_VARIANT=true' ||
    value.after.variant !== 'M3_MULTI_UV_VARIANT=true' ||
    value.after.pipeline !== 'M3_PIPELINE=custom' ||
    value.after.post !== 'M3_POST_EFFECT=inversion' ||
    value.afterEvidence.resizeHistory.join('>') !== '640x360>480x270>720x405>640x360>480x270>720x405>640x360' ||
    value.draws === 0 ||
    value.inspectedDraw === undefined ||
    value.dawn.nonBlackPixelCount === 0
  ) {
    console.error(`[m3-programmable] composed inherited material RHI/Dawn evidence: FAIL - ${JSON.stringify({ leg, value })}`);
    process.exit(1);
  }
}
const normalInheritedEvidence = firstComposedInheritanceLive.normal.afterEvidence;
const falsifierInheritedEvidence = firstComposedInheritanceLive.falsifier.afterEvidence;
if (
  normalInheritedEvidence.inheritanceBacked !== true ||
  normalInheritedEvidence.sourceRootGuid === null ||
  normalInheritedEvidence.sourceDerivedGuid === null ||
  normalInheritedEvidence.sourceRootGuid === normalInheritedEvidence.sourceDerivedGuid ||
  normalInheritedEvidence.sourceRootArtifactDigest !== normalInheritedEvidence.sourceArtifactDigest ||
  normalInheritedEvidence.sourceRootCookInputDigest !== normalInheritedEvidence.sourceCookInputDigest ||
  normalInheritedEvidence.beforeMaterialHandle === normalInheritedEvidence.afterMaterialHandle ||
  normalInheritedEvidence.beforeTextureHandles[0] === normalInheritedEvidence.afterTextureHandles[0] ||
  normalInheritedEvidence.beforeTextureHandles[1] === normalInheritedEvidence.afterTextureHandles[1] ||
  normalInheritedEvidence.afterComponentMaterialMatchesAfter !== true ||
  firstComposedInheritanceLive.normal.delta.changed < 1000 ||
  falsifierInheritedEvidence.inheritanceBacked !== true ||
  falsifierInheritedEvidence.beforeMaterialHandle === falsifierInheritedEvidence.afterMaterialHandle ||
  falsifierInheritedEvidence.beforeTextureHandles[0] !== falsifierInheritedEvidence.afterTextureHandles[0] ||
  falsifierInheritedEvidence.beforeTextureHandles[1] !== falsifierInheritedEvidence.afterTextureHandles[1] ||
  falsifierInheritedEvidence.falsifierMarker !== 'FALSIFY_EXPECTED_FAILURE:live-inheritance-rebind' ||
  firstComposedInheritanceLive.falsifier.delta.changed !== 0
) {
  console.error(
    `[m3-programmable] composed inherited material oracle: FAIL - ${JSON.stringify(firstComposedInheritanceLive)}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] composed inherited material rebind repeatability: PASS normalChanged=${firstComposedInheritanceLive.normal.delta.changed} falsifierChanged=${firstComposedInheritanceLive.falsifier.delta.changed} dawnSha=${firstComposedInheritanceLive.normal.dawn.sha256}`,
);

function runComposedInheritanceStartRepeatability({ msaa, startVariant }) {
  const switchedVariant = startVariant === 'true' ? 'false' : 'true';
  const mode = msaa ? 'msaa' : 'no-msaa';
  const modeLabel = msaa ? 'MSAA' : 'no-MSAA';
  const artifactRoot = resolve(
    process.env.FORGEAX_M3_ARTIFACT_DIR ?? resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering'),
    `inheritance-live-material-composed-${mode}-start-${startVariant}-repeatability`,
  );
  const runs = [];
  for (const pass of ['first', 'second']) {
    const artifactDir = resolve(artifactRoot, pass);
    runs.push({
      pass,
      result: run(
        `browser composed inherited material ${modeLabel} startup-${startVariant} rebind ${pass}`,
        ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-composed'],
        {
          FORGEAX_M3_INHERITANCE_LIVE_MATERIAL: '1',
          FORGEAX_M3_LIVE_VARIANT_SWITCH: '1',
          FORGEAX_M3_MSAA: msaa ? '1' : '0',
          FORGEAX_M3_START_VARIANT: startVariant,
          FORGEAX_M3_RESIZE_CHURN: '1',
          FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
          FORGEAX_M3_ARTIFACT_DIR: artifactDir,
        },
      ),
      snapshot: readLiveMaterialSnapshot(artifactDir),
    });
  }
  for (const runResult of runs) {
    if (
      runResult.result.status !== 0 ||
      !runResult.result.output.includes(`[m3-live-material] PASS pipeline=custom post=inversion msaa=${msaa} startVariant=${startVariant} variantSwitch=true`) ||
      !runResult.result.output.includes('normalSlots=true/true') ||
      !runResult.result.output.includes('falsifierSlots=false/false') ||
      !runResult.result.output.includes('resizeHistory=640x360>480x270>720x405>640x360>480x270>720x405>640x360')
    ) {
      console.error(`[m3-programmable] composed inherited material ${modeLabel} startup-${startVariant} ${runResult.pass}: FAIL`);
      process.exit(1);
    }
  }
  const first = runs[0].snapshot;
  const second = runs[1].snapshot;
  if (repeatabilityDiff(first, second) !== undefined) {
    console.error(
      `[m3-programmable] composed inherited material ${modeLabel} startup-${startVariant} repeatability: FAIL - ${JSON.stringify({ first, second })}`,
    );
    process.exit(1);
  }
  const expectedRenderedVariant = `M3_MULTI_UV_VARIANT=${switchedVariant}`;
  for (const [leg, value] of Object.entries(first)) {
    if (
      value.before.variant !== expectedRenderedVariant ||
      value.after.variant !== expectedRenderedVariant ||
      value.after.pipeline !== 'M3_PIPELINE=custom' ||
      value.after.post !== 'M3_POST_EFFECT=inversion' ||
      value.afterEvidence.resizeHistory.join('>') !== '640x360>480x270>720x405>640x360>480x270>720x405>640x360' ||
      value.rhiTopology.msaaTextureResourceCount !== (msaa ? 4 : 0) ||
      value.rhiTopology.resolveTargetCount !== (msaa ? 1 : 0) ||
      value.draws !== 2 ||
      value.inspectedDraw === undefined ||
      value.dawn.nonBlackPixelCount === 0
    ) {
      console.error(`[m3-programmable] composed inherited material ${modeLabel} startup-${startVariant} ${leg} topology: FAIL - ${JSON.stringify(value)}`);
      process.exit(1);
    }
  }
  const normal = first.normal;
  const falsifier = first.falsifier;
  if (
    normal.afterEvidence.inheritanceBacked !== true ||
    normal.afterEvidence.baseColorSlotChanged !== true ||
    normal.afterEvidence.detailSlotChanged !== true ||
    normal.afterEvidence.afterComponentMaterialMatchesAfter !== true ||
    normal.afterEvidence.sourceRootArtifactDigest !== normal.afterEvidence.sourceArtifactDigest ||
    normal.afterEvidence.sourceRootCookInputDigest !== normal.afterEvidence.sourceCookInputDigest ||
    normal.delta.changed < 1000 ||
    falsifier.afterEvidence.inheritanceBacked !== true ||
    falsifier.afterEvidence.baseColorSlotChanged !== false ||
    falsifier.afterEvidence.detailSlotChanged !== false ||
    falsifier.afterEvidence.falsifierMarker !== 'FALSIFY_EXPECTED_FAILURE:live-inheritance-rebind' ||
    falsifier.delta.changed !== 0
  ) {
    console.error(
      `[m3-programmable] composed inherited material ${modeLabel} startup-${startVariant} oracle: FAIL - ${JSON.stringify(first)}`,
    );
    process.exit(1);
  }
  console.log(
    `[m3-programmable] composed inherited material ${modeLabel} startup-${startVariant} repeatability: PASS normalChanged=${normal.delta.changed} falsifierChanged=${falsifier.delta.changed} dawnSha=${normal.dawn.sha256}`,
  );
}

function runComposedInheritancePipelineFalsifierRepeatability({ msaa, startVariant }) {
  const switchedVariant = startVariant === 'true' ? 'false' : 'true';
  const mode = msaa ? 'msaa' : 'no-msaa';
  const modeLabel = msaa ? 'MSAA' : 'no-MSAA';
  const artifactRoot = resolve(
    process.env.FORGEAX_M3_ARTIFACT_DIR ?? resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering'),
    `inheritance-live-material-composed-${mode}-start-${startVariant}-pipeline-falsifier-repeatability`,
  );
  const runs = [];
  for (const pass of ['first', 'second']) {
    const artifactDir = resolve(artifactRoot, pass);
    runs.push({
      pass,
      result: run(
        `browser composed inherited material ${modeLabel} startup-${startVariant} pipeline falsifier ${pass}`,
        ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-composed'],
        {
          FORGEAX_M3_INHERITANCE_LIVE_MATERIAL: '1',
          FORGEAX_M3_INHERITANCE_FALSIFIER_KIND: 'pipeline',
          FORGEAX_M3_LIVE_VARIANT_SWITCH: '1',
          FORGEAX_M3_MSAA: msaa ? '1' : '0',
          FORGEAX_M3_START_VARIANT: startVariant,
          FORGEAX_M3_RESIZE_CHURN: '1',
          FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
          FORGEAX_M3_ARTIFACT_DIR: artifactDir,
        },
      ),
      snapshot: readLiveMaterialSnapshot(artifactDir),
    });
  }
  for (const runResult of runs) {
    if (
      runResult.result.status !== 0 ||
      !runResult.result.output.includes(`[m3-live-material] PASS pipeline=custom post=inversion msaa=${msaa} startVariant=${startVariant} variantSwitch=true falsifier=pipeline`) ||
      !runResult.result.output.includes('normalSlots=true/true') ||
      !runResult.result.output.includes('falsifierSlots=true/true') ||
      !runResult.result.output.includes('draws=2/1') ||
      !runResult.result.output.includes('resizeHistory=640x360>480x270>720x405>640x360>480x270>720x405>640x360')
    ) {
      console.error(`[m3-programmable] composed inherited material ${modeLabel} startup-${startVariant} pipeline falsifier ${runResult.pass}: FAIL`);
      process.exit(1);
    }
  }
  const first = runs[0].snapshot;
  const second = runs[1].snapshot;
  if (repeatabilityDiff(first, second) !== undefined) {
    console.error(
      `[m3-programmable] composed inherited material ${modeLabel} startup-${startVariant} pipeline falsifier repeatability: FAIL - ${JSON.stringify({ first, second })}`,
    );
    process.exit(1);
  }
  for (const [leg, value] of Object.entries(first)) {
    if (
      value.before.variant !== `M3_MULTI_UV_VARIANT=${switchedVariant}` ||
      value.after.variant !== `M3_MULTI_UV_VARIANT=${switchedVariant}` ||
      value.after.pipeline !== 'M3_PIPELINE=custom' ||
      value.after.post !== 'M3_POST_EFFECT=inversion' ||
      value.afterEvidence.resizeHistory.join('>') !== '640x360>480x270>720x405>640x360>480x270>720x405>640x360' ||
      value.rhiTopology.msaaTextureResourceCount !== (msaa ? (leg === 'normal' ? 4 : 2) : 0) ||
      value.rhiTopology.resolveTargetCount !== (msaa ? 1 : 0) ||
      value.draws !== (leg === 'normal' ? 2 : 1) ||
      value.inspectedDraw === undefined ||
      value.dawn.nonBlackPixelCount === 0
    ) {
      console.error(`[m3-programmable] composed inherited material ${modeLabel} startup-${startVariant} pipeline falsifier ${leg}: FAIL - ${JSON.stringify(value)}`);
      process.exit(1);
    }
  }
  const normal = first.normal;
  const falsifier = first.falsifier;
  if (
    normal.afterEvidence.inheritanceBacked !== true ||
    normal.afterEvidence.baseColorSlotChanged !== true ||
    normal.afterEvidence.detailSlotChanged !== true ||
    normal.afterEvidence.afterComponentMaterialMatchesAfter !== true ||
    normal.delta.changed < 1000 ||
    falsifier.afterEvidence.inheritanceBacked !== true ||
    falsifier.afterEvidence.baseColorSlotChanged !== true ||
    falsifier.afterEvidence.detailSlotChanged !== true ||
    falsifier.afterEvidence.falsifierMarker !== null ||
    falsifier.delta.changed < 1000 ||
    normal.dawn.sha256 === falsifier.dawn.sha256
  ) {
    console.error(
      `[m3-programmable] composed inherited material ${modeLabel} startup-${startVariant} pipeline falsifier oracle: FAIL - ${JSON.stringify(first)}`,
    );
    process.exit(1);
  }
  console.log(
    `[m3-programmable] composed inherited material ${modeLabel} startup-${startVariant} pipeline falsifier repeatability: PASS normalChanged=${normal.delta.changed} falsifierChanged=${falsifier.delta.changed} draws=${normal.draws}/${falsifier.draws} dawnSha=${normal.dawn.sha256}/${falsifier.dawn.sha256}`,
  );
}

runComposedInheritanceStartRepeatability({ msaa: false, startVariant: 'false' });
runComposedInheritanceStartRepeatability({ msaa: false, startVariant: 'true' });
runComposedInheritanceStartRepeatability({ msaa: true, startVariant: 'false' });
runComposedInheritanceStartRepeatability({ msaa: true, startVariant: 'true' });
runComposedInheritancePipelineFalsifierRepeatability({ msaa: false, startVariant: 'false' });
runComposedInheritancePipelineFalsifierRepeatability({ msaa: false, startVariant: 'true' });
runComposedInheritancePipelineFalsifierRepeatability({ msaa: true, startVariant: 'false' });
runComposedInheritancePipelineFalsifierRepeatability({ msaa: true, startVariant: 'true' });

function runComposedInheritancePostRepeatability({ msaa, startVariant, post = 'depth', falsifierKind = 'texture' }) {
  const mode = msaa ? 'msaa' : 'no-msaa';
  const depthPost = post === 'depth';
  const pipelineFalsifier =
    falsifierKind === 'pipeline' ||
    falsifierKind === 'pipeline-texture' ||
    falsifierKind === 'reverse-pipeline' ||
    falsifierKind === 'reverse-pipeline-texture';
  const reversePipelineFalsifier =
    falsifierKind === 'reverse-pipeline' || falsifierKind === 'reverse-pipeline-texture';
  const textureSlotFalsifier =
    falsifierKind === 'texture' ||
    falsifierKind === 'pipeline-texture' ||
    falsifierKind === 'reverse-pipeline-texture';
  const expectedPipeline = reversePipelineFalsifier ? 'standard' : 'custom';
  const passLabel = pipelineFalsifier ? `${mode} ${falsifierKind} falsifier` : mode;
  const artifactSuffix = pipelineFalsifier ? `-${falsifierKind}-falsifier` : '';
  const artifactRoot = resolve(
    process.env.FORGEAX_M3_ARTIFACT_DIR ?? resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering'),
    `inheritance-${depthPost ? 'depth-post' : `${post}-post`}-composed-${mode}-start-${startVariant}${artifactSuffix}-repeatability`,
  );
  const runs = [];
  for (const pass of ['first', 'second']) {
    const artifactDir = resolve(artifactRoot, pass);
    runs.push({
      pass,
      result: run(
        `browser inherited material ${post} post ${mode} startup-${startVariant} ${pass}`,
        ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-composed'],
        {
          FORGEAX_M3_INHERITANCE_LIVE_MATERIAL: '1',
          FORGEAX_M3_INHERITANCE_POST: post,
          FORGEAX_M3_INHERITANCE_DEPTH_POST: depthPost ? '1' : '0',
          FORGEAX_M3_INHERITANCE_FALSIFIER_KIND: falsifierKind,
          FORGEAX_M3_LIVE_VARIANT_SWITCH: '1',
          FORGEAX_M3_MSAA: msaa ? '1' : '0',
          FORGEAX_M3_START_VARIANT: startVariant,
          FORGEAX_M3_RESIZE_CHURN: '1',
          FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
          FORGEAX_M3_ARTIFACT_DIR: artifactDir,
        },
      ),
      snapshot: readLiveMaterialSnapshot(artifactDir),
    });
  }
  for (const runResult of runs) {
    if (
      runResult.result.status !== 0 ||
      !runResult.result.output.includes(
        `[m3-live-material] PASS pipeline=${expectedPipeline} post=${post} msaa=${msaa} startVariant=${startVariant} variantSwitch=true falsifier=${falsifierKind}`,
      ) ||
      !runResult.result.output.includes('normalSlots=true/true') ||
      !runResult.result.output.includes(`falsifierSlots=${textureSlotFalsifier ? 'false/false' : 'true/true'}`) ||
      !runResult.result.output.includes('resizeHistory=640x360>480x270>720x405>640x360>480x270>720x405>640x360')
    ) {
      console.error(`[m3-programmable] inherited material ${post} post ${passLabel} startup-${startVariant} ${runResult.pass}: FAIL`);
      process.exit(1);
    }
  }
  const first = runs[0].snapshot;
  const second = runs[1].snapshot;
  if (repeatabilityDiff(first, second) !== undefined) {
    console.error(`[m3-programmable] inherited material ${post} post ${passLabel} repeatability: FAIL - ${JSON.stringify({ first, second })}`);
    process.exit(1);
  }
  const expectedRenderedVariant = `M3_MULTI_UV_VARIANT=${startVariant === 'true' ? 'false' : 'true'}`;
  for (const [leg, value] of Object.entries(first)) {
    if (
      value.before.variant !== expectedRenderedVariant ||
      value.after.variant !== expectedRenderedVariant ||
      value.after.pipeline !== `M3_PIPELINE=${expectedPipeline}` ||
      value.after.post !== `M3_POST_EFFECT=${post}` ||
      value.afterEvidence.resizeHistory.join('>') !== '640x360>480x270>720x405>640x360>480x270>720x405>640x360' ||
      value.rhiTopology.msaaTextureResourceCount !==
        (msaa ? (reversePipelineFalsifier || (pipelineFalsifier && leg === 'falsifier') ? 2 : 4) : 0) ||
      value.rhiTopology.resolveTargetCount !== (msaa ? 1 : 0) ||
      value.rhiTopology.hasDepthBinding !== (depthPost && (pipelineFalsifier ? leg === 'normal' : true)) ||
      value.draws !== (pipelineFalsifier && leg === 'falsifier' ? 1 : 2) ||
      value.inspectedDraw === undefined ||
      value.dawn.nonBlackPixelCount === 0
    ) {
      console.error(`[m3-programmable] inherited material ${post} post ${passLabel} ${leg} topology: FAIL - ${JSON.stringify(value)}`);
      process.exit(1);
    }
  }
  const normal = first.normal;
  const falsifier = first.falsifier;
  const textureFalsifierOracle =
    falsifier.afterEvidence.baseColorSlotChanged === false &&
    falsifier.afterEvidence.detailSlotChanged === false &&
    falsifier.afterEvidence.falsifierMarker === 'FALSIFY_EXPECTED_FAILURE:live-inheritance-rebind' &&
    falsifier.delta.changed === 0;
  const reversePipelineTextureFalsifierOracle =
    falsifier.afterEvidence.baseColorSlotChanged === false &&
    falsifier.afterEvidence.detailSlotChanged === false &&
    falsifier.afterEvidence.falsifierMarker === 'FALSIFY_EXPECTED_FAILURE:live-inheritance-rebind' &&
    falsifier.delta.changed === 0 &&
    normal.dawn.sha256 !== falsifier.dawn.sha256 &&
    normal.draws !== falsifier.draws;
  const pipelineTextureFalsifierOracle =
    falsifier.afterEvidence.baseColorSlotChanged === false &&
    falsifier.afterEvidence.detailSlotChanged === false &&
    falsifier.afterEvidence.falsifierMarker === 'FALSIFY_EXPECTED_FAILURE:live-inheritance-rebind' &&
    falsifier.delta.changed === 0 &&
    normal.dawn.sha256 !== falsifier.dawn.sha256 &&
    normal.draws !== falsifier.draws;
  const pipelineFalsifierOracle =
    falsifier.afterEvidence.baseColorSlotChanged === true &&
    falsifier.afterEvidence.detailSlotChanged === true &&
    falsifier.afterEvidence.falsifierMarker === null &&
    falsifier.delta.changed >= 1000 &&
    normal.draws !== falsifier.draws &&
    (post === 'passthrough' || normal.dawn.sha256 !== falsifier.dawn.sha256);
  if (
    normal.afterEvidence.inheritanceBacked !== true ||
    normal.afterEvidence.baseColorSlotChanged !== true ||
    normal.afterEvidence.detailSlotChanged !== true ||
    normal.afterEvidence.afterComponentMaterialMatchesAfter !== true ||
    normal.delta.changed < 1000 ||
    falsifier.afterEvidence.inheritanceBacked !== true ||
    (falsifierKind === 'pipeline-texture'
      ? !pipelineTextureFalsifierOracle
      : falsifierKind === 'reverse-pipeline-texture'
        ? !reversePipelineTextureFalsifierOracle
      : pipelineFalsifier
        ? !pipelineFalsifierOracle
        : !textureFalsifierOracle)
  ) {
    console.error(`[m3-programmable] inherited material ${post} post ${passLabel} oracle: FAIL - ${JSON.stringify(first)}`);
    process.exit(1);
  }
  console.log(
    `[m3-programmable] inherited material ${post} post ${passLabel} startup-${startVariant} repeatability: PASS normalChanged=${normal.delta.changed} falsifierChanged=${falsifier.delta.changed} dawnSha=${normal.dawn.sha256}`,
  );
}

runComposedInheritancePostRepeatability({ msaa: false, startVariant: 'false' });
runComposedInheritancePostRepeatability({ msaa: false, startVariant: 'true' });
runComposedInheritancePostRepeatability({ msaa: true, startVariant: 'false' });
runComposedInheritancePostRepeatability({ msaa: true, startVariant: 'true' });
runComposedInheritancePostRepeatability({ msaa: false, startVariant: 'false', falsifierKind: 'pipeline' });
runComposedInheritancePostRepeatability({ msaa: false, startVariant: 'true', falsifierKind: 'pipeline' });
runComposedInheritancePostRepeatability({ msaa: true, startVariant: 'false', falsifierKind: 'pipeline' });
runComposedInheritancePostRepeatability({ msaa: true, startVariant: 'true', falsifierKind: 'pipeline' });
runComposedInheritancePostRepeatability({ msaa: false, startVariant: 'false', falsifierKind: 'reverse-pipeline' });
runComposedInheritancePostRepeatability({ msaa: false, startVariant: 'true', falsifierKind: 'reverse-pipeline' });
runComposedInheritancePostRepeatability({ msaa: true, startVariant: 'false', falsifierKind: 'reverse-pipeline' });
runComposedInheritancePostRepeatability({ msaa: true, startVariant: 'true', falsifierKind: 'reverse-pipeline' });
runComposedInheritancePostRepeatability({ msaa: false, startVariant: 'false', falsifierKind: 'reverse-pipeline-texture' });
runComposedInheritancePostRepeatability({ msaa: false, startVariant: 'true', falsifierKind: 'reverse-pipeline-texture' });
runComposedInheritancePostRepeatability({ msaa: true, startVariant: 'false', falsifierKind: 'reverse-pipeline-texture' });
runComposedInheritancePostRepeatability({ msaa: true, startVariant: 'true', falsifierKind: 'reverse-pipeline-texture' });
runComposedInheritancePostRepeatability({ msaa: false, startVariant: 'false', falsifierKind: 'pipeline-texture' });
runComposedInheritancePostRepeatability({ msaa: false, startVariant: 'true', falsifierKind: 'pipeline-texture' });
runComposedInheritancePostRepeatability({ msaa: true, startVariant: 'false', falsifierKind: 'pipeline-texture' });
runComposedInheritancePostRepeatability({ msaa: true, startVariant: 'true', falsifierKind: 'pipeline-texture' });
runComposedInheritancePostRepeatability({ post: 'inversion', msaa: false, startVariant: 'false', falsifierKind: 'reverse-pipeline' });
runComposedInheritancePostRepeatability({ post: 'inversion', msaa: false, startVariant: 'true', falsifierKind: 'reverse-pipeline' });
runComposedInheritancePostRepeatability({ post: 'inversion', msaa: true, startVariant: 'false', falsifierKind: 'reverse-pipeline' });
runComposedInheritancePostRepeatability({ post: 'inversion', msaa: true, startVariant: 'true', falsifierKind: 'reverse-pipeline' });
runComposedInheritancePostRepeatability({ post: 'inversion', msaa: false, startVariant: 'false', falsifierKind: 'reverse-pipeline-texture' });
runComposedInheritancePostRepeatability({ post: 'inversion', msaa: false, startVariant: 'true', falsifierKind: 'reverse-pipeline-texture' });
runComposedInheritancePostRepeatability({ post: 'inversion', msaa: true, startVariant: 'false', falsifierKind: 'reverse-pipeline-texture' });
runComposedInheritancePostRepeatability({ post: 'inversion', msaa: true, startVariant: 'true', falsifierKind: 'reverse-pipeline-texture' });
runComposedInheritancePostRepeatability({ post: 'inversion', msaa: false, startVariant: 'false', falsifierKind: 'pipeline' });
runComposedInheritancePostRepeatability({ post: 'inversion', msaa: false, startVariant: 'true', falsifierKind: 'pipeline' });
runComposedInheritancePostRepeatability({ post: 'inversion', msaa: true, startVariant: 'false', falsifierKind: 'pipeline' });
runComposedInheritancePostRepeatability({ post: 'inversion', msaa: true, startVariant: 'true', falsifierKind: 'pipeline' });
runComposedInheritancePostRepeatability({ post: 'passthrough', msaa: false, startVariant: 'false', falsifierKind: 'pipeline' });
runComposedInheritancePostRepeatability({ post: 'passthrough', msaa: false, startVariant: 'true', falsifierKind: 'pipeline' });
runComposedInheritancePostRepeatability({ post: 'passthrough', msaa: true, startVariant: 'false', falsifierKind: 'pipeline' });
runComposedInheritancePostRepeatability({ post: 'passthrough', msaa: true, startVariant: 'true', falsifierKind: 'pipeline' });
runComposedInheritancePostRepeatability({ post: 'passthrough', msaa: false, startVariant: 'false', falsifierKind: 'reverse-pipeline' });
runComposedInheritancePostRepeatability({ post: 'passthrough', msaa: false, startVariant: 'true', falsifierKind: 'reverse-pipeline' });
runComposedInheritancePostRepeatability({ post: 'passthrough', msaa: true, startVariant: 'false', falsifierKind: 'reverse-pipeline' });
runComposedInheritancePostRepeatability({ post: 'passthrough', msaa: true, startVariant: 'true', falsifierKind: 'reverse-pipeline' });
runComposedInheritancePostRepeatability({ post: 'passthrough', msaa: false, startVariant: 'false', falsifierKind: 'reverse-pipeline-texture' });
runComposedInheritancePostRepeatability({ post: 'passthrough', msaa: false, startVariant: 'true', falsifierKind: 'reverse-pipeline-texture' });
runComposedInheritancePostRepeatability({ post: 'passthrough', msaa: true, startVariant: 'false', falsifierKind: 'reverse-pipeline-texture' });
runComposedInheritancePostRepeatability({ post: 'passthrough', msaa: true, startVariant: 'true', falsifierKind: 'reverse-pipeline-texture' });
runComposedInheritancePostRepeatability({ post: 'passthrough', msaa: false, startVariant: 'false', falsifierKind: 'texture' });
runComposedInheritancePostRepeatability({ post: 'passthrough', msaa: false, startVariant: 'true', falsifierKind: 'texture' });
runComposedInheritancePostRepeatability({ post: 'passthrough', msaa: true, startVariant: 'false', falsifierKind: 'texture' });
runComposedInheritancePostRepeatability({ post: 'passthrough', msaa: true, startVariant: 'true', falsifierKind: 'texture' });
runComposedInheritancePostRepeatability({ post: 'passthrough', msaa: false, startVariant: 'false', falsifierKind: 'pipeline-texture' });
runComposedInheritancePostRepeatability({ post: 'passthrough', msaa: false, startVariant: 'true', falsifierKind: 'pipeline-texture' });
runComposedInheritancePostRepeatability({ post: 'passthrough', msaa: true, startVariant: 'false', falsifierKind: 'pipeline-texture' });
runComposedInheritancePostRepeatability({ post: 'passthrough', msaa: true, startVariant: 'true', falsifierKind: 'pipeline-texture' });
runComposedInheritancePostRepeatability({ post: 'inversion', msaa: false, startVariant: 'false', falsifierKind: 'texture' });
runComposedInheritancePostRepeatability({ post: 'inversion', msaa: false, startVariant: 'true', falsifierKind: 'texture' });
runComposedInheritancePostRepeatability({ post: 'inversion', msaa: true, startVariant: 'false', falsifierKind: 'texture' });
runComposedInheritancePostRepeatability({ post: 'inversion', msaa: true, startVariant: 'true', falsifierKind: 'texture' });
runComposedInheritancePostRepeatability({ post: 'inversion', msaa: false, startVariant: 'false', falsifierKind: 'pipeline-texture' });
runComposedInheritancePostRepeatability({ post: 'inversion', msaa: false, startVariant: 'true', falsifierKind: 'pipeline-texture' });
runComposedInheritancePostRepeatability({ post: 'inversion', msaa: true, startVariant: 'false', falsifierKind: 'pipeline-texture' });
runComposedInheritancePostRepeatability({ post: 'inversion', msaa: true, startVariant: 'true', falsifierKind: 'pipeline-texture' });

const resizeChurnComposed = run(
  'browser custom pipeline + multi-texture resize churn',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-composed'],
  {
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_ARTIFACT_DIR:
      process.env.FORGEAX_M3_ARTIFACT_DIR ??
      resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering', 'resize-churn', 'browser-composed'),
  },
);
if (
  resizeChurnComposed.status !== 0 ||
  !resizeChurnComposed.output.includes('[m3-composed] PASS pipeline=custom') ||
  !resizeChurnComposed.output.includes('secondTextureChanged=') ||
  !resizeChurnComposed.output.includes('resizeHistory=640x360>480x270>720x405>640x360')
) {
  console.error('[m3-programmable] multi-texture resize churn: FAIL - composed resize/falsifier journey did not pass');
  process.exit(1);
}
console.log('[m3-programmable] multi-texture resize churn: PASS');

const msaaMultiTextureArtifactRoot =
  process.env.FORGEAX_M3_ARTIFACT_DIR ??
  resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering', 'msaa-multi-texture-double-resize-repeatability');
const msaaMultiTextureRuns = [];
for (const pass of ['first', 'second']) {
  msaaMultiTextureRuns.push({
    pass,
    normal: run(
      `browser MSAA multi-texture double resize ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-composed'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(msaaMultiTextureArtifactRoot, pass, 'normal'),
      },
    ),
    falsifier: run(
      `browser MSAA multi-texture double resize ${pass} second-texture falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-composed'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(msaaMultiTextureArtifactRoot, pass, 'falsifier'),
      },
    ),
  });
}
const msaaMultiTextureSnapshots = msaaMultiTextureRuns.map((runPair) => ({
  pass: runPair.pass,
  normal: readComposedSnapshot(resolve(msaaMultiTextureArtifactRoot, runPair.pass, 'normal')),
  falsifier: readComposedSnapshot(resolve(msaaMultiTextureArtifactRoot, runPair.pass, 'falsifier')),
}));
const msaaMultiTextureExpectedHistory = '640x360>480x270>720x405>640x360>480x270>720x405>640x360';
for (const runPair of msaaMultiTextureRuns) {
  for (const leg of ['normal', 'falsifier']) {
    if (
      runPair[leg].status !== 0 ||
      !runPair[leg].output.includes('[m3-composed] PASS pipeline=custom msaa=true') ||
      !runPair[leg].output.includes(`resizeHistory=${msaaMultiTextureExpectedHistory}`)
    ) {
      console.error(`[m3-programmable] MSAA multi-texture double resize ${runPair.pass} ${leg}: FAIL`);
      process.exit(1);
    }
  }
}
const normalRepeatabilityDiff = repeatabilityDiff(
  msaaMultiTextureSnapshots[0].normal,
  msaaMultiTextureSnapshots[1].normal,
);
const falsifierRepeatabilityDiff = repeatabilityDiff(
  msaaMultiTextureSnapshots[0].falsifier,
  msaaMultiTextureSnapshots[1].falsifier,
);
if (normalRepeatabilityDiff !== undefined || falsifierRepeatabilityDiff !== undefined) {
  console.error(
    `[m3-programmable] MSAA multi-texture double resize repeatability: FAIL - ${JSON.stringify({ normalRepeatabilityDiff, falsifierRepeatabilityDiff })}`,
  );
  process.exit(1);
}
for (const snapshot of msaaMultiTextureSnapshots) {
  for (const leg of ['normal', 'falsifier']) {
    const value = snapshot[leg];
    const minimumTextureResources = leg === 'normal' ? 2 : 1;
    if (
      value.live.resizeHistory.join('>') !== msaaMultiTextureExpectedHistory ||
      value.falsifier.resizeHistory.join('>') !== msaaMultiTextureExpectedHistory ||
      value.rhi[leg].textureResourceCount < minimumTextureResources ||
      value.rhi[leg].msaaTextureResourceCount !== 4 ||
      value.rhi[leg].resolveTargetCount !== 1 ||
      value.rhi[leg].drawCount < 2 ||
      value.rhi[leg].dawn.nonBlackPixelCount === 0
    ) {
      console.error(`[m3-programmable] MSAA multi-texture topology/replay: FAIL - ${JSON.stringify({ pass: snapshot.pass, leg, value })}`);
      process.exit(1);
    }
  }
  if (snapshot.falsifier.falsifier.secondTextureDelta.changed < 1000) {
    console.error(`[m3-programmable] MSAA multi-texture falsifier: FAIL - ${JSON.stringify(snapshot.falsifier.falsifier.secondTextureDelta)}`);
    process.exit(1);
  }
}
console.log(
  `[m3-programmable] MSAA multi-texture double resize repeatability: PASS normalDawnSha=${msaaMultiTextureSnapshots[0].normal.rhi.normal.dawn.sha256} falsifierDawnSha=${msaaMultiTextureSnapshots[0].falsifier.rhi.falsifier.dawn.sha256} secondTextureChanged=${msaaMultiTextureSnapshots[0].falsifier.falsifier.secondTextureDelta.changed}`,
);

const dualFalsifierArtifactRoot =
  process.env.FORGEAX_M3_ARTIFACT_DIR ??
  resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering', 'msaa-multi-texture-dual-falsifier-double-resize');
const dualFalsifierFamilies = [
  {
    kind: 'pipeline',
    label: 'adjacent-pipeline falsifier',
    expected: { textureResourceCount: 2, msaaTextureResourceCount: 2, resolveTargetCount: 1, drawCount: 1 },
  },
  {
    kind: 'texture',
    label: 'missing-detail-texture falsifier',
    expected: { textureResourceCount: 1, msaaTextureResourceCount: 4, resolveTargetCount: 1, drawCount: 2 },
  },
];
function runMsaaDualFalsifierMatrix({ artifactRoot, startVariant, label }) {
  const runs = [];
  for (const family of dualFalsifierFamilies) {
    for (const pass of ['first', 'second']) {
      runs.push({
        family,
        pass,
        result: run(
          `browser ${label} ${family.label} ${pass}`,
          ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-composed'],
          {
            FORGEAX_M3_MSAA: '1',
            FORGEAX_M3_START_VARIANT: startVariant,
            FORGEAX_M3_RESIZE_CHURN: '1',
            FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
            FORGEAX_M3_FALSIFIER_KIND: family.kind,
            FORGEAX_M3_ARTIFACT_DIR: resolve(artifactRoot, family.kind, pass),
          },
        ),
      });
    }
  }
  const snapshots = new Map(
    dualFalsifierFamilies.map((family) => [
      family.kind,
      ['first', 'second'].map((pass) => ({
        pass,
        snapshot: readComposedSnapshot(
          resolve(artifactRoot, family.kind, pass),
          family.kind === 'pipeline' ? 'falsified-pipeline-inversion' : 'falsified-second-texture-inversion',
        ),
      })),
    ]),
  );
  for (const runResult of runs) {
    if (
      runResult.result.status !== 0 ||
      !runResult.result.output.includes(
        `[m3-composed] PASS pipeline=custom msaa=true startVariant=${startVariant} falsifier=${runResult.family.kind}`,
      ) ||
      !runResult.result.output.includes(`resizeHistory=${msaaMultiTextureExpectedHistory}`)
    ) {
      console.error(`[m3-programmable] ${label} ${runResult.family.label} ${runResult.pass}: FAIL`);
      process.exit(1);
    }
  }
  for (const family of dualFalsifierFamilies) {
    const familySnapshots = snapshots.get(family.kind);
    const first = familySnapshots[0].snapshot;
    const second = familySnapshots[1].snapshot;
    const falsifierRepeatabilityDiff = repeatabilityDiff(first.falsifier, second.falsifier);
    const normalRepeatabilityDiff = repeatabilityDiff(first.live, second.live);
    const rhiRepeatabilityDiff = repeatabilityDiff(first.rhi.falsifier, second.rhi.falsifier);
    const value = first.rhi.falsifier;
    if (
      normalRepeatabilityDiff !== undefined ||
      falsifierRepeatabilityDiff !== undefined ||
      rhiRepeatabilityDiff !== undefined ||
      first.live.resizeHistory.join('>') !== msaaMultiTextureExpectedHistory ||
      first.falsifier.resizeHistory.join('>') !== msaaMultiTextureExpectedHistory ||
      value.textureResourceCount !== family.expected.textureResourceCount ||
      value.msaaTextureResourceCount !== family.expected.msaaTextureResourceCount ||
      value.resolveTargetCount !== family.expected.resolveTargetCount ||
      value.drawCount !== family.expected.drawCount ||
      value.dawn.nonBlackPixelCount === 0 ||
      first.falsifier.secondTextureDelta.changed < 1000
    ) {
      console.error(
        `[m3-programmable] ${label} ${family.label}: FAIL - ${JSON.stringify({ family: family.kind, normalRepeatabilityDiff, falsifierRepeatabilityDiff, value, delta: first.falsifier.secondTextureDelta })}`,
      );
      process.exit(1);
    }
  }
  console.log(
    `[m3-programmable] ${label}: PASS families=${dualFalsifierFamilies.map((family) => family.kind).join('+')} legs=${runs.length} pipelineDraws=${snapshots.get('pipeline')[0].snapshot.rhi.falsifier.drawCount} textureDraws=${snapshots.get('texture')[0].snapshot.rhi.falsifier.drawCount}`,
  );
}

runMsaaDualFalsifierMatrix({
  artifactRoot: dualFalsifierArtifactRoot,
  startVariant: 'true',
  label: 'MSAA multi-texture dual falsifier double resize',
});
runMsaaDualFalsifierMatrix({
  artifactRoot: resolve(dualFalsifierArtifactRoot, 'false-start'),
  startVariant: 'false',
  label: 'MSAA false-start multi-texture dual falsifier double resize',
});

const noMsaaDualFalsifierFamilies = [
  {
    kind: 'pipeline',
    label: 'adjacent-pipeline falsifier',
    expected: { textureResourceCount: 2, msaaTextureResourceCount: 0, resolveTargetCount: 0, drawCount: 1 },
  },
  {
    kind: 'texture',
    label: 'missing-detail-texture falsifier',
    expected: { textureResourceCount: 1, msaaTextureResourceCount: 0, resolveTargetCount: 0, drawCount: 2 },
  },
];
function runNoMsaaDualFalsifierMatrix({ artifactRoot, startVariant, label }) {
  const runs = [];
  for (const family of noMsaaDualFalsifierFamilies) {
    for (const pass of ['first', 'second']) {
      runs.push({
        family,
        pass,
        result: run(
          `browser ${label} ${family.label} ${pass}`,
          ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-composed'],
          {
            FORGEAX_M3_MSAA: '0',
            FORGEAX_M3_START_VARIANT: startVariant,
            FORGEAX_M3_RESIZE_CHURN: '1',
            FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
            FORGEAX_M3_FALSIFIER_KIND: family.kind,
            FORGEAX_M3_ARTIFACT_DIR: resolve(artifactRoot, family.kind, pass),
          },
        ),
      });
    }
  }
  const snapshots = new Map(
    noMsaaDualFalsifierFamilies.map((family) => [
      family.kind,
      ['first', 'second'].map((pass) => ({
        pass,
        snapshot: readComposedSnapshot(
          resolve(artifactRoot, family.kind, pass),
          family.kind === 'pipeline' ? 'falsified-pipeline-inversion' : 'falsified-second-texture-inversion',
        ),
      })),
    ]),
  );
  for (const runResult of runs) {
    if (
      runResult.result.status !== 0 ||
      !runResult.result.output.includes(`[m3-composed] PASS pipeline=custom msaa=false startVariant=${startVariant} falsifier=${runResult.family.kind}`) ||
      !runResult.result.output.includes(`resizeHistory=${msaaMultiTextureExpectedHistory}`)
    ) {
      console.error(`[m3-programmable] ${label} ${runResult.family.label} ${runResult.pass}: FAIL`);
      process.exit(1);
    }
  }
  for (const family of noMsaaDualFalsifierFamilies) {
    const familySnapshots = snapshots.get(family.kind);
    const first = familySnapshots[0].snapshot;
    const second = familySnapshots[1].snapshot;
    const falsifierRepeatabilityDiff = repeatabilityDiff(first.falsifier, second.falsifier);
    const normalRepeatabilityDiff = repeatabilityDiff(first.live, second.live);
    const rhiRepeatabilityDiff = repeatabilityDiff(first.rhi.falsifier, second.rhi.falsifier);
    const value = first.rhi.falsifier;
    if (
      normalRepeatabilityDiff !== undefined ||
      falsifierRepeatabilityDiff !== undefined ||
      rhiRepeatabilityDiff !== undefined ||
      first.live.resizeHistory.join('>') !== msaaMultiTextureExpectedHistory ||
      first.falsifier.resizeHistory.join('>') !== msaaMultiTextureExpectedHistory ||
      value.textureResourceCount !== family.expected.textureResourceCount ||
      value.msaaTextureResourceCount !== family.expected.msaaTextureResourceCount ||
      value.resolveTargetCount !== family.expected.resolveTargetCount ||
      value.drawCount !== family.expected.drawCount ||
      value.dawn.nonBlackPixelCount === 0 ||
      first.falsifier.secondTextureDelta.changed < 1000
    ) {
      console.error(
        `[m3-programmable] ${label} ${family.label}: FAIL - ${JSON.stringify({ family: family.kind, normalRepeatabilityDiff, falsifierRepeatabilityDiff, value, delta: first.falsifier.secondTextureDelta })}`,
      );
      process.exit(1);
    }
  }
  console.log(
    `[m3-programmable] ${label}: PASS families=${noMsaaDualFalsifierFamilies.map((family) => family.kind).join('+')} legs=${runs.length} pipelineDraws=${snapshots.get('pipeline')[0].snapshot.rhi.falsifier.drawCount} textureDraws=${snapshots.get('texture')[0].snapshot.rhi.falsifier.drawCount}`,
  );
}

const noMsaaDualFalsifierArtifactRoot =
  process.env.FORGEAX_M3_ARTIFACT_DIR ??
  resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering', 'no-msaa-multi-texture-dual-falsifier-double-resize');
runNoMsaaDualFalsifierMatrix({
  artifactRoot: noMsaaDualFalsifierArtifactRoot,
  startVariant: 'true',
  label: 'no-MSAA multi-texture dual falsifier double resize',
});
runNoMsaaDualFalsifierMatrix({
  artifactRoot: resolve(noMsaaDualFalsifierArtifactRoot, 'false-start'),
  startVariant: 'false',
  label: 'no-MSAA false-start multi-texture dual falsifier double resize',
});

const depthPostArtifactRoot =
  process.env.FORGEAX_M3_ARTIFACT_DIR ??
  resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering', 'depth-post-repeatability');
for (const [label, msaa] of [
  ['no-MSAA', '0'],
  ['MSAA', '1'],
]) {
  const first = run(`browser depth post ${label} first`, ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-composed'], {
    FORGEAX_M3_DEPTH_POST: '1',
    FORGEAX_M3_MSAA: msaa,
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(depthPostArtifactRoot, label, 'first'),
  });
  const second = run(`browser depth post ${label} second`, ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-composed'], {
    FORGEAX_M3_DEPTH_POST: '1',
    FORGEAX_M3_MSAA: msaa,
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(depthPostArtifactRoot, label, 'second'),
  });
  const firstSnapshot = readDepthSnapshot(resolve(depthPostArtifactRoot, label, 'first'));
  const secondSnapshot = readDepthSnapshot(resolve(depthPostArtifactRoot, label, 'second'));
  if (
    first.status !== 0 || second.status !== 0 ||
    !first.output.includes('[m3-depth-post] PASS') ||
    !second.output.includes('[m3-depth-post] PASS') ||
    repeatabilityDiff(firstSnapshot, secondSnapshot) !== undefined ||
    firstSnapshot.normal.hasDepthBinding !== true ||
    firstSnapshot.falsifier.hasDepthBinding !== false ||
    firstSnapshot.delta.changed < 1000 ||
    firstSnapshot.normal.resizeHistory.join('>') !== '640x360>480x270>720x405>640x360>480x270>720x405>640x360' ||
    firstSnapshot.normal.dawn.nonBlackPixelCount === 0 ||
    firstSnapshot.falsifier.dawn.nonBlackPixelCount === 0
  ) {
    console.error(`[m3-programmable] depth post ${label}: FAIL - ${JSON.stringify({ first: firstSnapshot, second: secondSnapshot })}`);
    process.exit(1);
  }
  console.log(`[m3-programmable] depth post ${label}: PASS changedPixels=${firstSnapshot.delta.changed} depthBinding=true falsifierDepthBinding=false dawnSha=${firstSnapshot.normal.dawn.sha256}/${firstSnapshot.falsifier.dawn.sha256}`);
}

const customRhiArtifactRoot =
  process.env.FORGEAX_M3_ARTIFACT_DIR ??
  resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering', 'custom-pipeline-rhi');
const customRhi = run(
  'custom pipeline RHI',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  { FORGEAX_M3_ARTIFACT_DIR: resolve(customRhiArtifactRoot, 'normal') },
);
const customRhiFalsifier = run(
  'custom pipeline RHI falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_FALSIFY: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(customRhiArtifactRoot, 'falsifier'),
  },
);
if (
  customRhi.status !== 0 ||
  !customRhi.output.includes('pipeline=M3_PIPELINE=custom variant=M3_MULTI_UV_VARIANT=false texture=M3_TEXTURE_BINDING=baseColorTexture+detailTexture') ||
  !customRhi.output.includes('textureResourceCount=2') ||
  !customRhi.output.includes('draws=2') ||
  customRhiFalsifier.status !== 0 ||
  !customRhiFalsifier.output.includes('pipeline=M3_PIPELINE=custom variant=M3_MULTI_UV_VARIANT=false texture=M3_TEXTURE_BINDING=baseColorTexture+detailTexture') ||
  !customRhiFalsifier.output.includes('textureResourceCount=2') ||
  !customRhiFalsifier.output.includes('draws=1')
) {
  console.error('[m3-programmable] custom pipeline RHI: FAIL - normal/falsifier capture-replay leg did not pass');
  process.exit(1);
}
console.log('[m3-programmable] custom pipeline RHI: PASS');

const customRhiTrueArtifactRoot = resolve(customRhiArtifactRoot, 'true-variant');
const customRhiTrue = run(
  'custom pipeline RHI true variant',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_ARTIFACT_DIR: resolve(customRhiTrueArtifactRoot, 'normal'),
  },
);
const customRhiTrueFalsifier = run(
  'custom pipeline RHI true variant falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_FALSIFY: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(customRhiTrueArtifactRoot, 'falsifier'),
  },
);
if (
  customRhiTrue.status !== 0 ||
  !customRhiTrue.output.includes('pipeline=M3_PIPELINE=custom variant=M3_MULTI_UV_VARIANT=true texture=M3_TEXTURE_BINDING=baseColorTexture+detailTexture') ||
  !customRhiTrue.output.includes('textureResourceCount=2') ||
  !customRhiTrue.output.includes('draws=2') ||
  customRhiTrueFalsifier.status !== 0 ||
  !customRhiTrueFalsifier.output.includes('pipeline=M3_PIPELINE=custom variant=M3_MULTI_UV_VARIANT=true texture=M3_TEXTURE_BINDING=baseColorTexture+detailTexture') ||
  !customRhiTrueFalsifier.output.includes('textureResourceCount=2') ||
  !customRhiTrueFalsifier.output.includes('draws=1')
) {
  console.error('[m3-programmable] custom pipeline RHI true variant: FAIL - custom/variant normal-falsifier leg did not pass');
  process.exit(1);
}
console.log('[m3-programmable] custom pipeline RHI true variant: PASS');
console.log('[m3-programmable] custom pipeline RHI texture binding: PASS');

const resizeChurnRhiArtifactRoot = resolve(customRhiArtifactRoot, 'resize-churn');
const resizeChurnRhi = run(
  'custom pipeline RHI resize churn',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(resizeChurnRhiArtifactRoot, 'normal'),
  },
);
const resizeChurnRhiFalsifier = run(
  'custom pipeline RHI resize churn falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_FALSIFY: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(resizeChurnRhiArtifactRoot, 'falsifier'),
  },
);
if (
  resizeChurnRhi.status !== 0 ||
  !resizeChurnRhi.output.includes('textureResourceCount=2') ||
  !resizeChurnRhi.output.includes('draws=2') ||
  !resizeChurnRhi.output.includes('resizeHistory=640x360>480x270>720x405>640x360') ||
  resizeChurnRhiFalsifier.status !== 0 ||
  !resizeChurnRhiFalsifier.output.includes('textureResourceCount=2') ||
  !resizeChurnRhiFalsifier.output.includes('draws=1') ||
  !resizeChurnRhiFalsifier.output.includes('resizeHistory=640x360>480x270>720x405>640x360')
) {
  console.error('[m3-programmable] multi-texture resize churn RHI: FAIL - normal/falsifier resource topology did not pass');
  process.exit(1);
}
console.log('[m3-programmable] multi-texture resize churn RHI: PASS');

const msaaResizeChurnArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-resize-churn');
const msaaResizeChurn = run(
  'custom pipeline MSAA resize churn',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaResizeChurnArtifactRoot, 'normal'),
  },
);
const msaaResizeChurnFalsifier = run(
  'custom pipeline MSAA resize churn falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaResizeChurnArtifactRoot, 'falsifier'),
  },
);
if (
  msaaResizeChurn.status !== 0 ||
  !msaaResizeChurn.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaResizeChurn.output.includes('textureResourceCount=2') ||
  !msaaResizeChurn.output.includes('msaaTextureResourceCount=4') ||
  !msaaResizeChurn.output.includes('resolveTargetCount=1') ||
  !msaaResizeChurn.output.includes('draws=2') ||
  !msaaResizeChurn.output.includes('resizeHistory=640x360>480x270>720x405>640x360') ||
  msaaResizeChurnFalsifier.status !== 0 ||
  !msaaResizeChurnFalsifier.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaResizeChurnFalsifier.output.includes('textureResourceCount=2') ||
  !msaaResizeChurnFalsifier.output.includes('msaaTextureResourceCount=4') ||
  !msaaResizeChurnFalsifier.output.includes('resolveTargetCount=0') ||
  !msaaResizeChurnFalsifier.output.includes('resizeHistory=640x360>480x270>720x405>640x360')
) {
  console.error('[m3-programmable] multi-texture MSAA resize churn: FAIL - normal/falsifier resolve topology did not pass');
  process.exit(1);
}
let msaaResizeDawnDelta;
try {
  msaaResizeDawnDelta = compareDawnReadbacks(
    resolve(msaaResizeChurnArtifactRoot, 'normal', 'dawn-readback.rgba'),
    resolve(msaaResizeChurnArtifactRoot, 'normal', 'dawn-readback.json'),
    resolve(msaaResizeChurnArtifactRoot, 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaResizeChurnArtifactRoot, 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] multi-texture MSAA resize churn pixel delta: FAIL - ${error}`);
  process.exit(1);
}
if (msaaResizeDawnDelta.changedPixels === 0 || msaaResizeDawnDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] multi-texture MSAA resize churn pixel delta: FAIL - changedPixels=${msaaResizeDawnDelta.changedPixels} meanRgbDelta=${msaaResizeDawnDelta.meanRgbDelta.toFixed(4)}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] multi-texture MSAA resize churn: PASS dawnChanged=${msaaResizeDawnDelta.changedPixels} meanRgbDelta=${msaaResizeDawnDelta.meanRgbDelta.toFixed(4)}`,
);

const msaaResizeChurnRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-resize-churn-repeatability');
const msaaResizeChurnRepeatNormalFirst = run(
  'custom pipeline MSAA resize churn repeatability normal first',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaResizeChurnRepeatArtifactRoot, 'normal-1'),
  },
);
const msaaResizeChurnRepeatNormalSecond = run(
  'custom pipeline MSAA resize churn repeatability normal second',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaResizeChurnRepeatArtifactRoot, 'normal-2'),
  },
);
const msaaResizeChurnRepeatFalsifierFirst = run(
  'custom pipeline MSAA resize churn repeatability falsifier first',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaResizeChurnRepeatArtifactRoot, 'falsifier-1'),
  },
);
const msaaResizeChurnRepeatFalsifierSecond = run(
  'custom pipeline MSAA resize churn repeatability falsifier second',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaResizeChurnRepeatArtifactRoot, 'falsifier-2'),
  },
);
const msaaResizeChurnRepeatRuns = [
  msaaResizeChurnRepeatNormalFirst,
  msaaResizeChurnRepeatNormalSecond,
  msaaResizeChurnRepeatFalsifierFirst,
  msaaResizeChurnRepeatFalsifierSecond,
];
if (
  msaaResizeChurnRepeatRuns.some((result) => result.status !== 0) ||
  !msaaResizeChurnRepeatNormalFirst.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaResizeChurnRepeatNormalFirst.output.includes('textureResourceCount=2') ||
  !msaaResizeChurnRepeatNormalFirst.output.includes('msaaTextureResourceCount=4') ||
  !msaaResizeChurnRepeatNormalFirst.output.includes('resolveTargetCount=1') ||
  !msaaResizeChurnRepeatNormalFirst.output.includes('draws=2') ||
  !msaaResizeChurnRepeatNormalFirst.output.includes('resizeHistory=640x360>480x270>720x405>640x360') ||
  !msaaResizeChurnRepeatNormalSecond.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaResizeChurnRepeatNormalSecond.output.includes('textureResourceCount=2') ||
  !msaaResizeChurnRepeatNormalSecond.output.includes('msaaTextureResourceCount=4') ||
  !msaaResizeChurnRepeatNormalSecond.output.includes('resolveTargetCount=1') ||
  !msaaResizeChurnRepeatNormalSecond.output.includes('draws=2') ||
  !msaaResizeChurnRepeatNormalSecond.output.includes('resizeHistory=640x360>480x270>720x405>640x360') ||
  !msaaResizeChurnRepeatFalsifierFirst.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaResizeChurnRepeatFalsifierFirst.output.includes('textureResourceCount=2') ||
  !msaaResizeChurnRepeatFalsifierFirst.output.includes('msaaTextureResourceCount=4') ||
  !msaaResizeChurnRepeatFalsifierFirst.output.includes('resolveTargetCount=0') ||
  !msaaResizeChurnRepeatFalsifierFirst.output.includes('resizeHistory=640x360>480x270>720x405>640x360') ||
  !msaaResizeChurnRepeatFalsifierSecond.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaResizeChurnRepeatFalsifierSecond.output.includes('textureResourceCount=2') ||
  !msaaResizeChurnRepeatFalsifierSecond.output.includes('msaaTextureResourceCount=4') ||
  !msaaResizeChurnRepeatFalsifierSecond.output.includes('resolveTargetCount=0') ||
  !msaaResizeChurnRepeatFalsifierSecond.output.includes('resizeHistory=640x360>480x270>720x405>640x360')
) {
  console.error('[m3-programmable] MSAA resize churn repeatability: FAIL - one or more independent legs did not pass');
  process.exit(1);
}
const msaaResizeChurnRepeatNormalDiff = repeatabilityDiff(
  readRepeatabilitySnapshot(resolve(msaaResizeChurnRepeatArtifactRoot, 'normal-1')),
  readRepeatabilitySnapshot(resolve(msaaResizeChurnRepeatArtifactRoot, 'normal-2')),
);
const msaaResizeChurnRepeatFalsifierDiff = repeatabilityDiff(
  readRepeatabilitySnapshot(resolve(msaaResizeChurnRepeatArtifactRoot, 'falsifier-1')),
  readRepeatabilitySnapshot(resolve(msaaResizeChurnRepeatArtifactRoot, 'falsifier-2')),
);
let msaaResizeChurnRepeatDeltaFirst;
let msaaResizeChurnRepeatDeltaSecond;
try {
  msaaResizeChurnRepeatDeltaFirst = compareDawnReadbacks(
    resolve(msaaResizeChurnRepeatArtifactRoot, 'normal-1', 'dawn-readback.rgba'),
    resolve(msaaResizeChurnRepeatArtifactRoot, 'normal-1', 'dawn-readback.json'),
    resolve(msaaResizeChurnRepeatArtifactRoot, 'falsifier-1', 'dawn-readback.rgba'),
    resolve(msaaResizeChurnRepeatArtifactRoot, 'falsifier-1', 'dawn-readback.json'),
  );
  msaaResizeChurnRepeatDeltaSecond = compareDawnReadbacks(
    resolve(msaaResizeChurnRepeatArtifactRoot, 'normal-2', 'dawn-readback.rgba'),
    resolve(msaaResizeChurnRepeatArtifactRoot, 'normal-2', 'dawn-readback.json'),
    resolve(msaaResizeChurnRepeatArtifactRoot, 'falsifier-2', 'dawn-readback.rgba'),
    resolve(msaaResizeChurnRepeatArtifactRoot, 'falsifier-2', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] MSAA resize churn repeatability pixel delta: FAIL - ${error}`);
  process.exit(1);
}
if (
  msaaResizeChurnRepeatNormalDiff !== undefined ||
  msaaResizeChurnRepeatFalsifierDiff !== undefined ||
  msaaResizeChurnRepeatDeltaFirst.changedPixels === 0 ||
  msaaResizeChurnRepeatDeltaFirst.meanRgbDelta <= 0.01 ||
  JSON.stringify(msaaResizeChurnRepeatDeltaFirst) !== JSON.stringify(msaaResizeChurnRepeatDeltaSecond)
) {
  console.error(
    `[m3-programmable] MSAA resize churn repeatability: FAIL - ${JSON.stringify({ normalDiff: msaaResizeChurnRepeatNormalDiff, falsifierDiff: msaaResizeChurnRepeatFalsifierDiff, firstDelta: msaaResizeChurnRepeatDeltaFirst, secondDelta: msaaResizeChurnRepeatDeltaSecond })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] MSAA resize churn repeatability: PASS normalSha256=${msaaResizeChurnRepeatDeltaFirst.normalSha256} falsifierSha256=${msaaResizeChurnRepeatDeltaFirst.falsifierSha256} changedPixels=${msaaResizeChurnRepeatDeltaFirst.changedPixels} meanRgbDelta=${msaaResizeChurnRepeatDeltaFirst.meanRgbDelta.toFixed(4)}`,
);

const msaaDoubleResizeChurnArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-double-resize-churn');
const msaaDoubleResizeChurn = run(
  'custom pipeline MSAA double resize churn normal',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaDoubleResizeChurnArtifactRoot, 'normal'),
  },
);
const msaaDoubleResizeChurnFalsifier = run(
  'custom pipeline MSAA double resize churn falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaDoubleResizeChurnArtifactRoot, 'falsifier'),
  },
);
const doubleResizeHistory = 'resizeHistory=640x360>480x270>720x405>640x360>480x270>720x405>640x360';
if (
  msaaDoubleResizeChurn.status !== 0 ||
  !msaaDoubleResizeChurn.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaDoubleResizeChurn.output.includes('textureResourceCount=2') ||
  !msaaDoubleResizeChurn.output.includes('msaaTextureResourceCount=4') ||
  !msaaDoubleResizeChurn.output.includes('resolveTargetCount=1') ||
  !msaaDoubleResizeChurn.output.includes('draws=2') ||
  !msaaDoubleResizeChurn.output.includes(doubleResizeHistory) ||
  msaaDoubleResizeChurnFalsifier.status !== 0 ||
  !msaaDoubleResizeChurnFalsifier.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaDoubleResizeChurnFalsifier.output.includes('textureResourceCount=2') ||
  !msaaDoubleResizeChurnFalsifier.output.includes('msaaTextureResourceCount=4') ||
  !msaaDoubleResizeChurnFalsifier.output.includes('resolveTargetCount=0') ||
  !msaaDoubleResizeChurnFalsifier.output.includes('draws=2') ||
  !msaaDoubleResizeChurnFalsifier.output.includes(doubleResizeHistory)
) {
  console.error('[m3-programmable] MSAA double resize churn: FAIL - normal/falsifier lifecycle legs did not pass');
  process.exit(1);
}
let msaaDoubleResizeDawnDelta;
try {
  msaaDoubleResizeDawnDelta = compareDawnReadbacks(
    resolve(msaaDoubleResizeChurnArtifactRoot, 'normal', 'dawn-readback.rgba'),
    resolve(msaaDoubleResizeChurnArtifactRoot, 'normal', 'dawn-readback.json'),
    resolve(msaaDoubleResizeChurnArtifactRoot, 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaDoubleResizeChurnArtifactRoot, 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] MSAA double resize churn pixel delta: FAIL - ${error}`);
  process.exit(1);
}
if (msaaDoubleResizeDawnDelta.changedPixels === 0 || msaaDoubleResizeDawnDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] MSAA double resize churn: FAIL - ${JSON.stringify(msaaDoubleResizeDawnDelta)}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] MSAA double resize churn: PASS changedPixels=${msaaDoubleResizeDawnDelta.changedPixels} meanRgbDelta=${msaaDoubleResizeDawnDelta.meanRgbDelta.toFixed(4)}`,
);

const msaaDoubleResizeChurnRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-double-resize-churn-repeatability');
const msaaDoubleResizeChurnRepeatNormalFirst = run(
  'custom pipeline MSAA double resize churn repeatability normal first',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'normal-1'),
  },
);
const msaaDoubleResizeChurnRepeatNormalSecond = run(
  'custom pipeline MSAA double resize churn repeatability normal second',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'normal-2'),
  },
);
const msaaDoubleResizeChurnRepeatFalsifierFirst = run(
  'custom pipeline MSAA double resize churn repeatability falsifier first',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'falsifier-1'),
  },
);
const msaaDoubleResizeChurnRepeatFalsifierSecond = run(
  'custom pipeline MSAA double resize churn repeatability falsifier second',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'falsifier-2'),
  },
);
const msaaDoubleResizeChurnRepeatRuns = [
  msaaDoubleResizeChurnRepeatNormalFirst,
  msaaDoubleResizeChurnRepeatNormalSecond,
  msaaDoubleResizeChurnRepeatFalsifierFirst,
  msaaDoubleResizeChurnRepeatFalsifierSecond,
];
if (
  msaaDoubleResizeChurnRepeatRuns.some((result) => result.status !== 0) ||
  !msaaDoubleResizeChurnRepeatNormalFirst.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaDoubleResizeChurnRepeatNormalFirst.output.includes('textureResourceCount=2') ||
  !msaaDoubleResizeChurnRepeatNormalFirst.output.includes('msaaTextureResourceCount=4') ||
  !msaaDoubleResizeChurnRepeatNormalFirst.output.includes('resolveTargetCount=1') ||
  !msaaDoubleResizeChurnRepeatNormalFirst.output.includes('draws=2') ||
  !msaaDoubleResizeChurnRepeatNormalFirst.output.includes(doubleResizeHistory) ||
  !msaaDoubleResizeChurnRepeatNormalSecond.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaDoubleResizeChurnRepeatNormalSecond.output.includes('textureResourceCount=2') ||
  !msaaDoubleResizeChurnRepeatNormalSecond.output.includes('msaaTextureResourceCount=4') ||
  !msaaDoubleResizeChurnRepeatNormalSecond.output.includes('resolveTargetCount=1') ||
  !msaaDoubleResizeChurnRepeatNormalSecond.output.includes('draws=2') ||
  !msaaDoubleResizeChurnRepeatNormalSecond.output.includes(doubleResizeHistory) ||
  !msaaDoubleResizeChurnRepeatFalsifierFirst.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaDoubleResizeChurnRepeatFalsifierFirst.output.includes('textureResourceCount=2') ||
  !msaaDoubleResizeChurnRepeatFalsifierFirst.output.includes('msaaTextureResourceCount=4') ||
  !msaaDoubleResizeChurnRepeatFalsifierFirst.output.includes('resolveTargetCount=0') ||
  !msaaDoubleResizeChurnRepeatFalsifierFirst.output.includes('draws=2') ||
  !msaaDoubleResizeChurnRepeatFalsifierFirst.output.includes(doubleResizeHistory) ||
  !msaaDoubleResizeChurnRepeatFalsifierSecond.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaDoubleResizeChurnRepeatFalsifierSecond.output.includes('textureResourceCount=2') ||
  !msaaDoubleResizeChurnRepeatFalsifierSecond.output.includes('msaaTextureResourceCount=4') ||
  !msaaDoubleResizeChurnRepeatFalsifierSecond.output.includes('resolveTargetCount=0') ||
  !msaaDoubleResizeChurnRepeatFalsifierSecond.output.includes('draws=2') ||
  !msaaDoubleResizeChurnRepeatFalsifierSecond.output.includes(doubleResizeHistory)
) {
  console.error('[m3-programmable] MSAA double resize churn repeatability: FAIL - one or more independent legs did not pass');
  process.exit(1);
}
const msaaDoubleResizeChurnRepeatNormalDiff = repeatabilityDiff(
  readRepeatabilitySnapshot(resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'normal-1')),
  readRepeatabilitySnapshot(resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'normal-2')),
);
const msaaDoubleResizeChurnRepeatFalsifierDiff = repeatabilityDiff(
  readRepeatabilitySnapshot(resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'falsifier-1')),
  readRepeatabilitySnapshot(resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'falsifier-2')),
);
let msaaDoubleResizeChurnRepeatDeltaFirst;
let msaaDoubleResizeChurnRepeatDeltaSecond;
try {
  msaaDoubleResizeChurnRepeatDeltaFirst = compareDawnReadbacks(
    resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'normal-1', 'dawn-readback.rgba'),
    resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'normal-1', 'dawn-readback.json'),
    resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'falsifier-1', 'dawn-readback.rgba'),
    resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'falsifier-1', 'dawn-readback.json'),
  );
  msaaDoubleResizeChurnRepeatDeltaSecond = compareDawnReadbacks(
    resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'normal-2', 'dawn-readback.rgba'),
    resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'normal-2', 'dawn-readback.json'),
    resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'falsifier-2', 'dawn-readback.rgba'),
    resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'falsifier-2', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] MSAA double resize churn repeatability pixel delta: FAIL - ${error}`);
  process.exit(1);
}
if (
  msaaDoubleResizeChurnRepeatNormalDiff !== undefined ||
  msaaDoubleResizeChurnRepeatFalsifierDiff !== undefined ||
  msaaDoubleResizeChurnRepeatDeltaFirst.changedPixels === 0 ||
  msaaDoubleResizeChurnRepeatDeltaFirst.meanRgbDelta <= 0.01 ||
  JSON.stringify(msaaDoubleResizeChurnRepeatDeltaFirst) !== JSON.stringify(msaaDoubleResizeChurnRepeatDeltaSecond)
) {
  console.error(
    `[m3-programmable] MSAA double resize churn repeatability: FAIL - ${JSON.stringify({ normalDiff: msaaDoubleResizeChurnRepeatNormalDiff, falsifierDiff: msaaDoubleResizeChurnRepeatFalsifierDiff, firstDelta: msaaDoubleResizeChurnRepeatDeltaFirst, secondDelta: msaaDoubleResizeChurnRepeatDeltaSecond })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] MSAA double resize churn repeatability: PASS normalSha256=${msaaDoubleResizeChurnRepeatDeltaFirst.normalSha256} falsifierSha256=${msaaDoubleResizeChurnRepeatDeltaFirst.falsifierSha256} changedPixels=${msaaDoubleResizeChurnRepeatDeltaFirst.changedPixels} meanRgbDelta=${msaaDoubleResizeChurnRepeatDeltaFirst.meanRgbDelta.toFixed(4)}`,
);

const noMsaaDoubleResizeChurnRepeatArtifactRoot = resolve(
  customRhiArtifactRoot,
  'no-msaa-double-resize-churn-repeatability',
);
const noMsaaDoubleResizeChurnRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, pass);
  noMsaaDoubleResizeChurnRepeatRuns.push({
    normal: run(
      `custom pipeline no-MSAA double resize churn repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA double resize churn repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const noMsaaDoubleResizeHistory = 'resizeHistory=640x360>480x270>720x405>640x360>480x270>720x405>640x360';
const noMsaaDoubleResizeOutputOk = (output, draws) =>
  output.includes('antialias=M3_ANTIALIAS=none') &&
  output.includes('post=M3_POST_EFFECT=inversion') &&
  output.includes('textureResourceCount=2') &&
  output.includes('msaaTextureResourceCount=0') &&
  output.includes('resolveTargetCount=0') &&
  output.includes(`draws=${draws}`) &&
  output.includes(noMsaaDoubleResizeHistory);
if (
  noMsaaDoubleResizeChurnRepeatRuns.some(
    ({ normal, falsifier }) =>
      normal.status !== 0 ||
      falsifier.status !== 0 ||
      !noMsaaDoubleResizeOutputOk(normal.output, 2) ||
      !noMsaaDoubleResizeOutputOk(falsifier.output, 1),
  )
) {
  console.error(
    '[m3-programmable] no-MSAA double resize churn repeatability: FAIL - one or more independent lifecycle legs did not pass',
  );
  process.exit(1);
}
const noMsaaDoubleResizeNormalDiff = repeatabilityDiff(
  readRepeatabilitySnapshot(resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'first', 'normal')),
  readRepeatabilitySnapshot(resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'second', 'normal')),
);
const noMsaaDoubleResizeFalsifierDiff = repeatabilityDiff(
  readRepeatabilitySnapshot(resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'first', 'falsifier')),
  readRepeatabilitySnapshot(resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'second', 'falsifier')),
);
let noMsaaDoubleResizeDawnDeltaFirst;
let noMsaaDoubleResizeDawnDeltaSecond;
let noMsaaDoubleResizePngDeltaFirst;
let noMsaaDoubleResizePngDeltaSecond;
try {
  noMsaaDoubleResizeDawnDeltaFirst = compareDawnReadbacks(
    resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'first', 'normal', 'dawn-readback.rgba'),
    resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'first', 'normal', 'dawn-readback.json'),
    resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'first', 'falsifier', 'dawn-readback.rgba'),
    resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'first', 'falsifier', 'dawn-readback.json'),
  );
  noMsaaDoubleResizeDawnDeltaSecond = compareDawnReadbacks(
    resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'second', 'normal', 'dawn-readback.rgba'),
    resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'second', 'normal', 'dawn-readback.json'),
    resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'second', 'falsifier', 'dawn-readback.rgba'),
    resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'second', 'falsifier', 'dawn-readback.json'),
  );
  noMsaaDoubleResizePngDeltaFirst = comparePngs(
    resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'first', 'normal', 'custom-live.png'),
    resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'first', 'falsifier', 'custom-live.png'),
  );
  noMsaaDoubleResizePngDeltaSecond = comparePngs(
    resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'second', 'normal', 'custom-live.png'),
    resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'second', 'falsifier', 'custom-live.png'),
  );
} catch (error) {
  console.error(`[m3-programmable] no-MSAA double resize churn repeatability delta: FAIL - ${error}`);
  process.exit(1);
}
if (
  noMsaaDoubleResizeNormalDiff !== undefined ||
  noMsaaDoubleResizeFalsifierDiff !== undefined ||
  noMsaaDoubleResizeDawnDeltaFirst.changedPixels === 0 ||
  noMsaaDoubleResizeDawnDeltaFirst.meanRgbDelta <= 0.01 ||
  noMsaaDoubleResizePngDeltaFirst.changedPixels === 0 ||
  noMsaaDoubleResizePngDeltaFirst.meanRgbDelta <= 0.01 ||
  JSON.stringify(noMsaaDoubleResizeDawnDeltaFirst) !== JSON.stringify(noMsaaDoubleResizeDawnDeltaSecond) ||
  JSON.stringify(noMsaaDoubleResizePngDeltaFirst) !== JSON.stringify(noMsaaDoubleResizePngDeltaSecond)
) {
  console.error(
    `[m3-programmable] no-MSAA double resize churn repeatability: FAIL - ${JSON.stringify({ normalDiff: noMsaaDoubleResizeNormalDiff, falsifierDiff: noMsaaDoubleResizeFalsifierDiff, dawnFirst: noMsaaDoubleResizeDawnDeltaFirst, dawnSecond: noMsaaDoubleResizeDawnDeltaSecond, pngFirst: noMsaaDoubleResizePngDeltaFirst, pngSecond: noMsaaDoubleResizePngDeltaSecond })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] no-MSAA double resize churn repeatability: PASS normalSha256=${noMsaaDoubleResizeDawnDeltaFirst.normalSha256} falsifierSha256=${noMsaaDoubleResizeDawnDeltaFirst.falsifierSha256} dawnChangedPixels=${noMsaaDoubleResizeDawnDeltaFirst.changedPixels} pngChangedPixels=${noMsaaDoubleResizePngDeltaFirst.changedPixels}`,
);

const msaaCustomArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-custom-graph');
const msaaCustom = run(
  'custom pipeline MSAA graph',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaCustomArtifactRoot, 'normal'),
  },
);
const msaaCustomFalsifier = run(
  'custom pipeline MSAA graph falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaCustomArtifactRoot, 'falsifier'),
  },
);
if (
  msaaCustom.status !== 0 ||
  !msaaCustom.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaCustom.output.includes('msaaTextureResourceCount=4') ||
  !msaaCustom.output.includes('resolveTargetCount=') ||
  !msaaCustom.output.includes('draws=2') ||
  !msaaCustom.output.includes('variantSwitch=true') ||
  !msaaCustom.output.includes('dawnReadbackSha256=') ||
  msaaCustomFalsifier.status !== 0 ||
  !msaaCustomFalsifier.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaCustomFalsifier.output.includes('resolveTargetCount=0') ||
  !msaaCustomFalsifier.output.includes('dawnReadbackSha256=')
) {
  console.error('[m3-programmable] custom pipeline MSAA graph: FAIL - MSAA resolve/replay falsifier leg did not pass');
  process.exit(1);
}
let msaaPixelDelta;
try {
  msaaPixelDelta = comparePngs(
    resolve(msaaCustomArtifactRoot, 'normal', 'custom-live.png'),
    resolve(msaaCustomArtifactRoot, 'falsifier', 'custom-live.png'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA pixel delta: FAIL - ${error}`);
  process.exit(1);
}
if (msaaPixelDelta.changedPixels === 0 || msaaPixelDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA pixel delta: FAIL - changedPixels=${msaaPixelDelta.changedPixels} meanRgbDelta=${msaaPixelDelta.meanRgbDelta.toFixed(4)}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline MSAA graph: PASS changedPixels=${msaaPixelDelta.changedPixels} changedFraction=${msaaPixelDelta.changedFraction.toFixed(3)} meanRgbDelta=${msaaPixelDelta.meanRgbDelta.toFixed(4)}`,
);
let msaaDawnReadbackDelta;
try {
  msaaDawnReadbackDelta = compareDawnReadbacks(
    resolve(msaaCustomArtifactRoot, 'normal', 'dawn-readback.rgba'),
    resolve(msaaCustomArtifactRoot, 'normal', 'dawn-readback.json'),
    resolve(msaaCustomArtifactRoot, 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaCustomArtifactRoot, 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA Dawn readback delta: FAIL - ${error}`);
  process.exit(1);
}
if (msaaDawnReadbackDelta.changedPixels === 0 || msaaDawnReadbackDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA Dawn readback delta: FAIL - changedPixels=${msaaDawnReadbackDelta.changedPixels} meanRgbDelta=${msaaDawnReadbackDelta.meanRgbDelta.toFixed(4)}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline MSAA Dawn readback: PASS changedPixels=${msaaDawnReadbackDelta.changedPixels} changedFraction=${msaaDawnReadbackDelta.changedFraction.toFixed(3)} meanRgbDelta=${msaaDawnReadbackDelta.meanRgbDelta.toFixed(4)} normalSha256=${msaaDawnReadbackDelta.normalSha256} falsifierSha256=${msaaDawnReadbackDelta.falsifierSha256}`,
);

const msaaRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-repeatability');
const msaaRepeatNormal = run(
  'custom pipeline MSAA repeatability normal',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaRepeatArtifactRoot, 'normal'),
  },
);
const msaaRepeatFalsifier = run(
  'custom pipeline MSAA repeatability falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaRepeatArtifactRoot, 'falsifier'),
  },
);
if (msaaRepeatNormal.status !== 0 || msaaRepeatFalsifier.status !== 0) {
  console.error('[m3-programmable] custom pipeline MSAA repeatability: FAIL - repeated normal/falsifier leg did not pass');
  process.exit(1);
}
const firstNormalReadback = readDawnReadbackMetadata(resolve(msaaCustomArtifactRoot, 'normal', 'dawn-readback.json'));
const repeatNormalReadback = readDawnReadbackMetadata(resolve(msaaRepeatArtifactRoot, 'normal', 'dawn-readback.json'));
const firstFalsifierReadback = readDawnReadbackMetadata(resolve(msaaCustomArtifactRoot, 'falsifier', 'dawn-readback.json'));
const repeatFalsifierReadback = readDawnReadbackMetadata(resolve(msaaRepeatArtifactRoot, 'falsifier', 'dawn-readback.json'));
if (JSON.stringify(firstNormalReadback) !== JSON.stringify(repeatNormalReadback)) {
  console.error(
    `[m3-programmable] custom pipeline MSAA repeatability: FAIL - normal readback drifted first=${JSON.stringify(firstNormalReadback)} repeat=${JSON.stringify(repeatNormalReadback)}`,
  );
  process.exit(1);
}
if (JSON.stringify(firstFalsifierReadback) !== JSON.stringify(repeatFalsifierReadback)) {
  console.error(
    `[m3-programmable] custom pipeline MSAA repeatability: FAIL - falsifier readback drifted first=${JSON.stringify(firstFalsifierReadback)} repeat=${JSON.stringify(repeatFalsifierReadback)}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline MSAA repeatability: PASS normalSha256=${repeatNormalReadback.sha256} falsifierSha256=${repeatFalsifierReadback.sha256} normalNonBlack=${repeatNormalReadback.nonBlackPixelCount} falsifierNonBlack=${repeatFalsifierReadback.nonBlackPixelCount}`,
);

const msaaTrueVariantArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-true-variant');
const msaaTrueVariant = run(
  'custom pipeline MSAA true variant',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaTrueVariantArtifactRoot, 'normal'),
  },
);
const msaaTrueVariantFalsifier = run(
  'custom pipeline MSAA true variant falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaTrueVariantArtifactRoot, 'falsifier'),
  },
);
const msaaTrueVariantCapture = JSON.parse(
  readFileSync(resolve(msaaTrueVariantArtifactRoot, 'normal', 'capture.json'), 'utf8'),
);
const msaaTrueVariantFalsifierCapture = JSON.parse(
  readFileSync(resolve(msaaTrueVariantArtifactRoot, 'falsifier', 'capture.json'), 'utf8'),
);
if (
  msaaTrueVariant.status !== 0 ||
  !msaaTrueVariant.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !msaaTrueVariant.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaTrueVariant.output.includes('resolveTargetCount=1') ||
  !msaaTrueVariant.output.includes('draws=2') ||
  !msaaTrueVariant.output.includes('dawnReadbackSha256=') ||
  msaaTrueVariantFalsifier.status !== 0 ||
  !msaaTrueVariantFalsifier.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaTrueVariantFalsifier.output.includes('resolveTargetCount=0') ||
  !msaaTrueVariantFalsifier.output.includes('dawnReadbackSha256=') ||
  msaaTrueVariantCapture.variant !== 'M3_MULTI_UV_VARIANT=true' ||
  msaaTrueVariantCapture.antialias !== 'M3_ANTIALIAS=msaa' ||
  msaaTrueVariantFalsifierCapture.variant !== 'M3_MULTI_UV_VARIANT=true' ||
  msaaTrueVariantFalsifierCapture.antialias !== 'M3_ANTIALIAS=msaa'
) {
  console.error('[m3-programmable] custom pipeline MSAA true variant: FAIL - initial true-variant MSAA combination did not pass');
  process.exit(1);
}
let msaaTrueVariantPixelDelta;
try {
  msaaTrueVariantPixelDelta = comparePngs(
    resolve(msaaTrueVariantArtifactRoot, 'normal', 'custom-live.png'),
    resolve(msaaTrueVariantArtifactRoot, 'falsifier', 'custom-live.png'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA true variant pixel delta: FAIL - ${error}`);
  process.exit(1);
}
if (msaaTrueVariantPixelDelta.changedPixels === 0 || msaaTrueVariantPixelDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA true variant pixel delta: FAIL - changedPixels=${msaaTrueVariantPixelDelta.changedPixels} meanRgbDelta=${msaaTrueVariantPixelDelta.meanRgbDelta.toFixed(4)}`,
  );
  process.exit(1);
}
let msaaTrueVariantDawnReadbackDelta;
try {
  msaaTrueVariantDawnReadbackDelta = compareDawnReadbacks(
    resolve(msaaTrueVariantArtifactRoot, 'normal', 'dawn-readback.rgba'),
    resolve(msaaTrueVariantArtifactRoot, 'normal', 'dawn-readback.json'),
    resolve(msaaTrueVariantArtifactRoot, 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaTrueVariantArtifactRoot, 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA true variant Dawn readback delta: FAIL - ${error}`);
  process.exit(1);
}
if (msaaTrueVariantDawnReadbackDelta.changedPixels === 0 || msaaTrueVariantDawnReadbackDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA true variant Dawn readback delta: FAIL - changedPixels=${msaaTrueVariantDawnReadbackDelta.changedPixels} meanRgbDelta=${msaaTrueVariantDawnReadbackDelta.meanRgbDelta.toFixed(4)}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline MSAA true variant: PASS changedPixels=${msaaTrueVariantPixelDelta.changedPixels} changedFraction=${msaaTrueVariantPixelDelta.changedFraction.toFixed(3)} meanRgbDelta=${msaaTrueVariantPixelDelta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${msaaTrueVariantDawnReadbackDelta.changedPixels} dawnMeanRgbDelta=${msaaTrueVariantDawnReadbackDelta.meanRgbDelta.toFixed(4)} normalSha256=${msaaTrueVariantDawnReadbackDelta.normalSha256} falsifierSha256=${msaaTrueVariantDawnReadbackDelta.falsifierSha256}`,
);

const msaaTrueVariantSwitchArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-true-variant-switch');
const msaaTrueVariantSwitch = run(
  'custom pipeline MSAA true variant live switch',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaTrueVariantSwitchArtifactRoot, 'normal'),
  },
);
const msaaTrueVariantSwitchFalsifier = run(
  'custom pipeline MSAA true variant live switch falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaTrueVariantSwitchArtifactRoot, 'falsifier'),
  },
);
const msaaTrueVariantSwitchCapture = JSON.parse(
  readFileSync(resolve(msaaTrueVariantSwitchArtifactRoot, 'normal', 'capture.json'), 'utf8'),
);
const msaaTrueVariantSwitchFalsifierCapture = JSON.parse(
  readFileSync(resolve(msaaTrueVariantSwitchArtifactRoot, 'falsifier', 'capture.json'), 'utf8'),
);
if (
  msaaTrueVariantSwitch.status !== 0 ||
  !msaaTrueVariantSwitch.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !msaaTrueVariantSwitch.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaTrueVariantSwitch.output.includes('resolveTargetCount=1') ||
  !msaaTrueVariantSwitch.output.includes('draws=2') ||
  !msaaTrueVariantSwitch.output.includes('variantSwitch=true') ||
  !msaaTrueVariantSwitch.output.includes('dawnReadbackSha256=') ||
  msaaTrueVariantSwitchFalsifier.status !== 0 ||
  !msaaTrueVariantSwitchFalsifier.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaTrueVariantSwitchFalsifier.output.includes('resolveTargetCount=0') ||
  !msaaTrueVariantSwitchFalsifier.output.includes('dawnReadbackSha256=') ||
  msaaTrueVariantSwitchCapture.selectedVariant !== 'true' ||
  msaaTrueVariantSwitchCapture.variant !== 'M3_MULTI_UV_VARIANT=false' ||
  msaaTrueVariantSwitchCapture.antialias !== 'M3_ANTIALIAS=msaa' ||
  msaaTrueVariantSwitchCapture.variantSwitchedAfterPipeline !== true ||
  msaaTrueVariantSwitchFalsifierCapture.selectedVariant !== 'true' ||
  msaaTrueVariantSwitchFalsifierCapture.variant !== 'M3_MULTI_UV_VARIANT=false' ||
  msaaTrueVariantSwitchFalsifierCapture.antialias !== 'M3_ANTIALIAS=msaa' ||
  msaaTrueVariantSwitchFalsifierCapture.variantSwitchedAfterPipeline !== true
) {
  console.error('[m3-programmable] custom pipeline MSAA true variant live switch: FAIL - initial true variant did not switch through the MSAA graph');
  process.exit(1);
}
let msaaTrueVariantSwitchPixelDelta;
try {
  msaaTrueVariantSwitchPixelDelta = comparePngs(
    resolve(msaaTrueVariantSwitchArtifactRoot, 'normal', 'custom-live.png'),
    resolve(msaaTrueVariantSwitchArtifactRoot, 'falsifier', 'custom-live.png'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA true variant live switch pixel delta: FAIL - ${error}`);
  process.exit(1);
}
if (msaaTrueVariantSwitchPixelDelta.changedPixels === 0 || msaaTrueVariantSwitchPixelDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA true variant live switch pixel delta: FAIL - changedPixels=${msaaTrueVariantSwitchPixelDelta.changedPixels} meanRgbDelta=${msaaTrueVariantSwitchPixelDelta.meanRgbDelta.toFixed(4)}`,
  );
  process.exit(1);
}
let msaaTrueVariantSwitchDawnReadbackDelta;
try {
  msaaTrueVariantSwitchDawnReadbackDelta = compareDawnReadbacks(
    resolve(msaaTrueVariantSwitchArtifactRoot, 'normal', 'dawn-readback.rgba'),
    resolve(msaaTrueVariantSwitchArtifactRoot, 'normal', 'dawn-readback.json'),
    resolve(msaaTrueVariantSwitchArtifactRoot, 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaTrueVariantSwitchArtifactRoot, 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA true variant live switch Dawn readback delta: FAIL - ${error}`);
  process.exit(1);
}
if (msaaTrueVariantSwitchDawnReadbackDelta.changedPixels === 0 || msaaTrueVariantSwitchDawnReadbackDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA true variant live switch Dawn readback delta: FAIL - changedPixels=${msaaTrueVariantSwitchDawnReadbackDelta.changedPixels} meanRgbDelta=${msaaTrueVariantSwitchDawnReadbackDelta.meanRgbDelta.toFixed(4)}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline MSAA true variant live switch: PASS changedPixels=${msaaTrueVariantSwitchPixelDelta.changedPixels} changedFraction=${msaaTrueVariantSwitchPixelDelta.changedFraction.toFixed(3)} meanRgbDelta=${msaaTrueVariantSwitchPixelDelta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${msaaTrueVariantSwitchDawnReadbackDelta.changedPixels} dawnMeanRgbDelta=${msaaTrueVariantSwitchDawnReadbackDelta.meanRgbDelta.toFixed(4)} normalSha256=${msaaTrueVariantSwitchDawnReadbackDelta.normalSha256} falsifierSha256=${msaaTrueVariantSwitchDawnReadbackDelta.falsifierSha256}`,
);

const msaaPipelineFalsifierArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-pipeline-falsifier');
const msaaPipelineNormal = run(
  'custom pipeline MSAA adjacent pipeline normal',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaPipelineFalsifierArtifactRoot, 'normal'),
  },
);
const msaaPipelineFalsifier = run(
  'custom pipeline MSAA adjacent pipeline falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_FALSIFY: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaPipelineFalsifierArtifactRoot, 'falsifier'),
  },
);
const msaaPipelineNormalCapture = JSON.parse(
  readFileSync(resolve(msaaPipelineFalsifierArtifactRoot, 'normal', 'capture.json'), 'utf8'),
);
const msaaPipelineFalsifierCapture = JSON.parse(
  readFileSync(resolve(msaaPipelineFalsifierArtifactRoot, 'falsifier', 'capture.json'), 'utf8'),
);
const msaaPipelineNormalSummary = JSON.parse(
  readFileSync(resolve(msaaPipelineFalsifierArtifactRoot, 'normal', 'rhi-summary.json'), 'utf8'),
);
const msaaPipelineFalsifierSummary = JSON.parse(
  readFileSync(resolve(msaaPipelineFalsifierArtifactRoot, 'falsifier', 'rhi-summary.json'), 'utf8'),
);
if (
  msaaPipelineNormal.status !== 0 ||
  !msaaPipelineNormal.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaPipelineNormal.output.includes('msaaTextureResourceCount=4') ||
  !msaaPipelineNormal.output.includes('resolveTargetCount=1') ||
  !msaaPipelineNormal.output.includes('draws=2') ||
  !msaaPipelineNormal.output.includes('variantSwitch=true') ||
  !msaaPipelineNormal.output.includes('dawnReadbackSha256=') ||
  msaaPipelineFalsifier.status !== 0 ||
  !msaaPipelineFalsifier.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaPipelineFalsifier.output.includes('msaaTextureResourceCount=2') ||
  !msaaPipelineFalsifier.output.includes('resolveTargetCount=1') ||
  !msaaPipelineFalsifier.output.includes('draws=1') ||
  !msaaPipelineFalsifier.output.includes('variantSwitch=true') ||
  !msaaPipelineFalsifier.output.includes('dawnReadbackSha256=') ||
  msaaPipelineNormalCapture.selectedVariant !== 'true' ||
  msaaPipelineNormalCapture.variant !== 'M3_MULTI_UV_VARIANT=false' ||
  msaaPipelineNormalCapture.antialias !== 'M3_ANTIALIAS=msaa' ||
  msaaPipelineNormalCapture.falsifyPipeline !== false ||
  msaaPipelineNormalCapture.variantSwitchedAfterPipeline !== true ||
  msaaPipelineFalsifierCapture.selectedVariant !== 'true' ||
  msaaPipelineFalsifierCapture.variant !== 'M3_MULTI_UV_VARIANT=false' ||
  msaaPipelineFalsifierCapture.antialias !== 'M3_ANTIALIAS=msaa' ||
  msaaPipelineFalsifierCapture.falsifyPipeline !== true ||
  msaaPipelineFalsifierCapture.variantSwitchedAfterPipeline !== true ||
  msaaPipelineNormalSummary.resolveTargetCount !== 1 ||
  msaaPipelineNormalSummary.drawCount !== 2 ||
  msaaPipelineFalsifierSummary.resolveTargetCount !== 1 ||
  msaaPipelineFalsifierSummary.drawCount !== 1
) {
  console.error('[m3-programmable] custom pipeline MSAA adjacent pipeline falsifier: FAIL - pipeline-selection fault did not preserve MSAA resolve while changing topology');
  process.exit(1);
}
let msaaPipelinePixelDelta;
try {
  msaaPipelinePixelDelta = comparePngs(
    resolve(msaaPipelineFalsifierArtifactRoot, 'normal', 'custom-live.png'),
    resolve(msaaPipelineFalsifierArtifactRoot, 'falsifier', 'custom-live.png'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA adjacent pipeline PNG delta: FAIL - ${error}`);
  process.exit(1);
}
if (msaaPipelinePixelDelta.changedPixels === 0 || msaaPipelinePixelDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA adjacent pipeline PNG delta: FAIL - changedPixels=${msaaPipelinePixelDelta.changedPixels} meanRgbDelta=${msaaPipelinePixelDelta.meanRgbDelta.toFixed(4)}`,
  );
  process.exit(1);
}
let msaaPipelineDawnReadbackDelta;
try {
  msaaPipelineDawnReadbackDelta = compareDawnReadbacks(
    resolve(msaaPipelineFalsifierArtifactRoot, 'normal', 'dawn-readback.rgba'),
    resolve(msaaPipelineFalsifierArtifactRoot, 'normal', 'dawn-readback.json'),
    resolve(msaaPipelineFalsifierArtifactRoot, 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaPipelineFalsifierArtifactRoot, 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA adjacent pipeline Dawn delta: FAIL - ${error}`);
  process.exit(1);
}
if (msaaPipelineDawnReadbackDelta.width !== 640 || msaaPipelineDawnReadbackDelta.height !== 360) {
  console.error(
    `[m3-programmable] custom pipeline MSAA adjacent pipeline Dawn readback: FAIL - dimensions=${msaaPipelineDawnReadbackDelta.width}x${msaaPipelineDawnReadbackDelta.height}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline MSAA adjacent pipeline: PASS normalResolve=1 falsifierResolve=1 normalDraws=2 falsifierDraws=1 changedPixels=${msaaPipelinePixelDelta.changedPixels} changedFraction=${msaaPipelinePixelDelta.changedFraction.toFixed(3)} meanRgbDelta=${msaaPipelinePixelDelta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${msaaPipelineDawnReadbackDelta.changedPixels} dawnMeanRgbDelta=${msaaPipelineDawnReadbackDelta.meanRgbDelta.toFixed(4)} normalSha256=${msaaPipelineDawnReadbackDelta.normalSha256} falsifierSha256=${msaaPipelineDawnReadbackDelta.falsifierSha256}`,
);

const msaaTrueVariantPipelineRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-true-variant-pipeline-repeatability');
const msaaTrueVariantPipelineRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaTrueVariantPipelineRepeatArtifactRoot, pass);
  msaaTrueVariantPipelineRepeatRuns.push({
    normal: run(
      `custom pipeline MSAA true variant pipeline repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA true variant pipeline repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaTrueVariantPipelineRepeatSnapshots = msaaTrueVariantPipelineRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaTrueVariantPipelineRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaTrueVariantPipelineRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [msaaTrueVariantPipelineRepeatFirst, msaaTrueVariantPipelineRepeatSecond] = msaaTrueVariantPipelineRepeatSnapshots;
const msaaTrueVariantPipelineRepeatNormalDiff = repeatabilityDiff(
  msaaTrueVariantPipelineRepeatFirst.normal.snapshot,
  msaaTrueVariantPipelineRepeatSecond.normal.snapshot,
);
const msaaTrueVariantPipelineRepeatFalsifierDiff = repeatabilityDiff(
  msaaTrueVariantPipelineRepeatFirst.falsifier.snapshot,
  msaaTrueVariantPipelineRepeatSecond.falsifier.snapshot,
);
if (
  msaaTrueVariantPipelineRepeatFirst.normal.result.status !== 0 ||
  !msaaTrueVariantPipelineRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !msaaTrueVariantPipelineRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaTrueVariantPipelineRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=4') ||
  !msaaTrueVariantPipelineRepeatFirst.normal.result.output.includes('resolveTargetCount=1') ||
  !msaaTrueVariantPipelineRepeatFirst.normal.result.output.includes('draws=2') ||
  !msaaTrueVariantPipelineRepeatFirst.normal.result.output.includes('variantSwitch=true') ||
  msaaTrueVariantPipelineRepeatFirst.falsifier.result.status !== 0 ||
  !msaaTrueVariantPipelineRepeatFirst.falsifier.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !msaaTrueVariantPipelineRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=2') ||
  !msaaTrueVariantPipelineRepeatFirst.falsifier.result.output.includes('resolveTargetCount=1') ||
  !msaaTrueVariantPipelineRepeatFirst.falsifier.result.output.includes('draws=1') ||
  !msaaTrueVariantPipelineRepeatFirst.falsifier.result.output.includes('variantSwitch=true') ||
  msaaTrueVariantPipelineRepeatSecond.normal.result.status !== 0 ||
  msaaTrueVariantPipelineRepeatSecond.falsifier.result.status !== 0 ||
  msaaTrueVariantPipelineRepeatNormalDiff !== undefined ||
  msaaTrueVariantPipelineRepeatFalsifierDiff !== undefined ||
  msaaTrueVariantPipelineRepeatFirst.normal.snapshot.capture.selectedVariant !== 'true' ||
  msaaTrueVariantPipelineRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'true' ||
  msaaTrueVariantPipelineRepeatFirst.normal.snapshot.capture.variant !== 'M3_MULTI_UV_VARIANT=false' ||
  msaaTrueVariantPipelineRepeatFirst.falsifier.snapshot.capture.variant !== 'M3_MULTI_UV_VARIANT=false' ||
  msaaTrueVariantPipelineRepeatFirst.normal.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  msaaTrueVariantPipelineRepeatFirst.falsifier.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  msaaTrueVariantPipelineRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  msaaTrueVariantPipelineRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== true ||
  msaaTrueVariantPipelineRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaTrueVariantPipelineRepeatFirst.normal.snapshot.rhi.drawCount !== 2 ||
  msaaTrueVariantPipelineRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaTrueVariantPipelineRepeatFirst.falsifier.snapshot.rhi.drawCount !== 1
) {
  console.error(
    `[m3-programmable] custom pipeline MSAA true variant pipeline repeatability: FAIL - ${JSON.stringify({ normalStatus: [msaaTrueVariantPipelineRepeatFirst.normal.result.status, msaaTrueVariantPipelineRepeatSecond.normal.result.status], falsifierStatus: [msaaTrueVariantPipelineRepeatFirst.falsifier.result.status, msaaTrueVariantPipelineRepeatSecond.falsifier.result.status], normalDiff: msaaTrueVariantPipelineRepeatNormalDiff, falsifierDiff: msaaTrueVariantPipelineRepeatFalsifierDiff })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline MSAA true variant pipeline repeatability: PASS normalSha256=${msaaTrueVariantPipelineRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${msaaTrueVariantPipelineRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${msaaTrueVariantPipelineRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${msaaTrueVariantPipelineRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const msaaTrueInversionPipelineRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-true-inversion-pipeline-repeatability');
const msaaTrueInversionPipelineRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaTrueInversionPipelineRepeatArtifactRoot, pass);
  msaaTrueInversionPipelineRepeatRuns.push({
    normal: run(
      `custom pipeline MSAA true inversion pipeline repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA true inversion pipeline repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaTrueInversionPipelineRepeatSnapshots = msaaTrueInversionPipelineRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaTrueInversionPipelineRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaTrueInversionPipelineRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [msaaTrueInversionPipelineRepeatFirst, msaaTrueInversionPipelineRepeatSecond] = msaaTrueInversionPipelineRepeatSnapshots;
const msaaTrueInversionPipelineRepeatNormalDiff = repeatabilityDiff(
  msaaTrueInversionPipelineRepeatFirst.normal.snapshot,
  msaaTrueInversionPipelineRepeatSecond.normal.snapshot,
);
const msaaTrueInversionPipelineRepeatFalsifierDiff = repeatabilityDiff(
  msaaTrueInversionPipelineRepeatFirst.falsifier.snapshot,
  msaaTrueInversionPipelineRepeatSecond.falsifier.snapshot,
);
if (
  msaaTrueInversionPipelineRepeatFirst.normal.result.status !== 0 ||
  !msaaTrueInversionPipelineRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !msaaTrueInversionPipelineRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaTrueInversionPipelineRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=4') ||
  !msaaTrueInversionPipelineRepeatFirst.normal.result.output.includes('resolveTargetCount=1') ||
  !msaaTrueInversionPipelineRepeatFirst.normal.result.output.includes('draws=2') ||
  !msaaTrueInversionPipelineRepeatFirst.normal.result.output.includes('variantSwitch=true') ||
  msaaTrueInversionPipelineRepeatFirst.falsifier.result.status !== 0 ||
  !msaaTrueInversionPipelineRepeatFirst.falsifier.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !msaaTrueInversionPipelineRepeatFirst.falsifier.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaTrueInversionPipelineRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=2') ||
  !msaaTrueInversionPipelineRepeatFirst.falsifier.result.output.includes('resolveTargetCount=1') ||
  !msaaTrueInversionPipelineRepeatFirst.falsifier.result.output.includes('draws=1') ||
  !msaaTrueInversionPipelineRepeatFirst.falsifier.result.output.includes('variantSwitch=true') ||
  msaaTrueInversionPipelineRepeatSecond.normal.result.status !== 0 ||
  msaaTrueInversionPipelineRepeatSecond.falsifier.result.status !== 0 ||
  msaaTrueInversionPipelineRepeatNormalDiff !== undefined ||
  msaaTrueInversionPipelineRepeatFalsifierDiff !== undefined ||
  msaaTrueInversionPipelineRepeatFirst.normal.snapshot.capture.selectedVariant !== 'true' ||
  msaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'true' ||
  msaaTrueInversionPipelineRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaTrueInversionPipelineRepeatFirst.normal.snapshot.capture.variant !== 'M3_MULTI_UV_VARIANT=false' ||
  msaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.capture.variant !== 'M3_MULTI_UV_VARIANT=false' ||
  msaaTrueInversionPipelineRepeatFirst.normal.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  msaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  msaaTrueInversionPipelineRepeatFirst.normal.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaTrueInversionPipelineRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  msaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== true ||
  msaaTrueInversionPipelineRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaTrueInversionPipelineRepeatFirst.normal.snapshot.rhi.drawCount !== 2 ||
  msaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.rhi.drawCount !== 1
) {
  console.error(
    `[m3-programmable] custom pipeline MSAA true inversion pipeline repeatability: FAIL - ${JSON.stringify({ normalStatus: [msaaTrueInversionPipelineRepeatFirst.normal.result.status, msaaTrueInversionPipelineRepeatSecond.normal.result.status], falsifierStatus: [msaaTrueInversionPipelineRepeatFirst.falsifier.result.status, msaaTrueInversionPipelineRepeatSecond.falsifier.result.status], normalDiff: msaaTrueInversionPipelineRepeatNormalDiff, falsifierDiff: msaaTrueInversionPipelineRepeatFalsifierDiff })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline MSAA true inversion pipeline repeatability: PASS normalSha256=${msaaTrueInversionPipelineRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${msaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${msaaTrueInversionPipelineRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${msaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const msaaFalsePassthroughPipelineRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-false-passthrough-pipeline-repeatability');
const msaaFalsePassthroughPipelineRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaFalsePassthroughPipelineRepeatArtifactRoot, pass);
  msaaFalsePassthroughPipelineRepeatRuns.push({
    normal: run(
      `custom pipeline MSAA false passthrough pipeline repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA false passthrough pipeline repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaFalsePassthroughPipelineRepeatSnapshots = msaaFalsePassthroughPipelineRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaFalsePassthroughPipelineRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaFalsePassthroughPipelineRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [msaaFalsePassthroughPipelineRepeatFirst, msaaFalsePassthroughPipelineRepeatSecond] = msaaFalsePassthroughPipelineRepeatSnapshots;
const msaaFalsePassthroughPipelineRepeatNormalDiff = repeatabilityDiff(
  msaaFalsePassthroughPipelineRepeatFirst.normal.snapshot,
  msaaFalsePassthroughPipelineRepeatSecond.normal.snapshot,
);
const msaaFalsePassthroughPipelineRepeatFalsifierDiff = repeatabilityDiff(
  msaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot,
  msaaFalsePassthroughPipelineRepeatSecond.falsifier.snapshot,
);
if (
  msaaFalsePassthroughPipelineRepeatFirst.normal.result.status !== 0 ||
  !msaaFalsePassthroughPipelineRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !msaaFalsePassthroughPipelineRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=passthrough') ||
  !msaaFalsePassthroughPipelineRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=4') ||
  !msaaFalsePassthroughPipelineRepeatFirst.normal.result.output.includes('resolveTargetCount=1') ||
  !msaaFalsePassthroughPipelineRepeatFirst.normal.result.output.includes('draws=2') ||
  !msaaFalsePassthroughPipelineRepeatFirst.normal.result.output.includes('variantSwitch=false') ||
  !msaaFalsePassthroughPipelineRepeatFirst.normal.result.output.includes('postSwitch=false') ||
  msaaFalsePassthroughPipelineRepeatFirst.falsifier.result.status !== 0 ||
  !msaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('[m3-browser-rhi] PASS -') ||
  !msaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !msaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('post=M3_POST_EFFECT=passthrough') ||
  !msaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=2') ||
  !msaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('resolveTargetCount=1') ||
  !msaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('draws=1') ||
  !msaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('variantSwitch=false') ||
  !msaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('postSwitch=false') ||
  msaaFalsePassthroughPipelineRepeatSecond.normal.result.status !== 0 ||
  msaaFalsePassthroughPipelineRepeatSecond.falsifier.result.status !== 0 ||
  msaaFalsePassthroughPipelineRepeatNormalDiff !== undefined ||
  msaaFalsePassthroughPipelineRepeatFalsifierDiff !== undefined ||
  msaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.capture.selectedVariant !== 'false' ||
  msaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'false' ||
  msaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.capture.variantSwitchedAfterPipeline !== false ||
  msaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.capture.variantSwitchedAfterPipeline !== false ||
  msaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  msaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== true ||
  msaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.rhi.drawCount !== 2 ||
  msaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.rhi.drawCount !== 1
) {
  console.error(
    `[m3-programmable] custom pipeline MSAA false passthrough pipeline repeatability: FAIL - ${JSON.stringify({ normalStatus: [msaaFalsePassthroughPipelineRepeatFirst.normal.result.status, msaaFalsePassthroughPipelineRepeatSecond.normal.result.status], falsifierStatus: [msaaFalsePassthroughPipelineRepeatFirst.falsifier.result.status, msaaFalsePassthroughPipelineRepeatSecond.falsifier.result.status], normalDiff: msaaFalsePassthroughPipelineRepeatNormalDiff, falsifierDiff: msaaFalsePassthroughPipelineRepeatFalsifierDiff })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline MSAA false passthrough pipeline repeatability: PASS normalSha256=${msaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${msaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${msaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${msaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const msaaFalseInversionPipelineRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-false-inversion-pipeline-repeatability');
const msaaFalseInversionPipelineRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaFalseInversionPipelineRepeatArtifactRoot, pass);
  msaaFalseInversionPipelineRepeatRuns.push({
    normal: run(
      `custom pipeline MSAA false inversion pipeline repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA false inversion pipeline repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaFalseInversionPipelineRepeatSnapshots = msaaFalseInversionPipelineRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaFalseInversionPipelineRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaFalseInversionPipelineRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [msaaFalseInversionPipelineRepeatFirst, msaaFalseInversionPipelineRepeatSecond] = msaaFalseInversionPipelineRepeatSnapshots;
const msaaFalseInversionPipelineRepeatNormalDiff = repeatabilityDiff(
  msaaFalseInversionPipelineRepeatFirst.normal.snapshot,
  msaaFalseInversionPipelineRepeatSecond.normal.snapshot,
);
const msaaFalseInversionPipelineRepeatFalsifierDiff = repeatabilityDiff(
  msaaFalseInversionPipelineRepeatFirst.falsifier.snapshot,
  msaaFalseInversionPipelineRepeatSecond.falsifier.snapshot,
);
if (
  msaaFalseInversionPipelineRepeatFirst.normal.result.status !== 0 ||
  !msaaFalseInversionPipelineRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !msaaFalseInversionPipelineRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaFalseInversionPipelineRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=4') ||
  !msaaFalseInversionPipelineRepeatFirst.normal.result.output.includes('resolveTargetCount=1') ||
  !msaaFalseInversionPipelineRepeatFirst.normal.result.output.includes('draws=2') ||
  !msaaFalseInversionPipelineRepeatFirst.normal.result.output.includes('variantSwitch=false') ||
  !msaaFalseInversionPipelineRepeatFirst.normal.result.output.includes('postSwitch=false') ||
  msaaFalseInversionPipelineRepeatFirst.falsifier.result.status !== 0 ||
  !msaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('[m3-browser-rhi] PASS -') ||
  !msaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !msaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=2') ||
  !msaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('resolveTargetCount=1') ||
  !msaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('draws=1') ||
  !msaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('variantSwitch=false') ||
  !msaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('postSwitch=false') ||
  msaaFalseInversionPipelineRepeatSecond.normal.result.status !== 0 ||
  msaaFalseInversionPipelineRepeatSecond.falsifier.result.status !== 0 ||
  msaaFalseInversionPipelineRepeatNormalDiff !== undefined ||
  msaaFalseInversionPipelineRepeatFalsifierDiff !== undefined ||
  msaaFalseInversionPipelineRepeatFirst.normal.snapshot.capture.selectedVariant !== 'false' ||
  msaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'false' ||
  msaaFalseInversionPipelineRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaFalseInversionPipelineRepeatFirst.normal.snapshot.capture.variantSwitchedAfterPipeline !== false ||
  msaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.capture.variantSwitchedAfterPipeline !== false ||
  msaaFalseInversionPipelineRepeatFirst.normal.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaFalseInversionPipelineRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  msaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== true ||
  msaaFalseInversionPipelineRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaFalseInversionPipelineRepeatFirst.normal.snapshot.rhi.drawCount !== 2 ||
  msaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.rhi.drawCount !== 1
) {
  console.error(
    `[m3-programmable] custom pipeline MSAA false inversion pipeline repeatability: FAIL - ${JSON.stringify({ normalStatus: [msaaFalseInversionPipelineRepeatFirst.normal.result.status, msaaFalseInversionPipelineRepeatSecond.normal.result.status], falsifierStatus: [msaaFalseInversionPipelineRepeatFirst.falsifier.result.status, msaaFalseInversionPipelineRepeatSecond.falsifier.result.status], normalDiff: msaaFalseInversionPipelineRepeatNormalDiff, falsifierDiff: msaaFalseInversionPipelineRepeatFalsifierDiff })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline MSAA false inversion pipeline repeatability: PASS normalSha256=${msaaFalseInversionPipelineRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${msaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${msaaFalseInversionPipelineRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${msaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const noMsaaFalseInversionPipelineRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'no-msaa-false-inversion-pipeline-repeatability');
const noMsaaFalseInversionPipelineRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(noMsaaFalseInversionPipelineRepeatArtifactRoot, pass);
  noMsaaFalseInversionPipelineRepeatRuns.push({
    normal: run(
      `custom pipeline no-MSAA false inversion pipeline repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA false inversion pipeline repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const noMsaaFalseInversionPipelineRepeatSnapshots = noMsaaFalseInversionPipelineRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaFalseInversionPipelineRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaFalseInversionPipelineRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [noMsaaFalseInversionPipelineRepeatFirst, noMsaaFalseInversionPipelineRepeatSecond] = noMsaaFalseInversionPipelineRepeatSnapshots;
const noMsaaFalseInversionPipelineRepeatNormalDiff = repeatabilityDiff(
  noMsaaFalseInversionPipelineRepeatFirst.normal.snapshot,
  noMsaaFalseInversionPipelineRepeatSecond.normal.snapshot,
);
const noMsaaFalseInversionPipelineRepeatFalsifierDiff = repeatabilityDiff(
  noMsaaFalseInversionPipelineRepeatFirst.falsifier.snapshot,
  noMsaaFalseInversionPipelineRepeatSecond.falsifier.snapshot,
);
if (
  noMsaaFalseInversionPipelineRepeatFirst.normal.result.status !== 0 ||
  !noMsaaFalseInversionPipelineRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !noMsaaFalseInversionPipelineRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !noMsaaFalseInversionPipelineRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaFalseInversionPipelineRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaFalseInversionPipelineRepeatFirst.normal.result.output.includes('resolveTargetCount=0') ||
  !noMsaaFalseInversionPipelineRepeatFirst.normal.result.output.includes('draws=2') ||
  !noMsaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !noMsaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !noMsaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('resolveTargetCount=0') ||
  !noMsaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('draws=1') ||
  noMsaaFalseInversionPipelineRepeatSecond.normal.result.status !== 0 ||
  noMsaaFalseInversionPipelineRepeatSecond.falsifier.result.status !== 0 ||
  noMsaaFalseInversionPipelineRepeatNormalDiff !== undefined ||
  noMsaaFalseInversionPipelineRepeatFalsifierDiff !== undefined ||
  noMsaaFalseInversionPipelineRepeatFirst.normal.snapshot.capture.selectedVariant !== 'false' ||
  noMsaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'false' ||
  noMsaaFalseInversionPipelineRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  noMsaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  noMsaaFalseInversionPipelineRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  noMsaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== true ||
  noMsaaFalseInversionPipelineRepeatFirst.normal.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaFalseInversionPipelineRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaFalseInversionPipelineRepeatFirst.normal.snapshot.rhi.drawCount !== 2 ||
  noMsaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.rhi.drawCount !== 1
) {
  console.error(
    `[m3-programmable] custom pipeline no-MSAA false inversion pipeline repeatability: FAIL - ${JSON.stringify({ normalStatus: [noMsaaFalseInversionPipelineRepeatFirst.normal.result.status, noMsaaFalseInversionPipelineRepeatSecond.normal.result.status], falsifierStatus: [noMsaaFalseInversionPipelineRepeatFirst.falsifier.result.status, noMsaaFalseInversionPipelineRepeatSecond.falsifier.result.status], normalDiff: noMsaaFalseInversionPipelineRepeatNormalDiff, falsifierDiff: noMsaaFalseInversionPipelineRepeatFalsifierDiff })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline no-MSAA false inversion pipeline repeatability: PASS normalSha256=${noMsaaFalseInversionPipelineRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${noMsaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${noMsaaFalseInversionPipelineRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${noMsaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const noMsaaTrueInversionPipelineRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'no-msaa-true-inversion-pipeline-repeatability');
const noMsaaTrueInversionPipelineRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(noMsaaTrueInversionPipelineRepeatArtifactRoot, pass);
  noMsaaTrueInversionPipelineRepeatRuns.push({
    normal: run(
      `custom pipeline no-MSAA true inversion pipeline repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA true inversion pipeline repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const noMsaaTrueInversionPipelineRepeatSnapshots = noMsaaTrueInversionPipelineRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaTrueInversionPipelineRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaTrueInversionPipelineRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [noMsaaTrueInversionPipelineRepeatFirst, noMsaaTrueInversionPipelineRepeatSecond] = noMsaaTrueInversionPipelineRepeatSnapshots;
const noMsaaTrueInversionPipelineRepeatNormalDiff = repeatabilityDiff(
  noMsaaTrueInversionPipelineRepeatFirst.normal.snapshot,
  noMsaaTrueInversionPipelineRepeatSecond.normal.snapshot,
);
const noMsaaTrueInversionPipelineRepeatFalsifierDiff = repeatabilityDiff(
  noMsaaTrueInversionPipelineRepeatFirst.falsifier.snapshot,
  noMsaaTrueInversionPipelineRepeatSecond.falsifier.snapshot,
);
if (
  noMsaaTrueInversionPipelineRepeatFirst.normal.result.status !== 0 ||
  !noMsaaTrueInversionPipelineRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !noMsaaTrueInversionPipelineRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !noMsaaTrueInversionPipelineRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaTrueInversionPipelineRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaTrueInversionPipelineRepeatFirst.normal.result.output.includes('resolveTargetCount=0') ||
  !noMsaaTrueInversionPipelineRepeatFirst.normal.result.output.includes('draws=2') ||
  !noMsaaTrueInversionPipelineRepeatFirst.falsifier.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !noMsaaTrueInversionPipelineRepeatFirst.falsifier.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !noMsaaTrueInversionPipelineRepeatFirst.falsifier.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaTrueInversionPipelineRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaTrueInversionPipelineRepeatFirst.falsifier.result.output.includes('resolveTargetCount=0') ||
  !noMsaaTrueInversionPipelineRepeatFirst.falsifier.result.output.includes('draws=1') ||
  noMsaaTrueInversionPipelineRepeatSecond.normal.result.status !== 0 ||
  noMsaaTrueInversionPipelineRepeatSecond.falsifier.result.status !== 0 ||
  noMsaaTrueInversionPipelineRepeatNormalDiff !== undefined ||
  noMsaaTrueInversionPipelineRepeatFalsifierDiff !== undefined ||
  noMsaaTrueInversionPipelineRepeatFirst.normal.snapshot.capture.selectedVariant !== 'true' ||
  noMsaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'true' ||
  noMsaaTrueInversionPipelineRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  noMsaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  noMsaaTrueInversionPipelineRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  noMsaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== true ||
  noMsaaTrueInversionPipelineRepeatFirst.normal.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaTrueInversionPipelineRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaTrueInversionPipelineRepeatFirst.normal.snapshot.rhi.drawCount !== 2 ||
  noMsaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.rhi.drawCount !== 1
) {
  console.error(
    `[m3-programmable] custom pipeline no-MSAA true inversion pipeline repeatability: FAIL - ${JSON.stringify({ normalStatus: [noMsaaTrueInversionPipelineRepeatFirst.normal.result.status, noMsaaTrueInversionPipelineRepeatSecond.normal.result.status], falsifierStatus: [noMsaaTrueInversionPipelineRepeatFirst.falsifier.result.status, noMsaaTrueInversionPipelineRepeatSecond.falsifier.result.status], normalDiff: noMsaaTrueInversionPipelineRepeatNormalDiff, falsifierDiff: noMsaaTrueInversionPipelineRepeatFalsifierDiff })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline no-MSAA true inversion pipeline repeatability: PASS normalSha256=${noMsaaTrueInversionPipelineRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${noMsaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${noMsaaTrueInversionPipelineRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${noMsaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const noMsaaTruePassthroughPipelineRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'no-msaa-true-passthrough-pipeline-repeatability');
const noMsaaTruePassthroughPipelineRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(noMsaaTruePassthroughPipelineRepeatArtifactRoot, pass);
  noMsaaTruePassthroughPipelineRepeatRuns.push({
    normal: run(
      `custom pipeline no-MSAA true passthrough pipeline repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA true passthrough pipeline repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const noMsaaTruePassthroughPipelineRepeatSnapshots = noMsaaTruePassthroughPipelineRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaTruePassthroughPipelineRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaTruePassthroughPipelineRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [noMsaaTruePassthroughPipelineRepeatFirst, noMsaaTruePassthroughPipelineRepeatSecond] = noMsaaTruePassthroughPipelineRepeatSnapshots;
const noMsaaTruePassthroughPipelineRepeatNormalDiff = repeatabilityDiff(
  noMsaaTruePassthroughPipelineRepeatFirst.normal.snapshot,
  noMsaaTruePassthroughPipelineRepeatSecond.normal.snapshot,
);
const noMsaaTruePassthroughPipelineRepeatFalsifierDiff = repeatabilityDiff(
  noMsaaTruePassthroughPipelineRepeatFirst.falsifier.snapshot,
  noMsaaTruePassthroughPipelineRepeatSecond.falsifier.snapshot,
);
if (
  noMsaaTruePassthroughPipelineRepeatFirst.normal.result.status !== 0 ||
  !noMsaaTruePassthroughPipelineRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !noMsaaTruePassthroughPipelineRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=passthrough') ||
  !noMsaaTruePassthroughPipelineRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaTruePassthroughPipelineRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaTruePassthroughPipelineRepeatFirst.normal.result.output.includes('resolveTargetCount=0') ||
  !noMsaaTruePassthroughPipelineRepeatFirst.normal.result.output.includes('draws=2') ||
  !noMsaaTruePassthroughPipelineRepeatFirst.falsifier.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !noMsaaTruePassthroughPipelineRepeatFirst.falsifier.result.output.includes('post=M3_POST_EFFECT=passthrough') ||
  !noMsaaTruePassthroughPipelineRepeatFirst.falsifier.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaTruePassthroughPipelineRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaTruePassthroughPipelineRepeatFirst.falsifier.result.output.includes('resolveTargetCount=0') ||
  !noMsaaTruePassthroughPipelineRepeatFirst.falsifier.result.output.includes('draws=1') ||
  noMsaaTruePassthroughPipelineRepeatSecond.normal.result.status !== 0 ||
  noMsaaTruePassthroughPipelineRepeatSecond.falsifier.result.status !== 0 ||
  noMsaaTruePassthroughPipelineRepeatNormalDiff !== undefined ||
  noMsaaTruePassthroughPipelineRepeatFalsifierDiff !== undefined ||
  noMsaaTruePassthroughPipelineRepeatFirst.normal.snapshot.capture.selectedVariant !== 'true' ||
  noMsaaTruePassthroughPipelineRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'true' ||
  noMsaaTruePassthroughPipelineRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaTruePassthroughPipelineRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaTruePassthroughPipelineRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  noMsaaTruePassthroughPipelineRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== true ||
  noMsaaTruePassthroughPipelineRepeatFirst.normal.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaTruePassthroughPipelineRepeatFirst.falsifier.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaTruePassthroughPipelineRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaTruePassthroughPipelineRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaTruePassthroughPipelineRepeatFirst.normal.snapshot.rhi.drawCount !== 2 ||
  noMsaaTruePassthroughPipelineRepeatFirst.falsifier.snapshot.rhi.drawCount !== 1
) {
  console.error(
    `[m3-programmable] custom pipeline no-MSAA true passthrough pipeline repeatability: FAIL - ${JSON.stringify({ normalStatus: [noMsaaTruePassthroughPipelineRepeatFirst.normal.result.status, noMsaaTruePassthroughPipelineRepeatSecond.normal.result.status], falsifierStatus: [noMsaaTruePassthroughPipelineRepeatFirst.falsifier.result.status, noMsaaTruePassthroughPipelineRepeatSecond.falsifier.result.status], normalDiff: noMsaaTruePassthroughPipelineRepeatNormalDiff, falsifierDiff: noMsaaTruePassthroughPipelineRepeatFalsifierDiff })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline no-MSAA true passthrough pipeline repeatability: PASS normalSha256=${noMsaaTruePassthroughPipelineRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${noMsaaTruePassthroughPipelineRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${noMsaaTruePassthroughPipelineRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${noMsaaTruePassthroughPipelineRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const noMsaaFalsePassthroughPipelineRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'no-msaa-false-passthrough-pipeline-repeatability');
const noMsaaFalsePassthroughPipelineRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(noMsaaFalsePassthroughPipelineRepeatArtifactRoot, pass);
  noMsaaFalsePassthroughPipelineRepeatRuns.push({
    normal: run(
      `custom pipeline no-MSAA false passthrough pipeline repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA false passthrough pipeline repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const noMsaaFalsePassthroughPipelineRepeatSnapshots = noMsaaFalsePassthroughPipelineRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaFalsePassthroughPipelineRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaFalsePassthroughPipelineRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [noMsaaFalsePassthroughPipelineRepeatFirst, noMsaaFalsePassthroughPipelineRepeatSecond] = noMsaaFalsePassthroughPipelineRepeatSnapshots;
const noMsaaFalsePassthroughPipelineRepeatNormalDiff = repeatabilityDiff(
  noMsaaFalsePassthroughPipelineRepeatFirst.normal.snapshot,
  noMsaaFalsePassthroughPipelineRepeatSecond.normal.snapshot,
);
const noMsaaFalsePassthroughPipelineRepeatFalsifierDiff = repeatabilityDiff(
  noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot,
  noMsaaFalsePassthroughPipelineRepeatSecond.falsifier.snapshot,
);
if (
  noMsaaFalsePassthroughPipelineRepeatFirst.normal.result.status !== 0 ||
  !noMsaaFalsePassthroughPipelineRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !noMsaaFalsePassthroughPipelineRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=passthrough') ||
  !noMsaaFalsePassthroughPipelineRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaFalsePassthroughPipelineRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaFalsePassthroughPipelineRepeatFirst.normal.result.output.includes('resolveTargetCount=0') ||
  !noMsaaFalsePassthroughPipelineRepeatFirst.normal.result.output.includes('draws=2') ||
  !noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('post=M3_POST_EFFECT=passthrough') ||
  !noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('resolveTargetCount=0') ||
  !noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('draws=1') ||
  noMsaaFalsePassthroughPipelineRepeatSecond.normal.result.status !== 0 ||
  noMsaaFalsePassthroughPipelineRepeatSecond.falsifier.result.status !== 0 ||
  noMsaaFalsePassthroughPipelineRepeatNormalDiff !== undefined ||
  noMsaaFalsePassthroughPipelineRepeatFalsifierDiff !== undefined ||
  noMsaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.capture.selectedVariant !== 'false' ||
  noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'false' ||
  noMsaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== true ||
  noMsaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.rhi.drawCount !== 2 ||
  noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.rhi.drawCount !== 1
) {
  console.error(
    `[m3-programmable] custom pipeline no-MSAA false passthrough pipeline repeatability: FAIL - ${JSON.stringify({ normalStatus: [noMsaaFalsePassthroughPipelineRepeatFirst.normal.result.status, noMsaaFalsePassthroughPipelineRepeatSecond.normal.result.status], falsifierStatus: [noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.result.status, noMsaaFalsePassthroughPipelineRepeatSecond.falsifier.result.status], normalDiff: noMsaaFalsePassthroughPipelineRepeatNormalDiff, falsifierDiff: noMsaaFalsePassthroughPipelineRepeatFalsifierDiff })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline no-MSAA false passthrough pipeline repeatability: PASS normalSha256=${noMsaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${noMsaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const noMsaaSteadyFalsePassthroughRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'no-msaa-steady-false-passthrough-repeatability');
const noMsaaSteadyFalsePassthroughRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(noMsaaSteadyFalsePassthroughRepeatArtifactRoot, pass);
  noMsaaSteadyFalsePassthroughRepeatRuns.push({
    normal: run(
      `custom pipeline no-MSAA steady false passthrough repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA steady false passthrough repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const noMsaaSteadyFalsePassthroughRepeatSnapshots = noMsaaSteadyFalsePassthroughRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaSteadyFalsePassthroughRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaSteadyFalsePassthroughRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [noMsaaSteadyFalsePassthroughRepeatFirst, noMsaaSteadyFalsePassthroughRepeatSecond] = noMsaaSteadyFalsePassthroughRepeatSnapshots;
const noMsaaSteadyFalsePassthroughRepeatNormalDiff = repeatabilityDiff(
  noMsaaSteadyFalsePassthroughRepeatFirst.normal.snapshot,
  noMsaaSteadyFalsePassthroughRepeatSecond.normal.snapshot,
);
const noMsaaSteadyFalsePassthroughRepeatFalsifierDiff = repeatabilityDiff(
  noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot,
  noMsaaSteadyFalsePassthroughRepeatSecond.falsifier.snapshot,
);
if (
  noMsaaSteadyFalsePassthroughRepeatFirst.normal.result.status !== 0 ||
  !noMsaaSteadyFalsePassthroughRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !noMsaaSteadyFalsePassthroughRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=passthrough') ||
  !noMsaaSteadyFalsePassthroughRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaSteadyFalsePassthroughRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaSteadyFalsePassthroughRepeatFirst.normal.result.output.includes('resolveTargetCount=0') ||
  !noMsaaSteadyFalsePassthroughRepeatFirst.normal.result.output.includes('draws=2') ||
  noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.result.status !== 0 ||
  !noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.result.output.includes('post=M3_POST_EFFECT=passthrough') ||
  !noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.result.output.includes('resolveTargetCount=0') ||
  !noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.result.output.includes('draws=2') ||
  noMsaaSteadyFalsePassthroughRepeatSecond.normal.result.status !== 0 ||
  noMsaaSteadyFalsePassthroughRepeatSecond.falsifier.result.status !== 0 ||
  noMsaaSteadyFalsePassthroughRepeatNormalDiff !== undefined ||
  noMsaaSteadyFalsePassthroughRepeatFalsifierDiff !== undefined ||
  noMsaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.capture.selectedVariant !== 'false' ||
  noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'false' ||
  noMsaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== false ||
  noMsaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.rhi.drawCount !== 2 ||
  noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.rhi.drawCount !== 2
) {
  console.error(
    `[m3-programmable] custom pipeline no-MSAA steady false passthrough repeatability: FAIL - ${JSON.stringify({ normalStatus: [noMsaaSteadyFalsePassthroughRepeatFirst.normal.result.status, noMsaaSteadyFalsePassthroughRepeatSecond.normal.result.status], falsifierStatus: [noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.result.status, noMsaaSteadyFalsePassthroughRepeatSecond.falsifier.result.status], normalDiff: noMsaaSteadyFalsePassthroughRepeatNormalDiff, falsifierDiff: noMsaaSteadyFalsePassthroughRepeatFalsifierDiff })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline no-MSAA steady false passthrough repeatability: PASS normalSha256=${noMsaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${noMsaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const noMsaaSteadyFalseInversionRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'no-msaa-steady-false-inversion-repeatability');
const noMsaaSteadyFalseInversionRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(noMsaaSteadyFalseInversionRepeatArtifactRoot, pass);
  noMsaaSteadyFalseInversionRepeatRuns.push({
    normal: run(
      `custom pipeline no-MSAA steady false inversion repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA steady false inversion repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const noMsaaSteadyFalseInversionRepeatSnapshots = noMsaaSteadyFalseInversionRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(resolve(noMsaaSteadyFalseInversionRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal')),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(resolve(noMsaaSteadyFalseInversionRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier')),
  },
}));
const [noMsaaSteadyFalseInversionRepeatFirst, noMsaaSteadyFalseInversionRepeatSecond] = noMsaaSteadyFalseInversionRepeatSnapshots;
const noMsaaSteadyFalseInversionRepeatNormalDiff = repeatabilityDiff(
  noMsaaSteadyFalseInversionRepeatFirst.normal.snapshot,
  noMsaaSteadyFalseInversionRepeatSecond.normal.snapshot,
);
const noMsaaSteadyFalseInversionRepeatFalsifierDiff = repeatabilityDiff(
  noMsaaSteadyFalseInversionRepeatFirst.falsifier.snapshot,
  noMsaaSteadyFalseInversionRepeatSecond.falsifier.snapshot,
);
if (
  noMsaaSteadyFalseInversionRepeatFirst.normal.result.status !== 0 ||
  !noMsaaSteadyFalseInversionRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !noMsaaSteadyFalseInversionRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !noMsaaSteadyFalseInversionRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaSteadyFalseInversionRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaSteadyFalseInversionRepeatFirst.normal.result.output.includes('resolveTargetCount=0') ||
  !noMsaaSteadyFalseInversionRepeatFirst.normal.result.output.includes('draws=2') ||
  noMsaaSteadyFalseInversionRepeatFirst.falsifier.result.status !== 0 ||
  !noMsaaSteadyFalseInversionRepeatFirst.falsifier.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !noMsaaSteadyFalseInversionRepeatFirst.falsifier.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !noMsaaSteadyFalseInversionRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaSteadyFalseInversionRepeatFirst.falsifier.result.output.includes('resolveTargetCount=0') ||
  !noMsaaSteadyFalseInversionRepeatFirst.falsifier.result.output.includes('draws=2') ||
  noMsaaSteadyFalseInversionRepeatSecond.normal.result.status !== 0 ||
  noMsaaSteadyFalseInversionRepeatSecond.falsifier.result.status !== 0 ||
  noMsaaSteadyFalseInversionRepeatNormalDiff !== undefined ||
  noMsaaSteadyFalseInversionRepeatFalsifierDiff !== undefined ||
  noMsaaSteadyFalseInversionRepeatFirst.normal.snapshot.capture.selectedVariant !== 'false' ||
  noMsaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'false' ||
  noMsaaSteadyFalseInversionRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  noMsaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  noMsaaSteadyFalseInversionRepeatFirst.normal.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaSteadyFalseInversionRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaSteadyFalseInversionRepeatFirst.normal.snapshot.rhi.drawCount !== 2 ||
  noMsaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.rhi.drawCount !== 2
) {
  console.error(
    `[m3-programmable] custom pipeline no-MSAA steady false inversion repeatability: FAIL - ${JSON.stringify({ normalStatus: [noMsaaSteadyFalseInversionRepeatFirst.normal.result.status, noMsaaSteadyFalseInversionRepeatSecond.normal.result.status], falsifierStatus: [noMsaaSteadyFalseInversionRepeatFirst.falsifier.result.status, noMsaaSteadyFalseInversionRepeatSecond.falsifier.result.status], normalDiff: noMsaaSteadyFalseInversionRepeatNormalDiff, falsifierDiff: noMsaaSteadyFalseInversionRepeatFalsifierDiff })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline no-MSAA steady false inversion repeatability: PASS normalSha256=${noMsaaSteadyFalseInversionRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${noMsaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${noMsaaSteadyFalseInversionRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${noMsaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const noMsaaSteadyTruePassthroughRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'no-msaa-steady-true-passthrough-repeatability');
const noMsaaSteadyTruePassthroughRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(noMsaaSteadyTruePassthroughRepeatArtifactRoot, pass);
  noMsaaSteadyTruePassthroughRepeatRuns.push({
    normal: run(
      `custom pipeline no-MSAA steady true passthrough repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA steady true passthrough repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const noMsaaSteadyTruePassthroughRepeatSnapshots = noMsaaSteadyTruePassthroughRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(resolve(noMsaaSteadyTruePassthroughRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal')),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(resolve(noMsaaSteadyTruePassthroughRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier')),
  },
}));
const [noMsaaSteadyTruePassthroughRepeatFirst, noMsaaSteadyTruePassthroughRepeatSecond] = noMsaaSteadyTruePassthroughRepeatSnapshots;
const noMsaaSteadyTruePassthroughRepeatNormalDiff = repeatabilityDiff(
  noMsaaSteadyTruePassthroughRepeatFirst.normal.snapshot,
  noMsaaSteadyTruePassthroughRepeatSecond.normal.snapshot,
);
const noMsaaSteadyTruePassthroughRepeatFalsifierDiff = repeatabilityDiff(
  noMsaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot,
  noMsaaSteadyTruePassthroughRepeatSecond.falsifier.snapshot,
);
if (
  noMsaaSteadyTruePassthroughRepeatFirst.normal.result.status !== 0 ||
  !noMsaaSteadyTruePassthroughRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !noMsaaSteadyTruePassthroughRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=passthrough') ||
  !noMsaaSteadyTruePassthroughRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaSteadyTruePassthroughRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaSteadyTruePassthroughRepeatFirst.normal.result.output.includes('resolveTargetCount=0') ||
  !noMsaaSteadyTruePassthroughRepeatFirst.normal.result.output.includes('draws=2') ||
  noMsaaSteadyTruePassthroughRepeatFirst.falsifier.result.status !== 0 ||
  !noMsaaSteadyTruePassthroughRepeatFirst.falsifier.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !noMsaaSteadyTruePassthroughRepeatFirst.falsifier.result.output.includes('post=M3_POST_EFFECT=passthrough') ||
  !noMsaaSteadyTruePassthroughRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaSteadyTruePassthroughRepeatFirst.falsifier.result.output.includes('resolveTargetCount=0') ||
  !noMsaaSteadyTruePassthroughRepeatFirst.falsifier.result.output.includes('draws=2') ||
  noMsaaSteadyTruePassthroughRepeatSecond.normal.result.status !== 0 ||
  noMsaaSteadyTruePassthroughRepeatSecond.falsifier.result.status !== 0 ||
  noMsaaSteadyTruePassthroughRepeatNormalDiff !== undefined ||
  noMsaaSteadyTruePassthroughRepeatFalsifierDiff !== undefined ||
  noMsaaSteadyTruePassthroughRepeatFirst.normal.snapshot.capture.selectedVariant !== 'true' ||
  noMsaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'true' ||
  noMsaaSteadyTruePassthroughRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaSteadyTruePassthroughRepeatFirst.normal.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaSteadyTruePassthroughRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaSteadyTruePassthroughRepeatFirst.normal.snapshot.rhi.drawCount !== 2 ||
  noMsaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.rhi.drawCount !== 2
) {
  console.error(
    `[m3-programmable] custom pipeline no-MSAA steady true passthrough repeatability: FAIL - ${JSON.stringify({ normalStatus: [noMsaaSteadyTruePassthroughRepeatFirst.normal.result.status, noMsaaSteadyTruePassthroughRepeatSecond.normal.result.status], falsifierStatus: [noMsaaSteadyTruePassthroughRepeatFirst.falsifier.result.status, noMsaaSteadyTruePassthroughRepeatSecond.falsifier.result.status], normalDiff: noMsaaSteadyTruePassthroughRepeatNormalDiff, falsifierDiff: noMsaaSteadyTruePassthroughRepeatFalsifierDiff })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline no-MSAA steady true passthrough repeatability: PASS normalSha256=${noMsaaSteadyTruePassthroughRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${noMsaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${noMsaaSteadyTruePassthroughRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${noMsaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const noMsaaSteadyTrueInversionRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'no-msaa-steady-true-inversion-repeatability');
const noMsaaSteadyTrueInversionRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(noMsaaSteadyTrueInversionRepeatArtifactRoot, pass);
  noMsaaSteadyTrueInversionRepeatRuns.push({
    normal: run(
      `custom pipeline no-MSAA steady true inversion repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA steady true inversion repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const noMsaaSteadyTrueInversionRepeatSnapshots = noMsaaSteadyTrueInversionRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(resolve(noMsaaSteadyTrueInversionRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal')),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(resolve(noMsaaSteadyTrueInversionRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier')),
  },
}));
const [noMsaaSteadyTrueInversionRepeatFirst, noMsaaSteadyTrueInversionRepeatSecond] = noMsaaSteadyTrueInversionRepeatSnapshots;
const noMsaaSteadyTrueInversionRepeatNormalDiff = repeatabilityDiff(
  noMsaaSteadyTrueInversionRepeatFirst.normal.snapshot,
  noMsaaSteadyTrueInversionRepeatSecond.normal.snapshot,
);
const noMsaaSteadyTrueInversionRepeatFalsifierDiff = repeatabilityDiff(
  noMsaaSteadyTrueInversionRepeatFirst.falsifier.snapshot,
  noMsaaSteadyTrueInversionRepeatSecond.falsifier.snapshot,
);
if (
  noMsaaSteadyTrueInversionRepeatFirst.normal.result.status !== 0 ||
  !noMsaaSteadyTrueInversionRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !noMsaaSteadyTrueInversionRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !noMsaaSteadyTrueInversionRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaSteadyTrueInversionRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaSteadyTrueInversionRepeatFirst.normal.result.output.includes('resolveTargetCount=0') ||
  !noMsaaSteadyTrueInversionRepeatFirst.normal.result.output.includes('draws=2') ||
  noMsaaSteadyTrueInversionRepeatFirst.falsifier.result.status !== 0 ||
  !noMsaaSteadyTrueInversionRepeatFirst.falsifier.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !noMsaaSteadyTrueInversionRepeatFirst.falsifier.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !noMsaaSteadyTrueInversionRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaSteadyTrueInversionRepeatFirst.falsifier.result.output.includes('resolveTargetCount=0') ||
  !noMsaaSteadyTrueInversionRepeatFirst.falsifier.result.output.includes('draws=2') ||
  noMsaaSteadyTrueInversionRepeatSecond.normal.result.status !== 0 ||
  noMsaaSteadyTrueInversionRepeatSecond.falsifier.result.status !== 0 ||
  noMsaaSteadyTrueInversionRepeatNormalDiff !== undefined ||
  noMsaaSteadyTrueInversionRepeatFalsifierDiff !== undefined ||
  noMsaaSteadyTrueInversionRepeatFirst.normal.snapshot.capture.selectedVariant !== 'true' ||
  noMsaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'true' ||
  noMsaaSteadyTrueInversionRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  noMsaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  noMsaaSteadyTrueInversionRepeatFirst.normal.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaSteadyTrueInversionRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaSteadyTrueInversionRepeatFirst.normal.snapshot.rhi.drawCount !== 2 ||
  noMsaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.rhi.drawCount !== 2
) {
  console.error(
    `[m3-programmable] custom pipeline no-MSAA steady true inversion repeatability: FAIL - ${JSON.stringify({ normalStatus: [noMsaaSteadyTrueInversionRepeatFirst.normal.result.status, noMsaaSteadyTrueInversionRepeatSecond.normal.result.status], falsifierStatus: [noMsaaSteadyTrueInversionRepeatFirst.falsifier.result.status, noMsaaSteadyTrueInversionRepeatSecond.falsifier.result.status], normalDiff: noMsaaSteadyTrueInversionRepeatNormalDiff, falsifierDiff: noMsaaSteadyTrueInversionRepeatFalsifierDiff })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline no-MSAA steady true inversion repeatability: PASS normalSha256=${noMsaaSteadyTrueInversionRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${noMsaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${noMsaaSteadyTrueInversionRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${noMsaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const msaaPostArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-postfx-falsifier');
const msaaPostNormal = run(
  'custom pipeline MSAA inversion post normal',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'inversion',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaPostArtifactRoot, 'normal'),
  },
);
const msaaPostFalsifier = run(
  'custom pipeline MSAA inversion post falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'inversion',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_FALSIFY: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaPostArtifactRoot, 'falsifier'),
  },
);
const msaaPostNormalCapture = JSON.parse(
  readFileSync(resolve(msaaPostArtifactRoot, 'normal', 'capture.json'), 'utf8'),
);
const msaaPostFalsifierCapture = JSON.parse(
  readFileSync(resolve(msaaPostArtifactRoot, 'falsifier', 'capture.json'), 'utf8'),
);
const msaaPostNormalSummary = JSON.parse(
  readFileSync(resolve(msaaPostArtifactRoot, 'normal', 'rhi-summary.json'), 'utf8'),
);
const msaaPostFalsifierSummary = JSON.parse(
  readFileSync(resolve(msaaPostArtifactRoot, 'falsifier', 'rhi-summary.json'), 'utf8'),
);
if (
  msaaPostNormal.status !== 0 ||
  !msaaPostNormal.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaPostNormal.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaPostNormal.output.includes('msaaTextureResourceCount=4') ||
  !msaaPostNormal.output.includes('resolveTargetCount=1') ||
  !msaaPostNormal.output.includes('draws=2') ||
  !msaaPostNormal.output.includes('variantSwitch=true') ||
  msaaPostFalsifier.status !== 0 ||
  !msaaPostFalsifier.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaPostFalsifier.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaPostFalsifier.output.includes('msaaTextureResourceCount=2') ||
  !msaaPostFalsifier.output.includes('resolveTargetCount=1') ||
  !msaaPostFalsifier.output.includes('draws=1') ||
  msaaPostNormalCapture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaPostFalsifierCapture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaPostNormalCapture.falsifyPipeline !== false ||
  msaaPostFalsifierCapture.falsifyPipeline !== true ||
  msaaPostNormalSummary.resolveTargetCount !== 1 ||
  msaaPostNormalSummary.drawCount !== 2 ||
  msaaPostFalsifierSummary.resolveTargetCount !== 1 ||
  msaaPostFalsifierSummary.drawCount !== 1
) {
  console.error('[m3-programmable] custom pipeline MSAA inversion post: FAIL - non-default post effect did not preserve the adjacent-pipeline oracle');
  process.exit(1);
}
let msaaPostPixelDelta;
try {
  msaaPostPixelDelta = comparePngs(
    resolve(msaaPostArtifactRoot, 'normal', 'custom-live.png'),
    resolve(msaaPostArtifactRoot, 'falsifier', 'custom-live.png'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA inversion post PNG delta: FAIL - ${error}`);
  process.exit(1);
}
if (msaaPostPixelDelta.changedPixels === 0 || msaaPostPixelDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA inversion post PNG delta: FAIL - changedPixels=${msaaPostPixelDelta.changedPixels} meanRgbDelta=${msaaPostPixelDelta.meanRgbDelta.toFixed(4)}`,
  );
  process.exit(1);
}
let msaaPostDawnReadbackDelta;
try {
  msaaPostDawnReadbackDelta = compareDawnReadbacks(
    resolve(msaaPostArtifactRoot, 'normal', 'dawn-readback.rgba'),
    resolve(msaaPostArtifactRoot, 'normal', 'dawn-readback.json'),
    resolve(msaaPostArtifactRoot, 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaPostArtifactRoot, 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA inversion post Dawn delta: FAIL - ${error}`);
  process.exit(1);
}
if (msaaPostDawnReadbackDelta.changedPixels === 0 || msaaPostDawnReadbackDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA inversion post Dawn delta: FAIL - changedPixels=${msaaPostDawnReadbackDelta.changedPixels} meanRgbDelta=${msaaPostDawnReadbackDelta.meanRgbDelta.toFixed(4)}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline MSAA inversion post: PASS normalResolve=1 falsifierResolve=1 normalDraws=2 falsifierDraws=1 changedPixels=${msaaPostPixelDelta.changedPixels} changedFraction=${msaaPostPixelDelta.changedFraction.toFixed(3)} meanRgbDelta=${msaaPostPixelDelta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${msaaPostDawnReadbackDelta.changedPixels} dawnMeanRgbDelta=${msaaPostDawnReadbackDelta.meanRgbDelta.toFixed(4)} normalSha256=${msaaPostDawnReadbackDelta.normalSha256} falsifierSha256=${msaaPostDawnReadbackDelta.falsifierSha256}`,
);

const msaaLivePostArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-live-post-falsifier');
const msaaLivePostNormal = run(
  'custom pipeline MSAA live post normal',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'passthrough',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_SWITCH_POST: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaLivePostArtifactRoot, 'normal'),
  },
);
const msaaLivePostFalsifier = run(
  'custom pipeline MSAA live post falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'passthrough',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_SWITCH_POST: '1',
    FORGEAX_M3_FALSIFY: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaLivePostArtifactRoot, 'falsifier'),
  },
);
const msaaLivePostNormalCapture = JSON.parse(
  readFileSync(resolve(msaaLivePostArtifactRoot, 'normal', 'capture.json'), 'utf8'),
);
const msaaLivePostFalsifierCapture = JSON.parse(
  readFileSync(resolve(msaaLivePostArtifactRoot, 'falsifier', 'capture.json'), 'utf8'),
);
const msaaLivePostNormalSummary = JSON.parse(
  readFileSync(resolve(msaaLivePostArtifactRoot, 'normal', 'rhi-summary.json'), 'utf8'),
);
const msaaLivePostFalsifierSummary = JSON.parse(
  readFileSync(resolve(msaaLivePostArtifactRoot, 'falsifier', 'rhi-summary.json'), 'utf8'),
);
if (
  msaaLivePostNormal.status !== 0 ||
  !msaaLivePostNormal.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaLivePostNormal.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaLivePostNormal.output.includes('msaaTextureResourceCount=4') ||
  !msaaLivePostNormal.output.includes('resolveTargetCount=1') ||
  !msaaLivePostNormal.output.includes('draws=2') ||
  !msaaLivePostNormal.output.includes('variantSwitch=true') ||
  !msaaLivePostNormal.output.includes('postSwitch=true') ||
  msaaLivePostFalsifier.status !== 0 ||
  !msaaLivePostFalsifier.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaLivePostFalsifier.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaLivePostFalsifier.output.includes('msaaTextureResourceCount=2') ||
  !msaaLivePostFalsifier.output.includes('resolveTargetCount=1') ||
  !msaaLivePostFalsifier.output.includes('draws=1') ||
  !msaaLivePostFalsifier.output.includes('variantSwitch=true') ||
  !msaaLivePostFalsifier.output.includes('postSwitch=true') ||
  msaaLivePostNormalCapture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaLivePostFalsifierCapture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaLivePostNormalCapture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaLivePostFalsifierCapture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaLivePostNormalCapture.postSwitchedAfterPipeline !== true ||
  msaaLivePostFalsifierCapture.postSwitchedAfterPipeline !== true ||
  msaaLivePostNormalSummary.resolveTargetCount !== 1 ||
  msaaLivePostNormalSummary.drawCount !== 2 ||
  msaaLivePostFalsifierSummary.resolveTargetCount !== 1 ||
  msaaLivePostFalsifierSummary.drawCount !== 1
) {
  console.error('[m3-programmable] custom pipeline MSAA live post: FAIL - live post selection did not preserve the MSAA adjacent-pipeline oracle');
  process.exit(1);
}
let msaaLivePostPixelDelta;
try {
  msaaLivePostPixelDelta = comparePngs(
    resolve(msaaLivePostArtifactRoot, 'normal', 'custom-live.png'),
    resolve(msaaLivePostArtifactRoot, 'falsifier', 'custom-live.png'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA live post PNG delta: FAIL - ${error}`);
  process.exit(1);
}
if (msaaLivePostPixelDelta.changedPixels === 0 || msaaLivePostPixelDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA live post PNG delta: FAIL - changedPixels=${msaaLivePostPixelDelta.changedPixels} meanRgbDelta=${msaaLivePostPixelDelta.meanRgbDelta.toFixed(4)}`,
  );
  process.exit(1);
}
let msaaLivePostDawnReadbackDelta;
try {
  msaaLivePostDawnReadbackDelta = compareDawnReadbacks(
    resolve(msaaLivePostArtifactRoot, 'normal', 'dawn-readback.rgba'),
    resolve(msaaLivePostArtifactRoot, 'normal', 'dawn-readback.json'),
    resolve(msaaLivePostArtifactRoot, 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaLivePostArtifactRoot, 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA live post Dawn delta: FAIL - ${error}`);
  process.exit(1);
}
if (msaaLivePostDawnReadbackDelta.changedPixels === 0 || msaaLivePostDawnReadbackDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA live post Dawn delta: FAIL - changedPixels=${msaaLivePostDawnReadbackDelta.changedPixels} meanRgbDelta=${msaaLivePostDawnReadbackDelta.meanRgbDelta.toFixed(4)}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline MSAA live post: PASS normalPost=passthrough falsifierPost=passthrough finalPost=inversion normalResolve=1 falsifierResolve=1 normalDraws=2 falsifierDraws=1 changedPixels=${msaaLivePostPixelDelta.changedPixels} changedFraction=${msaaLivePostPixelDelta.changedFraction.toFixed(3)} meanRgbDelta=${msaaLivePostPixelDelta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${msaaLivePostDawnReadbackDelta.changedPixels} dawnMeanRgbDelta=${msaaLivePostDawnReadbackDelta.meanRgbDelta.toFixed(4)} normalSha256=${msaaLivePostDawnReadbackDelta.normalSha256} falsifierSha256=${msaaLivePostDawnReadbackDelta.falsifierSha256}`,
);

const msaaLivePostPipelineArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-live-post-pipeline-falsifier');
const msaaLivePostPipelineNormal = run(
  'custom pipeline MSAA live post adjacent pipeline normal',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'passthrough',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_SWITCH_POST: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaLivePostPipelineArtifactRoot, 'normal'),
  },
);
const msaaLivePostPipelineFalsifier = run(
  'custom pipeline MSAA live post adjacent pipeline falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'passthrough',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_SWITCH_POST: '1',
    FORGEAX_M3_FALSIFY: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaLivePostPipelineArtifactRoot, 'falsifier'),
  },
);
const msaaLivePostPipelineNormalCapture = JSON.parse(
  readFileSync(resolve(msaaLivePostPipelineArtifactRoot, 'normal', 'capture.json'), 'utf8'),
);
const msaaLivePostPipelineFalsifierCapture = JSON.parse(
  readFileSync(resolve(msaaLivePostPipelineArtifactRoot, 'falsifier', 'capture.json'), 'utf8'),
);
const msaaLivePostPipelineNormalSummary = JSON.parse(
  readFileSync(resolve(msaaLivePostPipelineArtifactRoot, 'normal', 'rhi-summary.json'), 'utf8'),
);
const msaaLivePostPipelineFalsifierSummary = JSON.parse(
  readFileSync(resolve(msaaLivePostPipelineArtifactRoot, 'falsifier', 'rhi-summary.json'), 'utf8'),
);
if (
  msaaLivePostPipelineNormal.status !== 0 ||
  !msaaLivePostPipelineNormal.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaLivePostPipelineNormal.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaLivePostPipelineNormal.output.includes('msaaTextureResourceCount=4') ||
  !msaaLivePostPipelineNormal.output.includes('resolveTargetCount=1') ||
  !msaaLivePostPipelineNormal.output.includes('draws=2') ||
  !msaaLivePostPipelineNormal.output.includes('variantSwitch=true') ||
  !msaaLivePostPipelineNormal.output.includes('postSwitch=true') ||
  msaaLivePostPipelineFalsifier.status !== 0 ||
  !msaaLivePostPipelineFalsifier.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaLivePostPipelineFalsifier.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaLivePostPipelineFalsifier.output.includes('msaaTextureResourceCount=2') ||
  !msaaLivePostPipelineFalsifier.output.includes('resolveTargetCount=1') ||
  !msaaLivePostPipelineFalsifier.output.includes('draws=1') ||
  !msaaLivePostPipelineFalsifier.output.includes('variantSwitch=true') ||
  !msaaLivePostPipelineFalsifier.output.includes('postSwitch=true') ||
  msaaLivePostPipelineNormalCapture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaLivePostPipelineFalsifierCapture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaLivePostPipelineNormalCapture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaLivePostPipelineFalsifierCapture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaLivePostPipelineNormalCapture.falsifyPipeline !== false ||
  msaaLivePostPipelineFalsifierCapture.falsifyPipeline !== true ||
  msaaLivePostPipelineNormalCapture.postSwitchedAfterPipeline !== true ||
  msaaLivePostPipelineFalsifierCapture.postSwitchedAfterPipeline !== true ||
  msaaLivePostPipelineNormalSummary.resolveTargetCount !== 1 ||
  msaaLivePostPipelineNormalSummary.drawCount !== 2 ||
  msaaLivePostPipelineFalsifierSummary.resolveTargetCount !== 1 ||
  msaaLivePostPipelineFalsifierSummary.drawCount !== 1
) {
  console.error('[m3-programmable] custom pipeline MSAA live post adjacent pipeline falsifier: FAIL - live post switching did not survive the adjacent pipeline fault');
  process.exit(1);
}
let msaaLivePostPipelinePixelDelta;
try {
  msaaLivePostPipelinePixelDelta = comparePngs(
    resolve(msaaLivePostPipelineArtifactRoot, 'normal', 'custom-live.png'),
    resolve(msaaLivePostPipelineArtifactRoot, 'falsifier', 'custom-live.png'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA live post adjacent pipeline PNG delta: FAIL - ${error}`);
  process.exit(1);
}
if (msaaLivePostPipelinePixelDelta.changedPixels === 0 || msaaLivePostPipelinePixelDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA live post adjacent pipeline PNG delta: FAIL - changedPixels=${msaaLivePostPipelinePixelDelta.changedPixels} meanRgbDelta=${msaaLivePostPipelinePixelDelta.meanRgbDelta.toFixed(4)}`,
  );
  process.exit(1);
}
let msaaLivePostPipelineDawnReadbackDelta;
try {
  msaaLivePostPipelineDawnReadbackDelta = compareDawnReadbacks(
    resolve(msaaLivePostPipelineArtifactRoot, 'normal', 'dawn-readback.rgba'),
    resolve(msaaLivePostPipelineArtifactRoot, 'normal', 'dawn-readback.json'),
    resolve(msaaLivePostPipelineArtifactRoot, 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaLivePostPipelineArtifactRoot, 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA live post adjacent pipeline Dawn delta: FAIL - ${error}`);
  process.exit(1);
}
if (msaaLivePostPipelineDawnReadbackDelta.width !== 640 || msaaLivePostPipelineDawnReadbackDelta.height !== 360) {
  console.error(
    `[m3-programmable] custom pipeline MSAA live post adjacent pipeline Dawn readback: FAIL - dimensions=${msaaLivePostPipelineDawnReadbackDelta.width}x${msaaLivePostPipelineDawnReadbackDelta.height}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline MSAA live post adjacent pipeline: PASS normalPost=passthrough falsifierPost=passthrough finalPost=inversion normalResolve=1 falsifierResolve=1 normalDraws=2 falsifierDraws=1 changedPixels=${msaaLivePostPipelinePixelDelta.changedPixels} changedFraction=${msaaLivePostPipelinePixelDelta.changedFraction.toFixed(3)} meanRgbDelta=${msaaLivePostPipelinePixelDelta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${msaaLivePostPipelineDawnReadbackDelta.changedPixels} dawnMeanRgbDelta=${msaaLivePostPipelineDawnReadbackDelta.meanRgbDelta.toFixed(4)} normalSha256=${msaaLivePostPipelineDawnReadbackDelta.normalSha256} falsifierSha256=${msaaLivePostPipelineDawnReadbackDelta.falsifierSha256}`,
);

const msaaLivePostPipelineRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-live-post-pipeline-repeatability');
const msaaLivePostPipelineRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaLivePostPipelineRepeatArtifactRoot, pass);
  msaaLivePostPipelineRepeatRuns.push({
    normal: run(
      `custom pipeline MSAA live post adjacent pipeline repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA live post adjacent pipeline repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaLivePostPipelineRepeatSnapshots = msaaLivePostPipelineRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(resolve(msaaLivePostPipelineRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal')),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(resolve(msaaLivePostPipelineRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier')),
  },
}));
const [msaaLivePostPipelineRepeatFirst, msaaLivePostPipelineRepeatSecond] = msaaLivePostPipelineRepeatSnapshots;
const msaaLivePostPipelineRepeatNormalDiff = repeatabilityDiff(
  msaaLivePostPipelineRepeatFirst.normal.snapshot,
  msaaLivePostPipelineRepeatSecond.normal.snapshot,
);
const msaaLivePostPipelineRepeatFalsifierDiff = repeatabilityDiff(
  msaaLivePostPipelineRepeatFirst.falsifier.snapshot,
  msaaLivePostPipelineRepeatSecond.falsifier.snapshot,
);
if (
  msaaLivePostPipelineRepeatFirst.normal.result.status !== 0 ||
  !msaaLivePostPipelineRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaLivePostPipelineRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=4') ||
  !msaaLivePostPipelineRepeatFirst.normal.result.output.includes('resolveTargetCount=1') ||
  !msaaLivePostPipelineRepeatFirst.normal.result.output.includes('draws=2') ||
  !msaaLivePostPipelineRepeatFirst.normal.result.output.includes('variantSwitch=true') ||
  !msaaLivePostPipelineRepeatFirst.normal.result.output.includes('postSwitch=true') ||
  msaaLivePostPipelineRepeatFirst.falsifier.result.status !== 0 ||
  !msaaLivePostPipelineRepeatFirst.falsifier.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaLivePostPipelineRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=2') ||
  !msaaLivePostPipelineRepeatFirst.falsifier.result.output.includes('resolveTargetCount=1') ||
  !msaaLivePostPipelineRepeatFirst.falsifier.result.output.includes('draws=1') ||
  !msaaLivePostPipelineRepeatFirst.falsifier.result.output.includes('variantSwitch=true') ||
  !msaaLivePostPipelineRepeatFirst.falsifier.result.output.includes('postSwitch=true') ||
  msaaLivePostPipelineRepeatSecond.normal.result.status !== 0 ||
  msaaLivePostPipelineRepeatSecond.falsifier.result.status !== 0 ||
  msaaLivePostPipelineRepeatNormalDiff !== undefined ||
  msaaLivePostPipelineRepeatFalsifierDiff !== undefined ||
  msaaLivePostPipelineRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  msaaLivePostPipelineRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== true
) {
  console.error(
    `[m3-programmable] custom pipeline MSAA live post adjacent pipeline repeatability: FAIL - ${JSON.stringify({ normalStatus: [msaaLivePostPipelineRepeatFirst.normal.result.status, msaaLivePostPipelineRepeatSecond.normal.result.status], falsifierStatus: [msaaLivePostPipelineRepeatFirst.falsifier.result.status, msaaLivePostPipelineRepeatSecond.falsifier.result.status], normalDiff: msaaLivePostPipelineRepeatNormalDiff, falsifierDiff: msaaLivePostPipelineRepeatFalsifierDiff })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline MSAA live post adjacent pipeline repeatability: PASS normalSha256=${msaaLivePostPipelineRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${msaaLivePostPipelineRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${msaaLivePostPipelineRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${msaaLivePostPipelineRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const msaaLivePostResolveArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-live-post-resolve-falsifier');
const msaaLivePostResolveNormal = run(
  'custom pipeline MSAA live post resolve normal',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'passthrough',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_SWITCH_POST: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaLivePostResolveArtifactRoot, 'normal'),
  },
);
const msaaLivePostResolveFalsifier = run(
  'custom pipeline MSAA live post resolve falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'passthrough',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_SWITCH_POST: '1',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaLivePostResolveArtifactRoot, 'falsifier'),
  },
);
const msaaLivePostResolveNormalCapture = JSON.parse(
  readFileSync(resolve(msaaLivePostResolveArtifactRoot, 'normal', 'capture.json'), 'utf8'),
);
const msaaLivePostResolveFalsifierCapture = JSON.parse(
  readFileSync(resolve(msaaLivePostResolveArtifactRoot, 'falsifier', 'capture.json'), 'utf8'),
);
const msaaLivePostResolveNormalSummary = JSON.parse(
  readFileSync(resolve(msaaLivePostResolveArtifactRoot, 'normal', 'rhi-summary.json'), 'utf8'),
);
const msaaLivePostResolveFalsifierSummary = JSON.parse(
  readFileSync(resolve(msaaLivePostResolveArtifactRoot, 'falsifier', 'rhi-summary.json'), 'utf8'),
);
if (
  msaaLivePostResolveNormal.status !== 0 ||
  !msaaLivePostResolveNormal.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaLivePostResolveNormal.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaLivePostResolveNormal.output.includes('msaaTextureResourceCount=4') ||
  !msaaLivePostResolveNormal.output.includes('resolveTargetCount=1') ||
  !msaaLivePostResolveNormal.output.includes('draws=2') ||
  !msaaLivePostResolveNormal.output.includes('variantSwitch=true') ||
  !msaaLivePostResolveNormal.output.includes('postSwitch=true') ||
  msaaLivePostResolveFalsifier.status !== 0 ||
  !msaaLivePostResolveFalsifier.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaLivePostResolveFalsifier.output.includes('resolveTargetCount=0') ||
  !msaaLivePostResolveFalsifier.output.includes('dawnReadbackSha256=') ||
  msaaLivePostResolveNormalCapture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaLivePostResolveFalsifierCapture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaLivePostResolveNormalCapture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaLivePostResolveFalsifierCapture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaLivePostResolveNormalCapture.postSwitchedAfterPipeline !== true ||
  msaaLivePostResolveFalsifierCapture.postSwitchedAfterPipeline !== true ||
  msaaLivePostResolveNormalSummary.resolveTargetCount !== 1 ||
  msaaLivePostResolveNormalSummary.drawCount !== 2 ||
  msaaLivePostResolveFalsifierSummary.resolveTargetCount !== 0 ||
  msaaLivePostResolveFalsifierSummary.drawCount !== 2
) {
  console.error('[m3-programmable] custom pipeline MSAA live post resolve falsifier: FAIL - post switch did not survive the no-resolve topology falsifier');
  process.exit(1);
}
let msaaLivePostResolvePixelDelta;
try {
  msaaLivePostResolvePixelDelta = comparePngs(
    resolve(msaaLivePostResolveArtifactRoot, 'normal', 'custom-live.png'),
    resolve(msaaLivePostResolveArtifactRoot, 'falsifier', 'custom-live.png'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA live post resolve PNG delta: FAIL - ${error}`);
  process.exit(1);
}
if (msaaLivePostResolvePixelDelta.changedPixels === 0 || msaaLivePostResolvePixelDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA live post resolve PNG delta: FAIL - changedPixels=${msaaLivePostResolvePixelDelta.changedPixels} meanRgbDelta=${msaaLivePostResolvePixelDelta.meanRgbDelta.toFixed(4)}`,
  );
  process.exit(1);
}
let msaaLivePostResolveDawnReadbackDelta;
try {
  msaaLivePostResolveDawnReadbackDelta = compareDawnReadbacks(
    resolve(msaaLivePostResolveArtifactRoot, 'normal', 'dawn-readback.rgba'),
    resolve(msaaLivePostResolveArtifactRoot, 'normal', 'dawn-readback.json'),
    resolve(msaaLivePostResolveArtifactRoot, 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaLivePostResolveArtifactRoot, 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA live post resolve Dawn delta: FAIL - ${error}`);
  process.exit(1);
}
if (msaaLivePostResolveDawnReadbackDelta.changedPixels === 0 || msaaLivePostResolveDawnReadbackDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA live post resolve Dawn delta: FAIL - changedPixels=${msaaLivePostResolveDawnReadbackDelta.changedPixels} meanRgbDelta=${msaaLivePostResolveDawnReadbackDelta.meanRgbDelta.toFixed(4)}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline MSAA live post resolve falsifier: PASS normalPost=passthrough falsifierPost=passthrough finalPost=inversion normalResolve=1 falsifierResolve=0 normalDraws=2 falsifierDraws=2 changedPixels=${msaaLivePostResolvePixelDelta.changedPixels} changedFraction=${msaaLivePostResolvePixelDelta.changedFraction.toFixed(3)} meanRgbDelta=${msaaLivePostResolvePixelDelta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${msaaLivePostResolveDawnReadbackDelta.changedPixels} dawnMeanRgbDelta=${msaaLivePostResolveDawnReadbackDelta.meanRgbDelta.toFixed(4)} normalSha256=${msaaLivePostResolveDawnReadbackDelta.normalSha256} falsifierSha256=${msaaLivePostResolveDawnReadbackDelta.falsifierSha256}`,
);

const msaaLivePostResolveRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-live-post-resolve-repeatability');
const msaaLivePostResolveRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaLivePostResolveRepeatArtifactRoot, pass);
  msaaLivePostResolveRepeatRuns.push({
    normal: run(
      `custom pipeline MSAA live post resolve repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA live post resolve repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaLivePostResolveRepeatSnapshots = msaaLivePostResolveRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaLivePostResolveRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaLivePostResolveRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [msaaLivePostResolveRepeatFirst, msaaLivePostResolveRepeatSecond] = msaaLivePostResolveRepeatSnapshots;
const msaaLivePostResolveRepeatNormalDiff = repeatabilityDiff(
  msaaLivePostResolveRepeatFirst.normal.snapshot,
  msaaLivePostResolveRepeatSecond.normal.snapshot,
);
const msaaLivePostResolveRepeatFalsifierDiff = repeatabilityDiff(
  msaaLivePostResolveRepeatFirst.falsifier.snapshot,
  msaaLivePostResolveRepeatSecond.falsifier.snapshot,
);
if (
  msaaLivePostResolveRepeatFirst.normal.result.status !== 0 ||
  !msaaLivePostResolveRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaLivePostResolveRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaLivePostResolveRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=4') ||
  !msaaLivePostResolveRepeatFirst.normal.result.output.includes('resolveTargetCount=1') ||
  !msaaLivePostResolveRepeatFirst.normal.result.output.includes('draws=2') ||
  !msaaLivePostResolveRepeatFirst.normal.result.output.includes('variantSwitch=true') ||
  !msaaLivePostResolveRepeatFirst.normal.result.output.includes('postSwitch=true') ||
  msaaLivePostResolveRepeatFirst.falsifier.result.status !== 0 ||
  !msaaLivePostResolveRepeatFirst.falsifier.result.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaLivePostResolveRepeatFirst.falsifier.result.output.includes('resolveTargetCount=0') ||
  msaaLivePostResolveRepeatSecond.normal.result.status !== 0 ||
  msaaLivePostResolveRepeatSecond.falsifier.result.status !== 0 ||
  msaaLivePostResolveRepeatNormalDiff !== undefined ||
  msaaLivePostResolveRepeatFalsifierDiff !== undefined ||
  msaaLivePostResolveRepeatFirst.normal.snapshot.capture.selectedVariant !== 'true' ||
  msaaLivePostResolveRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'true' ||
  msaaLivePostResolveRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaLivePostResolveRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaLivePostResolveRepeatFirst.normal.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  msaaLivePostResolveRepeatFirst.falsifier.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  msaaLivePostResolveRepeatFirst.normal.snapshot.capture.postSwitchedAfterPipeline !== true ||
  msaaLivePostResolveRepeatFirst.falsifier.snapshot.capture.postSwitchedAfterPipeline !== true ||
  msaaLivePostResolveRepeatFirst.normal.snapshot.rhi.msaaTextureResourceCount !== 4 ||
  msaaLivePostResolveRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaLivePostResolveRepeatFirst.normal.snapshot.rhi.drawCount !== 2 ||
  msaaLivePostResolveRepeatFirst.falsifier.snapshot.rhi.msaaTextureResourceCount !== 4 ||
  msaaLivePostResolveRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 0 ||
  msaaLivePostResolveRepeatFirst.falsifier.snapshot.rhi.drawCount !== 2
) {
  console.error(
    `[m3-programmable] custom pipeline MSAA live post resolve repeatability: FAIL - ${JSON.stringify({ normalStatus: [msaaLivePostResolveRepeatFirst.normal.result.status, msaaLivePostResolveRepeatSecond.normal.result.status], falsifierStatus: [msaaLivePostResolveRepeatFirst.falsifier.result.status, msaaLivePostResolveRepeatSecond.falsifier.result.status], normalDiff: msaaLivePostResolveRepeatNormalDiff, falsifierDiff: msaaLivePostResolveRepeatFalsifierDiff })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline MSAA live post resolve repeatability: PASS normalSha256=${msaaLivePostResolveRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${msaaLivePostResolveRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${msaaLivePostResolveRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${msaaLivePostResolveRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const msaaLivePostDoubleResizeRepeatArtifactRoot = resolve(
  customRhiArtifactRoot,
  'msaa-live-post-double-resize-repeatability',
);
const msaaLivePostDoubleResizeRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, pass);
  msaaLivePostDoubleResizeRepeatRuns.push({
    normal: run(
      `custom pipeline MSAA live post double resize repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA live post double resize repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaLivePostDoubleResizeRepeatFirst = msaaLivePostDoubleResizeRepeatRuns[0];
const msaaLivePostDoubleResizeRepeatSecond = msaaLivePostDoubleResizeRepeatRuns[1];
const msaaLivePostDoubleResizeRepeatFirstNormalSnapshot = readRepeatabilitySnapshot(
  resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'normal'),
);
const msaaLivePostDoubleResizeRepeatSecondNormalSnapshot = readRepeatabilitySnapshot(
  resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'normal'),
);
const msaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot = readRepeatabilitySnapshot(
  resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'falsifier'),
);
const msaaLivePostDoubleResizeRepeatSecondFalsifierSnapshot = readRepeatabilitySnapshot(
  resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'falsifier'),
);
const msaaLivePostDoubleResizeRepeatNormalDiff = repeatabilityDiff(
  msaaLivePostDoubleResizeRepeatFirstNormalSnapshot,
  msaaLivePostDoubleResizeRepeatSecondNormalSnapshot,
);
const msaaLivePostDoubleResizeRepeatFalsifierDiff = repeatabilityDiff(
  msaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot,
  msaaLivePostDoubleResizeRepeatSecondFalsifierSnapshot,
);
let msaaLivePostDoubleResizeRepeatFirstPngDelta;
let msaaLivePostDoubleResizeRepeatSecondPngDelta;
let msaaLivePostDoubleResizeRepeatFirstDawnDelta;
let msaaLivePostDoubleResizeRepeatSecondDawnDelta;
try {
  msaaLivePostDoubleResizeRepeatFirstPngDelta = comparePngs(
    resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'normal', 'custom-live.png'),
    resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'falsifier', 'custom-live.png'),
  );
  msaaLivePostDoubleResizeRepeatSecondPngDelta = comparePngs(
    resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'normal', 'custom-live.png'),
    resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'falsifier', 'custom-live.png'),
  );
  msaaLivePostDoubleResizeRepeatFirstDawnDelta = compareDawnReadbacks(
    resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'normal', 'dawn-readback.rgba'),
    resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'normal', 'dawn-readback.json'),
    resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'falsifier', 'dawn-readback.json'),
  );
  msaaLivePostDoubleResizeRepeatSecondDawnDelta = compareDawnReadbacks(
    resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'normal', 'dawn-readback.rgba'),
    resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'normal', 'dawn-readback.json'),
    resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] MSAA live post double resize repeatability delta: FAIL - ${error}`);
  process.exit(1);
}
const msaaLivePostDoubleResizeExpectedHistoryArray = [
  '640x360',
  '480x270',
  '720x405',
  '640x360',
  '480x270',
  '720x405',
  '640x360',
];
if (
  msaaLivePostDoubleResizeRepeatFirst.normal.status !== 0 ||
  msaaLivePostDoubleResizeRepeatFirst.falsifier.status !== 0 ||
  msaaLivePostDoubleResizeRepeatSecond.normal.status !== 0 ||
  msaaLivePostDoubleResizeRepeatSecond.falsifier.status !== 0 ||
  msaaLivePostDoubleResizeRepeatFirstNormalSnapshot.capture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaLivePostDoubleResizeRepeatFirstNormalSnapshot.capture.antialias !== 'M3_ANTIALIAS=msaa' ||
  msaaLivePostDoubleResizeRepeatFirstNormalSnapshot.capture.variantSwitchedAfterPipeline !== true ||
  msaaLivePostDoubleResizeRepeatFirstNormalSnapshot.capture.postSwitchedAfterPipeline !== true ||
  msaaLivePostDoubleResizeRepeatFirstNormalSnapshot.capture.resizeHistory.join('>') !==
    msaaLivePostDoubleResizeExpectedHistoryArray.join('>') ||
  msaaLivePostDoubleResizeRepeatFirstNormalSnapshot.rhi.msaaTextureResourceCount !== 4 ||
  msaaLivePostDoubleResizeRepeatFirstNormalSnapshot.rhi.resolveTargetCount !== 1 ||
  msaaLivePostDoubleResizeRepeatFirstNormalSnapshot.rhi.drawCount !== 2 ||
  msaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.capture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.capture.antialias !== 'M3_ANTIALIAS=msaa' ||
  msaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.capture.variantSwitchedAfterPipeline !== true ||
  msaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.capture.postSwitchedAfterPipeline !== true ||
  msaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.capture.resizeHistory.join('>') !==
    msaaLivePostDoubleResizeExpectedHistoryArray.join('>') ||
  msaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.rhi.msaaTextureResourceCount !== 4 ||
  msaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.rhi.resolveTargetCount !== 0 ||
  msaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.rhi.drawCount !== 2 ||
  msaaLivePostDoubleResizeRepeatNormalDiff !== undefined ||
  msaaLivePostDoubleResizeRepeatFalsifierDiff !== undefined ||
  msaaLivePostDoubleResizeRepeatFirstPngDelta.changedPixels === 0 ||
  msaaLivePostDoubleResizeRepeatFirstPngDelta.meanRgbDelta <= 0.01 ||
  msaaLivePostDoubleResizeRepeatSecondPngDelta.changedPixels === 0 ||
  msaaLivePostDoubleResizeRepeatSecondPngDelta.meanRgbDelta <= 0.01 ||
  msaaLivePostDoubleResizeRepeatFirstDawnDelta.changedPixels === 0 ||
  msaaLivePostDoubleResizeRepeatFirstDawnDelta.meanRgbDelta <= 0.01 ||
  msaaLivePostDoubleResizeRepeatSecondDawnDelta.changedPixels === 0 ||
  msaaLivePostDoubleResizeRepeatSecondDawnDelta.meanRgbDelta <= 0.01
) {
  console.error(
    `[m3-programmable] MSAA live post double resize repeatability: FAIL - ${JSON.stringify({ statuses: { firstNormal: msaaLivePostDoubleResizeRepeatFirst.normal.status, firstFalsifier: msaaLivePostDoubleResizeRepeatFirst.falsifier.status, secondNormal: msaaLivePostDoubleResizeRepeatSecond.normal.status, secondFalsifier: msaaLivePostDoubleResizeRepeatSecond.falsifier.status }, normalDiff: msaaLivePostDoubleResizeRepeatNormalDiff, falsifierDiff: msaaLivePostDoubleResizeRepeatFalsifierDiff, firstPng: msaaLivePostDoubleResizeRepeatFirstPngDelta, secondPng: msaaLivePostDoubleResizeRepeatSecondPngDelta, firstDawn: msaaLivePostDoubleResizeRepeatFirstDawnDelta, secondDawn: msaaLivePostDoubleResizeRepeatSecondDawnDelta })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] MSAA live post double resize repeatability: PASS normalSha256=${msaaLivePostDoubleResizeRepeatFirstDawnDelta.normalSha256} falsifierSha256=${msaaLivePostDoubleResizeRepeatFirstDawnDelta.falsifierSha256} dawnChangedPixels=${msaaLivePostDoubleResizeRepeatFirstDawnDelta.changedPixels} pngChangedPixels=${msaaLivePostDoubleResizeRepeatFirstPngDelta.changedPixels}`,
);

const msaaLiveVariantRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-live-variant-repeatability');
const msaaLiveVariantRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaLiveVariantRepeatArtifactRoot, pass);
  msaaLiveVariantRepeatRuns.push({
    normal: run(
      `custom pipeline MSAA live variant repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA live variant repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaLiveVariantRepeatSnapshots = msaaLiveVariantRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaLiveVariantRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaLiveVariantRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [msaaLiveVariantRepeatFirst, msaaLiveVariantRepeatSecond] = msaaLiveVariantRepeatSnapshots;
const msaaLiveVariantRepeatNormalDiff = repeatabilityDiff(
  msaaLiveVariantRepeatFirst.normal.snapshot,
  msaaLiveVariantRepeatSecond.normal.snapshot,
);
const msaaLiveVariantRepeatFalsifierDiff = repeatabilityDiff(
  msaaLiveVariantRepeatFirst.falsifier.snapshot,
  msaaLiveVariantRepeatSecond.falsifier.snapshot,
);
if (
  msaaLiveVariantRepeatFirst.normal.result.status !== 0 ||
  !msaaLiveVariantRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !msaaLiveVariantRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=passthrough') ||
  !msaaLiveVariantRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaLiveVariantRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=4') ||
  !msaaLiveVariantRepeatFirst.normal.result.output.includes('resolveTargetCount=1') ||
  !msaaLiveVariantRepeatFirst.normal.result.output.includes('draws=2') ||
  !msaaLiveVariantRepeatFirst.normal.result.output.includes('variantSwitch=true') ||
  !msaaLiveVariantRepeatFirst.normal.result.output.includes('postSwitch=false') ||
  msaaLiveVariantRepeatFirst.falsifier.result.status !== 0 ||
  !msaaLiveVariantRepeatFirst.falsifier.result.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaLiveVariantRepeatFirst.falsifier.result.output.includes('resolveTargetCount=0') ||
  msaaLiveVariantRepeatSecond.normal.result.status !== 0 ||
  msaaLiveVariantRepeatSecond.falsifier.result.status !== 0 ||
  msaaLiveVariantRepeatNormalDiff !== undefined ||
  msaaLiveVariantRepeatFalsifierDiff !== undefined ||
  msaaLiveVariantRepeatFirst.normal.snapshot.capture.selectedVariant !== 'false' ||
  msaaLiveVariantRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'false' ||
  msaaLiveVariantRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaLiveVariantRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaLiveVariantRepeatFirst.normal.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  msaaLiveVariantRepeatFirst.falsifier.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  msaaLiveVariantRepeatFirst.normal.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaLiveVariantRepeatFirst.falsifier.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaLiveVariantRepeatFirst.normal.snapshot.rhi.msaaTextureResourceCount !== 4 ||
  msaaLiveVariantRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaLiveVariantRepeatFirst.normal.snapshot.rhi.drawCount !== 2 ||
  msaaLiveVariantRepeatFirst.falsifier.snapshot.rhi.msaaTextureResourceCount !== 4 ||
  msaaLiveVariantRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 0 ||
  msaaLiveVariantRepeatFirst.falsifier.snapshot.rhi.drawCount !== 2
) {
  console.error(
    `[m3-programmable] custom pipeline MSAA live variant repeatability: FAIL - ${JSON.stringify({ normalStatus: [msaaLiveVariantRepeatFirst.normal.result.status, msaaLiveVariantRepeatSecond.normal.result.status], falsifierStatus: [msaaLiveVariantRepeatFirst.falsifier.result.status, msaaLiveVariantRepeatSecond.falsifier.result.status], normalDiff: msaaLiveVariantRepeatNormalDiff, falsifierDiff: msaaLiveVariantRepeatFalsifierDiff })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline MSAA live variant repeatability: PASS normalSha256=${msaaLiveVariantRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${msaaLiveVariantRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${msaaLiveVariantRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${msaaLiveVariantRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const msaaSteadyInversionArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-steady-inversion');
const msaaLiveVariantInversionRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-live-variant-inversion-repeatability');
const msaaLiveVariantInversionRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaLiveVariantInversionRepeatArtifactRoot, pass);
  msaaLiveVariantInversionRepeatRuns.push({
    normal: run(
      `custom pipeline MSAA live variant inversion repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA live variant inversion repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaLiveVariantInversionRepeatSnapshots = msaaLiveVariantInversionRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaLiveVariantInversionRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaLiveVariantInversionRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [msaaLiveVariantInversionRepeatFirst, msaaLiveVariantInversionRepeatSecond] = msaaLiveVariantInversionRepeatSnapshots;
const msaaLiveVariantInversionRepeatNormalDiff = repeatabilityDiff(
  msaaLiveVariantInversionRepeatFirst.normal.snapshot,
  msaaLiveVariantInversionRepeatSecond.normal.snapshot,
);
const msaaLiveVariantInversionRepeatFalsifierDiff = repeatabilityDiff(
  msaaLiveVariantInversionRepeatFirst.falsifier.snapshot,
  msaaLiveVariantInversionRepeatSecond.falsifier.snapshot,
);
if (
  msaaLiveVariantInversionRepeatFirst.normal.result.status !== 0 ||
  !msaaLiveVariantInversionRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !msaaLiveVariantInversionRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaLiveVariantInversionRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaLiveVariantInversionRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=4') ||
  !msaaLiveVariantInversionRepeatFirst.normal.result.output.includes('resolveTargetCount=1') ||
  !msaaLiveVariantInversionRepeatFirst.normal.result.output.includes('draws=2') ||
  !msaaLiveVariantInversionRepeatFirst.normal.result.output.includes('variantSwitch=true') ||
  !msaaLiveVariantInversionRepeatFirst.normal.result.output.includes('postSwitch=false') ||
  msaaLiveVariantInversionRepeatFirst.falsifier.result.status !== 0 ||
  !msaaLiveVariantInversionRepeatFirst.falsifier.result.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaLiveVariantInversionRepeatFirst.falsifier.result.output.includes('resolveTargetCount=0') ||
  msaaLiveVariantInversionRepeatSecond.normal.result.status !== 0 ||
  msaaLiveVariantInversionRepeatSecond.falsifier.result.status !== 0 ||
  msaaLiveVariantInversionRepeatNormalDiff !== undefined ||
  msaaLiveVariantInversionRepeatFalsifierDiff !== undefined ||
  msaaLiveVariantInversionRepeatFirst.normal.snapshot.capture.selectedVariant !== 'false' ||
  msaaLiveVariantInversionRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'false' ||
  msaaLiveVariantInversionRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaLiveVariantInversionRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaLiveVariantInversionRepeatFirst.normal.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  msaaLiveVariantInversionRepeatFirst.falsifier.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  msaaLiveVariantInversionRepeatFirst.normal.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaLiveVariantInversionRepeatFirst.falsifier.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaLiveVariantInversionRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  msaaLiveVariantInversionRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== false ||
  msaaLiveVariantInversionRepeatFirst.normal.snapshot.rhi.msaaTextureResourceCount !== 4 ||
  msaaLiveVariantInversionRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaLiveVariantInversionRepeatFirst.normal.snapshot.rhi.drawCount !== 2 ||
  msaaLiveVariantInversionRepeatFirst.falsifier.snapshot.rhi.msaaTextureResourceCount !== 4 ||
  msaaLiveVariantInversionRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 0 ||
  msaaLiveVariantInversionRepeatFirst.falsifier.snapshot.rhi.drawCount !== 2
) {
  console.error(
    `[m3-programmable] custom pipeline MSAA live variant inversion repeatability: FAIL - ${JSON.stringify({ normalStatus: [msaaLiveVariantInversionRepeatFirst.normal.result.status, msaaLiveVariantInversionRepeatSecond.normal.result.status], falsifierStatus: [msaaLiveVariantInversionRepeatFirst.falsifier.result.status, msaaLiveVariantInversionRepeatSecond.falsifier.result.status], normalDiff: msaaLiveVariantInversionRepeatNormalDiff, falsifierDiff: msaaLiveVariantInversionRepeatFalsifierDiff })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline MSAA live variant inversion repeatability: PASS normalSha256=${msaaLiveVariantInversionRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${msaaLiveVariantInversionRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${msaaLiveVariantInversionRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${msaaLiveVariantInversionRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const noMsaaLiveVariantInversionPipelineRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'no-msaa-live-variant-inversion-pipeline-repeatability');
const noMsaaLiveVariantInversionPipelineRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(noMsaaLiveVariantInversionPipelineRepeatArtifactRoot, pass);
  noMsaaLiveVariantInversionPipelineRepeatRuns.push({
    normal: run(
      `custom pipeline no-MSAA live variant inversion adjacent pipeline repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA live variant inversion adjacent pipeline repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const noMsaaLiveVariantInversionPipelineRepeatSnapshots = noMsaaLiveVariantInversionPipelineRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaLiveVariantInversionPipelineRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaLiveVariantInversionPipelineRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [noMsaaLiveVariantInversionPipelineRepeatFirst, noMsaaLiveVariantInversionPipelineRepeatSecond] = noMsaaLiveVariantInversionPipelineRepeatSnapshots;
const noMsaaLiveVariantInversionPipelineRepeatNormalDiff = repeatabilityDiff(
  noMsaaLiveVariantInversionPipelineRepeatFirst.normal.snapshot,
  noMsaaLiveVariantInversionPipelineRepeatSecond.normal.snapshot,
);
const noMsaaLiveVariantInversionPipelineRepeatFalsifierDiff = repeatabilityDiff(
  noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.snapshot,
  noMsaaLiveVariantInversionPipelineRepeatSecond.falsifier.snapshot,
);
if (
  noMsaaLiveVariantInversionPipelineRepeatFirst.normal.result.status !== 0 ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.normal.result.output.includes('resolveTargetCount=0') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.normal.result.output.includes('draws=2') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.normal.result.output.includes('variantSwitch=true') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.normal.result.output.includes('postSwitch=false') ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.result.status !== 0 ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.result.output.includes('[m3-browser-rhi] PASS -') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.result.output.includes('resolveTargetCount=0') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.result.output.includes('draws=1') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.result.output.includes('variantSwitch=true') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.result.output.includes('postSwitch=false') ||
  noMsaaLiveVariantInversionPipelineRepeatSecond.normal.result.status !== 0 ||
  noMsaaLiveVariantInversionPipelineRepeatSecond.falsifier.result.status !== 0 ||
  noMsaaLiveVariantInversionPipelineRepeatNormalDiff !== undefined ||
  noMsaaLiveVariantInversionPipelineRepeatFalsifierDiff !== undefined ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.normal.snapshot.capture.selectedVariant !== 'false' ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'false' ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.normal.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.normal.snapshot.capture.postSwitchedAfterPipeline !== false ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.snapshot.capture.postSwitchedAfterPipeline !== false ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== true ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.normal.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.normal.snapshot.rhi.drawCount !== 2 ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.snapshot.rhi.drawCount !== 1
) {
  console.error(
    `[m3-programmable] custom pipeline no-MSAA live variant inversion adjacent pipeline repeatability: FAIL - ${JSON.stringify({ normalStatus: [noMsaaLiveVariantInversionPipelineRepeatFirst.normal.result.status, noMsaaLiveVariantInversionPipelineRepeatSecond.normal.result.status], falsifierStatus: [noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.result.status, noMsaaLiveVariantInversionPipelineRepeatSecond.falsifier.result.status], normalDiff: noMsaaLiveVariantInversionPipelineRepeatNormalDiff, falsifierDiff: noMsaaLiveVariantInversionPipelineRepeatFalsifierDiff })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline no-MSAA live variant inversion adjacent pipeline repeatability: PASS normalSha256=${noMsaaLiveVariantInversionPipelineRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${noMsaaLiveVariantInversionPipelineRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const msaaSteadyInversionNormal = run(
  'custom pipeline MSAA steady inversion normal',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'inversion',
    FORGEAX_M3_VARIANT: 'false',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaSteadyInversionArtifactRoot, 'normal'),
  },
);
const msaaSteadyInversionFalsifier = run(
  'custom pipeline MSAA steady inversion falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'inversion',
    FORGEAX_M3_VARIANT: 'false',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaSteadyInversionArtifactRoot, 'falsifier'),
  },
);
const msaaSteadyInversionNormalCapture = JSON.parse(
  readFileSync(resolve(msaaSteadyInversionArtifactRoot, 'normal', 'capture.json'), 'utf8'),
);
const msaaSteadyInversionFalsifierCapture = JSON.parse(
  readFileSync(resolve(msaaSteadyInversionArtifactRoot, 'falsifier', 'capture.json'), 'utf8'),
);
const msaaSteadyInversionNormalSummary = JSON.parse(
  readFileSync(resolve(msaaSteadyInversionArtifactRoot, 'normal', 'rhi-summary.json'), 'utf8'),
);
const msaaSteadyInversionFalsifierSummary = JSON.parse(
  readFileSync(resolve(msaaSteadyInversionArtifactRoot, 'falsifier', 'rhi-summary.json'), 'utf8'),
);
if (
  msaaSteadyInversionNormal.status !== 0 ||
  !msaaSteadyInversionNormal.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaSteadyInversionNormal.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !msaaSteadyInversionNormal.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaSteadyInversionNormal.output.includes('msaaTextureResourceCount=4') ||
  !msaaSteadyInversionNormal.output.includes('resolveTargetCount=1') ||
  !msaaSteadyInversionNormal.output.includes('draws=2') ||
  !msaaSteadyInversionNormal.output.includes('variantSwitch=false') ||
  !msaaSteadyInversionNormal.output.includes('postSwitch=false') ||
  msaaSteadyInversionFalsifier.status !== 0 ||
  !msaaSteadyInversionFalsifier.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaSteadyInversionFalsifier.output.includes('resolveTargetCount=0') ||
  msaaSteadyInversionNormalCapture.falsifyPipeline !== false ||
  msaaSteadyInversionFalsifierCapture.falsifyPipeline !== false ||
  msaaSteadyInversionNormalCapture.selectedVariant !== 'false' ||
  msaaSteadyInversionFalsifierCapture.selectedVariant !== 'false' ||
  msaaSteadyInversionNormalCapture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaSteadyInversionFalsifierCapture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaSteadyInversionNormalCapture.variantSwitchedAfterPipeline !== false ||
  msaaSteadyInversionFalsifierCapture.variantSwitchedAfterPipeline !== false ||
  msaaSteadyInversionNormalCapture.postSwitchedAfterPipeline !== false ||
  msaaSteadyInversionFalsifierCapture.postSwitchedAfterPipeline !== false ||
  msaaSteadyInversionNormalSummary.resolveTargetCount !== 1 ||
  msaaSteadyInversionNormalSummary.drawCount !== 2 ||
  msaaSteadyInversionFalsifierSummary.resolveTargetCount !== 0 ||
  msaaSteadyInversionFalsifierSummary.drawCount !== 2
) {
  console.error('[m3-programmable] custom pipeline MSAA steady inversion: FAIL - steady-state variant/post or no-resolve evidence did not pass');
  process.exit(1);
}
let msaaSteadyInversionPixelDelta;
try {
  msaaSteadyInversionPixelDelta = comparePngs(
    resolve(msaaSteadyInversionArtifactRoot, 'normal', 'custom-live.png'),
    resolve(msaaSteadyInversionArtifactRoot, 'falsifier', 'custom-live.png'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA steady inversion PNG delta: FAIL - ${error}`);
  process.exit(1);
}
if (msaaSteadyInversionPixelDelta.changedPixels === 0 || msaaSteadyInversionPixelDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA steady inversion PNG delta: FAIL - changedPixels=${msaaSteadyInversionPixelDelta.changedPixels} meanRgbDelta=${msaaSteadyInversionPixelDelta.meanRgbDelta.toFixed(4)}`,
  );
  process.exit(1);
}
let msaaSteadyInversionDawnReadbackDelta;
try {
  msaaSteadyInversionDawnReadbackDelta = compareDawnReadbacks(
    resolve(msaaSteadyInversionArtifactRoot, 'normal', 'dawn-readback.rgba'),
    resolve(msaaSteadyInversionArtifactRoot, 'normal', 'dawn-readback.json'),
    resolve(msaaSteadyInversionArtifactRoot, 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaSteadyInversionArtifactRoot, 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA steady inversion Dawn delta: FAIL - ${error}`);
  process.exit(1);
}
if (msaaSteadyInversionDawnReadbackDelta.changedPixels === 0 || msaaSteadyInversionDawnReadbackDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA steady inversion Dawn delta: FAIL - changedPixels=${msaaSteadyInversionDawnReadbackDelta.changedPixels} meanRgbDelta=${msaaSteadyInversionDawnReadbackDelta.meanRgbDelta.toFixed(4)}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline MSAA steady inversion: PASS normalResolve=1 falsifierResolve=0 normalDraws=2 falsifierDraws=2 changedPixels=${msaaSteadyInversionPixelDelta.changedPixels} changedFraction=${msaaSteadyInversionPixelDelta.changedFraction.toFixed(3)} meanRgbDelta=${msaaSteadyInversionPixelDelta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${msaaSteadyInversionDawnReadbackDelta.changedPixels} dawnMeanRgbDelta=${msaaSteadyInversionDawnReadbackDelta.meanRgbDelta.toFixed(4)} normalSha256=${msaaSteadyInversionDawnReadbackDelta.normalSha256} falsifierSha256=${msaaSteadyInversionDawnReadbackDelta.falsifierSha256}`,
);

const msaaSteadyTrueInversionArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-steady-true-inversion');
const msaaSteadyTrueInversionNormal = run(
  'custom pipeline MSAA steady true inversion normal',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'inversion',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaSteadyTrueInversionArtifactRoot, 'normal'),
  },
);
const msaaSteadyTrueInversionFalsifier = run(
  'custom pipeline MSAA steady true inversion falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'inversion',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaSteadyTrueInversionArtifactRoot, 'falsifier'),
  },
);
const msaaSteadyTrueInversionNormalCapture = JSON.parse(
  readFileSync(resolve(msaaSteadyTrueInversionArtifactRoot, 'normal', 'capture.json'), 'utf8'),
);
const msaaSteadyTrueInversionFalsifierCapture = JSON.parse(
  readFileSync(resolve(msaaSteadyTrueInversionArtifactRoot, 'falsifier', 'capture.json'), 'utf8'),
);
const msaaSteadyTrueInversionNormalSummary = JSON.parse(
  readFileSync(resolve(msaaSteadyTrueInversionArtifactRoot, 'normal', 'rhi-summary.json'), 'utf8'),
);
const msaaSteadyTrueInversionFalsifierSummary = JSON.parse(
  readFileSync(resolve(msaaSteadyTrueInversionArtifactRoot, 'falsifier', 'rhi-summary.json'), 'utf8'),
);
if (
  msaaSteadyTrueInversionNormal.status !== 0 ||
  !msaaSteadyTrueInversionNormal.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaSteadyTrueInversionNormal.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !msaaSteadyTrueInversionNormal.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaSteadyTrueInversionNormal.output.includes('msaaTextureResourceCount=4') ||
  !msaaSteadyTrueInversionNormal.output.includes('resolveTargetCount=1') ||
  !msaaSteadyTrueInversionNormal.output.includes('draws=2') ||
  !msaaSteadyTrueInversionNormal.output.includes('variantSwitch=false') ||
  !msaaSteadyTrueInversionNormal.output.includes('postSwitch=false') ||
  msaaSteadyTrueInversionFalsifier.status !== 0 ||
  !msaaSteadyTrueInversionFalsifier.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaSteadyTrueInversionFalsifier.output.includes('resolveTargetCount=0') ||
  msaaSteadyTrueInversionNormalCapture.falsifyPipeline !== false ||
  msaaSteadyTrueInversionFalsifierCapture.falsifyPipeline !== false ||
  msaaSteadyTrueInversionNormalCapture.selectedVariant !== 'true' ||
  msaaSteadyTrueInversionFalsifierCapture.selectedVariant !== 'true' ||
  msaaSteadyTrueInversionNormalCapture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaSteadyTrueInversionFalsifierCapture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaSteadyTrueInversionNormalCapture.variantSwitchedAfterPipeline !== false ||
  msaaSteadyTrueInversionFalsifierCapture.variantSwitchedAfterPipeline !== false ||
  msaaSteadyTrueInversionNormalCapture.postSwitchedAfterPipeline !== false ||
  msaaSteadyTrueInversionFalsifierCapture.postSwitchedAfterPipeline !== false ||
  msaaSteadyTrueInversionNormalSummary.resolveTargetCount !== 1 ||
  msaaSteadyTrueInversionNormalSummary.drawCount !== 2 ||
  msaaSteadyTrueInversionFalsifierSummary.resolveTargetCount !== 0 ||
  msaaSteadyTrueInversionFalsifierSummary.drawCount !== 2
) {
  console.error('[m3-programmable] custom pipeline MSAA steady true inversion: FAIL - steady-state true variant/post or no-resolve evidence did not pass');
  process.exit(1);
}
let msaaSteadyTrueInversionPixelDelta;
try {
  msaaSteadyTrueInversionPixelDelta = comparePngs(
    resolve(msaaSteadyTrueInversionArtifactRoot, 'normal', 'custom-live.png'),
    resolve(msaaSteadyTrueInversionArtifactRoot, 'falsifier', 'custom-live.png'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA steady true inversion PNG delta: FAIL - ${error}`);
  process.exit(1);
}
if (msaaSteadyTrueInversionPixelDelta.changedPixels === 0 || msaaSteadyTrueInversionPixelDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA steady true inversion PNG delta: FAIL - changedPixels=${msaaSteadyTrueInversionPixelDelta.changedPixels} meanRgbDelta=${msaaSteadyTrueInversionPixelDelta.meanRgbDelta.toFixed(4)}`,
  );
  process.exit(1);
}
let msaaSteadyTrueInversionDawnReadbackDelta;
try {
  msaaSteadyTrueInversionDawnReadbackDelta = compareDawnReadbacks(
    resolve(msaaSteadyTrueInversionArtifactRoot, 'normal', 'dawn-readback.rgba'),
    resolve(msaaSteadyTrueInversionArtifactRoot, 'normal', 'dawn-readback.json'),
    resolve(msaaSteadyTrueInversionArtifactRoot, 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaSteadyTrueInversionArtifactRoot, 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA steady true inversion Dawn delta: FAIL - ${error}`);
  process.exit(1);
}
if (msaaSteadyTrueInversionDawnReadbackDelta.changedPixels === 0 || msaaSteadyTrueInversionDawnReadbackDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA steady true inversion Dawn delta: FAIL - changedPixels=${msaaSteadyTrueInversionDawnReadbackDelta.changedPixels} meanRgbDelta=${msaaSteadyTrueInversionDawnReadbackDelta.meanRgbDelta.toFixed(4)}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline MSAA steady true inversion: PASS normalResolve=1 falsifierResolve=0 normalDraws=2 falsifierDraws=2 changedPixels=${msaaSteadyTrueInversionPixelDelta.changedPixels} changedFraction=${msaaSteadyTrueInversionPixelDelta.changedFraction.toFixed(3)} meanRgbDelta=${msaaSteadyTrueInversionPixelDelta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${msaaSteadyTrueInversionDawnReadbackDelta.changedPixels} dawnMeanRgbDelta=${msaaSteadyTrueInversionDawnReadbackDelta.meanRgbDelta.toFixed(4)} normalSha256=${msaaSteadyTrueInversionDawnReadbackDelta.normalSha256} falsifierSha256=${msaaSteadyTrueInversionDawnReadbackDelta.falsifierSha256}`,
);

const msaaSteadyTrueInversionRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-steady-true-inversion-repeatability');
const msaaSteadyTrueInversionRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaSteadyTrueInversionRepeatArtifactRoot, pass);
  msaaSteadyTrueInversionRepeatRuns.push({
    normal: run(
      `custom pipeline MSAA steady true inversion repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA steady true inversion repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaSteadyTrueInversionRepeatSnapshots = msaaSteadyTrueInversionRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaSteadyTrueInversionRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaSteadyTrueInversionRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [msaaSteadyTrueInversionRepeatFirst, msaaSteadyTrueInversionRepeatSecond] = msaaSteadyTrueInversionRepeatSnapshots;
const msaaSteadyTrueInversionRepeatNormalDiff = repeatabilityDiff(
  msaaSteadyTrueInversionRepeatFirst.normal.snapshot,
  msaaSteadyTrueInversionRepeatSecond.normal.snapshot,
);
const msaaSteadyTrueInversionRepeatFalsifierDiff = repeatabilityDiff(
  msaaSteadyTrueInversionRepeatFirst.falsifier.snapshot,
  msaaSteadyTrueInversionRepeatSecond.falsifier.snapshot,
);
if (
  msaaSteadyTrueInversionRepeatFirst.normal.result.status !== 0 ||
  !msaaSteadyTrueInversionRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !msaaSteadyTrueInversionRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaSteadyTrueInversionRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=4') ||
  !msaaSteadyTrueInversionRepeatFirst.normal.result.output.includes('resolveTargetCount=1') ||
  !msaaSteadyTrueInversionRepeatFirst.normal.result.output.includes('draws=2') ||
  msaaSteadyTrueInversionRepeatFirst.falsifier.result.status !== 0 ||
  !msaaSteadyTrueInversionRepeatFirst.falsifier.result.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaSteadyTrueInversionRepeatFirst.falsifier.result.output.includes('resolveTargetCount=0') ||
  msaaSteadyTrueInversionRepeatSecond.normal.result.status !== 0 ||
  msaaSteadyTrueInversionRepeatSecond.falsifier.result.status !== 0 ||
  msaaSteadyTrueInversionRepeatNormalDiff !== undefined ||
  msaaSteadyTrueInversionRepeatFalsifierDiff !== undefined ||
  msaaSteadyTrueInversionRepeatFirst.normal.snapshot.capture.selectedVariant !== 'true' ||
  msaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'true' ||
  msaaSteadyTrueInversionRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaSteadyTrueInversionRepeatFirst.normal.snapshot.capture.variantSwitchedAfterPipeline !== false ||
  msaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.capture.variantSwitchedAfterPipeline !== false ||
  msaaSteadyTrueInversionRepeatFirst.normal.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaSteadyTrueInversionRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  msaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== false ||
  msaaSteadyTrueInversionRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaSteadyTrueInversionRepeatFirst.normal.snapshot.rhi.drawCount !== 2 ||
  msaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 0 ||
  msaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.rhi.drawCount !== 2
) {
  console.error(
    `[m3-programmable] custom pipeline MSAA steady true inversion repeatability: FAIL - ${JSON.stringify({ normalStatus: [msaaSteadyTrueInversionRepeatFirst.normal.result.status, msaaSteadyTrueInversionRepeatSecond.normal.result.status], falsifierStatus: [msaaSteadyTrueInversionRepeatFirst.falsifier.result.status, msaaSteadyTrueInversionRepeatSecond.falsifier.result.status], normalDiff: msaaSteadyTrueInversionRepeatNormalDiff, falsifierDiff: msaaSteadyTrueInversionRepeatFalsifierDiff })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline MSAA steady true inversion repeatability: PASS normalSha256=${msaaSteadyTrueInversionRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${msaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${msaaSteadyTrueInversionRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${msaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const msaaSteadyTruePassthroughRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-steady-true-passthrough-repeatability');
const msaaSteadyTruePassthroughRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaSteadyTruePassthroughRepeatArtifactRoot, pass);
  msaaSteadyTruePassthroughRepeatRuns.push({
    normal: run(
      `custom pipeline MSAA steady true passthrough repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA steady true passthrough repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaSteadyTruePassthroughRepeatSnapshots = msaaSteadyTruePassthroughRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaSteadyTruePassthroughRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaSteadyTruePassthroughRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [msaaSteadyTruePassthroughRepeatFirst, msaaSteadyTruePassthroughRepeatSecond] = msaaSteadyTruePassthroughRepeatSnapshots;
const msaaSteadyTruePassthroughRepeatNormalDiff = repeatabilityDiff(
  msaaSteadyTruePassthroughRepeatFirst.normal.snapshot,
  msaaSteadyTruePassthroughRepeatSecond.normal.snapshot,
);
const msaaSteadyTruePassthroughRepeatFalsifierDiff = repeatabilityDiff(
  msaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot,
  msaaSteadyTruePassthroughRepeatSecond.falsifier.snapshot,
);
if (
  msaaSteadyTruePassthroughRepeatFirst.normal.result.status !== 0 ||
  !msaaSteadyTruePassthroughRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !msaaSteadyTruePassthroughRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=passthrough') ||
  !msaaSteadyTruePassthroughRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=4') ||
  !msaaSteadyTruePassthroughRepeatFirst.normal.result.output.includes('resolveTargetCount=1') ||
  !msaaSteadyTruePassthroughRepeatFirst.normal.result.output.includes('draws=2') ||
  !msaaSteadyTruePassthroughRepeatFirst.normal.result.output.includes('variantSwitch=false') ||
  !msaaSteadyTruePassthroughRepeatFirst.normal.result.output.includes('postSwitch=false') ||
  msaaSteadyTruePassthroughRepeatFirst.falsifier.result.status !== 0 ||
  !msaaSteadyTruePassthroughRepeatFirst.falsifier.result.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaSteadyTruePassthroughRepeatFirst.falsifier.result.output.includes('resolveTargetCount=0') ||
  msaaSteadyTruePassthroughRepeatSecond.normal.result.status !== 0 ||
  msaaSteadyTruePassthroughRepeatSecond.falsifier.result.status !== 0 ||
  msaaSteadyTruePassthroughRepeatNormalDiff !== undefined ||
  msaaSteadyTruePassthroughRepeatFalsifierDiff !== undefined ||
  msaaSteadyTruePassthroughRepeatFirst.normal.snapshot.capture.selectedVariant !== 'true' ||
  msaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'true' ||
  msaaSteadyTruePassthroughRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaSteadyTruePassthroughRepeatFirst.normal.snapshot.capture.variantSwitchedAfterPipeline !== false ||
  msaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.capture.variantSwitchedAfterPipeline !== false ||
  msaaSteadyTruePassthroughRepeatFirst.normal.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaSteadyTruePassthroughRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  msaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== false ||
  msaaSteadyTruePassthroughRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaSteadyTruePassthroughRepeatFirst.normal.snapshot.rhi.drawCount !== 2 ||
  msaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 0 ||
  msaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.rhi.drawCount !== 2
) {
  console.error(
    `[m3-programmable] custom pipeline MSAA steady true passthrough repeatability: FAIL - ${JSON.stringify({ normalStatus: [msaaSteadyTruePassthroughRepeatFirst.normal.result.status, msaaSteadyTruePassthroughRepeatSecond.normal.result.status], falsifierStatus: [msaaSteadyTruePassthroughRepeatFirst.falsifier.result.status, msaaSteadyTruePassthroughRepeatSecond.falsifier.result.status], normalDiff: msaaSteadyTruePassthroughRepeatNormalDiff, falsifierDiff: msaaSteadyTruePassthroughRepeatFalsifierDiff })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline MSAA steady true passthrough repeatability: PASS normalSha256=${msaaSteadyTruePassthroughRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${msaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${msaaSteadyTruePassthroughRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${msaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const msaaSteadyFalsePassthroughRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-steady-false-passthrough-repeatability');
const msaaSteadyFalsePassthroughRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaSteadyFalsePassthroughRepeatArtifactRoot, pass);
  msaaSteadyFalsePassthroughRepeatRuns.push({
    normal: run(
      `custom pipeline MSAA steady false passthrough repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA steady false passthrough repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaSteadyFalsePassthroughRepeatSnapshots = msaaSteadyFalsePassthroughRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaSteadyFalsePassthroughRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaSteadyFalsePassthroughRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [msaaSteadyFalsePassthroughRepeatFirst, msaaSteadyFalsePassthroughRepeatSecond] = msaaSteadyFalsePassthroughRepeatSnapshots;
const msaaSteadyFalsePassthroughRepeatNormalDiff = repeatabilityDiff(
  msaaSteadyFalsePassthroughRepeatFirst.normal.snapshot,
  msaaSteadyFalsePassthroughRepeatSecond.normal.snapshot,
);
const msaaSteadyFalsePassthroughRepeatFalsifierDiff = repeatabilityDiff(
  msaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot,
  msaaSteadyFalsePassthroughRepeatSecond.falsifier.snapshot,
);
if (
  msaaSteadyFalsePassthroughRepeatFirst.normal.result.status !== 0 ||
  !msaaSteadyFalsePassthroughRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !msaaSteadyFalsePassthroughRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=passthrough') ||
  !msaaSteadyFalsePassthroughRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=4') ||
  !msaaSteadyFalsePassthroughRepeatFirst.normal.result.output.includes('resolveTargetCount=1') ||
  !msaaSteadyFalsePassthroughRepeatFirst.normal.result.output.includes('draws=2') ||
  !msaaSteadyFalsePassthroughRepeatFirst.normal.result.output.includes('variantSwitch=false') ||
  !msaaSteadyFalsePassthroughRepeatFirst.normal.result.output.includes('postSwitch=false') ||
  msaaSteadyFalsePassthroughRepeatFirst.falsifier.result.status !== 0 ||
  !msaaSteadyFalsePassthroughRepeatFirst.falsifier.result.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaSteadyFalsePassthroughRepeatFirst.falsifier.result.output.includes('resolveTargetCount=0') ||
  msaaSteadyFalsePassthroughRepeatSecond.normal.result.status !== 0 ||
  msaaSteadyFalsePassthroughRepeatSecond.falsifier.result.status !== 0 ||
  msaaSteadyFalsePassthroughRepeatNormalDiff !== undefined ||
  msaaSteadyFalsePassthroughRepeatFalsifierDiff !== undefined ||
  msaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.capture.selectedVariant !== 'false' ||
  msaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'false' ||
  msaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.capture.variantSwitchedAfterPipeline !== false ||
  msaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.capture.variantSwitchedAfterPipeline !== false ||
  msaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  msaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== false ||
  msaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.rhi.drawCount !== 2 ||
  msaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 0 ||
  msaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.rhi.drawCount !== 2
) {
  console.error(
    `[m3-programmable] custom pipeline MSAA steady false passthrough repeatability: FAIL - ${JSON.stringify({ normalStatus: [msaaSteadyFalsePassthroughRepeatFirst.normal.result.status, msaaSteadyFalsePassthroughRepeatSecond.normal.result.status], falsifierStatus: [msaaSteadyFalsePassthroughRepeatFirst.falsifier.result.status, msaaSteadyFalsePassthroughRepeatSecond.falsifier.result.status], normalDiff: msaaSteadyFalsePassthroughRepeatNormalDiff, falsifierDiff: msaaSteadyFalsePassthroughRepeatFalsifierDiff })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline MSAA steady false passthrough repeatability: PASS normalSha256=${msaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${msaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${msaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${msaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const msaaSteadyFalseInversionRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-steady-false-inversion-repeatability');
const msaaSteadyFalseInversionRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaSteadyFalseInversionRepeatArtifactRoot, pass);
  msaaSteadyFalseInversionRepeatRuns.push({
    normal: run(
      `custom pipeline MSAA steady false inversion repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA steady false inversion repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaSteadyFalseInversionRepeatSnapshots = msaaSteadyFalseInversionRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaSteadyFalseInversionRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaSteadyFalseInversionRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [msaaSteadyFalseInversionRepeatFirst, msaaSteadyFalseInversionRepeatSecond] = msaaSteadyFalseInversionRepeatSnapshots;
const msaaSteadyFalseInversionRepeatNormalDiff = repeatabilityDiff(
  msaaSteadyFalseInversionRepeatFirst.normal.snapshot,
  msaaSteadyFalseInversionRepeatSecond.normal.snapshot,
);
const msaaSteadyFalseInversionRepeatFalsifierDiff = repeatabilityDiff(
  msaaSteadyFalseInversionRepeatFirst.falsifier.snapshot,
  msaaSteadyFalseInversionRepeatSecond.falsifier.snapshot,
);
if (
  msaaSteadyFalseInversionRepeatFirst.normal.result.status !== 0 ||
  !msaaSteadyFalseInversionRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !msaaSteadyFalseInversionRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaSteadyFalseInversionRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=4') ||
  !msaaSteadyFalseInversionRepeatFirst.normal.result.output.includes('resolveTargetCount=1') ||
  !msaaSteadyFalseInversionRepeatFirst.normal.result.output.includes('draws=2') ||
  msaaSteadyFalseInversionRepeatFirst.falsifier.result.status !== 0 ||
  !msaaSteadyFalseInversionRepeatFirst.falsifier.result.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaSteadyFalseInversionRepeatFirst.falsifier.result.output.includes('resolveTargetCount=0') ||
  msaaSteadyFalseInversionRepeatSecond.normal.result.status !== 0 ||
  msaaSteadyFalseInversionRepeatSecond.falsifier.result.status !== 0 ||
  msaaSteadyFalseInversionRepeatNormalDiff !== undefined ||
  msaaSteadyFalseInversionRepeatFalsifierDiff !== undefined ||
  msaaSteadyFalseInversionRepeatFirst.normal.snapshot.capture.selectedVariant !== 'false' ||
  msaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'false' ||
  msaaSteadyFalseInversionRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaSteadyFalseInversionRepeatFirst.normal.snapshot.capture.variantSwitchedAfterPipeline !== false ||
  msaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.capture.variantSwitchedAfterPipeline !== false ||
  msaaSteadyFalseInversionRepeatFirst.normal.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaSteadyFalseInversionRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  msaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== false ||
  msaaSteadyFalseInversionRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaSteadyFalseInversionRepeatFirst.normal.snapshot.rhi.drawCount !== 2 ||
  msaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 0 ||
  msaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.rhi.drawCount !== 2
) {
  console.error(
    `[m3-programmable] custom pipeline MSAA steady false inversion repeatability: FAIL - ${JSON.stringify({ normalStatus: [msaaSteadyFalseInversionRepeatFirst.normal.result.status, msaaSteadyFalseInversionRepeatSecond.normal.result.status], falsifierStatus: [msaaSteadyFalseInversionRepeatFirst.falsifier.result.status, msaaSteadyFalseInversionRepeatSecond.falsifier.result.status], normalDiff: msaaSteadyFalseInversionRepeatNormalDiff, falsifierDiff: msaaSteadyFalseInversionRepeatFalsifierDiff })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline MSAA steady false inversion repeatability: PASS normalSha256=${msaaSteadyFalseInversionRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${msaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${msaaSteadyFalseInversionRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${msaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const noMsaaLivePostResolveRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'no-msaa-live-post-resolve-repeatability');
const noMsaaLivePostResolveRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(noMsaaLivePostResolveRepeatArtifactRoot, pass);
  noMsaaLivePostResolveRepeatRuns.push({
    normal: run(
      `custom pipeline no-MSAA live post resolve repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA live post resolve repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const noMsaaLivePostResolveRepeatSnapshots = noMsaaLivePostResolveRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaLivePostResolveRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaLivePostResolveRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [noMsaaLivePostResolveRepeatFirst, noMsaaLivePostResolveRepeatSecond] = noMsaaLivePostResolveRepeatSnapshots;
const noMsaaLivePostResolveRepeatNormalDiff = repeatabilityDiff(
  noMsaaLivePostResolveRepeatFirst.normal.snapshot,
  noMsaaLivePostResolveRepeatSecond.normal.snapshot,
);
const noMsaaLivePostResolveRepeatFalsifierDiff = repeatabilityDiff(
  noMsaaLivePostResolveRepeatFirst.falsifier.snapshot,
  noMsaaLivePostResolveRepeatSecond.falsifier.snapshot,
);
if (
  noMsaaLivePostResolveRepeatFirst.normal.result.status !== 0 ||
  !noMsaaLivePostResolveRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaLivePostResolveRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaLivePostResolveRepeatFirst.normal.result.output.includes('resolveTargetCount=0') ||
  !noMsaaLivePostResolveRepeatFirst.normal.result.output.includes('draws=2') ||
  !noMsaaLivePostResolveRepeatFirst.normal.result.output.includes('variantSwitch=true') ||
  !noMsaaLivePostResolveRepeatFirst.normal.result.output.includes('postSwitch=true') ||
  noMsaaLivePostResolveRepeatFirst.falsifier.result.status !== 0 ||
  !noMsaaLivePostResolveRepeatFirst.falsifier.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaLivePostResolveRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaLivePostResolveRepeatFirst.falsifier.result.output.includes('resolveTargetCount=0') ||
  !noMsaaLivePostResolveRepeatFirst.falsifier.result.output.includes('draws=2') ||
  !noMsaaLivePostResolveRepeatFirst.falsifier.result.output.includes('variantSwitch=true') ||
  !noMsaaLivePostResolveRepeatFirst.falsifier.result.output.includes('postSwitch=true') ||
  noMsaaLivePostResolveRepeatFirst.falsifier.result.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  noMsaaLivePostResolveRepeatSecond.normal.result.status !== 0 ||
  noMsaaLivePostResolveRepeatSecond.falsifier.result.status !== 0 ||
  noMsaaLivePostResolveRepeatNormalDiff !== undefined ||
  noMsaaLivePostResolveRepeatFalsifierDiff !== undefined ||
  noMsaaLivePostResolveRepeatFirst.normal.snapshot.capture.selectedVariant !== 'true' ||
  noMsaaLivePostResolveRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'true' ||
  noMsaaLivePostResolveRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaLivePostResolveRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaLivePostResolveRepeatFirst.normal.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  noMsaaLivePostResolveRepeatFirst.falsifier.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  noMsaaLivePostResolveRepeatFirst.normal.snapshot.capture.postSwitchedAfterPipeline !== true ||
  noMsaaLivePostResolveRepeatFirst.falsifier.snapshot.capture.postSwitchedAfterPipeline !== true ||
  noMsaaLivePostResolveRepeatFirst.normal.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaLivePostResolveRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaLivePostResolveRepeatFirst.normal.snapshot.rhi.drawCount !== 2 ||
  noMsaaLivePostResolveRepeatFirst.falsifier.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaLivePostResolveRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaLivePostResolveRepeatFirst.falsifier.snapshot.rhi.drawCount !== 2
) {
  console.error(
    `[m3-programmable] custom pipeline no-MSAA live post resolve repeatability: FAIL - ${JSON.stringify({ normalStatus: [noMsaaLivePostResolveRepeatFirst.normal.result.status, noMsaaLivePostResolveRepeatSecond.normal.result.status], falsifierStatus: [noMsaaLivePostResolveRepeatFirst.falsifier.result.status, noMsaaLivePostResolveRepeatSecond.falsifier.result.status], normalDiff: noMsaaLivePostResolveRepeatNormalDiff, falsifierDiff: noMsaaLivePostResolveRepeatFalsifierDiff })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] custom pipeline no-MSAA live post resolve repeatability: PASS normalSha256=${noMsaaLivePostResolveRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${noMsaaLivePostResolveRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${noMsaaLivePostResolveRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${noMsaaLivePostResolveRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const noMsaaLivePostDoubleResizeRepeatArtifactRoot = resolve(
  customRhiArtifactRoot,
  'no-msaa-live-post-double-resize-repeatability',
);
const noMsaaLivePostDoubleResizeRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, pass);
  noMsaaLivePostDoubleResizeRepeatRuns.push({
    normal: run(
      `custom pipeline no-MSAA live post double resize repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA live post double resize repeat ${pass} adjacent pipeline falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const noMsaaLivePostDoubleResizeRepeatFirst = noMsaaLivePostDoubleResizeRepeatRuns[0];
const noMsaaLivePostDoubleResizeRepeatSecond = noMsaaLivePostDoubleResizeRepeatRuns[1];
const noMsaaLivePostDoubleResizeRepeatFirstNormalSnapshot = readRepeatabilitySnapshot(
  resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'normal'),
);
const noMsaaLivePostDoubleResizeRepeatSecondNormalSnapshot = readRepeatabilitySnapshot(
  resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'normal'),
);
const noMsaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot = readRepeatabilitySnapshot(
  resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'falsifier'),
);
const noMsaaLivePostDoubleResizeRepeatSecondFalsifierSnapshot = readRepeatabilitySnapshot(
  resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'falsifier'),
);
const noMsaaLivePostDoubleResizeRepeatNormalDiff = repeatabilityDiff(
  noMsaaLivePostDoubleResizeRepeatFirstNormalSnapshot,
  noMsaaLivePostDoubleResizeRepeatSecondNormalSnapshot,
);
const noMsaaLivePostDoubleResizeRepeatFalsifierDiff = repeatabilityDiff(
  noMsaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot,
  noMsaaLivePostDoubleResizeRepeatSecondFalsifierSnapshot,
);
let noMsaaLivePostDoubleResizeRepeatFirstPngDelta;
let noMsaaLivePostDoubleResizeRepeatSecondPngDelta;
let noMsaaLivePostDoubleResizeRepeatFirstDawnDelta;
let noMsaaLivePostDoubleResizeRepeatSecondDawnDelta;
try {
  noMsaaLivePostDoubleResizeRepeatFirstPngDelta = comparePngs(
    resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'normal', 'custom-live.png'),
    resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'falsifier', 'custom-live.png'),
  );
  noMsaaLivePostDoubleResizeRepeatSecondPngDelta = comparePngs(
    resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'normal', 'custom-live.png'),
    resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'falsifier', 'custom-live.png'),
  );
  noMsaaLivePostDoubleResizeRepeatFirstDawnDelta = compareDawnReadbacks(
    resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'normal', 'dawn-readback.rgba'),
    resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'normal', 'dawn-readback.json'),
    resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'falsifier', 'dawn-readback.rgba'),
    resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'falsifier', 'dawn-readback.json'),
  );
  noMsaaLivePostDoubleResizeRepeatSecondDawnDelta = compareDawnReadbacks(
    resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'normal', 'dawn-readback.rgba'),
    resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'normal', 'dawn-readback.json'),
    resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'falsifier', 'dawn-readback.rgba'),
    resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] no-MSAA live post double resize repeatability delta: FAIL - ${error}`);
  process.exit(1);
}
const noMsaaLivePostDoubleResizeExpectedHistory = [
  '640x360',
  '480x270',
  '720x405',
  '640x360',
  '480x270',
  '720x405',
  '640x360',
].join('>');
if (
  noMsaaLivePostDoubleResizeRepeatFirst.normal.status !== 0 ||
  noMsaaLivePostDoubleResizeRepeatFirst.falsifier.status !== 0 ||
  noMsaaLivePostDoubleResizeRepeatSecond.normal.status !== 0 ||
  noMsaaLivePostDoubleResizeRepeatSecond.falsifier.status !== 0 ||
  noMsaaLivePostDoubleResizeRepeatFirstNormalSnapshot.capture.post !== 'M3_POST_EFFECT=inversion' ||
  noMsaaLivePostDoubleResizeRepeatFirstNormalSnapshot.capture.antialias !== 'M3_ANTIALIAS=none' ||
  noMsaaLivePostDoubleResizeRepeatFirstNormalSnapshot.capture.selectedVariant !== 'true' ||
  noMsaaLivePostDoubleResizeRepeatFirstNormalSnapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaLivePostDoubleResizeRepeatFirstNormalSnapshot.capture.variantSwitchedAfterPipeline !== true ||
  noMsaaLivePostDoubleResizeRepeatFirstNormalSnapshot.capture.postSwitchedAfterPipeline !== true ||
  noMsaaLivePostDoubleResizeRepeatFirstNormalSnapshot.capture.falsifyPipeline !== false ||
  noMsaaLivePostDoubleResizeRepeatFirstNormalSnapshot.capture.resizeHistory.join('>') !== noMsaaLivePostDoubleResizeExpectedHistory ||
  noMsaaLivePostDoubleResizeRepeatFirstNormalSnapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaLivePostDoubleResizeRepeatFirstNormalSnapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaLivePostDoubleResizeRepeatFirstNormalSnapshot.rhi.drawCount !== 2 ||
  noMsaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.capture.post !== 'M3_POST_EFFECT=inversion' ||
  noMsaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.capture.antialias !== 'M3_ANTIALIAS=none' ||
  noMsaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.capture.selectedVariant !== 'true' ||
  noMsaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.capture.variantSwitchedAfterPipeline !== true ||
  noMsaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.capture.postSwitchedAfterPipeline !== true ||
  noMsaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.capture.falsifyPipeline !== true ||
  noMsaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.capture.resizeHistory.join('>') !== noMsaaLivePostDoubleResizeExpectedHistory ||
  noMsaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.rhi.drawCount !== 1 ||
  noMsaaLivePostDoubleResizeRepeatNormalDiff !== undefined ||
  noMsaaLivePostDoubleResizeRepeatFalsifierDiff !== undefined ||
  noMsaaLivePostDoubleResizeRepeatFirstPngDelta.changedPixels === 0 ||
  noMsaaLivePostDoubleResizeRepeatFirstPngDelta.meanRgbDelta <= 0.01 ||
  noMsaaLivePostDoubleResizeRepeatSecondPngDelta.changedPixels === 0 ||
  noMsaaLivePostDoubleResizeRepeatSecondPngDelta.meanRgbDelta <= 0.01 ||
  noMsaaLivePostDoubleResizeRepeatFirstDawnDelta.changedPixels === 0 ||
  noMsaaLivePostDoubleResizeRepeatFirstDawnDelta.meanRgbDelta <= 0.01 ||
  noMsaaLivePostDoubleResizeRepeatSecondDawnDelta.changedPixels === 0 ||
  noMsaaLivePostDoubleResizeRepeatSecondDawnDelta.meanRgbDelta <= 0.01
) {
  console.error(
    `[m3-programmable] no-MSAA live post double resize repeatability: FAIL - ${JSON.stringify({ statuses: { firstNormal: noMsaaLivePostDoubleResizeRepeatFirst.normal.status, firstFalsifier: noMsaaLivePostDoubleResizeRepeatFirst.falsifier.status, secondNormal: noMsaaLivePostDoubleResizeRepeatSecond.normal.status, secondFalsifier: noMsaaLivePostDoubleResizeRepeatSecond.falsifier.status }, normalDiff: noMsaaLivePostDoubleResizeRepeatNormalDiff, falsifierDiff: noMsaaLivePostDoubleResizeRepeatFalsifierDiff, firstPng: noMsaaLivePostDoubleResizeRepeatFirstPngDelta, secondPng: noMsaaLivePostDoubleResizeRepeatSecondPngDelta, firstDawn: noMsaaLivePostDoubleResizeRepeatFirstDawnDelta, secondDawn: noMsaaLivePostDoubleResizeRepeatSecondDawnDelta })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] no-MSAA live post double resize repeatability: PASS normalSha256=${noMsaaLivePostDoubleResizeRepeatFirstDawnDelta.normalSha256} falsifierSha256=${noMsaaLivePostDoubleResizeRepeatFirstDawnDelta.falsifierSha256} dawnChangedPixels=${noMsaaLivePostDoubleResizeRepeatFirstDawnDelta.changedPixels} pngChangedPixels=${noMsaaLivePostDoubleResizeRepeatFirstPngDelta.changedPixels}`,
);

const noMsaaFalseVariantLivePostDoubleResizeArtifactRoot = resolve(
  customRhiArtifactRoot,
  'no-msaa-live-post-false-variant-double-resize-repeatability',
);
const noMsaaFalseVariantLivePostDoubleResizeRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, pass);
  noMsaaFalseVariantLivePostDoubleResizeRuns.push({
    normal: run(
      `custom pipeline no-MSAA false-variant live post double resize repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA false-variant live post double resize repeat ${pass} adjacent pipeline falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const noMsaaFalseVariantLivePostDoubleResizeFirst = noMsaaFalseVariantLivePostDoubleResizeRuns[0];
const noMsaaFalseVariantLivePostDoubleResizeSecond = noMsaaFalseVariantLivePostDoubleResizeRuns[1];
const noMsaaFalseVariantLivePostDoubleResizeFirstNormalSnapshot = readRepeatabilitySnapshot(
  resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'first', 'normal'),
);
const noMsaaFalseVariantLivePostDoubleResizeSecondNormalSnapshot = readRepeatabilitySnapshot(
  resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'second', 'normal'),
);
const noMsaaFalseVariantLivePostDoubleResizeFirstFalsifierSnapshot = readRepeatabilitySnapshot(
  resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'first', 'falsifier'),
);
const noMsaaFalseVariantLivePostDoubleResizeSecondFalsifierSnapshot = readRepeatabilitySnapshot(
  resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'second', 'falsifier'),
);
const noMsaaFalseVariantLivePostDoubleResizeNormalDiff = repeatabilityDiff(
  noMsaaFalseVariantLivePostDoubleResizeFirstNormalSnapshot,
  noMsaaFalseVariantLivePostDoubleResizeSecondNormalSnapshot,
);
const noMsaaFalseVariantLivePostDoubleResizeFalsifierDiff = repeatabilityDiff(
  noMsaaFalseVariantLivePostDoubleResizeFirstFalsifierSnapshot,
  noMsaaFalseVariantLivePostDoubleResizeSecondFalsifierSnapshot,
);
let noMsaaFalseVariantLivePostDoubleResizeFirstPngDelta;
let noMsaaFalseVariantLivePostDoubleResizeSecondPngDelta;
let noMsaaFalseVariantLivePostDoubleResizeFirstDawnDelta;
let noMsaaFalseVariantLivePostDoubleResizeSecondDawnDelta;
try {
  noMsaaFalseVariantLivePostDoubleResizeFirstPngDelta = comparePngs(
    resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'first', 'normal', 'custom-live.png'),
    resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'first', 'falsifier', 'custom-live.png'),
  );
  noMsaaFalseVariantLivePostDoubleResizeSecondPngDelta = comparePngs(
    resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'second', 'normal', 'custom-live.png'),
    resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'second', 'falsifier', 'custom-live.png'),
  );
  noMsaaFalseVariantLivePostDoubleResizeFirstDawnDelta = compareDawnReadbacks(
    resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'first', 'normal', 'dawn-readback.rgba'),
    resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'first', 'normal', 'dawn-readback.json'),
    resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'first', 'falsifier', 'dawn-readback.rgba'),
    resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'first', 'falsifier', 'dawn-readback.json'),
  );
  noMsaaFalseVariantLivePostDoubleResizeSecondDawnDelta = compareDawnReadbacks(
    resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'second', 'normal', 'dawn-readback.rgba'),
    resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'second', 'normal', 'dawn-readback.json'),
    resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'second', 'falsifier', 'dawn-readback.rgba'),
    resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'second', 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] no-MSAA false-variant live post double resize repeatability delta: FAIL - ${error}`);
  process.exit(1);
}
const noMsaaFalseVariantLivePostDoubleResizeExpectedHistory =
  '640x360>480x270>720x405>640x360>480x270>720x405>640x360';
const noMsaaFalseVariantLivePostDoubleResizeNormalCapture =
  noMsaaFalseVariantLivePostDoubleResizeFirstNormalSnapshot.capture;
const noMsaaFalseVariantLivePostDoubleResizeFalsifierCapture =
  noMsaaFalseVariantLivePostDoubleResizeFirstFalsifierSnapshot.capture;
if (
  noMsaaFalseVariantLivePostDoubleResizeFirst.normal.status !== 0 ||
  noMsaaFalseVariantLivePostDoubleResizeFirst.falsifier.status !== 0 ||
  noMsaaFalseVariantLivePostDoubleResizeSecond.normal.status !== 0 ||
  noMsaaFalseVariantLivePostDoubleResizeSecond.falsifier.status !== 0 ||
  noMsaaFalseVariantLivePostDoubleResizeNormalCapture.variant !== 'M3_MULTI_UV_VARIANT=true' ||
  noMsaaFalseVariantLivePostDoubleResizeNormalCapture.post !== 'M3_POST_EFFECT=inversion' ||
  noMsaaFalseVariantLivePostDoubleResizeNormalCapture.selectedVariant !== 'false' ||
  noMsaaFalseVariantLivePostDoubleResizeNormalCapture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaFalseVariantLivePostDoubleResizeNormalCapture.antialias !== 'M3_ANTIALIAS=none' ||
  noMsaaFalseVariantLivePostDoubleResizeNormalCapture.variantSwitchedAfterPipeline !== true ||
  noMsaaFalseVariantLivePostDoubleResizeNormalCapture.postSwitchedAfterPipeline !== true ||
  noMsaaFalseVariantLivePostDoubleResizeNormalCapture.falsifyPipeline !== false ||
  noMsaaFalseVariantLivePostDoubleResizeNormalCapture.resizeHistory.join('>') !== noMsaaFalseVariantLivePostDoubleResizeExpectedHistory ||
  noMsaaFalseVariantLivePostDoubleResizeFirstNormalSnapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaFalseVariantLivePostDoubleResizeFirstNormalSnapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaFalseVariantLivePostDoubleResizeFirstNormalSnapshot.rhi.drawCount !== 2 ||
  noMsaaFalseVariantLivePostDoubleResizeFalsifierCapture.variant !== 'M3_MULTI_UV_VARIANT=true' ||
  noMsaaFalseVariantLivePostDoubleResizeFalsifierCapture.post !== 'M3_POST_EFFECT=inversion' ||
  noMsaaFalseVariantLivePostDoubleResizeFalsifierCapture.selectedVariant !== 'false' ||
  noMsaaFalseVariantLivePostDoubleResizeFalsifierCapture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaFalseVariantLivePostDoubleResizeFalsifierCapture.antialias !== 'M3_ANTIALIAS=none' ||
  noMsaaFalseVariantLivePostDoubleResizeFalsifierCapture.variantSwitchedAfterPipeline !== true ||
  noMsaaFalseVariantLivePostDoubleResizeFalsifierCapture.postSwitchedAfterPipeline !== true ||
  noMsaaFalseVariantLivePostDoubleResizeFalsifierCapture.falsifyPipeline !== true ||
  noMsaaFalseVariantLivePostDoubleResizeFalsifierCapture.resizeHistory.join('>') !== noMsaaFalseVariantLivePostDoubleResizeExpectedHistory ||
  noMsaaFalseVariantLivePostDoubleResizeFirstFalsifierSnapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaFalseVariantLivePostDoubleResizeFirstFalsifierSnapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaFalseVariantLivePostDoubleResizeFirstFalsifierSnapshot.rhi.drawCount !== 1 ||
  noMsaaFalseVariantLivePostDoubleResizeNormalDiff !== undefined ||
  noMsaaFalseVariantLivePostDoubleResizeFalsifierDiff !== undefined ||
  noMsaaFalseVariantLivePostDoubleResizeFirstPngDelta.changedPixels === 0 ||
  noMsaaFalseVariantLivePostDoubleResizeFirstPngDelta.meanRgbDelta <= 0.01 ||
  noMsaaFalseVariantLivePostDoubleResizeSecondPngDelta.changedPixels === 0 ||
  noMsaaFalseVariantLivePostDoubleResizeSecondPngDelta.meanRgbDelta <= 0.01 ||
  noMsaaFalseVariantLivePostDoubleResizeFirstDawnDelta.changedPixels === 0 ||
  noMsaaFalseVariantLivePostDoubleResizeFirstDawnDelta.meanRgbDelta <= 0.01 ||
  noMsaaFalseVariantLivePostDoubleResizeSecondDawnDelta.changedPixels === 0 ||
  noMsaaFalseVariantLivePostDoubleResizeSecondDawnDelta.meanRgbDelta <= 0.01
) {
  console.error(
    `[m3-programmable] no-MSAA false-variant live post double resize repeatability: FAIL - ${JSON.stringify({ statuses: { firstNormal: noMsaaFalseVariantLivePostDoubleResizeFirst.normal.status, firstFalsifier: noMsaaFalseVariantLivePostDoubleResizeFirst.falsifier.status, secondNormal: noMsaaFalseVariantLivePostDoubleResizeSecond.normal.status, secondFalsifier: noMsaaFalseVariantLivePostDoubleResizeSecond.falsifier.status }, normalDiff: noMsaaFalseVariantLivePostDoubleResizeNormalDiff, falsifierDiff: noMsaaFalseVariantLivePostDoubleResizeFalsifierDiff, firstPng: noMsaaFalseVariantLivePostDoubleResizeFirstPngDelta, secondPng: noMsaaFalseVariantLivePostDoubleResizeSecondPngDelta, firstDawn: noMsaaFalseVariantLivePostDoubleResizeFirstDawnDelta, secondDawn: noMsaaFalseVariantLivePostDoubleResizeSecondDawnDelta })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] no-MSAA false-variant live post double resize repeatability: PASS normalSha256=${noMsaaFalseVariantLivePostDoubleResizeFirstDawnDelta.normalSha256} falsifierSha256=${noMsaaFalseVariantLivePostDoubleResizeFirstDawnDelta.falsifierSha256} dawnChangedPixels=${noMsaaFalseVariantLivePostDoubleResizeFirstDawnDelta.changedPixels} pngChangedPixels=${noMsaaFalseVariantLivePostDoubleResizeFirstPngDelta.changedPixels}`,
);

const msaaFalseStartLivePostDoubleResizeArtifactRoot = resolve(
  customRhiArtifactRoot,
  'msaa-live-post-false-start-double-resize-repeatability',
);
const msaaFalseStartLivePostDoubleResizeRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, pass);
  msaaFalseStartLivePostDoubleResizeRuns.push({
    normal: run(
      `custom pipeline MSAA false-start live post double resize repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA false-start live post double resize repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaFalseStartLivePostDoubleResizeFirst = msaaFalseStartLivePostDoubleResizeRuns[0];
const msaaFalseStartLivePostDoubleResizeSecond = msaaFalseStartLivePostDoubleResizeRuns[1];
const msaaFalseStartLivePostDoubleResizeFirstNormalSnapshot = readRepeatabilitySnapshot(
  resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'first', 'normal'),
);
const msaaFalseStartLivePostDoubleResizeSecondNormalSnapshot = readRepeatabilitySnapshot(
  resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'second', 'normal'),
);
const msaaFalseStartLivePostDoubleResizeFirstFalsifierSnapshot = readRepeatabilitySnapshot(
  resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'first', 'falsifier'),
);
const msaaFalseStartLivePostDoubleResizeSecondFalsifierSnapshot = readRepeatabilitySnapshot(
  resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'second', 'falsifier'),
);
const msaaFalseStartLivePostDoubleResizeNormalDiff = repeatabilityDiff(
  msaaFalseStartLivePostDoubleResizeFirstNormalSnapshot,
  msaaFalseStartLivePostDoubleResizeSecondNormalSnapshot,
);
const msaaFalseStartLivePostDoubleResizeFalsifierDiff = repeatabilityDiff(
  msaaFalseStartLivePostDoubleResizeFirstFalsifierSnapshot,
  msaaFalseStartLivePostDoubleResizeSecondFalsifierSnapshot,
);
let msaaFalseStartLivePostDoubleResizeFirstPngDelta;
let msaaFalseStartLivePostDoubleResizeSecondPngDelta;
let msaaFalseStartLivePostDoubleResizeFirstDawnDelta;
let msaaFalseStartLivePostDoubleResizeSecondDawnDelta;
try {
  msaaFalseStartLivePostDoubleResizeFirstPngDelta = comparePngs(
    resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'first', 'normal', 'custom-live.png'),
    resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'first', 'falsifier', 'custom-live.png'),
  );
  msaaFalseStartLivePostDoubleResizeSecondPngDelta = comparePngs(
    resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'second', 'normal', 'custom-live.png'),
    resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'second', 'falsifier', 'custom-live.png'),
  );
  msaaFalseStartLivePostDoubleResizeFirstDawnDelta = compareDawnReadbacks(
    resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'first', 'normal', 'dawn-readback.rgba'),
    resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'first', 'normal', 'dawn-readback.json'),
    resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'first', 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'first', 'falsifier', 'dawn-readback.json'),
  );
  msaaFalseStartLivePostDoubleResizeSecondDawnDelta = compareDawnReadbacks(
    resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'second', 'normal', 'dawn-readback.rgba'),
    resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'second', 'normal', 'dawn-readback.json'),
    resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'second', 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'second', 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] MSAA false-start live post double resize repeatability delta: FAIL - ${error}`);
  process.exit(1);
}
const msaaFalseStartLivePostDoubleResizeExpectedHistory =
  '640x360>480x270>720x405>640x360>480x270>720x405>640x360';
const msaaFalseStartLivePostDoubleResizeNormalCapture =
  msaaFalseStartLivePostDoubleResizeFirstNormalSnapshot.capture;
const msaaFalseStartLivePostDoubleResizeFalsifierCapture =
  msaaFalseStartLivePostDoubleResizeFirstFalsifierSnapshot.capture;
if (
  msaaFalseStartLivePostDoubleResizeFirst.normal.status !== 0 ||
  msaaFalseStartLivePostDoubleResizeFirst.falsifier.status !== 0 ||
  msaaFalseStartLivePostDoubleResizeSecond.normal.status !== 0 ||
  msaaFalseStartLivePostDoubleResizeSecond.falsifier.status !== 0 ||
  msaaFalseStartLivePostDoubleResizeNormalCapture.variant !== 'M3_MULTI_UV_VARIANT=true' ||
  msaaFalseStartLivePostDoubleResizeNormalCapture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaFalseStartLivePostDoubleResizeNormalCapture.selectedVariant !== 'false' ||
  msaaFalseStartLivePostDoubleResizeNormalCapture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaFalseStartLivePostDoubleResizeNormalCapture.antialias !== 'M3_ANTIALIAS=msaa' ||
  msaaFalseStartLivePostDoubleResizeNormalCapture.variantSwitchedAfterPipeline !== true ||
  msaaFalseStartLivePostDoubleResizeNormalCapture.postSwitchedAfterPipeline !== true ||
  msaaFalseStartLivePostDoubleResizeNormalCapture.falsifyPipeline !== false ||
  msaaFalseStartLivePostDoubleResizeNormalCapture.resizeHistory.join('>') !== msaaFalseStartLivePostDoubleResizeExpectedHistory ||
  msaaFalseStartLivePostDoubleResizeFirstNormalSnapshot.rhi.msaaTextureResourceCount !== 4 ||
  msaaFalseStartLivePostDoubleResizeFirstNormalSnapshot.rhi.resolveTargetCount !== 1 ||
  msaaFalseStartLivePostDoubleResizeFirstNormalSnapshot.rhi.drawCount !== 2 ||
  msaaFalseStartLivePostDoubleResizeFalsifierCapture.variant !== 'M3_MULTI_UV_VARIANT=true' ||
  msaaFalseStartLivePostDoubleResizeFalsifierCapture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaFalseStartLivePostDoubleResizeFalsifierCapture.selectedVariant !== 'false' ||
  msaaFalseStartLivePostDoubleResizeFalsifierCapture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaFalseStartLivePostDoubleResizeFalsifierCapture.antialias !== 'M3_ANTIALIAS=msaa' ||
  msaaFalseStartLivePostDoubleResizeFalsifierCapture.variantSwitchedAfterPipeline !== true ||
  msaaFalseStartLivePostDoubleResizeFalsifierCapture.postSwitchedAfterPipeline !== true ||
  msaaFalseStartLivePostDoubleResizeFalsifierCapture.falsifyPipeline !== false ||
  msaaFalseStartLivePostDoubleResizeFalsifierCapture.resizeHistory.join('>') !== msaaFalseStartLivePostDoubleResizeExpectedHistory ||
  msaaFalseStartLivePostDoubleResizeFirstFalsifierSnapshot.rhi.msaaTextureResourceCount !== 4 ||
  msaaFalseStartLivePostDoubleResizeFirstFalsifierSnapshot.rhi.resolveTargetCount !== 0 ||
  msaaFalseStartLivePostDoubleResizeFirstFalsifierSnapshot.rhi.drawCount !== 2 ||
  msaaFalseStartLivePostDoubleResizeNormalDiff !== undefined ||
  msaaFalseStartLivePostDoubleResizeFalsifierDiff !== undefined ||
  msaaFalseStartLivePostDoubleResizeFirstPngDelta.changedPixels === 0 ||
  msaaFalseStartLivePostDoubleResizeFirstPngDelta.meanRgbDelta <= 0.01 ||
  msaaFalseStartLivePostDoubleResizeSecondPngDelta.changedPixels === 0 ||
  msaaFalseStartLivePostDoubleResizeSecondPngDelta.meanRgbDelta <= 0.01 ||
  msaaFalseStartLivePostDoubleResizeFirstDawnDelta.changedPixels === 0 ||
  msaaFalseStartLivePostDoubleResizeFirstDawnDelta.meanRgbDelta <= 0.01 ||
  msaaFalseStartLivePostDoubleResizeSecondDawnDelta.changedPixels === 0 ||
  msaaFalseStartLivePostDoubleResizeSecondDawnDelta.meanRgbDelta <= 0.01
) {
  console.error(
    `[m3-programmable] MSAA false-start live post double resize repeatability: FAIL - ${JSON.stringify({ statuses: { firstNormal: msaaFalseStartLivePostDoubleResizeFirst.normal.status, firstFalsifier: msaaFalseStartLivePostDoubleResizeFirst.falsifier.status, secondNormal: msaaFalseStartLivePostDoubleResizeSecond.normal.status, secondFalsifier: msaaFalseStartLivePostDoubleResizeSecond.falsifier.status }, normalDiff: msaaFalseStartLivePostDoubleResizeNormalDiff, falsifierDiff: msaaFalseStartLivePostDoubleResizeFalsifierDiff, firstPng: msaaFalseStartLivePostDoubleResizeFirstPngDelta, secondPng: msaaFalseStartLivePostDoubleResizeSecondPngDelta, firstDawn: msaaFalseStartLivePostDoubleResizeFirstDawnDelta, secondDawn: msaaFalseStartLivePostDoubleResizeSecondDawnDelta })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] MSAA false-start live post double resize repeatability: PASS normalSha256=${msaaFalseStartLivePostDoubleResizeFirstDawnDelta.normalSha256} falsifierSha256=${msaaFalseStartLivePostDoubleResizeFirstDawnDelta.falsifierSha256} dawnChangedPixels=${msaaFalseStartLivePostDoubleResizeFirstDawnDelta.changedPixels} pngChangedPixels=${msaaFalseStartLivePostDoubleResizeFirstPngDelta.changedPixels}`,
);

const msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot = resolve(
  customRhiArtifactRoot,
  'msaa-live-post-false-start-pipeline-double-resize-repeatability',
);
const msaaFalseStartLivePostPipelineDoubleResizeRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, pass);
  msaaFalseStartLivePostPipelineDoubleResizeRuns.push({
    normal: run(
      `custom pipeline MSAA false-start live post adjacent pipeline double resize repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA false-start live post adjacent pipeline double resize repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaFalseStartLivePostPipelineDoubleResizeFirst =
  msaaFalseStartLivePostPipelineDoubleResizeRuns[0];
const msaaFalseStartLivePostPipelineDoubleResizeSecond =
  msaaFalseStartLivePostPipelineDoubleResizeRuns[1];
const msaaFalseStartLivePostPipelineDoubleResizeFirstNormalSnapshot = readRepeatabilitySnapshot(
  resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'first', 'normal'),
);
const msaaFalseStartLivePostPipelineDoubleResizeSecondNormalSnapshot = readRepeatabilitySnapshot(
  resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'second', 'normal'),
);
const msaaFalseStartLivePostPipelineDoubleResizeFirstFalsifierSnapshot = readRepeatabilitySnapshot(
  resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'first', 'falsifier'),
);
const msaaFalseStartLivePostPipelineDoubleResizeSecondFalsifierSnapshot = readRepeatabilitySnapshot(
  resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'second', 'falsifier'),
);
const msaaFalseStartLivePostPipelineDoubleResizeNormalDiff = repeatabilityDiff(
  msaaFalseStartLivePostPipelineDoubleResizeFirstNormalSnapshot,
  msaaFalseStartLivePostPipelineDoubleResizeSecondNormalSnapshot,
);
const msaaFalseStartLivePostPipelineDoubleResizeFalsifierDiff = repeatabilityDiff(
  msaaFalseStartLivePostPipelineDoubleResizeFirstFalsifierSnapshot,
  msaaFalseStartLivePostPipelineDoubleResizeSecondFalsifierSnapshot,
);
let msaaFalseStartLivePostPipelineDoubleResizeFirstPngDelta;
let msaaFalseStartLivePostPipelineDoubleResizeSecondPngDelta;
let msaaFalseStartLivePostPipelineDoubleResizeFirstDawnDelta;
let msaaFalseStartLivePostPipelineDoubleResizeSecondDawnDelta;
try {
  msaaFalseStartLivePostPipelineDoubleResizeFirstPngDelta = comparePngs(
    resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'first', 'normal', 'custom-live.png'),
    resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'first', 'falsifier', 'custom-live.png'),
  );
  msaaFalseStartLivePostPipelineDoubleResizeSecondPngDelta = comparePngs(
    resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'second', 'normal', 'custom-live.png'),
    resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'second', 'falsifier', 'custom-live.png'),
  );
  msaaFalseStartLivePostPipelineDoubleResizeFirstDawnDelta = compareDawnReadbacks(
    resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'first', 'normal', 'dawn-readback.rgba'),
    resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'first', 'normal', 'dawn-readback.json'),
    resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'first', 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'first', 'falsifier', 'dawn-readback.json'),
  );
  msaaFalseStartLivePostPipelineDoubleResizeSecondDawnDelta = compareDawnReadbacks(
    resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'second', 'normal', 'dawn-readback.rgba'),
    resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'second', 'normal', 'dawn-readback.json'),
    resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'second', 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'second', 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] MSAA false-start live post adjacent pipeline double resize delta: FAIL - ${error}`);
  process.exit(1);
}
const msaaFalseStartLivePostPipelineDoubleResizeExpectedHistory =
  '640x360>480x270>720x405>640x360>480x270>720x405>640x360';
const msaaFalseStartLivePostPipelineDoubleResizeNormalCapture =
  msaaFalseStartLivePostPipelineDoubleResizeFirstNormalSnapshot.capture;
const msaaFalseStartLivePostPipelineDoubleResizeFalsifierCapture =
  msaaFalseStartLivePostPipelineDoubleResizeFirstFalsifierSnapshot.capture;
if (
  msaaFalseStartLivePostPipelineDoubleResizeFirst.normal.status !== 0 ||
  msaaFalseStartLivePostPipelineDoubleResizeFirst.falsifier.status !== 0 ||
  msaaFalseStartLivePostPipelineDoubleResizeSecond.normal.status !== 0 ||
  msaaFalseStartLivePostPipelineDoubleResizeSecond.falsifier.status !== 0 ||
  msaaFalseStartLivePostPipelineDoubleResizeNormalCapture.variant !== 'M3_MULTI_UV_VARIANT=true' ||
  msaaFalseStartLivePostPipelineDoubleResizeNormalCapture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaFalseStartLivePostPipelineDoubleResizeNormalCapture.selectedVariant !== 'false' ||
  msaaFalseStartLivePostPipelineDoubleResizeNormalCapture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaFalseStartLivePostPipelineDoubleResizeNormalCapture.antialias !== 'M3_ANTIALIAS=msaa' ||
  msaaFalseStartLivePostPipelineDoubleResizeNormalCapture.variantSwitchedAfterPipeline !== true ||
  msaaFalseStartLivePostPipelineDoubleResizeNormalCapture.postSwitchedAfterPipeline !== true ||
  msaaFalseStartLivePostPipelineDoubleResizeNormalCapture.falsifyPipeline !== false ||
  msaaFalseStartLivePostPipelineDoubleResizeNormalCapture.resizeHistory.join('>') !==
    msaaFalseStartLivePostPipelineDoubleResizeExpectedHistory ||
  msaaFalseStartLivePostPipelineDoubleResizeFirstNormalSnapshot.rhi.msaaTextureResourceCount !== 4 ||
  msaaFalseStartLivePostPipelineDoubleResizeFirstNormalSnapshot.rhi.resolveTargetCount !== 1 ||
  msaaFalseStartLivePostPipelineDoubleResizeFirstNormalSnapshot.rhi.drawCount !== 2 ||
  msaaFalseStartLivePostPipelineDoubleResizeFalsifierCapture.variant !== 'M3_MULTI_UV_VARIANT=true' ||
  msaaFalseStartLivePostPipelineDoubleResizeFalsifierCapture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaFalseStartLivePostPipelineDoubleResizeFalsifierCapture.selectedVariant !== 'false' ||
  msaaFalseStartLivePostPipelineDoubleResizeFalsifierCapture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaFalseStartLivePostPipelineDoubleResizeFalsifierCapture.antialias !== 'M3_ANTIALIAS=msaa' ||
  msaaFalseStartLivePostPipelineDoubleResizeFalsifierCapture.variantSwitchedAfterPipeline !== true ||
  msaaFalseStartLivePostPipelineDoubleResizeFalsifierCapture.postSwitchedAfterPipeline !== true ||
  msaaFalseStartLivePostPipelineDoubleResizeFalsifierCapture.falsifyPipeline !== true ||
  msaaFalseStartLivePostPipelineDoubleResizeFalsifierCapture.resizeHistory.join('>') !==
    msaaFalseStartLivePostPipelineDoubleResizeExpectedHistory ||
  msaaFalseStartLivePostPipelineDoubleResizeFirstFalsifierSnapshot.rhi.msaaTextureResourceCount !== 2 ||
  msaaFalseStartLivePostPipelineDoubleResizeFirstFalsifierSnapshot.rhi.resolveTargetCount !== 1 ||
  msaaFalseStartLivePostPipelineDoubleResizeFirstFalsifierSnapshot.rhi.drawCount !== 1 ||
  msaaFalseStartLivePostPipelineDoubleResizeNormalDiff !== undefined ||
  msaaFalseStartLivePostPipelineDoubleResizeFalsifierDiff !== undefined ||
  msaaFalseStartLivePostPipelineDoubleResizeFirstPngDelta.changedPixels === 0 ||
  msaaFalseStartLivePostPipelineDoubleResizeFirstPngDelta.meanRgbDelta <= 0.01 ||
  msaaFalseStartLivePostPipelineDoubleResizeSecondPngDelta.changedPixels === 0 ||
  msaaFalseStartLivePostPipelineDoubleResizeSecondPngDelta.meanRgbDelta <= 0.01 ||
  msaaFalseStartLivePostPipelineDoubleResizeFirstDawnDelta.changedPixels === 0 ||
  msaaFalseStartLivePostPipelineDoubleResizeFirstDawnDelta.meanRgbDelta <= 0.01 ||
  msaaFalseStartLivePostPipelineDoubleResizeSecondDawnDelta.changedPixels === 0 ||
  msaaFalseStartLivePostPipelineDoubleResizeSecondDawnDelta.meanRgbDelta <= 0.01
) {
  console.error(
    `[m3-programmable] MSAA false-start live post adjacent pipeline double resize repeatability: FAIL - ${JSON.stringify({ statuses: { firstNormal: msaaFalseStartLivePostPipelineDoubleResizeFirst.normal.status, firstFalsifier: msaaFalseStartLivePostPipelineDoubleResizeFirst.falsifier.status, secondNormal: msaaFalseStartLivePostPipelineDoubleResizeSecond.normal.status, secondFalsifier: msaaFalseStartLivePostPipelineDoubleResizeSecond.falsifier.status }, normalDiff: msaaFalseStartLivePostPipelineDoubleResizeNormalDiff, falsifierDiff: msaaFalseStartLivePostPipelineDoubleResizeFalsifierDiff, firstPng: msaaFalseStartLivePostPipelineDoubleResizeFirstPngDelta, secondPng: msaaFalseStartLivePostPipelineDoubleResizeSecondPngDelta, firstDawn: msaaFalseStartLivePostPipelineDoubleResizeFirstDawnDelta, secondDawn: msaaFalseStartLivePostPipelineDoubleResizeSecondDawnDelta })}`,
  );
  process.exit(1);
}
console.log(
  `[m3-programmable] MSAA false-start live post adjacent pipeline double resize repeatability: PASS normalSha256=${msaaFalseStartLivePostPipelineDoubleResizeFirstDawnDelta.normalSha256} falsifierSha256=${msaaFalseStartLivePostPipelineDoubleResizeFirstDawnDelta.falsifierSha256} dawnChangedPixels=${msaaFalseStartLivePostPipelineDoubleResizeFirstDawnDelta.changedPixels} pngChangedPixels=${msaaFalseStartLivePostPipelineDoubleResizeFirstPngDelta.changedPixels}`,
);

const liveVariantArtifactRoot = resolve(customRhiArtifactRoot, 'live-variant-switch');
const liveVariant = run(
  'custom pipeline live variant switch',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(liveVariantArtifactRoot, 'normal'),
  },
);
const liveVariantFalsifier = run(
  'custom pipeline live variant switch falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_FALSIFY: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(liveVariantArtifactRoot, 'falsifier'),
  },
);
if (
  liveVariant.status !== 0 ||
  !liveVariant.output.includes('pipeline=M3_PIPELINE=custom variant=M3_MULTI_UV_VARIANT=false') ||
  !liveVariant.output.includes('draws=2') ||
  !liveVariant.output.includes('variantSwitch=true') ||
  liveVariantFalsifier.status !== 0 ||
  !liveVariantFalsifier.output.includes('pipeline=M3_PIPELINE=custom variant=M3_MULTI_UV_VARIANT=false') ||
  !liveVariantFalsifier.output.includes('draws=1') ||
  !liveVariantFalsifier.output.includes('variantSwitch=true')
) {
  console.error('[m3-programmable] custom pipeline live variant switch: FAIL - post-resize custom variant mutation did not pass');
  process.exit(1);
}
console.log('[m3-programmable] custom pipeline live variant switch: PASS');
console.log('[m3-programmable] PASS - M3 programmable rendering gates GREEN');
