import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(
  new URL('../../../apps/preview/scripts/smoke-templates.mjs', import.meta.url),
  'utf8',
);
function functionSource(start, end) {
  assert.ok(source.includes(start) && source.includes(end));
  return source.slice(source.indexOf(start), source.indexOf(end));
}

test('successful Preview browser cleanup leaves no deadline timers keeping Node alive', () => {
  // Execute the actual cleanup body in a child so natural process exit is the
  // oracle. The old Promise.race left three live 10-second timers behind.
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { setTimeout as sleep } from 'node:timers/promises';
    let activeEvidence;
    let page = { close: async () => console.log('page') };
    let context = { close: async () => console.log('context') };
    let browser = { close: async () => console.log('browser') };
    ${functionSource('async function closeSmokeBrowser()', 'async function waitForSubmittedRendererFrame')}
    await closeSmokeBrowser();
  `,
    ],
    { timeout: 5000, encoding: 'utf8' },
  );
  assert.equal(output.trim(), 'page\ncontext\nbrowser');
});

test('Preview readiness terminates when an HTTP server accepts but never responds', () => {
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { createServer } from 'node:http';
    import { setTimeout as sleep } from 'node:timers/promises';
    const listener = createServer(() => {});
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const ORIGIN = 'http://127.0.0.1:' + listener.address().port;
    const SERVER_STARTUP_TIMEOUT_MS = 80;
    const CATALOG_URL = '/catalog.json';
    const server = { pid: process.pid };
    let serverSpawnError, serverExit;
    const serverOutput = '';
    ${functionSource('function serverDiagnostics(', 'function movementProjection(')}
    try {
      await waitForServerReady();
      throw new Error('accepted an unresponsive server');
    } catch (error) {
      if (!String(error).includes('Preview server did not become ready within 80ms')) throw error;
      console.log('bounded startup failure');
    } finally {
      listener.closeAllConnections();
      await new Promise(resolve => listener.close(resolve));
    }
  `,
    ],
    { timeout: 5000, encoding: 'utf8' },
  );
  assert.equal(output.trim(), 'bounded startup failure');
});

test('Preview readiness waits for its Catalog and preserves terminal producer errors', () => {
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { createServer } from 'node:http';
    import { setTimeout as sleep } from 'node:timers/promises';
    const CATALOG_URL = '/catalog.json';
    let ready = false, failed = false, reads = 0;
    const listener = createServer((req, res) => {
      if (req.url === CATALOG_URL) {
        reads++;
        res.statusCode = failed ? 500 : ready ? 200 : 503;
        res.end(failed ? 'character.pack.ts: module initialization failed' : JSON.stringify({ entries: [] }));
      } else res.end('<html>Listener only</html>');
    });
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const ORIGIN = 'http://127.0.0.1:' + listener.address().port;
    const SERVER_STARTUP_TIMEOUT_MS = 2000;
    const server = { pid: process.pid };
    let serverSpawnError, serverExit;
    const serverOutput = '';
    ${functionSource('function serverDiagnostics(', 'function movementProjection(')}
    try {
      const preparing = waitForServerReady();
      // The child can be scheduled behind the catalog fetch on a loaded
      // self-hosted runner. Wait for the observable request with a bounded
      // deadline instead of assuming it will happen within one fixed tick.
      const requestDeadline = Date.now() + 1000;
      while (reads === 0 && Date.now() < requestDeadline) await sleep(20);
      assert.ok(reads > 0, 'must request the catalog');
      ready = true;
      await preparing;
      assert.ok(reads >= 2, 'pending catalog must delay readiness');
      failed = true;
      const before = reads;
      await assert.rejects(waitForServerReady(), /character.pack.ts: module initialization failed/);
      assert.equal(reads, before + 1, 'terminal failure must not be retried');
      console.log('catalog readiness and failure passed');
    } finally {
      listener.closeAllConnections();
      await new Promise(resolve => listener.close(resolve));
    }
  `,
    ],
    { timeout: 5000, encoding: 'utf8' },
  );
  assert.equal(output.trim(), 'catalog readiness and failure passed');
});

test('Preview waits for a slow Catalog freshness barrier without restarting requests', () => {
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { createServer } from 'node:http';
    import { setTimeout as sleep } from 'node:timers/promises';
    let reads = 0;
    const listener = createServer(async (_req, res) => {
      reads++;
      // Every real Catalog request fences filesystem state. It can take
      // longer than a second even after Vite's HTTP listener is ready.
      await sleep(1500);
      res.end(JSON.stringify({ entries: [{ guid: 'slow-but-current' }] }));
    });
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const ORIGIN = 'http://127.0.0.1:' + listener.address().port;
    const SERVER_STARTUP_TIMEOUT_MS = 4000;
    const CATALOG_URL = '/catalog.json';
    const server = { pid: process.pid };
    let serverSpawnError, serverExit;
    const serverOutput = '';
    ${functionSource('function serverDiagnostics(', 'function movementProjection(')}
    try {
      await waitForServerReady();
      assert.equal(reads, 1, 'one in-budget freshness request must finish without retry churn');
      console.log('slow catalog passed');
    } finally {
      listener.closeAllConnections();
      await new Promise(resolve => listener.close(resolve));
    }
  `,
    ],
    { timeout: 8000, encoding: 'utf8' },
  );
  assert.equal(output.trim(), 'slow catalog passed');
});

test('Preview reports success only after browser and owned server cleanup', () => {
  assert.ok(source.indexOf('await stopServer();') < source.indexOf('writeReport(reportStatus)'));
  assert.match(source, /createOwnedProcessGroupStopper\(server\)/);
  assert.match(source, /process\.on\('SIGTERM', onTerminate\)/);
  assert.match(source, /process\.execPath,[\s\S]*vite\/package\.json/);
  const collision = functionSource(
    'async function smokeGame3dCollision(',
    'async function smokeGame3d(evidence)',
  );
  assert.match(collision, /keyboard\.down\('KeyW'\)/);
  assert.doesNotMatch(collision, /mouse\.(click|move)/);
  assert.match(collision, /collisionLateStep > 0\.45/);
});

test('both Preview browser consumers receive the verified shared shader manifest', () => {
  const workflow = readFileSync(
    new URL('../../../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  for (const name of [
    'UI authoring preview/capture probe',
    'engine templates Preview browser smoke (render + console gate)',
  ]) {
    const step = workflow
      .slice(workflow.indexOf(`      - name: ${name}`))
      .split(/\n {6}- name:|\n {2}#/)[0];
    assert.match(step, /FORGEAX_SHARED_APP_INPUTS_MANIFEST:.*shared-app-inputs\/manifest.json/);
  }
});
