import { describe, expect, it } from 'vitest';
import {
  createTransportRouteHandler,
  type TransportRouteContext,
} from '../dev/transport-routes.js';

async function responseFor(cause: unknown) {
  const handler = createTransportRouteHandler({
    startupReady: Promise.resolve(),
    devSession: {
      runtimeScope: () => ({ scopeId: 'game', generation: 1 }),
      state: () => ({
        status: 'failed',
        error: {
          code: 'produce-failed',
          expected: 'valid product',
          hint: 'repair source',
          detail: { stage: 'produce' },
          cause,
        },
      }),
    },
  } as unknown as TransportRouteContext);
  let body = '';
  const response = {
    statusCode: 200,
    setHeader() {},
    end(value: string | Uint8Array) {
      body = String(value);
    },
  };
  await handler({ url: '/__pack/scopes/game/1/catalog.json' }, response, () => {
    throw new Error('route not handled');
  });
  return { status: response.statusCode, body: JSON.parse(body) };
}

describe('catalog failure cause', () => {
  it('preserves catalog diagnostic arrays and bounds cyclic and oversized arrays', async () => {
    const diagnostic = {
      code: 'catalog-scan-failed',
      path: 'assets/broken.pack.json',
      message: 'invalid source',
      actual: 'malformed JSON',
      credentials: 'must not copy',
    };
    const cycle: unknown[] = [diagnostic];
    cycle.push(cycle);
    const result = await responseFor(cycle);
    expect(result.status).toBe(503);
    expect(result.body.cause).toEqual([
      {
        code: diagnostic.code,
        path: diagnostic.path,
        message: diagnostic.message,
        actual: diagnostic.actual,
      },
    ]);
    const large = await responseFor(
      Array.from({ length: 1000 }, () => ({ message: 'x'.repeat(3000) })),
    );
    expect(large.body.cause.length).toBeLessThanOrEqual(40);
    expect(large.body.cause[0].message).toHaveLength(2000);
  });

  it('preserves a nested Error message through the real JSON response', async () => {
    const result = await responseFor(
      Object.assign(new Error('scene source failed'), {
        code: 'scriptable-pack-build-failed',
        detail: { unusedDeclaredGuids: ['asset-guid'] },
        cause: new Error('missing shader compiler'),
      }),
    );
    expect(result.status).toBe(503);
    expect(result.body.cause).toMatchObject({
      code: 'scriptable-pack-build-failed',
      message: 'scene source failed',
      detail: { unusedDeclaredGuids: ['asset-guid'] },
      cause: { message: 'missing shader compiler' },
    });
    expect(JSON.stringify(result.body)).not.toContain('stack');
  });

  it('bounds cyclic causes and omits arbitrary provider objects', async () => {
    const cause: Record<string, unknown> = { message: 'failure', credentials: 'must not copy' };
    cause.cause = cause;
    const result = await responseFor(cause);
    expect(result.body.cause.message).toBe('failure');
    expect(JSON.stringify(result.body)).not.toContain('must not copy');
    expect(JSON.stringify(result.body).length).toBeLessThan(2000);
  });
});

async function importFailureFor(error: unknown) {
  const handler = createTransportRouteHandler({
    startupReady: Promise.resolve(),
    state: {},
    devSession: {
      runtimeScope: () => ({ scopeId: 'game', generation: 1, status: 'ready' }),
      state: () => ({ status: 'ready' }),
    },
    callbacks: {
      rebuildSource: async () => {
        throw error;
      },
    },
  } as unknown as TransportRouteContext);
  let body = '';
  const response = {
    statusCode: 200,
    setHeader() {},
    end(value: string | Uint8Array) {
      body = String(value);
    },
  };
  const request = {
    url: '/__pack/scopes/game/1/import/source',
    method: 'POST',
    headers: { 'x-forgeax-import-source-key': 'assets/counter.pack.ts' },
  };
  await handler(request, response, () => {
    throw new Error('unhandled');
  });
  return { status: response.statusCode, body: JSON.parse(body) };
}

describe('source import diagnostics', () => {
  it('preserves the actionable module-load cause on import and failed watcher catalog routes', async () => {
    const error = {
      code: 'pack-source-load-failed',
      expected: 'a valid module',
      hint: 'repair module initialization',
      detail: {
        sourcePath: 'assets/scene.pack.ts',
        reason: 'module-load',
        phase: 'module-load',
        diagnostic: 'AssetGuidParser is not defined',
      },
    };
    const imported = await importFailureFor(error);
    expect(imported.status).toBe(422);
    expect(imported.body.detail).toEqual(error.detail);
    const watched = await responseFor({ code: 'watch-failed', cause: error });
    expect(watched.status).toBe(503);
    expect(watched.body.cause.cause.detail).toEqual(error.detail);
  });

  it('reports the failing project source, not just the requested asset', async () => {
    const error = {
      code: 'pack-source-external-closure-mismatch',
      hint: 'repair GUID declarations',
      detail: { sourcePath: 'assets/scene.pack.ts', unusedDeclaredGuids: ['old-guid'] },
      token: 'private',
    };
    const result = await importFailureFor(error);
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({
      error: 'source-import-failed',
      code: error.code,
      hint: error.hint,
      detail: error.detail,
    });
    expect(JSON.stringify(result.body)).not.toContain('private');
  });
  it.each([
    new Error('compiler unavailable'),
    'compiler unavailable',
  ])('preserves ordinary failures', async (error) => {
    expect((await importFailureFor(error)).body.hint).toBe('compiler unavailable');
  });
  it('makes unknown errors explicit and bounds cyclic causes', async () => {
    expect((await importFailureFor({ token: 'private' })).body.hint).toContain('Unknown');
    const error: Record<string, unknown> = { code: 'failed', hint: 'repair source' };
    error.cause = error;
    expect(JSON.stringify((await importFailureFor(error)).body)).not.toContain('[object Object]');
  });
});
