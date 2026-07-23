import { World } from '@forgeax/engine-ecs';
import {
  createReplicaCoordinator,
  decodeAndApplyReplicaBatch,
  type NetEndpoint,
  type PeerId,
} from '@forgeax/engine-net';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createServerWorld } from '../server';
import { encodeCommand } from '../shared/commands';
import { GridPosition, Snake, SnakeBody, SnakeSegment, snakeProfile } from '../shared/components';

describe('Snake deterministic convergence', () => {
  it('remaps SnakeBody.segments and cleans disconnected replica entities', () => {
    const encodedJoin = encodeCommand({ kind: 'join' });
    if (!encodedJoin.ok) throw encodedJoin.error;
    const join = encodedJoin.value;
    let pending: Array<
      | { kind: 'peer-connected'; peerId: PeerId }
      | { kind: 'peer-disconnected'; peerId: PeerId }
      | { kind: 'message'; peerId: PeerId; data: Uint8Array }
    > = [
      { kind: 'peer-connected', peerId: 2 as PeerId },
      { kind: 'message', peerId: 2 as PeerId, data: join },
      { kind: 'peer-connected', peerId: 3 as PeerId },
      { kind: 'message', peerId: 3 as PeerId, data: join },
    ];
    const sent: Uint8Array[] = [];
    const authorityEndpoint: NetEndpoint = {
      poll: () => {
        const events = pending;
        pending = [];
        return events;
      },
      send: (_peerId, data) => {
        sent.push(data);
        return ok(undefined);
      },
      close: () => ok(undefined),
    };
    const authority = createServerWorld(authorityEndpoint);
    authority.game.snakes.set(2, {
      peerId: 2,
      direction: 'right',
      score: 2,
      cells: [
        { x: 5, y: 1 },
        { x: 4, y: 1 },
        { x: 3, y: 1 },
      ],
      respawnAt: null,
    });
    expect(authority.world.update(1).ok).toBe(true);
    const firstBatch = sent[0];
    expect(firstBatch).toBeDefined();
    if (firstBatch === undefined) return;
    const replicaWorld = new World();
    replicaWorld.spawn().unwrap();
    replicaWorld.spawn().unwrap();
    const replica = createReplicaCoordinator(replicaWorld, snakeProfile);
    const fixture = JSON.parse(new TextDecoder().decode(firstBatch)) as {
      entities: Array<{
        id: number;
        components: Array<{ name: string; data: Record<string, unknown> }>;
      }>;
    };
    const bodyRecord = fixture.entities
      .flatMap((entity) => entity.components.map((component) => ({ entity, component })))
      .find(({ component }) => component.name === SnakeBody.name);
    expect(bodyRecord).toBeDefined();
    if (bodyRecord === undefined) return;
    expect(bodyRecord.component.data.segments).toHaveLength(2);
    const applied = decodeAndApplyReplicaBatch(
      replica,
      new TextEncoder().encode(JSON.stringify(fixture)),
      snakeProfile.limits,
    );
    if (!applied.ok) throw new Error(applied.error.message);
    const snakeRow = replica.snapshot().find((row) => row.components.includes(Snake.name));
    expect(snakeRow).toBeDefined();
    if (snakeRow === undefined) return;
    const body = replica.readComponent(snakeRow.id, SnakeBody);
    const segmentRefs = Object.values(body?.segments ?? {});
    expect(segmentRefs.length).toBeGreaterThanOrEqual(2);
    const localSnake = replica.entityFor(snakeRow.id);
    expect(localSnake).toBeDefined();
    if (localSnake === undefined) return;
    const semantic = resolveBodySemantic(replica, snakeRow.id);
    expect(semantic.map((segment) => segment.order)).toEqual([1, 2]);
    expect(semantic.every((segment) => segment.owner === snakeRow.id)).toBe(true);
    const lateWorld = new World();
    for (let index = 0; index < 5; index += 1) lateWorld.spawn().unwrap();
    const late = createReplicaCoordinator(lateWorld, snakeProfile);
    expect(
      decodeAndApplyReplicaBatch(
        late,
        new TextEncoder().encode(JSON.stringify(fixture)),
        snakeProfile.limits,
      ).ok,
    ).toBe(true);
    const lateSnake = late.snapshot().find((row) => row.components.includes(Snake.name));
    expect(lateSnake).toBeDefined();
    if (lateSnake !== undefined) expect(resolveBodySemantic(late, lateSnake.id)).toEqual(semantic);

    const validSegments = segmentRefs as never[];
    const copiedLocal = replicaWorld.set(localSnake, SnakeBody, {
      segments: [replicaWorld.spawn().unwrap(), ...validSegments.slice(1)],
    });
    expect(copiedLocal.ok).toBe(true);
    expect(() => assertBodySemantic(replica, snakeRow.id)).toThrow();
    replicaWorld.set(localSnake, SnakeBody, { segments: validSegments }).unwrap();
    replicaWorld.set(localSnake, SnakeBody, { segments: [...validSegments].reverse() }).unwrap();
    expect(() => assertBodySemantic(replica, snakeRow.id)).toThrow();
    replicaWorld.set(localSnake, SnakeBody, { segments: validSegments }).unwrap();
    expect(() => assertBodySemantic(replica, snakeRow.id)).not.toThrow();

    pending = [{ kind: 'peer-disconnected', peerId: 2 as PeerId }];
    expect(authority.world.update(1).ok).toBe(true);
    replica.clear();
    expect(
      replica
        .snapshot()
        .filter((row) =>
          row.components.some((name) => name === Snake.name || name === SnakeSegment.name),
        ),
    ).toHaveLength(0);
  });

  it('publishes a late peer full baseline with the admitted roster', () => {
    const encodedJoin = encodeCommand({ kind: 'join' });
    if (!encodedJoin.ok) throw encodedJoin.error;
    const join = encodedJoin.value;
    const encodedReady = encodeCommand({ kind: 'ready' });
    if (!encodedReady.ok) throw encodedReady.error;
    const ready = encodedReady.value;
    let pending: Array<
      | { kind: 'peer-connected'; peerId: PeerId }
      | { kind: 'peer-disconnected'; peerId: PeerId }
      | { kind: 'message'; peerId: PeerId; data: Uint8Array }
    > = [
      { kind: 'peer-connected', peerId: 2 as PeerId },
      { kind: 'message', peerId: 2 as PeerId, data: join },
      { kind: 'peer-connected', peerId: 3 as PeerId },
      { kind: 'message', peerId: 3 as PeerId, data: join },
    ];
    const sent: Array<{ peerId: PeerId; data: Uint8Array }> = [];
    const endpoint: NetEndpoint = {
      poll: () => {
        const events = pending;
        pending = [];
        return events;
      },
      send: (peerId, data) => {
        sent.push({ peerId, data });
        return ok(undefined);
      },
      close: () => ok(undefined),
    };
    const authority = createServerWorld(endpoint);
    const early = makeReplica();
    expect(authority.world.update(1).ok).toBe(true);
    const first = sent.find((message) => message.peerId === (2 as PeerId))?.data;
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(decodeAndApplyReplicaBatch(early, first, snakeProfile.limits).ok).toBe(true);

    pending = [
      { kind: 'message', peerId: 2 as PeerId, data: ready },
      { kind: 'message', peerId: 3 as PeerId, data: ready },
    ];
    expect(authority.world.update(1).ok).toBe(true);
    const second = sent.filter((message) => message.peerId === (2 as PeerId)).at(-1)?.data;
    expect(second).toBeDefined();
    if (second === undefined) return;
    expect(decodeAndApplyReplicaBatch(early, second, snakeProfile.limits).ok).toBe(true);
    expect(early.tick).toBeGreaterThan(0);

    // The late peer joins after the early peer has already advanced.
    pending = [
      { kind: 'peer-connected', peerId: 4 as PeerId },
      { kind: 'message', peerId: 4 as PeerId, data: join },
    ];
    expect(authority.world.update(1).ok).toBe(true);
    const lateBaseline = sent.filter((message) => message.peerId === 4)[0]?.data;
    expect(lateBaseline).toBeDefined();
    if (lateBaseline === undefined) return;
    expect(playerIdsInBatch(lateBaseline)).toEqual([2, 3, 4]);
  });
});

function playerIdsInBatch(bytes: Uint8Array): number[] {
  const batch = JSON.parse(new TextDecoder().decode(bytes)) as {
    entities: Array<{ components: Array<{ name: string; data: { playerNetworkId?: number } }> }>;
  };
  return batch.entities
    .flatMap((entity) => entity.components)
    .filter((component) => component.name === Snake.name)
    .map((component) => component.data.playerNetworkId ?? 0)
    .sort((left, right) => left - right);
}

function makeReplica() {
  const world = new World();
  const replica = createReplicaCoordinator(world, snakeProfile);
  return replica;
}

function resolveBodySemantic(
  replica: ReturnType<typeof createReplicaCoordinator>,
  snakeId: number,
) {
  const body = replica.readComponent(snakeId, SnakeBody);
  const refs = Object.values(body?.segments ?? {});
  const snake = replica.readComponent(snakeId, Snake);
  return refs.map((segment) => {
    const row = replica.snapshot().find((candidate) => replica.entityFor(candidate.id) === segment);
    if (row === undefined) throw new Error('unresolved replica segment handle');
    const data = replica.readComponent(row.id, SnakeSegment);
    const position = replica.readComponent(row.id, GridPosition);
    if (
      data === undefined ||
      position === undefined ||
      Number(data.playerNetworkId) !== Number(snake?.playerNetworkId)
    )
      throw new Error('segment semantic mismatch');
    return {
      netId: row.id,
      owner: snakeId,
      order: Number(data.order),
      position: { x: Number(position.x), y: Number(position.y) },
    };
  });
}

function assertBodySemantic(replica: ReturnType<typeof createReplicaCoordinator>, snakeId: number) {
  const semantic = resolveBodySemantic(replica, snakeId);
  semantic.forEach((segment, index) => {
    if (segment.order !== index + 1) throw new Error('segment order mismatch');
  });
}
