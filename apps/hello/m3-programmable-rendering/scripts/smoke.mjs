#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
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
