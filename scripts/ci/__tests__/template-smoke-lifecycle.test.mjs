import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(
  new URL('../../../apps/preview/scripts/smoke-templates.mjs', import.meta.url),
  'utf8',
);
function functionSource(start, end) {
  assert.ok(source.includes(start) && source.includes(end));
  return source.slice(source.indexOf(start), source.indexOf(end));
}

test('Preview CI reduces shadows only in a disposable complete Game 3D project', () => {
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
    import { resolve, sep } from 'node:path';
    import { tmpdir } from 'node:os';
    const ROOT = process.cwd();
    const ARTIFACT_DIR = await mkdtemp(resolve(tmpdir(), 'preview-ci-project-test-'));
    const original = await readFile(resolve(ROOT, 'templates/game-3d/assets/scene.pack.ts'), 'utf8');
    ${functionSource('async function prepareGame3dSmokeProject()', 'const appendServerOutput =')}
    try {
      const root = await prepareGame3dSmokeProject();
      assert.equal(await readFile(resolve(root, 'assets/scene.pack.ts'), 'utf8'), original.replace('mapSize: 2048,', 'mapSize: 256,'));
      assert.equal(await readFile(resolve(ROOT, 'templates/game-3d/assets/scene.pack.ts'), 'utf8'), original);
      const descriptor = JSON.parse(await readFile(resolve(root, 'forge.json'), 'utf8'));
      assert.equal(descriptor.id, 'template-game-3d');
      assert.equal(await readFile(resolve(root, 'assets/player/player.ts'), 'utf8'), await readFile(resolve(ROOT, 'templates/game-3d/assets/player/player.ts'), 'utf8'));
      assert.equal(await readFile(resolve(root, 'assets/runtime-vase/vase-program.ts'), 'utf8'), await readFile(resolve(ROOT, 'templates/game-3d/assets/runtime-vase/vase-program.ts'), 'utf8'));
    } finally { await rm(ARTIFACT_DIR, { recursive: true, force: true }); }
  `,
    ],
    { timeout: 10000, encoding: 'utf8' },
  );
});

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
    let disposed = false;
    let page = {
      isClosed: () => false,
      evaluate: async (fn) => {
        if (fn.toString().includes('postMessage')) { disposed = true; console.log('dispose'); }
        else return true;
      },
      waitForFunction: async () => { if (!disposed) throw new Error('must dispose before destroying page'); },
      close: async () => { if (!disposed) throw new Error('must dispose before destroying page'); console.log('page'); },
    };
    let context = { close: async () => console.log('context') };
    let browser = { close: async () => console.log('browser') };
    let browserServer = { close: async () => console.log('browser') };
    ${functionSource('async function closeSmokeBrowser()', 'async function waitForSubmittedRendererFrame')}
    await closeSmokeBrowser();
  `,
    ],
    { timeout: 5000, encoding: 'utf8' },
  );
  assert.equal(output.trim(), 'dispose\npage\ncontext\nbrowser');
});

test('failed Preview browser shutdown retires its owned process and preserves the failure', () => {
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { setTimeout as sleep } from 'node:timers/promises';
    let activeEvidence, page, context;
    let killed = false;
    const cause = new Error('owned browser shutdown failed');
    let browser = { close: async () => { throw cause; } };
    let browserServer = {
      close: async () => { throw cause; },
      kill: async () => { killed = true; },
    };
    ${functionSource('async function closeSmokeBrowser()', 'async function waitForSubmittedRendererFrame')}
    await assert.rejects(closeSmokeBrowser(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0].cause, cause);
      return true;
    });
    assert.equal(killed, true, 'a failed protocol close must retire the owned browser process');
    assert.equal(browser, undefined);
    assert.equal(browserServer, undefined);
  `,
    ],
    { timeout: 5000, encoding: 'utf8' },
  );
});

test('Preview browser server and client share the original startup deadline and clean failed connections', async () => {
  for (const mode of ['success', 'connection-failure', 'cleanup-failure']) {
    const failure = new Error('connection failed');
    const cleanupFailure = new Error('cleanup failed');
    const times = [0, 2000];
    let launchOptions,
      connectOptions,
      cleaned = 0;
    const server = { wsEndpoint: () => 'ws://owned-browser' };
    const client = {};
    const scope = {
      performance: { now: () => times.shift() },
      process: { env: {} },
      CHROME_CHANNEL: 'chrome',
      CHROME_ARGS: [],
      chromium: {
        launchServer: async (options) => {
          launchOptions = options;
          return server;
        },
        connect: async (endpoint, options) => {
          assert.equal(endpoint, server.wsEndpoint());
          connectOptions = options;
          if (mode !== 'success') throw failure;
          return client;
        },
      },
      closeSmokeBrowser: async () => {
        cleaned++;
        if (mode === 'cleanup-failure') throw cleanupFailure;
      },
    };
    const launch = runInNewContext(
      `let browserServer; ${functionSource('async function launchSmokeBrowser()', 'async function createSmokePage')} launchSmokeBrowser;`,
      scope,
    );
    if (mode === 'success') assert.equal(await launch(), client);
    else
      await assert.rejects(launch(), (error) => {
        if (mode === 'connection-failure') assert.equal(error, failure);
        else assert.deepEqual(Array.from(error.errors), [failure, cleanupFailure]);
        return true;
      });
    assert.equal(launchOptions.timeout, 30_000);
    assert.equal(connectOptions.timeout, 28_000);
    assert.equal(cleaned, mode === 'success' ? 0 : 1);
  }
});

test('Preview dev server does not inherit a production-mode caller', () => {
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { resolve } from 'node:path';
    process.env.NODE_ENV = 'production';
    const ROOT = '/fixture', PORT = 5201;
    const createRequire = () => ({ resolve: () => '/fixture/vite/package.json' });
    let options;
    let server, serverOutput, serverSpawnError, serverExit, stopServer, game3dSmokeRoot;
    const appendServerOutput = () => {};
    const spawn = (_command, _args, value) => { options = value; return { stdout: {on(){}}, stderr:{on(){}}, on(){} }; };
    ${functionSource('function startServer(', 'let browser;')}
    startServer('game-3d');
    assert.equal(options.env.FORGEAX_TEMPLATE_SMOKE_SLUGS, 'game-3d');
    startServer('empty');
    assert.equal(options.env.FORGEAX_TEMPLATE_SMOKE_SLUGS, 'empty');
    assert.equal(options.env.NODE_ENV, 'development');
    assert.equal(options.env.FORGEAX_TEMPLATE_SMOKE, '1');
    assert.equal(process.env.NODE_ENV, 'production');
  `,
    ],
    { timeout: 5000 },
  );
});

test('Preview readiness requires GPU completion within one original deadline', () => {
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    const TEMPLATE_SETTLE_FRAMES = 10;
    let waits = 0;
    const dataset = {};
    globalThis.__forgeaxPreviewInspection = {
      renderer: { health: () => ({ reason: 'alive', frame: { frameId: 2 } }) },
    };
    globalThis.document = { documentElement: { dataset }, querySelector: () => ({ width: 320, height: 240 }) };
    const page = {
      waitForFunction: async (predicate, required, options) => {
        waits += 1;
        assert.equal(options.timeout, 30_000);
        assert.equal(required, true);
        assert.equal(predicate(required), false, 'submitted-only work is not ready');
        assert.equal(predicate(false), true, 'structural-only templates need no GPU receipt');
        dataset.forgeaxFrameCompleted = '0';
        assert.equal(predicate(required), true);
      },
      evaluate: async (_settle, frames) => assert.equal(frames, TEMPLATE_SETTLE_FRAMES),
    };
    ${functionSource('async function waitForTemplateReady(', 'async function smokeGame3dCollision')}
    await waitForTemplateReady();
    assert.equal(waits, 1, 'readiness must not add a second 30-second deadline');
  `,
    ],
    { timeout: 5000 },
  );
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

test('the complete template roster scopes and drains each server serially', () => {
  const loop = source.slice(source.indexOf('for (const template of templates)'));
  assert.match(
    loop,
    /startServer\(template\.slug\);\s*await waitForServerReady\(\);\s*await restartSmokeBrowser\(evidence\);/,
  );
  assert.match(loop, /await smokeTemplate\(template, evidence\);/);
  assert.match(
    loop,
    /await closeSmokeBrowser\(\);\s*await stopServer\(\);\s*if \(game3dSmokeRoot !== undefined\)/,
  );
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

test('the empty template retains its own complete catalog without foreign resource producers', () => {
  const config = readFileSync(
    new URL('../../../apps/preview/vite.config.ts', import.meta.url),
    'utf8',
  );
  const declaration = config.slice(
    config.indexOf('const packRoots ='),
    config.indexOf('const particleSourceRoots ='),
  );
  const rootsFor = (selectedTemplateSlugs) =>
    JSON.parse(
      JSON.stringify(
        runInNewContext(`${declaration}; packRoots`, {
          surfaceOnly: false,
          game3dOnlySmoke:
            selectedTemplateSlugs.length === 1 && selectedTemplateSlugs[0] === 'game-3d',
          selectedTemplateSlugs,
          templatePackRoots: ['scene-owner.pack.ts', 'world.scene.pack.json'],
          externalAssetRoots: ['foreign-font', 'foreign-model'],
          surfaceEvidencePackRoot: 'surface',
          previewUiAuthoringMetaPath: 'ui-authoring',
          process: {
            env: { FORGEAX_TEMPLATE_SMOKE: selectedTemplateSlugs.length > 0 ? '1' : undefined },
          },
          existsSync: () => true,
        }),
      ),
    );
  assert.deepEqual(rootsFor(['empty']), ['scene-owner.pack.ts', 'world.scene.pack.json']);
  assert.deepEqual(rootsFor(['game-3d']), ['scene-owner.pack.ts', 'world.scene.pack.json']);
  assert.deepEqual(rootsFor(['game-capability-lab']), [
    'scene-owner.pack.ts',
    'world.scene.pack.json',
    'foreign-font',
    'foreign-model',
  ]);
  assert.deepEqual(rootsFor([]), [
    'scene-owner.pack.ts',
    'world.scene.pack.json',
    'surface',
    'ui-authoring',
    'foreign-font',
    'foreign-model',
  ]);
});

test('Preview closing evidence is bounded, separate and cannot hide an owned cleanup failure', async () => {
  for (const failed of [false, true]) {
    const evidence = { pageErrors: [], consoleErrors: [] };
    const listeners = new Map();
    const events = [];
    const timers = new Set();
    const deadlines = [];
    const cause = new Error('fixture App disposal did not retire the UI');
    const page = {
      on: (name, handler) => listeners.set(name, handler),
      off: (name, handler) => {
        assert.equal(listeners.get(name), handler);
        listeners.delete(name);
      },
      isClosed: () => false,
      evaluate: async (fn) => {
        if (!fn.toString().includes('postMessage')) return true;
        events.push('dispose');
        listeners.get('pageerror')(new Error('fixture closing rejection'));
        for (let i = 0; i < 40; i++) {
          listeners.get('console')({ type: () => 'error', text: () => 'x'.repeat(4096) });
        }
        listeners.get('console')({
          type: () => {
            throw new Error('observer-only failure');
          },
        });
      },
      waitForFunction: async (_predicate, _argument, options) => {
        assert.equal(options.timeout, 10_000);
        if (failed) throw cause;
      },
      close: async () => {
        events.push('page');
      },
    };
    const scope = {
      activeEvidence: evidence,
      page,
      context: {
        close: async () => {
          events.push('context');
        },
      },
      browser: {},
      browserServer: {
        close: async () => {
          events.push('browser');
        },
      },
      sleep: async (ms) => {
        assert.equal(ms, 250);
      },
      setTimeout: (_callback, ms) => {
        assert.equal(ms, 10_000);
        deadlines.push(ms);
        const token = {};
        timers.add(token);
        return token;
      },
      clearTimeout: (token) => timers.delete(token),
    };
    const close = runInNewContext(
      `${functionSource('async function closeSmokeBrowser()', 'async function waitForSubmittedRendererFrame')} closeSmokeBrowser;`,
      scope,
    );
    if (failed) {
      await assert.rejects(close(), (error) => {
        assert.equal(error.name, 'AggregateError');
        assert.equal(error.errors[0].cause, cause);
        return true;
      });
    } else await close();
    assert.deepEqual(events, ['dispose', 'page', 'context', 'browser']);
    assert.deepEqual(evidence.pageErrors, []);
    assert.deepEqual(evidence.consoleErrors, []);
    assert.equal(evidence.shutdown.events.length, 32);
    assert.equal(evidence.shutdown.droppedEvents, 10);
    assert.equal(evidence.shutdown.events[0].kind, 'pageerror');
    assert.equal(evidence.shutdown.events[0].message, 'fixture closing rejection');
    assert.equal(evidence.shutdown.events[1].message.length, 2048);
    assert.equal(
      evidence.shutdown.phase,
      failed ? 'dispose-message-posted' : 'inspection-and-ui-retired',
    );
    assert.equal(evidence.shutdown.attempts[0].status, failed ? 'failed' : 'completed');
    assert.equal(evidence.shutdown.attempts[0].phase, evidence.shutdown.phase);
    if (failed) assert.match(evidence.shutdown.attempts[0].cause, /fixture App disposal/);
    assert.equal(evidence.shutdown.attempts.length, 4);
    assert.equal(deadlines.length, 4);
    assert.equal(timers.size, 0);
    assert.equal(listeners.size, 0);
    assert.equal(scope.activeEvidence, undefined);
    assert.equal(scope.page, undefined);
    assert.equal(scope.browserServer, undefined);
  }
});
