export type ParticleRenderErrorCode =
  | 'particle-render-material-not-ready'
  | 'particle-render-mesh-not-ready'
  | 'particle-render-type-mismatch'
  | 'particle-render-executor-missing'
  | 'particle-render-camera-unavailable'
  | 'particle-render-bucket-invalid'
  | 'particle-render-prepared-generation-mismatch'
  | 'particle-render-device-lost'
  | 'particle-render-feature-failed';

export type ParticleRenderErrorDetailByCode = {
  'particle-render-material-not-ready': { readonly assetGuid: string };
  'particle-render-mesh-not-ready': { readonly assetGuid: string };
  'particle-render-type-mismatch': {
    readonly expectedKind: 'billboard' | 'mesh';
    readonly actualKind: string;
  };
  'particle-render-executor-missing': { readonly operator: string };
  'particle-render-camera-unavailable': { readonly owner: number };
  'particle-render-bucket-invalid': { readonly bucket: string };
  'particle-render-prepared-generation-mismatch': {
    readonly expectedGeneration: number;
    readonly actualGeneration: number;
  };
  'particle-render-device-lost': { readonly generation: number };
  'particle-render-feature-failed': { readonly stage: 'extract' | 'prepare' | 'contribute' };
};

export type ParticleRenderErrorDetail = {
  [Code in ParticleRenderErrorCode]: ParticleRenderErrorDetailByCode[Code] & {
    readonly code: Code;
  };
}[ParticleRenderErrorCode];

export type ParticleRenderError = {
  [Code in ParticleRenderErrorCode]: {
    readonly code: Code;
    readonly expected: string;
    readonly hint: string;
    readonly detail: ParticleRenderErrorDetailByCode[Code] & { readonly code: Code };
  };
}[ParticleRenderErrorCode];

export const PARTICLE_RENDER_ERROR_CODES: readonly ParticleRenderErrorCode[] = Object.freeze([
  'particle-render-material-not-ready',
  'particle-render-mesh-not-ready',
  'particle-render-type-mismatch',
  'particle-render-executor-missing',
  'particle-render-camera-unavailable',
  'particle-render-bucket-invalid',
  'particle-render-prepared-generation-mismatch',
  'particle-render-device-lost',
  'particle-render-feature-failed',
]);

function hintFor(detail: ParticleRenderErrorDetail): string {
  switch (detail.code) {
    case 'particle-render-material-not-ready':
      return `load material asset '${detail.assetGuid}' before the next frame`;
    case 'particle-render-mesh-not-ready':
      return `load mesh asset '${detail.assetGuid}' before the next frame`;
    case 'particle-render-type-mismatch':
      return `emit a '${detail.expectedKind}' batch instead of '${detail.actualKind}'`;
    case 'particle-render-executor-missing':
      return `register CPU executor '${detail.operator}' before the next FixedUpdate`;
    case 'particle-render-camera-unavailable':
      return `provide the active camera for World owner ${detail.owner} and retry`;
    case 'particle-render-bucket-invalid':
      return `repair bucket '${detail.bucket}' and retry the next frame`;
    case 'particle-render-prepared-generation-mismatch':
      return `recover the renderer from generation ${detail.actualGeneration} to ${detail.expectedGeneration}`;
    case 'particle-render-device-lost':
      return `recover the renderer before reusing generation ${detail.generation} references`;
    case 'particle-render-feature-failed':
      return `repair the ${detail.stage} input and retry on the next frame`;
  }
}

export function createParticleRenderError<Code extends ParticleRenderErrorCode>(
  code: Code,
  detail: ParticleRenderErrorDetailByCode[Code],
): Extract<ParticleRenderError, { readonly code: Code }> {
  const typedDetail = { ...detail, code };
  const hint = hintFor(typedDetail as unknown as ParticleRenderErrorDetail);
  return Object.freeze({
    code,
    expected: `particle render completes ${code} without an error`,
    hint,
    detail: Object.freeze(typedDetail),
  }) as unknown as Extract<ParticleRenderError, { readonly code: Code }>;
}

export type ParticleRenderReadiness =
  | 'empty'
  | 'preparing'
  | 'ready'
  | 'disabled'
  | 'unavailable'
  | 'failed';

export interface ParticleRenderDiagnostics {
  readonly readiness: ParticleRenderReadiness;
  readonly error: ParticleRenderError | undefined;
  readonly bucketCount: number;
  readonly generation: number | undefined;
}
