import { err, ok, type Result } from '@forgeax/engine-types';

export type ParticleBackend = 'cpu' | 'gpu';

export type ParticleBackendPolicy =
  | { readonly kind: 'required'; readonly backend: ParticleBackend }
  | { readonly kind: 'preferred'; readonly backend: 'gpu'; readonly fallback: 'cpu' | 'disable' };

export type ParticleOperatorStage = 'spawn' | 'initialize' | 'update' | 'output';

export interface ParticleOperatorSource {
  readonly kind: string;
  readonly version: number;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface ParticleCurvePoint {
  readonly time: number;
  readonly value: number;
}

export interface ParticleCurve {
  readonly points: readonly ParticleCurvePoint[];
}

export interface ParticleGradientStop {
  readonly time: number;
  readonly color: readonly [number, number, number, number];
}

export interface ParticleGradient {
  readonly stops: readonly ParticleGradientStop[];
}

export interface ParticleEmitterSchedule {
  readonly rate: number;
  readonly bursts?: readonly { readonly time: number; readonly count: number }[];
}

export interface ParticleBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export type ParticleOutputSource =
  | { readonly kind: 'billboard'; readonly material: string }
  | { readonly kind: 'mesh'; readonly material: string; readonly mesh: string };

export interface ParticleEmitterSource {
  readonly id: string;
  readonly capacity: number;
  readonly space: 'local' | 'world';
  readonly schedule: ParticleEmitterSchedule;
  readonly bounds: ParticleBounds;
  readonly backendPolicy: ParticleBackendPolicy;
  readonly operators: Readonly<Record<ParticleOperatorStage, readonly ParticleOperatorSource[]>>;
  readonly curves?: Readonly<Record<string, ParticleCurve>>;
  readonly gradients?: Readonly<Record<string, ParticleGradient>>;
  readonly output: ParticleOutputSource;
}

export interface ParticleEffectSource {
  readonly schemaVersion: 1;
  readonly emitters: readonly ParticleEmitterSource[];
}

export interface ParticleSourceInvalidDetail {
  readonly path: string;
  readonly emitterId?: string;
}

export type ParticleSourceError = {
  readonly code: 'vfx-source-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: ParticleSourceInvalidDetail;
};

const stages: readonly ParticleOperatorStage[] = ['spawn', 'initialize', 'update', 'output'];

function invalid(
  path: string,
  expected: string,
  emitterId?: string,
): ResultErr<ParticleSourceError> {
  return err({
    code: 'vfx-source-invalid',
    expected,
    hint: `repair ${path} to match the ParticleEffectSource schema`,
    detail: emitterId === undefined ? { path } : { path, emitterId },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validateNumber(
  value: unknown,
  path: string,
  emitterId?: string,
): Result<number, ParticleSourceError> {
  return isFiniteNumber(value) ? ok(value) : invalid(path, 'a finite number', emitterId);
}

function validateVector(
  value: unknown,
  path: string,
  emitterId?: string,
): Result<readonly [number, number, number], ParticleSourceError> {
  if (!Array.isArray(value) || value.length !== 3) {
    return invalid(path, 'an array of three finite numbers', emitterId);
  }
  const numbers: number[] = [];
  for (const [index, item] of value.entries()) {
    const result = validateNumber(item, `${path}[${index}]`, emitterId);
    if (!result.ok) return result;
    numbers.push(result.value);
  }
  const [x, y, z] = numbers;
  if (x === undefined || y === undefined || z === undefined) {
    return invalid(path, 'an array of three finite numbers', emitterId);
  }
  return ok([x, y, z] as const);
}

function validateOperator(
  value: unknown,
  path: string,
  emitterId: string,
): Result<ParticleOperatorSource, ParticleSourceError> {
  if (
    !isRecord(value) ||
    !isString(value.kind) ||
    typeof value.version !== 'number' ||
    !Number.isInteger(value.version) ||
    value.version < 1
  ) {
    return invalid(`${path}`, '{kind, version >= 1, params}', emitterId);
  }
  if (!isRecord(value.params)) return invalid(`${path}.params`, 'a JSON object', emitterId);
  return ok({ kind: value.kind, version: value.version, params: value.params });
}

function validateOperators(
  value: unknown,
  path: string,
  emitterId: string,
): Result<
  Readonly<Record<ParticleOperatorStage, readonly ParticleOperatorSource[]>>,
  ParticleSourceError
> {
  if (!isRecord(value))
    return invalid(path, 'one non-empty array for each operator stage', emitterId);
  const result = {} as Record<ParticleOperatorStage, readonly ParticleOperatorSource[]>;
  for (const stage of stages) {
    const operators = value[stage];
    if (!Array.isArray(operators) || operators.length === 0) {
      return invalid(`${path}.${stage}`, 'a non-empty ordered operator array', emitterId);
    }
    const validated: ParticleOperatorSource[] = [];
    for (const [index, operator] of operators.entries()) {
      const item = validateOperator(operator, `${path}.${stage}[${index}]`, emitterId);
      if (!item.ok) return item;
      validated.push(item.value);
    }
    result[stage] = validated;
  }
  return ok(result);
}

function validateCurves(
  value: unknown,
  path: string,
  emitterId: string,
): Result<Readonly<Record<string, ParticleCurve>>, ParticleSourceError> {
  if (!isRecord(value)) return invalid(path, 'a map of named curves', emitterId);
  const curves: Record<string, ParticleCurve> = {};
  for (const [name, curve] of Object.entries(value)) {
    if (!isRecord(curve) || !Array.isArray(curve.points) || curve.points.length < 2) {
      return invalid(`${path}.${name}.points`, 'at least two ordered points', emitterId);
    }
    const points: ParticleCurvePoint[] = [];
    let previousTime = -Infinity;
    for (const [index, point] of curve.points.entries()) {
      if (!isRecord(point))
        return invalid(`${path}.${name}.points[${index}]`, 'a curve point', emitterId);
      const time = validateNumber(point.time, `${path}.${name}.points[${index}].time`, emitterId);
      if (!time.ok) return time;
      const number = validateNumber(
        point.value,
        `${path}.${name}.points[${index}].value`,
        emitterId,
      );
      if (!number.ok) return number;
      if (time.value < 0 || time.value > 1 || time.value <= previousTime) {
        return invalid(
          `${path}.${name}.points[${index}].time`,
          'a strictly increasing value in [0, 1]',
          emitterId,
        );
      }
      previousTime = time.value;
      points.push({ time: time.value, value: number.value });
    }
    curves[name] = { points };
  }
  return ok(curves);
}

function validateGradients(
  value: unknown,
  path: string,
  emitterId: string,
): Result<Readonly<Record<string, ParticleGradient>>, ParticleSourceError> {
  if (!isRecord(value)) return invalid(path, 'a map of named gradients', emitterId);
  const gradients: Record<string, ParticleGradient> = {};
  for (const [name, gradient] of Object.entries(value)) {
    if (!isRecord(gradient) || !Array.isArray(gradient.stops) || gradient.stops.length === 0) {
      return invalid(`${path}.${name}.stops`, 'one or more ordered color stops', emitterId);
    }
    const stops: ParticleGradientStop[] = [];
    let previousTime = -Infinity;
    for (const [index, stop] of gradient.stops.entries()) {
      if (!isRecord(stop))
        return invalid(`${path}.${name}.stops[${index}]`, 'a gradient stop', emitterId);
      const time = validateNumber(stop.time, `${path}.${name}.stops[${index}].time`, emitterId);
      if (!time.ok) return time;
      if (time.value < 0 || time.value > 1 || time.value <= previousTime) {
        return invalid(
          `${path}.${name}.stops[${index}].time`,
          'a strictly increasing value in [0, 1]',
          emitterId,
        );
      }
      if (!Array.isArray(stop.color) || stop.color.length !== 4) {
        return invalid(
          `${path}.${name}.stops[${index}].color`,
          'four channels in [0, 1]',
          emitterId,
        );
      }
      const color: number[] = [];
      for (const [channel, value] of stop.color.entries()) {
        const channelResult = validateNumber(
          value,
          `${path}.${name}.stops[${index}].color[${channel}]`,
          emitterId,
        );
        if (!channelResult.ok) return channelResult;
        if (channelResult.value < 0 || channelResult.value > 1) {
          return invalid(
            `${path}.${name}.stops[${index}].color[${channel}]`,
            'a number in [0, 1]',
            emitterId,
          );
        }
        color.push(channelResult.value);
      }
      previousTime = time.value;
      const [red, green, blue, alpha] = color;
      if (red === undefined || green === undefined || blue === undefined || alpha === undefined) {
        return invalid(
          `${path}.${name}.stops[${index}].color`,
          'four channels in [0, 1]',
          emitterId,
        );
      }
      stops.push({ time: time.value, color: [red, green, blue, alpha] });
    }
    gradients[name] = { stops };
  }
  return ok(gradients);
}

function validateEmitter(
  value: unknown,
  path: string,
  seenIds: ReadonlySet<string>,
): Result<ParticleEmitterSource, ParticleSourceError> {
  if (!isRecord(value)) return invalid(path, 'a ParticleEmitterSource object');
  if (!isString(value.id)) return invalid(`${path}.id`, 'a non-empty stable string');
  if (seenIds.has(value.id)) return invalid(`${path}.id`, 'a unique emitter id', value.id);
  const emitterId = value.id;
  if (
    typeof value.capacity !== 'number' ||
    !Number.isInteger(value.capacity) ||
    value.capacity <= 0
  ) {
    return invalid(`${path}.capacity`, 'a positive integer', emitterId);
  }
  const capacity = value.capacity;
  if (value.space !== 'local' && value.space !== 'world') {
    return invalid(`${path}.space`, "'local' or 'world'", emitterId);
  }
  if (!isRecord(value.schedule)) return invalid(`${path}.schedule`, 'a schedule object', emitterId);
  const rate = validateNumber(value.schedule.rate, `${path}.schedule.rate`, emitterId);
  if (!rate.ok) return rate;
  if (rate.value < 0) return invalid(`${path}.schedule.rate`, 'a finite number >= 0', emitterId);
  const bursts: { readonly time: number; readonly count: number }[] = [];
  if (value.schedule.bursts !== undefined) {
    if (!Array.isArray(value.schedule.bursts))
      return invalid(`${path}.schedule.bursts`, 'an array of bursts', emitterId);
    for (const [index, burst] of value.schedule.bursts.entries()) {
      if (!isRecord(burst))
        return invalid(`${path}.schedule.bursts[${index}]`, 'a burst object', emitterId);
      const time = validateNumber(burst.time, `${path}.schedule.bursts[${index}].time`, emitterId);
      if (!time.ok) return time;
      if (time.value < 0)
        return invalid(`${path}.schedule.bursts[${index}].time`, 'a finite number >= 0', emitterId);
      if (typeof burst.count !== 'number' || !Number.isInteger(burst.count) || burst.count <= 0) {
        return invalid(`${path}.schedule.bursts[${index}].count`, 'a positive integer', emitterId);
      }
      bursts.push({ time: time.value, count: burst.count });
    }
  }
  const min = validateVector(
    value.bounds && isRecord(value.bounds) ? value.bounds.min : undefined,
    `${path}.bounds.min`,
    emitterId,
  );
  if (!min.ok) return min;
  const max = validateVector(
    value.bounds && isRecord(value.bounds) ? value.bounds.max : undefined,
    `${path}.bounds.max`,
    emitterId,
  );
  if (!max.ok) return max;
  if (min.value[0] > max.value[0] || min.value[1] > max.value[1] || min.value[2] > max.value[2]) {
    return invalid(`${path}.bounds`, 'min must not exceed max', emitterId);
  }
  if (!isRecord(value.backendPolicy))
    return invalid(`${path}.backendPolicy`, 'a closed backend policy', emitterId);
  const policy = value.backendPolicy;
  let backendPolicy: ParticleBackendPolicy;
  if (policy.kind === 'required') {
    if (policy.backend !== 'cpu' && policy.backend !== 'gpu') {
      return invalid(`${path}.backendPolicy.backend`, "'cpu' or 'gpu'", emitterId);
    }
    backendPolicy = { kind: 'required', backend: policy.backend };
  } else if (policy.kind === 'preferred') {
    if (policy.backend !== 'gpu' || (policy.fallback !== 'cpu' && policy.fallback !== 'disable')) {
      return invalid(
        `${path}.backendPolicy`,
        "{kind: 'preferred', backend: 'gpu', fallback: 'cpu'|'disable'}",
        emitterId,
      );
    }
    backendPolicy = { kind: 'preferred', backend: 'gpu', fallback: policy.fallback };
  } else {
    return invalid(`${path}.backendPolicy.kind`, "'required' or 'preferred'", emitterId);
  }
  const operators = validateOperators(value.operators, `${path}.operators`, emitterId);
  if (!operators.ok) return operators;
  const curves =
    value.curves === undefined
      ? undefined
      : validateCurves(value.curves, `${path}.curves`, emitterId);
  if (curves !== undefined && !curves.ok) return curves;
  const gradients =
    value.gradients === undefined
      ? undefined
      : validateGradients(value.gradients, `${path}.gradients`, emitterId);
  if (gradients !== undefined && !gradients.ok) return gradients;
  if (!isRecord(value.output)) return invalid(`${path}.output`, 'an output intent', emitterId);
  if (value.output.kind !== 'billboard' && value.output.kind !== 'mesh') {
    return invalid(`${path}.output.kind`, "'billboard' or 'mesh'", emitterId);
  }
  if (!isString(value.output.material))
    return invalid(`${path}.output.material`, 'a non-empty material identity', emitterId);
  let output: ParticleOutputSource;
  if (value.output.kind === 'mesh') {
    if (!isString(value.output.mesh))
      return invalid(`${path}.output.mesh`, 'a non-empty mesh identity', emitterId);
    output = { kind: 'mesh', material: value.output.material, mesh: value.output.mesh };
  } else {
    output = { kind: 'billboard', material: value.output.material };
  }
  return ok({
    id: emitterId,
    capacity,
    space: value.space,
    schedule: bursts.length === 0 ? { rate: rate.value, bursts: [] } : { rate: rate.value, bursts },
    bounds: { min: min.value, max: max.value },
    backendPolicy,
    operators: operators.value,
    ...(curves === undefined ? {} : { curves: curves.value }),
    ...(gradients === undefined ? {} : { gradients: gradients.value }),
    output,
  });
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

export function normalizeParticleEffectSource(
  value: unknown,
): Result<ParticleEffectSource, ParticleSourceError> {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return invalid('effect.schemaVersion', 'the supported schema version 1');
  }
  if (!Array.isArray(value.emitters) || value.emitters.length === 0) {
    return invalid('effect.emitters', 'at least one emitter');
  }
  const emitters: ParticleEmitterSource[] = [];
  const seenIds = new Set<string>();
  for (const [index, emitter] of value.emitters.entries()) {
    const result = validateEmitter(emitter, `effect.emitters[${index}]`, seenIds);
    if (!result.ok) return result;
    emitters.push(result.value);
    seenIds.add(result.value.id);
  }
  return ok(sortJson({ schemaVersion: 1, emitters }) as ParticleEffectSource);
}

export const parseParticleEffectSource = normalizeParticleEffectSource;
export const defineParticleEffectSource = normalizeParticleEffectSource;

export function serializeParticleEffectSource(source: ParticleEffectSource): string {
  return JSON.stringify(sortJson(source));
}

type ResultErr<E> = Extract<Result<never, E>, { readonly ok: false }>;
