import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const mergerPath = join(repoRoot, 'scripts', 'ci', 'merge-ddc-snapshots.mjs');

function fixture(shards) {
  const root = mkdtempSync(join(tmpdir(), 'merge-ddc-snapshots-'));
  const snapshots = join(root, 'snapshots');
  const output = join(root, 'merged');
  for (const [index, entries] of shards.entries()) {
    const shard = join(snapshots, String(index));
    mkdirSync(shard, { recursive: true });
    for (const [identity, files] of Object.entries(entries)) {
      const entry = join(shard, 'entries', identity);
      mkdirSync(entry, { recursive: true });
      for (const file of files) writeFileSync(join(entry, file), file);
    }
  }
  return { root, snapshots, output };
}

function run({ snapshots, output, shardCount = 3, cacheHit = false }) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        mergerPath,
        '--snapshots-dir',
        snapshots,
        '--out-dir',
        output,
        '--shard-count',
        String(shardCount),
        ...(cacheHit ? ['--cache-hit'] : []),
      ],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return { exitCode: 0, stdout: stdout.trim(), stderr: '' };
  } catch (error) {
    return {
      exitCode: error.status ?? 1,
      stdout: error.stdout?.toString().trim() ?? '',
      stderr: error.stderr?.toString().trim() ?? '',
    };
  }
}

test('merges complete entries, rejects duplicate identities, and is idempotent', () => {
  const fixtureRoot = fixture([
    { alpha: ['receipt.json', 'integrity.json'] },
    { beta: ['receipt.json', 'integrity.json'] },
    { gamma: ['receipt.json', 'integrity.json'] },
  ]);
  try {
    const first = run(fixtureRoot);
    assert.equal(first.exitCode, 0, first.stdout || first.stderr);
    assert.deepEqual(JSON.parse(first.stdout), {
      outcome: 'saved',
      availableSnapshots: 3,
      shardCount: 3,
      nextRunWouldHit: true,
    });
    assert.equal(existsSync(join(fixtureRoot.output, 'entries', 'alpha', 'receipt.json')), true);
    const second = run(fixtureRoot);
    assert.equal(second.exitCode, 0, second.stdout || second.stderr);
    assert.equal(second.stdout, first.stdout);

    const duplicate = fixture([
      { same: ['receipt.json', 'integrity.json'] },
      { same: ['receipt.json', 'integrity.json'] },
    ]);
    try {
      const result = run({ ...duplicate, shardCount: 2 });
      assert.equal(result.exitCode, 1);
      assert.equal(JSON.parse(result.stdout).code, 'ci-ddc-snapshot-entry-duplicate');
    } finally {
      rmSync(duplicate.root, { recursive: true, force: true });
    }
  } finally {
    rmSync(fixtureRoot.root, { recursive: true, force: true });
  }
});

test('missing shard is an explicit partial result that cannot warm the next run', () => {
  const fixtureRoot = fixture([{ alpha: ['receipt.json', 'integrity.json'] }, {}]);
  try {
    const result = run(fixtureRoot);
    assert.equal(result.exitCode, 0, result.stdout || result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      outcome: 'partial',
      availableSnapshots: 2,
      shardCount: 3,
      nextRunWouldHit: false,
    });
  } finally {
    rmSync(fixtureRoot.root, { recursive: true, force: true });
  }
});

test('rejects incomplete entries with a structured failure', () => {
  const fixtureRoot = fixture([{ alpha: ['receipt.json'] }]);
  try {
    const result = run({ ...fixtureRoot, shardCount: 1 });
    assert.equal(result.exitCode, 1);
    assert.equal(JSON.parse(result.stdout).code, 'ci-ddc-snapshot-entry-incomplete');
  } finally {
    rmSync(fixtureRoot.root, { recursive: true, force: true });
  }
});

test('cache hit preserves restored output and reports skipped', () => {
  const fixtureRoot = fixture([]);
  mkdirSync(fixtureRoot.output, { recursive: true });
  writeFileSync(join(fixtureRoot.output, 'cached.bin'), 'cached');
  try {
    const result = run({ ...fixtureRoot, cacheHit: true });
    assert.equal(result.exitCode, 0, result.stdout || result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      outcome: 'skipped',
      availableSnapshots: 0,
      shardCount: 3,
      nextRunWouldHit: true,
    });
    assert.equal(readFileSync(join(fixtureRoot.output, 'cached.bin'), 'utf8'), 'cached');
  } finally {
    rmSync(fixtureRoot.root, { recursive: true, force: true });
  }
});
