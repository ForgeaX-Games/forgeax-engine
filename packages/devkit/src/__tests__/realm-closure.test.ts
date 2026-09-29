import { Context, inspectPluginFiber, startNativePlugin } from '@forgeax/engine-plugin';
import { describe, expect, it } from 'vitest';
import { resolveRealmClosure } from '../project/realm-closure.js';

const placements = ['host', 'frontend', 'engine-main', 'engine-worker', 'build'] as const;

function moduleGraph() {
  return [
    { module: './root.ts', imports: ['./feature.ts'] },
    { module: './feature.ts', imports: ['./shared.ts'] },
    { module: './shared.ts', imports: [] },
  ];
}

describe('realm closure', () => {
  it('starts, inspects, and disposes a native root in every placement', async () => {
    const events: string[] = [];
    const plugin = {
      name: 'placement-probe',
      apply(ctx: Context) {
        events.push('apply');
        ctx.effect(() => () => events.push('dispose'));
      },
    };

    for (const _placement of placements) {
      const context = new Context();
      const started = await startNativePlugin(context, plugin, undefined);
      expect(started.ok).toBe(true);
      if (!started.ok) throw started.error;
      expect(inspectPluginFiber(started.value)).toMatchObject({
        name: 'placement-probe',
        state: 'active',
        missingServices: [],
      });
      await started.value.dispose();
      await context.fiber.dispose();
    }

    expect(events).toEqual(placements.flatMap(() => ['apply', 'dispose']));
  });

  it('accepts one normalized graph in each physical placement', () => {
    for (const placement of placements) {
      const closure = resolveRealmClosure({
        entry: './root.ts',
        placement,
        modules: moduleGraph(),
      });

      expect(closure).toMatchObject({
        ok: true,
        value: {
          placement,
          modules: ['./root.ts', './feature.ts', './shared.ts'],
        },
      });
    }
  });

  it('returns the shortest chain for a multi-hop forbidden edge', () => {
    const closure = resolveRealmClosure({
      entry: './root.ts',
      placement: 'host',
      modules: [
        { module: './root.ts', imports: ['./feature.ts'] },
        { module: './feature.ts', imports: ['./renderer.ts'] },
        { module: './renderer.ts', imports: ['@forgeax/engine/app'] },
      ],
      realms: { '@forgeax/engine/app': 'engine' },
    });

    expect(closure).toMatchObject({
      ok: false,
      error: {
        code: 'realm-import-forbidden',
        detail: {
          chain: ['./root.ts', './feature.ts', './renderer.ts', '@forgeax/engine/app'],
          from: 'host',
          to: 'engine',
        },
      },
    });
  });

  it('fails closed for an unresolved import without evaluating project code', () => {
    const closure = resolveRealmClosure({
      entry: './root.ts',
      placement: 'engine-main',
      modules: [{ module: './root.ts', imports: ['./missing.ts'] }],
    });

    expect(closure).toMatchObject({
      ok: false,
      error: {
        code: 'realm-import-unresolved',
        detail: { chain: ['./root.ts', './missing.ts'] },
      },
    });
  });
});
