// run-plugins.test.ts -- runPlugins contract (M2 / w11, plan-strategy D-1/D-7).
//
// Covers: dedup, failure accumulation (first-failure readable + full list),
// build order, empty input, invalid (empty-name) plugin. All GREEN in M2.
//
// charter awareness:
//   P3 explicit failure: every failure path asserts a structured PluginError
//       (.code / .detail), not a thrown value or silent skip.

import { err, ok, type Result, World } from '@forgeax/engine-ecs';
import { type Plugin, PluginError } from '@forgeax/engine-plugin';
import { describe, expect, it } from 'vitest';

import { runPlugins } from '../internal/run-plugins';

function okPlugin(name: string, onBuild?: () => void): Plugin {
  return {
    name,
    build(_world: World): Result<void, PluginError> {
      onBuild?.();
      return ok(undefined);
    },
  };
}

function failPlugin(name: string, cause: string): Plugin {
  return {
    name,
    build(_world: World): Result<void, PluginError> {
      return err(
        new PluginError({
          code: 'plugin-build-failed',
          expected: 'every plugin.build(world) call must return Result.ok',
          hint: 'fix the plugin build',
          detail: { pluginName: name, cause },
        }),
      );
    },
  };
}

describe('runPlugins -- dedup (AC-04)', () => {
  it('returns duplicate-plugin when two plugins share a name (within userPlugins)', async () => {
    const world = new World();
    const result = await runPlugins(world, [], [okPlugin('audio'), okPlugin('audio')]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('duplicate-plugin');
    if (result.error.code !== 'duplicate-plugin') return;
    expect(result.error.detail.name).toBe('audio');
  });

  it('returns duplicate-plugin when a user plugin collides with the default set', async () => {
    const world = new World();
    const result = await runPlugins(world, [okPlugin('input')], [okPlugin('input')]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('duplicate-plugin');
    if (result.error.code !== 'duplicate-plugin') return;
    expect(result.error.detail.name).toBe('input');
  });
});

describe('runPlugins -- failure accumulation (AC-05 / D-7)', () => {
  it('accumulates one failure (ok, fail, ok) with first-failure readable', async () => {
    const world = new World();
    const result = await runPlugins(
      world,
      [],
      [okPlugin('a'), failPlugin('b', 'WASM load failed'), okPlugin('c')],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('plugin-build-failed');
    if (result.error.code !== 'plugin-build-failed') return;
    expect(result.error.detail.pluginName).toBe('b');
    expect(result.error.detail.cause).toBe('WASM load failed');
    expect(result.error.detail.failures).toHaveLength(1);
    expect(result.error.detail.failures?.[0]?.pluginName).toBe('b');
    expect(result.error.detail.failures?.[0]?.cause).toBe('WASM load failed');
  });

  it('accumulates all failures (fail, fail) without short-circuiting', async () => {
    const world = new World();
    const result = await runPlugins(
      world,
      [],
      [failPlugin('x', 'boom-x'), failPlugin('y', 'boom-y')],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('plugin-build-failed');
    if (result.error.code !== 'plugin-build-failed') return;
    // first failure is the readable one (AC-05 lower bound)
    expect(result.error.detail.pluginName).toBe('x');
    expect(result.error.detail.failures).toHaveLength(2);
    expect(result.error.detail.failures?.map((f) => f.pluginName)).toEqual(['x', 'y']);
  });
});

describe('runPlugins -- build order', () => {
  it('calls build in merged array order (default set first, then user)', async () => {
    const world = new World();
    const calls: string[] = [];
    const result = await runPlugins(
      world,
      [okPlugin('d1', () => calls.push('d1')), okPlugin('d2', () => calls.push('d2'))],
      [okPlugin('u1', () => calls.push('u1'))],
    );
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['d1', 'd2', 'u1']);
  });
});

describe('runPlugins -- empty input', () => {
  it('returns ok(empty Map) for defaultSet=[] and userPlugins=[]', async () => {
    const world = new World();
    const result = await runPlugins(world, [], []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.size).toBe(0);
  });

  it('returns ok(Map) populated with every plugin name on success', async () => {
    const world = new World();
    const result = await runPlugins(world, [okPlugin('transform')], [okPlugin('physics')]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value.keys()]).toEqual(['transform', 'physics']);
  });
});

describe('runPlugins -- invalid name', () => {
  it('returns plugin-build-failed when a plugin name is empty', async () => {
    const world = new World();
    const result = await runPlugins(world, [], [okPlugin('')]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('plugin-build-failed');
  });
});
