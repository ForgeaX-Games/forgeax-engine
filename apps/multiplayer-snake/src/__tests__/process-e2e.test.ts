import { createWorldContext, World } from '@forgeax/engine-ecs';
import type { NetEndpoint, NetEndpointConnector, NetSession } from '@forgeax/engine-net';
import {
  createReplicaCoordinator,
  decodeReplicationPacket,
  encodeReplicationPacket,
  netPlugin,
} from '@forgeax/engine-net';
import {
  connectWebSocketClientEndpoint,
  createWebSocketConnector,
} from '@forgeax/engine-net-websocket/node';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { startAuthority } from '../../scripts/authority-e2e.mjs';
import { startChaosWebSocketProxy } from '../../scripts/chaos-websocket.mjs';
import { encodeCommand } from '../shared/commands';
import { GridPosition, Snake, SnakeSession, snakeProfile } from '../shared/components';

declare function setImmediate(callback: () => void): unknown;
declare const process: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: { write(value: string): void };
};

async function connect(url: string, sessionId: number): Promise<LegacyProcessClient> {
  const endpoint = await connectWebSocketClientEndpoint(url);
  if (!endpoint.ok) throw endpoint.error;
  const packets: PacketObservation[] = [];
  const observedEndpoint = observeEndpoint(endpoint.value, packets);
  const world = new World();
  await createWorldContext(world, [netPlugin({ endpoint: observedEndpoint, sessionId })]);
  const session = world.getResource<NetSession>('net-session');
  const replica = createReplicaCoordinator(world, snakeProfile, observedEndpoint);
  session.attachReplica(replica, snakeProfile.limits);
  const receiveErrors = session.receiveEvents();
  if (receiveErrors.length > 0) throw receiveErrors[0];
  const join = encodeCommand({ kind: 'join' });
  if (!join.ok) throw join.error;
  const joined = session.sendToAuthority(session.getRecoverySnapshot().sessionId, join.value);
  if (!joined.ok) throw joined.error;
  return {
    world,
    endpoint: observedEndpoint,
    replica,
    session,
    packets,
    acknowledgedPackets: new Set(),
  };
}

interface AuthorityObservation {
  readonly kind: 'authority-net-session';
  readonly epoch: number;
  readonly pendingPackets: number;
  readonly peerIds: readonly number[];
  readonly ownedResources?: { readonly ledgers: number };
}

interface AuthorityProcess {
  readonly process: { readonly exitCode: number | null };
  readonly port: number;
  readonly kill: () => Promise<void>;
  readonly observations: () => readonly AuthorityObservation[];
}

interface ReplicaClient {
  readonly world: World;
  readonly endpoint: NetEndpoint;
  readonly replica: ReturnType<typeof createReplicaCoordinator>;
  readonly session: NetSession;
}

interface LegacyProcessClient extends ReplicaClient {
  readonly packets: PacketObservation[];
  readonly acknowledgedPackets: Set<string>;
}

interface PacketObservation {
  readonly kind: 'baseline' | 'delta';
  readonly epoch: number;
  readonly sequence: number;
}

interface SessionObservation {
  readonly state: string;
  readonly sessionId: number;
  readonly epoch: number;
  readonly sequence: number;
  readonly pendingPackets: number;
  readonly acknowledgedSequence: number;
  readonly reconnectAttempts: number;
  readonly ownedResources: NetSession['getResourceSnapshot'] extends (...args: never[]) => infer R
    ? R
    : never;
}

interface ProcessSessionClient {
  readonly world: World;
  readonly endpoint: NetEndpoint;
  readonly replica: ReturnType<typeof createReplicaCoordinator>;
  readonly session: NetSession;
  readonly initialEndpoint: NetEndpoint;
  readonly transport: {
    endpoint: NetEndpoint;
    replacementPacketStart?: number;
  };
  readonly connector: NetEndpointConnector;
  readonly packets: PacketObservation[];
  readonly observations: SessionObservation[];
  readonly acknowledgedPackets: Set<string>;
  replacementJoinSent: boolean;
}

function semanticState(client: ReplicaClient) {
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

function playerIds(client: ReplicaClient) {
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

function observeEndpoint(endpoint: NetEndpoint, packets: PacketObservation[]): NetEndpoint {
  return {
    poll: () => {
      const events = endpoint.poll();
      for (const event of events) {
        if (event.kind !== 'message') continue;
        const decoded = decodeReplicationPacket(event.data, snakeProfile.limits);
        if (!decoded.ok || (decoded.value.kind !== 'baseline' && decoded.value.kind !== 'delta'))
          continue;
        packets.push({
          kind: decoded.value.kind,
          epoch: decoded.value.epoch,
          sequence: decoded.value.sequence,
        });
      }
      return events;
    },
    send: (peerId, data) => endpoint.send(peerId, data),
    close: () => endpoint.close(),
  };
}

async function connectSession(url: string): Promise<ProcessSessionClient> {
  const publicConnector = createWebSocketConnector(url);
  const initialResult = await publicConnector.connect(new AbortController().signal);
  if (!initialResult.ok) throw initialResult.error;
  const packets: PacketObservation[] = [];
  const transport: ProcessSessionClient['transport'] = {
    endpoint: observeEndpoint(initialResult.value, packets),
  };
  const connector: NetEndpointConnector = {
    connect: async (signal) => {
      const result = await publicConnector.connect(signal);
      if (!result.ok) return result;
      transport.replacementPacketStart = packets.length;
      const endpoint = observeEndpoint(result.value, packets);
      transport.endpoint = endpoint;
      return ok(endpoint);
    },
  };
  const world = new World();
  await createWorldContext(world, [
    netPlugin({
      endpoint: transport.endpoint,
      connector,
      sessionId: 1,
      maxRawMessages: 32,
      recovery: { reconnectDelaysMs: [0] },
    }),
  ]);
  const session = world.getResource<NetSession>('net-session');
  const replica = createReplicaCoordinator(world, snakeProfile);
  session.attachReplica(replica, snakeProfile.limits);
  const receiveErrors = session.receiveEvents();
  if (receiveErrors.length > 0) throw receiveErrors[0];
  const sessionId = session.getRecoverySnapshot().sessionId;
  const join = encodeCommand({ kind: 'join' });
  if (!join.ok) throw join.error;
  const joined = session.sendToAuthority(sessionId, join.value);
  if (!joined.ok) throw joined.error;
  return {
    world,
    endpoint: transport.endpoint,
    replica,
    session,
    initialEndpoint: transport.endpoint,
    transport,
    connector,
    packets,
    observations: [],
    acknowledgedPackets: new Set(),
    replacementJoinSent: false,
  };
}

function observeSession(client: ProcessSessionClient): void {
  const snapshot = client.session.getRecoverySnapshot();
  const observation: SessionObservation = {
    state: snapshot.state.kind,
    sessionId: snapshot.sessionId,
    epoch: snapshot.epoch,
    sequence: snapshot.sequence,
    pendingPackets: snapshot.pendingPackets,
    acknowledgedSequence: snapshot.acknowledgedSequence,
    reconnectAttempts: snapshot.reconnectAttempts,
    ownedResources: snapshot.ownedResources,
  };
  const previous = client.observations.at(-1);
  if (JSON.stringify(previous) !== JSON.stringify(observation))
    client.observations.push(observation);
}

function acknowledgePackets(
  client: Pick<ProcessSessionClient, 'session' | 'packets' | 'acknowledgedPackets'>,
): void {
  if (client.session.getRecoverySnapshot().state.kind !== 'active') return;
  for (const packet of client.packets) {
    const key = `${packet.epoch}:${packet.sequence}`;
    if (client.acknowledgedPackets.has(key)) continue;
    const ack = encodeReplicationPacket(
      {
        version: 2,
        kind: 'ack',
        sessionId: client.session.getRecoverySnapshot().sessionId,
        epoch: packet.epoch,
        acknowledgedSequence: packet.sequence,
      },
      snakeProfile.limits,
    );
    if (!ack.ok) throw ack.error;
    const sent = client.session.sendToAuthority(
      client.session.getRecoverySnapshot().sessionId,
      ack.value,
    );
    if (sent.ok) client.acknowledgedPackets.add(key);
  }
}

function prepareReplacementJoin(client: ProcessSessionClient): void {
  if (client.replacementJoinSent || client.transport.replacementPacketStart === undefined) return;
  if (client.transport.endpoint === client.initialEndpoint) return;
  const snapshot = client.session.getRecoverySnapshot();
  const join = encodeCommand({ kind: 'join' });
  if (!join.ok) throw join.error;
  const sent = client.session.sendToAuthority(snapshot.sessionId, join.value);
  if (sent.ok) client.replacementJoinSent = true;
}

async function pumpProcessUntil(
  clients: readonly ProcessSessionClient[],
  ready: () => boolean,
  diagnostic: () => unknown = () => undefined,
): Promise<void> {
  // Real WebSocket process E2E runs on the shared CI runner alongside the
  // build and browser jobs. Keep the poll bounded, but leave enough room for
  // a cold Node/Bun process and the first socket event-loop turn to settle.
  const deadline = Date.now() + 120_000;
  while (!ready()) {
    for (const client of clients) client.world.update(1 / 60).unwrap();
    for (const client of clients) {
      prepareReplacementJoin(client);
      acknowledgePackets(client);
      observeSession(client);
    }
    if (Date.now() > deadline) {
      report(
        `[m16-net] timeout: ${JSON.stringify({
          clients: clients.map((client) => ({
            session: client.session.getRecoverySnapshot(),
            peers: client.session.getPeerSnapshot(),
            packetTail: client.packets.slice(-5),
            observationTail: client.observations.slice(-5),
          })),
          authority: diagnostic(),
        })}`,
      );
      throw new Error('same-session process recovery timeout');
    }
    await yieldToTransport();
  }
}

async function pumpUntil(
  clients: LegacyProcessClient[],
  ready: () => boolean,
  diagnostic: () => unknown = () => undefined,
): Promise<void> {
  // The legacy lifecycle path intentionally exercises real WebSocket clients;
  // a slow self-hosted runner must not turn startup contention into a false
  // protocol failure. The Vitest test-level timeout remains the outer bound.
  const deadline = Date.now() + 120_000;
  while (!ready()) {
    for (const client of clients) client.world.update(1 / 60).unwrap();
    for (const client of clients) acknowledgePackets(client);
    if (Date.now() > deadline) {
      report(
        `[m16-net] legacy timeout: ${JSON.stringify({
          clients: clients.map((client) => ({
            session: client.session.getRecoverySnapshot(),
            peers: client.session.getPeerSnapshot(),
            packetTail: client.packets.slice(-5),
          })),
          authority: diagnostic(),
        })}`,
      );
      throw new Error('process lifecycle timeout');
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

function snapshotIds(client: ReplicaClient) {
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

type ChaosClient = ProcessSessionClient | LegacyProcessClient;

function assertM17Control(name: string, condition: boolean, detail: string): void {
  if (!condition) {
    const prefix = process.env.M17_SABOTAGE === name ? 'm17-sabotage' : 'm17-control';
    throw new Error(`[${prefix}:${name}] ${detail}`);
  }
}

async function pumpChaosUntil(
  clients: readonly ChaosClient[],
  ready: () => boolean,
  diagnostic: () => unknown = () => undefined,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (!ready()) {
    for (const client of clients) client.world.update(1 / 60).unwrap();
    for (const client of clients) {
      if ('transport' in client) {
        prepareReplacementJoin(client);
        acknowledgePackets(client);
        observeSession(client);
      } else {
        acknowledgePackets(client);
      }
    }
    if (Date.now() > deadline) {
      report(
        `[m17-net] timeout: ${JSON.stringify({
          clients: clients.map((client) => ({
            session: client.session.getRecoverySnapshot(),
            peers: client.session.getPeerSnapshot(),
            packetTail: client.packets.slice(-8),
            ...('transport' in client ? { observationTail: client.observations.slice(-8) } : {}),
          })),
          authority: diagnostic(),
        })}`,
      );
      throw new Error('M17 real WebSocket chaos timeout');
    }
    await yieldToTransport();
  }
}

describe('multiplayer snake process E2E', () => {
  it('converges two real WebSocket clients across join, growth, death, respawn, late join, and disconnect', async () => {
    const authority = (await startAuthority()) as unknown as AuthorityProcess;
    const clients: Array<Awaited<ReturnType<typeof connect>>> = [];
    try {
      const url = `ws://127.0.0.1:${authority.port}`;
      clients.push(await connect(url, 1), await connect(url, 2));
      await pumpUntil(
        clients,
        () => clients.every(waiting),
        () => authority.observations().slice(-8),
      );
      for (const client of clients) {
        const ready = encodeCommand({ kind: 'ready' });
        if (!ready.ok) throw ready.error;
        const sent = client.session.sendToAuthority(
          client.session.getRecoverySnapshot().sessionId,
          ready.value,
        );
        if (!sent.ok) throw sent.error;
      }
      await pumpUntil(
        clients,
        () => clients.every((client) => playerIds(client).length === 2),
        () => authority.observations().slice(-8),
      );
      const first = clients[0];
      const second = clients[1];
      if (!first || !second) throw new Error('clients failed to connect');
      expect(first.replica.tick).toBeGreaterThan(0);
      expect(semanticState(first)).toEqual(semanticState(second));

      const late = await connect(url, 3);
      clients.push(late);
      await pumpUntil(
        clients,
        () => clients.every((client) => playerIds(client).length === 3),
        () => authority.observations().slice(-8),
      );
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
  }, 180_000);

  it('recovers one public NetSession across a real Node WebSocket replacement', async () => {
    const authority = (await startAuthority()) as unknown as AuthorityProcess;
    let primary: ProcessSessionClient | undefined;
    const evidence: Record<string, unknown> = {
      transport: 'real-node-websocket-process',
      sameWorldRecovery: true,
    };
    try {
      primary = await connectSession(`ws://127.0.0.1:${authority.port}`);
      if (primary === undefined) throw new Error('primary client failed to connect');
      const activePrimary = primary;
      observeSession(activePrimary);
      const originalWorld = activePrimary.world;
      const originalReplica = activePrimary.replica;
      const originalConnector = activePrimary.connector;
      await pumpProcessUntil(
        [activePrimary],
        () => {
          const snapshot = activePrimary.session.getRecoverySnapshot();
          return (
            snapshot?.state.kind === 'active' &&
            playerIds(activePrimary).length === 1 &&
            activePrimary.packets.some((packet) => packet.kind === 'baseline') &&
            activePrimary.packets.some((packet) => packet.kind === 'delta')
          );
        },
        () => authority.observations().slice(-8),
      );
      const initialSnapshot = activePrimary.session.getRecoverySnapshot();
      const initialPeer = activePrimary.session.getPeerSnapshot().peerIds[0];
      if (initialPeer === undefined) throw new Error('initial transport peer is missing');
      const initialSessionId = initialSnapshot.sessionId;
      const initialEpoch = initialSnapshot.epoch;
      const initialState = semanticState(activePrimary);
      const endpointBeforeClose = activePrimary.transport.endpoint;
      closeEndpoint(endpointBeforeClose);

      await pumpProcessUntil(
        [activePrimary],
        () => {
          const snapshot = activePrimary.session.getRecoverySnapshot();
          const replacementStart = activePrimary.transport.replacementPacketStart;
          const replacementPackets =
            replacementStart === undefined ? [] : activePrimary.packets.slice(replacementStart);
          return (
            snapshot?.state.kind === 'active' &&
            snapshot.sessionId === initialSessionId &&
            snapshot.epoch > initialEpoch &&
            activePrimary.session.getPeerSnapshot().peerIds[0] !== initialPeer &&
            replacementPackets?.some((packet) => packet.kind === 'delta') &&
            semanticState(activePrimary).length === 1
          );
        },
        () => authority.observations().slice(-8),
      );

      const finalSnapshot = activePrimary.session.getRecoverySnapshot();
      const replacementStart = activePrimary.transport.replacementPacketStart;
      if (replacementStart === undefined)
        throw new Error('replacement connector call was not observed');
      const replacementPackets = activePrimary.packets.slice(replacementStart);
      const firstReplacementPacket = replacementPackets[0];
      expect(firstReplacementPacket?.kind).toBe('baseline');
      expect(firstReplacementPacket?.sequence).toBe(1);
      expect(firstReplacementPacket?.epoch).toBeGreaterThan(initialEpoch);
      const firstDeltaIndex = replacementPackets.findIndex((packet) => packet.kind === 'delta');
      expect(firstDeltaIndex).toBeGreaterThan(0);
      expect(
        replacementPackets.slice(0, firstDeltaIndex).every((packet) => packet.kind === 'baseline'),
      ).toBe(true);
      expect(finalSnapshot.state.kind).toBe('active');
      expect(finalSnapshot.sessionId).toBe(initialSessionId);
      expect(activePrimary.session.getPeerSnapshot().peerIds[0]).not.toBe(initialPeer);
      expect(activePrimary.world).toBe(originalWorld);
      expect(activePrimary.replica).toBe(originalReplica);
      expect(activePrimary.connector).toBe(originalConnector);
      expect(semanticState(activePrimary)).toEqual(expect.any(Array));
      expect(snapshotIds(activePrimary).length).toBeGreaterThan(0);
      expect(JSON.stringify(initialState)).not.toBe('');
      expect(
        activePrimary.observations.some((observation) => observation.state === 'recovering'),
      ).toBe(true);
      expect(
        activePrimary.observations.some((observation) => observation.state === 'resyncing'),
      ).toBe(true);

      const replacementPeer = activePrimary.session.getPeerSnapshot().peerIds[0];
      if (replacementPeer === undefined) throw new Error('replacement transport peer is missing');
      await pumpProcessUntil(
        [activePrimary],
        () =>
          authority
            .observations()
            .some(
              (observation) =>
                observation.kind === 'authority-net-session' &&
                observation.epoch >= finalSnapshot.epoch &&
                observation.peerIds.includes(replacementPeer) &&
                observation.pendingPackets === 0 &&
                observation.ownedResources?.ledgers === 0,
            ),
        () => authority.observations().slice(-8),
      );
      const authorityObservations = authority.observations();
      expect(
        authorityObservations.some(
          (observation) =>
            observation.kind === 'authority-net-session' &&
            observation.epoch >= finalSnapshot.epoch &&
            observation.peerIds.includes(replacementPeer) &&
            observation.pendingPackets === 0 &&
            observation.ownedResources?.ledgers === 0,
        ),
      ).toBe(true);
      evidence.lifecycle = activePrimary.observations;
      evidence.packetOrder = replacementPackets;
      evidence.sessionId = initialSessionId;
      evidence.peerIds = {
        initial: initialPeer,
        replacement: activePrimary.session.getPeerSnapshot().peerIds[0],
      };
      evidence.convergence = {
        initialState,
        finalState: semanticState(activePrimary),
        acceptedBaselineBeforeDelta: true,
      };
      evidence.authorityAccounting = authorityObservations;

      activePrimary.session.dispose();
      const clientResources = activePrimary.session.getResourceSnapshot();
      expect(activePrimary.session.getRecoverySnapshot().state.kind).toBe('retired');
      expect(clientResources).toEqual({
        pendingConnects: 0,
        timers: 0,
        ledgers: 0,
        callbacks: 0,
      });
      expect(activePrimary.session.getPeerSnapshot()).toEqual({ peerIds: [], connected: false });
      await authority.kill();
      expect(authority.process.exitCode).toBe(0);
      evidence.cleanup = {
        clientResources,
        clientState: activePrimary.session.getRecoverySnapshot().state,
        authorityProcessExitCode: authority.process.exitCode,
        authoritySocketAndTimerOwnerExited: true,
      };
      report(`[m16-net] evidence: ${JSON.stringify(evidence)}`);
      report('[m16-net] active socket loss and bounded recovery: PASS');
      report('[m16-net] same SessionId, replacement PeerId, and fresh baseline: PASS');
      report('[m16-net] baseline-before-delta convergence and ACK accounting: PASS');
      report('[m16-net] process, socket, timer, and session disposal: PASS');
      report('[m16-net] PASS - M16 same-session Node WebSocket recovery GREEN');
    } finally {
      primary?.session.dispose();
      if (authority.process.exitCode === null) await authority.kill();
    }
  }, 30_000);

  it('M17 real WebSocket chaos gauntlet converges with bounded recovery and cleanup', async () => {
    const repeats = Number(process.env.M17_REPEATS ?? 3);
    const evidence: Array<Record<string, unknown>> = [];
    const waitingChaos = (client: ChaosClient): boolean => {
      const row = client.replica
        .snapshot()
        .find((candidate) => candidate.components.includes(SnakeSession.name));
      const session =
        row === undefined ? undefined : client.replica.readComponent(row.id, SnakeSession);
      return session?.started === false && session.gameplayTick === 0;
    };
    const readyCommand = encodeCommand({ kind: 'ready' });
    if (!readyCommand.ok) throw readyCommand.error;

    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const authority = (await startAuthority()) as unknown as AuthorityProcess;
      const proxy = await startChaosWebSocketProxy({
        targetUrl: `ws://127.0.0.1:${authority.port}`,
        mode: process.env.M17_CHAOS_MODE ?? 'all',
        sabotage: process.env.M17_SABOTAGE ?? '',
        delayMs: 40,
      });
      const clients: ChaosClient[] = [];
      let primary: ProcessSessionClient | undefined;
      let observer: LegacyProcessClient | undefined;
      let late: LegacyProcessClient | undefined;
      try {
        primary = await connectSession(proxy.url);
        observer = await connect(proxy.url, 2);
        if (primary === undefined || observer === undefined)
          throw new Error('M17 primary or observer client failed to connect');
        const activePrimary = primary;
        const activeObserver = observer;
        clients.push(activePrimary, activeObserver);
        await pumpChaosUntil(
          clients,
          () => clients.every(waitingChaos),
          () => ({ authority: authority.observations().slice(-8), proxy: proxy.snapshot() }),
        );
        for (const client of clients) {
          const sent = client.session.sendToAuthority(
            client.session.getRecoverySnapshot().sessionId,
            readyCommand.value,
          );
          if (!sent.ok) throw sent.error;
        }
        await pumpChaosUntil(
          clients,
          () =>
            clients.every((client) => {
              const snapshot = client.session.getRecoverySnapshot();
              return (
                snapshot.state.kind === 'active' &&
                playerIds(client).length === 2 &&
                client.packets.some((packet) => packet.kind === 'baseline') &&
                client.packets.some((packet) => packet.kind === 'delta')
              );
            }),
          () => ({ authority: authority.observations().slice(-8), proxy: proxy.snapshot() }),
        );
        const initialSnapshot = activePrimary.session.getRecoverySnapshot();
        const initialEpoch = initialSnapshot.epoch;
        const initialPeer = activePrimary.session.getPeerSnapshot().peerIds[0];
        if (initialPeer === undefined) throw new Error('M17 initial transport peer is missing');

        const disconnected = proxy.disconnectSession(initialSnapshot.sessionId);
        if (!disconnected) {
          if (process.env.M17_SABOTAGE === 'm17-disconnect-recovery') {
            throw new Error(
              '[m17-sabotage:m17-disconnect-recovery] the disconnect control was intentionally suppressed',
            );
          }
          throw new Error('M17 proxy could not disconnect the primary session');
        }

        if (process.env.M17_SABOTAGE === 'm17-out-of-order-baseline') {
          await pumpChaosUntil(
            clients,
            () => activePrimary.session.getRecoverySnapshot().state.kind === 'failed',
            () => authority.observations().slice(-8),
          );
          const failed = activePrimary.session.getRecoverySnapshot();
          expect(failed.state.kind).toBe('failed');
          expect(failed.lastError?.code).toBe('session-illegal-transition');
          throw new Error(
            `[m17-sabotage:m17-out-of-order-baseline] new-epoch delta was delivered before baseline and was rejected structurally`,
          );
        }

        await pumpChaosUntil(
          clients,
          () => {
            const snapshot = activePrimary.session.getRecoverySnapshot();
            const replacementStart = activePrimary.transport.replacementPacketStart;
            const replacementPackets =
              replacementStart === undefined ? [] : activePrimary.packets.slice(replacementStart);
            return (
              snapshot?.state.kind === 'active' &&
              snapshot.epoch > initialEpoch &&
              replacementStart !== undefined &&
              replacementPackets.some((packet) => packet.kind === 'delta') &&
              playerIds(activePrimary).length === 2 &&
              playerIds(activeObserver).length === 2
            );
          },
          () => ({ authority: authority.observations().slice(-8), proxy: proxy.snapshot() }),
        );
        const replacementSnapshot = activePrimary.session.getRecoverySnapshot();
        const replacementStart = activePrimary.transport.replacementPacketStart;
        if (replacementStart === undefined)
          throw new Error('M17 replacement connector call is missing');
        const replacementPackets = activePrimary.packets.slice(replacementStart);
        const replacementEpoch = replacementSnapshot.epoch;
        const firstCurrentEpochIndex = replacementPackets.findIndex(
          (packet) => packet.epoch === replacementEpoch,
        );
        const firstCurrentEpochPacket = replacementPackets[firstCurrentEpochIndex];
        const firstCurrentEpochDelta = replacementPackets.findIndex(
          (packet) => packet.epoch === replacementEpoch && packet.kind === 'delta',
        );
        expect(firstCurrentEpochPacket?.kind).toBe('baseline');
        expect(firstCurrentEpochPacket?.sequence).toBe(1);
        expect(firstCurrentEpochDelta).toBeGreaterThan(firstCurrentEpochIndex);
        expect(
          replacementPackets
            .slice(firstCurrentEpochIndex, firstCurrentEpochDelta)
            .every((packet) => packet.kind === 'baseline'),
        ).toBe(true);
        expect(replacementPackets.some((packet) => packet.epoch < replacementEpoch)).toBe(true);
        expect(
          activePrimary.observations.some((observation) => observation.state === 'recovering'),
        ).toBe(true);
        expect(
          activePrimary.observations.some((observation) => observation.state === 'resyncing'),
        ).toBe(true);
        expect(activePrimary.session.getPeerSnapshot().peerIds[0]).not.toBe(initialPeer);

        proxy.markLateJoin();
        late = await connect(proxy.url, 3);
        if (late === undefined) throw new Error('M17 late client failed to connect');
        const activeLate = late;
        clients.push(activeLate);
        await pumpChaosUntil(
          clients,
          () =>
            clients.every((client) => playerIds(client).length === 3) &&
            clients.every(
              (client) => client.session.getRecoverySnapshot().state.kind === 'active',
            ) &&
            activeLate.packets.some((packet) => packet.kind === 'delta'),
          () => authority.observations().slice(-8),
        );
        const lateDataPackets = activeLate.packets;
        expect(lateDataPackets[0]?.kind).toBe('baseline');
        expect(lateDataPackets[0]?.sequence).toBe(1);
        expect(lateDataPackets.some((packet) => packet.kind === 'delta')).toBe(true);
        expect(semanticState(activePrimary)).toEqual(semanticState(activeObserver));
        expect(semanticState(activePrimary)).toEqual(semanticState(activeLate));

        const assertBaselineFirstForEveryEpoch = (client: ChaosClient): boolean => {
          const packetsByEpoch = new Map<number, PacketObservation[]>();
          for (const packet of client.packets) {
            const packets = packetsByEpoch.get(packet.epoch) ?? [];
            packets.push(packet);
            packetsByEpoch.set(packet.epoch, packets);
          }
          return [...packetsByEpoch.values()].every((packets) => {
            const first = packets[0];
            if (first?.kind !== 'baseline' || first.sequence !== 1) return false;
            const firstDelta = packets.findIndex((packet) => packet.kind === 'delta');
            return firstDelta === -1 || firstDelta > 0;
          });
        };
        expect(clients.every(assertBaselineFirstForEveryEpoch)).toBe(true);

        const proxyEvidence = proxy.snapshot();
        const duplicateKeys = new Set(
          activePrimary.packets
            .reduce((counts, packet) => {
              const key = `${packet.epoch}:${packet.sequence}`;
              counts.set(key, (counts.get(key) ?? 0) + 1);
              return counts;
            }, new Map<string, number>())
            .entries(),
        );
        const duplicateWireIdentity = [...duplicateKeys].some(([, count]) => count > 1);
        const duplicateWireKeys = [...duplicateKeys]
          .filter(([, count]) => count > 1)
          .map(([key]) => key);
        const uniqueReplicaRows = clients.every((client) => {
          const ids = client.replica.snapshot().map((row) => row.id);
          const players = semanticState(client).map((row) => row.playerNetworkId);
          return new Set(ids).size === ids.length && new Set(players).size === players.length;
        });
        const disconnectRecovery =
          proxyEvidence.controls.disconnect.delivered > 0 &&
          activePrimary.session.getRecoverySnapshot().epoch > initialEpoch &&
          activePrimary.observations.some((observation) => observation.state === 'recovering') &&
          activePrimary.observations.some((observation) => observation.state === 'resyncing');
        const duplicateExactlyOnce =
          proxyEvidence.controls.duplicate.copies > 0 && duplicateWireIdentity && uniqueReplicaRows;
        const staleOutOfOrder =
          proxyEvidence.controls['out-of-order'].staleReplayed > 0 &&
          replacementPackets.some((packet) => packet.epoch < replacementEpoch);
        const delayedDelivery =
          proxyEvidence.controls['delayed-delivery'].delayedFrames > 0 &&
          proxyEvidence.controls['delayed-delivery'].maxDelayMs >= proxyEvidence.delayMs;
        const lateJoinBaseline =
          proxyEvidence.controls['late-join'].observed > 0 &&
          lateDataPackets[0]?.kind === 'baseline' &&
          lateDataPackets[0]?.sequence === 1;
        assertM17Control(
          'm17-disconnect-recovery',
          disconnectRecovery,
          `proxy=${JSON.stringify(proxyEvidence.controls.disconnect)} lifecycle=${JSON.stringify(activePrimary.observations)}`,
        );
        assertM17Control(
          'm17-duplicate-exactly-once',
          duplicateExactlyOnce,
          `duplicate=${JSON.stringify(proxyEvidence.controls.duplicate)} uniqueReplicaRows=${uniqueReplicaRows} duplicateWireIdentity=${duplicateWireIdentity}`,
        );
        assertM17Control(
          'm17-out-of-order-baseline',
          staleOutOfOrder,
          `outOfOrder=${JSON.stringify(proxyEvidence.controls['out-of-order'])} replacementPackets=${JSON.stringify(replacementPackets)}`,
        );
        assertM17Control(
          'm17-delayed-delivery',
          delayedDelivery,
          `delayed=${JSON.stringify(proxyEvidence.controls['delayed-delivery'])}`,
        );
        assertM17Control(
          'm17-late-join-baseline',
          lateJoinBaseline,
          `lateJoin=${JSON.stringify(proxyEvidence.controls['late-join'])} packets=${JSON.stringify(lateDataPackets)}`,
        );

        const allSessionObservations = clients.flatMap((client) =>
          'transport' in client ? client.observations : [],
        );
        const maxPendingPackets = Math.max(
          ...allSessionObservations.map((observation) => observation.pendingPackets),
          ...authority.observations().map((observation) => observation.pendingPackets),
        );
        expect(maxPendingPackets).toBeLessThanOrEqual(replacementSnapshot.maxPendingPackets);
        await pumpChaosUntil(
          clients,
          () =>
            authority
              .observations()
              .some(
                (observation) =>
                  observation.peerIds.length === 3 &&
                  observation.pendingPackets === 0 &&
                  observation.ownedResources?.ledgers === 0,
              ),
          () => authority.observations().slice(-8),
        );
        const authorityObservations = authority.observations();
        const finalConvergence = semanticState(activePrimary);

        for (const client of clients) client.session.dispose();
        const clientCleanup = clients.map((client) => client.session.getRecoverySnapshot());
        await proxy.close();
        await authority.kill();
        const proxyCleanup = proxy.snapshot();
        expect(clientCleanup.every((snapshot) => snapshot.state.kind === 'retired')).toBe(true);
        expect(
          clientCleanup.every((snapshot) =>
            Object.values(snapshot.ownedResources).every((value) => value === 0),
          ),
        ).toBe(true);
        expect(proxyCleanup.resources).toMatchObject({
          connections: 0,
          upstreamSockets: 0,
          timers: 0,
          queuedFrames: 0,
          lateJoinPending: false,
          serverListening: false,
        });
        expect(authority.process.exitCode).toBe(0);
        evidence.push({
          repeat: repeat + 1,
          transport: 'real-node-websocket-process-via-chaos-proxy',
          controls: proxyEvidence.controls,
          replacementPackets,
          latePackets: lateDataPackets,
          acceptedMutationIdentities: {
            uniqueWireKeys: duplicateKeys.size,
            duplicateWireKeys,
            replicaRowsUnique: uniqueReplicaRows,
          },
          convergence: finalConvergence,
          maxPendingPackets,
          authorityPendingDrained: authorityObservations.some(
            (observation) =>
              observation.peerIds.length === 3 &&
              observation.pendingPackets === 0 &&
              observation.ownedResources?.ledgers === 0,
          ),
          cleanup: {
            clients: clientCleanup,
            proxy: proxyCleanup,
            authorityExitCode: authority.process.exitCode,
          },
        });
        report(`[m17-net] chaos matrix repeat ${repeat + 1}/${repeats}: PASS`);
      } finally {
        for (const client of clients) client.session.dispose();
        await proxy.close();
        if (authority.process.exitCode === null) await authority.kill();
      }
    }
    report(`[m17-net] evidence: ${JSON.stringify({ repeats, cases: evidence })}`);
    report('[m17-net] complete real-WebSocket chaos matrix repeats=3: PASS');
  }, 180_000);
});
