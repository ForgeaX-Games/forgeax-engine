import { describe, expect, it } from 'vitest';
import {
  createMaterialPreviewContribution,
  type MaterialPreviewRequest,
  materialPreviewDescriptor,
} from '../material.js';
import { materialBindingFromPayload } from '../primitive.js';

const request: MaterialPreviewRequest = {
  subject: { kind: 'MaterialAsset', guid: 'mat-001' },
  snapshot: { revision: 7, digest: 'sha256:material-snapshot' },
  binding: {
    guid: 'mat-001',
    programDigest: 'sha256:program',
    bindings: ['baseColor', 'roughness', 'normal'],
  },
};

describe('material.preview canonical contract', () => {
  it('projects parameter bindings without treating module slots as draw defines', () => {
    expect(
      materialBindingFromPayload('mat-001', {
        kind: 'material',
        passes: [
          {
            name: 'forward',
            program: { module: 'game::material', moduleSlots: { FLAG: 'true' } },
          },
        ],
        parameters: [{ name: 'baseColor', type: 'color' }],
        values: { baseColor: [1, 1, 1, 1] },
      }),
    ).toEqual({
      guid: 'mat-001',
      programDigest: 'material-program:game::material',
      bindings: ['baseColor'],
    });
  });

  it('publishes a dedicated descriptor with subject evidence', () => {
    expect(materialPreviewDescriptor.id).toBe('material.preview');
    expect(materialPreviewDescriptor.realm).toBe('engine');
    expect(materialPreviewDescriptor.evidence).toEqual(['rhi-tape', 'png', 'profile-capture']);
    expect(materialPreviewDescriptor.preview).toMatchObject({
      realm: 'engine',
      subject: { kind: 'MaterialAsset' },
      requiredEvidence: ['rhi-tape', 'png', 'profile-capture'],
    });
  });

  it('requires the requested MaterialAsset GUID and real program bindings', () => {
    expect(
      materialPreviewDescriptor.argsSchema.parse({ ...request, binding: { guid: 'other' } }),
    ).toMatchObject({
      ok: false,
    });
    expect(
      materialPreviewDescriptor.argsSchema.parse({
        ...request,
        binding: { ...request.binding, bindings: [] },
      }),
    ).toMatchObject({ ok: false });
  });

  it('rejects fallback sphere, missing evidence, and non-background-only output', async () => {
    const contribution = createMaterialPreviewContribution(async () => ({
      ok: true,
      value: {
        subject: request.subject,
        snapshot: request.snapshot,
        report: {
          kind: 'material',
          bindingGuid: 'fallback-sphere',
          programDigest: request.binding.programDigest,
          backgroundNonBlackPixels: 0,
          subjectNonBlackPixels: 0,
          presentation: 'sphere-studio',
        },
        artifacts: [],
      },
    }));

    const terminal = await contribution.execute(request, {} as never);
    expect(terminal).toMatchObject({
      ok: false,
      error: { code: 'preview-subject-falsified' },
    });
  });
});
