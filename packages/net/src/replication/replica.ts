import {
  type Component,
  classifyEntityField,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { NetEndpoint } from '../endpoint/endpoint';
import { decodeReplicationBatch, type ReplicationBatch } from './codec';
import { NetError } from './errors';
import type { ReplicationLimits, ReplicationProfile } from './profile';

export class ReplicaCoordinator {
  readonly #world: World;
  readonly #profile: ReplicationProfile;
  readonly #endpoint: NetEndpoint | undefined;
  readonly #entities = new Map<number, EntityHandle>();
  #lastTick = 0;
  #stopped = false;
  constructor(world: World, profile: ReplicationProfile, endpoint?: NetEndpoint) {
    this.#world = world;
    this.#profile = profile;
    this.#endpoint = endpoint;
  }
  entityFor(id: number): EntityHandle | undefined {
    return this.#entities.get(id);
  }
  readComponent(id: number, component: Component): Record<string, unknown> | undefined {
    const entity = this.#entities.get(id);
    if (entity === undefined) return undefined;
    const read = this.#world.get(entity, component);
    return read.ok ? (read.value as Record<string, unknown>) : undefined;
  }
  snapshot(): readonly { id: number; components: readonly string[] }[] {
    return [...this.#entities]
      .map(([id, entity]) => ({
        id,
        components: this.#profile.components
          .filter((component) => this.#world.get(entity, component).ok)
          .map((component) => component.name),
      }))
      .sort((a, b) => a.id - b.id);
  }
  disconnect(): void {
    this.#endpoint?.close();
  }
  /** Remove the last replica baseline when the authority connection closes. */
  clear(): void {
    for (const entity of this.#entities.values()) this.#world.despawn(entity).unwrap();
    this.#entities.clear();
  }
  get stopped(): boolean {
    return this.#stopped;
  }
  get tick(): number {
    return this.#lastTick;
  }
  #entityReferences(value: unknown): readonly unknown[] {
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
      return Array.from(value as ArrayLike<unknown>);
    }
    return [];
  }
  validate(batch: ReplicationBatch): NetError | null {
    if (this.#stopped)
      return new NetError({
        code: 'apply-invariant-failed',
        expected: 'an active replica coordinator',
        hint: 'create a new session after a fatal apply failure',
        detail: { reason: 'replication stopped' },
      });
    if (batch.fingerprint !== this.#profile.fingerprint)
      return new NetError({
        code: 'schema-invalid',
        expected: 'a batch for the negotiated replication profile',
        hint: 'complete handshake before applying replication bytes',
        detail: { component: '', reason: 'fingerprint mismatch' },
      });
    if (batch.tick <= this.#lastTick)
      return new NetError({
        code: 'ordering-invalid-tick',
        expected: 'a strictly monotonic authority tick',
        hint: 'discard duplicate, stale, and out-of-order batches',
        detail: { receivedTick: batch.tick, lastTick: this.#lastTick },
      });
    const batchIds = new Set<number>();
    for (const record of batch.entities) {
      if (!Number.isSafeInteger(record.id) || record.id <= 0 || batchIds.has(record.id))
        return new NetError({
          code: 'identity-invalid',
          expected: 'unique non-zero NetEntityId values',
          hint: 'use session-issued identity values exactly once per batch',
          detail: { id: record.id, reason: 'zero, invalid, or duplicate identity' },
        });
      batchIds.add(record.id);
    }
    for (const record of batch.entities) {
      if (record.kind === 'despawn' && !this.#entities.has(record.id))
        return new NetError({
          code: 'identity-invalid',
          expected: 'a known identity for despawn',
          hint: 'do not reuse or despawn unknown network identities',
          detail: { id: record.id, reason: 'unknown identity' },
        });
      for (const entry of record.components) {
        const component = this.#profile.components.find(
          (candidate) => candidate.name === entry.name,
        );
        if (component === undefined)
          return new NetError({
            code: 'schema-invalid',
            expected: 'a component selected by the negotiated profile',
            hint: 'send only components from the ordered replication profile',
            detail: { component: entry.name, reason: 'unselected component' },
          });
        if (entry.operation === 'remove') continue;
        for (const [field, value] of Object.entries(entry.data)) {
          if (!(field in component.schema))
            return new NetError({
              code: 'schema-invalid',
              expected: 'component fields declared by the negotiated ECS schema',
              hint: 'send only fields declared by the replicated component token',
              detail: { component: entry.name, reason: `unknown field ${field}` },
            });
          const kind = classifyEntityField(component, field);
          const refs = kind?.isArray ? this.#entityReferences(value) : kind ? [value] : [];
          for (const reference of refs)
            if (
              reference !== null &&
              (typeof reference !== 'number' ||
                reference === 0 ||
                (!this.#entities.has(reference) && !batchIds.has(reference)))
            )
              return new NetError({
                code: 'remap-unresolved-reference',
                expected: 'every entity reference to resolve in the current or same batch',
                hint: 'include the referenced spawn in this batch; cross-batch pending references are unsupported',
                detail: { id: record.id, referencedId: Number(reference) },
              });
        }
      }
    }
    return null;
  }
  apply(batch: ReplicationBatch): Result<void, NetError> {
    const failure = this.validate(batch);
    if (failure) {
      this.disconnect();
      return err(failure);
    }
    try {
      for (const record of batch.entities)
        if (record.kind === 'upsert' && !this.#entities.has(record.id))
          this.#entities.set(record.id, this.#world.spawn().unwrap());
      for (const record of batch.entities)
        if (record.kind === 'upsert') {
          const entity = this.#entities.get(record.id);
          if (entity === undefined) throw new Error(`missing allocated entity ${record.id}`);
          for (const entry of record.components) {
            const component = this.#profile.components.find(
              (candidate) => candidate.name === entry.name,
            );
            if (component === undefined) throw new Error(`missing profile component ${entry.name}`);
            if (entry.operation === 'remove') {
              const removal = this.#world.removeComponent(entity, component);
              if (!removal.ok) throw removal.error;
              continue;
            }
            const data = Object.fromEntries(
              Object.entries(entry.data).map(([field, value]) => {
                const kind = classifyEntityField(component, field);
                if (kind === null) return [field, value];
                const mapped = kind.isArray
                  ? this.#entityReferences(value).map((id) => {
                      if (id === null) return null;
                      const reference = this.#entities.get(id as number);
                      if (reference === undefined)
                        throw new Error(`missing entity reference ${id}`);
                      return reference;
                    })
                  : value === null
                    ? null
                    : this.#entities.get(value as number);
                if (mapped === undefined) throw new Error(`missing entity reference ${value}`);
                return [field, mapped];
              }),
            );
            const typedData = data as never;
            const exists = this.#world.get(entity, component);
            const write = exists.ok
              ? this.#world.set(entity, component, typedData)
              : this.#world.addComponent(entity, { component, data: typedData });
            if (!write.ok) throw write.error;
          }
        }
      for (const record of batch.entities)
        if (record.kind === 'despawn') {
          const entity = this.#entities.get(record.id);
          if (entity === undefined) throw new Error(`missing despawn entity ${record.id}`);
          this.#world.despawn(entity).unwrap();
          this.#entities.delete(record.id);
        }
      this.#lastTick = batch.tick;
      return ok(undefined);
    } catch (cause) {
      this.#stopped = true;
      return err(
        new NetError({
          code: 'apply-invariant-failed',
          expected: 'ECS apply invariants to accept a validated batch',
          hint: 'stop this replication session and inspect the ECS error',
          detail: { reason: cause instanceof Error ? cause.message : String(cause) },
        }),
      );
    }
  }
}
export function createReplicaCoordinator(
  world: World,
  profile: ReplicationProfile,
  endpoint?: NetEndpoint,
): ReplicaCoordinator {
  return new ReplicaCoordinator(world, profile, endpoint);
}
export function applyReplicaBatch(
  replica: ReplicaCoordinator,
  batch: ReplicationBatch,
): Result<void, NetError> {
  return replica.apply(batch);
}

export function decodeAndApplyReplicaBatch(
  replica: ReplicaCoordinator,
  bytes: Uint8Array,
  limits: ReplicationLimits,
): Result<void, NetError> {
  const decoded = decodeReplicationBatch(bytes, limits);
  if (!decoded.ok) {
    replica.disconnect();
    return err(decoded.error);
  }
  return replica.apply(decoded.value);
}
