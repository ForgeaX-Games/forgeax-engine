import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createApp } from '@forgeax/engine-app';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, Update, type World } from '@forgeax/engine-ecs';
import {
  createReplicaCoordinator,
  type NetEndpoint,
  type NetSession,
  netPlugin,
  type PeerId,
} from '@forgeax/engine-net';
import { connectWebSocketClientEndpoint } from '@forgeax/engine-net-websocket/browser';
import {
  Camera,
  type MaterialAsset,
  Materials,
  MeshFilter,
  MeshRenderer,
  orthographic,
  Transform,
} from '@forgeax/engine-runtime';
import { type Direction, encodeCommand, encodeDirectionCommand } from './shared/commands';
import {
  Food,
  GridPosition,
  Snake,
  SnakeBody,
  SnakeSegment,
  SnakeSession,
  snakeProfile,
} from './shared/components';

export interface ReplicaRenderSinks {
  readonly stateTarget?: HTMLElement;
  readonly directionCommandEvidence?: DirectionCommandEvidence;
}

export interface ReplicatedSnake {
  readonly networkEntityId: number;
  readonly playerNetworkId: number;
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly score: number;
  readonly bodyLength: number;
  readonly direction: 'up' | 'right' | 'down' | 'left';
  readonly color: number;
}

export interface RenderSnake {
  readonly id: number;
  readonly position: readonly [number, number, number];
  readonly color: number;
}

export interface DirectionCommandEvidence {
  directionCommandSendCount: number;
  lastAttemptedDirection?: Direction;
  lastSendResult?: 'sent' | 'rejected';
}

/** The simulation grid grows downward; the orthographic world grows upward. */
export function gridToWorldPosition(x: number, y: number): [number, number, number] {
  return [x - 12, 8 - y, 0];
}

function replicaEntityReferences(value: unknown): number[] {
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value).map(Number).filter(Number.isFinite);
}

export function deriveReplicaRenderState(snakes: readonly ReplicatedSnake[]): RenderSnake[] {
  return snakes.map((snake) => ({
    id: snake.networkEntityId,
    position: [snake.x, snake.y, 0],
    color: snake.playerNetworkId % 2,
  }));
}

export function renderSnakeState(
  target: HTMLElement,
  tick: number,
  snakes: readonly ReplicatedSnake[],
  food?: { readonly x: number; readonly y: number },
  session?: {
    readonly started: boolean;
    readonly gameplayTick: number;
    readonly startedAtGameplayTick: number;
    readonly lastDirectionCommandPlayerNetworkId: number;
    readonly lastDirectionCommandGameplayTick: number;
  },
  localPlayerNetworkId?: number,
): void {
  target.dataset.testid = 'snake-state';
  target.dataset.lifecycle = tick === 0 ? 'waiting' : tick === 1 ? 'gameplay-start' : 'gameplay';
  if (tick === 0) target.dataset.waitingTick = '0';
  if (tick > 0 && target.dataset.gameplayStartTick === undefined)
    target.dataset.gameplayStartTick = String(tick);
  target.textContent = JSON.stringify({
    tick,
    snakes: snakes.map(
      ({ networkEntityId, playerNetworkId, id, x, y, score, bodyLength, direction }) => ({
        id,
        networkEntityId,
        playerNetworkId,
        x,
        y,
        score,
        bodyLength,
        direction,
      }),
    ),
    ...(food === undefined ? {} : { food }),
    ...(session === undefined ? {} : { session }),
  });
  const status = globalThis.document?.querySelector<HTMLElement>('#round-status');
  const scoreboard = globalThis.document?.querySelector<HTMLElement>('#scoreboard');
  if (status !== null && status !== undefined) {
    status.textContent =
      session?.started === false
        ? 'Waiting for a second player…'
        : snakes.length === 0
          ? 'Round resetting…'
          : 'Round in progress';
  }
  if (scoreboard !== null && scoreboard !== undefined) {
    const localPlayer = snakes.find((snake) => snake.playerNetworkId === localPlayerNetworkId);
    scoreboard.replaceChildren(
      ...(localPlayer === undefined
        ? []
        : [
            Object.assign(document.createElement('span'), {
              className: localPlayer.color === 0 ? 'cyan' : 'orange',
              textContent: `You are P${localPlayer.playerNetworkId}`,
            }),
          ]),
      ...snakes.map((snake) => {
        const item = document.createElement('span');
        item.className = snake.color === 0 ? 'cyan' : 'orange';
        item.textContent = `P${snake.playerNetworkId}: ${snake.score}`;
        return item;
      }),
    );
  }
}

export function registerReplicaDerivation(
  world: World,
  replica: ReturnType<typeof createReplicaCoordinator>,
  sinks: ReplicaRenderSinks = {},
  endpoint?: NetEndpoint,
): Map<number, EntityHandle> {
  const hasBrowserVisuals = sinks.stateTarget !== undefined && globalThis.document !== undefined;
  const hideBodyForVisualFalsification =
    globalThis.location?.search.includes('visual-sabotage=hide-body') ?? false;
  const renderEntities = new Map<number, EntityHandle>();
  let localPlayerNetworkId: number | undefined;
  const snakeMaterials = [
    world.allocSharedRef<'MaterialAsset', MaterialAsset>(
      'MaterialAsset',
      Materials.unlit([0.13, 0.83, 0.93, 1]),
    ),
    world.allocSharedRef<'MaterialAsset', MaterialAsset>(
      'MaterialAsset',
      Materials.unlit([0.98, 0.45, 0.09, 1]),
    ),
  ] as const;
  const snakeBodyMaterials = [
    world.allocSharedRef<'MaterialAsset', MaterialAsset>(
      'MaterialAsset',
      Materials.unlit([0.05, 0.46, 0.54, 1]),
    ),
    world.allocSharedRef<'MaterialAsset', MaterialAsset>(
      'MaterialAsset',
      Materials.unlit([0.61, 0.24, 0.04, 1]),
    ),
  ] as const;
  const foodMaterial = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.unlit([0.96, 0.23, 0.38, 1]),
  );
  const boundaryMaterial = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.unlit([0.2, 0.27, 0.38, 1]),
  );
  let foodEntity: EntityHandle | undefined;
  let readySent = false;
  if (hasBrowserVisuals) {
    foodEntity = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0], scale: [0.55, 0.55, 0.55] } },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [foodMaterial] } },
      )
      .unwrap();
    for (const [pos, scale] of [
      [
        [0, -8.5, 0],
        [25, 0.2, 0.2],
      ],
      [
        [0, 8.5, 0],
        [25, 0.2, 0.2],
      ],
      [
        [-12.5, 0, 0],
        [0.2, 17, 0.2],
      ],
      [
        [12.5, 0, 0],
        [0.2, 17, 0.2],
      ],
    ] as const)
      world
        .spawn(
          { component: Transform, data: { pos, scale } },
          { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
          { component: MeshRenderer, data: { materials: [boundaryMaterial] } },
        )
        .unwrap();
  }
  world.addSystem(Update, {
    name: 'snake-replica-derivation',
    queries: [],
    resources: ['net-session'],
    fn: (world) => {
      const liveIds = new Set<number>();
      const snakes: ReplicatedSnake[] = [];
      let food: { x: number; y: number } | undefined;
      const rows = replica.snapshot();
      const playerColors = new Map<number, number>();
      let session:
        | {
            started: boolean;
            gameplayTick: number;
            startedAtGameplayTick: number;
            lastDirectionCommandPlayerNetworkId: number;
            lastDirectionCommandGameplayTick: number;
          }
        | undefined;
      for (const row of rows) {
        const foodComponent = replica.readComponent(row.id, Food);
        const foodPosition = replica.readComponent(row.id, GridPosition);
        const sessionComponent = replica.readComponent(row.id, SnakeSession);
        if (sessionComponent !== undefined) {
          session = {
            started: Boolean(sessionComponent.started),
            gameplayTick: Number(sessionComponent.gameplayTick ?? 0),
            startedAtGameplayTick: Number(sessionComponent.startedAtGameplayTick ?? 0),
            lastDirectionCommandPlayerNetworkId: Number(
              sessionComponent.lastDirectionCommandPlayerNetworkId ?? 0,
            ),
            lastDirectionCommandGameplayTick: Number(
              sessionComponent.lastDirectionCommandGameplayTick ?? 0,
            ),
          };
          continue;
        }
        if (foodComponent !== undefined && foodPosition !== undefined) {
          food = { x: Number(foodPosition.x ?? 0), y: Number(foodPosition.y ?? 0) };
          continue;
        }
        const position = replica.readComponent(row.id, GridPosition);
        const snake = replica.readComponent(row.id, Snake);
        if (position === undefined || snake === undefined) continue;
        const body = replica.readComponent(row.id, SnakeBody);
        const bodySegments = replicaEntityReferences(body?.segments);
        liveIds.add(row.id);
        snakes.push({
          id: row.id,
          x: Number(position.x ?? 0),
          y: Number(position.y ?? 0),
          score: Number(snake.score ?? 0),
          bodyLength: bodySegments.length + 1,
          direction: (['up', 'right', 'down', 'left'][Number(snake.direction ?? 0)] ??
            'right') as ReplicatedSnake['direction'],
          networkEntityId: row.id,
          playerNetworkId: Number(snake.playerNetworkId ?? 0),
          color: Number(snake.playerNetworkId ?? 0) % 2,
        });
        const color = Number(snake.playerNetworkId ?? 0) % 2;
        playerColors.set(Number(snake.playerNetworkId ?? 0), color);
        let entity = renderEntities.get(row.id);
        if (entity === undefined) {
          entity = world
            .spawn(
              { component: Transform, data: { pos: [0, 0, 0] } },
              { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
              {
                component: MeshRenderer,
                data: {
                  materials: [
                    snakeMaterials[Number(snake.playerNetworkId) % 2] ?? snakeMaterials[0],
                  ],
                },
              },
            )
            .unwrap();
          renderEntities.set(row.id, entity);
        }
        world.set(entity, Transform, {
          pos: gridToWorldPosition(Number(position.x ?? 0), Number(position.y ?? 0)),
        });
      }
      if (session?.started === false && !readySent && endpoint !== undefined) {
        const ready = encodeCommand({ kind: 'ready' });
        if (!ready.ok) throw ready.error;
        if (endpoint.send(1 as PeerId, ready.value)) readySent = true;
      }
      if (hasBrowserVisuals && session?.started === false) {
        for (const [, entity] of renderEntities) world.despawn(entity).unwrap();
        renderEntities.clear();
        if (sinks.stateTarget !== undefined)
          renderSnakeState(
            sinks.stateTarget,
            replica.tick,
            [],
            food,
            session,
            localPlayerNetworkId,
          );
        if (sinks.stateTarget !== undefined) sinks.stateTarget.dataset.renderEntityCount = '0';
        return;
      }
      for (const row of rows) {
        const segment = replica.readComponent(row.id, SnakeSegment);
        const position = replica.readComponent(row.id, GridPosition);
        if (segment === undefined || position === undefined) continue;
        const color = playerColors.get(Number(segment.playerNetworkId ?? 0));
        if (color === undefined) continue;
        if (hideBodyForVisualFalsification) continue;
        liveIds.add(row.id);
        let entity = renderEntities.get(row.id);
        if (entity === undefined) {
          entity = world
            .spawn(
              { component: Transform, data: { pos: [0, 0, 0], scale: [0.9, 0.9, 0.9] } },
              { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
              {
                component: MeshRenderer,
                data: { materials: [snakeBodyMaterials[color] ?? snakeBodyMaterials[0]] },
              },
            )
            .unwrap();
          renderEntities.set(row.id, entity);
        }
        world.set(entity, Transform, {
          pos: gridToWorldPosition(Number(position.x ?? 0), Number(position.y ?? 0)),
          scale: [0.9, 0.9, 0.9],
        });
      }
      if (
        localPlayerNetworkId === undefined &&
        sinks.directionCommandEvidence?.lastSendResult === 'sent' &&
        (session?.lastDirectionCommandPlayerNetworkId ?? 0) > 0
      )
        localPlayerNetworkId = session?.lastDirectionCommandPlayerNetworkId;
      if (food !== undefined && foodEntity !== undefined)
        world
          .set(foodEntity, Transform, {
            pos: gridToWorldPosition(food.x, food.y),
            scale: [0.55, 0.55, 0.55],
          })
          .unwrap();
      for (const [id, entity] of renderEntities) {
        if (!liveIds.has(id)) {
          world.despawn(entity).unwrap();
          renderEntities.delete(id);
        }
      }
      if (sinks.stateTarget !== undefined)
        renderSnakeState(
          sinks.stateTarget,
          replica.tick,
          snakes,
          food,
          session,
          localPlayerNetworkId,
        );
      if (sinks.stateTarget !== undefined)
        sinks.stateTarget.dataset.renderEntityCount = String(renderEntities.size);
    },
  });
  return renderEntities;
}

/** Assemble the browser-side replica. Replicated components are read-only here. */
export async function createClient(canvas: HTMLCanvasElement, url: string) {
  const connected = await connectWebSocketClientEndpoint(url);
  if (!connected.ok) throw connected.error;
  return createClientWithEndpoint(canvas, connected.value);
}

export async function createClientWithEndpoint(canvas: HTMLCanvasElement, endpoint: NetEndpoint) {
  const lifecycleTarget = globalThis.document?.querySelector<HTMLElement>(
    '[data-testid="snake-state"]',
  );
  if (lifecycleTarget !== null && lifecycleTarget !== undefined)
    lifecycleTarget.dataset.lifecycle = 'connecting';
  const appResult = await createApp(canvas, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) throw appResult.error;
  const app = appResult.value;
  const { world, renderer } = app;
  const built = netPlugin({ endpoint }).build(world);
  if (built instanceof Promise) throw new Error('Snake net plugin must build synchronously');
  if (!built.ok) throw built.error;
  const session = world.getResource<NetSession>('net-session');
  const replica = createReplicaCoordinator(world, snakeProfile, endpoint);
  session.attachReplica(replica, snakeProfile.limits);
  const ready = await renderer.ready;
  if (!ready.ok) throw ready.error;
  if (lifecycleTarget !== null && lifecycleTarget !== undefined) {
    lifecycleTarget.dataset.lifecycle = 'renderer-ready';
    lifecycleTarget.dataset.rendererReady = 'true';
  }
  const join = encodeCommand({ kind: 'join' });
  if (!join.ok) throw join.error;
  const joined = endpoint.send(1 as PeerId, join.value);
  if (!joined.ok) throw joined.error;
  if (lifecycleTarget !== null && lifecycleTarget !== undefined) {
    lifecycleTarget.dataset.lifecycle = 'join-sent';
    lifecycleTarget.dataset.joinSent = 'true';
    lifecycleTarget.dataset.waitingTick = '0';
  }
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 20] } },
      {
        component: Camera,
        data: orthographic({ left: -13, right: 13, bottom: -9, top: 9, near: 0.1, far: 100 }),
      },
    )
    .unwrap();
  const document = globalThis.document;
  const stateTarget =
    document?.querySelector<HTMLElement>('[data-testid="snake-state"]') ?? undefined;
  const directionCommandEvidence: DirectionCommandEvidence = { directionCommandSendCount: 0 };
  const sinks: ReplicaRenderSinks = {};
  if (stateTarget !== undefined) (sinks as { stateTarget: HTMLElement }).stateTarget = stateTarget;
  (sinks as { directionCommandEvidence: DirectionCommandEvidence }).directionCommandEvidence =
    directionCommandEvidence;
  registerReplicaDerivation(world, replica, sinks, endpoint);
  installKeyboardInput(endpoint, undefined, directionCommandEvidence);
  return { app, world, renderer, endpoint, replica, directionCommandEvidence };
}

const KEY_DIRECTIONS: Readonly<Record<string, Direction>> = {
  ArrowUp: 'up',
  ArrowRight: 'right',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  w: 'up',
  d: 'right',
  s: 'down',
  a: 'left',
};

export function installKeyboardInput(
  endpoint: NetEndpoint,
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  evidence: DirectionCommandEvidence = { directionCommandSendCount: 0 },
): () => void {
  const eventTarget = target ?? globalThis.window;
  if (eventTarget === undefined) return () => {};
  const listener = (event: KeyboardEvent): void => {
    const direction = KEY_DIRECTIONS[event.key];
    if (direction === undefined) {
      evidence.lastSendResult = 'rejected';
      return;
    }
    evidence.lastAttemptedDirection = direction;
    const encoded = encodeDirectionCommand({ direction });
    if (encoded.ok) {
      endpoint.send(1 as PeerId, encoded.value);
      evidence.directionCommandSendCount += 1;
      evidence.lastSendResult = 'sent';
    } else evidence.lastSendResult = 'rejected';
  };
  eventTarget.addEventListener('keydown', listener);
  return () => eventTarget.removeEventListener('keydown', listener);
}
