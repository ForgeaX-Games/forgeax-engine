import type { BindGroupLayoutDescriptor, ParticleEffectAsset } from '@forgeax/engine-types';
import type {
  ParticleChannelSource,
  ParticleEmitterSourceV2,
  ParticleEventSource,
  ParticleRendererSource,
} from './code-source.js';
import type { VfxDataInterfaceRequirement } from './data-interface.js';
import type { VfxEffectReflection } from './effect-contract.js';

export const VFX_GPU_PROGRAM_FORMAT = 'forgeax-vfx-program-2' as const;
export const VFX_GPU_PROGRAM_ARTIFACT_KEY = 'particle-effect/program.json' as const;

export interface VfxGpuStageReflection {
  readonly id: string;
  readonly entry: string;
  readonly entryPoint: string;
  readonly domain: 'particle';
  readonly resources: readonly {
    readonly name: string;
    readonly access: 'read' | 'write' | 'read-write';
  }[];
  readonly dependsOn: readonly string[];
  readonly iterationBudget: number;
}

export interface VfxGpuRendererReflection {
  readonly topology: ParticleRendererSource['kind'];
  readonly resource: string;
  readonly capacity: number;
  readonly overflow: 'drop-newest' | 'drop-oldest';
  readonly enabled: boolean;
  readonly shaderInputs: readonly string[];
  readonly textureSheet?: {
    readonly columns: number;
    readonly rows: number;
    readonly frameRate: number;
    readonly frameCount: number;
  };
  readonly pivot?: readonly [number, number];
  readonly softParticle?: { readonly fadeDistance: number; readonly requiresDepth: true };
  readonly sorting?: 'none' | 'emitter' | 'back-to-front';
  readonly stripKey?: 'alive-index';
  readonly historyLength?: number;
  readonly endpointField?: 'velocity';
}

export interface VfxGpuProgramReflection {
  readonly hooks: readonly ['vfx_spawn', 'vfx_update'];
  readonly imports: readonly string[];
  readonly resources: readonly string[];
  readonly entryPoints: readonly string[];
  readonly bindings: readonly BindGroupLayoutDescriptor[];
  readonly layout?: VfxEffectReflection;
  readonly dataInterfaces?: readonly VfxDataInterfaceRequirement[];
  readonly eventChannels?: readonly ParticleChannelSource[];
  readonly events?: readonly ParticleEventSource[];
  readonly eventEntryPoint?: 'forgeax_vfx_event_main';
  readonly stages?: readonly VfxGpuStageReflection[];
  readonly renderers?: readonly VfxGpuRendererReflection[];
}

export interface VfxGpuEmitterProgram {
  readonly id: string;
  readonly module: string;
  readonly capacity: number;
  readonly backend: ParticleEmitterSourceV2['backend'];
  readonly space: ParticleEmitterSourceV2['space'];
  readonly schedule: ParticleEmitterSourceV2['schedule'];
  readonly bounds: ParticleEmitterSourceV2['bounds'];
  readonly renderers: ParticleEmitterSourceV2['renderers'];
  readonly channels?: readonly ParticleChannelSource[];
  readonly events?: readonly ParticleEventSource[];
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
  readonly guid: string;
  readonly program: VfxGpuProgram;
}
