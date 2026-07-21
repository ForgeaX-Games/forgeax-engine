import { describe, expect, it } from 'vitest';
import { defineComponent, World } from '@forgeax/engine-ecs';
import type { PeerId } from '../src/endpoint/endpoint';
import {
  createMemoryEndpointPairWithController,
  type MemoryFaultController,
} from '../src/endpoint/memory';
import { encodeReplicationBatch, type ReplicationBatch } from '../src/replication/codec';
import { createReplicaCoordinator, type ReplicaCoordinator } from '../src/replication/replica';
import { defineReplication, type ReplicationProfile } from '../src/replication/profile';
import { NetSession } from '../src/session/net-session';

const NetworkedRejected = defineComponent('NetworkedRejected', { enabled: 'bool' });
const LinkRejected = defineComponent('LinkRejected', { target: 'entity' });

function profile() {
  const result = defineReplication({
    name: 'memory-rejection-falsification',
    entities: { with: [NetworkedRejected] },
    components: [NetworkedRejected, LinkRejected],
    limits: { maxMessageBytes: 256 },
  });
  if (!result.ok) throw result.error;
  return result.value;
}

function snapshot(replica: ReplicaCoordinator) {
  return replica.snapshot().map(({ id, components }) => ({
    id,
    components,
    enabled: replica.readComponent(id, NetworkedRejected)?.enabled,
    target: replica.readComponent(id, LinkRejected)?.target,
  }));
}

function batch(profile: ReplicationProfile, tick: number, entities: ReplicationBatch['entities']): Uint8Array {
  return encodeReplicationBatch(
    { version: 1, fingerprint: profile.fingerprint, tick, full: false, entities },
    profile.limits,
  ).unwrap();
}

type RejectionCase = {
  readonly name: string;
  readonly code:
    | 'decode-invalid-payload'
    | 'decode-limit-exceeded'
    | 'schema-invalid'
    | 'ordering-invalid-tick'
    | 'identity-invalid'
    | 'remap-unresolved-reference';
  readonly bytes: (profile: ReplicationProfile) => Uint8Array;
  readonly fault?: (controller: MemoryFaultController) => void;
};

const cases: readonly RejectionCase[] = [
  {
    name: 'malformed',
    code: 'decode-invalid-payload',
    bytes: (replication) => batch(replication, 2, []),
    fault: (controller) => controller.malformNextDelivery(),
  },
  {
    name: 'truncated',
    code: 'decode-invalid-payload',
    bytes: () => new TextEncoder().encode('{"version":1'),
  },
  {
    name: 'over-limit',
    code: 'decode-limit-exceeded',
    bytes: () => new Uint8Array(257),
  },
  {
    name: 'schema',
    code: 'schema-invalid',
    bytes: (replication) =>
      batch(replication, 2, [
        { id: 1, kind: 'upsert', components: [{ name: 'NetworkedRejected', data: { forged: true } }] },
      ]),
  },
  {
    name: 'order',
    code: 'ordering-invalid-tick',
    bytes: (replication) => batch(replication, 1, []),
  },
  {
    name: 'identity',
    code: 'identity-invalid',
    bytes: (replication) => batch(replication, 2, [{ id: 0, kind: 'upsert', components: [] }]),
  },
  {
    name: 'unresolved reference',
    code: 'remap-unresolved-reference',
    bytes: (replication) =>
      batch(replication, 2, [
        { id: 2, kind: 'upsert', components: [{ name: 'LinkRejected', data: { target: 77 } }] },
      ]),
  },
];

describe('memory protocol rejection falsification', () => {
  it.each(cases)('$name rejection disconnects without World mutation or recovery', ({ code, bytes, fault }) => {
    const replication = profile();
    const { endpoints: [authorityEndpoint, replicaEndpoint], controller } =
      createMemoryEndpointPairWithController();
    const replica = createReplicaCoordinator(new World(), replication, replicaEndpoint);
    const session = new NetSession({ endpoint: replicaEndpoint, maxRawMessages: 8 });
    session.attachReplica(replica, replication.limits);
    authorityEndpoint.poll();
    session.receiveEvents();

    authorityEndpoint
      .send(
        2 as PeerId,
        batch(replication, 1, [
          {
            id: 1,
            kind: 'upsert',
            components: [{ name: 'NetworkedRejected', data: { enabled: true } }],
          },
        ]),
      )
      .unwrap();
    expect(session.receiveEvents()).toEqual([]);
    const before = snapshot(replica);

    fault?.(controller);
    authorityEndpoint.send(2 as PeerId, bytes(replication)).unwrap();
    const errors = session.receiveEvents();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe(code);
    expect(snapshot(replica)).toEqual(before);
    expect(authorityEndpoint.poll()).toContainEqual({ kind: 'peer-disconnected', peerId: 2 });
    expect(authorityEndpoint.send(2 as PeerId, batch(replication, 2, [])).ok).toBe(false);
  });
});
