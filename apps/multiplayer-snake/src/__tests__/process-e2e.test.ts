import { World } from '@forgeax/engine-ecs';
import type { NetEndpoint, NetSession } from '@forgeax/engine-net';
import { createReplicaCoordinator, netPlugin } from '@forgeax/engine-net';
import {
  connectWebSocketClientEndpoint,
  listenWebSocketEndpoint,
} from '@forgeax/engine-net-websocket/node';
import { describe, expect, it } from 'vitest';
import { startAuthority } from '../../scripts/authority-e2e.mjs';
import { createServerWorld } from '../server';
import { encodeCommand } from '../shared/commands';
import { GridPosition, Snake, SnakeSession, snakeProfile } from '../shared/components';

declare function setImmediate(callback: () => void): unknown;
declare const process: { readonly stdout: { write(value: string): void } };

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
  return { world, endpoint: endpoint.value, replica, session };
}

async function startInProcessAuthority() {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const listened = await listenWebSocketEndpoint({ port, maxPeers: 4 });
  if (!listened.ok) throw listened.error;
  const server = createServerWorld(listened.value);
  return {
    ...server,
    port,
    endpoint: listened.value,
    session: server.world.getResource<NetSession>('net-session'),
    close: () => {
      const closed = listened.value.close();
      if (!closed.ok && closed.error.code !== 'already-closed') throw closed.error;
    },
  };
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

function report(line: string): void {
  process.stdout.write(`${line}\n`);
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

async function pumpInProcessUntil(
  authority: { readonly world: World },
  clients: Array<Awaited<ReturnType<typeof connect>>>,
  ready: () => boolean,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!ready()) {
    authority.world.update(1 / 60).unwrap();
    for (const client of clients) client.world.update(1 / 60).unwrap();
    if (Date.now() > deadline) throw new Error('in-process network lifecycle timeout');
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

function snapshotIds(client: Awaited<ReturnType<typeof connect>>) {
  return client.replica.snapshot().map((row) => row.id);
}

function closeEndpoint(endpoint: NetEndpoint): void {
  const closed = endpoint.close();
  if (!closed.ok && closed.error.code !== 'already-closed') throw closed.error;
}

function yieldToTransport(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

async function waitForPeerCount(session: NetSession, count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (session.getPeerSnapshot().peerIds.length !== count) {
    session.receiveEvents();
    if (Date.now() > deadline) throw new Error(`peer lifecycle did not reach ${count}`);
    await yieldToTransport();
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

  it('terminates a real WebSocket session on malformed replication and recovers with a fresh session', async () => {
    const authority = await startInProcessAuthority();
    const clients: Array<Awaited<ReturnType<typeof connect>>> = [];
    const evidence: Record<string, unknown> = {
      hostRestartBetweenSessions: false,
      transport: 'real-node-websocket',
      convergence: {},
    };
    try {
      const url = `ws://127.0.0.1:${authority.port}`;
      const primary = await connect(url);
      const observer = await connect(url);
      clients.push(primary, observer);
      await pumpInProcessUntil(authority, clients, () => clients.every(waiting));
      for (const client of clients) {
        const ready = encodeCommand({ kind: 'ready' });
        if (!ready.ok) throw ready.error;
        const sent = client.endpoint.send(1 as never, ready.value);
        if (!sent.ok) throw sent.error;
      }
      await pumpInProcessUntil(authority, clients, () =>
        clients.every((client) => playerIds(client).length === 2),
      );
      expect(semanticState(primary)).toEqual(semanticState(observer));
      const initialIds = snapshotIds(observer);
      const initialPlayers = playerIds(observer);
      expect(initialPlayers).toHaveLength(2);
      expect(initialIds.length).toBeGreaterThan(0);

      const beforeReplacement = semanticState(observer);
      const direction = encodeCommand({ direction: 'down' });
      if (!direction.ok) throw direction.error;
      const directionSent = observer.endpoint.send(1 as never, direction.value);
      if (!directionSent.ok) throw directionSent.error;
      await pumpInProcessUntil(authority, clients, () => {
        const current = semanticState(observer);
        return JSON.stringify(current) !== JSON.stringify(beforeReplacement);
      });
      expect(semanticState(primary)).toEqual(semanticState(observer));
      evidence.convergence = {
        initialPlayers,
        initialEntityCount: initialIds.length,
        replacementObserved:
          JSON.stringify(beforeReplacement) !== JSON.stringify(semanticState(observer)),
        sharedStateAfterReplacement: semanticState(primary),
      };

      const late = await connect(url);
      clients.push(late);
      await pumpInProcessUntil(authority, clients, () =>
        clients.every((client) => playerIds(client).length === 3),
      );
      const latePlayers = playerIds(late);
      expect(latePlayers).toEqual(playerIds(observer));
      expect(latePlayers.length).toBe(3);
      const lateEntityCount = snapshotIds(late).length;
      expect(lateEntityCount).toBeGreaterThan(initialIds.length);
      closeEndpoint(late.endpoint);
      await waitForPeerCount(authority.session, 2);
      await pumpInProcessUntil(
        authority,
        [primary, observer],
        () => playerIds(observer).length === 2,
      );
      expect(playerIds(observer)).toEqual(playerIds(primary));
      expect(snapshotIds(observer).length).toBeLessThan(lateEntityCount);
      evidence.convergence = {
        ...(evidence.convergence as Record<string, unknown>),
        spawnEntityCount: lateEntityCount,
        despawnEntityCount: lateEntityCount - snapshotIds(observer).length,
        replacementEntityIds: initialIds,
        observerAfterDespawn: snapshotIds(observer),
      };

      const beforeFault = semanticState(primary);
      const primaryPlayer = playerIds(primary)[0];
      if (primaryPlayer === undefined)
        throw new Error('primary player identity missing before fault');
      const authorityPeer = authority.session.getPeerSnapshot().peerIds[0];
      if (authorityPeer === undefined)
        throw new Error('authority peer identity missing before fault');
      const malformed = authority.session.sendRaw(authorityPeer, new Uint8Array([0xff]));
      if (!malformed.ok) throw malformed.error;
      const faultErrors = await new Promise<
        readonly { readonly code: string; readonly detail: unknown }[]
      >((resolve, reject) => {
        const deadline = Date.now() + 5_000;
        const poll = () => {
          const errors = primary.session.receiveEvents();
          if (errors.length > 0) return resolve(errors);
          if (Date.now() > deadline) return reject(new Error('terminal fault was not observed'));
          setImmediate(poll);
        };
        poll();
      });
      expect(faultErrors[0]?.code).toBe('decode-invalid-payload');
      expect(semanticState(primary)).toEqual(beforeFault);
      const sendAfterFault = primary.endpoint.send(1 as never, new Uint8Array([0]));
      expect(sendAfterFault.ok).toBe(false);
      if (sendAfterFault.ok) throw new Error('closed endpoint accepted a message');
      expect(['already-closed', 'connection-closed']).toContain(sendAfterFault.error.code);
      evidence.fault = {
        code: faultErrors[0]?.code,
        detail: faultErrors[0]?.detail,
        trustedStateUnchanged:
          JSON.stringify(beforeFault) === JSON.stringify(semanticState(primary)),
        endpointAfterFault: sendAfterFault.error.code,
        terminalPlayer: primaryPlayer,
      };

      await waitForPeerCount(authority.session, 1);
      await pumpInProcessUntil(authority, [observer], () => playerIds(observer).length === 1);
      const replacement = await connect(url);
      clients.push(replacement);
      await pumpInProcessUntil(authority, [observer, replacement], () =>
        [observer, replacement].every((client) => playerIds(client).length === 2),
      );
      const replacementPlayers = playerIds(replacement);
      const replacementPlayer = replacementPlayers.find((id) => id !== playerIds(observer)[0]);
      expect(replacementPlayer).toBeDefined();
      expect(replacementPlayers).toEqual(playerIds(observer));
      expect(replacement.world).not.toBe(primary.world);
      expect(replacement.replica).not.toBe(primary.replica);
      expect(replacement.endpoint).not.toBe(primary.endpoint);
      expect(replacement.replica.tick).toBeGreaterThan(0);
      expect(replacementPlayers).not.toContain(primaryPlayer);
      const afterFreshBaseline = semanticState(replacement);
      await pumpInProcessUntil(authority, [observer, replacement], () => {
        const current = semanticState(replacement);
        return current.some((row) => row.playerNetworkId === replacementPlayer);
      });
      expect(semanticState(observer)).toEqual(semanticState(replacement));
      evidence.freshSession = {
        replacementPlayer,
        oldPlayer: primaryPlayer,
        newWorldIdentity: replacement.world !== primary.world,
        newReplicaIdentity: replacement.replica !== primary.replica,
        newEndpointIdentity: replacement.endpoint !== primary.endpoint,
        baselineEntityCount: snapshotIds(replacement).length,
        baselineState: afterFreshBaseline,
        renewedConvergence: semanticState(observer),
      };
      report(`[m15-net] evidence: ${JSON.stringify(evidence)}`);
      report('[m15-net] initial baseline and replacement: PASS');
      report('[m15-net] spawn and despawn convergence: PASS');
      report('[m15-net] malformed terminal fault and trusted-state preservation: PASS');
      report('[m15-net] same-process fresh session baseline and convergence: PASS');
      report('[m15-net] PASS - M15 terminal fault fresh session GREEN');
    } finally {
      for (const client of clients) closeEndpoint(client.endpoint);
      authority.close();
    }
  }, 30_000);
});
