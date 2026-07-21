// @forgeax/engine-ecs — CommandBuffer: deferred structural changes.
//
// System execution queues spawn/despawn/addComponent/removeComponent commands.
// world.update() flushes the queue at frame end with while(queue.length > 0)
// cascade support (D-06). Deferred spawn returns pending Entity handle (D-07).

import type { Component, ComponentSchema } from './component';
import { validateComponentDataKeys } from './component-default-fallback';
import type { EntityHandle } from './entity-handle';
import type { ComponentData } from './world';

// ────────────────────────────────────────────────────────────────────────────
// Command types
// ────────────────────────────────────────────────────────────────────────────

export type Command =
  | { type: 'spawn'; componentDatas: ComponentData[]; entity: EntityHandle }
  | { type: 'despawn'; entity: EntityHandle }
  | { type: 'addComponent'; entity: EntityHandle; componentData: ComponentData }
  | { type: 'removeComponent'; entity: EntityHandle; component: Component };

// ────────────────────────────────────────────────────────────────────────────
// CommandBuffer interface
// ────────────────────────────────────────────────────────────────────────────

/**
 * CommandBuffer queues structural changes (spawn/despawn/addComponent/removeComponent)
 * during system execution. Flushed at end of world.update().
 */
export interface CommandBuffer {
  /** Deferred spawn: returns pending Entity handle. */
  spawn(...componentDatas: ComponentData[]): EntityHandle;
  /** Deferred despawn. */
  despawn(entity: EntityHandle): void;
  /** Deferred addComponent. */
  addComponent<S extends ComponentSchema>(
    entity: EntityHandle,
    componentData: ComponentData<S>,
  ): void;
  /** Deferred removeComponent. */
  removeComponent<S extends ComponentSchema>(
    entity: EntityHandle,
    component: Component<string, S>,
  ): void;
  /** Check if an entity is pending (deferred spawn, not yet flushed). */
  isDeferred(entity: EntityHandle): boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// World access interface (avoids circular import)
// ────────────────────────────────────────────────────────────────────────────

/** Minimal world interface needed by CommandBuffer for entity allocation. */
export interface WorldForCommands {
  /**
   * Allocate a pending entity index, returning [entity handle, index slot].
   * @internal
   */
  _allocatePendingEntity(): EntityHandle;
  /**
   * Mark a pending entity as materialized (flush phase).
   * @internal
   */
  _materializePendingEntity(entity: EntityHandle, componentDatas: ComponentData[]): void;
  /** Execute despawn directly (flush phase). */
  despawn(entity: EntityHandle): void;
  /** Execute addComponent directly (flush phase). */
  addComponent<S extends ComponentSchema>(
    entity: EntityHandle,
    componentData: ComponentData<S>,
  ): void;
  /** Execute removeComponent directly (flush phase). */
  removeComponent<S extends ComponentSchema>(
    entity: EntityHandle,
    component: Component<string, S>,
  ): void;
}

// ────────────────────────────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────────────────────────────

export interface CommandBufferImpl extends CommandBuffer {
  /** @internal */
  _queue: Command[];
  /** @internal */
  _pendingEntities: Set<number>;
}

/**
 * Create a CommandBuffer bound to a World.
 * @param world - the World (for pending entity allocation)
 */
export function createCommandBuffer(world: WorldForCommands): CommandBufferImpl {
  const queue: Command[] = [];
  const pendingEntities = new Set<number>();

  const buffer: CommandBufferImpl = {
    _queue: queue,
    _pendingEntities: pendingEntities,

    spawn(...componentDatas: ComponentData[]): EntityHandle {
      // bug-20260615: validate raw spawn keys at queue time (synchronous,
      // points at the calling system's stack) rather than only at flush
      // time. Commands.spawn returns EntityHandle (no Result channel), so
      // unknown-key surfaces as a thrown SpawnDataUnknownFieldError here —
      // matches AGENTS.md "throw for build-time / infrastructure failures"
      // pattern; Result-channel aborts (world.spawn / world.addComponent)
      // remain returned via err().
      for (const cd of componentDatas) {
        const keyErr = validateComponentDataKeys(cd.component, cd.data as Record<string, unknown>);
        if (keyErr !== null) throw keyErr;
      }
      const entity = world._allocatePendingEntity();
      pendingEntities.add(entity as unknown as number);
      queue.push({ type: 'spawn', componentDatas, entity });
      return entity;
    },

    despawn(entity: EntityHandle): void {
      queue.push({ type: 'despawn', entity });
    },

    addComponent<S extends ComponentSchema>(
      entity: EntityHandle,
      componentData: ComponentData<S>,
    ): void {
      // bug-20260615: same fail-fast as Commands.spawn — Commands.addComponent
      // returns void, so unknown-key throws synchronously at queue time.
      const keyErr = validateComponentDataKeys(
        componentData.component,
        componentData.data as Record<string, unknown>,
      );
      if (keyErr !== null) throw keyErr;
      queue.push({ type: 'addComponent', entity, componentData: componentData as ComponentData });
    },

    removeComponent<S extends ComponentSchema>(
      entity: EntityHandle,
      component: Component<string, S>,
    ): void {
      queue.push({ type: 'removeComponent', entity, component: component as Component });
    },

    isDeferred(entity: EntityHandle): boolean {
      return pendingEntities.has(entity as unknown as number);
    },
  };

  return buffer;
}

/**
 * Flush all queued commands against the World.
 * Uses while(queue.length > 0) to support cascade (commands spawned during flush).
 */
export function flushCommands(buffer: CommandBufferImpl, world: WorldForCommands): void {
  const queue = buffer._queue;
  while (queue.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: while(queue.length > 0) guarantees shift() returns a value
    const cmd = queue.shift()!;
    switch (cmd.type) {
      case 'spawn':
        world._materializePendingEntity(cmd.entity, cmd.componentDatas);
        buffer._pendingEntities.delete(cmd.entity as unknown as number);
        break;
      case 'despawn':
        world.despawn(cmd.entity);
        break;
      case 'addComponent':
        world.addComponent(cmd.entity, cmd.componentData);
        break;
      case 'removeComponent':
        world.removeComponent(cmd.entity, cmd.component);
        break;
    }
  }
}
