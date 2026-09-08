import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  validateManifest,
  verifyEvidenceLayers,
  verifyRequiredCells,
} from '../render-evidence-manifest.mjs';

const sourceSha = 'b'.repeat(40);

function cell(id, backendKind, verdict = backendKind === 'rhi-null' ? 'structural' : 'pixel') {
  return {
    id,
    required: true,
    sourceSha,
    buildId: 'build-1',
    backendKind,
    backendIdentity: `${backendKind}-identity`,
    status: 'pass',
    verdict,
  };
}

function validManifest() {
  return {
    schemaVersion: '1.0.0',
    manifestKind: 'render-evidence-manifest',
    sourceSha,
    build: {
      id: 'build-1',
      distHashes: [{ path: 'packages/render/dist/index.mjs', sha256: 'c'.repeat(64) }],
    },
    testConfig: { id: 'render-evidence-config', sha256: 'd'.repeat(64) },
    evidence: {
      sourceSha,
      buildId: 'build-1',
      layers: {
        budget: 'pass',
        apiSnapshot: 'pass',
        consumerInventory: 'pass',
        legacySurface: 'pass',
        distBuild: 'pass',
        requiredCells: 'pass',
        documentation: 'pass',
      },
      frameChain: ['createRenderer', 'attach', 'draw', 'observe', 'recover'],
    },
    backends: [
      { kind: 'rhi-null', identity: 'rhi-null-identity' },
      { kind: 'dawn', identity: 'dawn-identity' },
      { kind: 'chromium', identity: 'chromium-identity' },
    ],
    requiredCells: [
      cell('scene-structure', 'rhi-null'),
      cell('dawn-shader', 'dawn'),
      cell('chromium-pack', 'chromium'),
    ],
    visualRecords: [
      {
        target: 'standard-lighting',
        sourceSha,
        buildId: 'build-1',
        backend: { kind: 'chromium', identity: 'chromium-identity' },
        frameId: 12,
        deviceGeneration: 3,
        oracle: 'frozen-lighting-oracle',
        falsifier: 'empty-light-table',
        observed: 'lights are visible',
        verdict: 'pixel',
        confidence: 0.95,
      },
    ],
    recoveryHints: ['Use inspect to identify the owner, then rebuild or recover.'],
  };
}

test('accepts a complete identity-bound manifest', () => {
  const manifest = validManifest();

  assert.deepEqual(validateManifest(manifest), { ok: true, errors: [] });
  assert.deepEqual(verifyRequiredCells(manifest), { ok: true, errors: [] });
  assert.deepEqual(verifyEvidenceLayers(manifest), { ok: true, errors: [] });
});

test('rejects a manifest with a missing evidence layer or incomplete frame chain', () => {
  const manifest = validManifest();
  manifest.evidence.layers.consumerInventory = 'missing';
  manifest.evidence.frameChain.pop();

  const result = verifyEvidenceLayers(manifest);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /inventory|frame|recover/i);
});

test('rejects a missing required cell', () => {
  const manifest = validManifest();
  manifest.requiredCells.pop();

  const result = verifyRequiredCells(manifest);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /required|cell/i);
});

test('rejects unsupported and error required cells', () => {
  for (const status of ['unsupported', 'error', 'blocked', 'missing']) {
    const manifest = validManifest();
    manifest.requiredCells[1].status = status;

    const result = verifyRequiredCells(manifest);

    assert.equal(result.ok, false, status);
    assert.match(result.errors.join('\n'), new RegExp(status, 'i'));
  }
});

test('rejects a cell whose source or build identity differs from the manifest', () => {
  const manifest = validManifest();
  manifest.requiredCells[1].sourceSha = 'e'.repeat(40);

  const result = verifyRequiredCells(manifest);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /identity|source/i);
});

test('rejects RhiNull structural evidence presented as a pixel verdict', () => {
  const manifest = validManifest();
  manifest.requiredCells[0].verdict = 'pixel';

  const result = verifyRequiredCells(manifest);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /RhiNull|structural|pixel/i);
});

test('rejects a malformed visual record', () => {
  const manifest = validManifest();
  delete manifest.visualRecords[0].falsifier;

  const result = validateManifest(manifest);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /falsifier|visual/i);
});
