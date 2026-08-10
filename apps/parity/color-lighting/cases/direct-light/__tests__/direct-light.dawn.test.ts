import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, PointLight, SpotLight, type Renderer } from '@forgeax/engine-render';
import { createRenderer } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { describe, expect, it } from 'vitest';
import { readbackLiveLinearHdr, readbackTexturePixels } from '../../../../../../packages/rhi-debug/src/readback';
import sceneCaseSchema from '../../../schemas/scene-case.schema.json' with { type: 'json' };
import { createForgeaxAdapter } from '../../../src/adapters/forgeax-adapter';
import { createThreeAdapter } from '../../../src/adapters/three-adapter';
import { projectObservation, validateAttachmentEvidence, type AttachmentEvidence } from '../../../src/capture/attachment-readback';
import { probeReadback } from '../../../src/capture/readback-probe';
import type { CaptureConfig } from '../../../src/capture/named-capture';
import { runParityMatrix } from '../../../src/cli/run-parity';
import { loadSceneCase } from '../../../src/contracts/load-scene-case';
import type { SceneCase } from '../../../src/contracts/types';
import { auditCrossPipelineEvidence, type PipelineAuditObservation } from '../../../src/report/status';
import { createPipelineEvidenceArtifact, writePipelineEvidence } from '../../../src/report/write-pipeline-evidence';

const dawnReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;
const casePaths = ['directional-urp', 'point-urp', 'spot-urp', 'khr-spot-urp'].map((name) =>
  resolve(import.meta.dirname, `../cases/${name}.json`),
);
const hdrpCasePaths = ['directional-hdrp', 'point-hdrp', 'spot-hdrp', 'khr-spot-hdrp'].map((name) =>
  resolve(import.meta.dirname, `../cases/${name}.json`),
);
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(sceneCaseSchema);
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const ENGINE_MANIFEST_URL = `data:application/json,${encodeURIComponent(JSON.stringify(ENGINE_MANIFEST))}`;

interface DawnSurface {
  readonly canvas: HTMLCanvasElement;
  readonly getTexture: () => GPUTexture;
  readonly getFormat: () => string;
}

interface CapturedProducerEvidence {
  readonly evidence: AttachmentEvidence;
  readonly pipelineId: 'forgeax::urp' | 'forgeax::hdrp';
  readonly copySrc: boolean;
  readonly lifetime: 'active' | 'retired';
  readonly size: { readonly width: number; readonly height: number };
}

function createDawnSurface(width: number, height: number): DawnSurface {
  let texture: GPUTexture | undefined;
  let format = 'rgba8unorm';
  const canvas = {
    width,
    height,
    getContext(kind: string): unknown {
      if (kind !== 'webgpu') return null;
      return {
        configure(desc: { device: GPUDevice; format?: GPUTextureFormat }) {
          format = desc.format ?? 'rgba8unorm';
          texture = desc.device.createTexture({
            size: { width, height, depthOrArrayLayers: 1 },
            format,
            usage: 0x10 | 0x01,
            viewFormats: [format === 'rgba8unorm' ? 'rgba8unorm-srgb' : 'bgra8unorm-srgb'],
          });
        },
        unconfigure() {},
        getCurrentTexture(): GPUTexture {
          if (texture === undefined) throw new Error('Dawn surface is not configured');
          return texture;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;
  return {
    canvas,
    getTexture: () => {
      if (texture === undefined) throw new Error('Dawn surface texture is unavailable');
      return texture;
    },
    getFormat: () => format,
  };
}

function spawnHdrpScene(world: World, sceneCase: SceneCase): void {
  const light = sceneCase.light;
  if (light === undefined) throw new Error(`HDRP case ${sceneCase.caseId} is missing light metadata`);
  const plane = createPlaneGeometry(2.8, 2.8);
  if (!plane.ok) throw new Error(`HDRP plane creation failed: ${plane.error.code}`);
  const meshHandle = world.allocSharedRef('MeshAsset', plane.value);
  const materialHandle = world.allocSharedRef('MaterialAsset', Materials.standard({
    baseColor: [0.7, 0.7, 0.7, 1],
    colorSpace: 'linear',
    metallic: 0,
    roughness: 1,
    castShadow: false,
    renderState: { cullMode: 'none' },
  }));
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1] } },
    { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 10 } },
  ).unwrap();
  world.spawn(
    { component: Transform, data: {} },
    { component: MeshFilter, data: { assetHandle: meshHandle } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  ).unwrap();
  const color = [light.color[0], light.color[1], light.color[2]] as [number, number, number];
  if (light.kind === 'directional') {
    world.spawn({ component: DirectionalLight, data: { direction: light.direction ?? [0, 0, -1], color, intensity: light.intensity, castShadow: false } }).unwrap();
    return;
  }
  if (light.kind === 'point') {
    world.spawn(
      { component: Transform, data: { pos: [0, 0, 2] } },
      { component: PointLight, data: { color, intensity: light.intensity, range: light.range ?? 10 } },
    ).unwrap();
    return;
  }
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 2] } },
    { component: SpotLight, data: {
      direction: light.direction ?? [0, 0, -1],
      color,
      intensity: light.intensity,
      range: light.range ?? 10,
      innerConeDeg: light.innerConeDeg ?? 0,
      outerConeDeg: light.outerConeDeg ?? 45,
      castShadow: false,
    } },
  ).unwrap();
}

async function readHdrpEvidence(
  renderer: Renderer,
  surface: DawnSurface,
  sceneCase: SceneCase,
  expectedPipelineId: 'forgeax::urp' | 'forgeax::hdrp',
): Promise<CapturedProducerEvidence> {
  const linearResult = await renderer.observeCurrentFrame({
    semantic: 'linear-hdr',
    readback: async (lease) => {
      const readback = await readbackLiveLinearHdr(renderer.device, lease);
      return readback.ok ? { ok: true, value: readback.value.bytes } : readback;
    },
  });
  if (!linearResult.ok) throw new Error(`HDRP linear readback failed: ${linearResult.error.code}`);
  if (linearResult.value.metadata.pipelineId !== expectedPipelineId) {
    throw new Error(`HDRP producer identity mismatch: ${linearResult.value.metadata.pipelineId}`);
  }
  const finalBytes = await readbackTexturePixels(
    renderer.device,
    surface.getTexture(),
    sceneCase.scene.width,
    sceneCase.scene.height,
    { bytesPerTexel: 4 },
  );
  const evidence = {
    linearHdr: projectObservation('linearHdr', {
      status: 'ready',
      bytes: linearResult.value.bytes,
      format: linearResult.value.metadata.format,
      size: linearResult.value.metadata.size,
      rawHash: hashBytes(linearResult.value.bytes),
      frameId: linearResult.value.metadata.frameId,
      pipelineId: linearResult.value.metadata.pipelineId,
      backendId: linearResult.value.metadata.backendId,
    }),
    finalDisplay: projectObservation('finalDisplay', {
      status: 'ready',
      bytes: finalBytes,
      format: surface.getFormat(),
      size: { width: sceneCase.scene.width, height: sceneCase.scene.height },
      rawHash: hashBytes(finalBytes),
      frameId: linearResult.value.metadata.frameId,
      pipelineId: linearResult.value.metadata.pipelineId,
      backendId: linearResult.value.metadata.backendId,
    }),
  };
  return {
    evidence,
    pipelineId: linearResult.value.metadata.pipelineId,
    copySrc: (linearResult.value.metadata.usage & 0x01) !== 0,
    lifetime: linearResult.value.metadata.lifetime.state,
    size: linearResult.value.metadata.size,
  };
}

async function capturePipelineEvidence(
  sceneCase: SceneCase,
  pipelineId: 'forgeax::urp' | 'forgeax::hdrp',
): Promise<CapturedProducerEvidence> {
  const surface = createDawnSurface(sceneCase.scene.width, sceneCase.scene.height);
  const renderer = await createRenderer(surface.canvas, {}, { shaderManifestUrl: ENGINE_MANIFEST_URL });
  try {
    const ready = await renderer.ready;
    if (!ready.ok) throw new Error(`HDRP renderer unavailable: ${ready.error.code}`);
    if (pipelineId === 'forgeax::hdrp') {
      const install = renderer.installPipeline({
        kind: 'render-pipeline',
        pipelineId,
        config: { clusterGrid: { x: 16, y: 9, z: 24 } },
      });
      if (!install.ok) throw new Error(`HDRP install failed: ${install.error.code}`);
    }
    const world = new World();
    spawnHdrpScene(world, sceneCase);
    renderer.draw([world], { owner: 0 });
    return await readHdrpEvidence(renderer, surface, sceneCase, pipelineId);
  } finally {
    renderer.dispose();
  }
}

function hashBytes(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function producerArtifactPath(basePath: string, caseId: string): string {
  return basePath.endsWith('.json')
    ? `${basePath.slice(0, -'.json'.length)}-${caseId}.json`
    : `${basePath}-${caseId}.json`;
}

async function createHdrpArtifact(
  sceneCase: SceneCase,
  capture: CapturedProducerEvidence,
): Promise<Awaited<ReturnType<typeof createPipelineEvidenceArtifact>>> {
  const linearHdr = capture.evidence.linearHdr;
  const finalDisplay = capture.evidence.finalDisplay;
  if (
    linearHdr.bytes === undefined
    || linearHdr.format === undefined
    || linearHdr.size === undefined
    || linearHdr.frameId === undefined
    || linearHdr.backendId === undefined
    || finalDisplay.bytes === undefined
    || finalDisplay.format === undefined
    || finalDisplay.size === undefined
  ) throw new Error(`HDRP producer evidence is incomplete for ${sceneCase.caseId}`);
  return createPipelineEvidenceArtifact({
    invocationId: process.env.FORGEAX_PARITY_INVOCATION_ID ?? 'm4-dawn-artifact-contract',
    sceneCase,
    pipelineId: capture.pipelineId,
    runtimeId: 'dawn',
    backendId: linearHdr.backendId,
    frameId: linearHdr.frameId,
    copySrc: capture.copySrc,
    lifetime: capture.lifetime,
    provenance: {
      implementation: 'forgeax',
      version: 'workspace',
      renderer: 'dawn',
      adapterId: 'forgeax-dawn-hdrp',
    },
    normalization: {
      authorityId: 'threeR184SquaredWindow',
      intensityScale: 1,
      rangeModel: 'squared-finite',
      coneModel: 'radians-to-degrees',
    },
    linearHdr,
    finalDisplay,
  });
}

function toAuditObservation(
  caseId: string,
  capture: CapturedProducerEvidence,
): PipelineAuditObservation {
  return {
    caseId,
    pipelineId: capture.pipelineId,
    evidence: capture.evidence,
    semantic: 'linear-hdr',
    source: 'live-producer',
    copySrc: capture.copySrc,
    lifetime: capture.lifetime,
    size: capture.size,
    normalization: {
      authorityId: 'threeR184SquaredWindow',
      intensityScale: 1,
      rangeModel: 'squared-finite',
      coneModel: 'radians-to-degrees',
    },
  };
}

describe('direct-light Dawn evidence contract', () => {
  it('loads the required light, import, pipeline, and finite budget fields', async () => {
    const cases = await Promise.all(casePaths.map(async (path) => {
      const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      expect(validate(value)).toBe(true);
      const result = await loadSceneCase(path);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.hint);
      return result.value;
    }));
    expect(cases.every((sceneCase) => sceneCase.pipeline?.identity === 'urp')).toBe(true);
    expect(cases.every((sceneCase) => sceneCase.light?.authorityId === 'threeR184SquaredWindow')).toBe(true);
    expect(cases.every((sceneCase) => sceneCase.import?.intensityScale === 1)).toBe(true);
    expect(cases.every((sceneCase) => Number.isFinite(sceneCase.budget.analyticMax))).toBe(true);
  });

  it('does not promote a final-only Dawn readback to paired parity evidence', () => {
    const probe = probeReadback({
      finalReadbackAvailable: true,
      linearReadbackAvailable: false,
      namedAttachmentAvailable: false,
      rawHashAvailable: true,
    });
    expect(probe.source).toBe('unavailable');
    expect(probe.linearReadback).toBe(false);
  });

  it('keeps light metadata and readback status in the case report', async () => {
    const loaded = await loadSceneCase(casePaths[0]!);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error.hint);
    const sceneCase = loaded.value;
    const config: CaptureConfig = {
      width: sceneCase.scene.width,
      height: sceneCase.scene.height,
      colorDomain: sceneCase.colorDomain,
      background: sceneCase.scene.background,
      ...(sceneCase.pipeline === undefined ? {} : { pipeline: sceneCase.pipeline.identity }),
      readback: probeReadback({
        finalReadbackAvailable: true,
        linearReadbackAvailable: false,
        namedAttachmentAvailable: false,
        rawHashAvailable: true,
      }),
    };
    const capture = { linear: [], final: [0, 0, 0, 255], config };
    const result = await runParityMatrix(
      [sceneCase],
      createForgeaxAdapter(async () => capture),
      createThreeAdapter(async () => capture),
      { expectedErrors: { [sceneCase.caseId]: 'status-incomplete' } },
    );
    const report = result.cases[0]?.report;
    expect(result.ok).toBe(true);
    expect(report?.pipeline?.engineId).toBe('forgeax::urp');
    expect(report?.light?.kind).toBe('directional');
    expect(report?.import?.intensityScale).toBe(1);
    expect(report?.readback).toEqual({ forgeax: 'unavailable', three: 'unavailable' });
    expect(report?.status).toBe('partial');
  });

  it.skipIf(!dawnReady)('requires a real Dawn adapter before evidence can be recorded', async () => {
    const adapter = await navigator.gpu.requestAdapter();
    expect(adapter).not.toBeNull();
  });

  it('captures independent HDRP producer evidence for every required case', async () => {
    if (!dawnReady) throw new Error('dawn-node navigator.gpu is required for HDRP producer evidence');
    const cases = await Promise.all(hdrpCasePaths.map(async (path) => {
      const result = await loadSceneCase(path);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.hint);
      return result.value;
    }));
    expect(cases.every((sceneCase) => sceneCase.pipeline?.identity === 'hdrp')).toBe(true);
    for (const [index, sceneCase] of cases.entries()) {
      const urpCapture = await capturePipelineEvidence(sceneCase, 'forgeax::urp');
      const hdrpCapture = await capturePipelineEvidence(sceneCase, 'forgeax::hdrp');
      const evidence = hdrpCapture.evidence;
      const sharedCaseId = sceneCase.caseId.replace(/-(urp|hdrp)$/, '');
      const audit = auditCrossPipelineEvidence({
        caseId: sharedCaseId,
        size: sceneCase.scene,
        missingPipelineIds: [],
        urp: toAuditObservation(sharedCaseId, urpCapture),
        hdrp: toAuditObservation(sharedCaseId, hdrpCapture),
      });
      expect(audit.reasons, audit.reasons.join('; ')).toEqual([]);
      expect(audit.missingPipelineIds).toEqual([]);
      expect(audit.firstDivergence).not.toBeNull();
      const evidenceValidation = validateAttachmentEvidence(evidence, 'forgeax::hdrp');
      expect(evidenceValidation.ok).toBe(true);
      expect(evidence.linearHdr.status).toBe('ready');
      expect(evidence.linearHdr.format).toBe('rgba16float');
      expect(evidence.linearHdr.bytes?.byteLength).toBeGreaterThan(0);
      expect(evidence.linearHdr.rawHash).toMatch(/^[0-9a-f]{8,}$/);
      expect(evidence.linearHdr.pipelineId).toBe('forgeax::hdrp');
      expect(evidence.finalDisplay.status).toBe('ready');
      expect(evidence.finalDisplay.format).toMatch(/^(rgba|bgra)8unorm$/);
      expect(evidence.finalDisplay.bytes?.byteLength).toBeGreaterThan(0);
      expect(evidence.finalDisplay.rawHash).toMatch(/^[0-9a-f]{8,}$/);
      expect(evidence.finalDisplay.rawHash).not.toBe(evidence.linearHdr.rawHash);
      const linearBytes = evidence.linearHdr.bytes;
      const finalBytes = evidence.finalDisplay.bytes;
      if (!(linearBytes instanceof Uint8Array) || !(finalBytes instanceof Uint8Array)) {
        throw new Error(`HDRP evidence bytes are unavailable for ${sceneCase.caseId}`);
      }
      const forgeaxConfig: CaptureConfig = {
        width: sceneCase.scene.width,
        height: sceneCase.scene.height,
        colorDomain: sceneCase.colorDomain,
        background: sceneCase.scene.background,
        pipeline: 'hdrp',
        readback: {
          source: 'rhi-debug',
          linearReadback: true,
          finalReadback: true,
          namedAttachment: true,
          rawHash: true,
          requiresRhiDebugExtension: false,
        },
      };
      const threeConfig: CaptureConfig = {
        width: sceneCase.scene.width,
        height: sceneCase.scene.height,
        colorDomain: sceneCase.colorDomain,
        background: sceneCase.scene.background,
        pipeline: 'hdrp',
        readback: probeReadback({
          finalReadbackAvailable: true,
          linearReadbackAvailable: false,
          namedAttachmentAvailable: false,
          rawHashAvailable: true,
        }),
      };
      const reportResult = await runParityMatrix(
        [sceneCase],
        createForgeaxAdapter(async () => ({
          linear: Array.from(linearBytes),
          final: Array.from(finalBytes),
          config: forgeaxConfig,
          observations: evidence,
        })),
        createThreeAdapter(async () => ({ linear: [], final: [], config: threeConfig })),
        { expectedErrors: { [sceneCase.caseId]: 'status-incomplete' } },
      );
      expect(reportResult.ok).toBe(true);
      const report = reportResult.cases[0]?.report;
      expect(report?.attachmentEvidence?.linearHdr.pipelineId).toBe('forgeax::hdrp');
      expect(report?.attachmentEvidence?.finalDisplay.pipelineId).toBe('forgeax::hdrp');
      expect(report?.status).toBe('partial');
      const sourceCaseResult = await loadSceneCase(casePaths[index]!);
      expect(sourceCaseResult.ok).toBe(true);
      if (!sourceCaseResult.ok) throw new Error(sourceCaseResult.error.hint);
      const outputPath = process.env.FORGEAX_PARITY_HDRP_ARTIFACT;
      if (outputPath !== undefined) {
        await writePipelineEvidence(
          producerArtifactPath(outputPath, sourceCaseResult.value.caseId),
          await createHdrpArtifact(sourceCaseResult.value, hdrpCapture),
        );
      }
    }
  }, 120_000);

  it('projects a live HDRP capture into an explicit artifact', async () => {
    if (!dawnReady) throw new Error('dawn-node navigator.gpu is required for HDRP producer evidence');
    const loaded = await loadSceneCase(casePaths[0]!);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error.hint);
    const capture = await capturePipelineEvidence(loaded.value, 'forgeax::hdrp');
    const artifact = await createHdrpArtifact(loaded.value, capture);
    expect(artifact.pipelineId).toBe('forgeax::hdrp');
    expect(artifact.runtimeId).toBe('dawn');
    expect(artifact.source).toBe('live-producer');
    expect(artifact.linearHdr.bytes).toEqual(Array.from(capture.evidence.linearHdr.bytes ?? []));
  }, 120_000);
});
