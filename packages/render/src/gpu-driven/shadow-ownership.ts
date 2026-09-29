import { gpuDrivenShadowDrawKey } from '../extract/gpu-driven';
import type { RenderResourceScope } from '../publication/resource-scope';
import { worldEntityKey } from '../record/frame-snapshot';
import type {
  DispatchEntry,
  RenderableSnapshot,
  ShadowCasterMembership,
} from '../render-system-extract';

const WORLD_ENTITY_KEY_STRIDE = 4294967296;

/**
 * Extract emits world/entity keys in the transient `worlds[]` index domain,
 * while PersistentRenderScene owns stable renderer-local RenderResourceScope keys for the
 * retained GPU scene. Rebase ShadowCaster ownership at this orchestration
 * boundary before both GPU projection and CPU residual recording consume it.
 */
export function rebaseShadowCasterOwnership(
  worlds: readonly RenderResourceScope[],
  stableWorldKeys: readonly number[],
  entityKeys: ReadonlySet<number>,
  drawKeys: ReadonlySet<string>,
  membership: readonly ShadowCasterMembership[] | undefined,
): {
  readonly entityKeys: ReadonlySet<number>;
  readonly drawKeys: ReadonlySet<string>;
  readonly membership: readonly ShadowCasterMembership[] | undefined;
} {
  const rebaseWorldEntity = (composite: number): number => {
    const transientWorldId = Math.floor(composite / WORLD_ENTITY_KEY_STRIDE);
    if (
      !Number.isInteger(transientWorldId) ||
      transientWorldId < 0 ||
      transientWorldId >= worlds.length
    ) {
      return composite;
    }
    const entityKey = composite - transientWorldId * WORLD_ENTITY_KEY_STRIDE;
    return worldEntityKey(stableWorldKeys[transientWorldId] ?? transientWorldId, entityKey);
  };

  const stableMembership =
    membership === undefined
      ? undefined
      : membership.map((entry) => ({
          ...entry,
          worldEntity: rebaseWorldEntity(entry.worldEntity),
        }));
  const stableDrawKeys =
    stableMembership === undefined
      ? new Set(
          [...drawKeys].map((key) => {
            const parts = key.split(':');
            if (parts.length !== 4) return key;
            const transientWorldEntity = Number(parts[0]);
            if (!Number.isFinite(transientWorldEntity)) return key;
            return `${rebaseWorldEntity(transientWorldEntity)}:${parts[1]}:${parts[2]}:${parts[3]}`;
          }),
        )
      : new Set(
          stableMembership.map((entry) =>
            gpuDrivenShadowDrawKey(
              entry.worldEntity,
              entry.materialHandle,
              entry.drawItemIndex,
              entry.passIndex,
            ),
          ),
        );
  return {
    entityKeys: new Set([...entityKeys].map(rebaseWorldEntity)),
    drawKeys: stableDrawKeys,
    membership: stableMembership,
  };
}

type ShadowCasterPass = NonNullable<RenderableSnapshot['shadowCasterPasses']>[number];

export interface ShadowCasterOwnership {
  readonly entityKeys: ReadonlySet<number>;
  readonly drawKeys: ReadonlySet<string>;
  readonly membership: readonly ShadowCasterMembership[];
}

function samePass(left: ShadowCasterPass, right: ShadowCasterPass): boolean {
  return (
    left === right ||
    (left.drawItemIndex === right.drawItemIndex &&
      left.materialHandle === right.materialHandle &&
      left.passIndex === right.passIndex &&
      left.materialShaderId === right.materialShaderId &&
      left.vertexEntry === right.vertexEntry &&
      left.fragmentEntry === right.fragmentEntry &&
      left.cpuReason === right.cpuReason &&
      left.gpuDrivenEligible === right.gpuDrivenEligible &&
      (left.renderState === right.renderState ||
        JSON.stringify(left.renderState ?? null) === JSON.stringify(right.renderState ?? null)))
  );
}

function samePasses(
  left: readonly ShadowCasterPass[] | undefined,
  right: readonly ShadowCasterPass[] | undefined,
): boolean {
  if (left === right) return true;
  const leftLength = left?.length ?? 0;
  if (leftLength !== (right?.length ?? 0)) return false;
  for (let index = 0; index < leftLength; index += 1) {
    const leftPass = left?.[index];
    const rightPass = right?.[index];
    if (leftPass === undefined || rightPass === undefined || !samePass(leftPass, rightPass)) {
      return false;
    }
  }
  return true;
}

interface OwnershipSourceRow {
  readonly worldId: number;
  readonly entityKey: number;
  readonly visible: boolean;
  readonly passes: readonly ShadowCasterPass[] | undefined;
}

/**
 * Retained ShadowCaster ownership over the persistent scene rows. Transform,
 * bounds, and temporal changes rebuild snapshots without changing ownership,
 * so the projection compares only the ownership facts and returns the previous
 * immutable result when they match. Identity equality of the result is the
 * membership revision consumed by the GPU producer and CPU residual.
 */
export class ShadowCasterOwnershipProjection {
  private rows: OwnershipSourceRow[] = [];
  private dispatch: readonly DispatchEntry[] | undefined;
  private shadowDispatchRows: readonly number[] = [];
  private value: ShadowCasterOwnership | undefined;
  private builds = 0;

  project(
    renderables: readonly RenderableSnapshot[],
    dispatch: readonly DispatchEntry[],
  ): ShadowCasterOwnership {
    if (this.value !== undefined && this.matches(renderables, dispatch)) return this.value;
    const rows: OwnershipSourceRow[] = [];
    const entityKeys = new Set<number>();
    const drawKeys = new Set<string>();
    const membership: ShadowCasterMembership[] = [];
    for (let renderableIndex = 0; renderableIndex < renderables.length; renderableIndex += 1) {
      const snapshot = renderables[renderableIndex];
      if (snapshot === undefined) continue;
      const visible = snapshot.authorVisible !== false;
      rows.push({
        worldId: snapshot.worldId,
        entityKey: snapshot.entityKey,
        visible,
        passes: snapshot.shadowCasterPasses,
      });
      if (!visible) continue;
      const worldEntity = worldEntityKey(snapshot.worldId, snapshot.entityKey);
      for (const pass of snapshot.shadowCasterPasses ?? []) {
        membership.push(Object.freeze({ ...pass, worldEntity, renderableIndex }));
        entityKeys.add(worldEntity);
        drawKeys.add(
          gpuDrivenShadowDrawKey(
            worldEntity,
            pass.materialHandle,
            pass.drawItemIndex,
            pass.passIndex,
          ),
        );
      }
    }
    const shadowDispatchRows: number[] = [];
    for (const draw of dispatch) {
      if (draw.tags.LightMode !== 'ShadowCaster') continue;
      shadowDispatchRows.push(draw.renderableIndex);
      const snapshot = renderables[draw.renderableIndex];
      if (snapshot !== undefined)
        entityKeys.add(worldEntityKey(snapshot.worldId, snapshot.entityKey));
    }
    this.rows = rows;
    this.dispatch = dispatch;
    this.shadowDispatchRows = shadowDispatchRows;
    this.value = Object.freeze({ entityKeys, drawKeys, membership: Object.freeze(membership) });
    this.builds += 1;
    return this.value;
  }

  /** Number of ownership rebuilds since construction; steady frames keep it flat. */
  buildCount(): number {
    return this.builds;
  }

  private matches(
    renderables: readonly RenderableSnapshot[],
    dispatch: readonly DispatchEntry[],
  ): boolean {
    if (renderables.length !== this.rows.length) return false;
    for (let index = 0; index < renderables.length; index += 1) {
      const snapshot = renderables[index];
      const row = this.rows[index];
      if (
        snapshot === undefined ||
        row === undefined ||
        snapshot.worldId !== row.worldId ||
        snapshot.entityKey !== row.entityKey ||
        (snapshot.authorVisible !== false) !== row.visible ||
        !samePasses(snapshot.shadowCasterPasses, row.passes)
      ) {
        return false;
      }
    }
    if (dispatch === this.dispatch) return true;
    let cursor = 0;
    for (const draw of dispatch) {
      if (draw.tags.LightMode !== 'ShadowCaster') continue;
      if (this.shadowDispatchRows[cursor] !== draw.renderableIndex) return false;
      cursor += 1;
    }
    if (cursor !== this.shadowDispatchRows.length) return false;
    this.dispatch = dispatch;
    return true;
  }
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Retains the stable-key rebase so an unchanged ownership keeps its identity. */
export class ShadowCasterOwnershipRebase {
  private worldCount = -1;
  private stableWorldKeys: readonly number[] = [];
  private entityKeys: ReadonlySet<number> | undefined;
  private drawKeys: ReadonlySet<string> | undefined;
  private membership: readonly ShadowCasterMembership[] | undefined;
  private value: ReturnType<typeof rebaseShadowCasterOwnership> | undefined;

  rebase(
    worlds: readonly RenderResourceScope[],
    stableWorldKeys: readonly number[],
    entityKeys: ReadonlySet<number>,
    drawKeys: ReadonlySet<string>,
    membership: readonly ShadowCasterMembership[] | undefined,
  ): ReturnType<typeof rebaseShadowCasterOwnership> {
    if (
      this.value !== undefined &&
      this.worldCount === worlds.length &&
      this.entityKeys === entityKeys &&
      this.drawKeys === drawKeys &&
      this.membership === membership &&
      sameNumbers(this.stableWorldKeys, stableWorldKeys)
    ) {
      return this.value;
    }
    this.worldCount = worlds.length;
    this.stableWorldKeys = [...stableWorldKeys];
    this.entityKeys = entityKeys;
    this.drawKeys = drawKeys;
    this.membership = membership;
    this.value = rebaseShadowCasterOwnership(
      worlds,
      stableWorldKeys,
      entityKeys,
      drawKeys,
      membership,
    );
    return this.value;
  }
}
