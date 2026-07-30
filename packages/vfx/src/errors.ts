import type { ParticleBackend, ParticleOperatorStage, ParticleSourceError } from './source.js';

export type { ParticleSourceError } from './source.js';

export interface ParticleOperatorKey {
  readonly stage: ParticleOperatorStage;
  readonly kind: string;
  readonly version: number;
}

export interface VfxOperatorUnknownDetail extends ParticleOperatorKey {
  readonly emitterId?: string;
}

export interface VfxOperatorBackendUnsupportedDetail {
  readonly emitterId: string;
  readonly operator: ParticleOperatorKey;
  readonly backend: ParticleBackend;
}

export interface VfxProgramInvalidDetail {
  readonly emitterId: string;
  readonly path: string;
  readonly format: 'forgeax-vfx-program-1';
}

export interface VfxBatchInvalidDetail {
  readonly output: string;
  readonly index: number;
  readonly path: string;
}

/** Identifies a backend capability that the cooked simulation policy requires. */
export interface VfxSimulationCapabilityUnavailableDetail {
  readonly player: number;
  readonly emitterId: string;
  readonly stage: ParticleOperatorStage;
  readonly backend: ParticleBackend;
  readonly plan: string;
}

/** Identifies an invalid author-intent field and the value that must be repaired. */
export interface VfxSimulationPlayerInvalidDetail {
  readonly player: number;
  readonly field: string;
  readonly value: unknown;
}

/** Identifies a missing or wrong-kind output dependency at its output stage. */
export interface VfxSimulationOutputUnavailableDetail {
  readonly player: number;
  readonly emitterId: string;
  readonly stage: ParticleOperatorStage;
  readonly reference: string;
  readonly expectedKind: 'material' | 'mesh';
}

/** Identifies the executor stage and operator that rejected a cooked program. */
export interface VfxSimulationExecutionFailedDetail {
  readonly player: number;
  readonly emitterId: string;
  readonly stage: ParticleOperatorStage;
  readonly operator: string;
  readonly reason: string;
}

export interface VfxCause {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
}

export type VfxAssetLoadDetail =
  | {
      readonly guid: string;
      readonly stage: 'package';
      readonly packageUrl: string;
      readonly cause: VfxCause;
    }
  | {
      readonly guid: string;
      readonly stage: 'artifact';
      readonly packageUrl: string;
      readonly artifact: string;
      readonly cause: VfxCause;
    }
  | {
      readonly guid: string;
      readonly stage: 'reference';
      readonly reference: string;
      readonly cause: VfxCause;
    };

export type VfxErrorCode =
  | 'vfx-source-invalid'
  | 'vfx-operator-unknown'
  | 'vfx-operator-backend-unsupported'
  | 'vfx-program-invalid'
  | 'vfx-batch-invalid'
  | 'vfx-asset-load-failed'
  | 'vfx-simulation-capability-unavailable'
  | 'vfx-simulation-player-invalid'
  | 'vfx-simulation-output-unavailable'
  | 'vfx-simulation-execution-failed';

export type VfxErrorDetailFor = {
  'vfx-source-invalid': ParticleSourceError['detail'];
  'vfx-operator-unknown': VfxOperatorUnknownDetail;
  'vfx-operator-backend-unsupported': VfxOperatorBackendUnsupportedDetail;
  'vfx-program-invalid': VfxProgramInvalidDetail;
  'vfx-batch-invalid': VfxBatchInvalidDetail;
  'vfx-asset-load-failed': VfxAssetLoadDetail;
  'vfx-simulation-capability-unavailable': VfxSimulationCapabilityUnavailableDetail;
  'vfx-simulation-player-invalid': VfxSimulationPlayerInvalidDetail;
  'vfx-simulation-output-unavailable': VfxSimulationOutputUnavailableDetail;
  'vfx-simulation-execution-failed': VfxSimulationExecutionFailedDetail;
};

export type VfxErrorFor<C extends VfxErrorCode> = {
  readonly code: C;
  readonly expected: string;
  readonly hint: string;
  readonly detail: VfxErrorDetailFor[C];
};

export type VfxError =
  | ParticleSourceError
  | VfxErrorFor<'vfx-operator-unknown'>
  | VfxErrorFor<'vfx-operator-backend-unsupported'>
  | VfxErrorFor<'vfx-program-invalid'>
  | VfxErrorFor<'vfx-batch-invalid'>
  | VfxErrorFor<'vfx-asset-load-failed'>
  | VfxErrorFor<'vfx-simulation-capability-unavailable'>
  | VfxErrorFor<'vfx-simulation-player-invalid'>
  | VfxErrorFor<'vfx-simulation-output-unavailable'>
  | VfxErrorFor<'vfx-simulation-execution-failed'>;

const expected: { readonly [C in VfxErrorCode]: string } = {
  'vfx-source-invalid': 'source matches the ParticleEffectSource schema',
  'vfx-operator-unknown': 'operator definition is registered',
  'vfx-operator-backend-unsupported': 'every operator and output has the declared backend compiler',
  'vfx-program-invalid': 'cooked program matches forgeax-vfx-program-1',
  'vfx-batch-invalid': 'batch attributes match the output count and variant',
  'vfx-asset-load-failed': 'package, artifact, and reference dependencies are ready',
  'vfx-simulation-capability-unavailable':
    'the cooked backend plan has a runtime executor capability',
  'vfx-simulation-player-invalid': 'player author intent contains valid simulation data',
  'vfx-simulation-output-unavailable':
    'the output reference is ready and has the expected asset kind',
  'vfx-simulation-execution-failed': 'the runtime executor accepts the cooked stage program',
};

const hints: { readonly [C in VfxErrorCode]: string } = {
  'vfx-source-invalid': 'repair the source path using the schema and parse it again',
  'vfx-operator-unknown': 'register the definition for the stage, kind, and version',
  'vfx-operator-backend-unsupported':
    'register the missing backend compiler or change the source policy',
  'vfx-program-invalid': 'recook the source and verify the asset-local program artifact',
  'vfx-batch-invalid':
    'repair the output variant attributes before handing the batch to a consumer',
  'vfx-asset-load-failed': 'repair the reported package, artifact, or reference and retry the load',
  'vfx-simulation-capability-unavailable':
    'enable the declared backend capability or choose an explicitly supported fallback',
  'vfx-simulation-player-invalid':
    'repair the named player field and retry the next fixed simulation boundary',
  'vfx-simulation-output-unavailable':
    'make the named output reference ready with the expected kind, then retry',
  'vfx-simulation-execution-failed':
    'repair or register the executor for the named stage and operator, then retry',
};

export function vfxError<C extends VfxErrorCode>(
  code: C,
  detail: VfxErrorDetailFor[C],
): VfxErrorFor<C> {
  return { code, expected: expected[code], hint: hints[code], detail };
}
