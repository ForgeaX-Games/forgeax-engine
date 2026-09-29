export interface ConservativeBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface BoundsCandidate {
  readonly bounds: ConservativeBounds | undefined;
  readonly transparent: boolean;
  readonly deformed: boolean;
}

export function conservativeBounds(
  localMin: readonly [number, number, number],
  localMax: readonly [number, number, number],
): ConservativeBounds {
  return {
    min: [
      Math.min(localMin[0], localMax[0]),
      Math.min(localMin[1], localMax[1]),
      Math.min(localMin[2], localMax[2]),
    ],
    max: [
      Math.max(localMin[0], localMax[0]),
      Math.max(localMin[1], localMax[1]),
      Math.max(localMin[2], localMax[2]),
    ],
  };
}

export function encloseBounds(
  boundsList: readonly (ConservativeBounds | undefined)[],
): ConservativeBounds | undefined {
  const present = boundsList.filter((bounds): bounds is ConservativeBounds => bounds !== undefined);
  if (present.length === 0) return undefined;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const bounds of present) {
    for (let axis = 0; axis < 3; axis += 1) {
      const lower = axis === 0 ? bounds.min[0] : axis === 1 ? bounds.min[1] : bounds.min[2];
      const upper = axis === 0 ? bounds.max[0] : axis === 1 ? bounds.max[1] : bounds.max[2];
      min[axis] = Math.min(min[axis] ?? Infinity, lower ?? 0);
      max[axis] = Math.max(max[axis] ?? -Infinity, upper ?? 0);
    }
  }
  return { min, max };
}

export function conservativeVisibleCandidate(
  candidate: BoundsCandidate,
):
  | { readonly visible: true; readonly queryable: false }
  | { readonly visible: false; readonly queryable: true; readonly bounds: ConservativeBounds } {
  if (candidate.bounds === undefined || candidate.transparent || candidate.deformed) {
    return { visible: true, queryable: false };
  }
  return { visible: false, queryable: true, bounds: candidate.bounds };
}
