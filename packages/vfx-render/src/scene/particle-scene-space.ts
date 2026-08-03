import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import {
  createParticleSpaceError,
  type ParticleSpacePose,
  type ParticleSpaceResolver,
  type ParticleSpaceResolverInput,
  type ParticleSpaceResolverResult,
} from '@forgeax/engine-vfx';

export interface ParticleSceneSpaceResolverOptions {
  readonly world: World;
  readonly resolveJoint?: (player: EntityHandle) => EntityHandle | undefined;
}

export function particleSceneSpaceResolver(
  options: ParticleSceneSpaceResolverOptions,
): ParticleSpaceResolver {
  return {
    resolve: (input) => resolveParticleSceneSpace(options, input),
  };
}

function resolveParticleSceneSpace(
  options: ParticleSceneSpaceResolverOptions,
  input: ParticleSpaceResolverInput,
): ParticleSpaceResolverResult {
  const player = input.player as EntityHandle;
  const playerPose = options.world.get(player, Transform);
  if (!playerPose.ok) {
    return unavailable(input, player, playerPose.error.code);
  }
  const joint =
    input.joint === undefined ? options.resolveJoint?.(player) : (input.joint as EntityHandle);
  if (joint !== undefined) {
    const pose = options.world.get(joint, Transform);
    if (!pose.ok) return unavailable(input, joint, pose.error.code, joint);
    return okPose(input, pose.value.world, 'joint', undefined, joint);
  }
  const parent = options.world.get(player, ChildOf);
  if (!parent.ok) {
    if (parent.error.code === 'component-not-present') {
      return okPose(input, playerPose.value.world, 'root');
    }
    return failed(input, player, parent.error.code);
  }
  const parentEntity = parent.value.parent;
  if (parentEntity === null) return failed(input, player, 'parent relation has no entity');
  const pose = options.world.get(parentEntity, Transform);
  if (!pose.ok) return unavailable(input, parentEntity, pose.error.code, parentEntity);
  return okPose(input, pose.value.world, 'parent', parentEntity);
}

function okPose(
  input: ParticleSpaceResolverInput,
  matrix: Float32Array,
  source: ParticleSpacePose['source'],
  parent?: EntityHandle,
  joint?: EntityHandle,
): ParticleSpaceResolverResult {
  return {
    ok: true,
    value: {
      space: input.space,
      phase: input.phase,
      matrix: new Float32Array(matrix),
      source,
      ...(parent === undefined ? {} : { parent }),
      ...(joint === undefined ? {} : { joint }),
    },
  };
}

function unavailable(
  input: ParticleSpaceResolverInput,
  parent: EntityHandle,
  reason: string,
  joint?: EntityHandle,
): ParticleSpaceResolverResult {
  return {
    ok: false,
    error: createParticleSpaceError('particle-space-parent-unavailable', {
      player: input.player,
      space: input.space,
      phase: input.phase,
      parent,
      ...(joint === undefined ? {} : { joint }),
      reason,
    }),
  };
}

function failed(
  input: ParticleSpaceResolverInput,
  parent: EntityHandle,
  reason: string,
): ParticleSpaceResolverResult {
  return {
    ok: false,
    error: createParticleSpaceError('particle-space-parent-failed', {
      player: input.player,
      space: input.space,
      phase: input.phase,
      parent,
      reason,
    }),
  };
}
