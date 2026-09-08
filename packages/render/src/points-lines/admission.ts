import { err, type MaterialAsset, type MeshAsset, ok, type Result } from '@forgeax/engine-types';
import { type PointShape, PointShapeValue, pointShapeFromU32 } from '../components/points';
import type {
  PointsLinesBudgetExceededError,
  PointsLinesInvalidStyleError,
  PointsLinesMaterialUnsupportedError,
  PointsLinesStyleUnsupportedError,
  PointsLinesTopologyMismatchError,
} from '../errors/render';
import {
  PointsLinesBudgetExceededError as BudgetError,
  PointsLinesInvalidStyleError as InvalidStyleError,
  PointsLinesMaterialUnsupportedError as MaterialError,
  PointsLinesStyleUnsupportedError as StyleError,
  PointsLinesTopologyMismatchError as TopologyError,
} from '../errors/render';

export interface PointsStyleInput {
  readonly sizePx?: number;
  readonly shape?: number;
}

export interface LinesStyleInput {
  readonly widthPx?: number;
}

export interface PointsLinesAdmissionLimits {
  readonly maxPoints?: number;
  readonly maxSegments?: number;
}

export interface PointsLinesAdmissionInput {
  readonly entity: number;
  readonly points?: PointsStyleInput;
  readonly lines?: LinesStyleInput;
  readonly mesh: MeshAsset;
  readonly material: MaterialAsset;
  readonly limits?: PointsLinesAdmissionLimits;
  readonly materialId?: string;
}

export interface PointsLinesAdmission {
  readonly component: 'Points' | 'Lines';
  readonly shape?: PointShape;
  readonly sizePx?: number;
  readonly widthPx?: number;
  readonly pointCount: number;
  readonly segmentCount: number;
  readonly submeshes: readonly number[];
}

export type PointsLinesAdmissionError =
  | PointsLinesInvalidStyleError
  | PointsLinesTopologyMismatchError
  | PointsLinesStyleUnsupportedError
  | PointsLinesMaterialUnsupportedError
  | PointsLinesBudgetExceededError;

function invalidStyle(
  input: PointsLinesAdmissionInput,
  component: 'Points' | 'Lines' | 'Points/Lines',
  field: string,
  value: number | string | undefined,
  expected: string,
): Result<never, PointsLinesAdmissionError> {
  return err(new InvalidStyleError({ entity: input.entity, component, field, value, expected }));
}

function topologyMismatch(
  input: PointsLinesAdmissionInput,
  submesh: number,
  expected: string,
  actual: string,
): Result<never, PointsLinesAdmissionError> {
  return err(new TopologyError({ entity: input.entity, submesh, expected, actual }));
}

function checkStyle(
  input: PointsLinesAdmissionInput,
): Result<
  { component: 'Points' | 'Lines'; shape?: PointShape; sizePx?: number; widthPx?: number },
  PointsLinesAdmissionError
> {
  const hasPoints = input.points !== undefined;
  const hasLines = input.lines !== undefined;
  if (hasPoints && hasLines) {
    return invalidStyle(
      input,
      'Points/Lines',
      'components',
      'Points + Lines',
      'exactly one style component',
    );
  }
  if (!hasPoints && !hasLines) {
    return invalidStyle(input, 'Points/Lines', 'components', undefined, 'one style component');
  }

  if (hasPoints) {
    const sizePx = input.points?.sizePx ?? 4;
    const shapeValue = input.points?.shape ?? PointShapeValue.square;
    const shape = pointShapeFromU32(shapeValue);
    if (!Number.isFinite(sizePx) || sizePx <= 0) {
      return invalidStyle(input, 'Points', 'sizePx', sizePx, 'finite sizePx > 0');
    }
    if (shape === undefined) {
      return invalidStyle(input, 'Points', 'shape', shapeValue, "shape is 'square' or 'circle'");
    }
    return ok({ component: 'Points', shape, sizePx });
  }

  const widthPx = input.lines?.widthPx ?? 1;
  if (!Number.isFinite(widthPx) || widthPx <= 0) {
    return invalidStyle(input, 'Lines', 'widthPx', widthPx, 'finite widthPx > 0');
  }
  return ok({ component: 'Lines', widthPx });
}

function checkTopology(
  input: PointsLinesAdmissionInput,
  component: 'Points' | 'Lines',
): Result<
  { pointCount: number; segmentCount: number; submeshes: readonly number[] },
  PointsLinesAdmissionError
> {
  const expected = component === 'Points' ? 'point-list' : 'line-list';
  let pointCount = 0;
  let segmentCount = 0;
  const acceptedSubmeshes: number[] = [];
  let sawNonEmpty = false;

  for (const [submeshIndex, submesh] of input.mesh.submeshes.entries()) {
    const indexed = input.mesh.indices !== undefined && submesh.indexCount > 0;
    const elementCount = indexed ? submesh.indexCount : submesh.vertexCount;
    if (elementCount === 0) continue;
    sawNonEmpty = true;

    if (component === 'Lines' && submesh.topology === 'line-strip') {
      return err(
        new StyleError({
          lane: 'admission',
          field: 'topology',
          member: 'line-strip',
          supported: ['line-list'],
        }),
      );
    }
    if (submesh.topology !== expected) {
      return topologyMismatch(input, submeshIndex, expected, submesh.topology);
    }
    if (component === 'Lines' && elementCount % 2 !== 0) {
      return topologyMismatch(input, submeshIndex, 'line-list pairs', 'line-list odd tail');
    }
    acceptedSubmeshes.push(submeshIndex);
    if (component === 'Points') pointCount += elementCount;
    else segmentCount += elementCount / 2;
  }

  if (!sawNonEmpty) return topologyMismatch(input, 0, expected, 'empty-range');
  return ok({ pointCount, segmentCount, submeshes: acceptedSubmeshes });
}

function checkMaterial(input: PointsLinesAdmissionInput): Result<void, PointsLinesAdmissionError> {
  const passes = input.material.passes ?? [];
  const unlitModules = new Set(['forgeax_material::unlit', 'forgeax::default-unlit']);
  if (passes.length !== 1 || passes[0] === undefined) {
    const pass =
      passes.find(
        (candidate) => candidate.name === 'deferred' || candidate.name === 'shadow-caster',
      ) ?? passes[0];
    return err(
      new MaterialError({
        entity: input.entity,
        material: input.materialId ?? '<anonymous>',
        pass: pass?.name ?? '<empty>',
        module: pass?.program.module ?? '<empty>',
        reason: 'points-lines admission requires one unlit forward pass',
      }),
    );
  }
  const pass = passes[0];
  const lightMode = (pass.renderState?.tags as Record<string, unknown> | undefined)?.LightMode;
  if (
    !unlitModules.has(pass.program.module) ||
    pass.name !== 'forward' ||
    lightMode === 'ShadowCaster'
  ) {
    return err(
      new MaterialError({
        entity: input.entity,
        material: input.materialId ?? '<anonymous>',
        pass: pass.name,
        module: pass.program.module,
        reason: 'points-lines admission requires an engine-owned unlit forward pass',
      }),
    );
  }
  return ok(undefined);
}

/** Validate one complete Points/Lines candidate before any renderer publication. */
export function admitPointsLines(
  input: PointsLinesAdmissionInput,
): Result<PointsLinesAdmission, PointsLinesAdmissionError> {
  const style = checkStyle(input);
  if (!style.ok) return style;
  const topology = checkTopology(input, style.value.component);
  if (!topology.ok) return topology;
  const material = checkMaterial(input);
  if (!material.ok) return material;

  if (style.value.component === 'Points' && input.limits?.maxPoints !== undefined) {
    if (topology.value.pointCount > input.limits.maxPoints) {
      return err(
        new BudgetError({
          lane: 'admission',
          requested: topology.value.pointCount,
          limit: input.limits.maxPoints,
          unit: 'points',
        }),
      );
    }
  }
  if (style.value.component === 'Lines' && input.limits?.maxSegments !== undefined) {
    if (topology.value.segmentCount > input.limits.maxSegments) {
      return err(
        new BudgetError({
          lane: 'admission',
          requested: topology.value.segmentCount,
          limit: input.limits.maxSegments,
          unit: 'segments',
        }),
      );
    }
  }

  return ok({ ...style.value, ...topology.value });
}
