import { Context, type Plugin } from '@deepseek-ai/cordis';
import { defineTool } from '@forgeax/engine-tool-runtime';
import { describe, expect, it } from 'vitest';
import {
  CatalogLoaderError,
  defineToolPlugin,
  installCatalogLoader,
  type PluginCatalog,
  projectPluginEntries,
} from '../loader';

function catalogOf(name: string, plugin: Plugin): PluginCatalog {
  return new Map([[name, { realm: 'engine' as const, load: async () => ({ default: plugin }) }]]);
}

describe('CatalogLoader', () => {
  it('unwraps a ToolPlugin to its Cordis plugin in the build realm', async () => {
    const lifecycle: string[] = [];
    const plugin: Plugin = {
      apply(ctx: Context) {
        lifecycle.push('apply');
        ctx.effect(() => () => lifecycle.push('dispose'));
      },
    };
    const schema = { parse: (value: unknown) => ({ ok: true as const, value }) };
    const tool = defineTool(
      {
        id: 'fixture.tool',
        title: 'Fixture',
        summary: 'Fixture tool.',
        realm: 'build',
        argsSchema: schema,
        resultSchema: schema,
        evidence: [],
      },
      async (value) => value,
    );
    const ctx = new Context();
    const { loader } = await installCatalogLoader(
      ctx,
      new Map([
        [
          '@game/tools',
          { realm: 'build', load: async () => ({ default: defineToolPlugin(plugin, [tool]) }) },
        ],
      ]),
      'build',
    );
    await loader.root.update([{ id: 'tools', name: '@game/tools' }]);
    await loader.await();
    expect(lifecycle).toEqual(['apply']);
    await ctx.fiber.dispose();
    expect(lifecycle).toEqual(['apply', 'dispose']);
  });

  it('uses native DSH Entry reconciliation for enable, update, disable, and remove', async () => {
    const events: string[] = [];
    const feature: Plugin = {
      name: 'feature',
      apply(ctx: Context, config: { value: number }) {
        events.push(`apply:${config.value}`);
        ctx.effect(() => () => events.push(`dispose:${config.value}`));
      },
    };
    const ctx = new Context();
    const { loader } = await installCatalogLoader(
      ctx,
      catalogOf('@game/feature', feature),
      'engine',
    );

    await loader.root.update([{ id: 'feature', name: '@game/feature', config: { value: 1 } }]);
    expect(events).toEqual(['apply:1']);

    await loader.update('feature', { config: { value: 2 } });
    expect(events).toEqual(['apply:1', 'dispose:1', 'apply:2']);

    await loader.update('feature', { disabled: true });
    expect(events).toEqual(['apply:1', 'dispose:1', 'apply:2', 'dispose:2']);

    await loader.update('feature', { disabled: false });
    expect(events).toEqual(['apply:1', 'dispose:1', 'apply:2', 'dispose:2', 'apply:2']);

    await loader.remove('feature');
    expect(events).toEqual([
      'apply:1',
      'dispose:1',
      'apply:2',
      'dispose:2',
      'apply:2',
      'dispose:2',
    ]);
    expect([...loader.entries()]).toEqual([]);
    await ctx.fiber.dispose();
  });

  it('rolls back a failed config update to the last working Fiber', async () => {
    const active = new Set<number>();
    const feature: Plugin = {
      name: 'rollback-feature',
      apply(ctx: Context, config: { value: number; fail?: boolean }) {
        if (config.fail) throw new Error('rejected config');
        active.add(config.value);
        ctx.effect(() => () => active.delete(config.value));
      },
    };
    const ctx = new Context();
    const { loader } = await installCatalogLoader(
      ctx,
      catalogOf('@game/rollback', feature),
      'engine',
    );
    await loader.root.update([{ id: 'rollback', name: '@game/rollback', config: { value: 1 } }]);

    await expect(loader.update('rollback', { config: { value: 2, fail: true } })).rejects.toThrow(
      'failed to apply',
    );
    expect(active).toEqual(new Set([1]));
    expect(loader.resolve('rollback').options.config).toEqual({ value: 1 });
    await ctx.fiber.dispose();
  });

  it('retries a refused catalog load through the same loader without residue', async () => {
    const lifecycle = {
      healthyApply: 0,
      healthyDispose: 0,
      retryApply: 0,
      retryDispose: 0,
    };
    let refuse = true;
    let loadAttempts = 0;
    const healthy: Plugin = {
      name: 'healthy',
      apply(ctx: Context) {
        lifecycle.healthyApply += 1;
        ctx.effect(() => () => {
          lifecycle.healthyDispose += 1;
        });
      },
    };
    const retry: Plugin = {
      name: 'retry',
      apply(ctx: Context) {
        lifecycle.retryApply += 1;
        ctx.effect(() => () => {
          lifecycle.retryDispose += 1;
        });
      },
    };
    const refusal = new CatalogLoaderError(
      'plugin-catalog-missing',
      'injected retry source',
      'repair the injected catalog record',
      { name: '@game/retry', attempt: 1 },
    );
    const catalog: PluginCatalog = new Map([
      ['@game/healthy', { realm: 'engine', load: async () => ({ default: healthy }) }],
      [
        '@game/retry',
        {
          realm: 'engine',
          load: async () => {
            loadAttempts += 1;
            if (refuse) throw refusal;
            return { default: retry };
          },
        },
      ],
    ]);
    const ctx = new Context();
    const { loader, fiber: loaderFiber } = await installCatalogLoader(ctx, catalog, 'engine');

    await loader.create({ name: '@game/healthy' });
    await expect(loader.create({ name: '@game/retry' })).rejects.toMatchObject({
      cause: refusal,
    });
    expect([...loader.entries()].map((entry) => entry.options.name)).toEqual(['@game/healthy']);
    expect(lifecycle).toEqual({
      healthyApply: 1,
      healthyDispose: 0,
      retryApply: 0,
      retryDispose: 0,
    });

    refuse = false;
    const retryId = await loader.create({ name: '@game/retry' });
    await loader.await();
    expect(loadAttempts).toBe(2);
    const names = [...loader.entries()].map((entry) => entry.options.name);
    expect(names).toHaveLength(2);
    expect(names).toEqual(expect.arrayContaining(['@game/healthy', '@game/retry']));
    expect(lifecycle).toEqual({
      healthyApply: 1,
      healthyDispose: 0,
      retryApply: 1,
      retryDispose: 0,
    });

    await loader.remove(retryId);
    expect(lifecycle.retryDispose).toBe(1);
    await loaderFiber.dispose();
    await loaderFiber.dispose();
    await ctx.fiber.dispose();
    expect(lifecycle).toEqual({
      healthyApply: 1,
      healthyDispose: 1,
      retryApply: 1,
      retryDispose: 1,
    });
  });

  it('fails before activation when a module is absent or targets another realm', async () => {
    const ctx = new Context();
    const catalog: PluginCatalog = new Map([
      ['@game/host', { realm: 'host', load: async () => ({ default: () => undefined }) }],
    ]);
    const { loader } = await installCatalogLoader(ctx, catalog, 'engine');
    await expect(loader.create({ name: '@game/missing' })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'plugin-catalog-missing' }),
    });
    await expect(loader.create({ name: '@game/host' })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'plugin-realm-mismatch' }),
    });
    await ctx.fiber.dispose();
  });
});

describe('projectPluginEntries', () => {
  it('uses DSH fields and strips only the ForgeaX realm extension', () => {
    expect(
      projectPluginEntries(
        [
          { id: 'engine', name: '@game/engine', realm: 'engine', inject: ['world'] },
          { id: 'host', name: '@game/host', realm: 'host' },
        ],
        'engine',
      ),
    ).toEqual([{ id: 'engine', name: '@game/engine', inject: ['world'] }]);
  });

  it('rejects a group that tries to span physical realms', () => {
    const entries = [
      {
        id: 'mixed',
        name: 'cordis:group',
        group: true,
        realm: 'host' as const,
        config: [{ id: 'engine', name: '@game/engine', realm: 'engine' as const }],
      },
    ];
    expect(() => projectPluginEntries(entries, 'engine')).toThrow(CatalogLoaderError);
    expect(() => projectPluginEntries(entries, 'host')).toThrow(CatalogLoaderError);
  });
});
