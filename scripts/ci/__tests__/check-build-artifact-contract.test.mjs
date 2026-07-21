// check-build-artifact-contract.test.mjs — TDD RED fixtures for
// check-build-artifact-contract.mjs (t1 + t2).
//
// t1: Contract schema validation — negative cases (missing required fields,
// overlapping path classes, malformed JSON) and AC-06 timing roster fixtures.
// t2: Workflow contract consistency — YAML download/upload mapping, timing
// roster cross-check, and AC-06 bidirectional needs check.
//
// Usage: node --test scripts/ci/__tests__/check-build-artifact-contract.test.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = realpathSync(join(__dirname, '..', '..', '..'));
const checkerPath = join(repoRoot, 'scripts', 'ci', 'check-build-artifact-contract.mjs');

/**
 * Write a temp contract JSON and return the temp dir + contract path.
 */
function tmpContract(content) {
  const dir = mkdtempSync(join(tmpdir(), 'contract-test-'));
  const fp = join(dir, 'build-artifact-contract.json');
  writeFileSync(fp, JSON.stringify(content, null, 2), 'utf-8');
  return { dir, fp };
}

/**
 * Write a temp YAML workflow file and return the temp dir + file path.
 */
function tmpWorkflow(content) {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-test-'));
  const fp = join(dir, 'ci.yml');
  writeFileSync(fp, content, 'utf-8');
  return { dir, fp };
}

/**
 * Run the checker script and return { exitCode, stdout, stderr }.
 */
function runChecker(args = []) {
  try {
    const stdout = execFileSync(process.execPath, [checkerPath, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout: stdout.trim(), stderr: '' };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout?.toString()?.trim() ?? '',
      stderr: err.stderr?.toString()?.trim() ?? '',
    };
  }
}

/**
 * A minimal valid contract for use as a baseline in negative tests.
 */
function validContract(overrides = {}) {
  return {
    version: 1,
    extractionRoot: '.',
    artifactClasses: {
      'engine-dist': {
        description: 'Package dist outputs',
        fileClasses: ['packages/*/dist'],
      },
      'wasm-runtime': {
        description: 'wgpu-wasm package',
        fileClasses: ['packages/wgpu-wasm/pkg'],
      },
      'wasm-fbx': {
        description: 'FBX WASM package',
        fileClasses: ['packages/fbx/pkg'],
      },
      'wasm-codec': {
        description: 'Codec WASM package',
        fileClasses: ['packages/codec/pkg'],
      },
      'app-dist': {
        description: 'App shader manifests and build reports',
        fileClasses: ['apps/**/dist'],
      },
    },
    consumers: {
      'primary-pnpm': {
        requiredArtifactClasses: ['engine-dist', 'wasm-runtime', 'app-dist'],
      },
      'vitest-browser': {
        requiredArtifactClasses: ['engine-dist', 'wasm-runtime', 'app-dist'],
      },
      'smoke-fleet': {
        requiredArtifactClasses: ['engine-dist', 'wasm-runtime', 'app-dist'],
      },
      'vitest-dawn': {
        requiredArtifactClasses: ['engine-dist', 'wasm-runtime'],
      },
      'webkit-fallback': {
        requiredArtifactClasses: ['engine-dist', 'wasm-runtime'],
      },
      'portability-bun': {
        requiredArtifactClasses: ['engine-dist', 'wasm-runtime', 'app-dist'],
      },
      'metrics-validate': {
        requiredArtifactClasses: ['engine-dist', 'wasm-runtime', 'app-dist'],
      },
      'collectathon-boot-e2e': {
        requiredArtifactClasses: ['engine-dist', 'wasm-runtime', 'app-dist'],
      },
      'publish-fbx-wasm-release': {
        requiredArtifactClasses: ['wasm-fbx'],
      },
      'publish-wgpu-wasm-release': {
        requiredArtifactClasses: ['wasm-runtime'],
      },
      'publish-basis-wasm-release': {
        requiredArtifactClasses: ['wasm-codec'],
      },
    },
    timingRoster: [
      {
        jobIdentity: 'primary-pnpm',
        requiredArtifactClasses: ['engine-dist', 'wasm-runtime', 'app-dist'],
        allowedNonArtifactPrerequisites: ['post-merge-gate'],
      },
      {
        jobIdentity: 'vitest-browser',
        requiredArtifactClasses: ['engine-dist', 'wasm-runtime', 'app-dist'],
        allowedNonArtifactPrerequisites: ['post-merge-gate'],
      },
      {
        jobIdentity: 'smoke-fleet',
        requiredArtifactClasses: ['engine-dist', 'wasm-runtime', 'app-dist'],
        allowedNonArtifactPrerequisites: ['post-merge-gate'],
      },
      {
        jobIdentity: 'vitest-dawn',
        requiredArtifactClasses: ['engine-dist', 'wasm-runtime'],
        allowedNonArtifactPrerequisites: ['post-merge-gate'],
      },
      {
        jobIdentity: 'webkit-fallback',
        requiredArtifactClasses: ['engine-dist', 'wasm-runtime'],
        allowedNonArtifactPrerequisites: ['post-merge-gate'],
      },
      {
        jobIdentity: 'portability-bun',
        requiredArtifactClasses: ['engine-dist', 'wasm-runtime', 'app-dist'],
        allowedNonArtifactPrerequisites: ['post-merge-gate'],
      },
      {
        jobIdentity: 'metrics-validate',
        requiredArtifactClasses: ['engine-dist', 'wasm-runtime', 'app-dist'],
        allowedNonArtifactPrerequisites: ['post-merge-gate'],
      },
      {
        jobIdentity: 'collectathon-boot-e2e',
        requiredArtifactClasses: ['engine-dist', 'wasm-runtime', 'app-dist'],
        allowedNonArtifactPrerequisites: ['post-merge-gate'],
      },
      {
        jobIdentity: 'publish-fbx-wasm-release',
        requiredArtifactClasses: [],
        allowedNonArtifactPrerequisites: [],
        notApplicable: true,
        notApplicableReason: 'PR run only',
      },
      {
        jobIdentity: 'publish-wgpu-wasm-release',
        requiredArtifactClasses: [],
        allowedNonArtifactPrerequisites: [],
        notApplicable: true,
        notApplicableReason: 'PR run only',
      },
      {
        jobIdentity: 'publish-basis-wasm-release',
        requiredArtifactClasses: [],
        allowedNonArtifactPrerequisites: [],
        notApplicable: true,
        notApplicableReason: 'PR run only',
      },
    ],
    provenance: {
      producerRoster: ['core-build', 'app-shard-0', 'app-shard-1', 'app-shard-2'],
      namingTemplate: 'provenance-<producerJobId>-a<runAttempt>',
      mergedClass: 'provenance-merged',
      mergedWriter: 'build-artifacts',
      mergedReader: 'cost-reporter',
      payloadClasses: ['engine-dist', 'wasm-runtime', 'wasm-fbx', 'wasm-codec', 'app-dist'],
    },
    requiredCIJobRoster: [
      'post-merge-gate',
      'build-artifacts',
      'primary-pnpm',
      'vitest-browser',
      'smoke-fleet',
      'vitest-dawn',
      'webkit-fallback',
      'portability-bun',
      'metrics-validate',
      'collectathon-boot-e2e',
      'publish-fbx-wasm-release',
      'publish-wgpu-wasm-release',
      'publish-basis-wasm-release',
      'sticky-comment',
    ],
    ...overrides,
  };
}

/**
 * A minimal valid contract with reduced timing roster — used for workflow tests
 * where the temp YAML only has a subset of jobs.
 */
function minimalContract(overrides = {}) {
  return {
    version: 1,
    extractionRoot: '.',
    artifactClasses: {
      'engine-dist': { fileClasses: ['packages/*/dist'] },
      'wasm-runtime': { fileClasses: ['packages/wgpu-wasm/pkg'] },
      'wasm-fbx': { fileClasses: ['packages/fbx/pkg'] },
      'wasm-codec': { fileClasses: ['packages/codec/pkg'] },
      'app-dist': {
        fileClasses: ['apps/**/dist'],
      },
    },
    consumers: {
      'primary-pnpm': {
        requiredArtifactClasses: ['engine-dist', 'wasm-runtime', 'app-dist'],
      },
      'vitest-dawn': { requiredArtifactClasses: ['engine-dist', 'wasm-runtime'] },
    },
    timingRoster: [
      {
        jobIdentity: 'primary-pnpm',
        requiredArtifactClasses: ['engine-dist', 'wasm-runtime', 'app-dist'],
        allowedNonArtifactPrerequisites: ['post-merge-gate'],
      },
    ],
    provenance: {
      producerRoster: ['core-build', 'app-shard-0', 'app-shard-1', 'app-shard-2'],
      namingTemplate: 'provenance-<producerJobId>-a<runAttempt>',
      mergedClass: 'provenance-merged',
      mergedWriter: 'build-artifacts',
      mergedReader: 'cost-reporter',
      payloadClasses: ['engine-dist', 'wasm-runtime', 'wasm-fbx', 'wasm-codec', 'app-dist'],
    },
    requiredCIJobRoster: ['build-artifacts', 'primary-pnpm'],
    ...overrides,
  };
}

/**
 * A minimal valid workflow YAML with just build-artifacts and primary-pnpm, plus post-merge-gate.
 */
function minimalWorkflowYaml() {
  return `
name: CI
on: push
jobs:
  post-merge-gate:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
  build-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v6
        with:
          name: engine-dist
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-runtime
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-fbx
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-codec
      - uses: actions/upload-artifact@v6
        with:
          name: app-dist
  primary-pnpm:
    runs-on: ubuntu-latest
    needs: [build-artifacts, post-merge-gate]
    steps:
      - uses: actions/download-artifact@v7
        with:
          name: build-output
`;
}

// ============================================================================
// t1: Contract schema validation fixtures
// ============================================================================

// -- Valid contract --
test('t1: valid contract passes schema validation', async () => {
  const { dir, fp } = tmpContract(validContract());
  try {
    const r = runChecker([fp]);
    assert.strictEqual(r.exitCode, 0, `valid contract should pass: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- Missing required fields --
test('t1: missing version field produces structured error', async () => {
  const c = validContract();
  delete c.version;
  const { dir, fp } = tmpContract(c);
  try {
    const r = runChecker([fp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on missing version');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(typeof parsed.code, 'string', 'should have code field');
    assert.ok(parsed.code.includes('contract'), 'code should reference contract');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('t1: missing artifactClasses produces structured error', async () => {
  const c = validContract();
  delete c.artifactClasses;
  const { dir, fp } = tmpContract(c);
  try {
    const r = runChecker([fp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on missing artifactClasses');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(typeof parsed.code, 'string', 'should have code field');
    assert.ok(parsed.code.includes('contract'), 'code should reference contract');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('t1: missing consumers produces structured error', async () => {
  const c = validContract();
  delete c.consumers;
  const { dir, fp } = tmpContract(c);
  try {
    const r = runChecker([fp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on missing consumers');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(typeof parsed.code, 'string', 'should have code field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- Unknown consumer name --
test('t1: consumer referencing unknown artifact class produces structured error', async () => {
  const c = validContract();
  c.consumers['primary-pnpm'].requiredArtifactClasses = ['engine-dist', 'nonexistent-class'];
  const { dir, fp } = tmpContract(c);
  try {
    const r = runChecker([fp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on unknown artifact class');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(typeof parsed.code, 'string', 'should have code field');
    assert.ok(
      parsed.code.includes('contract') || parsed.code.includes('artifact'),
      'code should reference artifact/contract',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- Overlapping path classes --
test('t1: overlapping path classes between artifacts produces structured error', async () => {
  const c = validContract();
  // Make wasm-fbx share the same path as engine-dist
  c.artifactClasses['wasm-fbx'].fileClasses = ['packages/*/dist'];
  const { dir, fp } = tmpContract(c);
  try {
    const r = runChecker([fp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on overlapping paths');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(typeof parsed.code, 'string', 'should have code field');
    assert.ok(parsed.code.includes('contract'), 'code should reference contract');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- Malformed JSON --
test('t1: malformed contract JSON produces structured error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'contract-test-'));
  const fp = join(dir, 'build-artifact-contract.json');
  writeFileSync(fp, 'this is { not valid json [[', 'utf-8');
  try {
    const r = runChecker([fp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on malformed JSON');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(typeof parsed.code, 'string', 'should have code field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- AC-06 timing roster: missing timingRoster --
test('t1: missing timingRoster section produces structured error', async () => {
  const c = validContract();
  delete c.timingRoster;
  const { dir, fp } = tmpContract(c);
  try {
    const r = runChecker([fp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on missing timingRoster');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(typeof parsed.code, 'string', 'should have code field');
    assert.ok(
      parsed.code.includes('timing-roster') || parsed.code.includes('timingRoster'),
      'code should reference timing roster',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- AC-06 timing roster: undeclared artifact class --
test('t1: timing consumer referencing undeclared artifact class produces structured error', async () => {
  const c = validContract();
  c.timingRoster[0].requiredArtifactClasses = ['nonexistent-class'];
  const { dir, fp } = tmpContract(c);
  try {
    const r = runChecker([fp]);
    assert.notStrictEqual(
      r.exitCode,
      0,
      'should fail on undeclared artifact class in timing roster',
    );
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(typeof parsed.code, 'string', 'should have code field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- AC-06 timing roster: missing jobIdentity --
test('t1: timing consumer missing jobIdentity produces structured error', async () => {
  const c = validContract();
  delete c.timingRoster[0].jobIdentity;
  const { dir, fp } = tmpContract(c);
  try {
    const r = runChecker([fp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on missing jobIdentity');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(typeof parsed.code, 'string', 'should have code field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- AC-06 timing roster: missing requiredArtifactClasses --
test('t1: timing consumer missing requiredArtifactClasses produces structured error', async () => {
  const c = validContract();
  delete c.timingRoster[0].requiredArtifactClasses;
  const { dir, fp } = tmpContract(c);
  try {
    const r = runChecker([fp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on missing requiredArtifactClasses');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(typeof parsed.code, 'string', 'should have code field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- AC-06 timing roster: release consumer without notApplicable --
test('t1: release consumer in timing roster without notApplicable declaration produces structured error', async () => {
  const c = validContract();
  // Add a release consumer without notApplicable
  c.timingRoster.push({
    jobIdentity: 'publish-something-release',
    requiredArtifactClasses: [],
    allowedNonArtifactPrerequisites: [],
  });
  const { dir, fp } = tmpContract(c);
  try {
    const r = runChecker([fp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on release consumer without notApplicable');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(typeof parsed.code, 'string', 'should have code field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- AC-06 timing roster: allowedNonArtifactPrerequisites overlap with required classes --
test('t1: timing consumer with allowedNonArtifactPrerequisites overlapping requiredArtifactClasses produces structured error', async () => {
  const c = validContract();
  c.timingRoster[0].allowedNonArtifactPrerequisites = ['engine-dist'];
  const { dir, fp } = tmpContract(c);
  try {
    const r = runChecker([fp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on overlapping prerequisites');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(typeof parsed.code, 'string', 'should have code field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- AC-06 timing roster: valid timing roster passes --
test('t1: valid timing roster passes', async () => {
  const { dir, fp } = tmpContract(validContract());
  try {
    const r = runChecker([fp]);
    assert.strictEqual(r.exitCode, 0, `valid timing roster should pass: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('t1: version 2 timing consumers must declare their artifact provider', async () => {
  const c = validContract();
  c.version = 2;
  const { dir, fp } = tmpContract(c);
  try {
    const r = runChecker([fp]);
    assert.notStrictEqual(r.exitCode, 0, 'version 2 must reject an implicit provider');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(parsed.code, 'ci-artifact-contract-timing-roster-invalid');
    assert.match(parsed.actual, /missing artifactProvider/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- Duplicate consumer jobIdentity --
test('t1: duplicate jobIdentity in timing roster produces structured error', async () => {
  const c = validContract();
  c.timingRoster.push({ ...c.timingRoster[0] });
  const { dir, fp } = tmpContract(c);
  try {
    const r = runChecker([fp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on duplicate jobIdentity');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(typeof parsed.code, 'string', 'should have code field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// t2: Workflow contract consistency fixtures
// ============================================================================

// -- Undeclared download step --
test('t2: undeclared workflow download step produces structured error', async () => {
  const c = minimalContract();
  // Add a download for an artifact that IS uploaded by build-artifacts but NOT declared in the contract
  // We add "undeclared-artifact" as both an upload in build-artifacts AND a download in primary-pnpm
  const { dir: cDir, fp: cFp } = tmpContract(c);
  const wfYaml = `
name: CI
on: push
jobs:
  build-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v6
        with:
          name: engine-dist
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-runtime
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-fbx
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-codec
      - uses: actions/upload-artifact@v6
        with:
          name: app-dist
      - uses: actions/upload-artifact@v6
        with:
          name: undeclared-artifact-name
  primary-pnpm:
    runs-on: ubuntu-latest
    needs: [build-artifacts, post-merge-gate]
    steps:
      - uses: actions/download-artifact@v7
        with:
          name: undeclared-artifact-name
`;
  const { dir: wDir, fp: wFp } = tmpWorkflow(wfYaml);
  try {
    const r = runChecker(['--workflow', wFp, cFp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on undeclared download');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(typeof parsed.code, 'string', 'should have code field');
    assert.ok(
      parsed.code.includes('contract') || parsed.code.includes('artifact'),
      'code should reference contract/artifact',
    );
  } finally {
    rmSync(cDir, { recursive: true, force: true });
    rmSync(wDir, { recursive: true, force: true });
  }
});

// -- Declared artifact name missing from workflow upload --
test('t2: artifact name declared in contract but missing from workflow upload produces structured error', async () => {
  const { dir: cDir, fp: cFp } = tmpContract(minimalContract());
  const wfYaml = `
name: CI
on: push
jobs:
  build-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v6
        with:
          name: engine-dist
  primary-pnpm:
    runs-on: ubuntu-latest
    needs: [build-artifacts, post-merge-gate]
    steps:
      - uses: actions/download-artifact@v7
        with:
          name: build-output
`;
  const { dir: wDir, fp: wFp } = tmpWorkflow(wfYaml);
  try {
    const r = runChecker(['--workflow', wFp, cFp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on missing upload');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(typeof parsed.code, 'string', 'should have code field');
    assert.ok(
      parsed.code.includes('contract') || parsed.code.includes('artifact'),
      'code should reference contract/artifact',
    );
  } finally {
    rmSync(cDir, { recursive: true, force: true });
    rmSync(wDir, { recursive: true, force: true });
  }
});

test('repair: bare class download cannot target only immutable producer uploads', async () => {
  const { dir: cDir, fp: cFp } = tmpContract(minimalContract());
  const workflow = minimalWorkflowYaml()
    .replace('name: wasm-runtime', 'name: wasm-runtime-core-build-a1')
    .replace('name: build-output', 'name: wasm-runtime');
  const { dir: wDir, fp: wFp } = tmpWorkflow(workflow);
  try {
    const result = runChecker(['--workflow', wFp, cFp]);
    assert.notEqual(result.exitCode, 0, 'stale mutable download name must fail');
    assert.equal(JSON.parse(result.stdout).code, 'ci-artifact-contract-download-name-mismatch');
  } finally {
    rmSync(cDir, { recursive: true, force: true });
    rmSync(wDir, { recursive: true, force: true });
  }
});

// -- Consumer declared in contract but missing needs in workflow --
test('t2: consumer declared in contract but missing needs in workflow produces structured error', async () => {
  const { dir: cDir, fp: cFp } = tmpContract(minimalContract());
  const wfYaml = `
name: CI
on: push
jobs:
  build-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v6
        with:
          name: engine-dist
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-runtime
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-fbx
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-codec
      - uses: actions/upload-artifact@v6
        with:
          name: app-dist
  primary-pnpm:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v7
        with:
          name: build-output
`;
  const { dir: wDir, fp: wFp } = tmpWorkflow(wfYaml);
  try {
    const r = runChecker(['--workflow', wFp, cFp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on missing needs');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(typeof parsed.code, 'string', 'should have code field');
  } finally {
    rmSync(cDir, { recursive: true, force: true });
    rmSync(wDir, { recursive: true, force: true });
  }
});

// -- Valid workflow passes --
test('t2: valid contract and workflow passes', async () => {
  const { dir: cDir, fp: cFp } = tmpContract(minimalContract());
  const { dir: wDir, fp: wFp } = tmpWorkflow(minimalWorkflowYaml());
  try {
    const r = runChecker(['--workflow', wFp, cFp]);
    assert.strictEqual(r.exitCode, 0, `valid workflow should pass: ${r.stderr}`);
  } finally {
    rmSync(cDir, { recursive: true, force: true });
    rmSync(wDir, { recursive: true, force: true });
  }
});

// -- Timing roster: jobIdentity not in workflow --
test('t2: timing roster jobIdentity not in workflow produces structured error', async () => {
  const c = validContract();
  c.timingRoster[0].jobIdentity = 'nonexistent-job';
  const { dir: cDir, fp: cFp } = tmpContract(c);
  const { dir: wDir, fp: wFp } = tmpWorkflow(minimalWorkflowYaml());
  try {
    const r = runChecker(['--workflow', wFp, cFp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on jobIdentity not in workflow');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(typeof parsed.code, 'string', 'should have code field');
    assert.ok(
      parsed.code.includes('timing-roster') || parsed.code.includes('timingRoster'),
      'code should reference timing roster',
    );
  } finally {
    rmSync(cDir, { recursive: true, force: true });
    rmSync(wDir, { recursive: true, force: true });
  }
});

// -- Timing roster: requiredArtifactClasses not in contract --
test('t2: timing roster requiredArtifactClasses not in contract produces structured error', async () => {
  const c = validContract();
  c.timingRoster[0].requiredArtifactClasses = ['nonexistent-class'];
  const { dir: cDir, fp: cFp } = tmpContract(c);
  const { dir: wDir, fp: wFp } = tmpWorkflow(minimalWorkflowYaml());
  try {
    const r = runChecker(['--workflow', wFp, cFp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on requiredArtifactClasses not in contract');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(typeof parsed.code, 'string', 'should have code field');
  } finally {
    rmSync(cDir, { recursive: true, force: true });
    rmSync(wDir, { recursive: true, force: true });
  }
});

// -- Timing roster: valid alignment passes --
test('t2: valid timing roster alignment passes with workflow', async () => {
  const { dir: cDir, fp: cFp } = tmpContract(minimalContract());
  const { dir: wDir, fp: wFp } = tmpWorkflow(minimalWorkflowYaml());
  try {
    const r = runChecker(['--workflow', wFp, cFp]);
    assert.strictEqual(r.exitCode, 0, `valid timing roster alignment should pass: ${r.stderr}`);
  } finally {
    rmSync(cDir, { recursive: true, force: true });
    rmSync(wDir, { recursive: true, force: true });
  }
});

// ============================================================================
// t2: AC-06 bidirectional needs check fixtures
// ============================================================================

// -- (a) consumer with needs: [build-artifacts] only -- passes --
test('t2: bidirectional needs check — consumer with only build-artifacts in needs passes', async () => {
  const { dir: cDir } = tmpContract(minimalContract());
  const wfYaml = `
name: CI
on: push
jobs:
  build-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v6
        with:
          name: engine-dist
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-runtime
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-fbx
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-codec
      - uses: actions/upload-artifact@v6
        with:
          name: app-dist
  primary-pnpm:
    runs-on: ubuntu-latest
    needs: [build-artifacts]
    steps:
      - uses: actions/download-artifact@v7
        with:
          name: build-output
`;
  const { dir: wDir, fp: wFp } = tmpWorkflow(wfYaml);
  // Update contract to have only build-artifacts as needs
  const c = minimalContract();
  c.timingRoster[0].allowedNonArtifactPrerequisites = [];
  const { fp: cFp2 } = tmpContract(c);
  try {
    const r = runChecker(['--workflow', wFp, cFp2]);
    assert.strictEqual(
      r.exitCode,
      0,
      `consumer with only build-artifacts should pass: ${r.stderr}`,
    );
  } finally {
    rmSync(cDir, { recursive: true, force: true });
    rmSync(wDir, { recursive: true, force: true });
  }
});

// -- (b) consumer with needs: [build-artifacts, post-merge-gate] where post-merge-gate IS declared -- passes --
test('t2: bidirectional needs check — declared non-artifact prerequisite in needs passes', async () => {
  const { dir: cDir, fp: cFp } = tmpContract(minimalContract());
  const { dir: wDir, fp: wFp } = tmpWorkflow(minimalWorkflowYaml());
  try {
    const r = runChecker(['--workflow', wFp, cFp]);
    assert.strictEqual(r.exitCode, 0, `declared prerequisite should pass: ${r.stderr}`);
  } finally {
    rmSync(cDir, { recursive: true, force: true });
    rmSync(wDir, { recursive: true, force: true });
  }
});

test('t2: a single-producer consumer waits on that producer instead of the merged aggregate', async () => {
  const c = minimalContract();
  c.timingRoster = [
    {
      jobIdentity: 'vitest-dawn',
      requiredArtifactClasses: ['engine-dist', 'wasm-runtime'],
      artifactProvider: 'core-build',
      allowedNonArtifactPrerequisites: ['post-merge-gate'],
    },
  ];
  const wfYaml = `
name: CI
on: push
jobs:
  post-merge-gate:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
  core-build:
    runs-on: ubuntu-latest
    steps:
      - run: echo core
  build-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v6
        with:
          name: engine-dist
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-runtime
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-fbx
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-codec
      - uses: actions/upload-artifact@v6
        with:
          name: app-dist
  vitest-dawn:
    runs-on: ubuntu-latest
    needs: [core-build, post-merge-gate]
    steps:
      - run: echo dawn
`;
  const { dir: cDir, fp: cFp } = tmpContract(c);
  const { dir: wDir, fp: wFp } = tmpWorkflow(wfYaml);
  try {
    const r = runChecker(['--workflow', wFp, cFp]);
    assert.strictEqual(r.exitCode, 0, `direct producer dependency should pass: ${r.stdout}`);
  } finally {
    rmSync(cDir, { recursive: true, force: true });
    rmSync(wDir, { recursive: true, force: true });
  }
});

// -- (c) consumer with undeclared prerequisite in needs --
test('t2: bidirectional needs check — undeclared prerequisite in needs produces structured error with code=ci-artifact-timing-roster-unknown-prerequisite', async () => {
  const { dir: cDir, fp: cFp } = tmpContract(minimalContract());
  const wfYaml = `
name: CI
on: push
jobs:
  build-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v6
        with:
          name: engine-dist
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-runtime
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-fbx
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-codec
      - uses: actions/upload-artifact@v6
        with:
          name: app-dist
  primary-pnpm:
    runs-on: ubuntu-latest
    needs: [build-artifacts, some-undeclared-job]
    steps:
      - uses: actions/download-artifact@v7
        with:
          name: build-output
`;
  const { dir: wDir, fp: wFp } = tmpWorkflow(wfYaml);
  try {
    const r = runChecker(['--workflow', wFp, cFp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on undeclared prerequisite');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(
      parsed.code,
      'ci-artifact-timing-roster-unknown-prerequisite',
      `expected ci-artifact-timing-roster-unknown-prerequisite but got ${parsed.code}`,
    );
    assert.ok(
      parsed.actual?.includes('some-undeclared-job'),
      'actual should list the undeclared job name',
    );
  } finally {
    rmSync(cDir, { recursive: true, force: true });
    rmSync(wDir, { recursive: true, force: true });
  }
});

// -- (d) stale declared prerequisite (in allowedNonArtifactPrerequisites but not in actual needs) --
test('t2: bidirectional needs check — stale prerequisite produces structured error with code=ci-artifact-timing-roster-stale-prerequisite', async () => {
  const { dir: cDir, fp: cFp } = tmpContract(minimalContract());
  // Contract declares post-merge-gate as allowed, but workflow doesn't have it in needs
  const wfYaml = `
name: CI
on: push
jobs:
  build-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v6
        with:
          name: engine-dist
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-runtime
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-fbx
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-codec
      - uses: actions/upload-artifact@v6
        with:
          name: app-dist
  primary-pnpm:
    runs-on: ubuntu-latest
    needs: [build-artifacts]
    steps:
      - uses: actions/download-artifact@v7
        with:
          name: build-output
`;
  const { dir: wDir, fp: wFp } = tmpWorkflow(wfYaml);
  try {
    const r = runChecker(['--workflow', wFp, cFp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on stale prerequisite');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(
      parsed.code,
      'ci-artifact-timing-roster-stale-prerequisite',
      `expected ci-artifact-timing-roster-stale-prerequisite but got ${parsed.code}`,
    );
    assert.ok(
      parsed.actual?.includes('post-merge-gate'),
      'actual should list the stale prerequisite name',
    );
  } finally {
    rmSync(cDir, { recursive: true, force: true });
    rmSync(wDir, { recursive: true, force: true });
  }
});

// -- (e) consumer with empty needs (no artifact dependency) --
test('t2: bidirectional needs check — consumer with no artifact dependency in needs produces structured error with code=ci-artifact-timing-roster-missing-artifact-needs', async () => {
  const { dir: cDir, fp: cFp } = tmpContract(minimalContract());
  const wfYaml = `
name: CI
on: push
jobs:
  build-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v6
        with:
          name: engine-dist
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-runtime
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-fbx
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-codec
      - uses: actions/upload-artifact@v6
        with:
          name: app-dist
  primary-pnpm:
    runs-on: ubuntu-latest
    needs: [post-merge-gate]
    steps:
      - uses: actions/download-artifact@v7
        with:
          name: build-output
`;
  const { dir: wDir, fp: wFp } = tmpWorkflow(wfYaml);
  try {
    const r = runChecker(['--workflow', wFp, cFp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on missing artifact needs');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(
      parsed.code,
      'ci-artifact-timing-roster-missing-artifact-needs',
      `expected ci-artifact-timing-roster-missing-artifact-needs but got ${parsed.code}`,
    );
  } finally {
    rmSync(cDir, { recursive: true, force: true });
    rmSync(wDir, { recursive: true, force: true });
  }
});

// -- (f) consumer with multiple undeclared prerequisites --
test('t2: bidirectional needs check — multiple undeclared prerequisites lists all', async () => {
  const { dir: cDir, fp: cFp } = tmpContract(minimalContract());
  const wfYaml = `
name: CI
on: push
jobs:
  build-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v6
        with:
          name: engine-dist
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-runtime
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-fbx
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-codec
      - uses: actions/upload-artifact@v6
        with:
          name: app-dist
  primary-pnpm:
    runs-on: ubuntu-latest
    needs: [build-artifacts, undeclared-a, undeclared-b]
    steps:
      - uses: actions/download-artifact@v7
        with:
          name: build-output
`;
  const { dir: wDir, fp: wFp } = tmpWorkflow(wfYaml);
  try {
    const r = runChecker(['--workflow', wFp, cFp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on multiple undeclared prerequisites');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(
      parsed.code,
      'ci-artifact-timing-roster-unknown-prerequisite',
      `expected ci-artifact-timing-roster-unknown-prerequisite but got ${parsed.code}`,
    );
    assert.ok(
      parsed.actual?.includes('undeclared-a') && parsed.actual.includes('undeclared-b'),
      'actual should list all undeclared job names',
    );
  } finally {
    rmSync(cDir, { recursive: true, force: true });
    rmSync(wDir, { recursive: true, force: true });
  }
});

// -- (g) consumer with needs that includes aggregate + non-artifact prerequisite whose completedAt is after t_ready --
// This is a dynamic runtime check that the static checker can't verify — the static checker
// only verifies the declaration of allowedNonArtifactPrerequisites. This fixture verifies that
// the static checker does NOT flag a valid declaration as invalid.
test('t2: bidirectional needs check — consumer with declared allowedNonArtifactPrerequisites passes static check (dynamic late-prerequisite is runtime concern)', async () => {
  const { dir: cDir, fp: cFp } = tmpContract(minimalContract());
  const { dir: wDir, fp: wFp } = tmpWorkflow(minimalWorkflowYaml());
  try {
    const r = runChecker(['--workflow', wFp, cFp]);
    assert.strictEqual(
      r.exitCode,
      0,
      `valid declaration should pass static check; dynamic late-prerequisite is runtime concern: ${r.stderr}`,
    );
  } finally {
    rmSync(cDir, { recursive: true, force: true });
    rmSync(wDir, { recursive: true, force: true });
  }
});

// -- Additional: provenance section validation --
test('t1: provenance section with missing producerRoster produces structured error', async () => {
  const c = validContract();
  delete c.provenance.producerRoster;
  const { dir, fp } = tmpContract(c);
  try {
    const r = runChecker([fp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on missing producerRoster');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(typeof parsed.code, 'string', 'should have code field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('t1: provenance section with wrong producerRoster cardinality produces structured error', async () => {
  const c = validContract();
  c.provenance.producerRoster = ['core-build']; // should be exactly 4
  const { dir, fp } = tmpContract(c);
  try {
    const r = runChecker([fp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on wrong producerRoster cardinality');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(typeof parsed.code, 'string', 'should have code field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('t1: provenance section with missing namingTemplate produces structured error', async () => {
  const c = validContract();
  delete c.provenance.namingTemplate;
  const { dir, fp } = tmpContract(c);
  try {
    const r = runChecker([fp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on missing namingTemplate');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(typeof parsed.code, 'string', 'should have code field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('t1: provenance section with missing mergedClass produces structured error', async () => {
  const c = validContract();
  delete c.provenance.mergedClass;
  const { dir, fp } = tmpContract(c);
  try {
    const r = runChecker([fp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on missing mergedClass');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(typeof parsed.code, 'string', 'should have code field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('t1: provenance section with missing payloadClasses produces structured error', async () => {
  const c = validContract();
  delete c.provenance.payloadClasses;
  const { dir, fp } = tmpContract(c);
  try {
    const r = runChecker([fp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on missing payloadClasses');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(typeof parsed.code, 'string', 'should have code field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('t1: provenance section with payloadClasses not covering all artifact classes produces structured error', async () => {
  const c = validContract();
  c.provenance.payloadClasses = ['engine-dist']; // missing wasm-*, app-dist
  const { dir, fp } = tmpContract(c);
  try {
    const r = runChecker([fp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on incomplete payloadClasses');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(typeof parsed.code, 'string', 'should have code field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- Additional: artifact class with empty fileClasses --
test('t1: artifact class with empty fileClasses produces structured error', async () => {
  const c = validContract();
  c.artifactClasses['engine-dist'].fileClasses = [];
  const { dir, fp } = tmpContract(c);
  try {
    const r = runChecker([fp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on empty fileClasses');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(typeof parsed.code, 'string', 'should have code field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- Additional: consumer with empty requiredArtifactClasses --
test('t1: consumer with empty requiredArtifactClasses produces structured error', async () => {
  const c = validContract();
  c.consumers['primary-pnpm'].requiredArtifactClasses = [];
  const { dir, fp } = tmpContract(c);
  try {
    const r = runChecker([fp]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on empty requiredArtifactClasses');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(typeof parsed.code, 'string', 'should have code field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// t7: Don't-break gate tests for M2 workflow
// ============================================================================

/**
 * Build a post-M2 temp workflow YAML that simulates the M2 contract-directed
 * upload/download shape. The contract declares five artifact classes:
 * engine-dist, wasm-runtime, wasm-fbx, wasm-codec, app-dist.
 * build-artifacts uploads all five; consumers download only their declared classes.
 */
function postM2WorkflowYaml() {
  return `
name: CI
on: push
jobs:
  build-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v6
        with:
          name: engine-dist
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-runtime
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-fbx
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-codec
      - uses: actions/upload-artifact@v6
        with:
          name: app-dist
  primary-pnpm:
    runs-on: ubuntu-latest
    needs: [build-artifacts, post-merge-gate]
    steps:
      - uses: actions/download-artifact@v7
        with:
          name: engine-dist
      - uses: actions/download-artifact@v7
        with:
          name: wasm-runtime
      - uses: actions/download-artifact@v7
        with:
          name: app-dist
  vitest-dawn:
    runs-on: ubuntu-latest
    needs: [build-artifacts, post-merge-gate]
    steps:
      - uses: actions/download-artifact@v7
        with:
          name: engine-dist
      - uses: actions/download-artifact@v7
        with:
          name: wasm-runtime
  post-merge-gate:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`;
}

/**
 * A reduced contract with only the consumers present in the post-M2 workflow
 * fixture, for testing the checker against the temp workflow.
 */
function postM2Contract(overrides = {}) {
  return {
    version: 1,
    extractionRoot: '.',
    artifactClasses: {
      'engine-dist': { fileClasses: ['packages/*/dist'] },
      'wasm-runtime': { fileClasses: ['packages/wgpu-wasm/pkg'] },
      'wasm-fbx': { fileClasses: ['packages/fbx/pkg'] },
      'wasm-codec': { fileClasses: ['packages/codec/pkg'] },
      'app-dist': {
        fileClasses: ['apps/**/dist'],
      },
    },
    consumers: {
      'primary-pnpm': {
        requiredArtifactClasses: ['engine-dist', 'wasm-runtime', 'app-dist'],
      },
      'vitest-dawn': {
        requiredArtifactClasses: ['engine-dist', 'wasm-runtime'],
      },
    },
    timingRoster: [
      {
        jobIdentity: 'primary-pnpm',
        requiredArtifactClasses: ['engine-dist', 'wasm-runtime', 'app-dist'],
        allowedNonArtifactPrerequisites: ['post-merge-gate'],
      },
    ],
    provenance: {
      producerRoster: ['core-build', 'app-shard-0', 'app-shard-1', 'app-shard-2'],
      namingTemplate: 'provenance-<producerJobId>-a<runAttempt>',
      mergedClass: 'provenance-merged',
      mergedWriter: 'build-artifacts',
      mergedReader: 'cost-reporter',
      payloadClasses: ['engine-dist', 'wasm-runtime', 'wasm-fbx', 'wasm-codec', 'app-dist'],
    },
    requiredCIJobRoster: ['build-artifacts', 'primary-pnpm'],
    ...overrides,
  };
}

// t7(a): post-M2 workflow passes contract checker --workflow
test('t7: post-M2 workflow shape passes contract checker --workflow', async () => {
  const { dir: cDir, fp: cFp } = tmpContract(postM2Contract());
  const { dir: wDir, fp: wFp } = tmpWorkflow(postM2WorkflowYaml());
  try {
    const r = runChecker(['--workflow', wFp, cFp]);
    assert.strictEqual(r.exitCode, 0, `post-M2 workflow should pass: ${r.stderr}`);
  } finally {
    rmSync(cDir, { recursive: true, force: true });
    rmSync(wDir, { recursive: true, force: true });
  }
});

// t7(b): build-artifacts is recognized as required context name
test('t7: build-artifacts is in the contract requiredCIJobRoster', async () => {
  const c = validContract();
  assert.ok(
    c.requiredCIJobRoster.includes('build-artifacts'),
    'build-artifacts must be in requiredCIJobRoster',
  );
});

// t7(c): all five artifact classes have upload steps in post-M2 workflow
test('t7: all five contract artifact classes have upload steps in post-M2 workflow', async () => {
  const { dir: cDir, fp: cFp } = tmpContract(postM2Contract());
  const { dir: wDir, fp: wFp } = tmpWorkflow(postM2WorkflowYaml());
  try {
    const r = runChecker(['--workflow', wFp, cFp]);
    assert.strictEqual(r.exitCode, 0, `all artifact classes should have uploads: ${r.stderr}`);
  } finally {
    rmSync(cDir, { recursive: true, force: true });
    rmSync(wDir, { recursive: true, force: true });
  }
});

// t7(d): post-M2 contract has no overlapping file class paths
test('t7: post-M2 contract file classes are non-overlapping', async () => {
  const { dir, fp } = tmpContract(validContract());
  try {
    const r = runChecker([fp]);
    assert.strictEqual(
      r.exitCode,
      0,
      `contract file classes should be non-overlapping: ${r.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sharedInputsContract(overrides = {}) {
  const contract = validContract();
  contract.version = 2;
  contract.artifactClasses['shared-asset-pack'] = {
    description: 'Shared LearnOpenGL asset pack produced once per CI run',
    fileClasses: ['shared-app-inputs/assets'],
  };
  contract.artifactClasses['shared-engine-shaders'] = {
    description: 'Shared engine shader payload produced once per CI run',
    fileClasses: ['shared-app-inputs/shaders'],
  };
  contract.consumers['app-shard'] = {
    requiredArtifactClasses: [
      'engine-dist',
      'wasm-runtime',
      'wasm-fbx',
      'wasm-codec',
      'shared-asset-pack',
      'shared-engine-shaders',
    ],
  };
  contract.provenance.producerRoster = [
    'core-build',
    'shared-app-inputs',
    'app-shard-0',
    'app-shard-1',
    'app-shard-2',
  ];
  contract.provenance.payloadClasses.push('shared-asset-pack', 'shared-engine-shaders');
  contract.timingRoster = [];
  return { ...contract, ...overrides };
}

test('w5: shared classes require the declared shared-app-inputs producer', () => {
  const contract = sharedInputsContract();
  contract.provenance.producerRoster = contract.provenance.producerRoster.filter(
    (producer) => producer !== 'shared-app-inputs',
  );
  const { dir, fp } = tmpContract(contract);
  try {
    const result = runChecker([fp]);
    assert.notEqual(result.exitCode, 0);
    const error = JSON.parse(result.stdout);
    assert.equal(error.code, 'ci-artifact-shared-producer-missing');
    assert.equal(error.expected, 'shared-app-inputs');
    assert.match(error.hint, /shared-app-inputs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('w5: shared classes reject an undeclared consumer', () => {
  const contract = sharedInputsContract();
  contract.consumers['unrelated-job'] = {
    requiredArtifactClasses: ['shared-asset-pack'],
  };
  const { dir, fp } = tmpContract(contract);
  try {
    const result = runChecker([fp]);
    assert.notEqual(result.exitCode, 0);
    const error = JSON.parse(result.stdout);
    assert.equal(error.code, 'ci-artifact-shared-consumer-unknown');
    assert.equal(error.expected, 'app-shard');
    assert.match(error.hint, /shared-app-inputs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('w5: app shard workflow must download every declared shared class', () => {
  const contract = sharedInputsContract({
    timingRoster: [
      {
        jobIdentity: 'app-shard-0',
        requiredArtifactClasses: ['shared-asset-pack', 'shared-engine-shaders'],
        artifactProvider: 'shared-app-inputs',
        allowedNonArtifactPrerequisites: ['core-build'],
      },
    ],
  });
  const workflow = `jobs:
  shared-app-inputs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v6
        with:
          name: engine-dist-a1
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-runtime-a1
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-fbx-a1
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-codec-a1
      - uses: actions/upload-artifact@v6
        with:
          name: app-dist-a1
      - uses: actions/upload-artifact@v6
        with:
          name: shared-asset-pack-a1
      - uses: actions/upload-artifact@v6
        with:
          name: shared-engine-shaders-a1
  app-shard-0:
    needs: [core-build, shared-app-inputs]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v7
        with:
          name: shared-asset-pack-a1
`;
  const { dir: contractDir, fp: contractPath } = tmpContract(contract);
  const { dir: workflowDir, fp: workflowPath } = tmpWorkflow(workflow);
  try {
    const result = runChecker(['--workflow', workflowPath, contractPath]);
    assert.notEqual(result.exitCode, 0);
    const error = JSON.parse(result.stdout);
    assert.equal(error.code, 'ci-artifact-workflow-shared-download-missing');
    assert.equal(error.expected, 'shared-engine-shaders');
    assert.match(error.hint, /app-shard-0/);
  } finally {
    rmSync(contractDir, { recursive: true, force: true });
    rmSync(workflowDir, { recursive: true, force: true });
  }
});

test('w5: app shard may hydrate declared shared classes through the verified retry command', () => {
  const contract = sharedInputsContract({
    timingRoster: [
      {
        jobIdentity: 'app-shard-0',
        requiredArtifactClasses: ['shared-asset-pack', 'shared-engine-shaders'],
        artifactProvider: 'shared-app-inputs',
        allowedNonArtifactPrerequisites: ['core-build'],
      },
    ],
  });
  const workflow = `jobs:
  shared-app-inputs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v6
        with:
          name: engine-dist-a1
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-runtime-a1
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-fbx-a1
      - uses: actions/upload-artifact@v6
        with:
          name: wasm-codec-a1
      - uses: actions/upload-artifact@v6
        with:
          name: app-dist-a1
      - uses: actions/upload-artifact@v6
        with:
          name: shared-asset-pack-a1
      - uses: actions/upload-artifact@v6
        with:
          name: shared-engine-shaders-a1
  app-shard-0:
    needs: [core-build, shared-app-inputs]
    runs-on: ubuntu-latest
    steps:
      - name: Hydrate shared asset pack
        run: >-
          node scripts/ci/download-artifact-with-retry.mjs
          --artifact-ids "\${{ needs.shared-app-inputs.outputs.asset_artifact_id }}"
          --path shared-app-inputs/assets
      - name: Hydrate shared engine shaders
        run: >-
          node scripts/ci/download-artifact-with-retry.mjs
          --artifact-ids "\${{ needs.shared-app-inputs.outputs.shader_artifact_id }}"
          --path shared-app-inputs
`;
  const { dir: contractDir, fp: contractPath } = tmpContract(contract);
  const { dir: workflowDir, fp: workflowPath } = tmpWorkflow(workflow);
  try {
    const result = runChecker(['--workflow', workflowPath, contractPath]);
    assert.equal(result.exitCode, 0, result.stdout);
  } finally {
    rmSync(contractDir, { recursive: true, force: true });
    rmSync(workflowDir, { recursive: true, force: true });
  }
});
