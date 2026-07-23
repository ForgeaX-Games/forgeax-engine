import { type EntityHandle, FixedTime, FixedUpdate, World } from '@forgeax/engine-ecs';
import {
  createAuthorityCoordinator,
  type NetEndpoint,
  type NetSession,
  netPlugin,
} from '@forgeax/engine-net';
import { listenWebSocketEndpoint } from '@forgeax/engine-net-websocket/node';
import type { Direction } from './shared/commands';
import {
  decodeCommand,
  processCommands,
  processJoinCommands,
  processReadyCommands,
} from './shared/commands';
import {
  ControlledBy,
  Food,
  GridPosition,
  Networked,
  PendingDirection,
  Snake,
  SnakeBody,
  SnakeSegment,
  SnakeSession,
  snakeProfile,
} from './shared/components';
import { SNAKE_MOVE_INTERVAL_SECONDS, type SnakeGameState, tickSimulation } from './shared/rules';

export interface SnakeServer {
  readonly world: World;
  readonly game: SnakeGameState;
}

const directionValue: Record<Direction, number> = { up: 0, right: 1, down: 2, left: 3 };

interface SnakeEntities {
  readonly snake: EntityHandle;
  segments: EntityHandle[];
}

function initialSnakeCells(index: number) {
  const y = 3 + index * 3;
  return [
    { x: 4, y },
    { x: 3, y },
    { x: 2, y },
  ];
}

/**
 * Materialize the plain deterministic game state into the replicated ECS
 * surface. The coordinator assigns network ids from these stable handles;
 * segment references therefore get remapped correctly on every replica.
 */
function projectGameState(
  world: World,
  game: SnakeGameState,
  byPeer: Map<number, SnakeEntities>,
  foodRef: { entity?: EntityHandle },
): void {
  if (foodRef.entity === undefined) {
    foodRef.entity = world
      .spawn(
        { component: Networked, data: { enabled: true } },
        { component: Food, data: { enabled: true } },
        { component: GridPosition, data: game.food },
      )
      .unwrap();
  } else world.set(foodRef.entity, GridPosition, game.food).unwrap();

  const livePeers = new Set(game.snakes.keys());
  for (const [peerId, entities] of [...byPeer]) {
    const snake = game.snakes.get(peerId);
    if (snake === undefined || snake.cells.length === 0) {
      for (const segment of entities.segments) world.despawn(segment).unwrap();
      world.despawn(entities.snake).unwrap();
      byPeer.delete(peerId);
    }
  }

  for (const [peerId, snake] of game.snakes) {
    if (snake.cells.length === 0) continue;
    const head = snake.cells[0] ?? { x: 0, y: 0 };
    let entities = byPeer.get(peerId);
    if (entities === undefined) {
      const created = world
        .spawn(
          { component: Networked, data: { enabled: true } },
          {
            component: Snake,
            data: {
              direction: directionValue[snake.direction],
              score: snake.score,
              playerNetworkId: peerId,
            },
          },
          { component: GridPosition, data: head },
          { component: SnakeBody, data: { segments: [] } },
          { component: ControlledBy, data: { peer: peerId } },
          { component: PendingDirection, data: { value: directionValue[snake.direction] } },
        )
        .unwrap();
      entities = { snake: created, segments: [] };
      byPeer.set(peerId, entities);
    }
    world
      .set(entities.snake, Snake, {
        direction: directionValue[snake.direction],
        score: snake.score,
        playerNetworkId: peerId,
      })
      .unwrap();
    world.set(entities.snake, GridPosition, head).unwrap();
    world
      .set(entities.snake, PendingDirection, { value: directionValue[snake.direction] })
      .unwrap();
    while (entities.segments.length > snake.cells.length - 1) {
      const segment = entities.segments.pop();
      if (segment !== undefined) world.despawn(segment).unwrap();
    }
    while (entities.segments.length < snake.cells.length - 1) {
      entities.segments.push(
        world
          .spawn(
            { component: Networked, data: { enabled: true } },
            {
              component: SnakeSegment,
              data: { playerNetworkId: peerId, order: entities.segments.length + 1 },
            },
            { component: GridPosition, data: { x: 0, y: 0 } },
          )
          .unwrap(),
      );
    }
    for (const [index, segment] of entities.segments.entries()) {
      world.set(segment, GridPosition, snake.cells[index + 1] ?? { x: 0, y: 0 }).unwrap();
    }
    world.set(entities.snake, SnakeBody, { segments: entities.segments }).unwrap();
  }
  // The set above is authoritative; this guard documents that disconnected
  // peers never retain a projected entity even when no simulation tick ran.
  for (const peerId of byPeer.keys()) if (!livePeers.has(peerId)) byPeer.delete(peerId);
}

export function createServerWorld(endpoint: NetEndpoint): SnakeServer {
  const world = new World();
  const built = netPlugin({ endpoint }).build(world);
  if (built instanceof Promise) throw new Error('Snake net plugin must build synchronously');
  if (!built.ok) throw built.error;
  const session = world.getResource<NetSession>('net-session');
  session.attachAuthority(createAuthorityCoordinator(world, snakeProfile));
  const game: SnakeGameState = {
    tick: 0,
    started: false,
    gameplayTick: 0,
    nextId: 1,
    snakes: new Map(),
    food: { x: 12, y: 8 },
    width: 24,
    height: 16,
    maxPeers: 4,
    seed: 1,
    movementAccumulatorSeconds: SNAKE_MOVE_INTERVAL_SECONDS,
    movementIntervalSeconds: SNAKE_MOVE_INTERVAL_SECONDS,
  };
  world.insertResource('snake-game', game);
  const sessionEntity = world
    .spawn(
      { component: Networked, data: { enabled: true } },
      {
        component: SnakeSession,
        data: {
          started: false,
          gameplayTick: 0,
          startedAtGameplayTick: 0,
          lastDirectionCommandPlayerNetworkId: 0,
          lastDirectionCommandGameplayTick: 0,
        },
      },
    )
    .unwrap();
  const projected = new Map<number, SnakeEntities>();
  const readyPeers = new Set<number>();
  const foodRef: { entity?: EntityHandle } = {};
  projectGameState(world, game, projected, foodRef);
  world.addSystem(FixedUpdate, {
    name: 'snake-fixed-tick',
    queries: [],
    resources: ['net-session', 'snake-game'],
    fn: (world) => {
      const activeSession = world.getResource<NetSession>('net-session');
      const activeGame = world.getResource<SnakeGameState>('snake-game');
      const fixedDeltaSeconds = world.getResource(FixedTime).delta;
      const wasStarted = activeGame.started;
      const rawMessages = activeSession.drainRawMessages();
      const peerIds = activeSession.getPeerSnapshot().peerIds;
      for (const peerId of [...readyPeers])
        if (!peerIds.includes(peerId as (typeof peerIds)[number])) readyPeers.delete(peerId);
      const joined = new Set(activeGame.snakes.keys());
      for (const peerId of processJoinCommands(rawMessages, new Set(peerIds))) joined.add(peerId);
      for (const peerId of processReadyCommands(rawMessages, new Set(peerIds)))
        readyPeers.add(peerId);
      for (const peerId of [...joined])
        if (!peerIds.includes(peerId as (typeof peerIds)[number])) joined.delete(peerId);
      for (const peerId of [...activeGame.snakes.keys()])
        if (!joined.has(peerId)) activeGame.snakes.delete(peerId);
      for (const peerId of joined) {
        if (activeGame.snakes.has(peerId)) continue;
        if (activeGame.snakes.size >= activeGame.maxPeers) continue;
        activeGame.snakes.set(peerId, {
          peerId,
          direction: 'right',
          score: 0,
          cells: initialSnakeCells(activeGame.snakes.size),
          respawnAt: null,
        });
        activeSession.requestFullBaseline(peerId as never);
      }
      // Admission is complete only after both peers have a projected snake.
      // This keeps the replicated waiting state observable until the second
      // peer has actually been accepted and baselined.
      if (!activeGame.started && readyPeers.size >= 2) {
        activeGame.started = true;
        activeGame.startedAtGameplayTick = activeGame.gameplayTick ?? 0;
      }
      const directions = new Map(
        [...activeGame.snakes.values()].map((snake) => [snake.peerId, snake.direction]),
      );
      const directionMessages = rawMessages.filter((message) => {
        const decoded = decodeCommand(message.data);
        return decoded.ok && !('kind' in decoded.value);
      });
      for (const [peerId, direction] of processCommands(directionMessages, directions)) {
        const snake = activeGame.snakes.get(peerId);
        if (snake === undefined) continue;
        snake.direction = direction;
        activeGame.lastDirectionCommandPlayerNetworkId = peerId;
        activeGame.lastDirectionCommandGameplayTick = activeGame.gameplayTick ?? 0;
      }
      if (wasStarted) tickSimulation(activeGame, fixedDeltaSeconds);
      world
        .set(sessionEntity, SnakeSession, {
          started: activeGame.started ?? false,
          gameplayTick: activeGame.gameplayTick ?? 0,
          startedAtGameplayTick: activeGame.startedAtGameplayTick ?? 0,
          lastDirectionCommandPlayerNetworkId: activeGame.lastDirectionCommandPlayerNetworkId ?? 0,
          lastDirectionCommandGameplayTick: activeGame.lastDirectionCommandGameplayTick ?? 0,
        })
        .unwrap();
      projectGameState(world, activeGame, projected, foodRef);
    },
  });
  return { world, game };
}

export async function startServer(port: number) {
  const listened = await listenWebSocketEndpoint({ port, maxPeers: 4 });
  if (!listened.ok) throw listened.error;
  const server = createServerWorld(listened.value);
  return { ...server, port, close: () => listened.value.close() };
}
