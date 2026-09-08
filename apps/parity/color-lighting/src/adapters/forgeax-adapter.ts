import type {
  SceneCase,
  VertexColorBackend,
  VertexColorCaptureOutput,
  VertexColorProducerIdentity,
  VertexColorSemanticFixture,
} from '../contracts/types';
import { VERTEX_COLOR_REQUIRED_CASES } from '../coverage/required-cases';
import { createNamedCaptures, type CaptureConfig, type CaptureEnvelope } from '../capture/named-capture';
import type { CaptureValidationResult } from '../capture/named-capture';
import type { AttachmentEvidence } from '../capture/attachment-readback';

export interface ForgeaxCaptureOutput {
  readonly linear: readonly number[];
  readonly final: readonly number[];
  readonly config: CaptureConfig;
  readonly observations?: AttachmentEvidence;
}

export interface ForgeaxAdapter {
  readonly id: 'forgeax-webgpu' | 'forgeax-wgpu-webgl2';
  capture(sceneCase: SceneCase): Promise<CaptureValidationResult<CaptureEnvelope>>;
}

export interface VertexColorForgeaxProducer {
  readonly identity: VertexColorProducerIdentity;
  capture(fixture: VertexColorSemanticFixture, backend: VertexColorBackend): Promise<VertexColorCaptureOutput>;
}

export function createVertexColorForgeaxProducer(
  run: (fixture: VertexColorSemanticFixture, backend: VertexColorBackend) => Promise<VertexColorCaptureOutput>,
  sourceSha = 'workspace-source',
): VertexColorForgeaxProducer {
  const identity: VertexColorProducerIdentity = {
    implementation: 'forgeax',
    version: 'workspace',
    renderer: 'webgpu',
    adapterId: 'forgeax-vertex-color-webgpu',
    pinnedCommit: sourceSha,
    buildIdentity: 'forgeax-browser-and-dawn-vertex-color',
  };
  return {
    identity,
    async capture(fixture, backend) {
      const output = await run(fixture, backend);
      if (output.backend !== backend) throw new Error('ForgeaX vertex-color backend provenance mismatch');
      if (output.frameCount !== 300) throw new Error('ForgeaX vertex-color capture requires 300 frames');
      if (output.sourceSha !== sourceSha) throw new Error('ForgeaX vertex-color source SHA mismatch');
      const expectedHash = VERTEX_COLOR_REQUIRED_CASES.find((entry) => entry.caseId === fixture.caseId)?.sourceFixtureHash;
      if (expectedHash === undefined || output.sourceFixtureHash !== expectedHash) throw new Error('ForgeaX vertex-color fixture hash mismatch');
      if (output.colorDomain !== fixture.colorDomain) throw new Error('ForgeaX vertex-color domain mismatch');
      validateVertexColorSamples(fixture, output);
      return output;
    },
  };
}

function validateVertexColorSamples(fixture: VertexColorSemanticFixture, output: VertexColorCaptureOutput): void {
  if (output.final.length === 0 || output.linear.length === 0 || output.readback !== 'copyTextureToBuffer') {
    throw new Error('vertex-color producer readback is incomplete');
  }
  const expectedIds = new Set(fixture.samplePoints.map((sample) => sample.id));
  if (output.samples.length !== expectedIds.size || output.samples.some((sample) => !expectedIds.has(sample.id))) {
    throw new Error('vertex-color producer samples do not match the semantic fixture');
  }
  if (output.samples.some((sample) => sample.rgba.some((channel) => !Number.isFinite(channel)))) {
    throw new Error('vertex-color producer sample is non-finite');
  }
}

export function createForgeaxAdapter(
  run: (sceneCase: SceneCase) => Promise<ForgeaxCaptureOutput>,
  renderer: 'webgpu' | 'webgl' = 'webgpu',
): ForgeaxAdapter {
  const id = renderer === 'webgpu' ? 'forgeax-webgpu' : 'forgeax-wgpu-webgl2';
  return {
    id,
    async capture(sceneCase) {
      const output = await run(sceneCase);
      const captures = await createNamedCaptures(output.linear, output.final);
      const pipeline = output.config.pipeline ?? sceneCase.pipeline?.identity;
      return {
        ok: true,
        value: {
          side: 'forgeax',
          role: 'primary',
          adapterId: id,
          provenance: { implementation: 'forgeax', version: 'workspace', renderer, adapterId: id },
          config: { ...output.config, ...(pipeline === undefined ? {} : { pipeline }) },
          captures,
          ...(output.config.readback === undefined ? {} : { readback: output.config.readback }),
          ...(output.observations === undefined ? {} : { observations: output.observations }),
        },
      };
    },
  };
}
