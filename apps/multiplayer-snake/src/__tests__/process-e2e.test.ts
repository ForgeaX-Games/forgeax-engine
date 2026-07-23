import { World } from '@forgeax/engine-ecs';
import type { NetSession } from '@forgeax/engine-net';
import { createReplicaCoordinator, netPlugin } from '@forgeax/engine-net';
import { connectWebSocketClientEndpoint } from '@forgeax/engine-net-websocket/node';
import { describe, expect, it } from 'vitest';
import { startAuthority } from '../../scripts/authority-e2e.mjs';
import { encodeCommand } from '../shared/commands';
import { GridPosition, Snake, SnakeSession, snakeProfile } from '../shared/components';

declare function setImmediate(callback: () => void): unknown;

async function connect(url: string) {
  const endpoint = await connectWebSocketClientEndpoint(url);
  if (!endpoint.ok) throw endpoint.error;
  const world = new World();
  const built = netPlugin({ endpoint: endpoint.value }).build(world);
  if (built instanceof Promise || !built.ok) throw new Error('net plugin failed');
  const session = world.getResource<NetSession>('net-session');
  const replica = createReplicaCoordinator(world, snakeProfile, endpoint.value);
  session.attachReplica(replica, snakeProfile.limits);
  const join = encodeCommand({ kind: 'join' });
  if (!join.ok) throw join.error;
  const sent = endpoint.value.send(1 as never, join.value);
  if (!sent.ok) throw sent.error;
  return { world, endpoint: endpoint.value, replica };
}

function semanticState(client: Awaited<ReturnType<typeof connect>>) {
  const byIdentity = new Map<number, ReturnType<typeof rowState>>();
  for (const row of client.replica
    .snapshot()
    .filter((candidate) => candidate.components.includes(Snake.name))) {
    const pos = client.replica.readComponent(row.id, GridPosition);
    const snake = client.replica.readComponent(row.id, Snake);
    const state = rowState({
      networkEntityId: row.id,
      playerNetworkId: (snake?.playerNetworkId as number | undefined) ?? 0,
      x: (pos?.x as number | undefined) ?? 0,
      y: (pos?.y as number | undefined) ?? 0,
      score: (snake?.score as number | undefined) ?? 0,
    });
    if (state.playerNetworkId > 0) byIdentity.set(state.playerNetworkId, state);
  }
  return [...byIdentity.values()].sort((a, b) => a.playerNetworkId - b.playerNetworkId);
}

function playerIds(client: Awaited<ReturnType<typeof connect>>) {
  return semanticState(client)
    .map((state) => state.playerNetworkId)
    .filter((playerNetworkId) => playerNetworkId !== 0)
    .sort((left, right) => left - right);
}

function waiting(client: Awaited<ReturnType<typeof connect>>) {
  const row = client.replica
    .snapshot()
    .find((candidate) => candidate.components.includes(SnakeSession.name));
  const session =
    row === undefined ? undefined : client.replica.readComponent(row.id, SnakeSession);
  return session?.started === false && session.gameplayTick === 0;
}

function rowState(value: {
  networkEntityId: number;
  playerNetworkId: number;
  x: number;
  y: number;
  score: number;
}) {
  return value;
}

async function pumpUntil(
  clients: Array<Awaited<ReturnType<typeof connect>>>,
  ready: () => boolean,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!ready()) {
    for (const client of clients) client.world.update(1 / 60).unwrap();
    if (Date.now() > deadline) throw new Error('process lifecycle timeout');
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

describe('multiplayer snake process E2E', () => {
  it('converges two real WebSocket clients across join, growth, death, respawn, late join, and disconnect', async () => {
    const authority = await startAuthority();
    const clients: Array<Awaited<ReturnType<typeof connect>>> = [];
    try {
      const url = `ws://127.0.0.1:${authority.port}`;
      clients.push(await connect(url), await connect(url));
      await pumpUntil(clients, () => clients.every(waiting));
      for (const client of clients) {
        const ready = encodeCommand({ kind: 'ready' });
        if (!ready.ok) throw ready.error;
        const sent = client.endpoint.send(1 as never, ready.value);
        if (!sent.ok) throw sent.error;
      }
      await pumpUntil(clients, () => clients.every((client) => playerIds(client).length === 2));
      const first = clients[0];
      const second = clients[1];
      if (!first || !second) throw new Error('clients failed to connect');
      expect(first.replica.tick).toBeGreaterThan(0);
      expect(semanticState(first)).toEqual(semanticState(second));

      const late = await connect(url);
      clients.push(late);
      await pumpUntil(clients, () => clients.every((client) => playerIds(client).length === 3));
      expect(playerIds(late)).toEqual(playerIds(first));

      const removedClient = clients[1];
      if (removedClient === undefined) throw new Error('second client is missing');
      const removedPlayer = playerIds(removedClient).at(0);
      if (removedPlayer === undefined) throw new Error('second client has no live snake');
      removedClient.endpoint.close();
      for (let index = 0; index < 30; index += 1) {
        first.world.update(1 / 60).unwrap();
        late.world.update(1 / 60).unwrap();
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      expect(
        playerIds(late).filter((playerNetworkId) => playerNetworkId !== removedPlayer),
      ).toEqual(playerIds(first).filter((playerNetworkId) => playerNetworkId !== removedPlayer));
    } finally {
      for (const client of clients) client.endpoint.close();
      await authority.kill();
    }
  }, 30_000);
});
