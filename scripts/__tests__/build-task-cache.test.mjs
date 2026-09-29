import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { appInputFiles, cachePath, readReceipt, writeReceipt } from '../build-task-cache.mjs';

test('app input fingerprints include declared external asset roots and override sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-build-task-cache-'));
  try {
    const app = join(root, 'apps', 'preview');
    const assets = join(root, 'apps', 'game-capability-lab', 'assets');
    const publicSource = join(root, 'fixtures', 'terrain.json');
    mkdirSync(app, { recursive: true });
    mkdirSync(assets, { recursive: true });
    mkdirSync(join(root, 'fixtures'), { recursive: true });
    writeFileSync(join(app, 'index.html'), '<canvas></canvas>');
    writeFileSync(join(assets, 'base-material.pack.json'), '{}');
    writeFileSync(publicSource, '{}');

    const files = appInputFiles(root, app, {
      forgeax: {
        assetRoots: ['../../apps/game-capability-lab/assets'],
        publicAssetOverrides: { '/terrain.json': '../../fixtures/terrain.json' },
      },
    });

    assert.ok(files.includes(resolve(assets, 'base-material.pack.json')));
    assert.ok(files.includes(resolve(publicSource)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('long receipt identities use a bounded basename and remain content-validated', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-build-task-cache-'));
  const identity = `/very/long/worktree/${'nested-segment/'.repeat(40)}shared-build-output`;
  try {
    const path = cachePath(root, 'receipts/shared', identity);
    assert.ok(path.split('/').at(-1).length < 128);
    writeReceipt(root, 'receipts/shared', identity, { outputFingerprint: 'sha256:abc' });
    assert.equal(readReceipt(root, 'receipts/shared', identity)?.outputFingerprint, 'sha256:abc');

    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    receipt.cacheKey.name = `${identity}-stale`;
    writeFileSync(path, `${JSON.stringify(receipt)}\n`);
    assert.equal(readReceipt(root, 'receipts/shared', identity), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent receipt publishers leave one complete identity-validated value', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-build-task-cache-'));
  const identity = `/concurrent/${'long-segment/'.repeat(30)}output`;
  const moduleUrl = pathToFileURL(resolve('scripts/build-task-cache.mjs')).href;
  const publish = (fingerprint) =>
    new Promise((resolvePublish, rejectPublish) => {
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `const { writeReceipt } = await import(${JSON.stringify(moduleUrl)}); writeReceipt(process.argv[1], 'receipts/shared', process.argv[2], { outputFingerprint: process.argv[3] });`,
          root,
          identity,
          fingerprint,
        ],
        { stdio: 'inherit' },
      );
      child.once('error', rejectPublish);
      child.once('exit', (code) => {
        if (code === 0) resolvePublish();
        else rejectPublish(new Error(`receipt publisher exited with ${String(code)}`));
      });
    });
  try {
    await Promise.all([publish('sha256:first'), publish('sha256:second')]);
    const receipt = readReceipt(root, 'receipts/shared', identity);
    assert.ok(['sha256:first', 'sha256:second'].includes(receipt?.outputFingerprint));
    assert.equal(
      readdirSync(join(root, 'node_modules/.cache/forgeax-build/receipts/shared')).some((name) =>
        name.endsWith('.tmp'),
      ),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
