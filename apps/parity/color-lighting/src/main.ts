import { createForgeaxAdapter } from './adapters/forgeax-adapter';
import { createThreeAdapter, threeToneMappingId } from './adapters/three-adapter';
import { captureIblGpuCase, serializeIblGpuCaseResult } from './adapters/ibl-adapter';
import { projectObservation, type AttachmentEvidence } from './capture/attachment-readback';
import { probeReadback } from './capture/readback-probe';
import { TONE_CASES_BY_ID, TONE_REQUIRED_CASES } from './report/tone-required';
import { inspectToneRamp } from './report/tone-report';
import type { CaptureConfig, CaptureEnvelope } from './capture/named-capture';
import type { CaseReport, SceneCase } from './contracts/types';
import { runParityMatrix } from './cli/run-parity';
import {
  PARITY_REQUIRED_CASE_IDS,
  PARITY_REQUIRED_CASES,
  PARITY_REQUIRED_PIPELINE_IDS,
} from './coverage/required-cases';
import { M1_CASE_INPUTS, M1_DEFERRED_MATRIX, M1_REQUIRED_CASES, type M1ColorInput } from './report/m1-required';
import positiveMinimal from '../cases/m0/positive-minimal.json' with { type: 'json' };
import selfCompare from '../cases/m0/self-compare.json' with { type: 'json' };
import sameProvenance from '../cases/m0/same-provenance.json' with { type: 'json' };
import missingPrimary from '../cases/m0/missing-primary.json' with { type: 'json' };
import invalidBudget from '../cases/m0/invalid-budget.json' with { type: 'json' };
import byteDiff from '../cases/m0/byte-diff.json' with { type: 'json' };
import falsificationManifest from '../cases/default/falsification/manifest.json' with { type: 'json' };
import constantEnvironment from '../cases/ibl/constant-environment.json' with { type: 'json' };
import transparentHdrCase from '../cases/transparency-post/transparent-hdr-hdrp.json' with { type: 'json' };
import transparentLdrCase from '../cases/transparency-post/transparent-ldr-urp.json' with { type: 'json' };
import {
  captureTransparencyForgeaxBrowser,
  captureTransparencyThreeBrowser,
} from './adapters/transparency-post-adapter';
import { World } from '@forgeax/engine-ecs';
import { createRenderer } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  Skylight,
  SpotLight,
  perspective,
  tonemapToU32,
  type FrameObservationReadback,
  type Renderer,
} from '@forgeax/engine-render';
import { err, ok } from '@forgeax/engine-types';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { PMREMGenerator, WebGPURenderer } from 'three/webgpu';
import {
  BackSide,
  Color,
  DataTexture,
  DoubleSide,
  DirectionalLight as ThreeDirectionalLight,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NearestFilter,
  PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  SRGBColorSpace,
  SphereGeometry,
  UnsignedByteType,
  WebGLRenderer,
} from 'three';

const m1FalsificationCases = falsificationManifest.cases.map(
  (entry) => ({
    caseId: entry.caseId,
    required: falsificationManifest.required,
    colorDomain: falsificationManifest.colorDomain,
    scene: falsificationManifest.scene,
    budget: falsificationManifest.budget,
  }) as unknown as SceneCase,
);
const m1CaptureInputs = Object.fromEntries([
  ...Object.entries(M1_CASE_INPUTS),
  ...falsificationManifest.cases.flatMap((entry) => {
    const input = M1_CASE_INPUTS[entry.sourceCaseId];
    return input === undefined ? [] : [[entry.caseId, input]];
  }),
]) as Record<string, M1ColorInput>;

interface M2AlphaFixture extends SceneCase {
  readonly alpha: {
    readonly mode: 'OPAQUE' | 'MASK' | 'BLEND';
    readonly baseAlpha: number;
    readonly cutoff?: number;
  };
  readonly baseColor: readonly [number, number, number, number];
  readonly textureColor?: readonly [number, number, number, number];
}

interface DirectProducerMetadata {
  readonly copySrc: boolean;
  readonly lifetime: 'active' | 'retired';
}

const M2_ALPHA_REQUIRED_CASE_IDS = [
  'material-alpha-rgba-factor',
  'material-alpha-mask-default',
  'material-alpha-mask-explicit',
  'material-alpha-mask-zero',
  'material-alpha-mask-one',
  'material-alpha-mask-equal',
  'material-alpha-blend',
] as const;

const m2FixtureModules = import.meta.glob('../cases/material-alpha/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, M2AlphaFixture>;
const m2AlphaCases = Object.values(m2FixtureModules);
const m2AlphaCasesById = new Map(m2AlphaCases.map((entry) => [entry.caseId, entry]));
const m4DirectLightModules = import.meta.glob('../cases/direct-light/cases/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, SceneCase>;
const m4DirectLightCases = Object.values(m4DirectLightModules);
const m4DirectLightCasesById = new Map(m4DirectLightCases.map((entry) => [entry.caseId, entry]));
const m6TransparencyCases = [transparentLdrCase, transparentHdrCase] as unknown as readonly SceneCase[];
const iblVisualSceneCase = {
  caseId: constantEnvironment.caseId,
  required: true,
  colorDomain: 'linearHdr',
  scene: { width: 128, height: 128, background: [0, 0, 0, 1] },
  comparison: { primaryMetric: 'rgba' },
  budget: { analyticMax: 0.05, roiMax: 0.05, byteMax: 128 * 128 * 4 },
} as const satisfies SceneCase;
const directProducerMetadata = new Map<string, DirectProducerMetadata>();
const cases = [
  positiveMinimal,
  selfCompare,
  sameProvenance,
  missingPrimary,
  invalidBudget,
  byteDiff,
  ...M1_REQUIRED_CASES,
  ...m1FalsificationCases,
  ...m2AlphaCases,
  ...TONE_REQUIRED_CASES,
  ...m4DirectLightCases,
] as unknown as readonly SceneCase[];
const expectedErrors = {
  'self-compare': 'provenance-conflict',
  'same-provenance': 'provenance-conflict',
  'missing-primary': 'primary-capture-missing',
  'invalid-budget': 'budget-exceeded',
  'byte-diff': 'budget-exceeded',
  ...Object.fromEntries(m1FalsificationCases.map((entry) => [entry.caseId, 'budget-exceeded'])),
  ...Object.fromEntries(m4DirectLightCases.map((entry) => [entry.caseId, 'status-incomplete'])),
} as const;
const blackConfig = (sceneCase: SceneCase): CaptureConfig => ({
  width: sceneCase.scene.width,
  height: sceneCase.scene.height,
  colorDomain: sceneCase.colorDomain,
  background: sceneCase.scene.background,
  ...(sceneCase.pipeline === undefined ? {} : { pipeline: sceneCase.pipeline.identity }),
});

async function waitForAnimationFrameOrTimeout(): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timeout = setTimeout(finish, 250);
    requestAnimationFrame(() => {
      clearTimeout(timeout);
      finish();
    });
  });
}

async function settleWebglRenderer(renderer: Renderer): Promise<void> {
  await waitForAnimationFrameOrTimeout();
  await waitForAnimationFrameOrTimeout();
  renderer.dispose();
}

const directReadbackConfig = (sceneCase: SceneCase): CaptureConfig => ({
  ...blackConfig(sceneCase),
  readback: {
    source: 'rhi-debug',
    linearReadback: true,
    finalReadback: true,
    namedAttachment: true,
    rawHash: true,
    requiresRhiDebugExtension: false,
  },
});

const directThreeReadbackConfig = (sceneCase: SceneCase): CaptureConfig => ({
  ...blackConfig(sceneCase),
  readback: probeReadback({
    finalReadbackAvailable: true,
    linearReadbackAvailable: false,
    namedAttachmentAvailable: false,
    rawHashAvailable: true,
  }),
});

function getM2AlphaCoverage() {
  const present = new Set(m2AlphaCases.map((entry) => entry.caseId));
  const missing = M2_ALPHA_REQUIRED_CASE_IDS.filter((caseId) => !present.has(caseId));
  const unexpected = m2AlphaCases
    .map((entry) => entry.caseId)
    .filter((caseId) => !M2_ALPHA_REQUIRED_CASE_IDS.includes(caseId as (typeof M2_ALPHA_REQUIRED_CASE_IDS)[number]));
  return {
    requiredCaseIds: [...M2_ALPHA_REQUIRED_CASE_IDS],
    presentCaseIds: m2AlphaCases.map((entry) => entry.caseId),
    missingCaseIds: missing,
    unexpectedCaseIds: unexpected,
    complete: missing.length === 0 && unexpected.length === 0 && m2AlphaCases.every((entry) => entry.required),
  } as const;
}

function m2AlphaVisible(fixture: M2AlphaFixture): boolean {
  const textureAlpha = fixture.textureColor?.[3] ?? 1;
  const alpha = fixture.alpha.baseAlpha * textureAlpha;
  if (fixture.alpha.mode !== 'MASK') return true;
  const cutoff = fixture.alpha.cutoff ?? 0.5;
  return cutoff <= 0 || alpha > cutoff;
}

function assertM2AlphaReadback(fixture: M2AlphaFixture, pixels: Uint8Array): void {
  const pixelOffset = (Math.floor(fixture.scene.height / 2) * fixture.scene.width + Math.floor(fixture.scene.width / 2)) * 4;
  const expected = fixture.scene.background.map((channel) => Math.round((channel ?? 0) * 255));
  const isClear = [0, 1, 2, 3].every((component) => {
    const actual = pixels[pixelOffset + component] ?? 0;
    return Math.abs(actual - (expected[component] ?? 0)) <= 3;
  });
  if (m2AlphaVisible(fixture) === isClear) {
    const state = m2AlphaVisible(fixture) ? 'visible' : 'discarded';
    throw new Error(`M2 alpha ${fixture.caseId} expected ${state} first draw, got clear=${isClear}`);
  }
}

function mutateFirstByte(capture: CaptureEnvelope): CaptureEnvelope {
  const linear = [1, ...capture.captures.linear.slice(1)];
  const final = [1, ...capture.captures.final.slice(1)];
  return { ...capture, captures: { ...capture.captures, linear, final } };
}

function mutateFalsification(capture: CaptureEnvelope, caseId: string): CaptureEnvelope {
  const final = [...capture.captures.final];
  if (caseId === 'falsify-reversed-clear-alpha') final[3] = 0;
  if (caseId === 'falsify-flat-color-substitution') final.fill(0);
  if (caseId === 'falsify-repeated-decode') final[0] = 55;
  if (caseId === 'falsify-omitted-decode') final[0] = 188;
  return { ...capture, captures: { ...capture.captures, final } };
}

async function readbackRgba16float(
  renderer: Renderer,
  lease: Parameters<FrameObservationReadback>[0],
): ReturnType<FrameObservationReadback> {
  const sourceResult = lease.beginReadback();
  if (!sourceResult.ok) return err(new Error(sourceResult.error.hint));
  const width = lease.descriptor.size.width;
  const height = lease.descriptor.size.height;
  const rowBytes = width * 8;
  const alignedRowBytes = Math.ceil(rowBytes / 256) * 256;
  const bufferResult = renderer.device.createBuffer({
    size: alignedRowBytes * height,
    usage: 0x08 | 0x01,
  });
  if (!bufferResult.ok) return err(new Error(bufferResult.error.code));
  const buffer = bufferResult.value;
  const encoderResult = renderer.device.createCommandEncoder({});
  if (!encoderResult.ok) {
    renderer.device.destroyBuffer(buffer);
    return err(new Error(encoderResult.error.code));
  }
  try {
    encoderResult.value.copyTextureToBuffer(
      { texture: sourceResult.value.texture } as never,
      { buffer, offset: 0, bytesPerRow: alignedRowBytes, rowsPerImage: height } as never,
      { width, height, depthOrArrayLayers: 1 },
    );
  } catch (cause) {
    renderer.device.destroyBuffer(buffer);
    return err(new Error(`copyTextureToBuffer failed: ${String(cause)}`));
  }
  const finishResult = encoderResult.value.finish();
  if (!finishResult.ok) {
    renderer.device.destroyBuffer(buffer);
    return err(new Error(finishResult.error.code));
  }
  renderer.device.queue.submit([finishResult.value]);
  await renderer.device.queue.onSubmittedWorkDone();
  const mapResult = await buffer.mapAsync(0x01);
  if (!mapResult.ok) {
    renderer.device.destroyBuffer(buffer);
    return err(new Error(mapResult.error.code));
  }
  const rangeResult = mapResult.value.getMappedRange();
  if (!rangeResult.ok) {
    mapResult.value.unmap();
    renderer.device.destroyBuffer(buffer);
    return err(new Error(rangeResult.error.code));
  }
  const fullBytes = new Uint8Array(rangeResult.value);
  const bytes = new Uint8Array(rowBytes * height);
  for (let row = 0; row < height; row += 1) {
    bytes.set(fullBytes.subarray(row * alignedRowBytes, row * alignedRowBytes + rowBytes), row * rowBytes);
  }
  mapResult.value.unmap();
  renderer.device.destroyBuffer(buffer);
  return ok(bytes);
}

async function hashRawBytes(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle !== undefined) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function captureDirectEvidence(
  renderer: Renderer,
  sceneCase: SceneCase,
  pixels: Uint8Array,
): Promise<{ readonly evidence: AttachmentEvidence; readonly metadata: DirectProducerMetadata }> {
  const observationResult = await renderer.observeCurrentFrame({
    semantic: 'linear-hdr',
    readback: (lease) => readbackRgba16float(renderer, lease),
  });
  if (!observationResult.ok) {
    throw new Error(`ForgeaX linear HDR observation failed: ${observationResult.error.code}`);
  }
  const linear = observationResult.value;
  const finalBytes = new Uint8Array(pixels);
  return {
    evidence: {
      linearHdr: projectObservation('linearHdr', {
        status: 'ready',
        bytes: linear.bytes,
        format: linear.metadata.format,
        size: linear.metadata.size,
        rawHash: await hashRawBytes(linear.bytes),
        frameId: linear.metadata.frameId,
        pipelineId: linear.metadata.pipelineId,
        backendId: linear.metadata.backendId,
      }),
      finalDisplay: projectObservation('finalDisplay', {
        status: 'ready',
        bytes: finalBytes,
        format: 'rgba8unorm',
        size: { width: sceneCase.scene.width, height: sceneCase.scene.height },
        rawHash: await hashRawBytes(finalBytes),
        frameId: linear.metadata.frameId,
        pipelineId: linear.metadata.pipelineId,
        backendId: linear.metadata.backendId,
      }),
    },
    metadata: {
      copySrc: (linear.metadata.usage & 0x01) !== 0,
      lifetime: linear.metadata.lifetime.state,
    },
  };
}

export async function captureForgeax(sceneCase: SceneCase, rendererKind: 'webgpu' | 'webgl' = 'webgpu') {
  const canvas = rendererKind === 'webgl'
    ? document.createElement('canvas')
    : document.querySelector<HTMLCanvasElement>('#forgeax');
  if (canvas === null) throw new Error('missing ForgeaX canvas');
  const useWebkitCompositorReadback = rendererKind === 'webgl'
    && typeof (globalThis as unknown as { __forgeaxWebkitCanvasReadback?: unknown }).__forgeaxWebkitCanvasReadback === 'function';
  if (rendererKind === 'webgl') {
    canvas.style.cssText = useWebkitCompositorReadback
      ? 'position:fixed;left:0;top:0'
      : 'position:fixed;left:-10000px;top:-10000px';
    document.body.append(canvas);
  }
  canvas.width = sceneCase.scene.width;
  canvas.height = sceneCase.scene.height;
  const renderer = await createRenderer(canvas, {}, forgeaxBundlerAdapter() as never);
  const renderErrors: string[] = [];
  const removeRenderErrorListener = renderer.onError((error) => {
    renderErrors.push(`${error.code}: ${error.expected} (${error.hint})`);
  });
  try {
    const ready = await renderer.ready;
    if (!ready.ok) throw new Error(`ForgeaX renderer unavailable: ${ready.error.code}`);
    const world = new World();
    const input = m1CaptureInputs[sceneCase.caseId];
    const m1Case = sceneCase.caseId.startsWith('default-') || sceneCase.caseId.startsWith('falsify-');
    const m2Case = m2AlphaCasesById.get(sceneCase.caseId);
    const toneCase = TONE_CASES_BY_ID.get(sceneCase.caseId);
    const directCase = m4DirectLightCasesById.get(sceneCase.caseId);
    const iblCase = sceneCase.caseId === constantEnvironment.caseId;
    if (m1Case || m2Case !== undefined || toneCase !== undefined || directCase !== undefined || iblCase) {
      world.spawn(
        { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1] } },
        {
          component: Camera,
          data: {
            ...perspective({ fov: Math.PI / 4, aspect: 1 }),
            clearColor: sceneCase.scene.background,
            ...(toneCase === undefined && !iblCase
              ? {}
              : toneCase === undefined
                ? { tonemap: tonemapToU32('reinhard') }
                : { tonemap: tonemapToU32(toneCase.tone.mode), exposure: toneCase.tone.exposure }),
          },
        },
      ).unwrap();
      if (input !== undefined) await spawnM1Primitive(world, renderer, input);
      if (m2Case !== undefined) await spawnM2AlphaPrimitive(world, renderer, m2Case);
      if (toneCase !== undefined) await spawnTonePrimitive(world, renderer, toneCase.tone.color);
      if (directCase !== undefined) await spawnDirectLightPrimitive(world, directCase);
      if (iblCase) spawnIblPrimitive(world);
      if (m2Case !== undefined) {
        world.spawn({
          component: DirectionalLight,
          data: { direction: [0, 0, -1], color: [1, 1, 1], intensity: 1, castShadow: false },
        });
      }
    }
    const drawResult = renderer.draw([world], { owner: 0 });
    if (!drawResult.ok) throw new Error(`ForgeaX draw failed: ${drawResult.error.code}`);
    if (rendererKind === 'webgl') {
      // The WebGL2 fallback has no browser GPU-queue completion event under
      // headed Xvfb; compositor frames are its completion boundary.
      await waitForAnimationFrameOrTimeout();
      const warmedDraw = renderer.draw([world], { owner: 0 });
      if (!warmedDraw.ok) throw new Error(`ForgeaX warmed draw failed: ${warmedDraw.error.code}`);
      await waitForAnimationFrameOrTimeout();
    }
    if (m2Case !== undefined && renderErrors.length > 0) {
      throw new Error(`ForgeaX M2 render errors for ${sceneCase.caseId}: ${renderErrors.join(' | ')}`);
    }
    if (iblCase && renderErrors.length > 0) {
      throw new Error(`ForgeaX IBL visual render errors for ${sceneCase.caseId}: ${renderErrors.join(' | ')}`);
    }
    if (iblCase && rendererKind === 'webgpu') await waitForAnimationFrameOrTimeout();
    const pixels = await readCanvasPixels(canvas, useWebkitCompositorReadback);
    if (m2Case !== undefined) assertM2AlphaReadback(m2Case, pixels);
    if (directCase !== undefined && rendererKind === 'webgpu') {
      const capture = await captureDirectEvidence(renderer, sceneCase, pixels);
      directProducerMetadata.set(sceneCase.caseId, capture.metadata);
      return { linear: [], final: Array.from(pixels), config: directReadbackConfig(sceneCase), observations: capture.evidence };
    }
    return {
      linear: Array.from(pixels),
      final: Array.from(pixels),
      config: rendererKind === 'webgpu'
        ? blackConfig(sceneCase)
        : {
            ...blackConfig(sceneCase),
            readback: probeReadback({
              finalReadbackAvailable: true,
              linearReadbackAvailable: false,
              namedAttachmentAvailable: false,
              rawHashAvailable: true,
            }),
          },
    };
  } finally {
    removeRenderErrorListener();
    if (rendererKind === 'webgl') {
      await settleWebglRenderer(renderer);
      canvas.remove();
    }
  }
}

async function spawnDirectLightPrimitive(world: World, sceneCase: SceneCase): Promise<void> {
  const light = sceneCase.light;
  if (light === undefined) throw new Error(`direct-light case ${sceneCase.caseId} is missing light metadata`);
  const plane = createPlaneGeometry(2.8, 2.8);
  if (!plane.ok) throw new Error(`direct-light plane creation failed: ${plane.error.code}`);
  const meshHandle = world.allocSharedRef('MeshAsset', plane.value);
  const material = Materials.standard({
    baseColor: [0.7, 0.7, 0.7, 1],
    colorSpace: 'linear',
    metallic: 0,
    roughness: 1,
    castShadow: false,
    renderState: { cullMode: 'none' },
  });
  const materialHandle = world.allocSharedRef('MaterialAsset', material);
  world.spawn(
    { component: Transform, data: {} },
    { component: MeshFilter, data: { assetHandle: meshHandle } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  ).unwrap();
  const color = [light.color[0], light.color[1], light.color[2]] as [number, number, number];
  if (light.kind === 'directional') {
    world.spawn({
      component: DirectionalLight,
      data: { direction: light.direction ?? [0, 0, -1], color, intensity: light.intensity, castShadow: false },
    }).unwrap();
    return;
  }
  const position = [0, 0, 2] as [number, number, number];
  if (light.kind === 'point') {
    world.spawn(
      { component: Transform, data: { pos: position } },
      { component: PointLight, data: { color, intensity: light.intensity, range: light.range ?? 10 } },
    ).unwrap();
    return;
  }
  world.spawn(
    { component: Transform, data: { pos: position } },
    {
      component: SpotLight,
      data: {
        direction: light.direction ?? [0, 0, -1],
        color,
        intensity: light.intensity,
        range: light.range ?? 10,
        innerConeDeg: light.innerConeDeg ?? 0,
        outerConeDeg: light.outerConeDeg ?? 45,
        castShadow: false,
      },
    },
  ).unwrap();
}

function spawnIblPrimitive(world: World): void {
  const plane = createPlaneGeometry(2.8, 2.8);
  if (!plane.ok) throw new Error(`IBL plane creation failed: ${plane.error.code}`);
  const meshHandle = world.allocSharedRef('MeshAsset', plane.value);
  const materialHandle = world.allocSharedRef('MaterialAsset', Materials.standard({
    baseColor: [0.72, 0.72, 0.72, 1],
    colorSpace: 'linear',
    metallic: 0,
    roughness: 1,
    castShadow: false,
    renderState: { cullMode: 'none' },
  }));
  world.spawn(
    { component: Transform, data: {} },
    { component: MeshFilter, data: { assetHandle: meshHandle } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  ).unwrap();
  world.spawn({ component: Skylight, data: { color: [1, 1, 1], intensity: 1 } }).unwrap();
}

function textureBytes(color: readonly [number, number, number, number]): Uint8Array {
  return Uint8Array.from(color.map((channel) => Math.round(channel * 255)));
}

function threeLinearColor(color: readonly [number, number, number]) {
  return new Color().setRGB(color[0], color[1], color[2], LinearSRGBColorSpace);
}

function materialColor(input: M1ColorInput): readonly [number, number, number, number] {
  return input.kind === 'factor-texture' ? (input.factor ?? [1, 1, 1, 1]) : input.color;
}

async function spawnM1Primitive(world: World, renderer: Awaited<ReturnType<typeof createRenderer>>, input: M1ColorInput): Promise<void> {
  const plane = createPlaneGeometry(2.8, 2.8);
  if (!plane.ok) throw new Error(`M1 plane creation failed: ${plane.error.code}`);
  const meshHandle = world.allocSharedRef('MeshAsset', plane.value);
  const texture = input.kind === 'srgb-texture' || input.kind === 'factor-texture'
    ? {
        kind: 'texture' as const,
        width: 1,
        height: 1,
        format: 'rgba8unorm-srgb' as GPUTextureFormat,
        data: textureBytes(input.color),
        colorSpace: 'srgb' as const,
        mipmap: false,
      }
    : undefined;
  const textureHandle = texture === undefined ? undefined : world.allocSharedRef('TextureAsset', texture);
  if (texture !== undefined && textureHandle !== undefined) {
    const upload = await renderer.store.uploadTexture(textureHandle, texture, {
      bytes: texture.data,
      width: 1,
      height: 1,
      mime: 'image/png',
      colorSpace: 'srgb',
      mipmap: false,
    });
    if (!upload.ok) throw new Error(`M1 texture upload failed: ${upload.error.code}`);
  }
  const colorSpace = input.kind === 'linear-input' || input.kind === 'factor-texture' ? 'linear' : 'srgb';
  const material = Materials.unlit(materialColor(input), {
    colorSpace,
    castShadow: false,
    renderState: { cullMode: 'none' },
    ...(textureHandle === undefined ? {} : { baseColorTexture: textureHandle as unknown as number }),
  });
  const materialHandle = world.allocSharedRef('MaterialAsset', material);
  world.spawn(
    { component: Transform, data: {} },
    { component: MeshFilter, data: { assetHandle: meshHandle } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  ).unwrap();
}

async function spawnM2AlphaPrimitive(
  world: World,
  renderer: Awaited<ReturnType<typeof createRenderer>>,
  fixture: M2AlphaFixture,
): Promise<void> {
  const plane = createPlaneGeometry(2.8, 2.8);
  if (!plane.ok) throw new Error(`M2 plane creation failed: ${plane.error.code}`);
  const meshHandle = world.allocSharedRef('MeshAsset', plane.value);
  const texture = fixture.textureColor === undefined
    ? undefined
    : {
        kind: 'texture' as const,
        width: 1,
        height: 1,
        format: 'rgba8unorm-srgb' as GPUTextureFormat,
        data: textureBytes(fixture.textureColor),
        colorSpace: 'srgb' as const,
        mipmap: false,
      };
  const textureHandle = texture === undefined ? undefined : world.allocSharedRef('TextureAsset', texture);
  if (texture !== undefined && textureHandle !== undefined) {
    const upload = await renderer.store.uploadTexture(textureHandle, texture, {
      bytes: texture.data,
      width: 1,
      height: 1,
      mime: 'image/png',
      colorSpace: 'srgb',
      mipmap: false,
    });
    if (!upload.ok) throw new Error(`M2 texture upload failed: ${upload.error.code}`);
  }
  const renderState = fixture.alpha.mode === 'BLEND'
    ? {
        cullMode: 'none' as const,
        depthWriteEnabled: false,
        blend: {
          color: { srcFactor: 'src-alpha' as const, dstFactor: 'one-minus-src-alpha' as const, operation: 'add' as const },
          alpha: { srcFactor: 'one' as const, dstFactor: 'one-minus-src-alpha' as const, operation: 'add' as const },
        },
      }
    : {
        cullMode: 'none' as const,
      };
  const material = Materials.standard({
    baseColor: [
      fixture.baseColor[0],
      fixture.baseColor[1],
      fixture.baseColor[2],
      fixture.alpha.baseAlpha,
    ],
    colorSpace: 'srgb',
    castShadow: false,
    metallic: 0,
    roughness: 1,
    queue: fixture.alpha.mode === 'BLEND' ? 3000 : fixture.alpha.mode === 'MASK' ? 2450 : 2000,
    renderState,
    ...(textureHandle === undefined ? {} : { baseColorTexture: textureHandle as unknown as number }),
    ...(fixture.alpha.mode === 'MASK' && fixture.alpha.cutoff !== undefined
      ? { alphaCutoff: fixture.alpha.cutoff }
      : {}),
  });
  const materialHandle = world.allocSharedRef('MaterialAsset', material);
  world.spawn(
    { component: Transform, data: {} },
    { component: MeshFilter, data: { assetHandle: meshHandle } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  ).unwrap();
}

async function spawnTonePrimitive(
  world: World,
  renderer: Awaited<ReturnType<typeof createRenderer>>,
  color: readonly [number, number, number],
): Promise<void> {
  await spawnM1Primitive(world, renderer, { kind: 'linear-input', color: [color[0], color[1], color[2], 1] });
}

type WebkitCanvasReadback = (request: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}) => Promise<readonly number[]>;

async function readCanvasPixels(
  canvas: HTMLCanvasElement,
  useWebkitCompositor = false,
): Promise<Uint8Array> {
  if (useWebkitCompositor) {
    const hook = (globalThis as unknown as { __forgeaxWebkitCanvasReadback?: WebkitCanvasReadback })
      .__forgeaxWebkitCanvasReadback;
    if (hook !== undefined) {
      const rect = canvas.getBoundingClientRect();
      const pixels = await hook({
        x: rect.x,
        y: rect.y,
        width: canvas.width,
        height: canvas.height,
      });
      const expectedLength = canvas.width * canvas.height * 4;
      if (pixels.length !== expectedLength) {
        throw new Error(
          `WebKit compositor readback returned ${pixels.length} bytes; expected ${expectedLength}`,
        );
      }
      return Uint8Array.from(pixels);
    }
  }
  const bitmap = await createImageBitmap(canvas);
  const offscreen = new OffscreenCanvas(canvas.width, canvas.height);
  const context = offscreen.getContext('2d', { willReadFrequently: true });
  if (context === null) {
    bitmap.close();
    throw new Error('canvas RGBA8 readback unavailable');
  }
  context.drawImage(bitmap, 0, 0);
  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Uint8Array(data.data.buffer, data.data.byteOffset, data.data.byteLength);
}

export async function captureThree(sceneCase: SceneCase, rendererKind: 'webgpu' | 'webgl' = 'webgpu') {
  const canvas = document.querySelector<HTMLCanvasElement>('#three');
  if (canvas === null) throw new Error('missing Three canvas');
  canvas.width = sceneCase.scene.width;
  canvas.height = sceneCase.scene.height;
  const input = m1CaptureInputs[sceneCase.caseId];
  const toneCase = TONE_CASES_BY_ID.get(sceneCase.caseId);
  const directCase = m4DirectLightCasesById.get(sceneCase.caseId);
  const iblCase = sceneCase.caseId === constantEnvironment.caseId;
  const alpha = sceneCase.caseId === 'default-transparent-alpha' || sceneCase.caseId.startsWith('material-alpha-');
  const renderer = rendererKind === 'webgpu'
    ? new WebGPURenderer({ canvas, alpha, antialias: false, forceWebGL: false })
    : new WebGLRenderer({ canvas, alpha, antialias: false, preserveDrawingBuffer: true });
  if (rendererKind === 'webgpu') {
    await renderer.init();
    if (renderer.backend?.isWebGPUBackend !== true) throw new Error('Three WebGPU primary unavailable');
  } else {
    renderer.setSize(sceneCase.scene.width, sceneCase.scene.height, false);
  }
  if (toneCase !== undefined) {
    renderer.toneMapping = threeToneMappingId(toneCase.tone.mode);
    renderer.toneMappingExposure = toneCase.tone.exposure;
  } else if (iblCase) {
    renderer.toneMapping = threeToneMappingId('reinhard');
  }
  const background = sceneCase.scene.background;
  renderer.setClearColor(
    new Color().setRGB(background[0] ?? 0, background[1] ?? 0, background[2] ?? 0, LinearSRGBColorSpace),
    background[3] ?? 1,
  );
  const scene = new Scene();
  let iblEnvironment: { dispose(): void } | undefined;
  if (input !== undefined || toneCase !== undefined || directCase !== undefined || iblCase) {
    const geometry = new PlaneGeometry(2.8, 2.8);
    const material = directCase === undefined && !iblCase
      ? new MeshBasicMaterial({ toneMapped: toneCase !== undefined, side: DoubleSide })
      : new MeshStandardMaterial({
          color: threeLinearColor(iblCase ? [0.72, 0.72, 0.72] : [0.7, 0.7, 0.7]),
          roughness: 1,
          metalness: 0,
          toneMapped: iblCase,
          side: DoubleSide,
        });
    const color = toneCase === undefined
      ? input === undefined
        ? [0, 0, 0, 1] as const
        : input.kind === 'factor-texture' ? (input.factor ?? [1, 1, 1, 1]) : input.color
      : [...toneCase.tone.color, 1] as const;
    const colorSpace = toneCase !== undefined || input?.kind === 'linear-input' || input?.kind === 'factor-texture'
      ? LinearSRGBColorSpace
      : SRGBColorSpace;
    if (material instanceof MeshBasicMaterial) material.color.setRGB(color[0], color[1], color[2], colorSpace);
    if (directCase !== undefined) {
      const light = directCase.light;
      if (light === undefined) throw new Error(`direct-light case ${directCase.caseId} is missing light metadata`);
      if (light.kind === 'directional') {
        const directional = new ThreeDirectionalLight(threeLinearColor(light.color), light.intensity);
        directional.position.set(0, 0, 3);
        directional.target.position.set(0, 0, 0);
        scene.add(directional, directional.target);
      } else if (light.kind === 'point') {
        const threeModule = await import('three') as unknown as {
          PointLight: new (...args: readonly unknown[]) => {
            position: { set(x: number, y: number, z: number): void };
          };
        };
        const point = new threeModule.PointLight(threeLinearColor(light.color), light.intensity, light.range ?? 10);
        point.position.set(0, 0, 2);
        scene.add(point);
      } else {
        const threeModule = await import('three') as unknown as {
          SpotLight: new (...args: readonly unknown[]) => {
            position: { set(x: number, y: number, z: number): void };
            target: { position: { set(x: number, y: number, z: number): void } };
          };
        };
        const spot = new threeModule.SpotLight(threeLinearColor(light.color), light.intensity, light.range ?? 10, ((light.outerConeDeg ?? 45) * Math.PI) / 180, 1 - (light.innerConeDeg ?? 0) / (light.outerConeDeg ?? 45));
        spot.position.set(0, 0, 2);
        spot.target.position.set(0, 0, 0);
        scene.add(spot, spot.target);
      }
    }
    if (iblCase) {
      const environmentScene = new Scene();
      const environmentGeometry = new SphereGeometry(1, 16, 16);
      const environmentMaterial = new MeshBasicMaterial({
        color: new Color().setRGB(1, 1, 1, LinearSRGBColorSpace),
        side: BackSide,
      });
      environmentScene.add(new Mesh(environmentGeometry, environmentMaterial));
      const pmremGenerator = new PMREMGenerator(renderer);
      const environmentTarget = pmremGenerator.fromScene(environmentScene, 0, 0.1, 10, { size: 32 });
      scene.environment = environmentTarget.texture;
      scene.environmentIntensity = 1;
      iblEnvironment = {
        dispose() {
          environmentTarget.dispose();
          pmremGenerator.dispose();
          environmentGeometry.dispose();
          environmentMaterial.dispose();
        },
      };
    }
    if (input !== undefined && (input.kind === 'srgb-texture' || input.kind === 'factor-texture')) {
      const texture = new DataTexture(textureBytes(input.color), 1, 1, RGBAFormat, UnsignedByteType);
      texture.colorSpace = SRGBColorSpace;
      texture.minFilter = NearestFilter;
      texture.magFilter = NearestFilter;
      texture.flipY = false;
      texture.needsUpdate = true;
      material.map = texture;
      material.needsUpdate = true;
    }
    scene.add(new Mesh(geometry, material));
  } else {
    const fixture = m2AlphaCasesById.get(sceneCase.caseId);
    if (fixture !== undefined) {
      const geometry = new PlaneGeometry(2.8, 2.8);
      const material = new MeshStandardMaterial({
        color: new Color().setRGB(
          fixture.baseColor[0],
          fixture.baseColor[1],
          fixture.baseColor[2],
          SRGBColorSpace,
        ),
        opacity: fixture.alpha.baseAlpha,
        transparent: fixture.alpha.mode === 'BLEND',
        depthWrite: fixture.alpha.mode !== 'BLEND',
        alphaTest: fixture.alpha.mode === 'MASK' ? fixture.alpha.cutoff ?? 0.5 : 0,
        toneMapped: false,
        side: DoubleSide,
      });
      if (fixture.textureColor !== undefined) {
        const texture = new DataTexture(textureBytes(fixture.textureColor), 1, 1, RGBAFormat, UnsignedByteType);
        texture.colorSpace = SRGBColorSpace;
        texture.minFilter = NearestFilter;
        texture.magFilter = NearestFilter;
        texture.flipY = false;
        texture.needsUpdate = true;
        material.map = texture;
        material.needsUpdate = true;
      }
      scene.add(new Mesh(geometry, material));
      const light = new ThreeDirectionalLight(0xffffff, 1);
      light.position.set(0, 0, 3);
      light.target.position.set(0, 0, 0);
      scene.add(light, light.target);
    }
  }
  const camera = new PerspectiveCamera(45, sceneCase.scene.width / sceneCase.scene.height, 0.1, 10);
  camera.position.z = 3;
  if (rendererKind === 'webgpu') {
    await renderer.renderAsync(scene, camera);
    if (iblCase) await renderer.renderAsync(scene, camera);
  } else renderer.render(scene, camera);
  const pixels = await readCanvasPixels(canvas);
  const m2Case = m2AlphaCasesById.get(sceneCase.caseId);
  if (m2Case !== undefined) assertM2AlphaReadback(m2Case, pixels);
  iblEnvironment?.dispose();
  renderer.dispose();
  const bytes = Array.from(pixels);
  if (directCase !== undefined) return { linear: [], final: bytes, config: directThreeReadbackConfig(sceneCase) };
  return { linear: bytes, final: bytes, config: blackConfig(sceneCase) };
}

const forgeaxAdapter = createForgeaxAdapter(captureForgeax);
const threeAdapter = createThreeAdapter(captureThree, 'webgpu');

declare global {
  interface Window {
    __colorLightingParity?: (invocationId?: string) => Promise<unknown>;
  }
}

window.__colorLightingParity = async (invocationId = 'color-lighting-parity-browser') => {
  const result = await runParityMatrix(cases, forgeaxAdapter, threeAdapter, {
    expectedErrors,
    overrideProvenance: {
      'self-compare': {
        forgeax: { implementation: 'three', version: 'r184', renderer: 'webgpu', adapterId: 'same' },
      },
      'same-provenance': {
        forgeax: { implementation: 'shared', version: '1', renderer: 'webgpu', adapterId: 'forgeax-webgpu' },
        three: { implementation: 'shared', version: '1', renderer: 'webgpu', adapterId: 'three-r184-webgpu' },
      },
      'missing-primary': {
        three: { implementation: 'three', version: 'r184', renderer: 'webgl', adapterId: 'three-r184-webgl-fallback' },
      },
    },
    mutateThree: {
      'byte-diff': mutateFirstByte,
      ...Object.fromEntries(m1FalsificationCases.map((entry) => [entry.caseId, (capture: CaptureEnvelope) => mutateFalsification(capture, entry.caseId)])),
    },
  });
  const auxiliaryErrors: string[] = [];
  let iblEvidence: Awaited<ReturnType<typeof captureIblGpuCase>> | null = null;
  try {
    iblEvidence = await captureIblGpuCase(navigator.gpu);
  } catch (error) {
    auxiliaryErrors.push(`ibl-constant-environment: ${error instanceof Error ? error.message : String(error)}`);
  }
  const iblPass = iblEvidence !== null
    && iblEvidence.capability.capabilityStatus === 'supported'
    && iblEvidence.evidence.status === 'ready'
    && iblEvidence.finalDisplay.status === 'ready'
    && iblEvidence.analytic.maxError <= constantEnvironment.analyticMax;
  let transparencyResult: Awaited<ReturnType<typeof runParityMatrix>> | null = null;
  try {
    transparencyResult = await runParityMatrix(
      m6TransparencyCases,
      createForgeaxAdapter(captureTransparencyForgeaxBrowser),
      createThreeAdapter(captureTransparencyThreeBrowser, 'webgpu'),
    );
  } catch (error) {
    auxiliaryErrors.push(`transparency-post: ${error instanceof Error ? error.message : String(error)}`);
  }
  const visualEvidenceErrors: string[] = [];
  const visualEvidenceInputs: Array<Record<string, unknown>> = [];
  const visualSceneCases = new Map<string, SceneCase>([
    ...cases.map((entry) => [entry.caseId, entry] as const),
    ...m6TransparencyCases.map((entry) => [entry.caseId, entry] as const),
    [iblVisualSceneCase.caseId, iblVisualSceneCase],
  ]);
  const appendVisualEvidence = (entry: { readonly caseId: string; readonly report: Pick<CaseReport, 'provenance' | 'captures' | 'metrics' | 'verdict' | 'status' | 'attachmentEvidence'> }): void => {
    const sceneCase = visualSceneCases.get(entry.caseId);
    if (sceneCase === undefined) {
      visualEvidenceErrors.push(`${entry.caseId}: visual SceneCase is missing`);
      return;
    }
    visualEvidenceInputs.push({
      caseId: entry.caseId,
      width: sceneCase.scene.width,
      height: sceneCase.scene.height,
      background: sceneCase.scene.background,
      framing: 'orthographic-center',
      provenance: entry.report.provenance,
      captures: entry.report.captures,
      metrics: entry.report.metrics,
      verdict: entry.report.verdict,
      status: entry.report.status,
      frameId: entry.report.attachmentEvidence?.finalDisplay.frameId ?? 0,
    });
  };
  for (const caseId of PARITY_REQUIRED_CASE_IDS) {
    if (caseId === constantEnvironment.caseId) continue;
    const entry = result.cases.find((candidate) => candidate.caseId === caseId)
      ?? transparencyResult?.cases.find((candidate) => candidate.caseId === caseId);
    if (entry === undefined) visualEvidenceErrors.push(`${caseId}: primary visual capture is missing`);
    else appendVisualEvidence(entry);
  }
  try {
    const forgeaxIbl = await forgeaxAdapter.capture(iblVisualSceneCase);
    const threeIbl = await threeAdapter.capture(iblVisualSceneCase);
    if (!forgeaxIbl.ok || !threeIbl.ok) {
      visualEvidenceErrors.push('ibl-constant-environment: independent visual capture is unavailable');
    } else {
      visualEvidenceInputs.push({
        caseId: iblVisualSceneCase.caseId,
        width: iblVisualSceneCase.scene.width,
        height: iblVisualSceneCase.scene.height,
        background: iblVisualSceneCase.scene.background,
        framing: 'orthographic-center',
        provenance: { forgeax: forgeaxIbl.value.provenance, three: threeIbl.value.provenance },
        captures: { forgeax: forgeaxIbl.value.captures, three: threeIbl.value.captures },
        metrics: { analyticMax: 0, roiMax: 0, differingBytes: 0 },
        verdict: 'notRun',
        status: 'partial',
        frameId: 0,
      });
    }
  } catch (error) {
    visualEvidenceErrors.push(`ibl-constant-environment: ${error instanceof Error ? error.message : String(error)}`);
  }
  const auxiliaryCaseStatuses = {
    [constantEnvironment.caseId]: iblPass ? 'pass' : 'failed',
    ...Object.fromEntries(
      transparencyResult?.cases.map((entry) => [entry.caseId, entry.passed ? 'pass' : 'failed']) ?? [],
    ),
  };
  const auxiliaryOk = iblPass && transparencyResult?.ok === true && auxiliaryErrors.length === 0;
  const alphaCoverage = getM2AlphaCoverage();
  const toneCaptures = new Map(
    result.cases
      .filter((entry) => TONE_CASES_BY_ID.has(entry.caseId))
      .map((entry) => [entry.caseId, entry.report.captures.forgeax.final]),
  );
  const toneRamp = inspectToneRamp(TONE_REQUIRED_CASES, toneCaptures);
  const capturedPipelineIds = [
    ...new Set(
      result.cases.flatMap((entry) => {
        const pipelineId = entry.report.attachmentEvidence?.linearHdr.pipelineId;
        return pipelineId === undefined ? [] : [pipelineId.replace(/^forgeax::/, '')];
      }),
    ),
  ];
  const missingPipelineIds = ['urp', 'hdrp'].filter((pipelineId) => !capturedPipelineIds.includes(pipelineId));
  const directLightEvidence = {
    requiredCaseIds: m4DirectLightCases.map((entry) => entry.caseId),
    requiredPipelineIds: ['urp', 'hdrp'],
    capturedPipelineIds,
    missingPipelineIds,
    status: missingPipelineIds.length === 0 ? 'complete' as const : 'partial' as const,
    complete: missingPipelineIds.length === 0,
    ...(missingPipelineIds.length === 0
      ? {}
      : { reason: `missing ${missingPipelineIds.join(', ')} producer evidence; Dawn owns the downstream capture` }),
  };
  const caseStatuses = Object.fromEntries(
    [
      ...result.cases.map((entry) => [entry.caseId, entry.passed ? 'pass' : 'failed']),
      ...Object.entries(auxiliaryCaseStatuses),
    ],
  );
  const caseBackendStatuses = Object.fromEntries(
    Object.entries(caseStatuses).map(([caseId, status]) => [caseId, { 'browser-webgpu': status }]),
  );
  const missingCaseIds = PARITY_REQUIRED_CASES
    .map((entry) => entry.caseId)
    .filter((caseId) => caseStatuses[caseId] !== 'pass');
  const missingRequiredPipelineIds = PARITY_REQUIRED_PIPELINE_IDS.filter((pipelineId) => {
    const normalizedPipelineId = `forgeax::${pipelineId}`;
    return !capturedPipelineIds.includes(pipelineId) && !capturedPipelineIds.includes(normalizedPipelineId);
  });
  const browserStageOk = result.ok
    && alphaCoverage.complete
    && toneRamp.ok
    && auxiliaryOk
    && missingCaseIds.length === 0;
  const browserStageStatus = result.cases.some((entry) => !entry.passed) || !auxiliaryOk
    ? 'failed' as const
    : browserStageOk ? 'complete' as const : 'partial' as const;
  const status = browserStageStatus === 'failed'
    ? 'failed'
    : browserStageOk && missingRequiredPipelineIds.length === 0 ? 'complete' : 'partial';
  const pipelineEvidenceInputs = result.cases.flatMap((entry) => {
    const sceneCase = m4DirectLightCasesById.get(entry.caseId);
    const observations = entry.report.attachmentEvidence;
    const metadata = directProducerMetadata.get(entry.caseId);
    if (sceneCase?.pipeline?.identity !== 'urp' || observations === undefined || metadata === undefined) return [];
    if (
      observations.linearHdr.status !== 'ready'
      || observations.finalDisplay.status !== 'ready'
      || observations.linearHdr.format === undefined
      || observations.linearHdr.size === undefined
      || observations.linearHdr.frameId === undefined
      || observations.linearHdr.pipelineId === undefined
      || observations.linearHdr.backendId === undefined
      || observations.finalDisplay.format === undefined
      || observations.finalDisplay.size === undefined
      || observations.finalDisplay.frameId === undefined
      || observations.finalDisplay.pipelineId === undefined
      || observations.finalDisplay.backendId === undefined
    ) return [];
    if (!(observations.linearHdr.bytes instanceof Uint8Array) || !(observations.finalDisplay.bytes instanceof Uint8Array)) return [];
    return [{
      invocationId,
      sceneCase,
      pipelineId: 'forgeax::urp' as const,
      runtimeId: 'browser' as const,
      backendId: observations.linearHdr.backendId,
      frameId: observations.linearHdr.frameId,
      copySrc: metadata.copySrc,
      lifetime: metadata.lifetime,
      provenance: entry.report.provenance.forgeax,
      normalization: {
        authorityId: 'threeR184SquaredWindow' as const,
        intensityScale: 1 as const,
        rangeModel: 'squared-finite' as const,
        coneModel: 'radians-to-degrees' as const,
      },
      linearHdr: {
        bytes: Array.from(observations.linearHdr.bytes),
        format: observations.linearHdr.format,
        size: observations.linearHdr.size,
        frameId: observations.linearHdr.frameId,
        pipelineId: observations.linearHdr.pipelineId,
        backendId: observations.linearHdr.backendId,
      },
      finalDisplay: {
        bytes: Array.from(observations.finalDisplay.bytes),
        format: observations.finalDisplay.format,
        size: observations.finalDisplay.size,
        frameId: observations.finalDisplay.frameId,
        pipelineId: observations.finalDisplay.pipelineId,
        backendId: observations.finalDisplay.backendId,
      },
    }];
  });
  return {
    invocationId,
    pipelineEvidenceInputs,
    stage: 'browser',
    requiredCases: [
      ...PARITY_REQUIRED_CASE_IDS,
    ],
    deferredMatrix: M1_DEFERRED_MATRIX,
    caseStatuses,
    caseBackendStatuses,
    auxiliaryEvidence: {
      ibl: iblEvidence === null ? null : serializeIblGpuCaseResult(iblEvidence),
      transparency: transparencyResult,
    },
    auxiliaryErrors,
    visualEvidenceInputs,
    visualEvidenceErrors,
    missingCaseIds,
    missingBackendIds: [],
    missingPipelineIds: [...new Set([...missingRequiredPipelineIds, ...missingPipelineIds])],
    alphaCoverage,
    toneRamp,
    directLightEvidence,
    ...result,
    browserStageOk,
    browserStageStatus,
    status,
    ok: browserStageOk && missingRequiredPipelineIds.length === 0,
  };
};

declare global {
  interface Window {
    __colorLightingWebkitParity?: (invocationId?: string) => Promise<unknown>;
  }
}

window.__colorLightingWebkitParity = async (invocationId = 'color-lighting-parity-webkit') => {
  if (typeof navigator !== 'undefined' && 'gpu' in navigator && navigator.gpu) {
    throw new Error('WebKit fallback runner requires navigator.gpu to be absent');
  }
  const sentinelIds = new Set([
    'default-srgb-texture',
    'material-alpha-mask-default',
    'material-alpha-blend',
    'tone-aces-filmic-2',
    'direct-directional-urp',
  ]);
  const sentinelCases = cases.filter((sceneCase) => sentinelIds.has(sceneCase.caseId));
  const fallback = await runParityMatrix(
    sentinelCases,
    createForgeaxAdapter((sceneCase) => captureForgeax(sceneCase, 'webgl'), 'webgl'),
    createThreeAdapter((sceneCase) => captureThree(sceneCase, 'webgl'), 'webgl'),
    { allowThreeWebglFallback: true },
  );
  const transparency = await runParityMatrix(
    [transparentLdrCase] as unknown as readonly SceneCase[],
    createForgeaxAdapter((sceneCase) => captureTransparencyForgeaxBrowser(sceneCase, 'webgl'), 'webgl'),
    createThreeAdapter((sceneCase) => captureTransparencyThreeBrowser(sceneCase, 'webgl'), 'webgl'),
    { allowThreeWebglFallback: true },
  );
  const allCases = [...fallback.cases, ...transparency.cases];
  return {
    invocationId,
    backendId: 'webkit-webgl2',
    executionStatus: 'complete',
    status: fallback.ok && transparency.ok ? 'pass' : 'failed',
    caseStatuses: Object.fromEntries(allCases.map((entry) => [entry.caseId, entry.passed ? 'pass' : 'failed'])),
    caseBackendStatuses: Object.fromEntries(
      allCases.map((entry) => [entry.caseId, { 'webkit-webgl2': entry.passed ? 'pass' : 'failed' }]),
    ),
    cases: allCases,
    provenance: {
      forgeax: { implementation: 'forgeax', version: 'workspace', renderer: 'webgl', adapterId: 'forgeax-wgpu-webgl2' },
      three: { implementation: 'three', version: 'r184', renderer: 'webgl', adapterId: 'three-r184-webgl-fallback' },
    },
  };
};
