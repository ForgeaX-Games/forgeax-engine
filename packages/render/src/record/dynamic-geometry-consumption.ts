import type { World } from '@forgeax/engine-ecs';
import type { DynamicGeometryRecordStageLane } from '../dynamic-geometry';
import type { ValidatedRenderable } from './frame-snapshot';

type RecordStageDrawLane = 'cpu' | 'gpu';

interface PendingDynamicGeometryBinding {
  readonly meshHandle: number;
  readonly lanes: Set<RecordStageDrawLane>;
}

/** Capture the render-stage mesh binding used by the current submitted frame. */
export function createDynamicGeometryConsumptionRecorder(
  worlds: readonly World[],
  bindings: WeakMap<World, Map<number, PendingDynamicGeometryBinding>>,
): (entry: ValidatedRenderable, lane?: RecordStageDrawLane) => void {
  return (entry, lane = 'cpu') => {
    const renderable = entry.source;
    const world = worlds[renderable.worldId];
    if (world === undefined) return;
    let worldBindings = bindings.get(world);
    if (worldBindings === undefined) {
      worldBindings = new Map();
      bindings.set(world, worldBindings);
    }
    const existing = worldBindings.get(renderable.entityKey);
    if (existing === undefined || existing.meshHandle !== renderable.assetHandle) {
      worldBindings.set(renderable.entityKey, {
        meshHandle: renderable.assetHandle,
        lanes: new Set([lane]),
      });
      return;
    }
    existing.lanes.add(lane);
  };
}

export interface DynamicGeometryFrameBindings {
  begin(): void;
  onRenderableDraw(
    worlds: readonly World[],
  ): (entry: ValidatedRenderable, lane?: RecordStageDrawLane) => void;
  commit(submitted: boolean): void;
  isConsumed(world: World, entity: number, meshHandle: number | undefined): boolean;
  recordStageLane(
    world: World,
    entity: number,
    meshHandle: number | undefined,
  ): DynamicGeometryRecordStageLane | undefined;
}

/** Own the submitted-frame receipt used by dynamic-geometry publication. */
export function createDynamicGeometryFrameBindings(): DynamicGeometryFrameBindings {
  let submitted = new WeakMap<World, ReadonlyMap<number, PendingDynamicGeometryBinding>>();
  let pending = new WeakMap<World, Map<number, PendingDynamicGeometryBinding>>();
  return {
    begin(): void {
      submitted = new WeakMap();
      pending = new WeakMap();
    },
    onRenderableDraw(worlds): (entry: ValidatedRenderable, lane?: RecordStageDrawLane) => void {
      return createDynamicGeometryConsumptionRecorder(worlds, pending);
    },
    commit(didSubmit): void {
      if (didSubmit) submitted = pending;
    },
    isConsumed(world, entity, meshHandle): boolean {
      if (!Number.isInteger(entity) || meshHandle === undefined) return false;
      return submitted.get(world)?.get(entity)?.meshHandle === meshHandle;
    },
    recordStageLane(world, entity, meshHandle): DynamicGeometryRecordStageLane | undefined {
      if (!Number.isInteger(entity) || meshHandle === undefined) return undefined;
      const binding = submitted.get(world)?.get(entity);
      if (binding?.meshHandle !== meshHandle) return undefined;
      if (binding.lanes.size > 1) return 'mixed';
      return binding.lanes.has('gpu') ? 'gpu' : 'cpu';
    },
  };
}
