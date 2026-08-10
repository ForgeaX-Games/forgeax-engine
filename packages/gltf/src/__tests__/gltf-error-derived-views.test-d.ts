import { describe, expectTypeOf, it } from 'vitest';
import {
  type GltfAccessorTypeMismatchDetail,
  type GltfAnimationCubicsplineUnsupportedDetail,
  type GltfAnimationTargetInvalidDetail,
  type GltfBufferOutOfBoundsDetail,
  type GltfError,
  type GltfErrorCode,
  type GltfErrorDetail,
  type GltfExtensionUnsupportedDetail,
  type GltfImageExtractFailedDetail,
  type GltfImageMimeUnsupportedDetail,
  type GltfInstancingCountMismatchDetail,
  type GltfMalformedHeaderDetail,
  type GltfMetaMissingDetail,
  type GltfMorphUnsupportedDetail,
  type GltfSkinAttrAsymmetricDetail,
  type GltfSkinJointCountExceededDetail,
  type GltfSkinJointNameMissingDetail,
  type GltfTextureLoadFailedDetail,
  type GltfVersionUnsupportedDetail,
  gltfErr,
} from '../errors.js';

type ExpectedDetails = {
  readonly 'gltf-malformed-header': GltfMalformedHeaderDetail;
  readonly 'gltf-version-unsupported': GltfVersionUnsupportedDetail;
  readonly 'gltf-buffer-out-of-bounds': GltfBufferOutOfBoundsDetail;
  readonly 'gltf-extension-unsupported': GltfExtensionUnsupportedDetail;
  readonly 'gltf-accessor-type-mismatch': GltfAccessorTypeMismatchDetail;
  readonly 'gltf-texture-load-failed': GltfTextureLoadFailedDetail;
  readonly 'gltf-meta-missing': GltfMetaMissingDetail;
  readonly 'gltf-instancing-count-mismatch': GltfInstancingCountMismatchDetail;
  readonly 'gltf-image-mime-unsupported': GltfImageMimeUnsupportedDetail;
  readonly 'gltf-skin-joint-count-exceeded': GltfSkinJointCountExceededDetail;
  readonly 'gltf-animation-cubicspline-unsupported': GltfAnimationCubicsplineUnsupportedDetail;
  readonly 'gltf-morph-unsupported': GltfMorphUnsupportedDetail;
  readonly 'gltf-skin-joint-name-missing': GltfSkinJointNameMissingDetail;
  readonly 'gltf-image-extract-failed': GltfImageExtractFailedDetail;
  readonly 'gltf-skin-attr-asymmetric': GltfSkinAttrAsymmetricDetail;
  readonly 'gltf-animation-target-invalid': GltfAnimationTargetInvalidDetail;
};

type ExpectedCodes = keyof ExpectedDetails;
type ExpectedError = {
  readonly [C in ExpectedCodes]: {
    readonly code: C;
    readonly expected: string;
    readonly hint: string;
    readonly detail: ExpectedDetails[C];
  };
}[ExpectedCodes];

function exhaustive(error: GltfError): string {
  switch (error.code) {
    case 'gltf-malformed-header':
      return `${error.detail.filePath}:${error.detail.byteOffset}`;
    case 'gltf-version-unsupported':
      return error.detail.actualVersion;
    case 'gltf-buffer-out-of-bounds':
      return `${error.detail.accessor}:${error.detail.bufferIndex}`;
    case 'gltf-extension-unsupported':
      return error.detail.extension;
    case 'gltf-accessor-type-mismatch':
      return error.detail.reason;
    case 'gltf-texture-load-failed':
      return error.detail.uri;
    case 'gltf-meta-missing':
      return error.detail.expectedMetaPath;
    case 'gltf-instancing-count-mismatch':
      return error.detail.accessor;
    case 'gltf-image-mime-unsupported':
      return error.detail.mimeType;
    case 'gltf-skin-joint-count-exceeded':
      return `${error.detail.skinIndex}:${error.detail.maxJoints}`;
    case 'gltf-animation-cubicspline-unsupported':
      return `${error.detail.animationIndex}:${error.detail.samplerIndex}`;
    case 'gltf-morph-unsupported':
      return `${error.detail.animationIndex}:${error.detail.channelIndex}`;
    case 'gltf-skin-joint-name-missing':
      return error.detail.reason;
    case 'gltf-image-extract-failed':
      return error.detail.source;
    case 'gltf-skin-attr-asymmetric':
      return `${error.detail.meshIndex}:${error.detail.primitiveIndex}`;
    case 'gltf-animation-target-invalid':
      return error.detail.reason;
  }
  return error;
}

describe('GltfError derived public views', () => {
  it('keeps the exact sixteen-code vocabulary and correlated union', () => {
    expectTypeOf<GltfErrorCode>().toEqualTypeOf<ExpectedCodes>();
    expectTypeOf<GltfError>().toEqualTypeOf<ExpectedError>();
    expectTypeOf<GltfErrorCode>().toEqualTypeOf<GltfError['code']>();
    expectTypeOf<GltfErrorDetail>().toEqualTypeOf<GltfError['detail']>();
  });

  it('rejects unknown codes and mismatched code/detail pairs', () => {
    // @ts-expect-error unknown literals are outside the closed code view
    const invalidCode: GltfErrorCode = 'gltf-not-a-real-error';
    void invalidCode;

    // @ts-expect-error the detail must match the selected code
    gltfErr('gltf-malformed-header', { uri: 'textures/wrong.png' });
  });

  it('preserves gltfErr inference for a selected correlated variant', () => {
    const error = gltfErr('gltf-version-unsupported', {
      filePath: 'model.gltf',
      actualVersion: '1.0',
    });
    expectTypeOf(error).toEqualTypeOf<
      Extract<GltfError, { readonly code: 'gltf-version-unsupported' }>
    >();
    expectTypeOf(error.detail).toEqualTypeOf<GltfVersionUnsupportedDetail>();
  });

  it('supports exhaustive narrowing across every derived variant', () => {
    expectTypeOf(exhaustive).toBeCallableWith({
      code: 'gltf-meta-missing',
      expected: 'sidecar',
      hint: 'import it',
      detail: { filePath: 'model.gltf', expectedMetaPath: 'model.gltf.meta.json' },
    });
  });
});
