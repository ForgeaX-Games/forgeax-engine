import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeServer,
  pollHttpReady,
  probeFailureRecord,
  assertApplicationBootstrap,
  withServerLifecycle,
  withRestoredFile,
} from './shared-inputs-browser-harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const smokeScript = join(here, 'smoke-shared-inputs-browser.mjs');

test('shared-inputs browser probe uses catalog-only inputs', async () => {
  const source = await readFile(smokeScript, 'utf8');
  assert.match(source, /['"]--catalog-only['"]/);
  assert.match(source, /FORGEAX_SHARED_APP_INPUTS_MODE:\s*['"]catalog-only['"]/);
  assert.match(source, /process\.env\.FORGEAX_SHARED_APP_INPUTS_MODE = ['"]catalog-only['"]/);
});

test('application bootstrap rejects structured application errors', () => {
  assert.throws(
    () => assertApplicationBootstrap(['CONSOLE-ERR: [learn-render] createApp failed: manifest-malformed'], 'http://127.0.0.1:43123/blending/'),
    (error) => error.stage === 'application-bootstrap' && error.actual.includes('manifest-malformed'),
  );
  assert.doesNotThrow(() => assertApplicationBootstrap([], 'http://127.0.0.1:43123/blending/'));
});

test('known probe failures expose a stable machine-readable record', async () => {
  const error = new (class extends Error {})();
  assert.equal(probeFailureRecord(error), null);
  await assert.rejects(
    pollHttpReady('http://127.0.0.1:1/blending/', {
      deadlineMs: 20,
      intervalMs: 2,
      fetchImpl: async () => ({ ok: false, status: 503 }),
      stage: 'preview-readiness',
    }),
    (failure) => {
      assert.deepEqual(probeFailureRecord(failure), {
      code: 'shared-input-browser-preview-readiness',
      stage: 'preview-readiness',
      url: 'http://127.0.0.1:1/blending/',
      expected: 'HTTP 2xx before deadline',
      actual: 503,
      hint: 'Check the server root/base and verify HTTP readiness rather than stdout markers.',
      detail: '',
      });
      return true;
    },
  );
});

test('readiness uses HTTP and closes server when deadline expires', async () => {
  let closed = 0;
  await assert.rejects(
    pollHttpReady('http://127.0.0.1:1/blending/', {
      deadlineMs: 20,
      intervalMs: 2,
      fetchImpl: async () => ({ ok: false, status: 503 }),
      stage: 'preview-readiness',
    }),
    (error) => error.stage === 'preview-readiness' && error.hint.includes('HTTP'),
  );
  await withServerLifecycle(
    Promise.resolve({ close: async () => { closed += 1; } }),
    async () => { throw new Error('assertion'); },
  ).catch(() => {});
  assert.equal(closed, 1);
});

test('server close drains HMR sockets and HTTP connections before awaiting Vite', async () => {
  const calls = [];
  await closeServer({
    close: async () => { calls.push('vite'); },
    ws: { close: () => calls.push('ws') },
    httpServer: {
      closeAllConnections: () => calls.push('all-connections'),
      closeIdleConnections: () => calls.push('idle-connections'),
      close: () => calls.push('http'),
    },
  });
  assert.deepEqual(calls, ['ws', 'all-connections', 'idle-connections', 'vite', 'http']);
});

test('occupied fixed port does not affect lifecycle when server allocates its own port', async () => {
  let closed = false;
  const result = await withServerLifecycle(
    Promise.resolve({
      origin: 'http://127.0.0.1:43123',
      close: async () => { closed = true; },
    }),
    async (server) => server.origin,
  );
  assert.equal(result, 'http://127.0.0.1:43123');
  assert.equal(closed, true);
});

test('assertion failures and HMR failures restore shader source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-harness-test-'));
  const file = join(root, 'alpha-test.wgsl');
  await writeFile(file, 'const alpha = 0.1;');
  try {
    await assert.rejects(withRestoredFile(file, async () => {
      await writeFile(file, 'const alpha = 0.2;');
      throw Object.assign(new Error('hmr timeout'), { stage: 'custom-shader-hmr' });
    }));
    assert.equal(await readFile(file, 'utf8'), 'const alpha = 0.1;');
  } finally {
    await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true }));
  }
});
