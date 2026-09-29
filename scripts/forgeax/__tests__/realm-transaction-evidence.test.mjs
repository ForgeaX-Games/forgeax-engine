import { describe, expect, it } from 'vitest';
import { resolveRealmClosure } from '../../../packages/devkit/src/project/realm-closure.ts';
import {
  Context,
  inspectPluginFiber,
  startNativePlugin,
} from '../../../packages/plugin/src/index.ts';

const placements = ['host', 'engine-main', 'engine-worker', 'build'];

describe('native realm lifecycle evidence', () => {
  it('records native install, inspect and cleanup for every placement', async () => {
    const events = [];
    const plugin = {
      name: 'evidence-plugin',
      apply(ctx) {
        events.push('apply');
        ctx.effect(() => () => events.push('dispose'));
      },
    };

    for (const placement of placements) {
      const closure = resolveRealmClosure({
        entry: './game.ts',
        placement,
        modules: [
          { module: './game.ts', imports: ['./shared.ts'] },
          { module: './shared.ts', imports: [] },
        ],
      });
      expect(closure).toMatchObject({
        ok: true,
        value: { placement, modules: ['./game.ts', './shared.ts'] },
      });

      const context = new Context();
      const started = await startNativePlugin(context, plugin);
      expect(started.ok).toBe(true);
      if (!started.ok) throw started.error;
      expect(inspectPluginFiber(started.value)).toMatchObject({ state: 'active' });
      await started.value.dispose();
      expect(started.value.state).toBe(4);
      await context.fiber.dispose();
    }

    expect(events).toEqual([
      'apply',
      'dispose',
      'apply',
      'dispose',
      'apply',
      'dispose',
      'apply',
      'dispose',
    ]);
  });
});
