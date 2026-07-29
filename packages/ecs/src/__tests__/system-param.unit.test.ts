import { describe, expect, it } from 'vitest';
import { defineComponent, defineSystemParam, Entity, Update, World } from '../index';

const Player = defineComponent('SystemParamPlayer', {});
const PLAYER_COUNT = 'systemParamPlayerCount';

describe('system parameters', () => {
  it('resolves a reusable query/resource bundle as a typed system argument', () => {
    const PlayerCounter = defineSystemParam({
      name: 'player-counter',
      queries: [{ with: [Player, Entity] }],
      resources: [PLAYER_COUNT],
      resolve: (world, queryResults) => ({
        playerCount:
          queryResults[0]?.reduce((count, bundle) => count + bundle.Entity.self.length, 0) ?? 0,
        resource: world.getResource<{ value: number }>(PLAYER_COUNT),
      }),
    });

    const world = new World();
    world.insertResource(PLAYER_COUNT, { value: 0 });
    world.spawn({ component: Player, data: {} }).unwrap();
    world.spawn({ component: Player, data: {} }).unwrap();
    const observed: number[] = [];
    world.addSystem(Update, {
      name: 'count-players',
      queries: [],
      params: [PlayerCounter],
      fn: (_world, _queryResults, _commands, [counter]) => {
        counter.resource.value = counter.playerCount;
        observed.push(counter.playerCount);
      },
    });

    expect(world.update(0).ok).toBe(true);
    expect(world.update(0).ok).toBe(true);
    expect(observed).toEqual([2, 2]);
    expect(world.getResource<{ value: number }>(PLAYER_COUNT).value).toBe(2);
  });

  it('validates parameter resources before resolving or running the system', () => {
    let resolved = false;
    let ran = false;
    const MissingResourceParam = defineSystemParam({
      name: 'missing-resource-param',
      queries: [],
      resources: ['missing-system-param-resource'],
      resolve: () => {
        resolved = true;
        return undefined;
      },
    });

    const world = new World();
    const errors: unknown[] = [];
    world.setErrorHandler((error: unknown) => {
      errors.push(error);
    });
    world.addSystem(Update, {
      name: 'missing-resource-system',
      queries: [],
      params: [MissingResourceParam],
      fn: () => {
        ran = true;
      },
    });

    const result = world.update(0);

    expect(result.ok).toBe(true);
    expect(resolved).toBe(false);
    expect(ran).toBe(false);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain('missing-system-param-resource');
  });
});
