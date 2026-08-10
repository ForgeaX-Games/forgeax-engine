import type { SceneCase } from '../contracts/types';
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
