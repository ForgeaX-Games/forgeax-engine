import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  RenderFeatureCapabilityMissingError,
  RenderFeaturePassOrderConflictError,
  RenderFeatureRegistrationConflictError,
  RenderFeatureStageFailedError,
} from '../errors/render';

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

const renderReadme = read('../../README.md');
const runtimeReadme = read('../../../runtime/README.md');
const appSkill = read('../../../../skills/forgeax-engine-app/SKILL.md');

// M4-06 prepends the direct-light contract; keep the existing first-read
// vocabulary assertion wide enough to cover that approved contract.
const topSurface = renderReadme.slice(0, 18000);

describe('RenderFeature documentation surface', () => {
  it('keeps the first-read public route and four-term vocabulary indexable', () => {
    for (const token of [
      '## RenderFeature: the producer seam',
      'type FrameData',
      'createRenderer(canvas, { features: [feature] })',
      "context.staging.addPass('named-pass'",
      'execute: ({ pass })',
      'active RenderGraph',
      'RenderFeature',
      'RenderPipeline',
      'RenderGraph pass',
      'Material pass',
    ]) {
      expect(topSurface).toContain(token);
    }
    expect(topSurface).not.toContain('passContext.commands');
    expect(topSurface).toContain('graph-only Wave 1 feature');
    expect(runtimeReadme).toContain('createRenderer(canvas, options?, bundler?)');
    expect(appSkill).toContain('Renderer feature assembly');
  });

  it('indexes capability, structured error, recovery, disposal, and pipeline switching', () => {
    const surface = `${renderReadme}\n${runtimeReadme}\n${appSkill}`;
    for (const token of [
      'Readonly<RhiCaps>',
      'RenderError',
      'error.code',
      'error.hint',
      'error.detail',
      'renderFeatureDiagnostics()',
      'renderer.recover()',
      'renderer.dispose()',
      'renderer.registerPipeline(id, pipeline)',
    ]) {
      expect(surface).toContain(token);
    }
  });

  it('keeps the error hint actions aligned with the recovery matrix', () => {
    const cases = [
      {
        error: new RenderFeatureRegistrationConflictError('test.feature', 1, 0),
        recoveryToken: 'registration',
      },
      {
        error: new RenderFeatureStageFailedError('test.feature', 1, 'prepare', 'next-frame'),
        recoveryToken: 'next frame',
      },
      {
        error: new RenderFeatureCapabilityMissingError('test.feature', 1, 'compute'),
        recoveryToken: 'capability',
      },
      {
        error: new RenderFeaturePassOrderConflictError('test.feature', 1, 'overlay', 'main'),
        recoveryToken: 'reorder',
      },
    ];

    for (const { error, recoveryToken } of cases) {
      expect(error.hint.toLowerCase()).toContain(recoveryToken);
      expect(`${renderReadme}\n${runtimeReadme}\n${appSkill}`.toLowerCase()).toContain(
        recoveryToken,
      );
    }
  });
});
