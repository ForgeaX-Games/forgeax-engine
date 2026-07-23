import { describe, expect, it } from 'vitest';
import { defineComponent, World } from '@forgeax/engine-ecs';
import { createMemoryEndpointPair } from '../src/endpoint/memory';
import { createAuthorityCoordinator } from '../src/replication/authority';
import { createReplicaCoordinator } from '../src/replication/replica';
import { defineReplication } from '../src/replication/profile';
import { NetSession } from '../src/session/net-session';

const NetworkedSession = defineComponent('NetworkedSession', { enabled: 'bool' });
const PositionSession = defineComponent('PositionSession', { x: 'f32' });

function profile() {
  const result = defineReplication({
    name: 'session-replication',
    entities: { with: [NetworkedSession] },
    components: [NetworkedSession, PositionSession],
  });
  if (!result.ok) throw result.error;
  return result.value;
}

describe('NetSession replication integration', () => {
  it('tracks actual peers, publishes canonical bytes, and applies them through a replica attachment', () => {
    const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
    const authorityWorld = new World();
    authorityWorld.spawn(
      { component: NetworkedSession, data: { enabled: true } },
      { component: PositionSession, data: { x: 7 } },
    );
    const replicaWorld = new World();
    const authoritySession = new NetSession({ endpoint: authorityEndpoint, maxRawMessages: 8 });
    const replicaSession = new NetSession({ endpoint: replicaEndpoint, maxRawMessages: 8 });
    const replication = profile();
    const replica = createReplicaCoordinator(replicaWorld, replication, replicaEndpoint);

    authoritySession.receiveEvents();
    replicaSession.receiveEvents();
    expect(authoritySession.getPeerSnapshot()).toEqual({ connected: true, peerIds: [2] });
    authoritySession.attachAuthority(createAuthorityCoordinator(authorityWorld, replication));
    replicaSession.attachReplica(replica, replication.limits);

    expect(authoritySession.publish().ok).toBe(true);
    expect(replicaSession.receiveEvents()).toEqual([]);
    expect(replica.snapshot()).toEqual([
      { id: 1, components: ['NetworkedSession', 'PositionSession'] },
    ]);
    expect(replicaSession.drainRawMessages()).toEqual([]);
  });

  it('publishes a full current baseline when a later session peer connects', () => {
    const [initialAuthorityEndpoint, initialReplicaEndpoint] = createMemoryEndpointPair();
    const authorityWorld = new World();
    authorityWorld.spawn(
      { component: NetworkedSession, data: { enabled: true } },
      { component: PositionSession, data: { x: 7 } },
    );
    const replication = profile();
    const authority = createAuthorityCoordinator(authorityWorld, replication);
    const initialAuthoritySession = new NetSession({
      endpoint: initialAuthorityEndpoint,
      maxRawMessages: 8,
    });
    const initialReplicaSession = new NetSession({
      endpoint: initialReplicaEndpoint,
      maxRawMessages: 8,
    });
    const initialReplica = createReplicaCoordinator(new World(), replication, initialReplicaEndpoint);
    initialAuthoritySession.attachAuthority(authority);
    initialReplicaSession.attachReplica(initialReplica, replication.limits);
    initialAuthoritySession.receiveEvents();
    initialReplicaSession.receiveEvents();

    expect(initialAuthoritySession.publish().ok).toBe(true);
    expect(initialReplicaSession.receiveEvents()).toEqual([]);
    expect(initialReplica.snapshot()).toEqual([
      { id: 1, components: ['NetworkedSession', 'PositionSession'] },
    ]);

    const [lateAuthorityEndpoint, lateReplicaEndpoint] = createMemoryEndpointPair();
    const lateAuthoritySession = new NetSession({ endpoint: lateAuthorityEndpoint, maxRawMessages: 8 });
    const lateReplicaSession = new NetSession({ endpoint: lateReplicaEndpoint, maxRawMessages: 8 });
    const lateReplica = createReplicaCoordinator(new World(), replication, lateReplicaEndpoint);
    lateAuthoritySession.attachAuthority(authority);
    lateReplicaSession.attachReplica(lateReplica, replication.limits);
    lateAuthoritySession.receiveEvents();
    lateReplicaSession.receiveEvents();
    const latePeer = lateAuthoritySession.getPeerSnapshot().peerIds[0];
    expect(latePeer).toBeDefined();
    if (latePeer === undefined) return;
    lateAuthoritySession.requestFullBaseline(latePeer);

    expect(lateAuthoritySession.publish().ok).toBe(true);
    expect(lateReplicaSession.receiveEvents()).toEqual([]);
    expect(lateReplica.snapshot()).toEqual(initialReplica.snapshot());
  });

  it('disconnects a sender when attached replica decoding rejects malformed bytes', () => {
    const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
    const session = new NetSession({ endpoint: replicaEndpoint, maxRawMessages: 8 });
    const replication = profile();
    session.attachReplica(createReplicaCoordinator(new World(), replication, replicaEndpoint), replication.limits);
    authorityEndpoint.poll();
    replicaEndpoint.poll();

    authorityEndpoint.send(2 as never, new Uint8Array([0xff]));
    const errors = session.receiveEvents();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe('decode-invalid-payload');
    expect(authorityEndpoint.poll()).toContainEqual({ kind: 'peer-disconnected', peerId: 2 });
  });
});
