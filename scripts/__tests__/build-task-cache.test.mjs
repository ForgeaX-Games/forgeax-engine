import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { appInputFiles } from '../build-task-cache.mjs';

test('app input fingerprints include declared external asset roots and override sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-build-task-cache-'));
  try {
    const app = join(root, 'apps', 'preview');
    const assets = join(root, 'templates', 'game-default', 'assets');
    const publicSource = join(root, 'fixtures', 'terrain.json');
    mkdirSync(app, { recursive: true });
    mkdirSync(assets, { recursive: true });
    mkdirSync(join(root, 'fixtures'), { recursive: true });
    writeFileSync(join(app, 'index.html'), '<canvas></canvas>');
    writeFileSync(join(assets, 'base-material.pack.json'), '{}');
    writeFileSync(publicSource, '{}');

    const files = appInputFiles(root, app, {
      forgeax: {
        assetRoots: ['../../templates/game-default/assets'],
        publicAssetOverrides: { '/terrain.json': '../../fixtures/terrain.json' },
      },
    });

    assert.ok(files.includes(resolve(assets, 'base-material.pack.json')));
    assert.ok(files.includes(resolve(publicSource)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
