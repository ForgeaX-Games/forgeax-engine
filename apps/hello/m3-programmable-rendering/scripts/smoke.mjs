#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '..', '..', '..');
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
      pipelineSwitchedAfterResize: summary.pipelineSwitchedAfterResize,
      variantSwitchedAfterPipeline: summary.variantSwitchedAfterPipeline,
      drawCount: summary.drawCount,
      inspections: summary.inspections,
    },
    dawn: readDawnReadbackMetadata(resolve(root, 'dawn-readback.json')),
    screenshotSha256: sha256File(resolve(root, 'custom-live.png')),
  };
}

function repeatabilityDiff(first, second) {
  const firstJson = JSON.stringify(first);
  const secondJson = JSON.stringify(second);
  return firstJson === secondJson ? undefined : { first, second };
}

function run(label, args, extraEnv = {}, cwd = repoRoot) {
  const result = spawnSync('pnpm', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 180_000,
    env: { ...process.env, INIT_CWD: repoRoot, ...extraEnv },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stdout.write(output);
  if (result.error) {
    console.error(`[m3-programmable] ${label}: spawn failed: ${result.error.message}`);
  }
  return { status: result.status, output };
}

const customMaterial = run('custom material', [
  '--filter',
  '@forgeax/hello-custom-shader',
  'smoke',
]);
if (
  customMaterial.status !== 0 ||
  !customMaterial.output.includes('[smoke] Pass-2 PASS -- ANTIALIAS_MSAA custom vs PBR GREEN') ||
  !customMaterial.output.includes('[smoke] brightnessDelta_05=') ||
  !customMaterial.output.includes(
    '[smoke] custom texture binding: PASS schema=baseColorTexture textureSample=true',
  )
) {
  console.error('[m3-programmable] custom material: FAIL - material/texture binding gate did not pass');
  process.exit(1);
}
console.log('[m3-programmable] custom material pixel: PASS');
console.log('[m3-programmable] custom material texture binding: PASS');

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
if (
  fakeDepth.status === 0 ||
  !fakeDepth.output.includes('FALSIFY force-fake-depth') ||
  !fakeDepth.output.includes('R/G stddev=') ||
  !fakeDepth.output.includes('expected spatial diversity from cascade bands')
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
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-variant'],
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
  ['--filter', '@forgeax/app-learn-render-4-advanced-opengl-5-framebuffers', 'smoke:browser-live'],
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
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-composed'],
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

const customRhiArtifactRoot =
  process.env.FORGEAX_M3_ARTIFACT_DIR ??
  resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering', 'custom-pipeline-rhi');
const customRhi = run(
  'custom pipeline RHI',
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
  { FORGEAX_M3_ARTIFACT_DIR: resolve(customRhiArtifactRoot, 'normal') },
);
const customRhiFalsifier = run(
  'custom pipeline RHI falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_ARTIFACT_DIR: resolve(customRhiTrueArtifactRoot, 'normal'),
  },
);
const customRhiTrueFalsifier = run(
  'custom pipeline RHI true variant falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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

const msaaCustomArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-custom-graph');
const msaaCustom = run(
  'custom pipeline MSAA graph',
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaCustomArtifactRoot, 'normal'),
  },
);
const msaaCustomFalsifier = run(
  'custom pipeline MSAA graph falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaRepeatArtifactRoot, 'normal'),
  },
);
const msaaRepeatFalsifier = run(
  'custom pipeline MSAA repeatability falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaTrueVariantArtifactRoot, 'normal'),
  },
);
const msaaTrueVariantFalsifier = run(
  'custom pipeline MSAA true variant falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaTrueVariantSwitchArtifactRoot, 'normal'),
  },
);
const msaaTrueVariantSwitchFalsifier = run(
  'custom pipeline MSAA true variant live switch falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaPipelineFalsifierArtifactRoot, 'normal'),
  },
);
const msaaPipelineFalsifier = run(
  'custom pipeline MSAA adjacent pipeline falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
if (msaaPipelineDawnReadbackDelta.changedPixels === 0 || msaaPipelineDawnReadbackDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA adjacent pipeline Dawn delta: FAIL - changedPixels=${msaaPipelineDawnReadbackDelta.changedPixels} meanRgbDelta=${msaaPipelineDawnReadbackDelta.meanRgbDelta.toFixed(4)}`,
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA true variant pipeline repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA false passthrough pipeline repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
  msaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.rhi.drawCount !== 1 ||
  msaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.dawn.sha256 === msaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.dawn.sha256 ||
  msaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.screenshotSha256 === msaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.screenshotSha256
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA false inversion pipeline repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
  msaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.rhi.drawCount !== 1 ||
  msaaFalseInversionPipelineRepeatFirst.normal.snapshot.dawn.sha256 === msaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.dawn.sha256 ||
  msaaFalseInversionPipelineRepeatFirst.normal.snapshot.screenshotSha256 === msaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.screenshotSha256
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA false inversion pipeline repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
  noMsaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.rhi.drawCount !== 1 ||
  noMsaaFalseInversionPipelineRepeatFirst.normal.snapshot.dawn.sha256 === noMsaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.dawn.sha256 ||
  noMsaaFalseInversionPipelineRepeatFirst.normal.snapshot.screenshotSha256 === noMsaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.screenshotSha256
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA true inversion pipeline repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
  noMsaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.rhi.drawCount !== 1 ||
  noMsaaTrueInversionPipelineRepeatFirst.normal.snapshot.dawn.sha256 === noMsaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.dawn.sha256 ||
  noMsaaTrueInversionPipelineRepeatFirst.normal.snapshot.screenshotSha256 === noMsaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.screenshotSha256
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA true passthrough pipeline repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA false passthrough pipeline repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA steady false passthrough repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA steady false inversion repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA steady true passthrough repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA steady true inversion repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
if (msaaLivePostPipelineDawnReadbackDelta.changedPixels === 0 || msaaLivePostPipelineDawnReadbackDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA live post adjacent pipeline Dawn delta: FAIL - changedPixels=${msaaLivePostPipelineDawnReadbackDelta.changedPixels} meanRgbDelta=${msaaLivePostPipelineDawnReadbackDelta.meanRgbDelta.toFixed(4)}`,
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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

const msaaLiveVariantRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-live-variant-repeatability');
const msaaLiveVariantRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaLiveVariantRepeatArtifactRoot, pass);
  msaaLiveVariantRepeatRuns.push({
    normal: run(
      `custom pipeline MSAA live variant repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
  noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.snapshot.rhi.drawCount !== 1 ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.normal.snapshot.dawn.sha256 === noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.snapshot.dawn.sha256 ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.normal.snapshot.screenshotSha256 === noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.snapshot.screenshotSha256
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
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'inversion',
    FORGEAX_M3_VARIANT: 'false',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaSteadyInversionArtifactRoot, 'normal'),
  },
);
const msaaSteadyInversionFalsifier = run(
  'custom pipeline MSAA steady inversion falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'inversion',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaSteadyTrueInversionArtifactRoot, 'normal'),
  },
);
const msaaSteadyTrueInversionFalsifier = run(
  'custom pipeline MSAA steady true inversion falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA steady true inversion repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA steady true passthrough repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA steady false passthrough repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA steady false inversion repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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

const liveVariantArtifactRoot = resolve(customRhiArtifactRoot, 'live-variant-switch');
const liveVariant = run(
  'custom pipeline live variant switch',
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(liveVariantArtifactRoot, 'normal'),
  },
);
const liveVariantFalsifier = run(
  'custom pipeline live variant switch falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-rhi'],
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
