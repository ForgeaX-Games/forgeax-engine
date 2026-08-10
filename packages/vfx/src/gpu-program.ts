import type { BindGroupLayoutDescriptor, ParticleEffectAsset } from '@forgeax/engine-types';
import type { ParticleEmitterSourceV2 } from './code-source.js';

export const VFX_GPU_PROGRAM_FORMAT = 'forgeax-vfx-program-2' as const;
export const VFX_GPU_PROGRAM_ARTIFACT_KEY = 'particle-effect/program.json' as const;

export interface VfxGpuProgramReflection {
  readonly hooks: readonly ['vfx_spawn', 'vfx_update'];
  readonly imports: readonly string[];
  readonly resources: readonly string[];
  readonly entryPoints: readonly string[];
  readonly bindings: readonly BindGroupLayoutDescriptor[];
}

export interface VfxGpuEmitterProgram {
  readonly id: string;
  readonly capacity: number;
  readonly backend: ParticleEmitterSourceV2['backend'];
  readonly space: ParticleEmitterSourceV2['space'];
  readonly schedule: ParticleEmitterSourceV2['schedule'];
  readonly bounds: ParticleEmitterSourceV2['bounds'];
  readonly renderers: ParticleEmitterSourceV2['renderers'];
  readonly simulationWhenCulled: 'continue' | 'pause' | 'restart-on-visible';
  readonly wgsl: string;
  readonly reflection: VfxGpuProgramReflection;
}

export interface VfxGpuProgram {
  readonly format: typeof VFX_GPU_PROGRAM_FORMAT;
  readonly fingerprint: string;
  readonly emitters: readonly VfxGpuEmitterProgram[];
}

export interface VfxGpuEffectAsset extends ParticleEffectAsset {
  readonly program: VfxGpuProgram;
}
