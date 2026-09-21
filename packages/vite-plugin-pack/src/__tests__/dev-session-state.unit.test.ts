import type { CatalogEntry, RuntimeAssetBinding } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createDevSession, type DevSessionSnapshot } from '../dev/dev-session.js';
import { createProductionSession } from '../production/session.js';

const entry: CatalogEntry = {
  guid: '11111111-1111-4111-8111-111111111111',
  packageUrl: '/preview/fixture.pack.json',
  kind: 'mesh',
  sourcePath: 'fixture.mesh',
};

function snapshot(
  generation: number,
  authority: DevSessionSnapshot['authority'] = 'authoritative',
) {
  return {
    generation,
    catalog: [entry],
    authority,
    diagnostics:
      authority === 'degraded' ? [{ code: 'fixture-failure', severity: 'blocking' as const }] : [],
  } satisfies DevSessionSnapshot;
}

function productionSession() {
  return createProductionSession({
    inventory: async () => [],
    produce: async () => {},
    publish: async () => {},
  });
}

function runtimeBinding(scopeId: string, generation: number): RuntimeAssetBinding {
  return {
    schemaVersion: 'runtime-asset-binding-v1',
    gameId: scopeId,
    scopeId,
    generation,
    status: 'unbound',
    catalogUrl: `/__pack/scopes/${scopeId}/${generation}/catalog.json`,
    importUrlBase: `/__pack/scopes/${scopeId}/${generation}/import`,
    packageUrlBase: `/__pack/scopes/${scopeId}/${generation}/asset`,
  };
}

describe('DevSession state machine', () => {
  it.each([
    {
      code: 'pack-source-load-failed',
      detail: {
        sourcePath: 'assets/scene.pack.ts',
        phase: 'module-load',
        diagnostic: 'AssetGuidParser is not defined',
      },
    },
    {
      code: 'pack-source-external-closure-mismatch',
      detail: {
        sourcePath: 'assets/scene.pack.ts',
        unusedDeclaredGuids: ['019fb7ce-3300-7000-8000-000000000003'],
      },
    },
  ])('keeps concrete source failure blocking until a corrected snapshot is accepted: $code', async (cause) => {
    const session = createDevSession({
      generation: 1,
      productionSession: productionSession(),
      startup: async () => snapshot(1),
    });
    session.bindRuntime(runtimeBinding('repair-source', 1));
    await session.start();
    try {
      await session.rebuild(async () => {
        throw {
          code: 'produce-failed',
          expected: 'accepted source',
          hint: 'repair source',
          detail: { stage: 'produce' },
          cause,
        };
      });
      expect(session.state().status).toBe('degraded');
      expect(session.runtimeScope()).toMatchObject({
        status: 'degraded',
        diagnostics: [
          expect.objectContaining({
            severity: 'blocking',
            cause: expect.objectContaining({ cause }),
          }),
        ],
      });
      await session.rebuild(async () => {
        throw new Error('still broken');
      });
      expect(session.runtimeScope()?.status).toBe('degraded');
      await session.rebuild(async () => ({
        ...snapshot(1),
        catalog: [{ ...entry, packageUrl: '/preview/corrected.pack.json' }],
      }));
      expect(session.state()).toMatchObject({
        status: 'serving',
        snapshot: {
          catalog: [expect.objectContaining({ packageUrl: '/preview/corrected.pack.json' })],
        },
      });
      expect(session.runtimeScope()).toMatchObject({ status: 'ready', diagnostics: [] });
    } finally {
      await session.close();
    }
  });

  it('owns and clears the runtime scope with its generation session', async () => {
    const session = createDevSession({
      generation: 1,
      productionSession: productionSession(),
      startup: async () => snapshot(1),
    });
    session.bindRuntime(runtimeBinding('game-a', 1));
    expect(session.runtimeScope()).toMatchObject({
      scopeId: 'game-a',
      generation: 1,
      status: 'transitioning',
    });
    expect(session.publishRuntime('ready')?.generation).toBe(1);
    expect(() => session.bindRuntime(runtimeBinding('game-a', 2))).toThrow('already belongs');

    await session.close();
    expect(session.runtimeScope()).toBeUndefined();
  });

  it('validates runtime identity before binding it to a session', async () => {
    const session = createDevSession({
      generation: 1,
      productionSession: productionSession(),
      startup: async () => snapshot(1),
    });
    expect(() => session.bindRuntime(runtimeBinding('game-a', 0))).toThrow('positive safe integer');
    expect(() => session.bindRuntime({ ...runtimeBinding('game-a', 1), gameId: '' })).toThrow(
      'gameId and scopeId are required',
    );
    await session.close();
  });

  it('fails closed without a startup snapshot and returns a structured 503 projection', async () => {
    const session = createDevSession({
      generation: 1,
      productionSession: productionSession(),
      startup: async () => {
        throw new Error('missing root');
      },
    });

    await session.start();
    expect(session.state().status).toBe('failed');
    expect(session.state()).toMatchObject({
      status: 'failed',
      error: { detail: { stage: 'scan' } },
    });
    await session.close();
  });

  it('retries a failed startup without inventing an accepted snapshot', async () => {
    const session = createDevSession({
      generation: 1,
      productionSession: productionSession(),
      startup: async () => {
        throw new Error('broken source');
      },
    });
    session.bindRuntime(runtimeBinding('recovery', 1));
    await session.start();
    expect(session.runtimeScope()).toMatchObject({
      status: 'degraded',
      authority: 'degraded',
      diagnostics: [expect.objectContaining({ code: 'scan-failed' })],
    });
    await session.rebuild(async ({ previous }) => {
      expect(previous).toBeUndefined();
      throw new Error('source still broken');
    });
    expect(session.state().status).toBe('failed');
    await session.rebuild(async ({ generation, previous }) => {
      expect(previous).toBeUndefined();
      return snapshot(generation);
    });
    expect(session.state().status).toBe('serving');
    expect(session.runtimeScope()).toMatchObject({ status: 'ready', diagnostics: [] });
    await session.close();
  });

  it('ignores an older failed recovery after a newer recovery succeeds', async () => {
    const session = createDevSession({
      generation: 1,
      productionSession: productionSession(),
      startup: async () => {
        throw new Error('broken source');
      },
    });
    await session.start();
    let reject!: (error: Error) => void;
    const older = session.rebuild(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    await session.rebuild(async () => snapshot(2));
    reject(new Error('stale failure'));
    await older;
    expect(session.state()).toMatchObject({ status: 'serving', snapshot: { generation: 2 } });
    await session.close();
  });

  it('does not publish a recovery after the session is closed', async () => {
    const session = createDevSession({
      generation: 1,
      productionSession: productionSession(),
      startup: async () => {
        throw new Error('broken source');
      },
    });
    await session.start();
    let release!: (value: DevSessionSnapshot) => void;
    const recovery = session.rebuild(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const closing = session.close();
    release(snapshot(2));
    await Promise.all([recovery, closing]);
    expect(session.state()).toEqual({ status: 'closed' });
    expect(session.runtimeScope()).toBeUndefined();
  });

  it('keeps the accepted snapshot visible during rebuild failure and closes with 410', async () => {
    const session = createDevSession({
      generation: 3,
      productionSession: productionSession(),
      startup: async () => snapshot(3),
    });
    session.bindRuntime(runtimeBinding('retained-publication', 3));
    await session.start();
    expect(session.state().status).toBe('serving');

    await session.rebuild(async () => {
      throw new Error('watch batch rejected');
    });
    expect(session.state().status).toBe('degraded');
    expect(session.state()).toMatchObject({
      status: 'degraded',
      snapshot: { catalog: [entry], authority: 'authoritative', diagnostics: [] },
    });
    expect(session.runtimeScope()).toMatchObject({
      status: 'degraded',
      authority: 'authoritative',
      diagnostics: [expect.objectContaining({ code: 'scan-failed' })],
    });
    await session.rebuild(async ({ previous, generation }) => {
      expect(previous?.authority).toBe('authoritative');
      return snapshot(generation);
    });
    expect(session.runtimeScope()).toMatchObject({
      status: 'ready',
      authority: 'authoritative',
      diagnostics: [],
    });

    await session.close();
    expect(session.state()).toEqual({ status: 'closed' });
    expect(session.state()).toEqual({ status: 'closed' });
  });

  it('does not let a late candidate replace a newer generation', async () => {
    let release!: (value: DevSessionSnapshot) => void;
    const session = createDevSession({
      generation: 1,
      productionSession: productionSession(),
      startup: async () => snapshot(1),
    });
    await session.start();
    const pending = session.rebuild(
      () => new Promise<DevSessionSnapshot>((resolve) => (release = resolve)),
    );
    const closing = session.close();
    await Promise.resolve();
    release(snapshot(2));
    await closing;
    await pending;
    expect(session.state()).toEqual({ status: 'closed' });
  });

  it('drains a delayed startup before close resolves', async () => {
    let release!: (value: DevSessionSnapshot) => void;
    const session = createDevSession({
      generation: 7,
      productionSession: productionSession(),
      startup: async () =>
        new Promise<DevSessionSnapshot>((resolve) => {
          release = resolve;
        }),
    });

    const starting = session.start();
    await Promise.resolve();
    const closing = session.close();
    await Promise.resolve();
    expect(session.state()).toEqual({ status: 'closing' });

    release(snapshot(7));
    await closing;
    await starting;
    expect(session.state()).toEqual({ status: 'closed' });
    expect(session.state()).toEqual({ status: 'closed' });
  });
});
