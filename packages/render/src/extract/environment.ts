import type { World } from '@forgeax/engine-ecs';
import { err, ok, type Result } from '@forgeax/engine-types';
import { environmentFactSignatures } from '../environment/signature';
import {
  AtmosphereInvalidParameterError,
  type AtmosphereParameterRange,
  EnvironmentSourceConflictError,
  FogCardinalityError,
  type RenderError,
} from '../errors/render';
import type { TemporalView } from '../temporal/view';

/** The retained projection's environment extraction owner. */
export interface EnvironmentExtractionContext {
  readonly resourceOwner: number;
  readonly world: World;
}

/** Keep environment reads at the resource-owner frame boundary. */
export function createEnvironmentExtractionContext(
  world: World,
  resourceOwner: number,
): EnvironmentExtractionContext {
  return Object.freeze({ world, resourceOwner });
}

export type EnvironmentCandidate =
  | { readonly kind: 'image'; readonly entityKey: number; readonly sourceKey: string }
  | {
      readonly kind: 'atmosphere';
      readonly entityKey: number;
      readonly sourceKey: string;
      readonly atmosphere: AtmosphereParameters;
    };

export interface AtmosphereParameters {
  readonly turbidity: number;
  readonly rayleigh: number;
  readonly mieCoefficient: number;
  readonly mieDirectionalG: number;
  readonly sunAngularRadius: number;
  readonly circumsolarStrength: number;
  readonly circumsolarWidth: number;
}

/** Shared CPU contract for values accepted by the atmosphere shaders. */
export const ATMOSPHERE_PARAMETER_RANGES: Readonly<
  Record<keyof AtmosphereParameters, AtmosphereParameterRange>
> = Object.freeze({
  turbidity: Object.freeze({ min: 1, max: 20 }),
  rayleigh: Object.freeze({ min: 0, max: Number.POSITIVE_INFINITY }),
  mieCoefficient: Object.freeze({ min: 0, max: Number.POSITIVE_INFINITY }),
  mieDirectionalG: Object.freeze({ min: 0, max: 0.999 }),
  sunAngularRadius: Object.freeze({ min: 0, max: Number.POSITIVE_INFINITY }),
  circumsolarStrength: Object.freeze({ min: 0, max: 4 }),
  circumsolarWidth: Object.freeze({ min: 0.25, max: 4 }),
});

export interface FogCandidate {
  readonly entityKey: number;
  readonly color: readonly [number, number, number];
  readonly density: number;
  readonly heightFalloff: number;
  readonly maxOpacity: number;
}

export type EnvironmentSource =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'image';
      readonly entityKey: number;
      readonly sourceKey: string;
    }
  | {
      readonly kind: 'atmosphere';
      readonly entityKey: number;
      readonly sourceKey: string;
      readonly atmosphere: AtmosphereParameters;
    };

export interface FogFrame extends FogCandidate {}

export interface FogParameterIssue {
  readonly field: string;
  readonly value: number;
  readonly expected: string;
}

/** Structured failure retained when an invalid Fog update falls back to LKG. */
export interface FogSelectionFailure {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface EnvironmentFrame {
  readonly source: EnvironmentSource;
  /** Descriptor of the real environment resource adopted for this frame. */
  readonly resourceDescriptor?: Readonly<{
    readonly width: number;
    readonly height: number;
    readonly bytesPerPixel: number;
  }>;
  readonly fog: FogFrame | undefined;
  readonly environmentSignature: string;
  readonly fogSignature: string;
  readonly signature: string;
  readonly revision: number;
}

export interface FramePlan {
  readonly environment: EnvironmentFrame;
  readonly temporal: TemporalView;
}

function freezeFog(candidate: FogCandidate): FogFrame {
  return Object.freeze({
    ...candidate,
    color: Object.freeze([...candidate.color] as unknown as FogFrame['color']),
  });
}

/** Validate the bounded Fog domain once for every frame-selection producer. */
export function validateFogParameters(candidate: FogCandidate): FogParameterIssue | undefined {
  if (candidate.color.length !== 3) {
    return {
      field: 'color',
      value: candidate.color.length,
      expected: 'exactly three finite channels in [0, 1]',
    };
  }
  for (let index = 0; index < candidate.color.length; index += 1) {
    const value = candidate.color[index];
    if (value === undefined || !Number.isFinite(value) || value < 0 || value > 1) {
      return {
        field: `color[${index}]`,
        value: value ?? Number.NaN,
        expected: 'a finite number in [0, 1]',
      };
    }
  }
  if (!Number.isFinite(candidate.density) || candidate.density < 0) {
    return { field: 'density', value: candidate.density, expected: 'a finite number >= 0' };
  }
  if (!Number.isFinite(candidate.heightFalloff) || candidate.heightFalloff < 0) {
    return {
      field: 'heightFalloff',
      value: candidate.heightFalloff,
      expected: 'a finite number >= 0',
    };
  }
  if (
    !Number.isFinite(candidate.maxOpacity) ||
    candidate.maxOpacity < 0 ||
    candidate.maxOpacity > 1
  ) {
    return {
      field: 'maxOpacity',
      value: candidate.maxOpacity,
      expected: 'a finite number in [0, 1]',
    };
  }
  return undefined;
}

function freezeAtmosphere(parameters: AtmosphereParameters): AtmosphereParameters {
  return Object.freeze({ ...parameters });
}

/** Return the first invalid analytic atmosphere field at the extraction boundary. */
export function validateAtmosphereParameters(
  parameters: AtmosphereParameters,
): AtmosphereInvalidParameterError | undefined {
  for (const field of Object.keys(ATMOSPHERE_PARAMETER_RANGES) as (keyof AtmosphereParameters)[]) {
    const value = parameters[field];
    const range = ATMOSPHERE_PARAMETER_RANGES[field];
    if (!Number.isFinite(value) || value < range.min || value > range.max) {
      return new AtmosphereInvalidParameterError(field, value, range);
    }
  }
  return undefined;
}

/** Select immutable environment and independent Fog facts at the frame boundary. */
export function selectEnvironmentFrame(
  candidates: readonly EnvironmentCandidate[],
  fogCandidates: readonly FogCandidate[],
): Result<EnvironmentFrame, RenderError> {
  if (candidates.length > 1) {
    return err(
      new EnvironmentSourceConflictError(
        candidates.map(({ kind, entityKey, sourceKey }) => ({ kind, entityKey, sourceKey })),
      ),
    );
  }
  if (fogCandidates.length > 1) return err(new FogCardinalityError(fogCandidates.length));
  const candidate = candidates[0];
  if (candidate?.kind === 'atmosphere') {
    const invalid = validateAtmosphereParameters(candidate.atmosphere);
    if (invalid !== undefined) return err(invalid);
  }
  const source: EnvironmentSource =
    candidate === undefined
      ? { kind: 'none' }
      : candidate.kind === 'atmosphere'
        ? {
            kind: 'atmosphere',
            entityKey: candidate.entityKey,
            sourceKey: candidate.sourceKey,
            atmosphere: freezeAtmosphere(candidate.atmosphere),
          }
        : {
            kind: 'image',
            entityKey: candidate.entityKey,
            sourceKey: candidate.sourceKey,
          };
  const fog = fogCandidates[0] === undefined ? undefined : freezeFog(fogCandidates[0]);
  const signatures = environmentFactSignatures({
    environments: candidate === undefined ? [] : [candidate],
    fogs: fogCandidates,
    suns: [],
  });
  return ok(
    Object.freeze({
      source: Object.freeze(source),
      fog,
      ...signatures,
      revision: 0,
    }),
  );
}
