import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const gate = await readFile(new URL('../forgeax/check-catalog-docs.mjs', import.meta.url), 'utf8');

test('catalog gate covers the MaterialAsset authoring and recovery route', () => {
  for (const token of [
    'MaterialAsset',
    'material-specialization-not-cooked',
    'material-parent-not-found',
    'material-value-type-mismatch',
    'material-reflection-binding-mismatch',
    'docs/material-asset-migration.md',
  ]) {
    assert.ok(gate.includes(token), `catalog gate must enforce ${token}`);
  }
});

test('catalog gate rejects retired material authoring vocabulary in planned docs', () => {
  for (const token of ['ShaderAsset', 'paramValues', 'uvSet', 'sidecar', 'registerMaterial']) {
    assert.ok(gate.includes(token), `catalog gate must reject ${token}`);
  }
});

test('catalog gate owns the canonical audit vocabulary and staged recovery actions', () => {
  for (const token of [
    'subject',
    'execution',
    'lifecycle',
    'lastKnownGood',
    'sourceKey',
    'author authority',
    'runtime source',
    'author-validation',
    'external-declaration',
    'import',
    'native-cook',
    'ddc-validation',
    'runtime-parse',
    'editor-capability',
    'inspect',
    'rebuild',
    'cold cook',
    'preview-LKG',
    'override',
    'promote',
    'stop-publish',
  ]) {
    assert.ok(gate.includes(token), `catalog gate must own ${token}`);
  }
});
