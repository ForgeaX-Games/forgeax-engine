import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import {
  describeGamePluginSystems,
  GAMEPLAY_PRODUCER_CONTRACT,
  GAMEPLAY_PRODUCER_CONTRACT_VERSION,
  type GamePluginProducer,
  installGamePluginProducers,
  loadGamePluginModules,
} from '../index';

function descriptor(id = 'test.producer') {
  return {
    contract: GAMEPLAY_PRODUCER_CONTRACT,
    version: GAMEPLAY_PRODUCER_CONTRACT_VERSION,
    id,
    title: 'Test producer',
  } as const;
}

describe('versioned gameplay producer contract', () => {
  it('discovers a producer descriptor and installs its projection/lifecycle', async () => {
    let speed = 1;
    let reloaded = false;
    const producer: GamePluginProducer = {
      descriptor: descriptor(),
      register: ({ gameProjection, lifecycle }) => {
        const removeRead = gameProjection?.registerRead({
          id: 'test.speed',
          title: 'Speed',
          read: () => speed,
        });
        if (removeRead) lifecycle.registerCleanup(removeRead);
        lifecycle.registerReload(() => {
          speed = 2;
          reloaded = true;
        });
      },
    };
    const load = await loadGamePluginModules({
      modules: [{ clientPath: 'assets/test.plugin.ts', url: '/test.plugin.ts' }],
      importModule: async () => ({ gameplay: producer }),
    });

    expect(load.errors).toEqual([]);
    expect(load.plugins[0]?.descriptor).toEqual(descriptor());

    const projection = new Map<string, { read(): unknown }>();
    const result = await installGamePluginProducers(load, {
      world: new World(),
      gameProjection: {
        registerAction: () => () => {},
        registerRead: (read) => {
          projection.set(read.id, read);
          return () => projection.delete(read.id);
        },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(projection.get('test.speed')?.read()).toBe(1);
    expect(await result.value.reload()).toEqual({
      ok: true,
      value: { pluginId: 'test.producer', status: 'reloaded' },
    });
    expect(reloaded).toBe(true);
    expect(projection.get('test.speed')?.read()).toBe(2);
    result.value.dispose();
    expect(projection.has('test.speed')).toBe(false);
    expect((await result.value.reload()).ok).toBe(false);
  });

  it('returns a structured terminal result when registration fails', async () => {
    const producer: GamePluginProducer = {
      descriptor: descriptor('test.failure'),
      register: ({ gameProjection }) => {
        gameProjection?.registerRead({ id: 'duplicate', title: 'Duplicate', read: () => null });
        gameProjection?.registerRead({ id: 'duplicate', title: 'Duplicate', read: () => null });
      },
    };
    const load = {
      plugins: [
        {
          clientPath: 'assets/test.plugin.ts',
          url: '/test.plugin.ts',
          components: [],
          systems: [],
          descriptor: producer.descriptor,
          producer,
        },
      ],
      systems: [],
      components: [],
      errors: [],
    };
    const registered = new Set<string>();
    const result = await installGamePluginProducers(load, {
      world: new World(),
      gameProjection: {
        registerAction: () => () => {},
        registerRead: (read) => {
          if (registered.has(read.id)) throw new Error(`game projection id conflict: ${read.id}`);
          registered.add(read.id);
          return () => registered.delete(read.id);
        },
      },
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'game-plugin-registration-failed',
        pluginId: 'test.failure',
        hint: expect.stringContaining('game projection id conflict'),
      },
    });
  });

  it('rejects an unsupported descriptor version and bounds system diagnostics', async () => {
    const load = await loadGamePluginModules({
      modules: [{ clientPath: 'assets/bad.plugin.ts', url: '/bad.plugin.ts' }],
      importModule: async () => ({
        gameplay: {
          descriptor: { ...descriptor('test.bad'), version: 99 },
          register: () => {},
        },
      }),
    });
    expect(load.errors[0]?.message).toContain('unsupported gameplay producer contract version');
    expect(
      describeGamePluginSystems(
        {
          plugins: [
            {
              clientPath: 'assets/test.plugin.ts',
              url: '/test.plugin.ts',
              components: [],
              systems: ['rotate'],
            },
          ],
          systems: ['rotate'],
          components: [],
          errors: [],
        },
        ['rotate'],
      ),
    ).toEqual([{ pluginId: 'assets/test.plugin.ts', system: 'rotate', status: 'attached' }]);
  });
});
