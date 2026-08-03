import type {
  ParticleCpuExecutorContext,
  ParticleCpuExecutorResult,
  ParticleCpuParticleContext,
} from '../simulation/types.js';
import type { ParticleOperatorStage } from '../source.js';

const EXAMPLE_COLOR_GRADIENT = {
  stops: [
    { time: 0, color: [1, 1, 1, 1] },
    { time: 1, color: [1, 1, 1, 0] },
  ],
};
const EXAMPLE_SIZE_CURVE = {
  points: [
    { time: 0, value: 1 },
    { time: 1, value: 0 },
  ],
};

export type StockParticleOperatorStage = ParticleOperatorStage;
export type StockParticleOperatorKind =
  | 'lifetime'
  | 'initial-velocity'
  | 'billboard'
  | 'mesh'
  | 'shape'
  | 'color-over-life'
  | 'drag'
  | 'gravity'
  | 'size-over-life';

export interface StockParticleOperatorKey {
  readonly stage: StockParticleOperatorStage;
  readonly kind: StockParticleOperatorKind;
  readonly version: 1;
}

export interface StockParticleOperatorManifestEntry extends StockParticleOperatorKey {
  readonly key: `${StockParticleOperatorStage}:${StockParticleOperatorKind}:1`;
  readonly parameterSchema: Readonly<Record<string, unknown>>;
  readonly exampleParams: unknown;
  readonly validateParams: (params: unknown) => StockParticleParameterResult;
  readonly execute: (
    context: ParticleCpuExecutorContext,
  ) => ParticleCpuExecutorResult<void, string>;
}

export type StockParticleParameterResult =
  | { readonly ok: true; readonly value: undefined }
  | { readonly ok: false; readonly error: string };

const vector3 = (value: unknown, name: string): string | undefined => {
  if (!Array.isArray(value) || value.length !== 3) return `${name} must be a 3-number array`;
  return value.every((item) => typeof item === 'number' && Number.isFinite(item))
    ? undefined
    : `${name} must be a 3-number array`;
};

const vector4 = (value: unknown, name: string): string | undefined => {
  if (!Array.isArray(value) || value.length !== 4) return `${name} must be a 4-number array`;
  return value.every((item) => typeof item === 'number' && Number.isFinite(item))
    ? undefined
    : `${name} must be a 4-number array`;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const finite = (value: unknown, name: string): string | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? undefined : `${name} must be finite`;

const nonNegative = (value: unknown, name: string): string | undefined => {
  const issue = finite(value, name);
  return (issue ?? (value as number) < 0) ? `${name} must be non-negative` : undefined;
};

const validCurve = (value: unknown, name: string): string | undefined => {
  if (!record(value) || !Array.isArray(value.points) || value.points.length < 2) {
    return `${name}.points must contain at least two points`;
  }
  let previous = -Infinity;
  for (const point of value.points) {
    if (!record(point)) return `${name}.points must contain point objects`;
    const timeIssue = finite(point.time, `${name}.points.time`);
    const valueIssue = finite(point.value, `${name}.points.value`);
    if (timeIssue !== undefined || valueIssue !== undefined) return timeIssue ?? valueIssue;
    if (
      (point.time as number) <= previous ||
      (point.time as number) < 0 ||
      (point.time as number) > 1
    ) {
      return `${name}.points.time must increase within [0, 1]`;
    }
    previous = point.time as number;
  }
  return undefined;
};

const validGradient = (value: unknown, name: string): string | undefined => {
  if (!record(value) || !Array.isArray(value.stops) || value.stops.length < 2) {
    return `${name}.stops must contain at least two stops`;
  }
  let previous = -Infinity;
  for (const stop of value.stops) {
    if (!record(stop)) return `${name}.stops must contain stop objects`;
    const timeIssue = finite(stop.time, `${name}.stops.time`);
    const colorIssue = vector4(stop.color, `${name}.stops.color`);
    if (timeIssue !== undefined || colorIssue !== undefined) return timeIssue ?? colorIssue;
    if (
      (stop.time as number) <= previous ||
      (stop.time as number) < 0 ||
      (stop.time as number) > 1
    ) {
      return `${name}.stops.time must increase within [0, 1]`;
    }
    previous = stop.time as number;
  }
  return undefined;
};

const valid = (): StockParticleParameterResult => ({ ok: true, value: undefined });
const invalid = (error: string): StockParticleParameterResult => ({ ok: false, error });

function validateLifetime(params: unknown): StockParticleParameterResult {
  if (!record(params)) return invalid('lifetime params must be an object');
  const issue = finite(params.seconds, 'seconds');
  return issue === undefined && (params.seconds as number) >= 0
    ? valid()
    : invalid(issue ?? 'seconds must be non-negative');
}

function validateShape(params: unknown): StockParticleParameterResult {
  if (!record(params)) return invalid('shape params must be an object');
  if (params.shape !== 'point' && params.shape !== 'sphere' && params.shape !== 'box') {
    return invalid("shape must be 'point', 'sphere', or 'box'");
  }
  if (params.shape === 'sphere') {
    const issue = nonNegative(params.radius, 'radius');
    return issue === undefined ? valid() : invalid(issue);
  }
  if (params.shape === 'box') {
    const issue = vector3(params.extents, 'extents');
    return issue === undefined && (params.extents as number[]).every((item) => item >= 0)
      ? valid()
      : invalid(issue ?? 'extents must be non-negative');
  }
  return valid();
}

function validateVelocity(params: unknown): StockParticleParameterResult {
  if (!record(params)) return invalid('initial velocity params must be an object');
  const issue = vector3(params.velocity, 'velocity');
  return issue === undefined ? valid() : invalid(issue);
}

function validateGravity(params: unknown): StockParticleParameterResult {
  if (!record(params)) return invalid('gravity params must be an object');
  const issue = vector3(params.acceleration, 'acceleration');
  return issue === undefined ? valid() : invalid(issue);
}

function validateDrag(params: unknown): StockParticleParameterResult {
  if (!record(params)) return invalid('drag params must be an object');
  const issue = nonNegative(params.coefficient, 'coefficient');
  return issue === undefined ? valid() : invalid(issue);
}

function validateSize(params: unknown): StockParticleParameterResult {
  if (!record(params)) return invalid('size over life params must be an object');
  const issue = validCurve(params.curve, 'curve');
  return issue === undefined ? valid() : invalid(issue);
}

function validateColor(params: unknown): StockParticleParameterResult {
  if (!record(params)) return invalid('color over life params must be an object');
  const issue = validGradient(params.gradient, 'gradient');
  return issue === undefined ? valid() : invalid(issue);
}

function validateOutput(params: unknown): StockParticleParameterResult {
  return record(params) ? valid() : invalid('output params must be an object');
}

function normalizedAge(particle: ParticleCpuParticleContext): number {
  if (!Number.isFinite(particle.lifetime) || particle.lifetime <= 0) return 0;
  return Math.min(1, Math.max(0, particle.age / particle.lifetime));
}

function interpolateCurve(
  curve: { readonly points: readonly { readonly time: number; readonly value: number }[] },
  time: number,
): number {
  const points = curve.points;
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return 0;
  if (time <= first.time) return first.value;
  if (time >= last.time) return last.value;
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index];
    const left = points[index - 1];
    if (right === undefined || left === undefined || time > right.time) continue;
    const ratio = (time - left.time) / (right.time - left.time);
    return left.value + (right.value - left.value) * ratio;
  }
  return last.value;
}

function interpolateGradient(
  gradient: {
    readonly stops: readonly { readonly time: number; readonly color: readonly number[] }[];
  },
  time: number,
  output: ParticleCpuParticleContext['color'],
): void {
  const stops = gradient.stops;
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (first === undefined || last === undefined) return;
  if (time <= first.time) {
    output.set(first.color);
    return;
  }
  if (time >= last.time) {
    output.set(last.color);
    return;
  }
  for (let index = 1; index < stops.length; index += 1) {
    const right = stops[index];
    const left = stops[index - 1];
    if (right === undefined || left === undefined || time > right.time) continue;
    const ratio = (time - left.time) / (right.time - left.time);
    for (let channel = 0; channel < 4; channel += 1) {
      const leftValue = left.color[channel] ?? 0;
      const rightValue = right.color[channel] ?? 0;
      output[channel] = leftValue + (rightValue - leftValue) * ratio;
    }
    return;
  }
}

function executeShape(
  context: ParticleCpuExecutorContext,
): ParticleCpuExecutorResult<void, string> {
  const params = context.program as {
    shape: 'point' | 'sphere' | 'box';
    radius?: number;
    extents?: number[];
  };
  if (params.shape === 'sphere') {
    const theta = context.random.nextFloat() * Math.PI * 2;
    const z = context.random.nextFloat() * 2 - 1;
    const scale = Math.sqrt(1 - z * z) * (params.radius ?? 0);
    context.particle.position[0] = Math.cos(theta) * scale;
    context.particle.position[1] = Math.sin(theta) * scale;
    context.particle.position[2] = z * (params.radius ?? 0);
  } else if (params.shape === 'box') {
    const extents = params.extents ?? [0, 0, 0];
    for (let axis = 0; axis < 3; axis += 1) {
      context.particle.position[axis] = (context.random.nextFloat() * 2 - 1) * (extents[axis] ?? 0);
    }
  } else {
    context.particle.position.fill(0);
  }
  return { ok: true, value: undefined };
}

function executeGravity(
  context: ParticleCpuExecutorContext,
): ParticleCpuExecutorResult<void, string> {
  const params = context.program as { acceleration: number[] };
  for (let axis = 0; axis < 3; axis += 1) {
    const velocity = context.particle.velocity[axis] ?? 0;
    const acceleration = params.acceleration[axis] ?? 0;
    context.particle.position[axis] =
      (context.particle.position[axis] ?? 0) + velocity * context.delta;
    context.particle.velocity[axis] = velocity + acceleration * context.delta;
  }
  return { ok: true, value: undefined };
}

function executeDrag(context: ParticleCpuExecutorContext): ParticleCpuExecutorResult<void, string> {
  const params = context.program as { coefficient: number };
  const scale = Math.exp(-params.coefficient * context.delta);
  for (let axis = 0; axis < 3; axis += 1) {
    context.particle.velocity[axis] = (context.particle.velocity[axis] ?? 0) * scale;
  }
  return { ok: true, value: undefined };
}

function executeSize(context: ParticleCpuExecutorContext): ParticleCpuExecutorResult<void, string> {
  const params = context.program as {
    curve: { points: readonly { time: number; value: number }[] };
  };
  context.particle.size = interpolateCurve(params.curve, normalizedAge(context.particle));
  return { ok: true, value: undefined };
}

function executeColor(
  context: ParticleCpuExecutorContext,
): ParticleCpuExecutorResult<void, string> {
  const params = context.program as {
    gradient: { stops: readonly { time: number; color: readonly number[] }[] };
  };
  interpolateGradient(params.gradient, normalizedAge(context.particle), context.particle.color);
  return { ok: true, value: undefined };
}

function executeLifetime(
  context: ParticleCpuExecutorContext,
): ParticleCpuExecutorResult<void, string> {
  context.particle.lifetime = (context.program as { seconds: number }).seconds;
  return { ok: true, value: undefined };
}

function executeVelocity(
  context: ParticleCpuExecutorContext,
): ParticleCpuExecutorResult<void, string> {
  context.particle.velocity.set((context.program as { velocity: readonly number[] }).velocity);
  return { ok: true, value: undefined };
}

const entry = (
  stage: StockParticleOperatorStage,
  kind: StockParticleOperatorKind,
  parameterSchema: Readonly<Record<string, unknown>>,
  exampleParams: unknown,
  validateParams: (params: unknown) => StockParticleParameterResult,
  execute: StockParticleOperatorManifestEntry['execute'],
): StockParticleOperatorManifestEntry => ({
  stage,
  kind,
  version: 1,
  key: `${stage}:${kind}:1`,
  parameterSchema,
  exampleParams,
  validateParams,
  execute,
});

export const STOCK_PARTICLE_OPERATOR_MANIFEST: readonly StockParticleOperatorManifestEntry[] = [
  entry(
    'initialize',
    'lifetime',
    { type: 'object', required: ['seconds'] },
    { seconds: 1 },
    validateLifetime,
    executeLifetime,
  ),
  entry(
    'initialize',
    'initial-velocity',
    { type: 'object', required: ['velocity'] },
    { velocity: [0, 1, 0] },
    validateVelocity,
    executeVelocity,
  ),
  entry('output', 'billboard', { type: 'object' }, {}, validateOutput, () => ({
    ok: true,
    value: undefined,
  })),
  entry('output', 'mesh', { type: 'object' }, {}, validateOutput, () => ({
    ok: true,
    value: undefined,
  })),
  entry(
    'spawn',
    'shape',
    { type: 'object', required: ['shape'] },
    { shape: 'point' },
    validateShape,
    executeShape,
  ),
  entry(
    'update',
    'color-over-life',
    { type: 'object', required: ['gradient'] },
    { gradient: EXAMPLE_COLOR_GRADIENT },
    validateColor,
    executeColor,
  ),
  entry(
    'update',
    'drag',
    { type: 'object', required: ['coefficient'] },
    { coefficient: 0.1 },
    validateDrag,
    executeDrag,
  ),
  entry(
    'update',
    'gravity',
    { type: 'object', required: ['acceleration'] },
    { acceleration: [0, -9.8, 0] },
    validateGravity,
    executeGravity,
  ),
  entry(
    'update',
    'size-over-life',
    { type: 'object', required: ['curve'] },
    { curve: EXAMPLE_SIZE_CURVE },
    validateSize,
    (context) => {
      if (context.stage !== 'update')
        return { ok: false, error: 'size-over-life requires update stage' };
      return executeSize(context);
    },
  ),
];

export function stockParticleOperatorKey(
  stage: StockParticleOperatorStage,
  kind: StockParticleOperatorKind,
  version = 1,
): string {
  return `${stage}:${kind}:${version}`;
}
