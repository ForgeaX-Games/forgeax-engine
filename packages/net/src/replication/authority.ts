import {
  createQueryState,
  Entity,
  type EntityHandle,
  projectComponentData,
  queryRun,
  type World,
} from '@forgeax/engine-ecs';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  encodeReplicationBatch,
  type ReplicationBatch,
  type ReplicationComponentRecord,
  type ReplicationEntityRecord,
} from './codec';
import { DEFAULT_REPLICATION_LIMITS } from './constants';
import type { NetError } from './errors';
import type { ReplicationProfile } from './profile';

export interface PublishedBatch extends ReplicationBatch {
  readonly bytes: Uint8Array;
}
interface KnownEntity {
  readonly id: number;
  readonly components: Map<string, string>;
}
function stable(value: unknown): string {
  return JSON.stringify(value);
}

export class AuthorityCoordinator {
  readonly #world: World;
  readonly #profile: ReplicationProfile;
  readonly #ids = new Map<EntityHandle, number>();
  readonly #known = new Map<EntityHandle, KnownEntity>();
  #nextId = 1;
  #tick = 0;
  constructor(world: World, profile: ReplicationProfile) {
    this.#world = world;
    this.#profile = profile;
  }
  idFor(entity: EntityHandle): number {
    return this.#ids.get(entity) ?? 0;
  }
  publish(): Result<PublishedBatch, NetError> {
    return this.#publish(false);
  }
  publishFull(): Result<PublishedBatch, NetError> {
    return this.#publish(true);
  }
  #publish(forceFull: boolean): Result<PublishedBatch, NetError> {
    const candidateIds = new Map(this.#ids);
    let candidateNextId = this.#nextId;
    const current = new Map<
      EntityHandle,
      { id: number; components: ReplicationComponentRecord[] }
    >();
    const state = createQueryState({
      ...this.#profile.entities,
      with: [...(this.#profile.entities.with ?? []), Entity],
    });
    // Allocate every visible entity id before projecting any component data.
    // queryRun visits archetype chunks independently, so projecting while
    // discovering ids can encode references to a later chunk as zero.
    queryRun(state, this.#world, (bundle) => {
      const entities = bundle.Entity.self as unknown as readonly EntityHandle[];
      for (const entity of entities) {
        if (!candidateIds.has(entity)) candidateIds.set(entity, candidateNextId++);
      }
    });
    queryRun(state, this.#world, (bundle) => {
      const entities = bundle.Entity.self as unknown as readonly EntityHandle[];
      for (const entity of entities) {
        const components: ReplicationComponentRecord[] = [];
        for (const component of this.#profile.components) {
          const raw = this.#world.get(entity, component);
          if (raw.ok) {
            components.push({
              name: component.name,
              data: projectComponentData(
                component,
                raw.value as Record<string, unknown>,
                (reference) => candidateIds.get(reference as EntityHandle) ?? 0,
              ),
            });
          }
        }
        const id = candidateIds.get(entity);
        if (id !== undefined) current.set(entity, { id, components });
      }
    });

    const full = forceFull || this.#tick === 0;
    const entities: ReplicationEntityRecord[] = [];
    for (const [entity, entry] of current) {
      const prior = this.#known.get(entity);
      const components =
        full || prior === undefined
          ? entry.components
          : [
              ...entry.components.filter(
                (component) => prior.components.get(component.name) !== stable(component.data),
              ),
              ...[...prior.components.keys()]
                .filter((name) => !entry.components.some((component) => component.name === name))
                .map((name) => ({ name, operation: 'remove' as const, data: {} })),
            ];
      if (full || prior === undefined || components.length > 0)
        entities.push({ id: entry.id, kind: 'upsert', components });
    }
    // A full baseline is consumed by a fresh replica, so it must describe
    // only live entities. Despawn records refer to the previous authority
    // baseline and would be unknown identities on a late-joining replica.
    if (!full)
      for (const [entity, prior] of this.#known) {
        if (!current.has(entity)) entities.push({ id: prior.id, kind: 'despawn', components: [] });
      }

    const candidateKnown = new Map<EntityHandle, KnownEntity>();
    for (const [entity, entry] of current) {
      candidateKnown.set(entity, {
        id: entry.id,
        components: new Map(
          entry.components.map((component) => [component.name, stable(component.data)]),
        ),
      });
    }
    for (const [entity] of candidateIds) {
      if (!current.has(entity)) candidateIds.delete(entity);
    }

    const batch: ReplicationBatch = {
      version: 1,
      fingerprint: this.#profile.fingerprint,
      tick: this.#tick + 1,
      full,
      entities,
    };
    const encoded = encodeReplicationBatch(
      batch,
      this.#profile.limits ?? DEFAULT_REPLICATION_LIMITS,
    );
    if (!encoded.ok) return err(encoded.error);

    this.#ids.clear();
    for (const [entity, id] of candidateIds) this.#ids.set(entity, id);
    this.#known.clear();
    for (const [entity, known] of candidateKnown) this.#known.set(entity, known);
    this.#nextId = candidateNextId;
    this.#tick = batch.tick;
    return ok({ ...batch, bytes: encoded.value });
  }
}
export function createAuthorityCoordinator(
  world: World,
  profile: ReplicationProfile,
): AuthorityCoordinator {
  return new AuthorityCoordinator(world, profile);
}
