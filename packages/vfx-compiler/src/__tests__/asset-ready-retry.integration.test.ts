import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { ParticleEffectAsset } from '@forgeax/engine-types';
import { particleEffectPackLoader } from '@forgeax/engine-vfx';
import { describe, expect, it, vi } from 'vitest';

const ROOT_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45c';
const REF_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45d';
const PACKAGE_URL = '/effects/pack';
const PROGRAM_KEY = 'particle-effect/program.json';

const rootPayload: ParticleEffectAsset = {
  kind: 'particle-effect',
  schemaVersion: 1,
  emitters: [{ id: 'root', capacity: 8 }],
};

const refPayload: ParticleEffectAsset = {
  kind: 'particle-effect',
  schemaVersion: 1,
  emitters: [{ id: 'ref', capacity: 4 }],
};

function packAsset(
  guid: string,
  payload: ParticleEffectAsset,
  refs: readonly string[],
  artifactPath: string,
) {
  return {
    guid,
    kind: 'particle-effect',
    payload,
    refs,
    artifacts: {
      [PROGRAM_KEY]: { path: artifactPath, mediaType: 'application/json' },
    },
  };
}

function program(id: string): Uint8Array {
  const capacity = id === 'root' ? 8 : 4;
  const rate = id === 'root' ? 2 : 1;
  return new TextEncoder().encode(
    JSON.stringify({
      format: 'forgeax-vfx-program-1',
      emitters: [
        {
          id,
          capacity,
          space: 'world',
          schedule: { rate, bursts: [] },
          bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
          backendPolicy: { kind: 'required', backend: 'cpu' },
          backendPlan: { kind: 'cpu', backends: ['cpu'] },
          operators: {
            spawn: [{ kind: 'spawn-rate', version: 1, params: { rate } }],
            initialize: [{ kind: 'set-life', version: 1, params: { seconds: 1 } }],
            update: [{ kind: 'gravity', version: 1, params: { y: -9.8 } }],
            output: [{ kind: 'billboard', version: 1, params: { size: 0.25 } }],
          },
          output: { kind: 'billboard', material: `material-${id}` },
          programs: {
            cpu: [
              { operator: 'spawn:spawn-rate:1', program: { opcode: 'spawn-rate', rate } },
              { operator: 'initialize:set-life:1', program: { opcode: 'set-life', seconds: 1 } },
              { operator: 'update:gravity:1', program: { opcode: 'gravity', y: -9.8 } },
              { operator: 'output:billboard:1', program: { opcode: 'billboard', size: 0.25 } },
            ],
          },
        },
      ],
    }),
  );
}

function installLoader(registry: AssetRegistry): void {
  registry.loaders.registerPackLoader(particleEffectPackLoader);
}

function configure(registry: AssetRegistry): void {
  registry.configurePackIndex('/pack-index.json');
  installLoader(registry);
}

function indexRows() {
  return [
    { guid: ROOT_GUID, packageUrl: PACKAGE_URL, kind: 'particle-effect', sourcePath: 'root.json' },
    { guid: REF_GUID, packageUrl: PACKAGE_URL, kind: 'particle-effect', sourcePath: 'ref.json' },
  ];
}

describe('VFX Pack v2 ready and retry boundary', () => {
  it('loads a cyclic ref component without exposing a provisional payload', async () => {
    const registry = new AssetRegistry({} as never);
    configure(registry);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('pack-index.json')) return new Response(JSON.stringify(indexRows()));
        if (url.endsWith('/effects/pack')) {
          return new Response(
            JSON.stringify({
              schemaVersion: '2.0.0',
              kind: 'internal-text-package',
              assets: [
                packAsset(ROOT_GUID, rootPayload, [REF_GUID], 'root.json'),
                packAsset(REF_GUID, refPayload, [ROOT_GUID], 'ref.json'),
              ],
            }),
          );
        }
        return new Response(
          (url.endsWith('root.json') ? program('root') : program('ref')) as unknown as BodyInit,
        );
      }),
    );

    const result = await registry.loadByGuid(registry.parseGuid(ROOT_GUID));

    expect(result.ok).toBe(true);
    expect(registry.lookup(ROOT_GUID)).toEqual(rootPayload);
    expect(registry.lookup(REF_GUID)).toEqual(refPayload);
  });

  it('deduplicates concurrent same-GUID loads and returns the same complete value', async () => {
    const registry = new AssetRegistry({} as never);
    configure(registry);
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('pack-index.json')) {
        return new Response(JSON.stringify([indexRows()[0]]));
      }
      if (url.endsWith('/effects/pack')) {
        return new Response(
          JSON.stringify({
            schemaVersion: '2.0.0',
            kind: 'internal-text-package',
            assets: [packAsset(ROOT_GUID, rootPayload, [], 'root.json')],
          }),
        );
      }
      return new Response(program('root') as unknown as BodyInit);
    });
    vi.stubGlobal('fetch', fetcher);

    const results = await Promise.all(
      Array.from({ length: 4 }, () => registry.loadByGuid(registry.parseGuid(ROOT_GUID))),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.map((result) => (result.ok ? result.value : undefined))).toEqual([
      rootPayload,
      rootPayload,
      rootPayload,
      rootPayload,
    ]);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/effects/pack'))).toHaveLength(1);
  });

  it('does not resolve concurrent public loads before a referenced artifact is ready', async () => {
    const registry = new AssetRegistry({} as never);
    configure(registry);
    let releaseRef!: () => void;
    const refStarted = new Promise<void>((resolve) => {
      releaseRef = resolve;
    });
    let refRequested!: () => void;
    const refRequest = new Promise<void>((resolve) => {
      refRequested = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('pack-index.json')) {
          return new Response(JSON.stringify(indexRows()));
        }
        if (url.endsWith('/effects/pack')) {
          return new Response(
            JSON.stringify({
              schemaVersion: '2.0.0',
              kind: 'internal-text-package',
              assets: [
                packAsset(ROOT_GUID, rootPayload, [REF_GUID], 'root.json'),
                packAsset(REF_GUID, refPayload, [], 'ref.json'),
              ],
            }),
          );
        }
        if (url.endsWith('ref.json')) {
          refRequested();
          await refStarted;
          return new Response(program('ref') as unknown as BodyInit);
        }
        return new Response(program('root') as unknown as BodyInit);
      }),
    );

    const first = registry.loadByGuid(registry.parseGuid(ROOT_GUID));
    await refRequest;
    let publicSettled = false;
    const concurrent = registry.loadByGuid(registry.parseGuid(ROOT_GUID)).then((result) => {
      publicSettled = true;
      return result;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(publicSettled).toBe(false);

    releaseRef();
    const [firstResult, concurrentResult] = await Promise.all([first, concurrent]);
    expect(firstResult.ok).toBe(true);
    expect(concurrentResult).toEqual(firstResult);
  });

  it('purges a broken artifact closure and retries after the artifact is repaired', async () => {
    const registry = new AssetRegistry({} as never);
    configure(registry);
    let repaired = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('pack-index.json')) {
          return new Response(JSON.stringify([indexRows()[0]]));
        }
        if (url.endsWith('/effects/pack')) {
          return new Response(
            JSON.stringify({
              schemaVersion: '2.0.0',
              kind: 'internal-text-package',
              assets: [packAsset(ROOT_GUID, rootPayload, [], 'root.json')],
            }),
          );
        }
        return repaired
          ? new Response(program('root') as unknown as BodyInit)
          : new Response('missing', { status: 503 });
      }),
    );

    const failed = await registry.loadByGuid(registry.parseGuid(ROOT_GUID));
    expect(failed.ok).toBe(false);
    expect(registry.lookup(ROOT_GUID)).toBeUndefined();

    repaired = true;
    const retried = await registry.loadByGuid(registry.parseGuid(ROOT_GUID));
    expect(retried.ok).toBe(true);
    expect(registry.lookup(ROOT_GUID)).toEqual(rootPayload);
  });
});
