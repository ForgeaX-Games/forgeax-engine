import { FixedTime, FixedUpdate, Time, Update, defineComponent, type EntityHandle, type World } from '@forgeax/engine/ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine/input';
import { quat, vec3 } from '@forgeax/engine/math';
import { CharacterController, type PhysicsWorld } from '@forgeax/engine/physics';
import type { Plugin } from '@forgeax/engine/plugin';
import { Name, Transform } from '@forgeax/engine/scene';
import { SceneInstance } from '@forgeax/engine/render';

const MOVE_SPEED = 5.5;
const JUMP_SPEED = 6.25;
const GRAVITY = 17;
const CAMERA_DISTANCE = 6.5;
const CAMERA_HEIGHT = 3;
const CAMERA_FOLLOW = 8;
const CAMERA_SETTLE_DISTANCE = 0.01;

const ThirdPersonMotor = defineComponent(
  'Game3dThirdPersonMotor',
  {
    verticalVelocity: { type: 'f32', default: 0 },
    facingX: { type: 'f32', default: 0 },
    facingZ: { type: 'f32', default: -1 },
  },
  { transient: true },
);

/**
 * The host loads forge.json#defaultScene before activating this plugin.
 * Add game-specific systems here without creating a second scene owner.
 */
const game3d: Plugin = {
  name: 'game-3d',
  inject: ['world', 'gameHost'],
  apply(ctx) {
    const host = ctx.gameHost;
    if (host === undefined) throw new Error('game-3d requires the App-owned GameHost');

    const player = sceneEntityByName(ctx.world, host, 'Player');
    const camera = sceneEntityByName(ctx.world, host, 'Main Camera');
    const lease = ctx.world.components.register(ThirdPersonMotor).unwrap();
    ctx.world.addComponent(player, { component: ThirdPersonMotor, data: {} }).unwrap();

    installMovement(ctx.world, player, camera);
    installFollowCamera(ctx.world, player, camera);

    const unregisterRead = host.gameProjection?.registerRead({
      id: 'game-3d.player',
      title: 'Third-person player state',
      description: 'Resolved player position, facing, and grounded state.',
      read: () => {
        const transform = ctx.world.get(player, Transform).unwrap();
        const motor = ctx.world.get(player, ThirdPersonMotor).unwrap();
        const controller = ctx.world.get(player, CharacterController).unwrap();
        return {
          position: Array.from(transform.pos),
          facing: [motor.facingX, motor.facingZ],
          grounded: controller.grounded,
        };
      },
    });

    ctx.effect(function* () {
      if (unregisterRead !== undefined) yield unregisterRead;
      yield () => ctx.world.removeSystem(Update, 'game-3d-camera-follow').unwrap();
      yield () => ctx.world.removeSystem(FixedUpdate, 'game-3d-player-movement').unwrap();
      yield () => ctx.world.removeComponent(player, ThirdPersonMotor).unwrap();
      yield () => lease.dispose().unwrap();
    }, 'game-3d/third-person');
  },
};

export default game3d;

type SceneHost = NonNullable<import('@forgeax/engine/app').GameHost>;

function sceneEntityByName(world: World, host: SceneHost, wanted: string): EntityHandle {
  if (host.defaultSceneRoot === undefined || host.defaultScene === undefined) {
    throw new Error(`game-3d default scene is unavailable while resolving ${wanted}`);
  }
  const instance = world.get(host.defaultSceneRoot, SceneInstance).unwrap();
  const authored = host.defaultScene.entities.find(
    (entity) => (entity.components[Name.name] as { value?: string } | undefined)?.value === wanted,
  );
  if (authored === undefined) throw new Error(`game-3d scene has no ${wanted} entity`);
  const entity = instance.mapping[authored.localId];
  if (entity === undefined || entity === 0 || entity === 0xffff_ffff) {
    throw new Error(`game-3d scene did not instantiate ${wanted}`);
  }
  return entity as EntityHandle;
}

function installMovement(world: World, player: EntityHandle, camera: EntityHandle): void {
  world.addSystem(FixedUpdate, {
    name: 'game-3d-player-movement',
    queries: [],
    fn: () => {
      if (!world.hasResource('PhysicsWorld')) return;
      const physics = world.getResource<PhysicsWorld>('PhysicsWorld');
      if (!physics.hasBody(player)) return;

      const input = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      const dt = world.getResource(FixedTime).delta;
      const playerTransform = world.get(player, Transform).unwrap();
      const cameraTransform = world.get(camera, Transform).unwrap();
      const motor = world.get(player, ThirdPersonMotor).unwrap();
      const controller = world.get(player, CharacterController).unwrap();

      const horizontal =
        Number(input.keyboard.downCode('KeyD') || input.keyboard.downCode('ArrowRight')) -
        Number(input.keyboard.downCode('KeyA') || input.keyboard.downCode('ArrowLeft'));
      const vertical =
        Number(input.keyboard.downCode('KeyW') || input.keyboard.downCode('ArrowUp')) -
        Number(input.keyboard.downCode('KeyS') || input.keyboard.downCode('ArrowDown'));
      const cameraToPlayerX = (playerTransform.pos[0] ?? 0) - (cameraTransform.pos[0] ?? 0);
      const cameraToPlayerZ = (playerTransform.pos[2] ?? 0) - (cameraTransform.pos[2] ?? 0);
      const cameraForwardLength = Math.hypot(cameraToPlayerX, cameraToPlayerZ) || 1;
      const forwardX = cameraToPlayerX / cameraForwardLength;
      const forwardZ = cameraToPlayerZ / cameraForwardLength;
      const rightX = -forwardZ;
      const rightZ = forwardX;
      let moveX = forwardX * vertical + rightX * horizontal;
      let moveZ = forwardZ * vertical + rightZ * horizontal;
      const moveLength = Math.hypot(moveX, moveZ);
      if (moveLength > 1) {
        moveX /= moveLength;
        moveZ /= moveLength;
      }

      let verticalVelocity = motor.verticalVelocity;
      const grounded = controller.grounded === true;
      if (grounded && input.keyboard.justPressedCode('Space')) verticalVelocity = JUMP_SPEED;
      verticalVelocity -= GRAVITY * dt;
      if (grounded && verticalVelocity < 0) verticalVelocity = -GRAVITY * dt;

      physics.moveAndSlide(
        player,
        vec3.create(moveX * MOVE_SPEED * dt, verticalVelocity * dt, moveZ * MOVE_SPEED * dt),
      );

      const groundedAfter = world.get(player, CharacterController).unwrap().grounded === true;
      if (groundedAfter && verticalVelocity < 0) verticalVelocity = 0;
      if (moveLength > 0.001) {
        const rotation = quat.eulerY(Math.atan2(-moveX, -moveZ));
        world.set(player, Transform, {
          quat: [rotation[0] ?? 0, rotation[1] ?? 0, rotation[2] ?? 0, rotation[3] ?? 1],
        }).unwrap();
      }
      world.set(player, ThirdPersonMotor, {
        verticalVelocity,
        ...(moveLength > 0.001 ? { facingX: moveX, facingZ: moveZ } : {}),
      }).unwrap();
    },
  }).unwrap();
}

function installFollowCamera(world: World, player: EntityHandle, camera: EntityHandle): void {
  world.addSystem(Update, {
    name: 'game-3d-camera-follow',
    after: [FixedUpdate],
    queries: [],
    fn: () => {
      const dt = world.getResource(Time).delta;
      const playerTransform = world.get(player, Transform).unwrap();
      const cameraTransform = world.get(camera, Transform).unwrap();
      const motor = world.get(player, ThirdPersonMotor).unwrap();
      const px = playerTransform.pos[0] ?? 0;
      const py = playerTransform.pos[1] ?? 0;
      const pz = playerTransform.pos[2] ?? 0;
      const desiredX = px - motor.facingX * CAMERA_DISTANCE;
      const desiredY = py + CAMERA_HEIGHT;
      const desiredZ = pz - motor.facingZ * CAMERA_DISTANCE;
      if (
        Math.max(
          Math.abs(desiredX - (cameraTransform.pos[0] ?? desiredX)),
          Math.abs(desiredY - (cameraTransform.pos[1] ?? desiredY)),
          Math.abs(desiredZ - (cameraTransform.pos[2] ?? desiredZ)),
        ) < CAMERA_SETTLE_DISTANCE
      ) {
        return;
      }
      const amount = 1 - Math.exp(-CAMERA_FOLLOW * dt);
      const position = [
        (cameraTransform.pos[0] ?? desiredX) + (desiredX - (cameraTransform.pos[0] ?? desiredX)) * amount,
        (cameraTransform.pos[1] ?? desiredY) + (desiredY - (cameraTransform.pos[1] ?? desiredY)) * amount,
        (cameraTransform.pos[2] ?? desiredZ) + (desiredZ - (cameraTransform.pos[2] ?? desiredZ)) * amount,
      ] as const;
      const target = [px, py + 0.45, pz] as const;
      const rotation = quat.fromLookAt(quat.create(), position, target, [0, 1, 0]);
      world.set(camera, Transform, {
        pos: position,
        quat: [rotation[0] ?? 0, rotation[1] ?? 0, rotation[2] ?? 0, rotation[3] ?? 1],
      }).unwrap();
    },
  }).unwrap();
}
