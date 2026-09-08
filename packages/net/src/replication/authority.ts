import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { projectComponentData } from '@forgeax/engine-ecs/externalization';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { SessionId } from '../session/recovery';
import { encodeReplicationPacket } from './codec';
import { REPLICATION_PROTOCOL_VERSION } from './constants';
import type { NetError } from './errors';
import { DEFAULT_REPLICATION_LIMITS, type ReplicationProfile } from './profile';
import type {
  ReplicationComponentRecord,
  ReplicationDataPacket,
  ReplicationEntityRecord,
} from './protocol';

export type PublishedPacket = ReplicationDataPacket & {
  readonly bytes: Uint8Array;
};
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
  #epoch = 0;
  #sequence = 0;
  readonly #sessionId: SessionId;
  constructor(world: World, profile: ReplicationProfile, sessionId: SessionId = 1 as SessionId) {
    this.#world = world;
    this.#profile = profile;
    this.#sessionId = sessionId;
  }
  idFor(entity: EntityHandle): number {
    return this.#ids.get(entity) ?? 0;
  }
  publish(): Result<PublishedPacket, NetError> {
    return this.#publish(false);
  }
  publishFull(): Result<PublishedPacket, NetError> {
    return this.#publish(true);
  }
  nextPublicationEpoch(forceFull = false): number {
    return forceFull && this.#tick > 0 ? this.#epoch + 1 : this.#epoch;
  }
  #publish(forceFull: boolean): Result<PublishedPacket, NetError> {
    const candidateIds = new Map(this.#ids);
    let candidateNextId = this.#nextId;
    const current = new Map<
      EntityHandle,
      { id: number; components: ReplicationComponentRecord[] }
    >();
    const query = this.#world.query(this.#profile.entities).unwrap();
    // Allocate every visible entity id before projecting any component data.
    // Query iteration visits storage groups independently, so projecting while
    // discovering ids can encode references to a later chunk as zero.
    for (const row of query) {
      if (!candidateIds.has(row.entity)) candidateIds.set(row.entity, candidateNextId++);
    }
    for (const row of query) {
      const entity = row.entity;
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

    const full = forceFull || this.#tick === 0;
    let nextEpoch = this.#epoch;
    let nextSequence = this.#sequence;
    if (forceFull && this.#tick > 0) {
      nextEpoch += 1;
      nextSequence = 0;
    }
    if (full && nextSequence === 0) nextSequence = 1;
    else nextSequence += 1;
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

    const packet: ReplicationDataPacket = full
      ? {
          version: REPLICATION_PROTOCOL_VERSION,
          kind: 'baseline',
          sessionId: this.#sessionId,
          epoch: nextEpoch,
          sequence: nextSequence as 1,
          fingerprint: this.#profile.fingerprint,
          tick: this.#tick + 1,
          entities,
        }
      : {
          version: REPLICATION_PROTOCOL_VERSION,
          kind: 'delta',
          sessionId: this.#sessionId,
          epoch: nextEpoch,
          sequence: nextSequence,
          fingerprint: this.#profile.fingerprint,
          tick: this.#tick + 1,
          entities,
        };
    const encoded = encodeReplicationPacket(
      packet,
      this.#profile.limits ?? DEFAULT_REPLICATION_LIMITS,
    );
    if (!encoded.ok) return err(encoded.error);

    this.#ids.clear();
    for (const [entity, id] of candidateIds) this.#ids.set(entity, id);
    this.#known.clear();
    for (const [entity, known] of candidateKnown) this.#known.set(entity, known);
    this.#nextId = candidateNextId;
    this.#tick = packet.tick;
    this.#epoch = nextEpoch;
    this.#sequence = nextSequence;
    return ok({ ...packet, bytes: encoded.value });
  }
}
export function createAuthorityCoordinator(
  world: World,
  profile: ReplicationProfile,
): AuthorityCoordinator {
  return new AuthorityCoordinator(world, profile);
}
