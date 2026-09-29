import { gpuDrivenShadowDrawKey } from '../extract/gpu-driven';
import type { RenderableSnapshot, ShadowCasterMembership } from '../render-system-extract';

export interface ShadowMembershipDraw {
  readonly rows: readonly number[];
  readonly cpu: boolean;
}

/**
 * Numeric lookup over one ShadowCaster membership array. The array identity
 * is stable while membership is unchanged, so every view and frame reuses one
 * index instead of formatting draw keys per submesh.
 */
export interface ShadowMembershipLookup {
  readonly keys: readonly string[];
  readonly keySet: ReadonlySet<string>;
  readonly draws: ReadonlyMap<
    number,
    ReadonlyMap<number, ReadonlyMap<number, ShadowMembershipDraw>>
  >;
}

const lookups = new WeakMap<readonly ShadowCasterMembership[], ShadowMembershipLookup>();

export function shadowMembershipLookup(
  membership: readonly ShadowCasterMembership[],
): ShadowMembershipLookup {
  const cached = lookups.get(membership);
  if (cached !== undefined) return cached;
  const keys: string[] = [];
  const draws = new Map<number, Map<number, Map<number, { rows: number[]; cpu: boolean }>>>();
  for (let row = 0; row < membership.length; row++) {
    const entry = membership[row];
    if (entry === undefined) continue;
    keys.push(
      gpuDrivenShadowDrawKey(
        entry.worldEntity,
        entry.materialHandle,
        entry.drawItemIndex,
        entry.passIndex,
      ),
    );
    let byMaterial = draws.get(entry.worldEntity);
    if (byMaterial === undefined) {
      byMaterial = new Map();
      draws.set(entry.worldEntity, byMaterial);
    }
    let byDraw = byMaterial.get(entry.materialHandle);
    if (byDraw === undefined) {
      byDraw = new Map();
      byMaterial.set(entry.materialHandle, byDraw);
    }
    let draw = byDraw.get(entry.drawItemIndex);
    if (draw === undefined) {
      draw = { rows: [], cpu: false };
      byDraw.set(entry.drawItemIndex, draw);
    }
    draw.rows.push(row);
    if (entry.cpuReason !== undefined) draw.cpu = true;
  }
  const lookup = { keys, keySet: new Set(keys), draws };
  lookups.set(membership, lookup);
  return lookup;
}

export function shadowMembershipDraw(
  lookup: ShadowMembershipLookup,
  worldEntity: number,
  materialHandle: number,
  drawItemIndex: number,
): ShadowMembershipDraw | undefined {
  return lookup.draws.get(worldEntity)?.get(materialHandle)?.get(drawItemIndex);
}

const sourcesByRenderable = new WeakMap<
  readonly { readonly renderableIndex: number; readonly source: RenderableSnapshot }[],
  ReadonlyMap<number, RenderableSnapshot>
>();

/** Shared by every shadow view of one recorded frame. */
export function shadowSourcesByRenderable(
  ordered: readonly { readonly renderableIndex: number; readonly source: RenderableSnapshot }[],
): ReadonlyMap<number, RenderableSnapshot> {
  const cached = sourcesByRenderable.get(ordered);
  if (cached !== undefined) return cached;
  const sources = new Map<number, RenderableSnapshot>();
  for (const entry of ordered) sources.set(entry.renderableIndex, entry.source);
  sourcesByRenderable.set(ordered, sources);
  return sources;
}
