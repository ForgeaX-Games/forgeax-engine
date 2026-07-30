import { ok, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import {
  definePluginGroup,
  runPlugins,
  type Plugin,
} from '../src/index';

function plugin(name: string, calls: string[]): Plugin {
  return {
    name,
    build() {
      calls.push(name);
      return ok(undefined);
    },
  };
}

describe('PluginGroup', () => {
  it('preserves group order through the ordinary plugin runner', async () => {
    const calls: string[] = [];
    const group = definePluginGroup('hello-world', (builder) => {
      builder.add(plugin('hello', calls)).add(plugin('world', calls));
    });

    const result = await runPlugins(new World(), [], [group]);

    expect(result.ok).toBe(true);
    expect(calls).toEqual(['hello', 'world']);
    expect(result.ok && [...result.value.keys()]).toEqual(['hello', 'world']);
  });

  it('supports disabling and reordering members before the snapshot', () => {
    const calls: string[] = [];
    const group = definePluginGroup('configured', (builder) => {
      builder
        .add(plugin('world', calls))
        .add(plugin('hello', calls))
        .add(plugin('unused', calls))
        .disable('unused')
        .addBefore('world', plugin('before-world', calls))
        .addAfter('hello', plugin('after-hello', calls));
    });

    expect(group.plugins.map((entry) => entry.name)).toEqual([
      'before-world',
      'world',
      'hello',
      'after-hello',
    ]);
    expect(Object.isFrozen(group)).toBe(true);
    expect(Object.isFrozen(group.plugins)).toBe(true);
  });
});
