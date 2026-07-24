#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '..', '..', '..');

function run(label, args, extraEnv = {}, cwd = repoRoot) {
  const result = spawnSync('pnpm', args, {
    cwd,
    encoding: 'utf8',
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
  !customMaterial.output.includes('[smoke] brightnessDelta_05=')
) {
  console.error('[m3-programmable] custom material: FAIL - pixel-changing shader gate did not pass');
  process.exit(1);
}
console.log('[m3-programmable] custom material pixel: PASS');

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
  !multiUv.output.includes('quadSampleMaxDiff=')
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
console.log('[m3-programmable] PASS - M3 programmable rendering gates GREEN');
