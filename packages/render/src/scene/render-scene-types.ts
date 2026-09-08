import type { RenderSceneResyncReason } from '../inspection-types';
import type { PointsLinesRetainedSnapshot } from '../points-lines/snapshot';
import type { RenderableSnapshot } from '../render-system-extract';

export type { RenderSceneResyncReason } from '../inspection-types';

export interface RenderSceneIdentity {
  readonly worldId: number;
  readonly entityKey: number;
}

export type RenderSceneOperation =
  | { readonly kind: 'create'; readonly snapshot: RenderableSnapshot }
  | (RenderSceneIdentity & {
      readonly kind: 'update-transform';
      readonly world: Float32Array;
    })
  | (RenderSceneIdentity & { readonly kind: 'remove' });

export interface RenderSceneRecord extends RenderSceneIdentity {
  readonly slot: number;
  readonly generation: number;
}

export interface RenderSceneSlot extends RenderSceneRecord {
  readonly snapshot: RenderableSnapshot;
  /** Optional detached projection carried with the retained render slot. */
  readonly pointsLines?: PointsLinesRetainedSnapshot;
}

export interface RenderSceneApplyResult {
  readonly created: number;
  readonly updated: number;
  readonly removed: number;
  readonly recreated: number;
  readonly ignoredLateUpdates: number;
  readonly createdSlots: readonly RenderSceneSlot[];
  readonly updatedSlots: readonly RenderSceneSlot[];
  readonly removedSlots: readonly RenderSceneRecord[];
  readonly recreatedSlots: readonly RenderSceneSlot[];
  readonly resynced: number;
}

export interface RenderSceneDelta {
  readonly operations: readonly RenderSceneOperation[];
  readonly overflowed?: boolean;
  readonly resync?: readonly RenderableSnapshot[];
  readonly reason?: RenderSceneResyncReason;
}

export interface RenderSceneInspection {
  readonly records: readonly RenderSceneRecord[];
  readonly slotCapacity: number;
  readonly freeSlots: number;
  readonly revision: number;
  readonly noChangeFrames: number;
  readonly deltaFrames: number;
  readonly renderableScans: number;
  readonly fullRebuilds: number;
  readonly resyncs: number;
  readonly lastResyncReason: RenderSceneResyncReason | undefined;
}

export interface RenderSceneBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}
