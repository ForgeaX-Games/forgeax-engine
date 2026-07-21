import { describe, expect, it } from 'vitest';
import { defineComponent, World } from '@forgeax/engine-ecs';
import type { PeerId } from '../src/endpoint/endpoint';
import { createMemoryEndpointPair } from '../src/endpoint/memory';
import { encodeReplicationBatch } from '../src/replication/codec';
import { createReplicaCoordinator } from '../src/replication/replica';
import { defineReplication } from '../src/replication/profile';
import { NetSession } from '../src/session/net-session';

const NetworkedFatal = defineComponent('NetworkedFatal', { enabled: 'bool' });

function profile() {
  const result = defineReplication({
    name: 'replica-fatal-stop',
    entities: { with: [NetworkedFatal] },
    components: [NetworkedFatal],
  });
  if (!result.ok) throw result.error;
  return result.value;
}

describe('replica fatal apply stop', () => {
  it('stops later trusted applies after a real post-validation ECS write invariant failure', () => {
    const replication = profile();
    const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
    const replica = createReplicaCoordinator(new World(), replication, replicaEndpoint);
    const session = new NetSession({ endpoint: replicaEndpoint, maxRawMessages: 8 });
    session.attachReplica(replica, replication.limits);
    authorityEndpoint.poll();
    session.receiveEvents();

    const invalidWrite = encodeReplicationBatch(
      {
        version: 1,
        fingerprint: replication.fingerprint,
        tick: 1,
        full: true,
        entities: [{ id: 1, kind: 'upsert', components: [{ name: 'NetworkedFatal', operation: 'remove', data: {} }] }],
      },
      replication.limits,
    ).unwrap();
    authorityEndpoint.send(2 as PeerId, invalidWrite).unwrap();
    const fatal = session.receiveEvents();
    expect(fatal).toHaveLength(1);
    expect(fatal[0]!.code).toBe('apply-invariant-failed');
    expect(replica.stopped).toBe(true);
    expect(replica.snapshot()).toEqual([{ id: 1, components: [] }]);

    const validLater = encodeReplicationBatch(
      {
        version: 1,
        fingerprint: replication.fingerprint,
        tick: 2,
        full: false,
        entities: [{ id: 1, kind: 'upsert', components: [{ name: 'NetworkedFatal', data: { enabled: true } }] }],
      },
      replication.limits,
    ).unwrap();
    authorityEndpoint.send(2 as PeerId, validLater).unwrap();
    const stopped = session.receiveEvents();
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.code).toBe('apply-invariant-failed');
    expect(replica.snapshot()).toEqual([{ id: 1, components: [] }]);
  });
});
