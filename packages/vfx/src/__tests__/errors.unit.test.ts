import { describe, expect, it } from 'vitest';
import { type VfxError, vfxError } from '../errors.js';

const errors: readonly VfxError[] = [
  vfxError('vfx-source-invalid', {
    path: 'effect.emitters[0].capacity',
    emitterId: 'smoke',
  }),
  vfxError('vfx-operator-unknown', {
    stage: 'update',
    kind: 'missing-kind',
    version: 1,
    emitterId: 'smoke',
  }),
  vfxError('vfx-operator-backend-unsupported', {
    emitterId: 'smoke',
    operator: { stage: 'update', kind: 'gravity', version: 1 },
    backend: 'gpu',
  }),
  vfxError('vfx-program-invalid', {
    emitterId: 'smoke',
    path: 'program.emitters[0].stages.update',
    format: 'forgeax-vfx-program-1',
  }),
  vfxError('vfx-batch-invalid', {
    output: 'billboard',
    index: 0,
    path: 'batches[0].attributes.position',
  }),
  vfxError('vfx-asset-load-failed', {
    guid: 'effect-guid',
    stage: 'artifact',
    packageUrl: '/effects.pack',
    artifact: 'program.bin',
    cause: {
      code: 'artifact-missing',
      expected: 'asset-local artifact exists',
      hint: 'recook the particle effect package',
    },
  }),
];

function exhaustiveRecovery(error: VfxError): string {
  switch (error.code) {
    case 'vfx-source-invalid':
      return error.detail.path;
    case 'vfx-operator-unknown':
      return error.detail.kind;
    case 'vfx-operator-backend-unsupported':
      return error.detail.backend;
    case 'vfx-program-invalid':
      return error.detail.format;
    case 'vfx-batch-invalid':
      return error.detail.output;
    case 'vfx-asset-load-failed':
      return error.detail.stage;
    case 'vfx-simulation-capability-unavailable':
      return error.detail.backend;
    case 'vfx-simulation-player-invalid':
      return error.detail.field;
    case 'vfx-simulation-output-unavailable':
      return error.detail.reference;
    case 'vfx-simulation-execution-failed':
      return error.detail.operator;
  }
}

describe('VfxError', () => {
  it('exposes stable recovery fields for every closed domain failure', () => {
    for (const error of errors) {
      expect(error.code).toMatch(/^vfx-/);
      expect(error.expected).toBeTruthy();
      expect(error.hint).toBeTruthy();
      expect(exhaustiveRecovery(error)).toBeTruthy();
    }
  });

  it('narrows asset loading causes by package, artifact, and reference stage', () => {
    const packageFailure = vfxError('vfx-asset-load-failed', {
      guid: 'effect-guid',
      stage: 'package',
      packageUrl: '/effects.pack',
      cause: { code: 'package-missing', expected: 'pack is reachable', hint: 'verify packageUrl' },
    });
    const referenceFailure = vfxError('vfx-asset-load-failed', {
      guid: 'effect-guid',
      stage: 'reference',
      reference: 'material-guid',
      cause: {
        code: 'reference-missing',
        expected: 'reference is ready',
        hint: 'load the referenced asset',
      },
    });

    expect(packageFailure.detail.stage).toBe('package');
    if (packageFailure.detail.stage === 'package') {
      expect(packageFailure.detail.packageUrl).toBe('/effects.pack');
    }
    expect(referenceFailure.detail.stage).toBe('reference');
    if (referenceFailure.detail.stage === 'reference') {
      expect(referenceFailure.detail.reference).toBe('material-guid');
    }
  });
});
