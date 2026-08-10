import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { World } from '@forgeax/engine-ecs';
import { BarrierRoute, resolveBarrierImpact } from '../assets/plugins/barrier-route.js';

describe('game-default charged barrier route', () => {
  it('starts dormant until the existing relay unlocks it', () => {
    const world = new World();
    const emitter = world.spawn({ component: BarrierRoute, data: {} }).unwrap();

    expect(world.get(emitter, BarrierRoute).unwrap()).toEqual({
      active: false,
      opens: 0,
      ordinaryHits: 0,
      alreadyOpenHits: 0,
    });
  });

  it('opens exactly once only for a real charged projectile impact', () => {
    expect(resolveBarrierImpact({ active: true, projectileContact: false, impactScale: 2 })).toBe('non-projectile');
    expect(resolveBarrierImpact({ active: true, projectileContact: true, impactScale: 1 })).toBe('ordinary');
    expect(resolveBarrierImpact({ active: true, projectileContact: true, impactScale: 1.01 })).toBe('open');
    expect(resolveBarrierImpact({ active: false, projectileContact: true, impactScale: 2 })).toBe('already-open');
  });

  it('authors one stable emitter and barrier guarding EnergyCoreAlpha', () => {
    const pack = JSON.parse(readFileSync(new URL('../assets/scene.pack.json', import.meta.url), 'utf8')) as {
      assets: Array<{
        guid: string;
        payload: { entities?: Array<{ localId: number; components: Record<string, Record<string, unknown>> }> };
      }>;
    };
    const scene = pack.assets.find((asset) => asset.guid === '1036f6f0-d3c2-5f31-9593-3432942d4c93');
    const emitter = scene?.payload.entities?.find((entity) => entity.components.Name?.value === 'BarrierEmitter');
    const barrier = scene?.payload.entities?.find((entity) => entity.components.Name?.value === 'EnergyBarrier');

    expect(emitter).toMatchObject({
      localId: 33,
      components: { Transform: { pos: [-4.2, 0.7, -1.5] } },
    });
    expect(barrier).toMatchObject({
      localId: 34,
      components: { Transform: { pos: [-2.5, 0.9, -1.5], scale: [3.4, 1.8, 0.16] } },
    });
  });
});
