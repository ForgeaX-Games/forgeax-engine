import { describe, expect, it } from 'vitest';
import type {
  ParticleSimulationSpace,
  ParticleSpaceResolver,
  ParticleSpaceResolverInput,
  ParticleSpaceResolverResult,
} from '../space-resolver.js';
import { createParticleSpaceError } from '../space-resolver.js';

const rootPose = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1]);
const movedPose = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 9, 8, 7, 1]);

function poseFor(
  space: ParticleSimulationSpace,
  phase: ParticleSpaceResolverInput['phase'],
  matrix: Float32Array,
  source: 'root' | 'parent' | 'joint' = 'root',
): ParticleSpaceResolverResult {
  return {
    ok: true,
    value: { space, phase, matrix, source },
  };
}

describe('headless particle space resolver contract', () => {
  it('keeps local extraction and world spawn as distinct POD requests', () => {
    const requests: ParticleSpaceResolverInput[] = [];
    const resolver: ParticleSpaceResolver = {
      resolve(input) {
        requests.push(input);
        return poseFor(input.space, input.phase, input.phase === 'spawn' ? rootPose : movedPose);
      },
    };

    const local = resolver.resolve({ player: 3, space: 'local', phase: 'extract', tick: 2 });
    const world = resolver.resolve({ player: 3, space: 'world', phase: 'spawn', tick: 2 });

    expect(local.ok).toBe(true);
    expect(world.ok).toBe(true);
    expect(requests).toEqual([
      { player: 3, space: 'local', phase: 'extract', tick: 2 },
      { player: 3, space: 'world', phase: 'spawn', tick: 2 },
    ]);
    if (local.ok && world.ok) {
      expect(local.value.matrix).toBe(movedPose);
      expect(world.value.matrix).toBe(rootPose);
    }
  });

  it('represents a parentless root without inventing a parent handle', () => {
    const resolver: ParticleSpaceResolver = {
      resolve(input) {
        return poseFor(input.space, input.phase, rootPose, 'root');
      },
    };

    const result = resolver.resolve({ player: 4, space: 'local', phase: 'extract', tick: 1 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.source).toBe('root');
      expect(result.value.parent).toBeUndefined();
      expect(result.value.joint).toBeUndefined();
    }
  });

  it('exposes stale-parent unavailable and failed results for retry', () => {
    let repaired = false;
    const resolver: ParticleSpaceResolver = {
      resolve(input) {
        if (!repaired) {
          return {
            ok: false,
            error: createParticleSpaceError('particle-space-parent-unavailable', {
              player: input.player,
              space: input.space,
              phase: input.phase,
              parent: 9,
              reason: 'stale parent',
            }),
          };
        }
        return {
          ok: false,
          error: createParticleSpaceError('particle-space-parent-failed', {
            player: input.player,
            space: input.space,
            phase: input.phase,
            parent: 9,
            reason: 'hierarchy propagation failed',
          }),
        };
      },
    };

    const unavailable = resolver.resolve({ player: 5, space: 'local', phase: 'extract', tick: 3 });
    repaired = true;
    const failed = resolver.resolve({ player: 5, space: 'local', phase: 'extract', tick: 4 });

    expect(unavailable.ok).toBe(false);
    expect(failed.ok).toBe(false);
    if (!unavailable.ok && !failed.ok) {
      expect(unavailable.error.detail.parent).toBe(9);
      expect(failed.error.detail.reason).toContain('propagation');
    }
  });
});
