import { err, ok, type Result } from '@forgeax/engine-types';

/** Engine-owned seed module used by newly-authored particle effects. */
export const PARTICLE_CODE_DEFAULT_MODULE_ID = 'forgeax_vfx::default' as const;

export type ParticleBoundsSource =
  | {
      readonly kind: 'aabb';
      readonly min: readonly [number, number, number];
      readonly max: readonly [number, number, number];
    }
  | {
      readonly kind: 'sphere';
      readonly center: readonly [number, number, number];
      readonly radius: number;
    };

export type ParticleRendererSource =
  | {
      readonly kind: 'billboard';
      readonly material: string;
      readonly blend?: 'additive' | 'alpha' | 'opaque-cutout';
    }
  | {
      readonly kind: 'mesh';
      readonly material: string;
      readonly mesh: string;
      readonly submesh?: number;
    };

export interface ParticleEmitterSourceV2 {
  readonly id: string;
  readonly capacity: number;
  readonly backend: { readonly required: 'gpu' };
  readonly space: 'local' | 'world';
  readonly bounds: ParticleBoundsSource;
  readonly schedule: {
    readonly rate: number;
    readonly bursts?: readonly { readonly time: number; readonly count: number }[];
    readonly loopDuration?: number;
  };
  readonly program: { readonly module: string };
  readonly renderers: readonly ParticleRendererSource[];
  readonly simulationWhenCulled?: 'continue' | 'pause' | 'restart-on-visible';
}

export interface ParticleEffectRootSourceV2 {
  readonly schemaVersion: 2;
  readonly emitters: readonly ParticleEmitterSourceV2[];
}

export type ParticleEffectSourceV2 = ParticleEffectRootSourceV2;

export interface ParticleCodeSourceInvalidDetail {
  readonly path: string;
  readonly emitterId?: string;
}

export interface ParticleCodeSourceError {
  readonly code: 'vfx-source-invalid' | 'vfx-source-version-unsupported';
  readonly expected: string;
  readonly hint: string;
  readonly detail: ParticleCodeSourceInvalidDetail;
}

function invalid(
  path: string,
  expected: string,
  emitterId?: string,
): Result<never, ParticleCodeSourceError> {
  return err({
    code: 'vfx-source-invalid',
    expected,
    hint: `repair ${path} and recook the particle effect`,
    detail: emitterId === undefined ? { path } : { path, emitterId },
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveInteger(value: unknown): value is number {
  return finite(value) && Number.isInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return finite(value) && Number.isInteger(value) && value >= 0;
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function vector(value: unknown, size: number): value is readonly number[] {
  return Array.isArray(value) && value.length === size && value.every(finite);
}

function allowed(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  const set = new Set(keys);
  return Object.keys(value).find((key) => !set.has(key));
}

function parseEmitter(
  value: unknown,
  index: number,
  ids: Set<string>,
): Result<ParticleEmitterSourceV2, ParticleCodeSourceError> {
  const path = `emitters[${index}]`;
  if (!record(value)) return invalid(path, 'a v2 emitter object');
  const extra = allowed(value, [
    'id',
    'capacity',
    'backend',
    'space',
    'bounds',
    'schedule',
    'program',
    'renderers',
    'simulationWhenCulled',
  ]);
  if (extra !== undefined) return invalid(`${path}.${extra}`, 'a v2 emitter field');
  if (!text(value.id) || ids.has(value.id)) return invalid(`${path}.id`, 'a unique non-empty id');
  const id = value.id;
  ids.add(id);
  if (!positiveInteger(value.capacity))
    return invalid(`${path}.capacity`, 'a positive integer', id);
  if (!record(value.backend) || value.backend.required !== 'gpu') {
    return invalid(`${path}.backend`, "the explicit policy { required: 'gpu' }", id);
  }
  const backendExtra = allowed(value.backend, ['required']);
  if (backendExtra !== undefined) {
    return invalid(`${path}.backend.${backendExtra}`, 'the required GPU policy', id);
  }
  if (value.space !== 'local' && value.space !== 'world') {
    return invalid(`${path}.space`, 'local or world', id);
  }
  if (!record(value.bounds)) return invalid(`${path}.bounds`, 'fixed aabb or sphere bounds', id);
  const boundsExtra = allowed(
    value.bounds,
    value.bounds.kind === 'aabb'
      ? ['kind', 'min', 'max']
      : value.bounds.kind === 'sphere'
        ? ['kind', 'center', 'radius']
        : ['kind'],
  );
  if (boundsExtra !== undefined) {
    return invalid(`${path}.bounds.${boundsExtra}`, 'a supported bounds field', id);
  }
  const boundsOk =
    (value.bounds.kind === 'aabb' && vector(value.bounds.min, 3) && vector(value.bounds.max, 3)) ||
    (value.bounds.kind === 'sphere' &&
      vector(value.bounds.center, 3) &&
      finite(value.bounds.radius) &&
      value.bounds.radius > 0);
  if (!boundsOk) return invalid(`${path}.bounds`, 'valid fixed aabb or sphere bounds', id);
  if (!record(value.schedule) || !finite(value.schedule.rate) || value.schedule.rate < 0) {
    return invalid(`${path}.schedule`, 'a non-negative spawn schedule', id);
  }
  const scheduleExtra = allowed(value.schedule, ['rate', 'bursts', 'loopDuration']);
  if (scheduleExtra !== undefined) {
    return invalid(`${path}.schedule.${scheduleExtra}`, 'a supported schedule field', id);
  }
  if (
    value.schedule.bursts !== undefined &&
    (!Array.isArray(value.schedule.bursts) ||
      value.schedule.bursts.some(
        (burst) =>
          !record(burst) || !finite(burst.time) || burst.time < 0 || !positiveInteger(burst.count),
      ))
  ) {
    return invalid(`${path}.schedule.bursts`, 'non-negative timed positive bursts', id);
  }
  if (Array.isArray(value.schedule.bursts)) {
    for (const [burstIndex, burst] of value.schedule.bursts.entries()) {
      if (!record(burst)) continue;
      const burstExtra = allowed(burst, ['time', 'count']);
      if (burstExtra !== undefined) {
        return invalid(
          `${path}.schedule.bursts[${burstIndex}].${burstExtra}`,
          'a supported burst field',
          id,
        );
      }
    }
  }
  if (
    value.schedule.loopDuration !== undefined &&
    (!finite(value.schedule.loopDuration) || value.schedule.loopDuration <= 0)
  ) {
    return invalid(`${path}.schedule.loopDuration`, 'a positive finite duration', id);
  }
  if (!record(value.program) || !text(value.program.module)) {
    return invalid(`${path}.program.module`, 'a WGSL module identity', id);
  }
  const programExtra = allowed(value.program, ['module']);
  if (programExtra !== undefined) {
    return invalid(`${path}.program.${programExtra}`, 'a supported program field', id);
  }
  if (!Array.isArray(value.renderers) || value.renderers.length === 0) {
    return invalid(`${path}.renderers`, 'at least one renderer', id);
  }
  for (const [rendererIndex, renderer] of value.renderers.entries()) {
    const rendererPath = `${path}.renderers[${rendererIndex}]`;
    if (
      !record(renderer) ||
      !text(renderer.material) ||
      (renderer.kind !== 'billboard' && renderer.kind !== 'mesh') ||
      (renderer.kind === 'mesh' && !text(renderer.mesh))
    ) {
      return invalid(rendererPath, 'a valid billboard or mesh renderer', id);
    }
    const rendererExtra = allowed(
      renderer,
      renderer.kind === 'billboard'
        ? ['kind', 'material', 'blend']
        : ['kind', 'material', 'mesh', 'submesh'],
    );
    if (rendererExtra !== undefined) {
      return invalid(`${rendererPath}.${rendererExtra}`, 'a supported renderer field', id);
    }
    if (
      renderer.kind === 'billboard' &&
      renderer.blend !== undefined &&
      renderer.blend !== 'additive' &&
      renderer.blend !== 'alpha' &&
      renderer.blend !== 'opaque-cutout'
    ) {
      return invalid(`${rendererPath}.blend`, 'additive, alpha, or opaque-cutout', id);
    }
    if (
      renderer.kind === 'mesh' &&
      renderer.submesh !== undefined &&
      !nonNegativeInteger(renderer.submesh)
    ) {
      return invalid(`${rendererPath}.submesh`, 'a non-negative integer submesh index', id);
    }
  }
  if (
    value.simulationWhenCulled !== undefined &&
    value.simulationWhenCulled !== 'continue' &&
    value.simulationWhenCulled !== 'pause' &&
    value.simulationWhenCulled !== 'restart-on-visible'
  ) {
    return invalid(`${path}.simulationWhenCulled`, 'continue, pause, or restart-on-visible', id);
  }
  return ok(value as unknown as ParticleEmitterSourceV2);
}

export function parseParticleEffectSourceV2(
  value: unknown,
): Result<ParticleEffectSourceV2, ParticleCodeSourceError> {
  if (!record(value)) return invalid('$', 'a particle effect source object');
  if (value.schemaVersion !== 2) {
    return err({
      code: 'vfx-source-version-unsupported',
      expected: 'ParticleEffectSource schemaVersion 2',
      hint: 'migrate code behavior to WGSL and recook; v1 is not interpreted at runtime',
      detail: { path: 'schemaVersion' },
    });
  }
  const extra = allowed(value, ['schemaVersion', 'emitters']);
  if (extra !== undefined) return invalid(extra, 'a root field: emitters');
  if (!Array.isArray(value.emitters) || value.emitters.length === 0) {
    return invalid('emitters', 'at least one v2 emitter');
  }
  const ids = new Set<string>();
  const emitters: ParticleEmitterSourceV2[] = [];
  for (const [index, emitter] of value.emitters.entries()) {
    const parsed = parseEmitter(emitter, index, ids);
    if (!parsed.ok) return parsed;
    emitters.push(parsed.value);
  }
  return ok(
    Object.freeze({
      schemaVersion: 2,
      emitters: Object.freeze(emitters),
    }),
  );
}

export function defineParticleEffectSourceV2<T extends ParticleEffectSourceV2>(source: T): T {
  const parsed = parseParticleEffectSourceV2(source);
  if (!parsed.ok) throw new TypeError(`${parsed.error.code}: ${parsed.error.expected}`);
  return source;
}
