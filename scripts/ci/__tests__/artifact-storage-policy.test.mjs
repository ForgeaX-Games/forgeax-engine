import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const read = (path) => readFileSync(resolve(path), 'utf8');
const ci = read('.github/workflows/ci.yml');
const candidate = read('.github/workflows/sdk-release-candidate.yml');
const promotion = read('.github/workflows/sdk-release-promote.yml');
const cleanup = read('.github/workflows/actions-artifact-cleanup.yml');
const nativeRayQuery = read('.github/workflows/native-ray-query.yml');
const upload = read('.github/actions/upload-artifact-with-retry/action.yml');

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing section: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing section end: ${endMarker}`);
  return source.slice(start, end);
}

test('artifact retry stays idempotent and never creates a retry-named full copy', () => {
  assert.match(upload, /description: .*without creating duplicate artifacts/);
  assert.match(upload, /name: \$\{\{ inputs\.name \}\}[\s\S]*?overwrite: true/);
  assert.doesNotMatch(upload, /-retry-[12]-a/);
  assert.doesNotMatch(upload, /retry_2/);
  assert.match(upload, /Fail after exhausted artifact transfer/);
});

test('daily CI uploads only artifacts with an actual downstream consumer', () => {
  const webkit = section(ci, '  webkit-fallback:\n', '  portability-bun:\n');
  const browser = section(ci, '  metrics-validate-browser:\n', '  metrics-validate-runtime:\n');
  const runtime = section(ci, '  metrics-validate-runtime:\n', '  metrics-validate:\n');
  const metrics = section(ci, '  metrics-validate:\n', '  collectathon-boot-e2e:\n');
  const smoke = section(ci, '  smoke-fleet:\n', '  smoke-fleet-required-context:\n');

  assert.match(webkit, /chromium-fallback-color-lighting-status[\s\S]*?retention-days: 1/);
  assert.match(
    webkit,
    /Upload Chromium fallback lifecycle evidence[\s\S]*?if: failure\(\)[\s\S]*?retention-days: 1/,
  );
  assert.match(browser, /Stage browser metrics evidence\n\s+if: success\(\)/);
  assert.match(
    browser,
    /Upload browser metrics evidence\n\s+id: upload-metrics-browser-evidence\n\s+if: success\(\)/,
  );
  assert.match(runtime, /Stage runtime metrics evidence\n\s+if: success\(\)/);
  assert.match(
    runtime,
    /Upload runtime metrics evidence\n\s+id: upload-metrics-runtime-evidence\n\s+if: success\(\)/,
  );
  assert.match(
    metrics,
    /id: render-metrics-report[\s\S]*?id: upload-metrics-report[\s\S]*?github\.event_name == 'pull_request'[\s\S]*?steps\.render-metrics-report\.outcome == 'success'[\s\S]*?path: report\/sticky-comment\.md/,
  );
  assert.doesNotMatch(metrics, /path: report\/\n/);
  assert.match(
    smoke,
    /Upload Directional CSM MVD evidence \(deferred-to-PR\)[\s\S]*?if: github\.event_name == 'pull_request' && matrix\.group == 1[\s\S]*?retention-days: 1/,
  );
});

test('failed CI runs retain producer artifacts for failed-job reruns', () => {
  const cleanup = ci.slice(ci.indexOf('  cleanup-transient-artifacts:\n'));
  assert.match(
    cleanup,
    /if: >-\n\s+!cancelled\(\) && !contains\(needs\.\*\.result, 'failure'\) &&\n\s+!contains\(needs\.\*\.result, 'cancelled'\)/,
  );
  const report = section(ci, '  sticky-comment:\n', '    if:');
  const reportNeeds = report
    .match(/\n {4}needs: \[([^\]]+)\]/)[1]
    .split(',')
    .map((id) => id.trim());
  const cleanupNeeds = new Set(
    cleanup
      .match(/\n {4}needs:\n((?: {6}- [^\n]+\n)+)/)[1]
      .trim()
      .split('\n')
      .map((line) => line.trim().slice(2)),
  );
  assert.deepEqual(
    reportNeeds.filter((id) => !cleanupNeeds.has(id)),
    [],
    'a successful report must not mask a failed or cancelled prerequisite',
  );
});

test('View failure and the final Collectathon consumer block transient cleanup', () => {
  const job = section(
    ci,
    '  cleanup-transient-artifacts:\n',
    '  auto-exposure-feature-evidence:\n',
  );
  const needs = new Set(
    job
      .match(/\n {4}needs:\n((?: {6}- [^\n]+\n)+)/)[1]
      .trim()
      .split('\n')
      .map((line) => line.trim().slice(2)),
  );
  assert.ok(needs.has('view-integration'), 'a failed View aggregate must retain its capture');
  assert.ok(needs.has('collectathon-boot-e2e'), 'never delete inputs while this consumer runs');
  const view = section(ci, '  view-integration-shards:\n', '  primary-pnpm:\n');
  assert.match(
    view,
    /failure-view-integration-evidence|failure-' \|\| '' \}\}view-integration-evidence/,
  );
  assert.match(view, /failure-preview-rhi-window/);
});

test('View evidence retries transport once while preserving required hidden captures', () => {
  const view = section(ci, '  view-integration-shards:\n', '  view-integration:\n');
  const uploads = view
    .split(/\n(?= {6}- (?:name|uses):)/)
    .filter((step) =>
      /name: .*view-integration-evidence|name: failure-preview-rhi-window/.test(step),
    );
  assert.equal(uploads.length, 2);
  for (const step of uploads) {
    assert.match(step, /uses: \.\/\.github\/actions\/upload-artifact-with-retry/);
    assert.match(step, /required: 'true'/);
    assert.doesNotMatch(step, /continue-on-error: true/);
    assert.match(step, /retention-days: 3/);
  }
  assert.match(
    uploads.find((step) => step.includes('failure-preview-rhi-window')),
    /include-hidden-files: true/,
  );
  assert.match(upload, /include-hidden-files:\n\s+description:[^\n]+\n\s+default: 'false'/);
  assert.equal(
    (upload.match(/include-hidden-files: \$\{\{ inputs\.include-hidden-files \}\}/g) ?? []).length,
    2,
  );
});

test('failed Lens Effects keeps only current-owner capture bytes through cleanup', () => {
  const browser = section(ci, '  vitest-browser-shard:\n', '  vitest-browser:\n');
  const clear = browser.indexOf('      - name: Clear previous Lens Effects evidence');
  const gate = browser.indexOf('      - name: Vitest browser project');
  const retain = browser.indexOf('      - name: Preserve failed Lens Effects evidence');
  assert.ok(clear >= 0 && clear < gate && retain > gate);
  assert.match(browser.slice(clear, gate), /rm -rf -- artifacts\/lens-effects\/browser/);
  const step = browser.slice(retain).split(/\n(?= {6}- (?:name|uses):)/)[0];
  assert.match(step, /if: failure\(\)/);
  assert.match(step, /uses: \.\/\.github\/actions\/upload-optional-artifact/);
  assert.match(step, /name: failure-lens-effects-browser-/);
  assert.match(
    step,
    /path: \|\n\s+artifacts\/lens-effects\/browser\/\n\s+packages\/runtime\/src\/__tests__\/__screenshots__\/lens-effects\.browser\.test\.ts\//,
  );
  assert.equal(
    step.match(/^\s+if: ([^\n]+)$/m)?.[1],
    "failure() && (hashFiles('artifacts/lens-effects/browser/**') != '' || hashFiles('packages/runtime/src/__tests__/__screenshots__/lens-effects.browser.test.ts/**') != '')",
  );
  assert.equal((browser.match(/name: failure-lens-effects-browser-/g) ?? []).length, 1);
  assert.match(step, /retention-days: 3/);
  assert.match(step, /if-no-files-found: warn/);
});

test('SDK candidate keeps one payload plus small seal metadata until promotion', () => {
  const build = section(candidate, '  build-sdk:\n', '  npm-consumer:\n');
  const seedToSeal = candidate.slice(
    candidate.indexOf('  build-sdk:\n'),
    candidate.indexOf('  seal:\n'),
  );
  assert.match(build, /name: sdk-candidate-\$\{\{ github\.run_id \}\}/);
  assert.match(build, /artifacts\/sdk\/forgeax-sdk-v\$\{\{ env\.SDK_VERSION \}\}\.zip/);
  assert.match(build, /artifacts\/sdk\/sdk-build-result\.json/);
  assert.match(build, /artifacts\/sdk\/npm/);
  assert.doesNotMatch(build, /path: artifacts\/sdk\n/);
  assert.match(build, /compression-level: 0/);
  assert.match(build, /retention-days: 14/);
  assert.equal((seedToSeal.match(/retention-days: 1\b/g) ?? []).length, 4);
  const seal = section(candidate, '  seal:\n', '  cleanup-transient-artifacts:\n');
  assert.match(seal, /name: sdk-candidate-\$\{\{ github\.run_id \}\}-seal/);
  assert.match(seal, /artifacts\/sdk\/sdk-candidate\.json[\s\S]*?artifacts\/sdk\/gates/);
  assert.match(seal, /retention-days: 14/);
  assert.match(candidate, /KEEP_CANDIDATE_PAYLOAD/);
  assert.match(candidate, /KEEP_CANDIDATE_SEAL/);
  assert.match(candidate, /--preserve-name/);
  assert.match(
    ci,
    /PRESERVE_TIMING_ARTIFACTS:[\s\S]*github\.event\.pull_request\.head\.ref == 'forgeax\/feat-20260827-auto-exposure-hdr-color-grading-successor'/,
  );
  assert.match(ci, /PRESERVE_TIMING_ARTIFACTS:\s*\$\{\{/);
  assert.match(
    ci,
    /PRESERVE_TIMING_ARTIFACTS:[\s\S]*github\.event_name == 'workflow_dispatch'[\s\S]*inputs\.run_shared_evidence_probe == true[\s\S]*inputs\.run_auto_exposure_feature_evidence == true[\s\S]*github\.ref == 'refs\/heads\/forgeax\/feat-20260827-auto-exposure-hdr-color-grading-successor'/,
  );
  assert.match(ci, /PRESERVE_PROBE_ARTIFACTS[\s\S]*PRESERVE_TIMING_ARTIFACTS/);
  assert.match(ci, /renderer-device-loss-smoke-roster-a\$\{GITHUB_RUN_ATTEMPT\}/);
  const smokeRequired = section(ci, '  smoke-fleet-required-context:\n', '  bevy-smoke-fleet:\n');
  assert.doesNotMatch(smokeRequired, /overwrite: true/);
  const timing = read('.github/workflows/auto-exposure-timing-real-gpu.yml');
  assert.match(timing, /Download exact canonical roster evidence/);
  assert.match(
    timing,
    /name: renderer-device-loss-smoke-roster-a\$\{\{ inputs.ci_run_attempt \}\}/,
  );
  assert.match(timing, /manifest\?\.engineSha !== process\.env\.EXPECTED_SOURCE_HEAD/);
  assert.match(timing, /--allow-blocked-roster=true/);
  assert.doesNotMatch(timing, /forgeax-engine-editor-prerequisite-build\/v1/);
  assert.match(promotion, /retention-days: 14/);
  assert.match(promotion, /cleanup-promoted-candidate:/);
  assert.match(promotion, /--run-id "\$CANDIDATE_RUN_ID"/);
});

test('workflow_run backstop cleans successful source runs without touching a valid seal', () => {
  assert.match(cleanup, /workflow_run:/);
  assert.match(cleanup, /- CI\n\s+- emscripten-no-xz-evidence\n\s+- SDK Release Candidate/);
  assert.match(cleanup, /SOURCE_RUN_ID: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  assert.match(cleanup, /SOURCE_EVENT: \$\{\{ github\.event\.workflow_run\.event \}\}/);
  assert.match(cleanup, /SOURCE_RUN_ATTEMPT: \$\{\{ github\.event\.workflow_run\.run_attempt \}\}/);
  assert.match(cleanup, /SOURCE_CONCLUSION/);
  assert.match(
    cleanup,
    /SOURCE_WORKFLOW.*CI.*SOURCE_EVENT.*workflow_dispatch[\s\S]*?--preserve-name "core-build-a\$\{source_attempt\}"[\s\S]*?--preserve-name "shared-app-inputs-a\$\{source_attempt\}"/,
  );
  assert.match(cleanup, /renderer-device-loss-smoke-roster-a\$\{source_attempt\}/);
  assert.match(cleanup, /--preserve-name "sdk-candidate-\$\{SOURCE_RUN_ID\}"/);
  assert.match(cleanup, /--preserve-name "sdk-candidate-\$\{SOURCE_RUN_ID\}-seal"/);
  assert.match(cleanup, /actions: write/);
});

test('diagnostic-only native evidence cannot fail a passing gate when quota is full', () => {
  assert.match(
    nativeRayQuery,
    /Upload native evidence[\s\S]*?uses: \.\/\.github\/actions\/upload-optional-artifact/,
  );
  assert.match(
    nativeRayQuery,
    /Upload upstream evidence[\s\S]*?uses: \.\/\.github\/actions\/upload-optional-artifact/,
  );
});

test('completion cleanup preserves failed and cancelled CI inputs until bounded expiry', () => {
  assert.match(
    cleanup,
    /if: >-\n\s+github.event.workflow_run.conclusion == 'success' \|\|\n\s+\(github.event.workflow_run.name != 'CI' && github.event.workflow_run.conclusion == 'cancelled'\)/,
  );
  assert.match(upload, /inputs.required == 'true'/);
});

test('optional diagnostics tolerate action initialization failures at the workflow boundary', () => {
  for (const path of [
    '.github/workflows/ci.yml',
    '.github/workflows/ci-focus.yml',
    '.github/workflows/native-ray-query.yml',
  ]) {
    const steps = read(path).split(/\n(?= {6}- (?:name|uses|id):)/);
    const optional = steps.filter((step) =>
      step.includes('uses: ./.github/actions/upload-optional-artifact'),
    );
    assert.ok(optional.length > 0, path);
    for (const step of optional) {
      assert.match(step, /\n {8}continue-on-error: true\n/, `${path}: ${step.split('\n')[0]}`);
    }
    for (const step of steps.filter((step) => /\n {8}continue-on-error: true\n/.test(step))) {
      assert.match(
        step,
        /uses: \.\/\.github\/actions\/upload-optional-artifact/,
        'only optional diagnostics may suppress an outer step failure',
      );
    }
  }
});

test('Wave 1 shadow upload skips shards without a capture', () => {
  const step = section(
    ci,
    '      - name: Preserve Wave 1 shadow capture',
    '      - name: MSAA paired P2 proof',
  );
  assert.match(
    step,
    /if: always\(\) && hashFiles\('artifacts\/wave1-rendering\/wave1-shadow\.rhitape'\) != ''/,
  );
});

test('AC-08 permits optional diagnostics but rejects test, job and required-upload overrides', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forgeax-failure-policy-'));
  const gate = resolve('apps/hello/triangle/scripts/ac-08-grep-gate.mjs');
  const optional = `jobs:
  diagnostics:
    steps:
      - name: Preserve optional diagnostics
        continue-on-error: true
        uses: ./.github/actions/upload-optional-artifact
`;
  const run = () =>
    spawnSync(process.execPath, [gate, '--workflow-dir', dir], { encoding: 'utf8' });
  try {
    writeFileSync(join(dir, 'optional.yml'), optional);
    const accepted = run();
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
    writeFileSync(
      join(dir, 'test.yml'),
      optional.replace('uses: ./.github/actions/upload-optional-artifact', 'run: pnpm test:dawn'),
    );
    writeFileSync(
      join(dir, 'required.yml'),
      optional.replace('upload-optional-artifact', 'upload-artifact-with-retry'),
    );
    writeFileSync(
      join(dir, 'job.yml'),
      optional.replace('    steps:', '    continue-on-error: true\n    steps:'),
    );
    writeFileSync(
      join(dir, 'skip.yml'),
      `${optional}        env:\n          ALLOW_SMOKE_FAIL: 1\n`,
    );
    writeFileSync(join(dir, 'mixed.yml'), `${optional}        run: pnpm test:dawn\n`);
    writeFileSync(
      join(dir, 'duplicate.yml'),
      `${optional}        uses: actions/upload-artifact@v6\n`,
    );
    const rejected = run();
    assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
    for (const name of ['test', 'required', 'job', 'skip', 'mixed', 'duplicate']) {
      assert.ok(
        rejected.stdout.includes(`${name}.yml:`),
        `missing ${name} violation: ${rejected.stdout}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transient cleanup overlaps at most four deletions and drains failures while preserving named inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'artifact-cleanup-'));
  try {
    const events = join(root, 'events.jsonl');
    writeFileSync(
      join(root, 'gh'),
      String.raw`#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (!args.includes('DELETE')) {
  for (let id = 1; id <= 10; id++) console.log(id + '\t' + (id === 9 ? 'keep' : 'transient-' + id));
} else {
  const id = Number(args.at(-1).split('/').at(-1));
  const record = (phase) => fs.appendFileSync(process.env.GH_FAKE_EVENTS, JSON.stringify({ id, phase }) + '\n');
  record('start');
  setTimeout(() => { record('end'); process.exit(id === 3 ? 1 : 0); }, 200);
}
`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      process.execPath,
      ['scripts/ci/delete-workflow-artifacts.mjs', '--run-id', '123', '--preserve-name', 'keep'],
      {
        encoding: 'utf8',
        timeout: 20_000,
        env: {
          ...process.env,
          PATH: root,
          GITHUB_REPOSITORY: 'fixture/repo',
          GH_FAKE_EVENTS: events,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /deleted: 8; preserved: 1; failed deletions: 1/);
    let active = 0;
    let peak = 0;
    const started = [];
    for (const event of readFileSync(events, 'utf8').trim().split('\n').map(JSON.parse)) {
      active += event.phase === 'start' ? 1 : -1;
      peak = Math.max(peak, active);
      if (event.phase === 'start') started.push(event.id);
    }
    assert.equal(active, 0, 'all deletion processes drain');
    assert.ok(peak > 1 && peak <= 4, 'overlap uses at most four API processes');
    assert.deepEqual(
      started.sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8, 10],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
