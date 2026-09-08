import { createWorldContext, World } from '@forgeax/engine-ecs';
import {
  createMemoryEndpointPair,
  createReplicaCoordinator,
  type NetSession,
  netPlugin,
} from '@forgeax/engine-net';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { gridToWorldPosition, registerReplicaDerivation } from '../client';
import clientSource from '../client.ts?raw';
import { createServerWorld } from '../server';
import serverSource from '../server.ts?raw';
import { encodeCommand } from '../shared/commands';
import { GridPosition, Snake, SnakeSegment, snakeProfile } from '../shared/components';

describe('Snake replica write contract', () => {
  it('uses NetSession snapshots and SessionId rather than transport identity for consumers', () => {
    expect(clientSource).toContain('getRecoverySnapshot');
    expect(clientSource).toContain('SessionId');
    expect(clientSource).toContain('sendToAuthority');
    expect(clientSource).toContain('ownedResources');
    expect(clientSource).not.toContain('endpoint.send(1 as PeerId');
    expect(clientSource).not.toContain('installKeyboardInput(endpoint');
    expect(serverSource).toContain('getRecoverySnapshot');
    expect(serverSource).toContain('SessionId');
    expect(serverSource).not.toContain('Map<number, SnakeEntities>');
  });

  it('branches every public lifecycle and structured failure outcome', () => {
    expect(clientSource).toContain("case 'connecting'");
    expect(clientSource).toContain("case 'resyncing'");
    expect(clientSource).toContain("case 'active'");
    expect(clientSource).toContain("case 'recovering'");
    expect(clientSource).toContain("case 'failed'");
    expect(clientSource).toContain("case 'retired'");
    expect(clientSource).toContain('lastError');
    expect(clientSource).toContain('ownedResources');
  });

  it('maps grid up to visual up', () => {
    expect(gridToWorldPosition(12, 8)).toEqual([0, 0, 0]);
    expect(gridToWorldPosition(12, 7)).toEqual([0, 1, 0]);
    expect(gridToWorldPosition(12, 9)).toEqual([0, -1, 0]);
  });

  it('applies a real batch then derives only local render components', async () => {
    const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
    const authority = await createServerWorld(authorityEndpoint);
    const world = new World();
    await createWorldContext(world, [netPlugin({ endpoint: replicaEndpoint })]);
    const replica = createReplicaCoordinator(world, snakeProfile, replicaEndpoint);
    world.getResource<NetSession>('net-session').attachReplica(replica, snakeProfile.limits);
    const stateTarget = { dataset: {}, textContent: '' } as unknown as HTMLElement;
    const previousDocument = globalThis.document;
    let renderEntities: ReturnType<typeof registerReplicaDerivation>;
    Reflect.deleteProperty(globalThis, 'document');
    try {
      renderEntities = registerReplicaDerivation(world, replica, { stateTarget });
    } finally {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: previousDocument,
      });
    }

    sendJoin(replicaEndpoint);
    expect(authority.world.update(1).ok).toBe(true);
    expect(world.update(1).ok).toBe(true);
    const row = replica.snapshot().find((entry) => entry.components.includes(Snake.name));
    expect(row).toBeDefined();
    if (row === undefined) return;
    const beforeSnake = replica.readComponent(row.id, Snake);
    const beforePosition = replica.readComponent(row.id, GridPosition);
    expect(beforeSnake).toBeDefined();
    expect(beforePosition).toBeDefined();

    // A second Update runs the registered derivation against the same applied data.
    expect(world.update(1).ok).toBe(true);
    expect(world.update(1).ok).toBe(true);
    expect(replica.readComponent(row.id, Snake)).toEqual(beforeSnake);
    expect(replica.readComponent(row.id, GridPosition)).toEqual(beforePosition);
    expect(renderEntities?.size).toBe(3);
    const renderEntity = renderEntities?.get(row.id);
    expect(renderEntity).toBeDefined();
    if (renderEntity === undefined) return;
    expect(world.get(renderEntity, MeshRenderer).unwrap().materials).toHaveLength(1);
    expect(world.get(renderEntity, MeshRenderer).unwrap().materials[0]).toBeGreaterThan(0);

    const segmentRow = replica
      .snapshot()
      .find((entry) => entry.components.includes(SnakeSegment.name));
    expect(segmentRow).toBeDefined();
    if (segmentRow === undefined) return;
    const segmentRenderEntity = renderEntities?.get(segmentRow.id);
    expect(segmentRenderEntity).toBeDefined();
    if (segmentRenderEntity === undefined) return;
    expect(world.get(segmentRenderEntity, MeshRenderer).ok).toBe(true);

    authorityEndpoint.close();
    expect(world.update(1 / 60).ok).toBe(true);
    expect(countRenderEntities(world)).toBe(0);
  });

  it('projects stable player identity separately from the network incarnation id', async () => {
    const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
    const authority = await createServerWorld(authorityEndpoint);
    const world = new World();
    await createWorldContext(world, [netPlugin({ endpoint: replicaEndpoint })]);
    const replica = createReplicaCoordinator(world, snakeProfile, replicaEndpoint);
    world.getResource<NetSession>('net-session').attachReplica(replica, snakeProfile.limits);
    sendJoin(replicaEndpoint);
    authority.world.update(1).unwrap();
    world.update(1).unwrap();
    const row = replica.snapshot().find((entry) => entry.components.includes(Snake.name));
    expect(row).toBeDefined();
    if (!row) return;
    const snake = replica.readComponent(row.id, Snake);
    expect(snake).toEqual(expect.objectContaining({ playerNetworkId: expect.any(Number) }));
    expect(snake).not.toHaveProperty('color');
  });
});

function sendJoin(endpoint: { send(peerId: never, data: Uint8Array): { ok: boolean } }) {
  const join = encodeCommand({ kind: 'join' });
  if (!join.ok) throw join.error;
  const sent = endpoint.send(1 as never, join.value);
  if (!sent.ok) throw new Error('join send failed');
}

function countRenderEntities(world: World): number {
  let count = 0;
  const query = world.query({ with: [Transform, MeshFilter, MeshRenderer] }).unwrap();
  for (const _row of query) count += 1;
  return count;
}
