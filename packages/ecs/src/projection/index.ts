import type { Result } from '@forgeax/engine-types';
import type { Component } from '../component';
import { componentId } from '../component';
import type { EntityHandle } from '../entity-handle';
import type { SharedRefMutationRead } from '../shared-ref-store';
import type { WorldChangeRead } from '../storage/change-detection';
import type { EcsError, World } from '../world';
import { worldInternal } from '../world-internal';

// Owner packages that need ECS validation/default semantics consume these
// helpers through the explicit projection surface. They are intentionally not
// part of the token-first root barrel.
export { fillComponentDefaults } from '../component-default-fallback';
export {
  ComponentNotDefinedError,
  InstanceTransformsStrideMismatchError,
  ManagedBufferOutOfBoundsError,
  ResourceInvalidValueError,
  SpawnLightInvalidBoundsError,
  SpriteAnimationInvalidError,
  SpriteInstancesCountMismatchError,
  SpriteInstancesMutuallyExclusiveWithInstancesError,
  SpriteInstancesRequiresSpriteShaderError,
  StaleEntityError,
} from '../errors';

export type ProjectionChangeKind =
  | 'component-added'
  | 'component-changed'
  | 'component-removed'
  | 'derived-component-changed'
  | 'entity-removed';

export interface ProjectionChange {
  readonly entity: EntityHandle;
  readonly kind: ProjectionChangeKind;
  /** Token identity is the owner-facing component discriminator. */
  readonly component?: Component;
  /** Numeric id remains journal evidence for ECS-internal consumers. */
  readonly componentId?: number;
}

export type ProjectionRead =
  | {
      readonly status: 'delta';
      readonly cursor: number;
      readonly changes: readonly ProjectionChange[];
    }
  | {
      readonly status: 'rebuild';
      readonly cursor: number;
      readonly reason: 'journal-overflow';
    };

export interface WorldProjection {
  readonly cursor: number;
  poll(): ProjectionRead;
}

export interface WorldProjectionOptions {
  readonly components?: readonly Component[];
}

export interface RenderProjectionComponentRequest {
  readonly component: Component;
  readonly fields: readonly string[];
}

export interface RenderProjectionRequest {
  readonly components: readonly RenderProjectionComponentRequest[];
}

export interface RenderProjectionSpan {
  readonly length: number;
  readonly fields: Readonly<Record<string, ArrayLike<number>>>;
}

export interface RenderProjectionSpans {
  readonly generation: number;
  readonly sharedRefEpoch: number;
  readonly spans: readonly RenderProjectionSpan[];
}

export interface RenderChangeBatchOk {
  readonly status: 'ok';
  readonly cursor: number;
  readonly world: Extract<WorldChangeRead, { readonly status: 'ok' }>;
  readonly sharedRefs: Extract<SharedRefMutationRead, { readonly status: 'ok' }>;
}

export interface RenderChangeBatchOverflow {
  readonly status: 'overflow';
  readonly cursor: number;
  readonly resync: true;
  readonly oldestAvailable: number;
  readonly world: WorldChangeRead;
  readonly sharedRefs: SharedRefMutationRead;
}

export type RenderChangeBatch = RenderChangeBatchOk | RenderChangeBatchOverflow;

export interface RenderReadLease {
  readonly worldIdentity: string;
  readonly generation: number;
  readChanges(cursor: number): RenderChangeBatch;
  querySpans(request: RenderProjectionRequest): RenderProjectionSpans;
  inspectCursor(): number;
  dispose(): void;
}

/**
 * Read one array field through the render projection boundary without
 * materialising the component object. Render extraction uses this for hot
 * transform/instance columns; the World internals remain owned by ECS.
 */
export function readRenderArrayView(
  world: World,
  entity: EntityHandle,
  component: Component,
  fieldName: string,
): ArrayLike<number> | undefined {
  return world[worldInternal].getArrayView(entity, component, fieldName) as
    | ArrayLike<number>
    | undefined;
}

interface ProjectionCursor {
  readonly world: number;
  readonly sharedRefs: number;
}

function readProjectionSpans(
  world: World,
  generation: number,
  request: RenderProjectionRequest,
): RenderProjectionSpans {
  const queryResult = world.query({ read: request.components.map((entry) => entry.component) });
  if (!queryResult.ok) throw new Error(queryResult.error.message);
  const spansResult = queryResult.value.spans();
  if (!spansResult.ok) throw new Error(spansResult.error.message);
  const spans: RenderProjectionSpan[] = [];
  for (const span of spansResult.value) {
    const fields: Record<string, ArrayLike<number>> = {};
    for (const entry of request.components) {
      const shape = span.get(entry.component) as unknown as Record<string, ArrayLike<number>>;
      for (const fieldName of entry.fields) {
        const field = shape[fieldName];
        if (field === undefined) {
          throw new Error(
            `Render projection field '${entry.component.name}.${fieldName}' is unavailable.`,
          );
        }
        fields[`${entry.component.name}.${fieldName}`] = field;
        if (request.components.length === 1) fields[fieldName] = field;
      }
    }
    spans.push({ length: span.length, fields: Object.freeze(fields) });
  }
  return {
    generation,
    sharedRefEpoch: world[worldInternal].getSharedRefs().getMutationEpoch(),
    spans: Object.freeze(spans),
  };
}

/** Create the render-owned lease from the ECS projection boundary. */
export function createRenderReadLease(world: World, token: object = {}): RenderReadLease {
  void token;
  const sharedRefs = world[worldInternal].getSharedRefs();
  const generation = Math.max(1, world[worldInternal].getStructureEpoch());
  let disposed = false;
  let nextCursor = 1;
  const cursors = new Map<number, ProjectionCursor>([
    [
      0,
      { world: world[worldInternal].getChangeCursor(), sharedRefs: sharedRefs.getMutationEpoch() },
    ],
  ]);

  const assertLive = (): void => {
    if (disposed) throw new Error('RenderReadLease is disposed.');
  };

  const captureCursor = (): number => {
    const cursor = nextCursor++;
    cursors.set(cursor, {
      world: world[worldInternal].getChangeCursor(),
      sharedRefs: sharedRefs.getMutationEpoch(),
    });
    if (cursors.size > 8) {
      const oldest = cursors.keys().next().value;
      if (typeof oldest === 'number' && oldest !== cursor) cursors.delete(oldest);
    }
    return cursor;
  };

  return {
    worldIdentity: world.identity,
    generation,
    inspectCursor(): number {
      assertLive();
      return captureCursor();
    },
    readChanges(cursor: number): RenderChangeBatch {
      assertLive();
      const start = cursors.get(cursor);
      if (start === undefined) throw new RangeError(`Unknown RenderReadLease cursor ${cursor}.`);
      const worldRead = world[worldInternal].readChangesSince(start.world) as WorldChangeRead;
      const sharedRead = sharedRefs.readChangesSince(start.sharedRefs);
      const next = captureCursor();
      if (worldRead.status === 'overflow' || sharedRead.status === 'overflow') {
        const oldestAvailable = Math.min(
          worldRead.status === 'overflow' ? worldRead.oldestAvailable : Number.MAX_SAFE_INTEGER,
          sharedRead.status === 'overflow' ? sharedRead.oldestAvailable : Number.MAX_SAFE_INTEGER,
        );
        return {
          status: 'overflow',
          cursor: next,
          resync: true,
          oldestAvailable,
          world: worldRead,
          sharedRefs: sharedRead,
        };
      }
      return { status: 'ok', cursor: next, world: worldRead, sharedRefs: sharedRead };
    },
    querySpans(request: RenderProjectionRequest): RenderProjectionSpans {
      assertLive();
      return readProjectionSpans(world, generation, request);
    },
    dispose(): void {
      disposed = true;
      cursors.clear();
    },
  };
}

/**
 * Publish one owner-derived component value without confusing it with an
 * authored mutation. Owner packages use this narrow seam for fields such as
 * `Transform.world`: the write still passes through ECS validation and managed
 * storage, while the journal records a `derived-component-changed` fact for
 * incremental projections.
 */
export function setDerivedComponent(
  world: World,
  entity: EntityHandle,
  component: Component,
  value: Record<string, unknown>,
): Result<void, EcsError> {
  const result = world[worldInternal].setQueryRow(entity, component, value);
  if (!result.ok) return result;
  world[worldInternal].markDerivedComponentChanges(componentId(component), [entity]);
  return result;
}

/** Route an owner-domain error through the World without exposing raw internals. */
export function routeWorldError(
  world: World,
  error: unknown,
  context?: { readonly systemName: string },
): void {
  world[worldInternal].routeError(error, context);
}

/**
 * Create the narrow incremental evidence surface for an owner projection.
 * Rebuilds intentionally return a reason; complete data always comes from
 * the owner's regular Query/QuerySpan path.
 */
export function createWorldProjection(
  world: World,
  options: WorldProjectionOptions = {},
): WorldProjection {
  const componentById =
    options.components === undefined
      ? undefined
      : new Map(options.components.map((component) => [componentId(component), component]));
  const componentIds = componentById === undefined ? undefined : new Set(componentById.keys());
  let cursor = world[worldInternal].getChangeCursor();

  const pollSince = (requestedCursor: number): ProjectionRead => {
    const result = world[worldInternal].readChangesSince(requestedCursor);
    if (result.status === 'overflow') {
      cursor = result.cursor;
      return { status: 'rebuild', cursor, reason: 'journal-overflow' };
    }
    cursor = result.cursor;
    const changes: ProjectionChange[] = [];
    for (const record of result.records) {
      if (
        componentIds !== undefined &&
        record.kind !== 'entity-removed' &&
        (record.componentId === undefined || !componentIds.has(record.componentId))
      ) {
        continue;
      }
      const component =
        record.componentId === undefined ? undefined : componentById?.get(record.componentId);
      changes.push({
        entity: record.entity,
        kind: record.kind,
        ...(component === undefined ? {} : { component }),
        ...(record.componentId === undefined ? {} : { componentId: record.componentId }),
      });
    }
    return { status: 'delta', cursor, changes };
  };

  return {
    get cursor(): number {
      return cursor;
    },
    poll(): ProjectionRead {
      return pollSince(cursor);
    },
  };
}
