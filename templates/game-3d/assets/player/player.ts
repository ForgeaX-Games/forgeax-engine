import { AnimatedBy, AnimationPlayer, AnimationTargetId, bindAnimationTargets } from '@forgeax/engine/animation';
import {
  defineComponent,
  FixedTime,
  FixedUpdate,
  type EntityHandle,
  type World,
} from '@forgeax/engine/ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine/input';
import { quat, vec3 } from '@forgeax/engine/math';
import { CharacterController, type PhysicsWorld } from '@forgeax/engine/physics';
import type { Plugin } from '@forgeax/engine/plugin';
import { Transform } from '@forgeax/engine/scene';
import type { AnimationClip } from '@forgeax/engine/types';
import { cameraRelativeMove, facingYaw } from '../camera/third-person.ts';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { resolveGameEntity, type GameScene } from '../shared/scene-refs.ts';
import { PLAYER_JOINT_NAMES } from './player-rig.ts';

const CAMERA_TARGET_HEIGHT = 0.5;

export const ThirdPersonRig = defineComponent(
  'Game3dThirdPersonRig',
  {
    verticalVelocity: { type: 'f32', default: 0 },
    yaw: { type: 'f32', default: 0 },
    pitch: { type: 'f32', default: (20 * Math.PI) / 180 },
    focusX: { type: 'f32', default: 0 },
    focusY: { type: 'f32', default: 0 },
    focusZ: { type: 'f32', default: 0 },
    facingX: { type: 'f32', default: 0 },
    facingZ: { type: 'f32', default: -1 },
  },
  { transient: true },
);

export interface Game3dPlayerService {
  readonly entity: EntityHandle;
  readonly readRig: () => {
    readonly yaw: number;
    readonly pitch: number;
    readonly focusX: number;
    readonly focusY: number;
    readonly focusZ: number;
  };
  readonly updateRig: (patch: {
    readonly yaw: number;
    readonly pitch: number;
    readonly focusX: number;
    readonly focusY: number;
    readonly focusZ: number;
  }) => void;
}

declare module '@forgeax/engine/plugin' {
  interface EngineContextServices {
    game3dPlayer: Game3dPlayerService;
  }
}

type SceneHost = NonNullable<import('@forgeax/engine/app').GameHost>;

interface PlayerConfig {
  readonly speed: number;
  readonly jumpSpeed: number;
  readonly gravity: number;
  readonly walk: string;
}
const playerPlugin: Plugin.Object<PlayerConfig> = {
  name: 'game-3d/player',
  provide: 'game3dPlayer',
  inject: ['world', 'physics', 'gameHost', 'gameScene'],
  async apply(ctx, config) {
    const host = ctx.gameHost;
    if (host === undefined) throw new Error('game-3d/player requires the App-owned GameHost');
    const player = resolveGameEntity(ctx.world, ctx.gameScene, 'player');
    const playerTransform = ctx.world.get(player, Transform).unwrap();
    await ctx.effect(async function* () {
      const lease = ctx.world.components.register(ThirdPersonRig).unwrap();
      yield () => lease.dispose().unwrap();
      ctx.world
        .addComponent(player, {
          component: ThirdPersonRig,
          data: {
            focusX: playerTransform.pos[0] ?? 0,
            focusY: (playerTransform.pos[1] ?? 0) + CAMERA_TARGET_HEIGHT,
            focusZ: playerTransform.pos[2] ?? 0,
          },
        })
        .unwrap();
      yield () => ctx.world.removeComponent(player, ThirdPersonRig).unwrap();
      const playerService: Game3dPlayerService = {
        entity: player,
        readRig: () => {
          const rig = ctx.world.get(player, ThirdPersonRig).unwrap();
          return {
            yaw: rig.yaw,
            pitch: rig.pitch,
            focusX: rig.focusX,
            focusY: rig.focusY,
            focusZ: rig.focusZ,
          };
        },
        updateRig: (patch) => {
          ctx.world.set(player, ThirdPersonRig, patch).unwrap();
        },
      };
      yield* installWalkAnimation(ctx.world, host, ctx.gameScene, player, config.walk);
      installMovement(ctx.world, player, config);
      yield () => ctx.world.removeSystem(FixedUpdate, 'game-3d-player-movement').unwrap();
      const unregisterRead = host.gameProjection?.registerRead({
        id: 'game-3d.player',
        title: 'Third-person player state',
        description: 'Resolved physics position, camera angles, facing, and grounded state.',
        read: () => {
          const transform = ctx.world.get(player, Transform).unwrap();
          const rig = ctx.world.get(player, ThirdPersonRig).unwrap();
          const controller = ctx.world.get(player, CharacterController).unwrap();
          const animation = ctx.world.get(player, AnimationPlayer).unwrap();
          const input = ctx.world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
          return {
            position: Array.from(transform.pos),
            facing: [rig.facingX, rig.facingZ],
            camera: { yaw: rig.yaw, pitch: rig.pitch, pointerLocked: input.mouse.pointerLocked },
            grounded: controller.grounded,
            simulation: { fixedTick: ctx.world.getResource(FixedTime).tick },
            animation: { walkWeight: animation.weights[0] ?? 0, walkTime: animation.times[0] ?? 0 },
          };
        },
      });
      if (unregisterRead !== undefined) yield unregisterRead;
      ctx.provide('game3dPlayer', playerService);
    }, 'game-3d/player');
  },
};

export default playerPlugin;

async function* installWalkAnimation(
  world: World,
  host: SceneHost,
  scene: GameScene,
  player: EntityHandle,
  walk: string,
): AsyncGenerator<() => void, void, void> {
  const parsedWalk = AssetGuid.parse(walk);
  if (!parsedWalk.ok) throw parsedWalk.error;
  const playerWalk = parsedWalk.value;
  const loaded = await host.assets.loadByGuid<AnimationClip>(playerWalk);
  if (!loaded.ok) throw loaded.error;
  const clip = world.allocSharedRef('AnimationClip', loaded.value);
  yield () => {
    world.sharedRefs.release(clip).unwrap();
  };
  world
    .addComponent(player, {
      component: AnimationPlayer,
      data: { clips: [clip], times: [0], weights: [0], speeds: [1] },
    })
    .unwrap();
  yield () => {
    world.removeComponent(player, AnimationPlayer).unwrap();
  };
  const targets = PLAYER_JOINT_NAMES.map((name) =>
    resolveGameEntity(world, scene, `player/joint/${name}`),
  );
  // Binding can add IDs and relationships to borrowed scene entities. Only
  // remove the contributions introduced here, including a partial bind.
  const newIds = targets.filter((target) => !world.get(target, AnimationTargetId).ok);
  const newBindings = targets.filter((target) => !world.get(target, AnimatedBy).ok);
  yield () => {
    for (const target of newBindings) {
      if (world.get(target, AnimatedBy).ok) world.removeComponent(target, AnimatedBy).unwrap();
    }
    for (const target of newIds) {
      if (world.get(target, AnimationTargetId).ok)
        world.removeComponent(target, AnimationTargetId).unwrap();
    }
  };
  const bound = bindAnimationTargets(world, player, targets);
  if (!bound.ok) throw bound.error;
}

function installMovement(world: World, player: EntityHandle, config: PlayerConfig): void {
  world
    .addSystem(FixedUpdate, {
      name: 'game-3d-player-movement',
      queries: [],
      fn: () => {
        if (!world.hasResource('PhysicsWorld')) return;
        const physics = world.getResource<PhysicsWorld>('PhysicsWorld');
        if (!physics.hasBody(player)) return;
        const input = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
        const dt = world.getResource(FixedTime).delta;
        const rig = world.get(player, ThirdPersonRig).unwrap();
        const controller = world.get(player, CharacterController).unwrap();
        const horizontal =
          Number(input.keyboard.downCode('KeyD') || input.keyboard.downCode('ArrowRight')) -
          Number(input.keyboard.downCode('KeyA') || input.keyboard.downCode('ArrowLeft'));
        const vertical =
          Number(input.keyboard.downCode('KeyW') || input.keyboard.downCode('ArrowUp')) -
          Number(input.keyboard.downCode('KeyS') || input.keyboard.downCode('ArrowDown'));
        const move = cameraRelativeMove(rig.yaw, horizontal, vertical);
        let verticalVelocity = rig.verticalVelocity;
        if (controller.grounded && input.keyboard.justPressedCode('Space'))
          verticalVelocity = config.jumpSpeed;
        verticalVelocity -= config.gravity * dt;
        if (controller.grounded && verticalVelocity < 0) verticalVelocity = -config.gravity * dt;
        physics.moveAndSlide(
          player,
          vec3.create(
            move.x * config.speed * dt,
            verticalVelocity * dt,
            move.z * config.speed * dt,
          ),
        );
        if (world.get(player, CharacterController).unwrap().grounded && verticalVelocity < 0)
          verticalVelocity = 0;
        if (move.length > 0.001) {
          const rotation = quat.eulerY(facingYaw(move.x, move.z));
          world
            .set(player, Transform, {
              quat: [rotation[0] ?? 0, rotation[1] ?? 0, rotation[2] ?? 0, rotation[3] ?? 1],
            })
            .unwrap();
        }
        world
          .set(player, ThirdPersonRig, {
            verticalVelocity,
            ...(move.length > 0.001 ? { facingX: move.x, facingZ: move.z } : {}),
          })
          .unwrap();
        world.set(player, AnimationPlayer, { weights: [move.length > 0.001 ? 1 : 0] }).unwrap();
      },
    })
    .unwrap();
}
