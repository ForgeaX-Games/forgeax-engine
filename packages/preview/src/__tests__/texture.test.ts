import { describe, expect, it } from 'vitest';
import {
  createTexturePreviewContribution,
  type TexturePreviewRequest,
  texturePreviewDescriptor,
} from '../texture.js';

const request: TexturePreviewRequest = {
  subject: { kind: 'TextureAsset', guid: 'texture-001' },
  snapshot: { revision: 2, digest: 'sha256:texture-snapshot' },
  binding: {
    guid: 'texture-001',
    width: 640,
    height: 360,
    format: 'rgba16float',
    colorSpace: 'linear',
    alpha: true,
    mipLevels: 4,
    channels: 4,
  },
};

describe('texture.preview canonical contract', () => {
  it('publishes a dedicated descriptor for inspector evidence', () => {
    expect(texturePreviewDescriptor.id).toBe('texture.preview');
    expect(texturePreviewDescriptor.realm).toBe('engine');
    expect(texturePreviewDescriptor.evidence).toEqual(['rhi-tape', 'png', 'profile-capture']);
  });

  it('requires dimensions, format, color space, and the requested texture GUID', () => {
    expect(
      texturePreviewDescriptor.argsSchema.parse({
        ...request,
        binding: { ...request.binding, guid: 'other' },
      }),
    ).toMatchObject({ ok: false });
    expect(
      texturePreviewDescriptor.argsSchema.parse({
        ...request,
        binding: { ...request.binding, width: 0 },
      }),
    ).toMatchObject({ ok: false });
  });

  it('rejects texture replacement and aspect-ratio/checker falsification', async () => {
    const contribution = createTexturePreviewContribution(async () => ({
      ok: true,
      value: {
        subject: request.subject,
        snapshot: request.snapshot,
        report: {
          kind: 'texture',
          bindingGuid: request.subject.guid,
          width: 1,
          height: 1,
          format: 'rgba8unorm',
          colorSpace: 'srgb',
          alpha: false,
          mipLevels: 1,
          channels: 4,
          aspectRatio: 1,
          checkerPixels: 0,
          subjectNonBlackPixels: 0,
        },
        artifacts: [],
      },
    }));
    await expect(contribution.execute(request, {} as never)).resolves.toMatchObject({
      ok: false,
      error: { code: 'preview-subject-falsified' },
    });
  });
});
