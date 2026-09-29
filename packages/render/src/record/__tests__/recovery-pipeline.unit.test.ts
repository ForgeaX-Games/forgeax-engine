import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { describe, expect, it } from 'vitest';
import { makeZeroCameraFallbackSnapshot, type ValidatedRenderable } from '../frame-snapshot';
import {
  createRecoveryColdWorkGuard,
  prepareRecoveryPipelineReadiness,
} from '../recovery-pipeline';
import type { PipelineState, RenderSystemInternals } from '../render-context';

function probeRenderable(probe: boolean): ValidatedRenderable {
  const material = {
    baseColor: [1, 1, 1],
    metallic: 0,
    roughness: 1,
    materialShaderId: 'forgeax::default-standard-pbr',
  } as never;
  return {
    source: {
      material,
      materials: [material],
      ...(probe ? { probeBlendRecord: {} } : {}),
    },
    mesh: {
      layoutProjection: deriveVertexLayoutProjection({
        position: new Float32Array(0),
        normal: new Float32Array(0),
        uv: new Float32Array(0),
        tangent: new Float32Array(0),
      }),
      indexFormat: 'uint32',
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 3,
          topology: 'triangle-list',
          materialSlot: 0,
        },
      ],
    },
  } as never;
}

function recoveryReadinessFor(
  renderable: ValidatedRenderable,
  reflectionFallbackAvailable = false,
) {
  const pipeline = {} as never;
  const internals = {
    device: { caps: { backendKind: 'webgpu', storageBuffer: true } },
    getMaterialShaderPipelineEntry: (..._args: unknown[]) => ({
      pipeline,
      group2Contract: 'cluster' as const,
    }),
  } as unknown as RenderSystemInternals;
  const pipelineState = {
    colorAttachmentFormat: 'bgra8unorm',
  } as unknown as PipelineState;
  return prepareRecoveryPipelineReadiness({
    internals,
    pipelineState,
    camera: makeZeroCameraFallbackSnapshot(),
    standardLighting: { kind: 'no-local-lights' } as never,
    validated: [renderable],
    dispatch: [],
    shadowCastersActive: false,
    splitLdrSprite: false,
    reflectionFallbackAvailable,
  });
}

describe('recovery prepared pipeline cache', () => {
  it('prepares the probe-enabled Standard PBR variant used by the live record path', () => {
    const readiness = recoveryReadinessFor(probeRenderable(true));
    const standardPbr = readiness.pipelineSpecs.find(
      (spec) => spec.shader.id === 'forgeax::default-standard-pbr',
    );

    expect(standardPbr?.shader.variantSet).toContain('PROBE_BLEND_AVAILABLE=true');
  });

  it('does not add the probe ABI to a Standard PBR renderable without a record', () => {
    const readiness = recoveryReadinessFor(probeRenderable(false));
    const standardPbr = readiness.pipelineSpecs.find(
      (spec) => spec.shader.id === 'forgeax::default-standard-pbr',
    );

    expect(standardPbr?.shader.variantSet).not.toContain('PROBE_BLEND_AVAILABLE=true');
  });

  it('prepares the Standard PBR reflection fallback MRT variant', () => {
    const readiness = recoveryReadinessFor(probeRenderable(false), true);
    const standardPbr = readiness.pipelineSpecs.find(
      (spec) => spec.shader.id === 'forgeax::default-standard-pbr',
    );

    expect(standardPbr?.shader.variantSet).toContain('REFLECTION_FALLBACK_AVAILABLE=true');
    expect(standardPbr?.attachments.colorFormats).toEqual(['rgba16float', 'rgba16float']);
  });
  it('allows explicit candidate uploads between recovery publication and the first draw', () => {
    const guard = createRecoveryColdWorkGuard();
    guard.arm();
    expect(() => guard.noteUploadColdWork()).not.toThrow();
  });

  it('keeps the first-submit assertion across a skipped draw and releases its recording scope', () => {
    const guard = createRecoveryColdWorkGuard();
    guard.arm();
    guard.beginFrame();
    guard.endFrame();
    expect(() => guard.noteUploadColdWork()).not.toThrow();
    guard.beginFrame();
    expect(() => guard.noteUploadColdWork()).toThrow(/cold upload/);
    guard.endFrame();
    expect(() => guard.noteUploadColdWork()).not.toThrow();
  });

  it('accepts a prepared candidate with no first-frame cold work', () => {
    const guard = createRecoveryColdWorkGuard();

    guard.arm();
    guard.beginFrame();
    expect(() => guard.finish()).not.toThrow();
    expect(() => guard.finish()).not.toThrow();
  });

  it.each([
    [
      'pipeline',
      (guard: ReturnType<typeof createRecoveryColdWorkGuard>) => guard.notePipelineColdWork(),
    ],
    [
      'upload',
      (guard: ReturnType<typeof createRecoveryColdWorkGuard>) => guard.noteUploadColdWork(),
    ],
  ] as const)('hard-fails a first-frame %s miss before submission', (_kind, note) => {
    const guard = createRecoveryColdWorkGuard();

    guard.arm();
    guard.beginFrame();
    expect(() => note(guard)).toThrow(/recovery first frame performed cold/);
  });
});
