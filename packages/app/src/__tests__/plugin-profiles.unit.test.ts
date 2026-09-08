import type { AudioBackend } from '@forgeax/engine-audio';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { type InputBackend, ownedInputBackendPlugin } from '@forgeax/engine-input';
import { Context, type Plugin } from '@forgeax/engine-plugin';
import type { Renderer } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';
import { assembledEngineProfile } from '../internal/assembled-engine-profile';
import { mainEngineProfile } from '../internal/main-engine-profile';
import { remoteServerPlugin } from '../internal/remote-server-plugin';
import { workerEngineProfile } from '../internal/worker-engine-profile';
import { ownedRendererPlugin } from '../renderer-plugin';

interface PluginMetadata {
  readonly name?: string;
  readonly inject?: readonly string[] | Readonly<Record<string, unknown>>;
  readonly provide?: string | readonly string[];
}

function metadata(plugin: Plugin): PluginMetadata {
  return plugin as PluginMetadata;
}

function names(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  return typeof value === 'string' ? [value] : value;
}

function injects(value: PluginMetadata['inject']): readonly string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : Object.keys(value);
}

function expectDag(profile: readonly Plugin[], roots: readonly string[]): void {
  const providers = new Map<string, number>();
  for (const root of roots) providers.set(root, -1);
  for (const [index, plugin] of profile.entries()) {
    for (const service of names(metadata(plugin).provide)) {
      expect(providers.has(service), `duplicate provider for ${service}`).toBe(false);
      providers.set(service, index);
    }
  }

  const outgoing = profile.map(() => new Set<number>());
  const indegree = profile.map(() => 0);
  for (const [consumer, plugin] of profile.entries()) {
    for (const service of injects(metadata(plugin).inject)) {
      const provider = providers.get(service);
      expect(
        provider,
        `${metadata(plugin).name ?? consumer} requires ${service}`,
      ).not.toBeUndefined();
      expect(
        provider === consumer,
        `${metadata(plugin).name ?? consumer} provides and requires ${service}`,
      ).toBe(false);
      if (provider === undefined || provider < 0) continue;
      if (outgoing[provider]?.has(consumer)) continue;
      outgoing[provider]?.add(consumer);
      indegree[consumer] = (indegree[consumer] ?? 0) + 1;
    }
  }

  const ready = indegree.flatMap((degree, index) => (degree === 0 ? [index] : []));
  let visited = 0;
  while (ready.length > 0) {
    const current = ready.shift();
    if (current === undefined) break;
    visited += 1;
    for (const consumer of outgoing[current] ?? []) {
      indegree[consumer] = (indegree[consumer] ?? 0) - 1;
      if (indegree[consumer] === 0) ready.push(consumer);
    }
  }
  expect(visited, 'built-in profile dependency cycle').toBe(profile.length);
}

const renderer = { assets: {} } as unknown as Renderer;
const input = { sample: () => ({}) } as InputBackend;
const audio = {} as AudioBackend;
describe('Engine built-in plugin profiles', () => {
  it('keeps browser-main capabilities in one acyclic declared graph', () => {
    const profile = mainEngineProfile({
      renderer,
      input,
      inputMap: [],
      animationPayloads: () => undefined,
    });
    expect(profile.map((plugin) => metadata(plugin).name)).toEqual([
      'renderer',
      'render-components',
      'renderer-assets',
      'assets-world',
      'input-backend',
      'scene',
      'animation-payloads',
      'animation',
      'state',
      'input',
      'input-map',
    ]);
    expectDag(profile, ['world']);
  });

  it('keeps Worker and assembled selections acyclic without copying App wiring', () => {
    expectDag(
      workerEngineProfile({
        renderer,
        input,
        audio,
        animationPayloads: () => undefined,
      }),
      ['world'],
    );
    expectDag(assembledEngineProfile({ renderer }), ['world']);
  });

  it('closes an App-owned remote server with its Fiber', async () => {
    let closeCount = 0;
    const context = new Context();
    await context.plugin(
      remoteServerPlugin({
        port: 5732,
        async close() {
          closeCount += 1;
        },
      }),
    );
    await context.fiber.dispose();
    expect(closeCount).toBe(1);
  });

  it('releases an owned Renderer through its dependent Fiber', async () => {
    const disposalOrder: string[] = [];
    const ownedRenderer = {
      dispose() {
        disposalOrder.push('renderer');
      },
    } as Renderer;
    const context = new Context();
    await context.plugin(ownedRendererPlugin(ownedRenderer));
    await context.plugin({
      name: 'renderer-consumer',
      inject: ['renderer'],
      apply(ctx) {
        ctx.effect(
          () => () => {
            disposalOrder.push('consumer');
          },
          'test/renderer-consumer',
        );
      },
    });
    await context.fiber.dispose();
    expect(disposalOrder).toEqual(['consumer', 'renderer']);
  });

  it('releases an App-acquired input backend through its provider Fiber', async () => {
    let disposeCount = 0;
    const context = new Context();
    await context.plugin(
      ownedInputBackendPlugin(input, () => {
        disposeCount += 1;
      }),
    );
    await context.fiber.dispose();
    expect(disposeCount).toBe(1);
  });

  it('releases an owned Renderer once when later activation rolls back', async () => {
    let disposeCount = 0;
    const ownedRenderer = {
      dispose() {
        disposeCount += 1;
      },
    } as Renderer;

    await expect(
      createWorldContext(new World(), [
        ownedRendererPlugin(ownedRenderer),
        {
          name: 'activation-failure',
          apply() {
            throw new Error('activation failed');
          },
        },
      ]),
    ).rejects.toThrow('activation failed');
    expect(disposeCount).toBe(1);
  });
});
