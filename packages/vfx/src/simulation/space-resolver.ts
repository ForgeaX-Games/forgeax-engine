export type ParticleSimulationSpace = 'local' | 'world';

export type ParticleSpaceResolvePhase = 'spawn' | 'extract';

export interface ParticleSpaceResolverInput {
  readonly player: number;
  readonly space: ParticleSimulationSpace;
  readonly phase: ParticleSpaceResolvePhase;
  readonly tick: number;
  readonly joint?: number;
}

export interface ParticleSpacePose {
  readonly space: ParticleSimulationSpace;
  readonly phase: ParticleSpaceResolvePhase;
  readonly matrix: Float32Array;
  readonly source: 'root' | 'parent' | 'joint';
  readonly parent?: number;
  readonly joint?: number;
}

export type ParticleSpaceResolverErrorCode =
  | 'particle-space-parent-unavailable'
  | 'particle-space-parent-failed';

export interface ParticleSpaceResolverErrorDetail {
  readonly player: number;
  readonly space: ParticleSimulationSpace;
  readonly phase: ParticleSpaceResolvePhase;
  readonly parent?: number;
  readonly joint?: number;
  readonly reason: string;
}

export type ParticleSpaceResolverError = {
  readonly code: ParticleSpaceResolverErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: ParticleSpaceResolverErrorDetail;
};

export type ParticleSpaceResolverResult =
  | { readonly ok: true; readonly value: ParticleSpacePose }
  | { readonly ok: false; readonly error: ParticleSpaceResolverError };

/** The narrow, POD-only scene fact seam consumed by the headless simulator. */
export interface ParticleSpaceResolver {
  resolve(input: ParticleSpaceResolverInput): ParticleSpaceResolverResult;
}

const EXPECTED = {
  'particle-space-parent-unavailable': 'the parent or joint remains live and has a world pose',
  'particle-space-parent-failed': 'the repaired parent world pose resolves without failure',
} as const satisfies Record<ParticleSpaceResolverErrorCode, string>;

const HINT = {
  'particle-space-parent-unavailable':
    'repair the parent relationship and retry on the next FixedUpdate',
  'particle-space-parent-failed': 'repair the hierarchy error and retry on the next FixedUpdate',
} as const satisfies Record<ParticleSpaceResolverErrorCode, string>;

export function createParticleSpaceError(
  code: ParticleSpaceResolverErrorCode,
  detail: ParticleSpaceResolverErrorDetail,
): ParticleSpaceResolverError {
  return Object.freeze({
    code,
    expected: EXPECTED[code],
    hint: HINT[code],
    detail: Object.freeze({ ...detail }),
  });
}

/** Transform one emitter-local point with a scene-owned column-major pose. */
export function transformParticlePoint(
  matrix: Float32Array,
  source: Float32Array,
  sourceOffset: number,
  target: Float32Array,
  targetOffset: number,
): void {
  const x = source[sourceOffset] ?? 0;
  const y = source[sourceOffset + 1] ?? 0;
  const z = source[sourceOffset + 2] ?? 0;
  target[targetOffset] =
    (matrix[0] ?? 0) * x + (matrix[4] ?? 0) * y + (matrix[8] ?? 0) * z + (matrix[12] ?? 0);
  target[targetOffset + 1] =
    (matrix[1] ?? 0) * x + (matrix[5] ?? 0) * y + (matrix[9] ?? 0) * z + (matrix[13] ?? 0);
  target[targetOffset + 2] =
    (matrix[2] ?? 0) * x + (matrix[6] ?? 0) * y + (matrix[10] ?? 0) * z + (matrix[14] ?? 0);
}
