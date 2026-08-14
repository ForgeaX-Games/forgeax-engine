import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { test } from 'node:test';

const repoRoot = resolve(import.meta.dirname, '../../..');
const ciWorkflow = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8');
const nightlyWorkflow = readFileSync(resolve(repoRoot, '.github/workflows/nightly.yml'), 'utf8');
const evidenceWorkflow = readFileSync(
  resolve(repoRoot, '.github/workflows/emscripten-no-xz-evidence.yml'),
  'utf8',
);
const evidenceScript = resolve(repoRoot, 'scripts/ci/evidence/emscripten-no-xz.mjs');
const testNodePath = resolve(process.execPath);
const testNodeSha256 = `sha256:${createHash('sha256').update(readFileSync(testNodePath)).digest('hex')}`;
const testNodeAliasDir = mkdtempSync(join(tmpdir(), 'forgeax-node-alias-'));
const testNodeAlias = join(testNodeAliasDir, 'node');
symlinkSync(testNodePath, testNodeAlias);
const {
  compareEvidence,
  normalizeBootstrapNodeAuthority,
  createControlledLanePath,
  probeXz,
  runCompilerPreflight,
  runConsumer,
  validateBootstrapToolchainLayout,
  validateEnvelope,
} = await import(evidenceScript);

function jobSection(workflow, name) {
  const start = workflow.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `missing workflow job ${name}`);
  const remaining = workflow.slice(start);
  const nextJob = remaining.slice(1).search(/\n {2}[a-z][\w-]+:/);
  return remaining.slice(0, nextJob === -1 ? undefined : nextJob + 1);
}

function stepIndex(workflow, name) {
  const index = workflow.indexOf(`- name: ${name}`);
  assert.notEqual(index, -1, `missing workflow step ${name}`);
  return index;
}

function stepSection(workflow, name) {
  const start = stepIndex(workflow, name);
  const remaining = workflow.slice(start);
  const nextStep = remaining.slice(1).search(/\n {6}- (?:name:|uses:)/);
  return remaining.slice(0, nextStep === -1 ? undefined : nextStep + 1);
}

function assertLinuxOnly(workflow, command, label) {
  let offset = 0;
  let count = 0;
  while (true) {
    const found = workflow.indexOf(command, offset);
    if (found === -1) break;
    count += 1;
    const before = workflow.slice(0, found);
    const stepStart = before.lastIndexOf('\n      - name:');
    const scope = workflow.slice(Math.max(0, stepStart), found);
    assert.match(
      scope,
      /runner\.os\s*==\s*['"]Linux['"]|runs-on:.*Linux|\["self-hosted",\s*"Linux"/s,
      `${label} must be scoped to Linux`,
    );
    offset = found + command.length;
  }
  assert.ok(count > 0, `${label} must be present`);
}

function platformOrderAudit() {
  return {
    linux: {
      status: 'proven',
      workflowRunId: '31685331312',
      gateRunIds: { cold: '94399940428', warm: '94402063505' },
      gate: 'pass',
    },
    macos: {
      status: 'unproven',
      workflowRunId: null,
      gate: 'unproven',
      reason: 'No real macOS nightly run is available from this Darwin host.',
    },
    windows: {
      status: 'unproven',
      workflowRunId: null,
      gate: 'unproven',
      reason: 'No real Windows nightly run is available from this Darwin host.',
    },
  };
}

function localCapabilityAudit() {
  const linux = platformOrderAudit().linux;
  return {
    host: { os: process.platform, arch: process.arch },
    localChecks: ['helper', 'schema', 'contract', 'static-workflow'],
    localAcceptance: false,
    remoteEvidence: [
      { name: 'linux-x86_64-cold-warm', ...linux },
      { name: 'macos-nightly', status: 'unproven' },
      { name: 'windows-nightly', status: 'unproven' },
    ],
  };
}

function featureChangedFiles() {
  const base = execFileSync('git', ['merge-base', 'origin/main', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  return execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean);
}

test('no-xz bootstrap is Linux-only and absent from portability-bun', () => {
  const command = 'python3 scripts/ci/setup-emscripten-no-xz.py';
  assertLinuxOnly(ciWorkflow, command, 'ci no-xz helper');
  assertLinuxOnly(nightlyWorkflow, command, 'nightly no-xz helper');
  assert.doesNotMatch(jobSection(ciWorkflow, 'portability-bun'), /setup-emscripten-no-xz\.py/);
});

test('Linux nightly prepares .nvmrc Node before the no-xz helper', () => {
  const linuxNode = stepSection(nightlyWorkflow, 'Setup Node.js for Linux Emscripten');
  const helper = stepSection(nightlyWorkflow, 'Setup Emscripten without external xz (Linux)');
  assert.match(linuxNode, /if:\s+runner\.os\s*==\s*['"]Linux['"]/);
  assert.match(linuxNode, /node-version-file:\s*\.nvmrc/);
  assert.ok(
    stepIndex(nightlyWorkflow, 'Setup Node.js for Linux Emscripten') <
      stepIndex(nightlyWorkflow, 'Setup Emscripten without external xz (Linux)'),
  );
  assert.match(helper, /if:\s+runner\.os\s*==\s*['"]Linux['"]/);
});

test('production Linux cache misses prepare and pass the locked archive inputs', () => {
  for (const [label, workflow] of [
    ['ci', ciWorkflow],
    ['nightly', nightlyWorkflow],
  ]) {
    const restore = stepIndex(workflow, 'Restore Emscripten no-xz cache (Linux)');
    const prepare = stepIndex(workflow, 'Prepare pinned Emscripten archive (Linux cache miss)');
    const setup = stepIndex(workflow, 'Setup Emscripten without external xz (Linux)');
    assert.ok(restore < prepare && prepare < setup, `${label} archive order`);
    const preparation = stepSection(
      workflow,
      'Prepare pinned Emscripten archive (Linux cache miss)',
    );
    assert.match(preparation, /if:.*runner\.os\s*==\s*['"]Linux['"]/);
    assert.match(preparation, /steps\.emsdk-no-xz-cache\.outputs\.cache-hit\s*!=\s*['"]true['"]/);
    assert.match(preparation, /prepare-emscripten-no-xz-archive\.py/);
    assert.match(preparation, /--lock\s+scripts\/ci\/emscripten-no-xz\.lock\.json/);
    assert.match(
      preparation,
      /--archive\s+"\$RUNNER_TEMP\/emscripten-no-xz\/wasm-binaries\.tar\.xz"/,
    );
    assert.match(preparation, /--github-env\s+"\$GITHUB_ENV"/);
    const helper = stepSection(workflow, 'Setup Emscripten without external xz (Linux)');
    assert.match(helper, /if:.*runner\.os\s*==\s*['"]Linux['"]/);
    assert.match(helper, /steps\.emsdk-no-xz-cache\.outputs\.cache-hit/);
    assert.match(helper, /--archive\s+"\$RUNNER_TEMP\/emscripten-no-xz\/wasm-binaries\.tar\.xz"/s);
    assert.match(helper, /--release-metadata\s+scripts\/ci\/emscripten-no-xz\.lock\.json/s);
    assert.match(helper, /--archive-sha256\s+"\$EMSCRIPTEN_NO_XZ_ARCHIVE_SHA256"/s);
    assert.match(
      workflow,
      /hashFiles\([^)]*setup-emscripten-no-xz\.py[^)]*emscripten-no-xz\.lock\.json[^)]*\.nvmrc/,
    );
    assert.doesNotMatch(
      workflow,
      /hashFiles\([^)]*prepare-emscripten-no-xz-archive\.py/,
      `${label} archive downloader must not invalidate the toolchain cache identity`,
    );
  }
});

test('non-Linux nightly keeps upstream Emscripten setup', () => {
  const setup = stepSection(nightlyWorkflow, 'Setup Emscripten (non-Linux upstream)');
  assert.match(setup, /if:\s+runner\.os\s*!=\s*['"]Linux['"]/);
  assert.match(setup, /emscripten-core\/setup-emsdk@v16/);
});

test('macOS and Windows keep the upstream Emscripten, consumer, pnpm, Node order', () => {
  const names = [
    'Setup Emscripten (non-Linux upstream)',
    'Build fbx-wasm',
    'Build basis-wasm',
    'Read pnpm version',
    'Setup pnpm',
    'Setup Node.js (non-Linux upstream)',
  ];
  const indexes = names.map((name) => stepIndex(nightlyWorkflow, name));
  for (let index = 1; index < indexes.length; index += 1) {
    assert.ok(
      indexes[index - 1] < indexes[index],
      `${names[index - 1]} must precede ${names[index]}`,
    );
  }
  assert.match(
    stepSection(nightlyWorkflow, 'Setup Node.js (non-Linux upstream)'),
    /if:\s+runner\.os\s*!=\s*['"]Linux['"]/,
  );
});

test('platform order audit records unavailable non-Linux runs as unproven', () => {
  const audit = platformOrderAudit();
  assert.deepEqual(audit.linux, {
    status: 'proven',
    workflowRunId: '31685331312',
    gateRunIds: { cold: '94399940428', warm: '94402063505' },
    gate: 'pass',
  });
  for (const platform of ['macos', 'windows']) {
    assert.equal(audit[platform].status, 'unproven', platform);
    assert.equal(audit[platform].workflowRunId, null, platform);
    assert.equal(audit[platform].gate, 'unproven', platform);
    assert.match(audit[platform].reason, /No real/);
  }
});

test('local capability audit never claims remote platform acceptance', () => {
  const audit = localCapabilityAudit();
  const expectedLinux = platformOrderAudit().linux;
  assert.deepEqual(audit.host, { os: process.platform, arch: process.arch });
  assert.deepEqual(audit.localChecks, ['helper', 'schema', 'contract', 'static-workflow']);
  assert.equal(audit.localAcceptance, false);
  assert.deepEqual(audit.remoteEvidence[0], {
    name: 'linux-x86_64-cold-warm',
    ...expectedLinux,
  });
  for (const evidence of audit.remoteEvidence.slice(1)) {
    assert.equal(evidence.status, 'unproven');
  }
  if (process.platform === 'darwin') assert.equal(process.arch, 'arm64');
});

test('feature scope excludes consumer surfaces, generated outputs, and generic cache refactors', () => {
  const changedFiles = featureChangedFiles();
  const consumerSurface = changedFiles.filter((path) =>
    /^(?:packages\/(?:fbx|codec)\/)/.test(path),
  );
  assert.deepEqual(consumerSurface, []);

  const generatedOutputs = execFileSync(
    'git',
    ['ls-files', '--', 'packages/fbx/pkg', 'packages/codec/pkg'],
    { cwd: repoRoot, encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.deepEqual(generatedOutputs, []);

  const genericRefactors = changedFiles.filter((path) =>
    /^(?:scripts\/(?:cache|release)|scripts\/lib\/ensure-wasm-lib\.mjs)/.test(path),
  );
  assert.deepEqual(genericRefactors, []);
});

test('independent evidence workflow runs from the feature branch or its main PR', () => {
  const events = evidenceWorkflow.slice(0, evidenceWorkflow.indexOf('concurrency:'));
  assert.match(events, /workflow_dispatch:/);
  assert.match(
    events,
    /push:\s+branches:\s+- forgeax\/feat-20260813-emscripten-linux-bootstrap-without-external-xz/s,
  );
  assert.match(events, /pull_request:\s+branches:\s+- main/s);
  assert.match(events, /types: \[opened, synchronize, reopened\]/);
  assert.match(events, /paths:\s+- \.github\/workflows\/emscripten-no-xz-evidence\.yml/s);
});

test('independent evidence workflow invokes exact cold and warm predicates', () => {
  const cold = jobSection(evidenceWorkflow, 'cold');
  const warm = jobSection(evidenceWorkflow, 'warm');
  assert.match(
    cold,
    /cd "\$GITHUB_WORKSPACE" && rm -rf "\$GITHUB_WORKSPACE\/artifacts\/emscripten\/cold" "\$GITHUB_WORKSPACE\/emsdk-cache" "\$RUNNER_TEMP\/emscripten-no-xz-cold-consumer-cache" "\$RUNNER_TEMP\/emscripten-no-xz-cold-hydration" packages\/fbx\/pkg packages\/codec\/pkg/s,
  );
  assert.match(
    cold,
    /node scripts\/ci\/evidence\/emscripten-no-xz\.mjs --mode cold --evidence-dir "\$GITHUB_WORKSPACE\/artifacts\/emscripten\/cold"/s,
  );
  assert.match(cold, /Fetch pinned Linux Emscripten archive/);
  assert.match(cold, /prepare-emscripten-no-xz-archive\.py/);
  assert.match(cold, /--lock\s+"\$EMSCRIPTEN_NO_XZ_LOCK"/s);
  assert.match(cold, /--archive\s+"\$EMSCRIPTEN_NO_XZ_ARCHIVE"/s);
  assert.match(cold, /--github-env\s+"\$GITHUB_ENV"/s);
  assert.doesNotMatch(cold, /urlopen|lock\["archiveUrl"\]|lock\["archiveSha256"\]/s);
  assert.doesNotMatch(cold, /d574428df9ecf00790e28636bdc47027432737c31621b18cdb418123afda4ac1/);
  assert.doesNotMatch(cold, /storage\.googleapis\.com\/webassembly\/emscripten-releases-builds/);
  assert.match(
    cold,
    /--archive "\$RUNNER_TEMP\/emscripten-no-xz-cold-archive\/wasm-binaries\.tar\.xz" --release-metadata scripts\/ci\/emscripten-no-xz\.lock\.json/s,
  );
  assert.match(cold, /--archive-sha256 "\$EMSCRIPTEN_NO_XZ_ARCHIVE_SHA256"/s);
  assert.match(cold, /e\.status==="ready",e\.mode==="cold",e\.cache\?\.status==="cold-created"/s);
  assert.doesNotMatch(cold, /e\.cacheStatus/);
  assert.match(
    warm,
    /cd "\$GITHUB_WORKSPACE" && rm -rf "\$GITHUB_WORKSPACE\/artifacts\/emscripten\/warm" "\$RUNNER_TEMP\/emscripten-no-xz-warm-consumer-cache" "\$RUNNER_TEMP\/emscripten-no-xz-warm-hydration" packages\/fbx\/pkg packages\/codec\/pkg/s,
  );
  assert.match(
    warm,
    /node scripts\/ci\/evidence\/emscripten-no-xz\.mjs --mode warm --cold-evidence "\$GITHUB_WORKSPACE\/artifacts\/emscripten\/cold\/evidence\.json" --evidence-dir "\$GITHUB_WORKSPACE\/artifacts\/emscripten\/warm"/s,
  );
  assert.match(
    warm,
    /e\.status==="ready",e\.mode==="warm",e\.cache\?\.status==="exact-valid",e\.comparison\?\.equivalent===true/s,
  );
  assert.doesNotMatch(warm, /e\.cacheStatus/);
  assert.match(cold, /if-no-files-found: error/);
  assert.match(warm, /if-no-files-found: error/);
  assert.match(warm, /Require exact Emscripten cache hit/);
});

test('independent evidence jobs provision pnpm and frozen workspace dependencies first', () => {
  for (const jobName of ['cold', 'warm']) {
    const job = jobSection(evidenceWorkflow, jobName);
    const readVersion = job.indexOf('- name: Read pnpm version');
    const setupPnpm = job.indexOf('uses: pnpm/action-setup@v5');
    const setupNode = job.indexOf('uses: actions/setup-node@v5');
    const clearLinks = job.indexOf('- name: Clear stale root dependency links');
    const install = job.indexOf('- name: Install workspace dependencies');
    const evidence = job.indexOf('node scripts/ci/evidence/emscripten-no-xz.mjs');
    assert.ok(readVersion >= 0, `${jobName} must read package.json packageManager`);
    assert.ok(setupPnpm > readVersion, `${jobName} pnpm setup must follow version read`);
    assert.ok(setupNode > setupPnpm, `${jobName} Node setup must follow pnpm setup`);
    assert.ok(clearLinks > setupNode, `${jobName} stale links must clear after Node setup`);
    assert.ok(install > clearLinks, `${jobName} install must follow stale-link cleanup`);
    assert.ok(evidence > install, `${jobName} evidence must follow dependency install`);
    assert.match(job, /packageManager/);
    assert.match(
      job,
      /uses: pnpm\/action-setup@v5[\s\S]*?version: \$\{\{ steps\.pnpm-version\.outputs\.value \}\}/,
    );
    assert.match(job, /pnpm install --frozen-lockfile --ignore-scripts/);
  }
});

function validEnvelope(overrides = {}) {
  return {
    schemaVersion: 1,
    status: 'ready',
    mode: 'cold',
    source: {
      sha: '0123456789abcdef0123456789abcdef01234567',
      repository: 'forgeax-engine',
    },
    run: {
      id: 'run-123',
      attempt: 1,
      workflow: 'emscripten-no-xz-evidence',
    },
    runner: {
      os: 'Linux',
      arch: 'x86_64',
      name: 'self-hosted-linux-x64',
    },
    xz: {
      checkedCommands: ['xz', 'unxz', 'xz-utils', 'xzcat', 'xzdec', 'pixz'],
      available: false,
      installAttempted: false,
      invocationDetected: false,
      lanePathControlled: true,
      laneCommandPaths: {
        xz: false,
        unxz: false,
        'xz-utils': false,
        xzcat: false,
        xzdec: false,
        pixz: false,
      },
      hostCommandPaths: {
        xz: false,
        unxz: false,
        'xz-utils': false,
        xzcat: false,
        xzdec: false,
        pixz: false,
      },
      hostPackageStatus: 'not-installed',
      pythonLzmaUsed: true,
    },
    cache: {
      status: 'cold-created',
      key: 'emsdk-no-xz-linux-x86_64-6.0.2',
      matchedKey: null,
      fingerprint: {
        emscriptenVersion: '6.0.2',
        releaseIdentity: 'releases-004876f1984e18a9eb0736c5ca417ac86d386fb8-64bit',
        runnerOs: 'Linux',
        runnerArch: 'x86_64',
        bootstrapInputDigest:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    },
    compiler: {
      emscriptenVersion: '6.0.2',
      releaseIdentity: 'releases-004876f1984e18a9eb0736c5ca417ac86d386fb8-64bit',
      emccPath: '/opt/emsdk/emcc',
      fingerprint: {
        emscriptenVersion: '6.0.2',
        releaseIdentity: 'releases-004876f1984e18a9eb0736c5ca417fb8-64bit'.replace(
          '417fb8',
          '417ac86d386fb8',
        ),
        runnerOs: 'Linux',
        runnerArch: 'x86_64',
        bootstrapInputDigest:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    },
    node: {
      expectedVersion: '22.22.3',
      nodeVersion: 'v22.22.3',
      nodePath: testNodePath,
      emsdkNode: testNodePath,
      executableSha256: testNodeSha256,
      bundledNodePaths: [],
    },
    emcc: {
      invocations: [
        { id: 'fbx-1', consumer: 'fbx', command: ['emcc', 'ufbx.c'], exitCode: 0 },
        { id: 'codec-1', consumer: 'codec', command: ['emcc', 'basis.cpp'], exitCode: 0 },
      ],
    },
    consumer: [
      {
        name: 'fbx',
        invocationIds: ['fbx-1'],
        outputNames: ['pkg/fbx-wasm.mjs', 'pkg/fbx-wasm.wasm'],
        gateIds: ['fbx-build'],
      },
      {
        name: 'codec',
        invocationIds: ['codec-1'],
        outputNames: [
          'pkg/basis_transcoder.mjs',
          'pkg/basis_transcoder.wasm',
          'pkg/encode/basis_encoder.mjs',
          'pkg/encode/basis_encoder.wasm',
        ],
        gateIds: ['codec-build'],
      },
    ],
    output: {
      files: [
        {
          consumer: 'fbx',
          name: 'pkg/fbx-wasm.mjs',
          outputSha256: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
        {
          consumer: 'fbx',
          name: 'pkg/fbx-wasm.wasm',
          outputSha256: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        },
        {
          consumer: 'codec',
          name: 'pkg/basis_transcoder.mjs',
          outputSha256: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        },
        {
          consumer: 'codec',
          name: 'pkg/basis_transcoder.wasm',
          outputSha256: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        },
        {
          consumer: 'codec',
          name: 'pkg/encode/basis_encoder.mjs',
          outputSha256: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        },
        {
          consumer: 'codec',
          name: 'pkg/encode/basis_encoder.wasm',
          outputSha256: 'sha256:9999999999999999999999999999999999999999999999999999999999999999',
        },
      ],
    },
    gate: {
      results: [
        { id: 'fbx-build', consumer: 'fbx', name: 'build-wasm', status: 'pass' },
        { id: 'codec-build', consumer: 'codec', name: 'build-wasm', status: 'pass' },
      ],
    },
    ...overrides,
  };
}

function runValidator(envelope) {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-emscripten-evidence-'));
  const path = join(root, 'envelope.json');
  writeFileSync(path, `${JSON.stringify(envelope)}\n`);
  try {
    return execFileSync(process.execPath, [evidenceScript, '--validate', path], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? '',
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('cold and warm evidence envelopes validate and derive their summary', () => {
  const result = runValidator(validEnvelope());
  assert.equal(result.status, undefined);
  const payload = JSON.parse(result);
  assert.equal(payload.status, 'ready');
  assert.equal(payload.summary.sourceSha, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(payload.summary.consumerCount, 2);
  assert.equal(payload.summary.nodeIdentity.executableSha256, testNodeSha256);

  const warm = validEnvelope({
    mode: 'warm',
    cache: {
      ...validEnvelope().cache,
      status: 'exact-valid',
      matchedKey: 'emsdk-no-xz-linux-x86_64-6.0.2',
    },
  });
  const warmResult = runValidator(warm);
  assert.equal(warmResult.status, undefined);
  assert.equal(JSON.parse(warmResult).summary.mode, 'warm');
});

test('warm comparison ignores runner-local Node paths but requires version and executable SHA', () => {
  const cold = validEnvelope();
  const warm = validEnvelope({
    mode: 'warm',
    node: {
      ...cold.node,
      nodePath: testNodeAlias,
      emsdkNode: testNodeAlias,
    },
  });
  const equivalent = compareEvidence(cold, warm);
  assert.equal(equivalent.nodeEqual, true);
  assert.equal(equivalent.equivalent, true);

  const changedSha = validEnvelope({
    mode: 'warm',
    node: { ...cold.node, executableSha256: `sha256:${'c'.repeat(64)}` },
  });
  assert.equal(compareEvidence(cold, changedSha).nodeEqual, false);
});

test('historical cold Node paths validate portably while current envelopes stay local', () => {
  const cold = validEnvelope({
    node: {
      ...validEnvelope().node,
      nodePath: '/runner-a/setup/node',
      emsdkNode: '/runner-a/setup/node',
      executableSha256: `sha256:${'a'.repeat(64)}`,
    },
  });
  assert.equal(validateEnvelope(cold, { nodePathMode: 'portable' }), null);
  assert.equal(validateEnvelope(cold)?.reason, 'node-path-missing');
  assert.equal(compareEvidence(cold, validEnvelope({ node: cold.node })).nodeEqual, true);
});

test('normalizes actual helper-shaped Node authority for schema output', () => {
  const bootstrap = JSON.parse(
    JSON.stringify({
      status: 'ready',
      nodeAuthority: {
        nodeExpectedVersion: '22.22.3',
        nodeVersion: '22.22.3',
        nodePath: testNodePath,
        emsdkNode: testNodePath,
      },
    }),
  );
  assert.deepEqual(normalizeBootstrapNodeAuthority(bootstrap.nodeAuthority, 'cold'), {
    nodeExpectedVersion: '22.22.3',
    nodeVersion: 'v22.22.3',
    nodePath: testNodePath,
    emsdkNode: testNodePath,
  });
  assert.throws(
    () =>
      normalizeBootstrapNodeAuthority(
        { ...bootstrap.nodeAuthority, nodeVersion: 'v22.22.3' },
        'cold',
      ),
    (error) => error.reason === 'system-node-unproven' && error.stage === 'node-authority',
  );
});

test('accepts only the locked real Emscripten install layout', () => {
  const lock = JSON.parse(
    readFileSync(resolve(repoRoot, 'scripts/ci/emscripten-no-xz.lock.json'), 'utf8'),
  );
  const bootstrap = JSON.parse(JSON.stringify({ toolchainLayout: lock.toolchainLayout }));
  assert.deepEqual(
    validateBootstrapToolchainLayout(bootstrap.toolchainLayout, 'cold'),
    lock.toolchainLayout,
  );
  assert.throws(
    () =>
      validateBootstrapToolchainLayout(
        { ...bootstrap.toolchainLayout, compilerRelativePath: 'emsdk/emcc' },
        'warm',
      ),
    (error) => error.reason === 'toolchain-layout-mismatch' && error.stage === 'compiler',
  );
});

test('captures consumer diagnostics and binds install/bin in the child environment', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-emscripten-diagnostics-'));
  const fakeBin = join(root, 'fake-bin');
  const evidenceDir = join(root, 'evidence');
  const envPath = join(root, 'child-env.txt');
  mkdirSync(fakeBin);
  const fakePnpm = join(fakeBin, 'pnpm');
  writeFileSync(
    fakePnpm,
    `#!/bin/sh\nprintf 'child stdout'\nprintf 'child stderr' >&2\nprintf '%s' "$EMSDK|$EMSCRIPTEN|$EMSDK_NODE|$PATH" > ${envPath}\nexit 7\n`,
  );
  chmodSync(fakePnpm, 0o755);
  const lock = JSON.parse(
    readFileSync(resolve(repoRoot, 'scripts/ci/emscripten-no-xz.lock.json'), 'utf8'),
  );
  const cacheDir = join(root, 'cache');
  const wrapper = { wrapperPath: join(root, 'wrapper', 'emcc') };
  const node = { emsdkNode: '/opt/node/bin/node' };
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${originalPath || ''}`;
  try {
    const result = runConsumer(
      'fbx',
      wrapper,
      'cold',
      cacheDir,
      lock.toolchainLayout,
      node,
      evidenceDir,
    );
    assert.equal(result.exitCode, 7);
    assert.equal(result.stdout, 'child stdout');
    assert.equal(result.stderr, 'child stderr');
    assert.equal(result.spawnError, null);
    assert.equal(result.diagnosticPath, 'diagnostics/fbx.json');
    assert.equal(result.diagnosticWriteError, null);
    const diagnostic = JSON.parse(readFileSync(join(evidenceDir, result.diagnosticPath), 'utf8'));
    assert.equal(diagnostic.stderr, 'child stderr');
    assert.equal(diagnostic.exitCode, 7);
    assert.deepEqual(diagnostic.command, ['pnpm', '-F', '@forgeax/engine-fbx', 'build:wasm']);
    assert.equal(diagnostic.environment.EM_CACHE, `${cacheDir}/install/emscripten/cache`);
    assert.equal(diagnostic.environment.EM_LLVM_ROOT, `${cacheDir}/install/bin`);
    assert.equal(diagnostic.environment.EM_BINARYEN_ROOT, `${cacheDir}/install`);
    const config = readFileSync(diagnostic.environment.EM_CONFIG, 'utf8');
    assert.match(config, new RegExp(`LLVM_ROOT = ${JSON.stringify(`${cacheDir}/install/bin`)}`));
    assert.match(config, new RegExp(`BINARYEN_ROOT = ${JSON.stringify(`${cacheDir}/install`)}`));
    const childEnvironment = readFileSync(envPath, 'utf8');
    assert.match(childEnvironment, new RegExp(`${cacheDir}/install\\|`));
    assert.match(childEnvironment, new RegExp(`${cacheDir}/install/emscripten\\|`));
    assert.match(childEnvironment, /\/opt\/node\/bin\/node\|/);
    assert.match(childEnvironment, new RegExp(`${cacheDir}/install/bin`));

    process.env.PATH = join(root, 'missing-pnpm');
    const unavailable = runConsumer(
      'codec',
      wrapper,
      'cold',
      cacheDir,
      lock.toolchainLayout,
      node,
      evidenceDir,
    );
    assert.match(unavailable.spawnError, /ENOENT|not found/);
    const blockedDiagnostic = JSON.parse(
      readFileSync(join(evidenceDir, unavailable.diagnosticPath), 'utf8'),
    );
    assert.equal(blockedDiagnostic.spawnError, unavailable.spawnError);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test('captures direct compiler preflight diagnostics before consumer gates', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-emscripten-preflight-'));
  const compiler = join(root, 'emcc');
  const evidenceDir = join(root, 'evidence');
  writeFileSync(
    compiler,
    '#!/bin/sh\nprintf "emcc version output"\nprintf "emcc config failure" >&2\nexit 9\n',
  );
  chmodSync(compiler, 0o755);
  const environment = {
    EMSDK: join(root, 'install'),
    EMSCRIPTEN: join(root, 'install/emscripten'),
    EMSCRIPTEN_ROOT: join(root, 'install/emscripten'),
    EMSDK_NODE: '/opt/node/bin/node',
    EM_CONFIG: join(evidenceDir, 'diagnostics/emscripten-config.py'),
    EM_CACHE: join(root, 'install/emscripten/cache'),
    EM_LLVM_ROOT: join(root, 'install/bin'),
    EM_BINARYEN_ROOT: join(root, 'install'),
    PATH: '/opt/node/bin:/usr/bin',
  };
  try {
    const result = runCompilerPreflight(compiler, environment, evidenceDir);
    assert.equal(result.exitCode, 9);
    assert.equal(result.stdout, 'emcc version output');
    assert.equal(result.stderr, 'emcc config failure');
    assert.equal(result.spawnError, null);
    const diagnostic = JSON.parse(readFileSync(join(evidenceDir, result.diagnosticPath), 'utf8'));
    assert.equal(diagnostic.exitCode, 9);
    assert.equal(diagnostic.environment.EM_CONFIG, environment.EM_CONFIG);
    assert.equal(diagnostic.environment.EM_LLVM_ROOT, environment.EM_LLVM_ROOT);
    assert.equal(diagnostic.environment.EM_BINARYEN_ROOT, environment.EM_BINARYEN_ROOT);
    const unavailable = runCompilerPreflight(join(root, 'missing-emcc'), environment, evidenceDir);
    assert.match(unavailable.spawnError, /ENOENT|not found/);
    assert.equal(unavailable.exitCode, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('evidence validation rejects missing, mistyped, and mismatched facts', () => {
  const cases = [
    ['schemaVersion', (envelope) => delete envelope.schemaVersion],
    [
      'wrong field type',
      (envelope) => {
        envelope.runner.arch = 64;
      },
    ],
    [
      'fingerprint mismatch',
      (envelope) => {
        envelope.compiler.fingerprint.runnerArch = 'arm64';
      },
    ],
    [
      'missing consumer invocation',
      (envelope) => {
        envelope.emcc.invocations = [envelope.emcc.invocations[0]];
      },
    ],
  ];
  for (const [label, mutate] of cases) {
    const envelope = validEnvelope();
    mutate(envelope);
    const result = runValidator(envelope);
    assert.notEqual(result.status, undefined, label);
    const payload = JSON.parse(result.stdout);
    for (const field of ['stage', 'reason', 'expected', 'observed', 'hint']) {
      assert.ok(payload[field] !== undefined, `${label}: missing ${field}`);
    }
  }
});

function runContract(command, args) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function runPreflight(fixture, mode = 'cold', coldEnvelope = validEnvelope()) {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-emscripten-preflight-'));
  const fixturePath = join(root, 'preflight.json');
  const evidenceDir = join(root, 'evidence');
  writeFileSync(fixturePath, `${JSON.stringify(fixture)}\n`);
  let coldEvidencePath;
  if (mode === 'warm') {
    coldEvidencePath = join(root, 'cold-evidence.json');
    writeFileSync(coldEvidencePath, `${JSON.stringify(coldEnvelope)}\n`);
  }
  try {
    const args = [
      evidenceScript,
      '--mode',
      mode,
      '--evidence-dir',
      evidenceDir,
      '--preflight-only',
      fixturePath,
    ];
    if (coldEvidencePath) args.push('--cold-evidence', coldEvidencePath);
    return execFileSync(process.execPath, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, FORGEAX_EVIDENCE_TEST_PREFLIGHT: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? '',
      evidenceDir,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function validColdPreflight(overrides = {}) {
  return {
    sourceSha: '0123456789abcdef0123456789abcdef01234567',
    runner: { os: 'Linux', arch: 'x86_64' },
    xz: {
      checkedCommands: ['xz', 'unxz', 'xz-utils', 'xzcat', 'xzdec', 'pixz'],
      available: false,
      installAttempted: false,
      invocationDetected: false,
      lanePathControlled: true,
      laneCommandPaths: {
        xz: false,
        unxz: false,
        'xz-utils': false,
        xzcat: false,
        xzdec: false,
        pixz: false,
      },
      hostCommandPaths: {
        xz: false,
        unxz: false,
        'xz-utils': false,
        xzcat: false,
        xzdec: false,
        pixz: false,
      },
      hostPackageStatus: 'not-installed',
      pythonLzmaUsed: true,
    },
    cleanup: {
      toolchainCacheEmpty: true,
      fbxOutputCleared: true,
      codecOutputCleared: true,
      consumerCacheCleared: true,
      hydrationCleared: true,
    },
    ...overrides,
  };
}

test('cold preflight accepts only a fixed Linux x86_64 source with no xz family', () => {
  const result = runPreflight(validColdPreflight());
  assert.equal(result.status, undefined);
  const payload = JSON.parse(result);
  assert.equal(payload.status, 'ready');
  assert.equal(payload.mode, 'cold');
  assert.equal(payload.source.sha, '0123456789abcdef0123456789abcdef01234567');
  assert.deepEqual(payload.runner, { os: 'Linux', arch: 'x86_64' });
  assert.equal(payload.xz.available, false);
  assert.equal(payload.xz.installAttempted, false);
  assert.equal(payload.xz.invocationDetected, false);
});

test('cold preflight ignores host xz facts after lane isolation is proven', () => {
  const hostCommandPaths = {
    xz: true,
    unxz: true,
    'xz-utils': false,
    xzcat: true,
    xzdec: false,
    pixz: false,
  };
  const fixture = validColdPreflight({
    xz: {
      ...validColdPreflight().xz,
      hostCommandPaths,
      hostPackageStatus: 'installed',
    },
  });
  const result = runPreflight(fixture);
  assert.equal(JSON.parse(result).status, 'ready');
});

test('controlled lane PATH hides host xz while preserving required commands', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-emscripten-path-'));
  const hostBin = join(root, 'host-bin');
  mkdirSync(hostBin);
  for (const command of ['node', 'pnpm', 'python3', 'git', 'xz', 'unxz', 'xzcat']) {
    const path = join(hostBin, command);
    writeFileSync(path, '#!/bin/sh\nexit 0\n');
    chmodSync(path, 0o755);
  }
  const controlled = createControlledLanePath(hostBin);
  try {
    const facts = probeXz({
      lanePath: controlled.path,
      hostPath: hostBin,
      pythonLzmaUsed: true,
    });
    assert.equal(facts.lanePathControlled, true);
    assert.equal(facts.pythonLzmaUsed, true);
    assert.equal(facts.hostCommandPaths.xz, true);
    assert.equal(facts.hostCommandPaths.unxz, true);
    assert.equal(facts.hostCommandPaths.xzcat, true);
    for (const command of ['xz', 'unxz', 'xz-utils', 'xzcat', 'xzdec', 'pixz'])
      assert.equal(facts.laneCommandPaths[command], false, command);
    assert.match(
      execFileSync('/bin/sh', ['-c', 'command -v node'], {
        env: { ...process.env, PATH: controlled.path },
        encoding: 'utf8',
      }),
      /node/,
    );
  } finally {
    rmSync(controlled.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('controlled lane preserves the stable path of symlinked launchers', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-emscripten-launcher-'));
  const stableBin = join(root, 'stable-bin');
  const hostBin = join(root, 'host-bin');
  mkdirSync(stableBin);
  mkdirSync(hostBin);
  const launcher = join(stableBin, 'pnpm');
  const launcherTarget = join(stableBin, 'pnpm.mjs');
  writeFileSync(launcher, '#!/bin/sh\nexec "$(dirname "$0")/pnpm.mjs" "$@"\n');
  writeFileSync(launcherTarget, '#!/bin/sh\nprintf stable-launcher\n');
  chmodSync(launcher, 0o755);
  chmodSync(launcherTarget, 0o755);
  symlinkSync(launcher, join(hostBin, 'pnpm'));
  const controlled = createControlledLanePath(`${hostBin}${delimiter}${process.env.PATH || ''}`);
  try {
    assert.match(readFileSync(join(controlled.path, 'pnpm'), 'utf8'), /stable-bin\/pnpm/);
    assert.equal(
      execFileSync(join(controlled.path, 'pnpm'), ['--version'], {
        env: { ...process.env, PATH: controlled.path },
        encoding: 'utf8',
      }),
      'stable-launcher',
    );
  } finally {
    rmSync(controlled.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('cold preflight blocks unverifiable runner, source, xz, package, and hydration facts', () => {
  const cases = [
    ['source SHA', { sourceSha: 'not-a-commit' }],
    ['runner OS', { runner: { os: 'Darwin', arch: 'x86_64' } }],
    ['runner architecture', { runner: { os: 'Linux', arch: 'arm64' } }],
    ['xz availability', { xz: { ...validColdPreflight().xz, available: true } }],
    ['xz-utils installation', { xz: { ...validColdPreflight().xz, installAttempted: true } }],
    [
      'consumer output cleanup',
      { cleanup: { ...validColdPreflight().cleanup, fbxOutputCleared: false } },
    ],
    [
      'hydration cleanup',
      { cleanup: { ...validColdPreflight().cleanup, hydrationCleared: false } },
    ],
  ];
  for (const [label, override] of cases) {
    const result = runPreflight(validColdPreflight(override));
    assert.notEqual(result.status, undefined, label);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'blocked', label);
    for (const field of ['stage', 'reason', 'expected', 'observed', 'hint']) {
      assert.ok(payload[field] !== undefined, `${label}: missing ${field}`);
    }
  }
});

test('warm preflight requires an exact cache and linked cold envelope', () => {
  const cold = validEnvelope();
  const warm = validColdPreflight({
    cache: {
      status: 'exact-valid',
      key: 'emsdk-no-xz-linux-x86_64-6.0.2',
      matchedKey: 'emsdk-no-xz-linux-x86_64-6.0.2',
      fingerprint: cold.cache.fingerprint,
    },
  });
  const result = runPreflight(warm, 'warm', cold);
  assert.equal(result.status, undefined);
  const payload = JSON.parse(result);
  assert.equal(payload.status, 'ready');
  assert.equal(payload.mode, 'warm');
  assert.equal(payload.cache.status, 'exact-valid');
  assert.equal(payload.coldEvidence.source.sha, cold.source.sha);
});

test('warm preflight blocks partial cache, stale cold linkage, and bypass sources', () => {
  const cold = validEnvelope();
  const cases = [
    ['partial cache', { cache: { status: 'partial' } }],
    ['cache service unavailable', { cache: { status: 'unavailable' } }],
    [
      'consumer output not fresh',
      {
        cache: {
          status: 'exact-valid',
          key: 'cache',
          matchedKey: 'cache',
          fingerprint: cold.cache.fingerprint,
        },
        cleanup: { ...validColdPreflight().cleanup, codecOutputCleared: false },
      },
    ],
  ];
  for (const [label, override] of cases) {
    const result = runPreflight(validColdPreflight(override), 'warm', cold);
    assert.notEqual(result.status, undefined, label);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'blocked', label);
    assert.equal(payload.mode, 'warm', label);
  }

  const staleCold = validEnvelope({
    source: { ...cold.source, sha: 'fedcba9876543210fedcba9876543210fedcba98' },
  });
  const staleResult = runPreflight(
    validColdPreflight({
      cache: {
        status: 'exact-valid',
        key: 'cache',
        matchedKey: 'cache',
        fingerprint: cold.cache.fingerprint,
      },
    }),
    'warm',
    staleCold,
  );
  assert.notEqual(staleResult.status, undefined, 'stale cold envelope');
  assert.equal(JSON.parse(staleResult.stdout).status, 'blocked');
});

test('cold and warm consumer records cover both lanes and complete output sets', () => {
  const cold = validEnvelope();
  const warm = validEnvelope({
    mode: 'warm',
    cache: {
      ...cold.cache,
      status: 'exact-valid',
      matchedKey: cold.cache.key,
    },
  });
  assert.equal(cold.consumer.length + warm.consumer.length, 4);
  for (const envelope of [cold, warm]) {
    assert.equal(envelope.emcc.invocations.length, 2);
    assert.deepEqual(envelope.consumer.map((consumer) => consumer.name).sort(), ['codec', 'fbx']);
    assert.equal(envelope.output.files.length, 6);
    assert.ok(
      envelope.output.files.every((file) => /^sha256:[0-9a-f]{64}$/.test(file.outputSha256)),
    );
    assert.ok(envelope.gate.results.every((gate) => gate.status === 'pass'));
    assert.equal(envelope.node.expectedVersion, '22.22.3');
    assert.equal(envelope.node.nodeVersion, 'v22.22.3');
    assert.equal(envelope.node.nodePath, envelope.node.emsdkNode);
    assert.deepEqual(envelope.node.bundledNodePaths, []);
  }
});

test('consumer evidence rejects shortcuts and incomplete facts', () => {
  const cases = [
    [
      'missing invocation',
      (envelope) => {
        envelope.emcc.invocations = [envelope.emcc.invocations[0]];
        envelope.consumer[1].invocationIds = [];
      },
    ],
    [
      'missing output',
      (envelope) => {
        envelope.output.files = envelope.output.files.slice(0, -1);
      },
    ],
    [
      'missing SHA',
      (envelope) => {
        envelope.output.files[0].outputSha256 = '';
      },
    ],
    [
      'missing gate',
      (envelope) => {
        envelope.gate.results = [];
      },
    ],
    [
      'wasm-only output',
      (envelope) => {
        envelope.consumer[0].outputNames = ['pkg/fbx-wasm.wasm'];
        envelope.output.files = envelope.output.files.filter(
          (file) => file.name === 'pkg/fbx-wasm.wasm' || file.consumer !== 'fbx',
        );
      },
    ],
    [
      'hydration shortcut',
      (envelope) => {
        envelope.emcc.invocations = [];
        envelope.consumer[0].invocationIds = [];
        envelope.consumer[1].invocationIds = [];
      },
    ],
    [
      'missing Node tuple',
      (envelope) => {
        delete envelope.node.emsdkNode;
      },
    ],
    [
      'missing Node executable SHA',
      (envelope) => {
        delete envelope.node.executableSha256;
      },
    ],
    [
      'mismatched Node executable SHA',
      (envelope) => {
        envelope.node.executableSha256 = `sha256:${'d'.repeat(64)}`;
      },
    ],
  ];
  for (const [label, mutate] of cases) {
    const envelope = validEnvelope();
    mutate(envelope);
    const result = runValidator(envelope);
    assert.notEqual(result.status, undefined, label);
    const payload = JSON.parse(result.stdout);
    assert.ok(payload.stage, label);
    assert.ok(payload.reason, label);
    assert.ok(payload.hint, label);
  }
});

test('existing wasm artifact classes and graph remain intact', () => {
  const contract = JSON.parse(
    readFileSync(resolve(repoRoot, 'scripts/ci/build-artifact-contract.json'), 'utf8'),
  );
  for (const className of ['wasm-fbx', 'wasm-codec']) {
    assert.equal(contract.artifactClasses[className].producer, 'core-build');
    assert.equal(contract.artifactClasses[className].transferArtifact, 'core-build');
  }
  assert.deepEqual(contract.artifactClasses['wasm-fbx'].fileClasses, ['packages/fbx/pkg']);
  assert.deepEqual(contract.artifactClasses['wasm-codec'].fileClasses, ['packages/codec/pkg']);

  const ci = ciWorkflow;
  assert.match(ci, /core-build:[\s\S]*?wasm-fbx[\s\S]*?wasm-codec/);
  assert.match(ci, /build-artifacts:[\s\S]*?needs:\s*\[core-build/);
  assert.match(
    ci,
    /wasm-fbx[\s\S]*?download-artifact-with-retry|download-artifact-with-retry[\s\S]*?wasm-fbx/,
  );
  assert.match(
    ci,
    /wasm-codec[\s\S]*?download-artifact-with-retry|download-artifact-with-retry[\s\S]*?wasm-codec/,
  );
  runContract(process.execPath, [
    'scripts/ci/check-build-artifact-contract.mjs',
    '--workflow',
    '.github/workflows/ci.yml',
  ]);
});

test('nightly keeps install-time harness materialization and channel allowlist', () => {
  const install = stepIndex(nightlyWorkflow, 'Install (frozen)');
  const materialize = stepIndex(nightlyWorkflow, 'Materialize harness documentation');
  assert.ok(materialize > install, 'harness materialization must follow install');
  assert.match(nightlyWorkflow.slice(materialize, materialize + 800), /pnpm harness:sync/);

  runContract(process.execPath, ['scripts/check-ci-channel-alignment.mjs']);
  assert.doesNotMatch(
    jobSection(ciWorkflow, 'portability-bun'),
    /setup-emscripten-no-xz|emscripten-no-xz-evidence/,
  );
});

test('independent evidence workflow does not join the generic wasm artifact contract', () => {
  const evidenceWorkflow = readFileSync(
    resolve(repoRoot, '.github/workflows/emscripten-no-xz-evidence.yml'),
    'utf8',
  );
  assert.doesNotMatch(evidenceWorkflow, /wasm-fbx|wasm-codec|build-artifact-contract/);
  assert.match(evidenceWorkflow, /emscripten-no-xz-evidence/);
  assert.match(evidenceWorkflow, /actions\/upload-artifact@v6/);
});
