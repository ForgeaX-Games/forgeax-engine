import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type {
  ParticleSpaceResolver,
  ParticleSpaceResolverError,
  ParticleSpaceResolverInput,
  ParticleSpaceResolverResult,
} from '@forgeax/engine-vfx';
import {
  type ParticleSceneSpaceResolverOptions,
  particleSceneSpaceResolver,
} from '@forgeax/engine-vfx-render';
import { describe, expectTypeOf, it } from 'vitest';

function consumeSceneSpace(
  world: World,
  player: EntityHandle,
  joint: EntityHandle,
): ParticleSpaceResolverResult {
  const options = {
    world,
    resolveJoint: (_player: EntityHandle) => joint,
  } satisfies ParticleSceneSpaceResolverOptions;
  const resolver = particleSceneSpaceResolver(options);
  const input: ParticleSpaceResolverInput = {
    player,
    space: 'local',
    phase: 'extract',
    tick: 4,
  };
  const resolved = resolver.resolve(input);
  if (resolved.ok) {
    const source: 'root' | 'parent' | 'joint' = resolved.value.source;
    const matrix: Float32Array = resolved.value.matrix;
    void source;
    void matrix;
    return resolved;
  }
  const error: ParticleSpaceResolverError = resolved.error;
  switch (error.code) {
    case 'particle-space-parent-unavailable':
      if (error.detail.parent !== undefined) {
        const parent: number = error.detail.parent;
        void parent;
      }
      break;
    case 'particle-space-parent-failed':
      if (error.detail.joint !== undefined) {
        const failedJoint: number = error.detail.joint;
        void failedJoint;
      }
      break;
  }
  const retryPhase: 'spawn' | 'extract' = error.detail.phase;
  const retryHint: string = error.hint;
  void retryPhase;
  void retryHint;
  return resolved;
}

function consumeHeadlessContract(input: ParticleSpaceResolverInput): ParticleSpaceResolverResult {
  const resolver: ParticleSpaceResolver = {
    resolve: (_input) => ({
      ok: true,
      value: {
        space: input.space,
        phase: input.phase,
        matrix: new Float32Array(16),
        source: 'root',
      },
    }),
  };
  return resolver.resolve(input);
}

describe('scene space public type surface', () => {
  it('keeps scene and headless resolver consumers type-safe', () => {
    expectTypeOf(consumeSceneSpace).toBeFunction();
    expectTypeOf(consumeHeadlessContract).toBeFunction();
  });
});
