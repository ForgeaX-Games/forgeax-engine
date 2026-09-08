import type { PointShape } from '../components/points';

export interface PointsLinesViewport {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

export type PointsLinesStyle =
  | { readonly kind: 'points'; readonly sizePx: number; readonly shape: PointShape }
  | { readonly kind: 'lines'; readonly widthPx: number };

export type PointsLinesInvalidation = 'none' | 'mesh' | 'material' | 'style' | 'view' | 'scene';

/**
 * Detached facts retained between frames for the Points/Lines owner.
 *
 * The snapshot deliberately contains no World, ECS row, AssetRegistry, GPU
 * handle, or derived triangle data. Mesh and material generations are the
 * producer-owned fences used by prepare; viewport and projection are the
 * only camera-owned facts in this projection.
 */
export interface PointsLinesRetainedSnapshot {
  readonly worldId: number;
  readonly entityKey: number;
  readonly component: 'Points' | 'Lines' | undefined;
  readonly meshHandle: number;
  readonly meshGeneration: number;
  readonly materialHandle: number;
  readonly materialGeneration: number;
  readonly style: PointsLinesStyle | undefined;
  readonly layer: number;
  readonly sortKey: number | undefined;
  readonly visible: boolean;
  readonly sourceBounds: Float32Array;
  readonly viewport: PointsLinesViewport;
  readonly projection: Float32Array;
  readonly dedicatedResourceBytes?: number;
}

export interface PointsLinesSnapshotInput
  extends Omit<
    PointsLinesRetainedSnapshot,
    'sourceBounds' | 'viewport' | 'projection' | 'sortKey'
  > {
  readonly sortKey?: number | undefined;
  readonly sourceBounds: ArrayLike<number>;
  readonly viewport: PointsLinesViewport;
  readonly projection: ArrayLike<number>;
}

export function createPointsLinesSnapshot(
  input: PointsLinesSnapshotInput,
): PointsLinesRetainedSnapshot {
  return {
    worldId: input.worldId,
    entityKey: input.entityKey,
    component: input.component,
    meshHandle: input.meshHandle,
    meshGeneration: input.meshGeneration,
    materialHandle: input.materialHandle,
    materialGeneration: input.materialGeneration,
    style: input.style === undefined ? undefined : { ...input.style },
    layer: input.layer,
    sortKey: input.sortKey,
    visible: input.visible,
    sourceBounds: new Float32Array(input.sourceBounds),
    viewport: { ...input.viewport },
    projection: new Float32Array(input.projection),
    ...(input.component === undefined ? { dedicatedResourceBytes: 0 } : {}),
  };
}

export function comparePointsLinesSnapshots(
  previous: PointsLinesRetainedSnapshot,
  next: PointsLinesRetainedSnapshot,
): PointsLinesInvalidation {
  if (
    previous.meshHandle !== next.meshHandle ||
    previous.meshGeneration !== next.meshGeneration ||
    !sameArray(previous.sourceBounds, next.sourceBounds)
  ) {
    return 'mesh';
  }
  if (
    previous.materialHandle !== next.materialHandle ||
    previous.materialGeneration !== next.materialGeneration
  ) {
    return 'material';
  }
  if (!sameValue(previous.style, next.style)) return 'style';
  if (
    previous.viewport.width !== next.viewport.width ||
    previous.viewport.height !== next.viewport.height ||
    previous.viewport.dpr !== next.viewport.dpr ||
    !sameArray(previous.projection, next.projection)
  ) {
    return 'view';
  }
  if (
    previous.worldId !== next.worldId ||
    previous.entityKey !== next.entityKey ||
    previous.layer !== next.layer ||
    previous.sortKey !== next.sortKey ||
    previous.visible !== next.visible
  ) {
    return 'scene';
  }
  return 'none';
}

function sameArray(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameValue(
  left: PointsLinesStyle | undefined,
  right: PointsLinesStyle | undefined,
): boolean {
  if (left?.kind !== right?.kind) return false;
  if (left === undefined || right === undefined) return left === right;
  if (left.kind === 'points' && right.kind === 'points') {
    return left.sizePx === right.sizePx && left.shape === right.shape;
  }
  return left.kind === 'lines' && right.kind === 'lines' && left.widthPx === right.widthPx;
}
