import { createQueryState, Entity, type EntityHandle, queryRun } from '@forgeax/engine-ecs';
import { createMemoryEndpointPair, type EndpointEvent, type PeerId } from '@forgeax/engine-net';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createServerWorld } from '../server';
import { encodeCommand } from '../shared/commands';
import { Networked, Snake, SnakeBody, SnakeSegment } from '../shared/components';

const joinResult = encodeCommand({ kind: 'join' });
if (!joinResult.ok) throw joinResult.error;
const join = joinResult.value;
const readyResult = encodeCommand({ kind: 'ready' });
if (!readyResult.ok) throw readyResult.error;
const ready = readyResult.value;

describe('assembled Snake authority', () => {
  it('keeps transport-only connections waiting and starts after two admitted peers are ready', () => {
    let pending: EndpointEvent[] = [
      { kind: 'peer-connected', peerId: 1 as PeerId },
      { kind: 'peer-connected', peerId: 2 as PeerId },
    ];
    const authority = {
      poll: () => {
        const events = pending;
        pending = [];
        return events;
      },
      send: () => ok(undefined),
      close: () => ok(undefined),
    };
    const server = createServerWorld(authority);
    expect(server.world.update(1 / 60).ok).toBe(true);
    expect(server.game.snakes.size).toBe(0);
    pending = [{ kind: 'message', peerId: 1 as PeerId, data: join }];
    expect(server.world.update(1 / 60).ok).toBe(true);
    expect(server.game.snakes.size).toBe(1);
    expect(server.game.started).toBe(false);
    expect(server.game.snakes.get(1)?.cells).toHaveLength(3);
    pending = [{ kind: 'message', peerId: 2 as PeerId, data: join }];
    expect(server.world.update(1 / 60).ok).toBe(true);
    expect(server.game.started).toBe(false);
    pending = [{ kind: 'message', peerId: 1 as PeerId, data: ready }];
    expect(server.world.update(1 / 60).ok).toBe(true);
    expect(server.game.started).toBe(false);
    pending = [{ kind: 'message', peerId: 2 as PeerId, data: ready }];
    expect(server.world.update(1 / 60).ok).toBe(true);
    expect(server.game.started).toBe(true);
    expect(server.game.tick).toBe(0);
    const before = server.game.snakes.get(1)?.cells[0];
    expect(server.world.update(1 / 60).ok).toBe(true);
    expect(server.game.tick).toBe(1);
    expect(server.game.snakes.get(1)?.cells[0]).not.toEqual(before);
  });
  it('installs deterministic fixed-tick simulation over a memory endpoint', () => {
    const server = createStartedServer();
    expect(server.game.tick).toBe(0);
    expect(server.world.update(1).ok).toBe(true);
    expect(server.game.tick).toBe(4);
  });

  it('rejects malformed and opposite commands at the assembled boundary', () => {
    const [authority, peer] = createMemoryEndpointPair();
    const server = createServerWorld(authority);
    // Consume the initial peer-connected event and spawn the peer snake.
    peer.send(1 as PeerId, join);
    expect(server.world.update(1).ok).toBe(true);
    const snake = server.game.snakes.get(2);
    expect(snake).toBeDefined();
    const before = structuredClone(snake);
    peer.send(1 as PeerId, new Uint8Array([99, 99, 99]));
    expect(server.world.update(0.25).ok).toBe(true);
    expect(server.game.snakes.get(2)).toEqual(
      expect.objectContaining({ direction: before?.direction }),
    );
    // A payload with an extra identity field is malformed; identity comes from the event.
    peer.send(1 as PeerId, new Uint8Array([1, 2, 7]));
    expect(server.world.update(0.25).ok).toBe(true);
    expect(server.game.snakes.get(2)?.direction).toBe(before?.direction);
    // First valid command wins for this fixed tick; the duplicate is ignored.
    peer.send(1 as PeerId, new Uint8Array([1, 0]));
    peer.send(1 as PeerId, new Uint8Array([1, 2]));
    expect(server.world.update(0.25).ok).toBe(true);
    expect(server.game.snakes.get(2)?.direction).toBe('up');
  });

  it('grows on food and respawns exactly 30 fixed ticks after death', () => {
    const fixedStep = 1 / 60;
    const server = createStartedServer();
    const snake = server.game.snakes.get(2);
    expect(snake).toBeDefined();
    if (snake === undefined) return;

    snake.cells = [{ x: 4, y: 1 }];
    server.game.food = { x: 5, y: 1 };
    const scoreBefore = snake.score;
    expect(server.world.update(fixedStep).ok).toBe(true);
    expect(snake.score).toBe(scoreBefore + 1);
    expect(snake.cells).toHaveLength(2);

    snake.cells = [{ x: 23, y: 1 }];
    snake.direction = 'right';
    for (let index = 0; index < 5; index += 1) expect(server.world.update(fixedStep).ok).toBe(true);
    expect(snake.cells).toHaveLength(0);
    const respawnTick = snake.respawnAt;
    expect(respawnTick).toBe(server.game.tick + 30);
    while (server.game.tick < (respawnTick as number) - 1) {
      expect(server.world.update(fixedStep).ok).toBe(true);
      expect(snake.cells).toHaveLength(0);
    }
    expect(server.game.tick).toBe((respawnTick as number) - 1);
    expect(server.world.update(fixedStep).ok).toBe(true);
    expect(snake.respawnAt).toBeNull();
    expect(snake.cells).toHaveLength(3);
  });

  it('projects authoritative snakes, segments, and remapped body references into ECS', () => {
    const server = createStartedServer();
    server.game.snakes.delete(1);
    const authoritySnake = server.game.snakes.get(2);
    expect(authoritySnake).toBeDefined();
    authoritySnake?.cells.splice(0, authoritySnake.cells.length, { x: 4, y: 2 }, { x: 3, y: 2 });
    expect(server.world.update(1).ok).toBe(true);
    const snakes: EntityHandle[] = [];
    const segments: EntityHandle[] = [];
    queryRun(createQueryState({ with: [Networked, Entity] }), server.world, (bundle) => {
      for (const entity of bundle.Entity.self as unknown as EntityHandle[]) {
        if (server.world.get(entity, Snake).ok) snakes.push(entity);
        if (server.world.get(entity, SnakeSegment).ok) segments.push(entity);
      }
    });
    expect(snakes).toHaveLength(1);
    expect(segments).toHaveLength(1);
    const body = server.world.get(snakes[0] as EntityHandle, SnakeBody).unwrap();
    expect(body.segments).toHaveLength(1);
    expect(body.segments[0]).toBe(segments[0]);
  });

  it('despawns the snake and segments after an authority death', () => {
    const server = createStartedServer();
    server.game.snakes.delete(1);
    const snake = server.game.snakes.get(2);
    expect(snake).toBeDefined();
    snake?.cells.splice(0, snake.cells.length, { x: 23, y: 1 }, { x: 22, y: 1 });
    expect(server.world.update(1).ok).toBe(true);
    expect(snake?.respawnAt).not.toBeNull();
    const projected = [] as EntityHandle[];
    queryRun(createQueryState({ with: [Networked, Entity] }), server.world, (bundle) => {
      projected.push(...(bundle.Entity.self as unknown as EntityHandle[]));
    });
    expect(projected.every((entity) => !server.world.get(entity, Snake).ok)).toBe(true);
  });

  it('refuses a fifth peer without creating a fifth snake', () => {
    let pending = [1, 2, 3, 4, 5].flatMap((peerId) => [
      { kind: 'peer-connected' as const, peerId: peerId as PeerId },
      { kind: 'message' as const, peerId: peerId as PeerId, data: join },
    ]);
    const endpoint = {
      poll: () => {
        const events = pending;
        pending = [];
        return events;
      },
      send: () => ok(undefined),
      close: () => ok(undefined),
    };
    const server = createServerWorld(endpoint);
    expect(server.world.update(1).ok).toBe(true);
    expect(server.game.snakes.size).toBe(4);
    expect(server.game.snakes.has(5)).toBe(false);
  });

  it('binds commands to endpoint PeerId and ignores an identity-confused event', () => {
    let pending: Array<
      | { kind: 'peer-connected'; peerId: PeerId }
      | { kind: 'message'; peerId: PeerId; data: Uint8Array }
    > = [
      { kind: 'peer-connected' as const, peerId: 7 as PeerId },
      { kind: 'message' as const, peerId: 7 as PeerId, data: join },
    ];
    const endpoint = {
      poll: () => {
        const events = pending;
        pending = [];
        return events;
      },
      send: () => ok(undefined),
      close: () => ok(undefined),
    };
    const server = createServerWorld(endpoint);
    expect(server.world.update(1).ok).toBe(true);
    expect(server.game.snakes.get(7)?.direction).toBe('right');

    pending = [{ kind: 'message' as const, peerId: 7 as PeerId, data: new Uint8Array([1, 2]) }];
    expect(server.world.update(1).ok).toBe(true);
    expect(server.game.snakes.get(7)?.direction).toBe('down');
    expect(server.game.lastDirectionCommandPlayerNetworkId).toBe(7);
    expect(server.game.lastDirectionCommandGameplayTick).toBe(0);

    // The command bytes contain no peer field. A transport event claiming a
    // different peer cannot steer the connected snake because PeerId comes
    // from the endpoint event and must match the connected-peer snapshot.
    pending = [{ kind: 'message' as const, peerId: 99 as PeerId, data: new Uint8Array([1, 0]) }];
    expect(server.world.update(1).ok).toBe(true);
    expect(server.game.snakes.get(7)?.direction).toBe('down');
    expect(server.game.snakes.has(99)).toBe(false);
    expect(server.game.lastDirectionCommandPlayerNetworkId).toBe(7);
  });
});

function createStartedServer() {
  let pending: EndpointEvent[] = [
    { kind: 'peer-connected', peerId: 1 as PeerId },
    { kind: 'peer-connected', peerId: 2 as PeerId },
    { kind: 'message', peerId: 1 as PeerId, data: join },
    { kind: 'message', peerId: 2 as PeerId, data: join },
  ];
  const server = createServerWorld({
    poll: () => {
      const events = pending;
      pending = [];
      return events;
    },
    send: () => ok(undefined),
    close: () => ok(undefined),
  });
  server.world.update(1 / 60).unwrap();
  pending = [
    { kind: 'message', peerId: 1 as PeerId, data: ready },
    { kind: 'message', peerId: 2 as PeerId, data: ready },
  ];
  server.world.update(1 / 60).unwrap();
  return server;
}
