import { createQueryState, queryRun, World } from '@forgeax/engine-ecs';
import {
  createMemoryEndpointPair,
  createReplicaCoordinator,
  type NetSession,
  netPlugin,
} from '@forgeax/engine-net';
import { MeshFilter, MeshRenderer, Transform } from '@forgeax/engine-runtime';
import { describe, expect, it } from 'vitest';
import { gridToWorldPosition, registerReplicaDerivation } from '../client';
import { createServerWorld } from '../server';
import { encodeCommand } from '../shared/commands';
import { GridPosition, Snake, SnakeSegment, snakeProfile } from '../shared/components';

describe('Snake replica write contract', () => {
  it('maps grid up to visual up', () => {
    expect(gridToWorldPosition(12, 8)).toEqual([0, 0, 0]);
    expect(gridToWorldPosition(12, 7)).toEqual([0, 1, 0]);
    expect(gridToWorldPosition(12, 9)).toEqual([0, -1, 0]);
  });

  it('applies a real batch then derives only local render components', () => {
    const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
    const authority = createServerWorld(authorityEndpoint);
    const world = new World();
    const built = netPlugin({ endpoint: replicaEndpoint }).build(world);
    if (built instanceof Promise || !built.ok) throw new Error('replica plugin failed');
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

  it('projects stable player identity separately from the network incarnation id', () => {
    const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
    const authority = createServerWorld(authorityEndpoint);
    const world = new World();
    const built = netPlugin({ endpoint: replicaEndpoint }).build(world);
    if (built instanceof Promise || !built.ok) throw new Error('replica plugin failed');
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
  queryRun(createQueryState({ with: [Transform, MeshFilter, MeshRenderer] }), world, () => {
    count += 1;
  });
  return count;
}
