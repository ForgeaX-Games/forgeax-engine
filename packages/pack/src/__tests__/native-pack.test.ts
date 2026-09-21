import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { AssetGuid, definePack, definePackageId } from '../scriptable-pack.js';
import { loadScriptablePack } from '../scriptable-pack-node.js';

const packageId = definePackageId('dd43c759-8112-5ea2-ab45-7affb0e7a214');
const scene = { kind: 'scene' as const, entities: [] };

describe('native Pack source discovery', () => {
  it('derives official identities and builds once across discovery and cook consumption', async () => {
    let builds = 0;
    const disposals: string[] = [];
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId,
      build: ({ packageId: id }) => {
        builds++;
        expect(AssetGuid.format(AssetGuid.derive(id, 'scene/main'))).toBe(
          '1073cc16-2533-53dc-a63f-cbd45527b75d',
        );
        return ok({ 'scene/main': scene });
      },
    });
    const loaded = await loadScriptablePack('/game/asset.pack.ts', {
      executor: {
        load: async () => ({ default: definition }),
        dispose: async (reason) => {
          disposals.push(reason);
        },
      },
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const reader = {
      readByGuid: async () => {
        throw new Error('unexpected read');
      },
    };
    const first = await loaded.value.build(reader);
    const second = await loaded.value.build(reader);
    expect(first).toEqual(ok({ 'scene/main': scene }));
    expect(second).toEqual(first);
    expect(first).not.toBe(second);
    expect(builds).toBe(1);
    expect(disposals).toEqual(['complete']);
    expect(loaded.value.authoringVersion).toBe('2.0.0');
  });

  it('does not let caught external read failures produce a stale cached output', async () => {
    const loaded = await loadScriptablePack('/game/asset.pack.ts', {
      executor: {
        load: async () => ({
          default: definePack({
            schemaVersion: '2.0.0',
            packageId,
            build: async ({ readByGuid }) => {
              await readByGuid(AssetGuid.random()).catch(() => undefined);
              return ok({ 'scene/main': scene });
            },
          }),
        }),
      },
    });
    expect(loaded).toMatchObject({
      ok: false,
      error: {
        detail: {
          phase: 'build',
          diagnostic: expect.stringContaining('discovery-read-unsupported'),
        },
      },
    });
  });

  it('bounds discovery execution and releases the executor', async () => {
    const disposals: string[] = [];
    const loaded = await loadScriptablePack('/game/asset.pack.ts', {
      buildTimeoutMs: 10,
      executor: {
        load: async () => ({
          default: definePack({
            schemaVersion: '2.0.0',
            packageId,
            build: () => new Promise(() => {}),
          }),
        }),
        dispose: async (reason) => {
          disposals.push(reason);
        },
      },
    });
    expect(loaded).toMatchObject({
      ok: false,
      error: { detail: { phase: 'build', diagnostic: expect.stringContaining('exceeded') } },
    });
    expect(disposals).toEqual(['failure']);
  });

  it('rejects parameterized definitions rather than dropping parameter semantics', () => {
    const value = {
      schemaVersion: '2.0.0' as const,
      packageId,
      parameters: [],
      build: () => ok({ 'scene/main': scene }),
    };
    expect(() => definePack(value)).toThrow('parameters-unsupported');
  });

  it('rejects invalid keys and empty output maps', async () => {
    for (const outputs of [{}, { '../escape': scene }]) {
      const loaded = await loadScriptablePack('/game/asset.pack.ts', {
        metadataOnly: true,
        executor: {
          load: async () => ({
            default: definePack({ schemaVersion: '2.0.0', packageId, build: () => ok(outputs) }),
          }),
        },
      });
      expect(loaded.ok).toBe(false);
    }
  });
});
