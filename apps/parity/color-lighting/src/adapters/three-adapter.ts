import type { SceneCase } from '../contracts/types';
import { createNamedCaptures, type CaptureConfig, type CaptureEnvelope } from '../capture/named-capture';
import type { CaptureValidationResult } from '../capture/named-capture';
import type { ThreeR184ToneMode } from '../analytic/three-r184-tonemap';

export interface ThreeCaptureOutput {
  readonly linear: readonly number[];
  readonly final: readonly number[];
  readonly config: CaptureConfig;
}

export interface ThreeAdapter {
  readonly id: 'three-r184-webgpu' | 'three-r184-webgl-fallback';
  capture(sceneCase: SceneCase): Promise<CaptureValidationResult<CaptureEnvelope>>;
}

export function threeToneMappingId(mode: ThreeR184ToneMode): number {
  switch (mode) {
    case 'linear': return 1;
    case 'reinhard': return 2;
    case 'cineon': return 3;
    case 'aces-filmic': return 4;
    case 'agx': return 6;
    case 'neutral': return 7;
  }
}

export function createThreeAdapter(
  run: (sceneCase: SceneCase) => Promise<ThreeCaptureOutput>,
  renderer: 'webgpu' | 'webgl' = 'webgpu',
): ThreeAdapter {
  const id = renderer === 'webgpu' ? 'three-r184-webgpu' : 'three-r184-webgl-fallback';
  return {
    id,
    async capture(sceneCase) {
      const output = await run(sceneCase);
      const captures = await createNamedCaptures(output.linear, output.final);
      const pipeline = output.config.pipeline ?? sceneCase.pipeline?.identity;
      return {
        ok: true,
        value: {
          side: 'three',
          role: renderer === 'webgpu' ? 'primary' : 'fallback',
          adapterId: id,
          provenance: { implementation: 'three', version: 'r184', renderer, adapterId: id },
          config: { ...output.config, ...(pipeline === undefined ? {} : { pipeline }) },
          captures,
          ...(output.config.readback === undefined ? {} : { readback: output.config.readback }),
        },
      };
    },
  };
}
