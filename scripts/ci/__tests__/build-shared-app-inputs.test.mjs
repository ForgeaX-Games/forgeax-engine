import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const script = join(repoRoot, 'scripts', 'ci', 'build-shared-app-inputs.mjs');

test('shared inputs preserve both raw source paths and Vite-emitted asset paths', () => {
  const output = mkdtempSync(join(tmpdir(), 'forgeax-shared-inputs-'));
  try {
    const result = spawnSync(process.execPath, [script, '--root', repoRoot, '--out', output], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const catalog = JSON.parse(readFileSync(join(output, 'assets', 'catalog.json'), 'utf8'));
    const bleep = catalog.find((entry) => entry.sourcePath.endsWith('audio/bleep.mp3'));
    assert.ok(bleep, 'shared catalog includes the raw audio entry');
    assert.ok(existsSync(join(output, 'assets', 'payload', bleep.relativeUrl)));
    assert.ok(existsSync(join(output, 'assets', 'payload', 'assets')));
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
