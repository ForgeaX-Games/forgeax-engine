import { describe, expect, it } from 'vitest';
import { defineComponent, FixedUpdate, World } from '@forgeax/engine-ecs';
import { createMemoryEndpointPair } from '../src/endpoint/memory';
import type { PeerId } from '../src/endpoint/endpoint';
import { createAuthorityCoordinator } from '../src/replication/authority';
import { defineReplication } from '../src/replication/profile';
import { createReplicaCoordinator } from '../src/replication/replica';
import { NetSession } from '../src/session/net-session';
import { netPlugin } from '../src/session/session-plugin';

const NetworkedScheduled = defineComponent('NetworkedScheduled', { enabled: 'bool' });
const PositionScheduled = defineComponent('PositionScheduled', { x: 'f32' });

function scheduledProfile() {
  const result = defineReplication({
    name: 'session-scheduling',
    entities: { with: [NetworkedScheduled] },
    components: [NetworkedScheduled, PositionScheduled],
  });
  if (!result.ok) throw result.error;
  return result.value;
}

describe('NetSession scheduling integration', () => {
  it('can create a session with a memory endpoint', () => {
    const [epA] = createMemoryEndpointPair();
    const session = new NetSession({ endpoint: epA, maxRawMessages: 256 });
    expect(session).toBeDefined();
  });

  it('receiveEvents polls endpoint and buffers raw messages', () => {
    const [epA, epB] = createMemoryEndpointPair();
    const sessionA = new NetSession({ endpoint: epA, maxRawMessages: 256 });

    // Session polls its own endpoint -- should see the connect event
    sessionA.receiveEvents();
    const snapshotA = sessionA.getPeerSnapshot();
    expect(snapshotA.connected).toBe(true);

    // Send from epB to epA (peerId 1 from B's perspective)
    epB.send(1 as PeerId, new Uint8Array([1, 2, 3]));

    sessionA.receiveEvents();
    const raw = sessionA.drainRawMessages();
    expect(raw).toHaveLength(1);
    expect(raw[0]!.data).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('applies received replication before fixed simulation and publishes after it via World.update', () => {
    const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
    const profile = scheduledProfile();
    const authorityWorld = new World({ time: { fixedDeltaSeconds: 1, maxDeltaSeconds: 5 } });
    const replicaWorld = new World({ time: { fixedDeltaSeconds: 1, maxDeltaSeconds: 5 } });
    const authorityEntity = authorityWorld
      .spawn(
        { component: NetworkedScheduled, data: { enabled: true } },
        { component: PositionScheduled, data: { x: 1 } },
      )
      .unwrap();

    expect(netPlugin({ endpoint: authorityEndpoint }).build(authorityWorld).ok).toBe(true);
    expect(netPlugin({ endpoint: replicaEndpoint }).build(replicaWorld).ok).toBe(true);
    const authoritySession = authorityWorld.getResource<NetSession>('net-session');
    const replicaSession = replicaWorld.getResource<NetSession>('net-session');
    authoritySession.attachAuthority(createAuthorityCoordinator(authorityWorld, profile));
    const replica = createReplicaCoordinator(replicaWorld, profile, replicaEndpoint);
    replicaSession.attachReplica(replica, profile.limits);

    replicaWorld.addSystem(FixedUpdate, {
      name: 'observe-replica-before-simulation',
      queries: [],
      fn: () => {
        expect(replica.readComponent(1, PositionScheduled)).toEqual({ x: 2 });
      },
    });
    authorityWorld.addSystem(FixedUpdate, {
      name: 'simulate-authority',
      queries: [],
      fn: () => {
        authorityWorld.set(authorityEntity, PositionScheduled, { x: 2 }).unwrap();
      },
    });

    authorityWorld.update(1).unwrap();
    replicaWorld.update(1).unwrap();

    expect(replica.readComponent(1, PositionScheduled)).toEqual({ x: 2 });
  });

  it('sender identity is preserved through endpoint', () => {
    const [epA, epB] = createMemoryEndpointPair();
    const sessionA = new NetSession({ endpoint: epA, maxRawMessages: 256 });

    sessionA.receiveEvents();

    // B sends to A (peerId 1)
    epB.send(1 as PeerId, new Uint8Array([99]));

    sessionA.receiveEvents();
    const raw = sessionA.drainRawMessages();
    expect(raw).toHaveLength(1);
    // B's peerId from A's perspective is 2
    expect(raw[0]!.peerId).toBe(2 as PeerId);
  });

  it('session works without World dependency (host-neutral)', () => {
    const [epA] = createMemoryEndpointPair();
    const session = new NetSession({ endpoint: epA, maxRawMessages: 256 });

    session.receiveEvents();
    const raw = session.drainRawMessages();
    expect(raw).toHaveLength(0);

    const snapshot = session.getPeerSnapshot();
    expect(snapshot.connected).toBeDefined();
  });
});
