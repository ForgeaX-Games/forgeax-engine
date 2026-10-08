import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { verifySdkViewRuntime } from '../sdk-lib.mjs';
import {
  aggregateSdkConsumers,
  checkSeed,
  SDK_PR_CONSUMERS,
  writeSeedChecksums,
} from '../sdk-pr-preflight.mjs';

const head = 'a'.repeat(40);
const version = `0.0.0-pr.${head}`;
const reports = SDK_PR_CONSUMERS.map((group) => ({
  ok: true,
  group,
  sdkVersion: version,
  engineCommit: head,
  viewCommit: 'b'.repeat(40),
  sha256: 'c'.repeat(64),
}));

test('the required SDK aggregate rejects missing, duplicate, failed or mismatched consumers', () => {
  assert.equal(aggregateSdkConsumers(reports, head, version).ok, true);
  assert.throws(() => aggregateSdkConsumers(reports.slice(1), head, version));
  assert.throws(() =>
    aggregateSdkConsumers([reports[0], reports[0], ...reports.slice(2)], head, version),
  );
  for (const mutation of [
    { ok: false },
    { engineCommit: 'd'.repeat(40) },
    { sha256: 'd'.repeat(64) },
    { viewCommit: 'd'.repeat(40) },
    { sdkVersion: 'different' },
  ])
    assert.throws(() =>
      aggregateSdkConsumers([{ ...reports[0], ...mutation }, ...reports.slice(1)], head, version),
    );
});

test('seed transfer verifies every ZIP and npm payload byte and the exact build identity', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'sdk-pr-seed-test-'));
  try {
    mkdirSync(resolve(root, 'npm/packages'), { recursive: true });
    const zip = resolve(root, `forgeax-sdk-v${version}.zip`);
    const carrier = resolve(root, `npm/forgeax-engine-sdk-${version}.tgz`);
    const pkg = resolve(root, 'npm/packages/engine.tgz');
    writeFileSync(zip, 'zip-bytes');
    writeFileSync(carrier, 'carrier');
    writeFileSync(pkg, 'package');
    writeFileSync(
      resolve(root, 'sdk-build-result.json'),
      JSON.stringify({
        ok: true,
        engineCommit: head,
        sdkVersion: version,
        sha256: createHash('sha256').update(readFileSync(zip)).digest('hex'),
        npm: { packageCount: 1 },
      }),
    );
    writeSeedChecksums(root, version);
    assert.equal(checkSeed(root, head, version).ok, true);
    assert.throws(() => checkSeed(root, 'd'.repeat(40), version));
    writeFileSync(pkg, 'Package');
    assert.throws(() => checkSeed(root, head, version), /byte-closure/);
    writeFileSync(pkg, 'package');
    rmSync(carrier);
    assert.throws(() => checkSeed(root, head, version), /byte-closure/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archive group selection is explicit while release qualification retains the complete default', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../verify-sdk.mjs'), 'utf8');
  assert.match(source, /groupIndex < 0 \? 'all'/);
  assert.match(source, /sdk-verify-unknown-group/);
  assert.match(
    source,
    /if\s*\(selected\('source'\)\)\s*\{\s*await sdkStage\('buildSourceSnapshot'/,
  );
  const project = source.slice(
    source.indexOf("if (selected('project'))"),
    source.indexOf('async function verifySourceTemplate'),
  );
  assert.match(project, /verifySelectedTemplate/);
  const publicSource = source.slice(
    source.indexOf("if (selected('source'))"),
    source.indexOf("if (selected('view'))"),
  );
  assert.match(publicSource, /verifySourceTemplate/);
  assert.match(publicSource, /verifyPublicSourceViewTool/);
  const installed = source.slice(source.indexOf("if (selected('view'))"));
  assert.match(installed, /verifyPairedViewTool/);
  assert.match(installed, /selected\('project'\)[\s\S]*verifyInstalledViewRuntime/);
  assert.match(installed, /sdk-consumer-mutated-store/);
});

test('public source preparation completes before consumers start and is absent from other groups', async () => {
  const source = readFileSync(resolve(import.meta.dirname, '../verify-sdk.mjs'), 'utf8');
  const body = source.slice(
    source.indexOf("if (selected('source'))"),
    source.indexOf('const initializedSdk'),
  );
  const execute = new (Object.getPrototypeOf(async () => {}).constructor)(
    'selected',
    'sdkStage',
    'sourceBuildPnpm',
    'consumerReady',
    `${body}\nconsumerReady();`,
  );
  for (const group of ['source', 'project', 'view']) {
    const commands = [];
    const stages = [];
    let ready = false;
    let release;
    const running = execute(
      (candidate) => candidate === group,
      (label, work) => {
        stages.push(label);
        return new Promise((resolveStage) => {
          release = () => resolveStage(work());
        });
      },
      async (args) => {
        commands.push(args);
      },
      () => {
        ready = true;
      },
    );
    if (group === 'source') {
      assert.equal(ready, false, 'a consumer cannot retire input while source preparation is live');
      assert.deepEqual(stages, ['buildSourceSnapshot']);
      release();
    }
    await running;
    assert.equal(ready, true);
    assert.deepEqual(
      commands,
      group === 'source'
        ? [
            ['install', '--frozen-lockfile', '--ignore-scripts'],
            ['build:engine'],
            ['build:tools'],
            ['build:app', 'preview'],
          ]
        : [],
    );
    assert.deepEqual(stages, group === 'source' ? ['buildSourceSnapshot'] : []);
  }
});

test('archive groups conserve independent inputs and both installed View journeys within four consumers', async () => {
  const source = readFileSync(resolve(import.meta.dirname, '../verify-sdk.mjs'), 'utf8');
  const body = source
    .slice(
      source.lastIndexOf("if (selected('view'))"),
      source.indexOf('\nfor (const expected of manifest.artifacts.filter'),
    )
    .replaceAll('import.meta.dirname', JSON.stringify(resolve(import.meta.dirname, '..')));
  const execute = new (Object.getPrototypeOf(async () => {}).constructor)(
    'group',
    'selected',
    'sdkStage',
    'execFileAsync',
    'verifySdkViewRuntime',
    'resolve',
    'sdkRoot',
    'offlineEnv',
    'archive',
    'dirname',
    body,
  );
  const observed = {};
  const independentCommands = [];
  for (const group of ['project', 'source', 'view', 'all']) {
    const stages = [];
    await execute(
      group,
      (owner) => group === 'all' || group === owner,
      async (stage, run) => {
        stages.push(stage);
        await run();
      },
      async (executable, args, options) => {
        if (args[0].endsWith('verify-independent-run.mjs'))
          independentCommands.push({
            group,
            executable,
            engine: options.env.FORGEAX_INDEPENDENT_ENGINE_PACKAGE,
          });
        return { stdout: '', stderr: '' };
      },
      async () => {},
      resolve,
      '/sdk',
      {},
      '/sdk.zip',
      dirname,
    );
    observed[group] = stages;
  }
  assert.deepEqual(observed, {
    project: ['verifyInstalledViewRuntime'],
    source: [],
    view: ['verifyIndependentRun', 'verifyPairedViewTool', 'verifyInstalledViewRuntimeJS'],
    all: ['verifyIndependentRun', 'verifyPairedViewTool', 'verifyInstalledViewRuntime'],
  });
  assert.deepEqual(
    independentCommands,
    ['view', 'all'].map((group) => ({
      group,
      executable: process.execPath,
      engine: '/sdk/.forgeax/cli-runtime/node_modules/@forgeax/engine',
    })),
  );
  assert.equal(observed.view.filter((stage) => stage === 'verifyInstalledViewRuntimeJS').length, 1);
  assert.equal(
    observed.project.filter((stage) => stage === 'verifyInstalledViewRuntime').length,
    1,
  );
});

test('the real installed View scheduler preserves language publication chains and the full default', async () => {
  const runtimeScript = `
    import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
    import { resolve } from 'node:path';
    import assert from 'node:assert/strict';
    const env = process.env, language = env.FORGEAX_RUNTIME_PACK_LANGUAGE;
    for (const key of ['NODE_PATH','FORGEAX_SHARED_APP_INPUTS_MANIFEST','FORGEAX_LOCAL_ENGINE','FORGEAX_RUNTIME_PACK_DIRECT'])
      assert.equal(env[key], undefined, key);
    if (env.FORGEAX_RUNTIME_PACK_SNAPSHOT)
      assert.equal(readFileSync(env.FORGEAX_RUNTIME_PACK_SNAPSHOT,'utf8'), language);
    else {
      mkdirSync(env.FORGEAX_EVIDENCE_DIR,{recursive:true});
      writeFileSync(resolve(env.FORGEAX_EVIDENCE_DIR,'saved-content.json'),language);
    }
    appendFileSync(env.FORGEAX_TEST_RECEIPT, language + (env.FORGEAX_RUNTIME_PACK_SNAPSHOT ? '-cold' : '-live') + '\\n');
  `;
  const observed = {};
  for (const group of ['all', 'view', 'project']) {
    const root = mkdtempSync(resolve(tmpdir(), 'sdk-view-language-chain-'));
    try {
      const scripts = resolve(root, '.forgeax/cli-runtime/node_modules/@forgeax/view/scripts');
      const receipt = resolve(root, 'receipt.txt');
      mkdirSync(scripts, { recursive: true });
      writeFileSync(resolve(scripts, 'verify-runtime-content-engine.mjs'), runtimeScript);
      writeFileSync(
        resolve(scripts, 'verify-game3d-workspace.mjs'),
        `import {appendFileSync} from 'node:fs'; appendFileSync(process.env.FORGEAX_TEST_RECEIPT,'game3d\\n');`,
      );
      const options = {
        sdkRoot: root,
        evidenceRoot: resolve(root, 'evidence'),
        env: {
          ...process.env,
          FORGEAX_TEST_RECEIPT: receipt,
          NODE_PATH: '/forbidden',
          FORGEAX_SHARED_APP_INPUTS_MANIFEST: '/forbidden',
          FORGEAX_LOCAL_ENGINE: '/forbidden',
          FORGEAX_RUNTIME_PACK_DIRECT: '/forbidden',
        },
      };
      await verifySdkViewRuntime(group === 'all' ? options : { ...options, group });
      observed[group] = readFileSync(receipt, 'utf8').trim().split('\n');
      await assert.rejects(verifySdkViewRuntime({ ...options, group: 'missing' }), /unknown-group/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  assert.deepEqual(observed.all, ['js-live', 'js-cold', 'ts-live', 'ts-cold', 'game3d']);
  assert.deepEqual(observed.view, ['js-live', 'js-cold']);
  assert.deepEqual(observed.project, ['ts-live', 'ts-cold', 'game3d']);
  assert.deepEqual([...observed.view, ...observed.project], observed.all);
});

test('the real SDK page-readiness route activates the page before asynchronous gameplay inspection', async () => {
  const source = readFileSync('scripts/forgeax/verify-sdk.mjs', 'utf8');
  const declaration = source.slice(
    source.indexOf('  async function waitForProjectPage('),
    source.indexOf('  async function readSelectedPlayerProjection('),
  );
  let foreground = false;
  const calls = [];
  const page = {
    on() {},
    async bringToFront() {
      foreground = true;
      calls.push('focus');
    },
    async goto() {
      assert.ok(
        foreground,
        'a background page cannot service the Engine Worker inspection boundary',
      );
      calls.push('navigate');
    },
    async waitForFunction() {},
    async evaluate() {
      assert.ok(foreground);
      calls.push('inspection');
      return true;
    },
  };
  const open = new Function(
    'sdkStage',
    'appendDiagnostic',
    'frameTimeoutDiagnostics',
    `${declaration} return waitForProjectPage;`,
  )(
    (_label, operation) => operation(),
    () => {},
    async () => ({}),
  );
  const result = await open(
    page,
    'http://sdk-fixture.invalid',
    { pageErrors: [], consoleErrors: [], failedResponses: [] },
    'movement',
  );
  assert.equal(result, undefined);
  assert.deepEqual(calls, ['focus', 'navigate', 'inspection']);
});

for (const failureAt of ['page readiness', 'player read']) {
  test(`the real SDK ${failureAt} rejection retains its page and diagnostics through cleanup`, async () => {
    const source = readFileSync('scripts/forgeax/verify-sdk.mjs', 'utf8');
    const declaration = source.slice(
      source.indexOf('  async function verifyProjectBrowser('),
      source.indexOf('  async function waitForProjectPackCatalog('),
    );
    const cause = new Error('player read stalled');
    const calls = [];
    const page = { evaluate: async () => ({ canvas: { width: 320, height: 180 } }) };
    const deps = {
      LIVE_DEV_STARTUP_TIMEOUT_MS: 1_000,
      spawnProjectServer: () => ({
        exitCode: 0,
        once: (_event, callback) => queueMicrotask(() => callback(0)),
        stdout: { on: (_event, callback) => callback('{"command":"dev","ok":true,"value":{}}\n') },
        stderr: { on() {} },
      }),
      sdkStage: (_label, operation) => operation(),
      liveProjectUrl: async () => 'http://sdk-fixture.invalid',
      waitForProjectPackCatalog: async () => {},
      launchSelectedBrowser: async () => ({}),
      createProjectPage: async () => page,
      waitForProjectPage: async () => {
        if (failureAt === 'page readiness') throw cause;
      },
      readSelectedPlayerProjection: async () => {
        throw cause;
      },
      boundedTail: (value) => value,
      frameTimeoutDiagnostics: async (actualPage, diagnostics, phase) => {
        assert.equal(actualPage, page);
        assert.equal(phase, 'gameplay');
        assert.deepEqual(diagnostics.pageErrors, []);
        assert.match(diagnostics.serverOutput().stdout, /"command":"dev"/);
        calls.push('diagnostics');
        return { phase, renderer: { state: 'alive' } };
      },
      closeSelectedPage: async () => calls.push('page'),
      closeSelectedBrowser: async () => calls.push('browser'),
      stopLiveProject: async () => calls.push('server'),
    };
    const verify = new Function(
      ...Object.keys(deps),
      `${declaration} return verifyProjectBrowser;`,
    )(...Object.values(deps));
    await assert.rejects(verify('/fixture', 'scope'), (error) => {
      assert.equal(error.cause, cause);
      assert.match(error.message, /sdk-selected-gameplay-failed/);
      assert.match(error.message, /"state":"alive"/);
      return true;
    });
    assert.deepEqual(calls, ['diagnostics', 'page', 'browser', 'server']);
  });
}
